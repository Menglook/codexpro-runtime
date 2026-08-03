import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runManagedProcessSync } from "../../shared/execution-kernel.mjs";
import { redactSensitiveText } from "../../shared/redaction.mjs";

const MB = 1024 * 1024;
const PS_RSS_UNIT_KB = 1024;

export const PROCESS_CLASSIFICATION_BASIS = [
  {
    command_class: "codexpro_server",
    type: "codexpro_server",
    basis: "CodexPro server entrypoints such as scripts/codexpro.mjs start, dist/http.js, dist/stdio.js, or codexpro-mcp binaries."
  },
  {
    command_class: "handoff_watcher",
    type: "codexpro_watcher",
    basis: "CodexPro handoff watcher commands containing watch-handoff and a workspace root."
  },
  {
    command_class: "codex_executor",
    type: "codex_executor",
    basis: "Codex CLI, codex-agent-wrapper, Codex SDK/exec runner, or commands that execute CodexPro handoff work."
  },
  {
    command_class: "browser_bridge",
    type: "browser_bridge",
    basis: "Browser Bridge lifecycle scripts and CDP bridge commands on the Linux/WSL side."
  },
  {
    command_class: "browser_validation",
    type: "browser_validation",
    basis: "Browser verification, visual regression, Playwright, or CDP smoke commands."
  },
  {
    command_class: "validation",
    type: "validation",
    basis: "Build, smoke, test, TypeScript, vitest, jest, mocha, or npm validation commands."
  },
  {
    command_class: "docker",
    type: "docker",
    basis: "Docker, dockerd, containerd, compose, or BuildKit process names/commands."
  },
  {
    command_class: "node_runtime",
    type: "node",
    basis: "Node/npm/tsx process associated with the current workspace or a configured CodexPro stack root."
  }
];

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function asPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function readJsonSafe(filePath, maxBytes = 2 * MB) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function pathExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  const normalized = asPositiveInteger(pid);
  if (!normalized) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function normalizePathForCompare(value) {
  return path.resolve(String(value || "")).replaceAll("\\", "/").toLowerCase();
}

function isInsidePath(candidate, root) {
  if (!candidate || !root) return false;
  const normalizedCandidate = normalizePathForCompare(candidate);
  const normalizedRoot = normalizePathForCompare(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function commandIncludesPath(command, root) {
  if (!command || !root) return false;
  const normalizedCommand = String(command).replaceAll("\\", "/").toLowerCase();
  return normalizedCommand.includes(normalizePathForCompare(root));
}

function readProcessCwd(pid) {
  if (process.platform !== "linux") return null;
  try {
    return fs.realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function redactCommand(command) {
  return redactSensitiveText(String(command || "")).slice(0, 500);
}

export function parseLinuxPsOutput(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([0-9.]+)\s+(\d+)\s+(.+?)\s*$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpu_percent: round(Number(match[3]), 1),
        rss_kb: Number(match[4]),
        command: match[5]
      };
    })
    .filter(Boolean);
}

export function collectLinuxProcessRows() {
  const result = runManagedProcessSync("ps", ["-eo", "pid=,ppid=,pcpu=,rss=,args="], {
    timeoutMs: 5000,
    maxOutputBytes: 8 * MB,
    domain: "probe",
    operation: "control_center_ps",
    sideEffectLevel: "none",
    riskLevel: "low",
    recordRoot: process.cwd()
  });
  if (result.spawnError) {
    return {
      ok: false,
      rows: [],
      warning: `ps process scan failed: ${result.stderr || result.errorClass || "spawn failed"}`
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      rows: [],
      warning: `ps process scan exited ${result.exitCode}: ${String(result.stderr || "").trim() || "no stderr"}`
    };
  }
  return { ok: true, rows: parseLinuxPsOutput(result.stdout) };
}

function commandName(command) {
  const first = String(command || "").trim().split(/\s+/)[0] || "";
  return path.basename(first).toLowerCase();
}

function detectProject(row, roots) {
  for (const root of roots) {
    if (row.cwd && isInsidePath(row.cwd, root)) return root;
    if (commandIncludesPath(row.command, root)) return root;
  }
  return row.cwd || null;
}

function classifyNodeCommand(command, projectMatched) {
  const lower = String(command || "").toLowerCase();
  const name = commandName(command);
  if (!["node", "npm", "npx", "tsx", "ts-node"].includes(name) && !lower.includes("/node ")) return null;
  return projectMatched || /codex|smoke|test|build|playwright|vitest|jest|mocha|typescript|tsc/.test(lower)
    ? { type: "node", command_class: "node_runtime" }
    : null;
}

export function classifyLinuxProcess(row, options = {}) {
  const command = String(row.command || "");
  const lower = command.toLowerCase();
  const roots = [...new Set([options.projectRoot, ...(options.knownRoots || [])].filter(Boolean).map((item) => path.resolve(item)))];
  const projectMatched = roots.some((root) => (row.cwd && isInsidePath(row.cwd, root)) || commandIncludesPath(command, root));

  if (/scripts\/codexpro\.mjs\s+start\b|dist\/http\.js\b|dist\/stdio\.js\b|codexpro-mcp(?:\s|$)|codexpro-mcp-http/.test(lower)) {
    return { type: "codexpro_server", command_class: "codexpro_server" };
  }
  if (/\bwatch-handoff\b/.test(lower)) {
    return { type: "codexpro_watcher", command_class: "handoff_watcher" };
  }
  if (/codex-agent-wrapper\.mjs|\bcodex\s+exec\b|\/codex(?:\s|$)|@openai\/codex-sdk|codexpro-exec-runner|fake-codex\.mjs\s+exec/.test(lower)) {
    return { type: "codex_executor", command_class: "codex_executor" };
  }
  if (/browser-bridge\.mjs|start-codexpro-chrome\.ps1|cdp-private-proxy|browser bridge/.test(lower)) {
    return { type: "browser_bridge", command_class: "browser_bridge" };
  }
  if (/browser-(?:verification|visual|interaction|bridge-cdp|bridge-v2)|playwright|cdp-live|visual-regression/.test(lower)) {
    return { type: "browser_validation", command_class: "browser_validation" };
  }
  if (/\bdocker(?:d|-compose)?\b|\bcontainerd\b|\bbuildkitd\b/.test(lower)) {
    return { type: "docker", command_class: "docker" };
  }
  if (/\bnpm\s+run\s+(?:build|smoke|test|.*smoke)|\bnpm\s+(?:test|run-script)|\bvitest\b|\bjest\b|\bmocha\b|\btsc\b|scripts\/.*smoke\.mjs/.test(lower)) {
    return { type: "validation", command_class: "validation" };
  }
  return classifyNodeCommand(command, projectMatched);
}

export function buildProcessTree(rows, options = {}) {
  const knownRoots = [...new Set([options.projectRoot, ...(options.knownRoots || [])].filter(Boolean).map((item) => path.resolve(item)))];
  const enrichedRows = rows.map((row) => {
    const cwd = row.cwd === undefined ? readProcessCwd(row.pid) : row.cwd;
    return { ...row, cwd };
  });
  const byPid = new Map(enrichedRows.map((row) => [row.pid, row]));
  const childrenByParent = new Map();
  for (const row of enrichedRows) {
    const children = childrenByParent.get(row.ppid) || [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const processMap = new Map();
  for (const row of enrichedRows) {
    const classification = classifyLinuxProcess(row, { projectRoot: options.projectRoot, knownRoots });
    if (!classification) continue;
    const projectRoot = detectProject(row, knownRoots);
    const childPids = childrenByParent.get(row.pid) || [];
    const childProcesses = childPids
      .map((pid) => byPid.get(pid))
      .filter(Boolean)
      .map((child) => {
        const childClass = classifyLinuxProcess(child, { projectRoot: options.projectRoot, knownRoots }) || {
          type: "other",
          command_class: "other"
        };
        return {
          pid: child.pid,
          type: childClass.type,
          command_class: childClass.command_class,
          cpu_percent: child.cpu_percent,
          rss_mb: round(child.rss_kb / PS_RSS_UNIT_KB, 1),
          command_excerpt: redactCommand(child.command)
        };
      });
    processMap.set(row.pid, {
      pid: row.pid,
      ppid: row.ppid,
      type: classification.type,
      project: projectRoot && options.projectRoot && isInsidePath(projectRoot, options.projectRoot) ? "codexpro" : projectRoot || "unknown",
      project_root: projectRoot,
      command_class: classification.command_class,
      cpu_percent: row.cpu_percent,
      rss_mb: round(row.rss_kb / PS_RSS_UNIT_KB, 1),
      child_processes: childProcesses,
      child_count: childProcesses.length,
      command_excerpt: redactCommand(row.command)
    });
  }
  return [...processMap.values()].sort((left, right) => left.pid - right.pid);
}

export function readStackState(options = {}) {
  const explicitPath = options.stackStatePath
    ? path.resolve(options.stackStatePath)
    : process.env.CODEXPRO_STACK_STATE_DIR
      ? path.join(process.env.CODEXPRO_STACK_STATE_DIR, "state.json")
      : path.join(os.homedir(), ".codexpro", "stack", "state.json");
  return {
    path: explicitPath,
    state: readJsonSafe(explicitPath)
  };
}

function stackKnownRoots(projectRoot, stackState) {
  return [
    projectRoot,
    stackState?.server_root,
    ...(Array.isArray(stackState?.watchers) ? stackState.watchers.map((item) => item?.root) : [])
  ].filter(Boolean);
}

function listMatchingFiles(dir, fileName, depth = 3) {
  const results = [];
  function walk(current, remaining) {
    if (remaining < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === fileName) results.push(fullPath);
      else if (entry.isDirectory()) walk(fullPath, remaining - 1);
    }
  }
  walk(dir, depth);
  return results.sort();
}

function statusActive(status) {
  return ["running", "recovering", "validating", "reviewing"].includes(String(status || ""));
}

function browserRunProcess(processes, projectRoot) {
  return processes.filter((item) => {
    if (!["browser_validation"].includes(item.type)) return false;
    return item.project === "codexpro" || (item.project_root && isInsidePath(item.project_root, projectRoot));
  });
}

function validationProcess(processes, projectRoot) {
  return processes.filter((item) => {
    if (!["validation", "browser_validation"].includes(item.type)) return false;
    return item.project === "codexpro" || (item.project_root && isInsidePath(item.project_root, projectRoot));
  });
}

function executorProcess(processes, projectRoot) {
  return processes.filter((item) => {
    if (item.type !== "codex_executor") return false;
    return item.project === "codexpro" || (item.project_root && isInsidePath(item.project_root, projectRoot));
  });
}

function pidRss(processByPid, pid) {
  const row = processByPid.get(Number(pid));
  return typeof row?.rss_mb === "number" ? row.rss_mb : null;
}

function addLivePid(target, evidence, pid, reason, processByPid) {
  const normalized = asPositiveInteger(pid);
  if (!normalized) return false;
  const alive = isProcessAlive(normalized);
  evidence.push({
    source: reason,
    pid: normalized,
    alive,
    rss_mb: pidRss(processByPid, normalized)
  });
  if (alive) target.add(normalized);
  return alive;
}

export function summarizeCodexProState(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const processes = options.processes || [];
  const processScanAvailable = options.processScanAvailable !== false;
  const processByPid = new Map(processes.map((item) => [Number(item.pid), item]));
  const stack = options.stackState || readStackState(options);
  const evidence = [];
  const warnings = [];
  const missing = [];
  const activeExecutorPids = new Set();
  const activeBrowserRunPids = new Set(browserRunProcess(processes, projectRoot).map((item) => item.pid));
  const activeValidationPids = new Set(validationProcess(processes, projectRoot).map((item) => item.pid));
  for (const processInfo of executorProcess(processes, projectRoot)) activeExecutorPids.add(processInfo.pid);

  let serverRssMb = null;
  const serverPid = asPositiveInteger(stack.state?.server?.pid);
  if (serverPid) {
    const supervisor = processByPid.get(serverPid);
    const serviceChild = supervisor?.child_processes?.find((item) => item.type === "codexpro_server");
    serverRssMb = typeof serviceChild?.rss_mb === "number" ? serviceChild.rss_mb : pidRss(processByPid, serverPid);
    evidence.push({
      source: serviceChild ? "codexpro_stack_state.server_child" : "codexpro_stack_state.server",
      path: stack.path,
      pid: serviceChild?.pid ?? serverPid,
      supervisor_pid: serverPid,
      alive: isProcessAlive(serviceChild?.pid ?? serverPid),
      rss_mb: serverRssMb,
      supervisor_rss_mb: pidRss(processByPid, serverPid)
    });
  } else {
    const candidates = processes.filter((item) => item.type === "codexpro_server" && (item.project === "codexpro" || isInsidePath(item.project_root, projectRoot)));
    const fallback = candidates.find((item) => /dist\/(?:http|stdio)\.js\b/.test(item.command_excerpt || "")) ?? candidates[0];
    if (fallback) {
      serverRssMb = fallback.rss_mb;
      evidence.push({ source: "linux_process_scan.codexpro_server", pid: fallback.pid, rss_mb: fallback.rss_mb });
    }
  }
  if (serverRssMb === null) missing.push("codexpro.server_rss_mb");

  let watcherRssMb = null;
  let watcherTotalRssMb = null;
  const watcherRows = Array.isArray(stack.state?.watchers) ? stack.state.watchers : [];
  const matchingWatchers = watcherRows.filter((watcher) => watcher?.root && isInsidePath(watcher.root, projectRoot));
  const allWatcherRss = watcherRows
    .map((watcher) => pidRss(processByPid, watcher?.pid))
    .filter((value) => typeof value === "number");
  const matchingWatcherRss = matchingWatchers
    .map((watcher) => pidRss(processByPid, watcher?.pid))
    .filter((value) => typeof value === "number");
  if (matchingWatcherRss.length) watcherRssMb = round(matchingWatcherRss.reduce((sum, value) => sum + value, 0), 1);
  if (allWatcherRss.length) watcherTotalRssMb = round(allWatcherRss.reduce((sum, value) => sum + value, 0), 1);
  if (matchingWatchers.length) {
    for (const watcher of matchingWatchers) {
      evidence.push({
        source: "codexpro_stack_state.watcher",
        path: stack.path,
        root: watcher.root,
        pid: watcher.pid,
        alive: isProcessAlive(watcher.pid),
        rss_mb: pidRss(processByPid, watcher.pid)
      });
    }
  } else {
    const fallbackWatchers = processes.filter((item) => item.type === "codexpro_watcher" && (item.project === "codexpro" || isInsidePath(item.project_root, projectRoot)));
    if (fallbackWatchers.length) {
      watcherRssMb = round(fallbackWatchers.reduce((sum, item) => sum + (item.rss_mb || 0), 0), 1);
      watcherTotalRssMb = watcherRssMb;
      evidence.push({ source: "linux_process_scan.handoff_watcher", pids: fallbackWatchers.map((item) => item.pid), rss_mb: watcherRssMb });
    }
  }
  if (watcherRssMb === null) missing.push("codexpro.watcher_rss_mb");

  const handoffStatePath = path.join(projectRoot, ".ai-bridge", "handoff-run-state.json");
  const handoffState = readJsonSafe(handoffStatePath);
  if (handoffState) {
    const running = statusActive(handoffState.state);
    const live = running && addLivePid(activeExecutorPids, evidence, handoffState.pid, "handoff_run_state", processByPid);
    if (running && !live) warnings.push("Handoff run state is active, but no live executor PID was proven.");
  } else if (pathExists(handoffStatePath)) {
    missing.push("handoff_run_state_unreadable");
  }

  const durableRoot = path.join(projectRoot, ".codexpro", "runs");
  if (pathExists(durableRoot)) {
    for (const jobPath of listMatchingFiles(durableRoot, "job.json", 3)) {
      const job = readJsonSafe(jobPath);
      if (!job || !statusActive(job.status)) continue;
      const lock = readJsonSafe(path.join(path.dirname(jobPath), "owner.lock"));
      const ownerPid = asPositiveInteger(lock?.pid);
      const live = addLivePid(activeExecutorPids, evidence, ownerPid, "durable_job_owner_lock", processByPid);
      if (!live) warnings.push(`Durable Job ${job.run_id || path.basename(path.dirname(jobPath))} is active without a live owner lock PID.`);
      const phase = String(job.progress?.phase || "");
      const step = String(job.current_step_id || "");
      if (live && (/validat/i.test(phase) || /validat/i.test(step))) activeValidationPids.add(ownerPid);
      if (live && job.progress?.browser_active === true) activeBrowserRunPids.add(ownerPid);
    }
  }

  const goalRoot = path.join(projectRoot, ".ai-bridge", "goals");
  if (pathExists(goalRoot)) {
    for (const goalPath of listMatchingFiles(goalRoot, "goal.json", 2)) {
      const goal = readJsonSafe(goalPath);
      if (!goal || !statusActive(goal.status)) continue;
      const providerRun = goal.checkpoint?.provider_run;
      const ownerPid = providerRun?.owner_pid ?? providerRun?.executor_pid ?? providerRun?.provider_pid ?? null;
      const live = addLivePid(activeExecutorPids, evidence, ownerPid, "goal_provider_run", processByPid);
      if (!live) warnings.push(`Goal ${goal.goal_id || path.basename(path.dirname(goalPath))} is active without a live provider PID.`);
      if (live && ["validating", "reviewing"].includes(String(goal.status))) activeValidationPids.add(asPositiveInteger(ownerPid));
    }
  }

  return {
    server_rss_mb: serverRssMb,
    watcher_rss_mb: watcherRssMb,
    watcher_total_rss_mb: watcherTotalRssMb,
    active_executors: processScanAvailable || activeExecutorPids.size > 0 ? activeExecutorPids.size : null,
    active_browser_runs: processScanAvailable || activeBrowserRunPids.size > 0 ? activeBrowserRunPids.size : null,
    active_validation_runs: processScanAvailable || activeValidationPids.size > 0 ? [...activeValidationPids].filter(Boolean).length : null,
    evidence,
    missing,
    warnings
  };
}

function stripBom(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

export function parseWindowsChromeProcessJson(text) {
  const raw = stripBom(text);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`PowerShell Chrome process JSON parse failed: ${error.message}`);
  }
  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return items
    .map((item) => {
      const pid = asPositiveInteger(item.ProcessId ?? item.processId ?? item.Id);
      if (!pid) return null;
      const rssBytes = Number(item.WorkingSetSize ?? item.WorkingSet64 ?? item.WorkingSet ?? 0);
      return {
        pid,
        name: String(item.Name ?? item.ProcessName ?? "chrome.exe"),
        command_line: String(item.CommandLine ?? ""),
        rss_mb: Number.isFinite(rssBytes) && rssBytes > 0 ? round(rssBytes / MB, 1) : null
      };
    })
    .filter(Boolean);
}

function windowsPathNeedle(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

export function summarizeChromeProcesses(processes, options = {}) {
  const profileNeedles = [
    options.codexProChromeProfile,
    process.env.CODEXPRO_BROWSER_CDP_PROFILE_DIR,
    "CodexPro\\ChromeProfile"
  ].filter(Boolean).map(windowsPathNeedle);
  let missingCommandLine = 0;
  let codexProChromeRssMb = 0;
  let codexProChromeProcessCount = 0;
  let chromeTotalRssMb = 0;
  for (const item of processes) {
    if (typeof item.rss_mb === "number") chromeTotalRssMb += item.rss_mb;
    if (!item.command_line) {
      missingCommandLine += 1;
      continue;
    }
    const command = windowsPathNeedle(item.command_line);
    const profileMatched = profileNeedles.some((needle) => needle && command.includes(needle));
    const cdpMatched = /--remote-debugging-port=\d+/.test(command);
    if (profileMatched || (command.includes("codexpro") && cdpMatched)) {
      codexProChromeProcessCount += 1;
      if (typeof item.rss_mb === "number") codexProChromeRssMb += item.rss_mb;
    }
  }
  return {
    chrome_process_count: processes.length,
    chrome_total_rss_mb: round(chromeTotalRssMb, 1),
    codexpro_chrome_process_count: codexProChromeProcessCount,
    codexpro_chrome_rss_mb: round(codexProChromeRssMb, 1),
    missing_command_line_count: missingCommandLine,
    processes: processes.map((item) => ({
      pid: item.pid,
      rss_mb: item.rss_mb,
      codexpro_profile_match: Boolean(item.command_line && profileNeedles.some((needle) => needle && windowsPathNeedle(item.command_line).includes(needle))),
      command_excerpt: redactCommand(item.command_line)
    }))
  };
}

export function unavailableChromeSummary(reason, extra = {}) {
  return {
    source: {
      status: "unavailable",
      method: "powershell.exe Get-CimInstance Win32_Process Name=chrome.exe",
      reason,
      ...extra
    },
    chrome_process_count: null,
    chrome_total_rss_mb: null,
    codexpro_chrome_process_count: null,
    codexpro_chrome_rss_mb: null,
    missing_command_line_count: null,
    processes: []
  };
}

export function collectWindowsChromeProcesses(options = {}) {
  if (options.skipPowerShell) return unavailableChromeSummary("PowerShell collection was skipped by CLI option.");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$items = @(Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" -ErrorAction SilentlyContinue | Select-Object ProcessId,Name,CommandLine,WorkingSetSize)",
    "$items | ConvertTo-Json -Compress -Depth 4"
  ].join("; ");
  const result = runManagedProcessSync(options.powerShellExecutable || "powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command
  ], {
    timeoutMs: options.timeoutMs ?? 5000,
    maxOutputBytes: 8 * MB,
    domain: "probe",
    operation: "control_center_windows_chrome_processes",
    sideEffectLevel: "none",
    riskLevel: "low",
    recordRoot: process.cwd()
  });
  if (result.spawnError) return unavailableChromeSummary(result.stderr || result.errorClass || "spawn failed", { error_code: result.errorClass });
  if (result.exitCode !== 0) {
    return unavailableChromeSummary(`PowerShell exited ${result.exitCode}.`, {
      stderr: redactSensitiveText(String(result.stderr || "").trim()).slice(0, 500),
      stdout: redactSensitiveText(String(result.stdout || "").trim()).slice(0, 500)
    });
  }
  let processes;
  try {
    processes = parseWindowsChromeProcessJson(result.stdout);
  } catch (error) {
    return unavailableChromeSummary(error.message, {
      stdout: redactSensitiveText(String(result.stdout || "").trim()).slice(0, 500)
    });
  }
  return {
    source: {
      status: "available",
      method: "powershell.exe Get-CimInstance Win32_Process Name=chrome.exe",
      exit_code: result.exitCode
    },
    ...summarizeChromeProcesses(processes, options)
  };
}

export function systemSnapshot() {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    system_memory_total: round(total / MB, 1),
    system_memory_used: round((total - free) / MB, 1),
    system_memory_unit: "MB",
    system_cpu_load: {
      load_1m: round(os.loadavg()[0], 2),
      load_5m: round(os.loadavg()[1], 2),
      load_15m: round(os.loadavg()[2], 2),
      cpu_count: os.cpus().length
    }
  };
}

export function utcTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function collectResourceBaseline(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd());
  const stack = readStackState(options);
  const knownRoots = stackKnownRoots(projectRoot, stack.state);
  const ps = options.processRows
    ? { ok: true, rows: options.processRows }
    : collectLinuxProcessRows();
  const warnings = [];
  if (ps.warning) warnings.push(ps.warning);
  const processes = buildProcessTree(ps.rows || [], { projectRoot, knownRoots });
  const browser = options.browserSummary || collectWindowsChromeProcesses(options);
  const codexpro = summarizeCodexProState({
    projectRoot,
    processes,
    stackState: stack,
    processScanAvailable: ps.ok
  });
  warnings.push(...codexpro.warnings);
  if (browser.source.status === "unavailable") warnings.push(`Windows Chrome process collection unavailable: ${browser.source.reason}`);
  if (browser.missing_command_line_count > 0) warnings.push(`${browser.missing_command_line_count} Chrome process(es) lacked command-line data; CodexPro Chrome RSS may be undercounted.`);

  const missingItems = [...new Set([
    ...(browser.source.status === "unavailable" ? ["browser.chrome_processes"] : []),
    ...codexpro.missing
  ])].sort();

  return {
    version: 1,
    captured_at: options.capturedAt || new Date().toISOString(),
    capture_source: {
      script: "scripts/control-center-resource-baseline.mjs",
      project_root: projectRoot,
      platform: process.platform,
      hostname: os.hostname(),
      linux_process_source: ps.ok ? "ps -eo pid=,ppid=,pcpu=,rss=,args=" : "unavailable",
      windows_chrome_source: browser.source,
      stack_state_path: stack.path,
      stack_state_found: Boolean(stack.state)
    },
    ...systemSnapshot(),
    processes,
    browser,
    codexpro: {
      server_rss_mb: codexpro.server_rss_mb,
      watcher_rss_mb: codexpro.watcher_rss_mb,
      active_executors: codexpro.active_executors,
      active_browser_runs: codexpro.active_browser_runs,
      active_validation_runs: codexpro.active_validation_runs,
      watcher_total_rss_mb: codexpro.watcher_total_rss_mb,
      evidence: codexpro.evidence,
      missing: codexpro.missing
    },
    missing_items: missingItems,
    warnings: [...new Set(warnings)].sort(),
    process_classification_basis: PROCESS_CLASSIFICATION_BASIS
  };
}

function valueOrUnknown(value, suffix = "") {
  return value === null || value === undefined ? "unknown" : `${value}${suffix}`;
}

function mdTable(rows) {
  if (!rows.length) return "_None._\n";
  return rows.join("\n") + "\n";
}

export function renderResourceBaselineMarkdown(report) {
  const chromeSource = report.browser?.source?.status === "available"
    ? "available"
    : `unavailable (${report.browser?.source?.reason || "unknown reason"})`;
  const processRows = report.processes.map((item) =>
    `| ${item.pid} | ${item.type} | ${item.project} | ${item.command_class} | ${valueOrUnknown(item.cpu_percent)} | ${valueOrUnknown(item.rss_mb)} | ${item.child_processes.length} | ${item.command_excerpt.replaceAll("|", "\\|")} |`
  );
  const basisRows = report.process_classification_basis.map((item) =>
    `| ${item.command_class} | ${item.type} | ${item.basis.replaceAll("|", "\\|")} |`
  );
  const evidenceRows = report.codexpro.evidence.map((item) =>
    `| ${item.source} | ${item.pid ?? ""} | ${item.alive ?? ""} | ${item.rss_mb ?? ""} | ${String(item.path || item.root || "").replaceAll("|", "\\|")} |`
  );
  const chromeRows = (report.browser.processes || []).map((item) =>
    `| ${item.pid} | ${valueOrUnknown(item.rss_mb)} | ${item.codexpro_profile_match ? "yes" : "no"} | ${item.command_excerpt.replaceAll("|", "\\|")} |`
  );

  return [
    "# CodexPro CC0 Resource Baseline",
    "",
    `Captured at: ${report.captured_at}`,
    `Project root: ${report.capture_source.project_root}`,
    "",
    "## Capture Source",
    "",
    `- Linux/WSL processes: ${report.capture_source.linux_process_source}`,
    `- Windows Chrome: ${chromeSource}`,
    `- Stack state: ${report.capture_source.stack_state_found ? report.capture_source.stack_state_path : `missing at ${report.capture_source.stack_state_path}`}`,
    "",
    "## Summary",
    "",
    `- System memory: ${report.system_memory_used} / ${report.system_memory_total} ${report.system_memory_unit}`,
    `- CPU load: ${report.system_cpu_load.load_1m}, ${report.system_cpu_load.load_5m}, ${report.system_cpu_load.load_15m} across ${report.system_cpu_load.cpu_count} CPUs`,
    `- Chrome processes: ${valueOrUnknown(report.browser.chrome_process_count)}, total RSS ${valueOrUnknown(report.browser.chrome_total_rss_mb, " MB")}, CodexPro Chrome RSS ${valueOrUnknown(report.browser.codexpro_chrome_rss_mb, " MB")}`,
    `- CodexPro server RSS: ${valueOrUnknown(report.codexpro.server_rss_mb, " MB")}`,
    `- CodexPro watcher RSS: ${valueOrUnknown(report.codexpro.watcher_rss_mb, " MB")}`,
    `- Active executors: ${valueOrUnknown(report.codexpro.active_executors)}`,
    `- Active browser runs: ${valueOrUnknown(report.codexpro.active_browser_runs)}`,
    `- Active validation runs: ${valueOrUnknown(report.codexpro.active_validation_runs)}`,
    "",
    "## Missing Items",
    "",
    report.missing_items.length ? report.missing_items.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "## Warnings",
    "",
    report.warnings.length ? report.warnings.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "## Process Classification Basis",
    "",
    "| command_class | type | basis |",
    "| --- | --- | --- |",
    mdTable(basisRows).trimEnd(),
    "",
    "## Linux/WSL Processes",
    "",
    "| pid | type | project | command_class | cpu_percent | rss_mb | child_processes | command_excerpt |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | --- |",
    mdTable(processRows).trimEnd(),
    "",
    "## Windows Chrome",
    "",
    "| pid | rss_mb | codexpro_profile_match | command_excerpt |",
    "| --- | ---: | --- | --- |",
    mdTable(chromeRows).trimEnd(),
    "",
    "## CodexPro Evidence",
    "",
    "| source | pid | alive | rss_mb | path/root |",
    "| --- | ---: | --- | ---: | --- |",
    mdTable(evidenceRows).trimEnd(),
    ""
  ].join("\n");
}

export function writeResourceBaseline(report, options = {}) {
  const projectRoot = path.resolve(options.projectRoot || report.capture_source.project_root || process.cwd());
  const outputDir = path.resolve(options.outputDir || path.join(projectRoot, ".ai-bridge", "resource-baselines"));
  const timestamp = options.timestamp || utcTimestamp(new Date(report.captured_at));
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(outputDir, `${timestamp}.json`);
  const mdPath = path.join(outputDir, `${timestamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(mdPath, renderResourceBaselineMarkdown(report), { encoding: "utf8", mode: 0o600 });
  return { jsonPath, mdPath };
}
