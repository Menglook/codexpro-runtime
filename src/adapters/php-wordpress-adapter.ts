import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { CodexProError } from "../guard.js";
import { redactSensitiveText } from "../redact.js";
import { runProcess as runManagedProcess } from "../runtime/processWrapper.js";

export type PhpWordPressToolSafety = "read" | "run";

export interface PhpWordPressToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface PhpWordPressToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  safety: PhpWordPressToolSafety;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<PhpWordPressToolResult>;
}

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;

interface ProjectCwd {
  absPath: string;
  relPath: string;
}

interface ComposerInfo {
  path: string | null;
  name?: string;
  type?: string;
  scripts: Record<string, string>;
  dependencies: string[];
}

interface WordPressProjectInfo {
  cwd: string;
  wordpress_root: string | null;
  wp_content_dir: string | null;
  themes_dir: string | null;
  plugins_dir: string | null;
  uploads_dir: string | null;
  wp_config_path: string | null;
  has_wordpress: boolean;
  has_composer: boolean;
  has_woocommerce: boolean;
  composer: ComposerInfo;
  risk_paths: string[];
  suggested_readonly_checks: Array<{ name: string; command: string; cwd: string; note?: string }>;
}

interface PhpLintResult {
  file: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  spawnError?: string;
}

const MAX_TEXT_FILE_BYTES = 512_000;
const MAX_HEADER_BYTES = 64_000;
const DEFAULT_OUTPUT_BYTES = 80_000;
const WORDPRESS_ROOT_CANDIDATES = ["", "public", "web", "wordpress", "wp", "app/public"];
const WORDPRESS_CONTENT_CANDIDATES = ["wp-content", "app"];
const RISK_PATH_CANDIDATES = ["mysql", "mysql-data", "db_data"];

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function cwdArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Directory inside the workspace that contains composer.json or WordPress files. Default: workspace root.");
}

function formatJsonBlock(value: unknown): string {
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function normalizeRelPath(value: string): string {
  const normalized = value.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
  return normalized || ".";
}

function relFromWorkspace(workspace: Workspace, absPath: string): string {
  return normalizeRelPath(path.relative(workspace.root, absPath));
}

function joinRel(base: string, child: string): string {
  const normalizedBase = normalizeRelPath(base);
  const normalizedChild = child.split(path.sep).join("/").replace(/^\.\//, "");
  return normalizedBase === "." ? normalizedChild : `${normalizedBase}/${normalizedChild}`;
}

function fileExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isFile();
  } catch {
    return false;
  }
}

function dirExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

function readTextIfSmall(absPath: string, maxBytes = MAX_TEXT_FILE_BYTES): string | undefined {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    return fs.readFileSync(absPath, "utf8");
  } catch {
    return undefined;
  }
}

function readJsonIfSmall(absPath: string): Record<string, unknown> | undefined {
  const raw = readTextIfSmall(absPath);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function resolveProjectCwd(guard: PathGuard, workspace: Workspace, cwdInput?: string): ProjectCwd {
  const resolved = guard.resolve(workspace, cwdInput ?? ".");
  const stat = fs.statSync(resolved.absPath);
  if (!stat.isDirectory()) throw new CodexProError(`PHP / WordPress cwd is not a directory: ${resolved.relPath}`);
  return { absPath: resolved.absPath, relPath: normalizeRelPath(resolved.relPath) };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") out[key] = item;
  }
  return out;
}

function composerDependencyNames(composerJson: Record<string, unknown> | undefined): string[] {
  if (!composerJson) return [];
  const names = new Set<string>();
  for (const group of [composerJson.require, composerJson["require-dev"]]) {
    if (!group || typeof group !== "object" || Array.isArray(group)) continue;
    for (const key of Object.keys(group)) names.add(key.toLowerCase());
  }
  return [...names].sort();
}

function readComposerInfo(workspace: Workspace, cwd: ProjectCwd): ComposerInfo {
  const absPath = path.join(cwd.absPath, "composer.json");
  const relPath = joinRel(cwd.relPath, "composer.json");
  if (!fileExists(absPath)) {
    return { path: null, scripts: {}, dependencies: [] };
  }
  const composerJson = readJsonIfSmall(absPath);
  return {
    path: relPath,
    name: typeof composerJson?.name === "string" ? composerJson.name : undefined,
    type: typeof composerJson?.type === "string" ? composerJson.type : undefined,
    scripts: stringRecord(composerJson?.scripts),
    dependencies: composerDependencyNames(composerJson)
  };
}

function detectWordPressLayout(workspace: Workspace, cwd: ProjectCwd): Pick<WordPressProjectInfo, "wordpress_root" | "wp_content_dir" | "themes_dir" | "plugins_dir" | "uploads_dir" | "wp_config_path" | "has_wordpress"> {
  for (const rootCandidate of WORDPRESS_ROOT_CANDIDATES) {
    const rootAbs = rootCandidate ? path.join(cwd.absPath, rootCandidate) : cwd.absPath;
    if (!dirExists(rootAbs)) continue;
    const rootRel = relFromWorkspace(workspace, rootAbs);
    const wpConfigAbs = path.join(rootAbs, "wp-config.php");
    const classicContentAbs = path.join(rootAbs, "wp-content");
    const bedrockContentAbs = path.join(rootAbs, "app");
    const hasCoreDirs = dirExists(path.join(rootAbs, "wp-admin")) && dirExists(path.join(rootAbs, "wp-includes"));
    const hasRootMarker = fileExists(wpConfigAbs) || hasCoreDirs;

    let contentAbs: string | null = null;
    for (const contentCandidate of WORDPRESS_CONTENT_CANDIDATES) {
      const candidateAbs = path.join(rootAbs, contentCandidate);
      if (dirExists(candidateAbs)) {
        contentAbs = candidateAbs;
        break;
      }
    }

    if (!contentAbs && !hasRootMarker) continue;
    const contentRel = contentAbs ? relFromWorkspace(workspace, contentAbs) : null;
    const themesAbs = contentAbs ? path.join(contentAbs, "themes") : null;
    const pluginsAbs = contentAbs ? path.join(contentAbs, "plugins") : null;
    const uploadsAbs = contentAbs ? path.join(contentAbs, "uploads") : null;
    return {
      wordpress_root: rootRel,
      wp_content_dir: contentRel,
      themes_dir: themesAbs && dirExists(themesAbs) ? relFromWorkspace(workspace, themesAbs) : (contentRel ? `${contentRel}/themes` : null),
      plugins_dir: pluginsAbs && dirExists(pluginsAbs) ? relFromWorkspace(workspace, pluginsAbs) : (contentRel ? `${contentRel}/plugins` : null),
      uploads_dir: uploadsAbs && dirExists(uploadsAbs) ? relFromWorkspace(workspace, uploadsAbs) : (contentRel ? `${contentRel}/uploads` : null),
      wp_config_path: fileExists(wpConfigAbs) ? relFromWorkspace(workspace, wpConfigAbs) : null,
      has_wordpress: true
    };
  }

  return {
    wordpress_root: null,
    wp_content_dir: null,
    themes_dir: null,
    plugins_dir: null,
    uploads_dir: null,
    wp_config_path: null,
    has_wordpress: false
  };
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = value?.trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function inspectPhpWordPressProject(guard: PathGuard, workspace: Workspace, cwdInput?: string): WordPressProjectInfo {
  const cwd = resolveProjectCwd(guard, workspace, cwdInput);
  const composer = readComposerInfo(workspace, cwd);
  const layout = detectWordPressLayout(workspace, cwd);
  const pluginDirs = [layout.plugins_dir].filter(Boolean) as string[];
  const hasWooCommerceDir = pluginDirs.some((pluginDir) => dirExists(path.join(workspace.root, pluginDir, "woocommerce")) || fileExists(path.join(workspace.root, pluginDir, "woocommerce.php")));
  const hasWooCommerceDependency = composer.dependencies.some((item) => item.includes("woocommerce"));
  const riskPaths = uniqueStrings([
    layout.wp_config_path,
    layout.uploads_dir,
    ...RISK_PATH_CANDIDATES.map((candidate) => dirExists(path.join(cwd.absPath, candidate)) ? joinRel(cwd.relPath, candidate) : null)
  ]);
  const suggested: WordPressProjectInfo["suggested_readonly_checks"] = [];
  if (composer.path) {
    suggested.push({ name: "composer_validate", command: "composer validate --no-check-publish", cwd: cwd.relPath });
  }
  if (layout.has_wordpress) {
    suggested.push(
      { name: "wp_plugin_list", command: "wp plugin list", cwd: layout.wordpress_root ?? cwd.relPath, note: "Read-only WP-CLI inspection; requires safe target environment." },
      { name: "wp_theme_list", command: "wp theme list", cwd: layout.wordpress_root ?? cwd.relPath, note: "Read-only WP-CLI inspection; requires safe target environment." }
    );
  }

  return {
    cwd: cwd.relPath,
    ...layout,
    has_composer: Boolean(composer.path),
    has_woocommerce: hasWooCommerceDir || hasWooCommerceDependency,
    composer,
    risk_paths: riskPaths,
    suggested_readonly_checks: suggested
  };
}

function directoryNames(workspace: Workspace, relDir: string | null, maxEntries: number): Array<{ name: string; path: string; type: "directory" | "file" }> {
  if (!relDir) return [];
  const absDir = path.join(workspace.root, relDir);
  if (!dirExists(absDir)) return [];
  return fs.readdirSync(absDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== "index.php")
    .map((entry) => ({
      name: entry.name,
      path: `${relDir}/${entry.name}`,
      type: entry.isDirectory() ? "directory" as const : "file" as const
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, maxEntries);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseWordPressHeaders(raw: string, headerNames: string[]): Record<string, string> {
  const text = raw.slice(0, MAX_HEADER_BYTES);
  const headers: Record<string, string> = {};
  for (const header of headerNames) {
    const pattern = new RegExp(`^[\\s/*#@]*${escapeRegExp(header)}\\s*:\\s*(.+)$`, "im");
    const match = text.match(pattern);
    if (match?.[1]) headers[header] = match[1].trim().replace(/\*\/$/, "").trim();
  }
  return headers;
}

function readHeaderFile(absPath: string): string | undefined {
  return readTextIfSmall(absPath, MAX_HEADER_BYTES);
}

function themeInfo(workspace: Workspace, info: WordPressProjectInfo, maxThemes: number): Array<Record<string, unknown>> {
  const themes = directoryNames(workspace, info.themes_dir, maxThemes).filter((entry) => entry.type === "directory");
  return themes.map((theme) => {
    const styleRel = `${theme.path}/style.css`;
    const styleAbs = path.join(workspace.root, styleRel);
    const headers = fileExists(styleAbs)
      ? parseWordPressHeaders(readHeaderFile(styleAbs) ?? "", ["Theme Name", "Version", "Template", "Author", "Description", "Text Domain"])
      : {};
    return {
      slug: theme.name,
      path: theme.path,
      style_css: fileExists(styleAbs) ? styleRel : null,
      name: headers["Theme Name"] ?? theme.name,
      version: headers.Version ?? null,
      parent_template: headers.Template ?? null,
      author: headers.Author ?? null,
      text_domain: headers["Text Domain"] ?? null,
      description: headers.Description ?? null
    };
  });
}

function topLevelPhpFiles(absDir: string): string[] {
  try {
    return fs.readdirSync(absDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".php"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function findPluginMainFile(absDir: string, slug: string): string | null {
  const candidates = uniqueStrings([`${slug}.php`, ...topLevelPhpFiles(absDir)]);
  for (const candidate of candidates) {
    const absPath = path.join(absDir, candidate);
    const raw = readHeaderFile(absPath);
    if (!raw) continue;
    const headers = parseWordPressHeaders(raw, ["Plugin Name"]);
    if (headers["Plugin Name"]) return candidate;
  }
  return candidates[0] ?? null;
}

function pluginInfo(workspace: Workspace, info: WordPressProjectInfo, maxPlugins: number): Array<Record<string, unknown>> {
  const plugins = directoryNames(workspace, info.plugins_dir, maxPlugins);
  return plugins.map((plugin) => {
    const pluginAbs = path.join(workspace.root, plugin.path);
    const mainFileName = plugin.type === "directory" ? findPluginMainFile(pluginAbs, plugin.name) : plugin.name;
    const mainRel = mainFileName ? (plugin.type === "directory" ? `${plugin.path}/${mainFileName}` : plugin.path) : null;
    const raw = mainRel ? readHeaderFile(path.join(workspace.root, mainRel)) : undefined;
    const headers = raw
      ? parseWordPressHeaders(raw, ["Plugin Name", "Version", "Description", "Author", "Text Domain", "Requires PHP", "Requires at least", "WC requires at least", "WC tested up to"])
      : {};
    const pluginName = headers["Plugin Name"] ?? plugin.name.replace(/\.php$/i, "");
    const isWooCommerce = plugin.name.toLowerCase() === "woocommerce" || pluginName.toLowerCase().includes("woocommerce");
    return {
      slug: plugin.name.replace(/\.php$/i, ""),
      path: plugin.path,
      type: plugin.type,
      main_file: mainRel,
      name: pluginName,
      version: headers.Version ?? null,
      author: headers.Author ?? null,
      text_domain: headers["Text Domain"] ?? null,
      requires_php: headers["Requires PHP"] ?? null,
      requires_wordpress: headers["Requires at least"] ?? null,
      wc_requires_at_least: headers["WC requires at least"] ?? null,
      wc_tested_up_to: headers["WC tested up to"] ?? null,
      description: headers.Description ?? null,
      is_woocommerce: isWooCommerce
    };
  });
}

function maxOutputBytes(config: CodexProConfig): number {
  return Math.max(1_000, Math.min(config.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, 200_000));
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = config.inheritEnv
    ? { ...process.env }
    : {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "",
        USER: process.env.USER ?? "",
        SHELL: process.env.SHELL ?? "/bin/bash",
        TMPDIR: process.env.TMPDIR ?? "/tmp",
        TERM: "dumb"
      };
  return {
    ...base,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: base.CI ?? "1"
  };
}

function assertPhpRunAllowed(config: CodexProConfig, sessionId?: string): void {
  if (config.bashMode === "off") {
    throw new CodexProError("php_lint_files is disabled because CODEXPRO_BASH_MODE=off. Enable bash/shell execution to run PHP lint checks.");
  }
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    }
    return;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
  }
}

function phpExecutable(): string {
  return process.platform === "win32" ? "php.exe" : "php";
}

async function runPhpLint(config: CodexProConfig, workspace: Workspace, file: { absPath: string; relPath: string }, timeoutMs: number): Promise<PhpLintResult> {
  const executable = phpExecutable();
  const started = Date.now();
  const outputLimit = maxOutputBytes(config);
  const timeout = Math.max(1_000, Math.min(timeoutMs, 60_000));
  const result = await runManagedProcess(executable, ["-l", file.absPath], {
    cwd: workspace.root,
    env: makeEnv(config),
    timeoutMs: timeout,
    killGraceMs: 1_500,
    maxOutputBytes: outputLimit,
    domain: "adapter",
    operation: "php_lint",
    sideEffectLevel: "local_read",
    riskLevel: "low"
  });
  const stderr = result.timedOut
    ? `${result.stderr}\n[codexpro] PHP lint timed out after ${timeout} ms.`
    : result.stderr;
  const out = trimOutput(redactSensitiveText(result.stdout), outputLimit);
  const err = trimOutput(redactSensitiveText(stderr), outputLimit);
  return {
    file: file.relPath,
    command: `php -l ${file.relPath}`,
    cwd: relFromWorkspace(workspace, workspace.root),
    durationMs: result.durationMs || Date.now() - started,
    stdout: out.value,
    stderr: err.value,
    truncated: out.truncated || err.truncated || result.truncated,
    exitCode: result.exitCode,
    signal: result.signal,
    ...(result.spawnError ? { spawnError: result.stderr || result.errorClass || "spawn failed" } : {})
  };
}

function resolveLintFile(guard: PathGuard, workspace: Workspace, relPathInput: string): { absPath: string; relPath: string } {
  const resolved = guard.resolve(workspace, relPathInput);
  const stat = fs.statSync(resolved.absPath);
  if (!stat.isFile()) throw new CodexProError(`PHP lint target is not a file: ${resolved.relPath}`);
  if (!resolved.relPath.toLowerCase().endsWith(".php")) throw new CodexProError(`PHP lint target must be a .php file: ${resolved.relPath}`);
  return { absPath: resolved.absPath, relPath: normalizeRelPath(resolved.relPath) };
}

export function phpWordPressToolNames(): string[] {
  return ["wordpress_status", "wordpress_theme_info", "wordpress_plugin_info", "php_lint_files"];
}

export function createPhpWordPressTools(config: CodexProConfig, guard: PathGuard, resolveWorkspace: WorkspaceResolver): PhpWordPressToolDefinition[] {
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  const projectInfoFor = (args: any) => inspectPhpWordPressProject(guard, workspaceFor(args), args.cwd);

  return [
    {
      name: "wordpress_status",
      title: "WordPress Status",
      description: "Inspect PHP / WordPress project markers, Composer metadata, WooCommerce signals, important paths, risk paths, and safe read-only check suggestions without changing files or databases.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg()
      },
      safety: "read",
      invoking: "Inspecting WordPress project status...",
      invoked: "WordPress project status ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const info = projectInfoFor(args);
        const text = [
          "# WordPress Status",
          "",
          `CWD: ${info.cwd}`,
          `WordPress detected: ${info.has_wordpress ? "yes" : "no"}`,
          `Composer detected: ${info.has_composer ? "yes" : "no"}`,
          `WooCommerce detected: ${info.has_woocommerce ? "yes" : "no"}`,
          `WordPress root: ${info.wordpress_root ?? "n/a"}`,
          `wp-content: ${info.wp_content_dir ?? "n/a"}`,
          `Themes dir: ${info.themes_dir ?? "n/a"}`,
          `Plugins dir: ${info.plugins_dir ?? "n/a"}`,
          `Uploads risk path: ${info.uploads_dir ?? "n/a"}`,
          `wp-config risk path: ${info.wp_config_path ?? "n/a"}`,
          `Existing risk paths: ${info.risk_paths.length ? info.risk_paths.join(", ") : "none"}`,
          "",
          "## Suggested read-only checks",
          info.suggested_readonly_checks.length
            ? info.suggested_readonly_checks.map((check) => `- ${check.name}: \`${check.command}\` (cwd: ${check.cwd})${check.note ? ` — ${check.note}` : ""}`).join("\n")
            : "- none",
          formatJsonBlock(info)
        ].join("\n");
        return { text, structured: { ...info, root: workspace.root } };
      }
    },
    {
      name: "wordpress_theme_info",
      title: "WordPress Theme Info",
      description: "List WordPress theme directories and parse bounded style.css headers such as Theme Name, Version, Template, Author, and Text Domain.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        max_themes: z.number().int().min(1).max(200).optional().describe("Maximum themes to list. Default: 80.")
      },
      safety: "read",
      invoking: "Reading WordPress theme info...",
      invoked: "WordPress theme info ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const info = projectInfoFor(args);
        const themes = themeInfo(workspace, info, args.max_themes ?? 80);
        const text = [
          "# WordPress Theme Info",
          "",
          `Themes dir: ${info.themes_dir ?? "n/a"}`,
          `Themes listed: ${themes.length}`,
          formatJsonBlock(themes)
        ].join("\n");
        return { text, structured: { themes_dir: info.themes_dir, themes, project: info } };
      }
    },
    {
      name: "wordpress_plugin_info",
      title: "WordPress Plugin Info",
      description: "List WordPress plugin directories/files and parse bounded plugin headers. Flags WooCommerce when a WooCommerce plugin directory or header is present.",
      inputSchema: {
        workspace_id: workspaceArg(),
        cwd: cwdArg(),
        max_plugins: z.number().int().min(1).max(300).optional().describe("Maximum plugins to list. Default: 120.")
      },
      safety: "read",
      invoking: "Reading WordPress plugin info...",
      invoked: "WordPress plugin info ready",
      async handler(args) {
        const workspace = workspaceFor(args);
        const info = projectInfoFor(args);
        const plugins = pluginInfo(workspace, info, args.max_plugins ?? 120);
        const wooCommerce = plugins.filter((plugin) => plugin.is_woocommerce);
        const text = [
          "# WordPress Plugin Info",
          "",
          `Plugins dir: ${info.plugins_dir ?? "n/a"}`,
          `Plugins listed: ${plugins.length}`,
          `WooCommerce plugins: ${wooCommerce.length}`,
          formatJsonBlock(plugins)
        ].join("\n");
        return { text, structured: { plugins_dir: info.plugins_dir, plugins, woocommerce_plugins: wooCommerce, project: info } };
      }
    },
    {
      name: "php_lint_files",
      title: "PHP Lint Files",
      description: "Run php -l on explicit .php files only. It does not execute application code, does not accept shell strings, and never modifies WordPress files, uploads, database volumes, orders, products, or configuration secrets.",
      inputSchema: {
        workspace_id: workspaceArg(),
        files: z.array(z.string()).min(1).max(20).describe("Explicit .php files inside the workspace to lint. Directories and non-PHP files are rejected."),
        timeout_ms: z.number().int().min(1000).max(60000).optional().describe("Per-file timeout. Default: 15000."),
        session_id: z.string().optional().describe("Optional bash session id when this server requires one.")
      },
      safety: "run",
      invoking: "Running PHP lint checks...",
      invoked: "PHP lint checks complete",
      async handler(args) {
        assertPhpRunAllowed(config, args.session_id);
        const workspace = workspaceFor(args);
        const files = (args.files as string[]).map((file) => resolveLintFile(guard, workspace, file));
        const results: PhpLintResult[] = [];
        for (const file of files) {
          results.push(await runPhpLint(config, workspace, file, args.timeout_ms ?? 15_000));
        }
        const failed = results.filter((result) => result.exitCode !== 0 || result.spawnError);
        const text = [
          "# PHP Lint Files",
          "",
          `Files checked: ${results.length}`,
          `Failures: ${failed.length}`,
          ...results.map((result) => [
            "",
            `## ${result.file}`,
            `Command: \`${result.command}\``,
            `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
            result.spawnError ? `Spawn error: ${result.spawnError}` : "",
            `Duration: ${result.durationMs} ms`,
            result.truncated ? "Output: truncated" : "Output: complete",
            result.stdout ? ["", "### stdout", "", "```text", result.stdout, "```"].join("\n") : "",
            result.stderr ? ["", "### stderr", "", "```text", result.stderr, "```"].join("\n") : ""
          ].filter(Boolean).join("\n"))
        ].join("\n");
        return { text, structured: { files: files.map((file) => file.relPath), results, failed, status: failed.length ? "fail" : "pass" } };
      }
    }
  ];
}
