#!/usr/bin/env node
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { expandHome, loadConfig, type CodexProConfig } from "./config.js";
import { isSubpath } from "./guard.js";
import {
  profilePathForRoot,
  readRuntimeConnection,
  readWorkspaceProfile,
  sanitizeWorkspaceProfile,
  saveWorkspaceProfile,
  type ConnectorMode,
  type TunnelMode,
  type WorkspaceProfile
} from "./profileStore.js";
import { redactSensitiveText, redactStructured } from "./redact.js";
import { createCodexProServer } from "./server.js";
import { onboardingPage } from "./http/adminSurface.js";
import { officeSurfacePage } from "./http/officeSurface.js";
import { OfficeSnapshotService } from "./http/officeSnapshotService.js";
import { officeSceneFeatureFlag } from "./http/officeSceneSurface.js";
import { projectOfficeVisualSnapshot } from "./http/officeVisualProjection.js";
import { OfficeReportService, OfficeReportServiceError } from "./http/officeReportService.js";
import { OfficeToolOutcomeService, OfficeToolOutcomeServiceError, officeToolOutcomeFeatureFlag } from "./http/officeToolOutcomeService.js";
import { officeCapabilityRegistry } from "./http/officeCapabilityRegistry.js";
import { discoverDashboardProjects, isAllowedDashboardArtifactPath, ProjectAggregationService, resolveDashboardArtifactRoot } from "./http/projectAggregationService.js";
import { TaskActionError, TaskActionService } from "./http/taskActionService.js";
import { AttentionService, AttentionServiceError, installAttentionEventBusListener } from "./http/attentionService.js";
import { StructuredTaskError, StructuredTaskService } from "./http/structuredTaskService.js";
import { consoleEnumLabel, formatConsoleDateTime } from "./http/consoleLocale.js";
import { ProjectionSnapshotProvider } from "./tasks/projectionSnapshot.js";
import { browserAuthorizationStore } from "./browser/browser-authorization.js";
import { recoverConfiguredDurableJobs } from "./jobs/jobStartup.js";
import { runProcessSync } from "./runtime/processWrapper.js";
import { applyBrowserRuntimeEnv } from "../shared/browser-runtime-env.mjs";
import { goldTaskRuntimeIdentity, recordGoldTaskConnectorConnection } from "./evaluation/goldTaskSession.js";
import { handleModernMcpRequest } from "./mcp/modern/handler.js";
import { protectedResourceMetadata } from "./mcp/modern/oauth.js";
import { declaredModernProtocolVersion, shouldHandleModernMcpRequest, type McpHeaderMap } from "./mcp/modern/requestContext.js";

const HTTP_PROCESS_RECORD_ROOT = path.join(os.tmpdir(), "codexpro-http-process-records");

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function copyCommand(title: string, description: string, command: string, displayCommand = command, copyKind = ""): string {
  const copyAttrs = copyKind
    ? `data-copy-kind="${escapeHtml(copyKind)}" data-copy-base="${escapeHtml(command)}"`
    : `data-copy="${escapeHtml(command)}"`;
  return `<div class="control">
    <div>
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
      <code>${escapeHtml(displayCommand)}</code>
    </div>
    <button type="button" class="copy-mini" ${copyAttrs}>复制</button>
  </div>`;
}

const TUNNELS = ["cloudflare", "ngrok", "cloudflare-named", "none"] as const;
const MODES = ["agent", "handoff", "pro"] as const;
const BASH_MODES = ["safe", "off", "full"] as const;
const BASH_TRANSCRIPTS = ["compact", "full"] as const;
const CODEX_SESSIONS = ["off", "metadata", "read"] as const;
const WRITE_MODES = ["workspace", "handoff", "off"] as const;
const TOOL_MODES = ["standard", "progressive", "minimal", "full"] as const;

const textField = (max: number) =>
  z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().max(max).optional());

const AdminProfilePatch = z.object({
  tunnel: z.enum(TUNNELS).optional(),
  hostname: textField(253),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  mode: z.enum(MODES).optional(),
  bash: z.enum(BASH_MODES).optional(),
  bashTranscript: z.enum(BASH_TRANSCRIPTS).optional(),
  codexSessions: z.enum(CODEX_SESSIONS).optional(),
  codexDir: textField(4096),
  bashSession: textField(64).refine(
    (value) => !value || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value),
    "bashSession must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number."
  ),
  requireBashSession: z.boolean().optional(),
  write: z.enum(WRITE_MODES).optional(),
  toolMode: z.enum(TOOL_MODES).optional(),
  toolCards: z.boolean().optional(),
  widgetDomain: textField(2048),
  tunnelName: textField(128),
  ngrokConfig: textField(4096),
  cloudflareConfig: textField(4096),
  cloudflareTokenFile: textField(4096),
  noInstallCloudflared: z.boolean().optional()
}).strict();

type AdminProfilePatch = z.infer<typeof AdminProfilePatch>;

const OfficeQuery = z.object({
  project: textField(240),
  include_archived: z.preprocess(
    (value) => value === undefined ? undefined : value === "1" || value === "true" || value === true,
    z.boolean().optional()
  ),
  include_test_history: z.preprocess(
    (value) => value === "1" || value === "true" || value === true,
    z.boolean().optional()
  ),
  archive_limit: z.coerce.number().int().min(1).max(50).optional(),
  active_limit_per_project: z.coerce.number().int().min(1).max(50).optional()
});

interface ProfileFormValues {
  port: string;
  mode: ConnectorMode;
  tunnel: TunnelMode;
  hostname: string;
  tunnelName: string;
  ngrokConfig: string;
  cloudflareConfig: string;
  cloudflareTokenFile: string;
  bash: "off" | "safe" | "full";
  bashTranscript: "compact" | "full";
  codexSessions: "off" | "metadata" | "read";
  codexDir: string;
  bashSession: string;
  requireBashSession: boolean;
  write: "off" | "handoff" | "workspace";
  toolMode: "minimal" | "progressive" | "standard" | "full";
  toolCards: boolean;
  widgetDomain: string;
  noInstallCloudflared: boolean;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, fallback: T[number]): T[number] {
  return typeof value === "string" && values.includes(value) ? value : fallback;
}

function runtimeTunnelFallback(): TunnelMode {
  if (process.env.CODEXPRO_TUNNEL && TUNNELS.includes(process.env.CODEXPRO_TUNNEL as TunnelMode)) {
    return process.env.CODEXPRO_TUNNEL as TunnelMode;
  }
  return process.env.CODEXPRO_TUNNEL_MODE === "0" ? "none" : "cloudflare";
}

function normalizePublicHostname(value: string | undefined): string {
  const raw = value?.trim().replace(/\/+$/, "") ?? "";
  if (!raw) return "";
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  if (url.protocol !== "https:") throw new Error("hostname must use https when a scheme is provided.");
  if (url.search || url.hash) throw new Error("hostname must not include query strings or fragments.");
  if (url.pathname !== "/" && url.pathname !== "/mcp") throw new Error("hostname must be a host, URL root, or /mcp URL.");
  return url.host;
}

function normalizeWidgetDomain(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("widgetDomain must use https.");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("widgetDomain must be an origin only, for example https://widgets.example.com.");
  }
  return url.origin;
}

function effectiveWriteMode(mode: ConnectorMode, write: ProfileFormValues["write"]): ProfileFormValues["write"] {
  if (mode === "agent") return write;
  return write === "off" ? "off" : "handoff";
}

function normalizeProfilePath(root: string, value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  const expanded = expandHome(raw);
  return path.isAbsolute(expanded) || path.win32.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(root, expanded);
}

function profileValues(config: CodexProConfig, profile = readWorkspaceProfile(config.defaultRoot)): ProfileFormValues {
  const hostname =
    profile.hostname ??
    process.env.CODEXPRO_PUBLIC_HOSTNAME ??
    process.env.CODEXPRO_HOSTNAME ??
    process.env.NGROK_DOMAIN ??
    "";
  const mode = oneOf(profile.mode ?? process.env.CODEXPRO_MODE, MODES, "agent");
  const write = effectiveWriteMode(mode, oneOf(profile.write ?? config.writeMode, WRITE_MODES, config.writeMode));
  return {
    port: String(profile.port ?? config.port),
    mode,
    tunnel: oneOf(profile.tunnel, TUNNELS, runtimeTunnelFallback()),
    hostname: String(hostname),
    tunnelName: String(profile.tunnelName ?? ""),
    ngrokConfig: String(profile.ngrokConfig ?? ""),
    cloudflareConfig: String(profile.cloudflareConfig ?? ""),
    cloudflareTokenFile: String(profile.cloudflareTokenFile ?? ""),
    bash: oneOf(profile.bash ?? config.bashMode, BASH_MODES, config.bashMode),
    bashTranscript: oneOf(profile.bashTranscript ?? config.bashTranscript, BASH_TRANSCRIPTS, config.bashTranscript),
    codexSessions: oneOf(profile.codexSessions ?? config.codexSessions, CODEX_SESSIONS, config.codexSessions),
    codexDir: String(profile.codexDir ?? config.codexDir),
    bashSession: String(profile.bashSession ?? config.bashSessionId ?? ""),
    requireBashSession: Boolean(profile.requireBashSession ?? config.requireBashSession),
    write,
    toolMode: oneOf(profile.toolMode ?? config.toolMode, TOOL_MODES, config.toolMode),
    toolCards: Boolean(profile.toolCards ?? config.toolCards),
    widgetDomain: String(profile.widgetDomain ?? config.widgetDomain),
    noInstallCloudflared: Boolean(profile.noInstallCloudflared)
  };
}

const OPTION_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare 快速隧道",
  ngrok: "ngrok 固定地址",
  "cloudflare-named": "Cloudflare 命名隧道",
  none: "仅本机",
  agent: "代理模式",
  handoff: "交接模式",
  pro: "专业包模式",
  safe: "安全模式",
  off: "关闭",
  full: "完整",
  compact: "精简",
  metadata: "仅元数据",
  read: "只读",
  workspace: "工作区",
  minimal: "最小",
  progressive: "渐进",
  standard: "标准"
};

function optionLabel(value: string): string {
  return OPTION_LABELS[value] ?? value;
}

function selectOptions(values: readonly string[], current: string): string {
  return values
    .map((value) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(optionLabel(value))}</option>`)
    .join("");
}

function serverUrlDisplay(endpoint: string | undefined, authEnabled: boolean): string {
  if (!endpoint) return "";
  const safeEndpoint = redactSensitiveText(endpoint);
  if (!authEnabled) return safeEndpoint;
  const glue = safeEndpoint.includes("?") ? "&" : "?";
  return `${safeEndpoint}${glue}codexpro_token=<redacted>`;
}

function currentTunnelMessage(tunnel: TunnelMode, endpoint: string): string {
  if (endpoint) {
    if (tunnel === "cloudflare") return "当前运行使用 Cloudflare 生成的地址；快速隧道地址会在重启后变化。";
    if (tunnel === "ngrok") return "当前运行正在使用已保存的 ngrok 公网主机名。";
    if (tunnel === "cloudflare-named") return "当前运行正在使用已保存的 Cloudflare 命名隧道主机名。";
    return "这是仅供能够访问本机的客户端使用的本地端点。";
  }
  if (tunnel === "cloudflare") return "Cloudflare 快速隧道启动后会在终端输出生成的公网地址。";
  if (tunnel === "ngrok") return "请输入预留的 ngrok 域名，或在启动 CodexPro 前设置 NGROK_DOMAIN。";
  if (tunnel === "cloudflare-named") return "请输入已路由到 Cloudflare 命名隧道的主机名。";
  return "尚未保存公网隧道；本地 MCP 客户端可使用本机地址。";
}

function profileForm(config: CodexProConfig): string {
  const profile = readWorkspaceProfile(config.defaultRoot);
  const values = profileValues(config, profile);
  const runtime = readRuntimeConnection(config.defaultRoot);
  const profilePath = profile.profilePath ?? profilePathForRoot(config.defaultRoot);
  const savedLabel = profile.profilePath ? "已保存" : "尚未保存";
  const runtimeEndpoint = typeof runtime.endpoint === "string" ? runtime.endpoint : "";
  const runtimeTunnel = oneOf(runtime.tunnel ?? values.tunnel, TUNNELS, values.tunnel);
  const runtimeUrl = serverUrlDisplay(runtimeEndpoint, Boolean(config.authToken));
  const savedEndpoint = values.hostname ? `https://${values.hostname}/mcp` : "";
  const savedUrl = serverUrlDisplay(savedEndpoint, Boolean(config.authToken));
  const ngrokHostname = process.env.NGROK_DOMAIN ?? (values.tunnel === "ngrok" ? values.hostname : "");
  const cloudflareHostname =
    process.env.CODEXPRO_PUBLIC_HOSTNAME ??
    process.env.CODEXPRO_HOSTNAME ??
    (values.tunnel === "cloudflare-named" ? values.hostname : "");
  const currentUrlBlock = runtimeUrl
    ? `<div class="current-url">
        <div>
          <span>当前服务器地址</span>
          <code>${escapeHtml(runtimeUrl)}</code>
          <p>${escapeHtml(currentTunnelMessage(runtimeTunnel, runtimeEndpoint))}</p>
        </div>
        <button type="button" class="copy-mini" data-copy-kind="server-url" data-copy-base="${escapeHtml(redactSensitiveText(runtimeEndpoint))}">复制</button>
      </div>`
    : `<div class="current-url idle">
        <div>
          <span>${savedUrl ? "已保存的服务器地址预览" : "当前服务器地址"}</span>
          <code>${savedUrl ? escapeHtml(savedUrl) : "本次运行未检测到公网地址"}</code>
          <p>${escapeHtml(savedUrl ? "此地址根据已保存的主机名生成；启动器启动相应隧道后才会生效。" : currentTunnelMessage(values.tunnel, ""))}</p>
        </div>
        ${savedEndpoint ? `<button type="button" class="copy-mini" data-copy-kind="server-url" data-copy-base="${escapeHtml(redactSensitiveText(savedEndpoint))}">复制</button>` : ""}
      </div>`;
  return `<section class="panel profile-panel" id="profile">
      <div class="section-head">
        <div>
          <h2>连接配置</h2>
          <p>这些设置将在下次启动时生效；启动器识别到当前隧道地址后会显示在此处。</p>
        </div>
        <span class="pill ${profile.profilePath ? "" : "warn"}">${escapeHtml(savedLabel)}</span>
      </div>
      <form class="profile-form" data-profile-form>
        ${currentUrlBlock}
        <fieldset class="profile-group">
          <legend>连接方式</legend>
          <p>选择 ChatGPT 访问本地 MCP 服务的方式。固定隧道使用已保存主机名，Cloudflare 快速隧道会在启动时生成地址。</p>
          <div class="form-grid">
            <label><span>隧道</span><select name="tunnel" data-tunnel-select data-ngrok-hostname="${escapeHtml(ngrokHostname)}" data-cloudflare-hostname="${escapeHtml(cloudflareHostname)}">${selectOptions(TUNNELS, values.tunnel)}</select></label>
            <label><span>公网主机名</span><input name="hostname" value="${escapeHtml(values.hostname)}" data-hostname-input data-autofilled="0"></label>
            <label><span>端口</span><input name="port" type="number" min="1" max="65535" value="${escapeHtml(values.port)}"></label>
            <label><span>模式</span><select name="mode">${selectOptions(MODES, values.mode)}</select></label>
            <label><span>Cloudflare 隧道名称</span><input name="tunnelName" value="${escapeHtml(values.tunnelName)}"></label>
            <label><span>ngrok 配置文件</span><input name="ngrokConfig" value="${escapeHtml(values.ngrokConfig)}"></label>
            <label><span>Cloudflare 配置文件</span><input name="cloudflareConfig" value="${escapeHtml(values.cloudflareConfig)}"></label>
            <label><span>Cloudflare 令牌文件</span><input name="cloudflareTokenFile" value="${escapeHtml(values.cloudflareTokenFile)}"></label>
          </div>
          <p class="field-help" data-hostname-help>${escapeHtml(currentTunnelMessage(values.tunnel, runtimeEndpoint))}</p>
          <label class="check-row"><input name="noInstallCloudflared" type="checkbox" value="true"${values.noInstallCloudflared ? " checked" : ""}><span>不自动安装 cloudflared</span></label>
        </fieldset>
        <fieldset class="profile-group">
          <legend>运行策略</legend>
          <p>保存下次启动的默认访问级别；这些设置不会修改当前正在运行的进程。</p>
          <div class="form-grid">
            <label><span>Bash 模式</span><select name="bash">${selectOptions(BASH_MODES, values.bash)}</select></label>
            <label><span>写入模式</span><select name="write">${selectOptions(WRITE_MODES, values.write)}</select></label>
            <label><span>工具模式</span><select name="toolMode">${selectOptions(TOOL_MODES, values.toolMode)}</select></label>
            <label><span>Codex 会话</span><select name="codexSessions">${selectOptions(CODEX_SESSIONS, values.codexSessions)}</select></label>
            <label><span>Codex 目录</span><input name="codexDir" value="${escapeHtml(values.codexDir)}"></label>
            <label><span>Bash 会话</span><input name="bashSession" value="${escapeHtml(values.bashSession)}"></label>
          </div>
          <label class="check-row"><input name="toolCards" type="checkbox" value="true"${values.toolCards ? " checked" : ""}><span>启用 ChatGPT 工具卡片</span></label>
          <label class="check-row"><input name="requireBashSession" type="checkbox" value="true"${values.requireBashSession ? " checked" : ""}><span>要求匹配 Bash 会话 ID</span></label>
        </fieldset>
        <fieldset class="profile-group readonly-group">
          <legend>本次运行只读信息</legend>
          <div class="readonly-grid">
            <div><span>Bash 输出模式</span><code>${escapeHtml(optionLabel(values.bashTranscript))}</code></div>
            <div><span>组件来源</span><code>${escapeHtml(values.widgetDomain)}</code></div>
          </div>
        </fieldset>
        <div class="actions">
          <button type="submit" class="primary">保存配置</button>
          <span class="mono">${escapeHtml(profilePath)}</span>
        </div>
        <p class="note" data-profile-status>令牌始终隐藏；重启 CodexPro 后，已保存的配置才会生效。</p>
      </form>
    </section>`;
}

function buildProfilePayload(config: CodexProConfig, existing: WorkspaceProfile, input: AdminProfilePatch): WorkspaceProfile {
  const current = profileValues(config, existing);
  const next: ProfileFormValues = {
    ...current,
    ...input,
    port: input.port ? String(input.port) : current.port,
    requireBashSession: input.requireBashSession ?? current.requireBashSession,
    noInstallCloudflared: input.noInstallCloudflared ?? current.noInstallCloudflared
  };
  next.hostname = normalizePublicHostname(next.hostname);
  if (next.tunnel !== "ngrok" && next.tunnel !== "cloudflare-named") next.hostname = "";
  next.widgetDomain = normalizeWidgetDomain(next.widgetDomain);
  if ((next.tunnel === "ngrok" || next.tunnel === "cloudflare-named") && !next.hostname) {
    throw new Error("hostname is required for ngrok and cloudflare-named profiles.");
  }
  if (next.requireBashSession && !next.bashSession) {
    throw new Error("requireBashSession requires a bashSession value.");
  }

  const token = typeof existing.token === "string" && existing.token ? existing.token : config.authToken ?? "";
  const cloudflareToken = next.tunnel === "cloudflare-named" && typeof existing.cloudflareToken === "string" && existing.cloudflareToken ? existing.cloudflareToken : "";
  const write = effectiveWriteMode(next.mode, next.write);
  const tunnelName = next.tunnel === "cloudflare-named" ? next.tunnelName : "";
  const ngrokConfig = next.tunnel === "ngrok" ? normalizeProfilePath(config.defaultRoot, next.ngrokConfig) : "";
  const cloudflareConfig = next.tunnel === "cloudflare-named" ? normalizeProfilePath(config.defaultRoot, next.cloudflareConfig) : "";
  const cloudflareTokenFile = next.tunnel === "cloudflare-named" ? normalizeProfilePath(config.defaultRoot, next.cloudflareTokenFile) : "";
  return {
    port: next.port,
    mode: next.mode,
    tunnel: next.tunnel,
    ...(next.hostname ? { hostname: next.hostname } : {}),
    ...(tunnelName ? { tunnelName } : {}),
    ...(ngrokConfig ? { ngrokConfig } : {}),
    ...(cloudflareConfig ? { cloudflareConfig } : {}),
    ...(cloudflareTokenFile ? { cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(cloudflareToken ? { cloudflareToken } : {}),
    bash: next.bash,
    ...(next.bashTranscript !== "compact" ? { bashTranscript: next.bashTranscript } : {}),
    ...(next.codexSessions !== "off" ? { codexSessions: next.codexSessions } : {}),
    ...(next.codexDir ? { codexDir: next.codexDir } : {}),
    ...(next.bashSession ? { bashSession: next.bashSession } : {}),
    ...(next.requireBashSession ? { requireBashSession: true } : {}),
    write,
    toolMode: next.toolMode,
    toolCards: next.toolCards,
    ...(next.widgetDomain ? { widgetDomain: next.widgetDomain } : {}),
    ...(next.noInstallCloudflared ? { noInstallCloudflared: true } : {})
  };
}


function profileResponse(config: CodexProConfig): Record<string, unknown> {
  const profile = readWorkspaceProfile(config.defaultRoot);
  const runtime = readRuntimeConnection(config.defaultRoot);
  return redactStructured({
    ok: true,
    profile_path: profile.profilePath ?? profilePathForRoot(config.defaultRoot),
    exists: Boolean(profile.profilePath),
    profile: sanitizeWorkspaceProfile(profile),
    effective: profileValues(config, profile),
    runtime_connection: runtime,
    runtime: {
      defaultRoot: config.defaultRoot,
      port: config.port,
      bashMode: config.bashMode,
      bashTranscript: config.bashTranscript,
      codexSessions: config.codexSessions,
      writeMode: config.writeMode,
      toolMode: config.toolMode,
      toolCards: config.toolCards,
      widgetDomain: config.widgetDomain,
      authEnabled: Boolean(config.authToken)
    }
  });
}

interface DashboardLink {
  title: string;
  path: string;
  href: string;
  kind: string;
  mtimeMs: number;
}

interface DashboardRun {
  runId: string;
  title: string;
  status: string;
  phase: string;
  currentStep: number;
  totalSteps: number | null;
  currentAction: string;
  executionState: string;
  heartbeatAt: string;
  waitReason?: string;
  lastEvidence?: string;
  retries: number;
  writerActive: boolean;
  browserActive: boolean;
  updatedAt: string;
  mtimeMs: number;
}

interface DashboardSummary {
  projectName: string;
  projectKind: string;
  branch: string;
  gitStatus: string[];
  isProjectContainer: boolean;
  managedProjects: string[];
  startCommands: string[];
  acceptanceCommands: string[];
  dockerStatus: string;
  recentRuns: DashboardRun[];
  recentTasks: DashboardLink[];
  recentAcceptanceReports: DashboardLink[];
  recentBrowserReports: DashboardLink[];
  recentScreenshots: DashboardLink[];
  recentReleaseReports: DashboardLink[];
  projectMap?: DashboardLink;
  memoryLinks: DashboardLink[];
}

const ARTIFACT_ROOTS = [
  ".ai-bridge/acceptance-reports",
  ".ai-bridge/browser-reports",
  ".ai-bridge/release-reports",
  ".ai-bridge/task-snapshots",
  ".ai-bridge/console-actions",
  ".codexpro/memory",
  ".codexpro/project-map.md"
];
const ARTIFACT_EXTENSIONS = new Set([".md", ".json", ".txt", ".png", ".jpg", ".jpeg", ".webp", ".html"]);

function toPosixRel(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function artifactHref(relPath: string): string {
  return `/admin/artifact?path=${encodeURIComponent(toPosixRel(relPath))}`;
}

function titleFromPath(relPath: string): string {
  const clean = toPosixRel(relPath);
  const parts = clean.split("/");
  if (parts.length >= 3) return `${parts.at(-2)} / ${parts.at(-1)}`;
  return parts.at(-1) ?? clean;
}

function linkFor(root: string, relPath: string, kind: string): DashboardLink | undefined {
  const abs = path.join(root, relPath);
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return undefined;
    return { title: titleFromPath(relPath), path: toPosixRel(relPath), href: artifactHref(relPath), kind, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

function isAllowedArtifactPath(relPath: string): boolean {
  const clean = toPosixRel(relPath);
  if (clean.includes("..") || clean.startsWith("/") || path.isAbsolute(clean)) return false;
  const ext = path.extname(clean).toLowerCase();
  if (!ARTIFACT_EXTENSIONS.has(ext)) return false;
  return ARTIFACT_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`));
}

function collectRecentLinks(root: string, baseRel: string, kind: string, names: RegExp, limit = 5): DashboardLink[] {
  const base = path.join(root, baseRel);
  const out: DashboardLink[] = [];
  function visit(absDir: string, depth: number): void {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rel = toPosixRel(path.relative(root, abs));
      if (entry.isDirectory()) {
        visit(abs, depth + 1);
      } else if (entry.isFile() && names.test(entry.name)) {
        const link = linkFor(root, rel, kind);
        if (link) out.push(link);
      }
    }
  }
  visit(base, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function dashboardRunText(value: unknown, max = 500): string {
  return typeof value === "string" ? value.replace(/[\u0000\r\n]+/g, " ").trim().slice(0, max) : "";
}

function collectRecentRuns(root: string, limit = 8): DashboardRun[] {
  const runsRoot = path.join(root, ".codexpro", "runs");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: DashboardRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobPath = path.join(runsRoot, entry.name, "job.json");
    try {
      const stat = fs.statSync(jobPath);
      const parsed = JSON.parse(fs.readFileSync(jobPath, "utf8")) as Record<string, unknown>;
      const progress = parsed.progress && typeof parsed.progress === "object" && !Array.isArray(parsed.progress)
        ? parsed.progress as Record<string, unknown>
        : {};
      const totalSteps = typeof progress.total_steps === "number" && Number.isFinite(progress.total_steps)
        ? Math.max(0, Math.floor(progress.total_steps))
        : null;
      runs.push({
        runId: dashboardRunText(parsed.run_id, 100) || entry.name,
        title: dashboardRunText(parsed.title, 160) || entry.name,
        status: dashboardRunText(parsed.status, 40) || "unknown",
        phase: dashboardRunText(progress.phase, 80) || "unknown",
        currentStep: typeof progress.current_step === "number" && Number.isFinite(progress.current_step)
          ? Math.max(0, Math.floor(progress.current_step))
          : 0,
        totalSteps,
        currentAction: dashboardRunText(progress.current_action, 240) || "暂无当前操作",
        executionState: dashboardRunText(progress.execution_state, 40) || "unknown",
        heartbeatAt: dashboardRunText(progress.heartbeat_at, 80) || "unknown",
        ...(dashboardRunText(progress.wait_reason, 500) ? { waitReason: dashboardRunText(progress.wait_reason, 500) } : {}),
        ...(dashboardRunText(progress.last_evidence, 500) ? { lastEvidence: dashboardRunText(progress.last_evidence, 500) } : {}),
        retries: typeof progress.retries === "number" && Number.isFinite(progress.retries) ? Math.max(0, Math.floor(progress.retries)) : 0,
        writerActive: progress.writer_active === true,
        browserActive: progress.browser_active === true,
        updatedAt: dashboardRunText(parsed.updated_at, 80) || new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs
      });
    } catch {
      // A corrupt or partial run must not hide healthy dashboard entries.
    }
  }
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function runReadOnlyCommand(root: string, command: string, args: string[], timeoutMs = 1800): string {
  try {
    const result = runProcessSync(command, args, {
      cwd: root,
      timeoutMs,
      maxOutputBytes: 128_000,
      domain: "probe",
      operation: command,
      usageTracking: false,
      sideEffectLevel: "local_read",
      recordRoot: HTTP_PROCESS_RECORD_ROOT,
      contextDir: "execution",
      riskLevel: "low"
    });
    const text = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
    if (result.spawnError) return result.stderr || result.errorClass || "spawn failed";
    return text || (typeof result.exitCode === "number" ? `exit ${result.exitCode}` : "no output");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function readPackageJson(root: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function packageScripts(pkg: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  const out: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command === "string") out[name] = command;
  }
  return out;
}

function dashboardCommands(scripts: Record<string, string>, names: string[]): string[] {
  return names
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => `npm run ${name}`);
}

function detectDashboardProjectKind(root: string, pkg: Record<string, unknown> | undefined): string {
  const frameworks: string[] = [];
  const deps = { ...(pkg?.dependencies as Record<string, unknown> | undefined), ...(pkg?.devDependencies as Record<string, unknown> | undefined) };
  for (const name of ["next", "vite", "react", "vue", "express", "typescript", "playwright"]) {
    if (deps && Object.prototype.hasOwnProperty.call(deps, name)) frameworks.push(name);
  }
  const signals = [
    fs.existsSync(path.join(root, "package.json")) ? "node" : "",
    fs.existsSync(path.join(root, "tsconfig.json")) ? "typescript" : "",
    fs.existsSync(path.join(root, "Dockerfile")) || fs.existsSync(path.join(root, "docker-compose.yml")) ? "docker" : ""
  ].filter(Boolean);
  return [...new Set([...signals, ...frameworks])].join(" / ") || "unknown";
}

function dockerDashboardStatus(root: string): string {
  const hasDockerFile = ["Dockerfile", "docker-compose.yml", "compose.yml", "docker-compose.yaml", "compose.yaml"].some((name) => fs.existsSync(path.join(root, name)));
  if (!hasDockerFile) return "未检测到 Docker 配置";
  const output = runReadOnlyCommand(root, "docker", ["ps", "--format", "{{.Names}} — {{.Status}}"], 1600);
  if (/ENOENT|not found/i.test(output)) return "Docker CLI 不可用";
  return output.split(/\r?\n/g).filter(Boolean).slice(0, 8).join("; ") || "已检测到 Docker，暂无运行中的容器";
}

function buildDashboardSummary(config: CodexProConfig): DashboardSummary {
  const root = config.defaultRoot;
  const discoveredProjects = discoverDashboardProjects(config).filter((project) => project.available);
  const defaultRootIsProject = discoveredProjects.some((project) => path.resolve(project.root) === path.resolve(root));
  const isProjectContainer = !defaultRootIsProject && discoveredProjects.length > 0;
  const managedProjects = discoveredProjects.map((project) => project.name);
  const pkg = isProjectContainer ? undefined : readPackageJson(root);
  const scripts = packageScripts(pkg);
  const projectName = isProjectContainer
    ? "多项目控制中心"
    : typeof pkg?.name === "string" && pkg.name.trim()
      ? pkg.name.trim()
      : path.basename(root);
  const branch = isProjectContainer
    ? "not_applicable"
    : runReadOnlyCommand(root, "git", ["branch", "--show-current"], 1200).split(/\r?\n/g)[0] || "unknown";
  const gitStatus = isProjectContainer
    ? ["not_applicable"]
    : (() => {
        const gitStatusText = runReadOnlyCommand(root, "git", ["status", "--short"], 1200);
        return gitStatusText === "no output" ? ["clean"] : gitStatusText.split(/\r?\n/g).filter(Boolean).slice(0, 40);
      })();
  const projectMap = linkFor(root, ".codexpro/project-map.md", "project-map");
  const memoryLinks = collectRecentLinks(root, ".codexpro/memory", "memory", /\.(?:md|txt)$/i, 8);
  return {
    projectName,
    projectKind: isProjectContainer ? "multi_project_container" : detectDashboardProjectKind(root, pkg),
    branch,
    gitStatus,
    isProjectContainer,
    managedProjects,
    startCommands: dashboardCommands(scripts, ["start", "start:http", "dev:http", "connect", "connect:stable"]),
    acceptanceCommands: dashboardCommands(scripts, ["release-gate", "smoke", "browser-smoke", "pack-smoke", "fresh-install-smoke", "release-safety-check"]),
    dockerStatus: isProjectContainer ? "按项目查看" : dockerDashboardStatus(root),
    recentRuns: collectRecentRuns(root, 8),
    recentTasks: collectRecentLinks(root, ".ai-bridge/task-snapshots", "task", /(?:summary|report|memory-candidate)\.md$/i, 5),
    recentAcceptanceReports: collectRecentLinks(root, ".ai-bridge/acceptance-reports", "acceptance", /report\.(?:md|json)$/i, 5),
    recentBrowserReports: collectRecentLinks(root, ".ai-bridge/browser-reports", "browser-report", /report\.(?:md|json|html)$/i, 5),
    recentScreenshots: collectRecentLinks(root, ".ai-bridge/browser-reports", "screenshot", /\.(?:png|jpg|jpeg|webp)$/i, 8),
    recentReleaseReports: collectRecentLinks(root, ".ai-bridge/release-reports", "release", /release-report\.(?:md|json)$/i, 5),
    ...(projectMap ? { projectMap } : {}),
    memoryLinks
  };
}

function compactList(items: string[], empty = "暂无"): string {
  return items.length ? items.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("") : `<li><span>${escapeHtml(empty)}</span></li>`;
}

function linkList(links: DashboardLink[], empty = "暂无"): string {
  return links.length
    ? links.map((link) => `<li><a class="resource-link" href="${escapeHtml(link.href)}" target="_blank" rel="noreferrer">${escapeHtml(link.title)}</a><span class="mono small-path">${escapeHtml(link.path)}</span></li>`).join("")
    : `<li><span>${escapeHtml(empty)}</span></li>`;
}

function durableRunList(runs: DashboardRun[], empty = "暂无持久任务记录"): string {
  if (!runs.length) return `<li><span>${escapeHtml(empty)}</span></li>`;
  return runs.map((run) => {
    const total = run.totalSteps && run.totalSteps > 0 ? run.totalSteps : Math.max(1, run.currentStep);
    const value = Math.min(total, Math.max(0, run.currentStep));
    const tone = ["failed", "blocked", "stale", "recovery_required"].includes(run.status)
      ? "warn"
      : run.status === "completed"
        ? "good"
        : "";
    return `<li class="durable-run">
      <div class="durable-run-head"><strong>${escapeHtml(run.title)}</strong><span class="pill ${tone}" title="${escapeHtml(run.status)}">${escapeHtml(consoleEnumLabel(run.status))}</span></div>
      <div class="durable-run-meta"><code>${escapeHtml(run.runId)}</code><span>${escapeHtml(consoleEnumLabel(run.phase))} · ${value}/${run.totalSteps ?? "?"}</span><span title="${escapeHtml(run.executionState)}">${escapeHtml(consoleEnumLabel(run.executionState))}</span></div>
      <progress value="${value}" max="${total}" aria-label="${escapeHtml(`${run.title} 的任务进度`)}"></progress>
      <p>${escapeHtml(run.currentAction)}</p>
      <div class="durable-run-meta"><span>心跳 ${escapeHtml(formatConsoleDateTime(run.heartbeatAt))}</span><span>重试 ${run.retries}</span><span>写入 ${run.writerActive ? "活跃" : "空闲"}</span><span>浏览器 ${run.browserActive ? "活跃" : "空闲"}</span></div>
      ${run.waitReason ? `<p class="run-wait">等待原因：${escapeHtml(run.waitReason)}</p>` : ""}
      ${run.lastEvidence ? `<code class="small-path">证据：${escapeHtml(run.lastEvidence)}</code>` : ""}
    </li>`;
  }).join("");
}

async function unifiedTaskDashboard(
  config: CodexProConfig,
  query: Record<string, unknown>,
  attentionService: AttentionService
) {
  const projectionSnapshotProvider = new ProjectionSnapshotProvider(config);
  const dashboard = await new ProjectAggregationService(config).dashboard(query, { projectionSnapshotProvider });
  const attention = await attentionService.getAttention({
    project: query.project,
    cursor: query.attention_cursor,
    limit: query.attention_limit ?? 100
  }, { projectionSnapshotProvider });
  return {
    ...dashboard,
    attention,
    request_projection_observability: projectionSnapshotProvider.observability()
  };
}

async function officeDashboard(config: CodexProConfig, officeSnapshotService: OfficeSnapshotService, query: Record<string, unknown>) {
  const parsed = OfficeQuery.safeParse(query);
  if (!parsed.success) {
    const error = new Error("办公室筛选参数无效。") as Error & { issues?: unknown };
    error.issues = parsed.error.flatten();
    throw error;
  }
  const projection = await officeSnapshotService.read({
    project: parsed.data.project,
    include_archived: parsed.data.include_archived,
    include_test_history: parsed.data.include_test_history,
    archive_limit: parsed.data.archive_limit,
    active_limit_per_project: parsed.data.active_limit_per_project
  });
  const sceneFeature = officeSceneFeatureFlag();
  const projected = sceneFeature.enabled || sceneFeature.projects.length > 0
    ? { ...projection, visual_snapshot: projectOfficeVisualSnapshot(projection) }
    : projection;
  return { ...projected, capability_registry: officeCapabilityRegistry(config) };
}

function dashboardPanel(config: CodexProConfig, serverUrl: string): string {
  const dashboard = buildDashboardSummary(config);
  const latestBrowserReport = dashboard.recentBrowserReports[0];
  const gitTone = dashboard.gitStatus.length === 1 && dashboard.gitStatus[0] === "clean" ? "" : "warn";
  const projectMetrics = dashboard.isProjectContainer
    ? `<div class="metric"><span>管理范围</span><strong>${escapeHtml(dashboard.projectName)}</strong><code>${escapeHtml(config.defaultRoot)}</code></div>
       <div class="metric"><span>已发现项目</span><strong>${dashboard.managedProjects.length} 个</strong><code>${escapeHtml(dashboard.managedProjects.join("、") || "暂无")}</code></div>
       <div class="metric"><span>工作区类型</span><strong>${escapeHtml(consoleEnumLabel(dashboard.projectKind))}</strong><code>聚合根目录不执行仓库级 Git 检测</code></div>`
    : `<div class="metric"><span>当前项目</span><strong>${escapeHtml(dashboard.projectName)}</strong><code>${escapeHtml(config.defaultRoot)}</code></div>
       <div class="metric"><span>当前分支</span><strong>${escapeHtml(dashboard.branch)}</strong><code>git branch --show-current</code></div>
       <div class="metric"><span>项目类型</span><strong>${escapeHtml(dashboard.projectKind)}</strong><code>仅依据本地信号</code></div>`;
  const repositoryMetrics = dashboard.isProjectContainer
    ? `<div class="metric"><span>项目级状态</span><strong>见下方项目卡片</strong><code>分支、Git 和 Watcher 均按项目展示</code></div>`
    : `<div class="metric"><span>Docker 状态</span><strong>${escapeHtml(dashboard.dockerStatus)}</strong><code>只读 docker ps</code></div>
       <div class="metric"><span>Git 状态</span><strong class="pill ${gitTone}" title="${escapeHtml(dashboard.gitStatus[0] ?? "unknown")}">${escapeHtml(consoleEnumLabel(dashboard.gitStatus[0] ?? "unknown"))}</strong><code>${escapeHtml(dashboard.gitStatus.slice(1, 6).join("; ") || "工作区状态")}</code></div>`;
  const consoleActions = dashboard.isProjectContainer
    ? `<span class="pill">项目级安全操作需先选择具体项目</span>
       ${latestBrowserReport ? `<a class="resource-link" href="${escapeHtml(latestBrowserReport.href)}" target="_blank" rel="noreferrer">打开最新浏览器报告</a>` : ""}`
    : `<button type="button" class="primary" data-console-action="quick_acceptance">运行快速验收</button>
       <button type="button" class="copy-mini secondary" data-console-action="docker_status">检查 Docker 状态</button>
       <button type="button" class="copy-mini secondary" data-console-action="generate_project_map">生成项目地图</button>
       <button type="button" class="copy-mini secondary" data-console-action="copy_git_add">复制 git add 命令</button>
       ${latestBrowserReport ? `<a class="resource-link" href="${escapeHtml(latestBrowserReport.href)}" target="_blank" rel="noreferrer">打开最新浏览器报告</a>` : `<span class="pill warn">暂无浏览器报告</span>`}`;
  return `<section class="panel dashboard-panel" id="dashboard">
    <div class="section-head">
      <div>
        <h2>本地任务控制台</h2>
        <p>查看项目状态并执行经过白名单限制的安全操作；浏览器界面不提供破坏性操作。</p>
      </div>
      <span class="pill">安全操作</span>
    </div>
    <div class="dashboard-grid">
      ${projectMetrics}
      <div class="metric"><span>ChatGPT MCP 服务器地址</span><strong>${escapeHtml(serverUrl || "未检测到")}</strong><code>/mcp</code></div>
      ${repositoryMetrics}
    </div>
    <div class="console-actions" data-console-actions>
      <a class="primary resource-link" href="/office" data-office-link>打开办公室视图</a>
      ${consoleActions}
    </div>
    <pre class="console-output" data-console-output>${dashboard.isProjectContainer ? "当前为多项目聚合根目录；项目级验收、Docker、Git 和项目地图操作不会在父目录执行。" : "控制台操作只会在 .ai-bridge/console-actions/ 下写入报告，不会执行删除、数据库写入、推送或生产环境写入。"}</pre>
    <section class="structured-task-panel" data-structured-task-panel>
      <div class="unified-task-head">
        <div>
          <h3>直接结构化任务入口</h3>
          <p class="unified-task-summary">从既有计划启动阶段，或提交范围固定的结构化任务；创建后进入现有 Goal Manager 和统一任务中心。</p>
        </div>
        <span class="pill">Goal Contract v1</span>
      </div>
      <form class="structured-task-form" data-structured-task-form>
        <div class="structured-task-grid">
          <label><span>入口模式</span><select name="mode" data-structured-mode>
            <option value="existing_plan">执行既有计划</option>
            <option value="fixed_task">结构化固定任务</option>
          </select></label>
          <label><span>项目</span><input name="project" list="structured-task-projects" value="${escapeHtml(path.basename(config.defaultRoot) || dashboard.projectName)}" autocomplete="off"></label>
          <datalist id="structured-task-projects" data-structured-project-options></datalist>
          <label><span>优先级</span><select name="priority">
            <option value="normal">普通</option>
            <option value="urgent">紧急</option>
            <option value="background">后台</option>
          </select></label>
          <div class="structured-mode-plan">
            <label><span>计划文件</span><input name="plan_file" value="planning-local/" autocomplete="off"></label>
            <label><span>Stage</span><input name="stage" placeholder="例如 CC5"></label>
            <label data-structured-wide><span>范围限制</span><textarea name="scope_limit" placeholder="每行一个路径或范围，可留空"></textarea></label>
          </div>
          <div class="structured-mode-fixed" hidden>
            <label data-structured-wide><span>目标</span><textarea name="objective" placeholder="明确、低歧义、范围固定的任务目标"></textarea></label>
            <label data-structured-wide><span>包含范围</span><textarea name="include" placeholder="每行一个允许路径或范围"></textarea></label>
            <label data-structured-wide><span>排除范围</span><textarea name="exclude" placeholder="每行一个排除路径或范围"></textarea></label>
            <label data-structured-wide><span>验收项</span><textarea name="acceptance" placeholder="每行一个验收项"></textarea></label>
            <label><span>执行档位</span><select name="execution_profile">
              <option value="standard">标准</option>
              <option value="read_only">只读</option>
              <option value="lightweight">轻量</option>
              <option value="heavy">高负载</option>
              <option value="fast">快速</option>
              <option value="deep">深度</option>
            </select></label>
            <label><span>声明风险</span><select name="risk_level">
              <option value="">未声明</option>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="critical">关键</option>
            </select></label>
          </div>
          <div class="structured-checks">
            <label><input type="checkbox" name="browser_verification"><span>浏览器验证</span></label>
            <label><input type="checkbox" name="local_record_permission"><span>允许本地记录</span></label>
            <label><input type="checkbox" name="remote_sync_permission"><span>允许远端同步</span></label>
            <label><input type="checkbox" name="new_run"><span>明确新 run</span></label>
          </div>
          <label data-structured-wide><span>幂等键</span><input name="idempotency_key" placeholder="new_run=true 时必填；8-200 位字母、数字、点、下划线、冒号或短横线" autocomplete="off"></label>
          <div class="structured-task-actions">
            <button type="submit" class="primary" data-structured-submit>创建结构化任务</button>
            <button type="button" class="copy-mini secondary" data-structured-reset>清空反馈</button>
          </div>
        </div>
      </form>
      <pre class="structured-task-output" data-structured-task-output>尚未创建结构化任务。</pre>
    </section>
    <div class="dashboard-columns">
      <section class="unified-tasks-section">
        <div class="unified-task-head">
          <div>
            <h3>目标控制中心</h3>
            <p class="unified-task-summary">默认只显示当前目标、真正需要你的动作和最近交付；运行指标与历史 Attempt 按需展开。</p>
          </div>
        </div>
        <p class="unified-task-summary" data-task-summary>正在从统一投影加载 Goal、持久任务和 Handoff 状态……</p>
        <section class="objective-focus" data-current-objective hidden>
          <div class="objective-focus-head">
            <div>
              <p>当前目标</p>
              <h4 data-objective-title>尚无当前目标</h4>
              <p class="objective-focus-reason" data-objective-reason></p>
            </div>
            <span class="pill" data-objective-status>未开始</span>
          </div>
          <div class="objective-focus-grid">
            <div class="objective-focus-item"><span>Stage</span><strong data-objective-stage>未指定</strong></div>
            <div class="objective-focus-item"><span>当前 Attempt</span><code data-objective-attempt>无</code></div>
            <div class="objective-focus-item"><span>是否需要我处理</span><strong data-objective-human>否</strong></div>
            <div class="objective-focus-item"><span>系统下一步</span><strong data-objective-next>无</strong></div>
          </div>
        </section>
        <div class="attention-center" data-attention-center>
          <div class="attention-head">
            <div>
              <h4>需要我处理</h4>
              <p data-attention-summary>正在核对真正需要用户行动的批准、授权和决策……</p>
            </div>
            <div class="attention-actions">
              <button type="button" class="copy-mini secondary" data-attention-notifications-enable>启用浏览器通知</button>
              <button type="button" class="copy-mini secondary" data-attention-refresh>刷新待处理事项</button>
            </div>
          </div>
          <div class="attention-groups" data-attention-groups></div>
          <ul class="attention-list" data-attention-list><li><span>正在加载需要用户处理的事项……</span></li></ul>
        </div>
        <section class="recent-deliveries" data-recent-deliveries>
          <div class="attention-head">
            <div>
              <h4>最近交付</h4>
              <p data-recent-delivery-summary>正在加载最近完成并保留证据的任务……</p>
            </div>
          </div>
          <ul class="recent-delivery-list" data-recent-delivery-list><li><span>正在加载最近交付……</span></li></ul>
        </section>
        <details class="diagnostic-workbench" data-diagnostic-workbench>
          <summary>诊断与历史 <span data-diagnostic-summary>按需展开运行指标、项目状态和 Attempt 历史</span></summary>
          <div class="diagnostic-content">
            <div class="task-toolbar">
              <select aria-label="项目筛选" data-task-project><option value="">全部项目</option></select>
              <select aria-label="状态筛选" data-task-status>
                <option value="">全部状态</option>
                <option value="running,validating">运行中</option>
                <option value="queued">排队中</option>
                <option value="waiting,interrupted,implemented_not_verified">需要处理</option>
                <option value="recovering,interrupted,recovery_required,stale">恢复相关</option>
                <option value="failed">失败</option>
                <option value="completed">已完成</option>
              </select>
              <select aria-label="每页数量" data-task-page-size>
                <option value="10">每页 10 条</option>
                <option value="25" selected>每页 25 条</option>
                <option value="50">每页 50 条</option>
              </select>
              <button type="button" class="copy-mini secondary" data-task-prev>上一页</button>
              <span class="mono task-page" data-task-page>1/1</span>
              <button type="button" class="copy-mini secondary" data-task-next>下一页</button>
              <button type="button" class="copy-mini secondary" data-task-refresh>刷新</button>
            </div>
            <div class="task-overview-grid" data-task-overview></div>
            <div class="project-status-grid" data-project-status></div>
            <ul class="durable-run-list unified-task-list" data-unified-task-list><li><span>正在加载任务……</span></li></ul>
          </div>
        </details>
        <dialog class="task-detail-dialog" data-task-dialog>
          <div class="task-detail-head"><strong data-task-dialog-title>任务详情</strong><button type="button" class="copy-mini secondary" data-task-dialog-close>关闭</button></div>
          <pre class="task-detail-output" data-task-dialog-output></pre>
        </dialog>
      </section>
      <details class="diagnostic-workbench dashboard-artifact-workbench">
        <summary>运行入口与诊断产物 <span>启动命令、验收命令、持久任务、报告、截图和项目记忆</span></summary>
        <div class="dashboard-columns diagnostic-artifact-grid">
          <section><h3>启动命令</h3><ul class="compact-list">${compactList(dashboard.startCommands)}</ul></section>
          <section><h3>验收命令</h3><ul class="compact-list">${compactList(dashboard.acceptanceCommands)}</ul></section>
          <section class="durable-runs-section"><h3>持久任务进度</h3><ul class="durable-run-list">${durableRunList(dashboard.recentRuns)}</ul></section>
          <section><h3>最近任务</h3><ul class="link-list">${linkList(dashboard.recentTasks)}</ul></section>
          <section><h3>验收报告</h3><ul class="link-list">${linkList(dashboard.recentAcceptanceReports)}</ul></section>
          <section><h3>浏览器报告</h3><ul class="link-list">${linkList(dashboard.recentBrowserReports)}</ul></section>
          <section><h3>最近截图</h3><ul class="link-list">${linkList(dashboard.recentScreenshots)}</ul></section>
          <section><h3>发布报告</h3><ul class="link-list">${linkList(dashboard.recentReleaseReports)}</ul></section>
          <section><h3>项目地图</h3><ul class="link-list">${linkList(dashboard.projectMap ? [dashboard.projectMap] : [])}</ul></section>
          <section><h3>项目记忆</h3><ul class="link-list">${linkList(dashboard.memoryLinks)}</ul></section>
        </div>
      </details>
    </div>
  </section>`;
}

function serveAdminArtifact(config: CodexProConfig, req: Request, res: Response): void {
  const raw = typeof req.query.path === "string" ? req.query.path : "";
  const relPath = toPosixRel(raw);
  const rawProject = typeof req.query.project === "string" ? req.query.project : null;
  const project = resolveDashboardArtifactRoot(config, rawProject);
  if (!project) {
    jsonError(res, 404, "project_not_found", "Artifact project is not available.");
    return;
  }
  if (!isAllowedArtifactPath(relPath) || !isAllowedDashboardArtifactPath(relPath)) {
    jsonError(res, 400, "invalid_artifact", "Artifact path is not allowed.");
    return;
  }
  const root = path.resolve(project.root);
  const abs = path.resolve(root, relPath);
  if (!isSubpath(abs, root)) {
    jsonError(res, 400, "invalid_artifact", "Artifact path escapes the workspace.");
    return;
  }
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      jsonError(res, 404, "artifact_not_found", "Artifact not found.");
      return;
    }
    const maxBytes = config.maxReadBytes;
    if (stat.size > maxBytes) {
      jsonError(res, 413, "artifact_too_large", `Artifact exceeds the ${maxBytes} byte read limit.`);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.type(path.extname(abs).slice(1) || "text");
    res.send(fs.readFileSync(abs));
  } catch {
    jsonError(res, 404, "artifact_not_found", "Artifact not found.");
  }
}

const CONSOLE_ACTIONS = new Set(["quick_acceptance", "docker_status", "generate_project_map", "copy_git_add"]);

function safeActionSlug(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64) || "action";
}

function actionStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function truncateConsoleText(value: string, max = 24_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[output truncated at ${max} characters]`;
}

function writeConsoleActionReport(root: string, action: string, title: string, status: string, body: string): DashboardLink {
  const relDir = toPosixRel(path.join(".ai-bridge", "console-actions", `${actionStamp()}-${safeActionSlug(action)}`));
  const absDir = path.join(root, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const relPath = toPosixRel(path.join(relDir, "report.md"));
  const content = [
    `# ${title}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Status: ${status}`,
    `Workspace: ${root}`,
    "",
    body.trim() || "无输出。"
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(root, relPath), content, "utf8");
  const link = linkFor(root, relPath, "console-action");
  if (!link) throw new Error(`Console action report was not written: ${relPath}`);
  return link;
}

function runConsoleCommand(root: string, command: string, args: string[], timeoutMs = 120_000): { status: "passed" | "failed"; code: number | null; output: string } {
  try {
    const result = runProcessSync(command, args, {
      cwd: root,
      timeoutMs,
      maxOutputBytes: 512_000,
      env: { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: process.env.NO_COLOR ?? "1" },
      domain: "shell",
      operation: command,
      sideEffectLevel: "local_read",
      recordRoot: HTTP_PROCESS_RECORD_ROOT,
      contextDir: "execution",
      riskLevel: "medium"
    });
    const output = truncateConsoleText(`${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim());
    if (result.spawnError) return { status: "failed", code: null, output: result.stderr || result.errorClass || "spawn failed" };
    return { status: result.exitCode === 0 ? "passed" : "failed", code: result.exitCode, output };
  } catch (error) {
    return { status: "failed", code: null, output: error instanceof Error ? error.message : String(error) };
  }
}

function shellQuoteForCopy(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function gitAddCopyCommand(root: string): string {
  const output = runReadOnlyCommand(root, "git", ["status", "--porcelain", "--untracked-files=all"], 1600);
  if (/not a git repository/i.test(output)) return "未检测到 Git 仓库。";
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/g)) {
    if (!line.trim()) continue;
    const rawPath = line.slice(3).trim();
    const finalPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)?.trim() ?? rawPath : rawPath;
    const clean = finalPath.replace(/^"|"$/g, "");
    if (clean && !clean.startsWith(".git/")) paths.push(clean);
  }
  if (!paths.length) return "没有需要暂存的本地改动。";
  return `git add ${paths.map(shellQuoteForCopy).join(" ")}`;
}

function writeProjectMapFromDashboard(config: CodexProConfig): DashboardLink {
  const dashboard = buildDashboardSummary(config);
  const relPath = ".codexpro/project-map.md";
  fs.mkdirSync(path.join(config.defaultRoot, ".codexpro"), { recursive: true });
  const content = [
    "# CodexPro Project Map",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Workspace: ${config.defaultRoot}`,
    "",
    "## Project identity",
    "",
    `- Name: ${dashboard.projectName}`,
    `- Kind: ${dashboard.projectKind}`,
    `- Branch: ${dashboard.branch}`,
    "",
    "## Runtime commands",
    "",
    "### Start commands",
    dashboard.startCommands.length ? dashboard.startCommands.map((item) => `- \`${item}\``).join("\n") : "- none",
    "",
    "### Acceptance commands",
    dashboard.acceptanceCommands.length ? dashboard.acceptanceCommands.map((item) => `- \`${item}\``).join("\n") : "- none",
    "",
    "## Current status",
    "",
    `- Git status: ${dashboard.gitStatus.join("; ")}`,
    `- Docker status: ${dashboard.dockerStatus}`,
    "- Generated by the Local Web Console operation surface.",
    "- Credential and environment file values are not included."
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(config.defaultRoot, relPath), content, "utf8");
  const link = linkFor(config.defaultRoot, relPath, "project-map");
  if (!link) throw new Error("project map was not written");
  return link;
}

function consoleActionResponse(config: CodexProConfig, action: string): Record<string, unknown> {
  const root = config.defaultRoot;
  if (action === "quick_acceptance") {
    const scripts = packageScripts(readPackageJson(root));
    if (!scripts.smoke) {
      const link = writeConsoleActionReport(root, action, "快速验收", "skipped", "package.json 中未找到 `smoke` 脚本。");
      return { ok: true, action, status: "skipped", message: "未找到 smoke 脚本。", report: link };
    }
    const result = runConsoleCommand(root, "npm", ["run", "smoke"], 120_000);
    const link = writeConsoleActionReport(root, action, "快速验收", result.status, [
      "```text",
      result.output,
      "```"
    ].join("\n"));
    return { ok: result.status === "passed", action, status: result.status, exit_code: result.code, report: link, output: result.output };
  }
  if (action === "docker_status") {
    const text = dockerDashboardStatus(root);
    const link = writeConsoleActionReport(root, action, "Docker 状态", "passed", text);
    return { ok: true, action, status: "passed", message: text, report: link };
  }
  if (action === "generate_project_map") {
    const link = writeProjectMapFromDashboard(config);
    return { ok: true, action, status: "passed", message: "项目地图已生成。", report: link };
  }
  if (action === "copy_git_add") {
    return { ok: true, action, status: "passed", copy_text: gitAddCopyCommand(root) };
  }
  return { ok: false, action, status: "failed", message: "Unsupported console action." };
}

function handleConsoleAction(config: CodexProConfig, req: Request, res: Response): void {
  const action = typeof req.body?.action === "string" ? req.body.action : "";
  if (!CONSOLE_ACTIONS.has(action)) {
    jsonError(res, 400, "invalid_console_action", "Unsupported console action.");
    return;
  }
  try {
    res.json(consoleActionResponse(config, action));
  } catch (error) {
    jsonError(res, 500, "console_action_failed", error instanceof Error ? error.message : String(error));
  }
}

function jsonError(res: Response, status: number, code: string, message: string, issues?: unknown): void {
  res.status(status).json({
    ok: false,
    error: { code, message, ...(issues ? { issues } : {}) }
  });
}

const LOCAL_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#2563eb"/>
  <rect x="8" y="8" width="48" height="48" rx="12" fill="#ffffff" fill-opacity=".12" stroke="#ffffff" stroke-opacity=".38"/>
  <path d="M38.4 40.3c-1.8 1.1-3.9 1.7-6.3 1.7-6.1 0-10.3-4.2-10.3-10s4.2-10 10.4-10c2.4 0 4.5.6 6.2 1.7l-2.1 4.1c-1.1-.7-2.3-1-3.8-1-2.9 0-4.9 2.1-4.9 5.2s2 5.2 4.9 5.2c1.5 0 2.8-.4 3.9-1.1l2 4.2Z" fill="#ffffff"/>
</svg>`;
const CODEXPRO_VERSION = "0.28.6";

function printHelp(): void {
  console.log(`CodexPro MCP HTTP server

Usage:
  codexpro-mcp-http --root /path/to/repo --port 8787
  codexpro-mcp-http --version
  codexpro-mcp-http --help

Set CODEXPRO_HTTP_TOKEN for public/tunnel use.
For trusted local-only testing, set CODEXPRO_ALLOW_NO_HTTP_TOKEN=1.
Most users should run: codexpro start`);
}

function renderOnboardingPage(config: CodexProConfig, csrfToken = ""): string {
  return onboardingPage(config, {
    escapeHtml,
    shellQuote,
    copyCommand,
    readRuntimeConnection,
    profileValues,
    serverUrlDisplay,
    profileForm,
    dashboardPanel,
    csrfToken
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(CODEXPRO_VERSION);
    return;
  }
  if (argv.includes("--help") || argv[0] === "help") {
    printHelp();
    return;
  }

  applyBrowserRuntimeEnv(process.env);
  const config = loadConfig();
  const taskActionCsrfToken = randomBytes(32).toString("base64url");
  const taskActionService = new TaskActionService(config, randomBytes(32).toString("base64url"));
  const attentionService = new AttentionService(config);
  const structuredTaskService = new StructuredTaskService(config);
  installAttentionEventBusListener(config, attentionService);
  if (config.requireHttpToken && !config.authToken) {
    throw new Error(
      "CODEXPRO_HTTP_TOKEN is required for this HTTP binding. " +
        "Set CODEXPRO_HTTP_TOKEN, use `codexpro start` to generate one, " +
        "or set CODEXPRO_ALLOW_NO_HTTP_TOKEN=1 only for a trusted local-only setup."
    );
  }

  const recovery = await recoverConfiguredDurableJobs(config);
  if (recovery.resumed.length || recovery.recovery_required.length || recovery.stale.length || recovery.errors.length) {
    console.error(`[CodexPro] durable job recovery scanned=${recovery.scanned} resumed=${recovery.resumed.length} recovery_required=${recovery.recovery_required.length} stale=${recovery.stale.length} errors=${recovery.errors.length}`);
  }

  const officeSnapshotService = new OfficeSnapshotService(config);
  const officeReportService = new OfficeReportService(config);
  const officeToolOutcomeService = new OfficeToolOutcomeService(config);
  const officeToolOutcomeFeatures = officeToolOutcomeFeatureFlag();
  void officeToolOutcomeService.recoverPending().catch((error) => {
    console.warn(`[CodexPro] Office tool outcome recovery degraded: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
  });

  const app = express();
  const logRequests = process.env.CODEXPRO_LOG_REQUESTS === "1";

  function secretMatches(expectedValue: string, value: unknown): boolean {
    if (typeof value !== "string") return false;
    const expected = Buffer.from(expectedValue);
    const actual = Buffer.from(value);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function tokenMatches(value: unknown): boolean {
    return Boolean(config.authToken && secretMatches(config.authToken, value));
  }

  const authSessionCookieName = "codexpro_admin_session";
  const authSessionValue = config.authToken
    ? createHash("sha256").update("codexpro-admin-session-v1\0").update(config.authToken).digest("base64url")
    : "";

  function requestCookie(req: Request, name: string): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const item of header.split(";")) {
      const separator = item.indexOf("=");
      if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
      const value = item.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return undefined;
  }

  function authSessionMatches(req: Request): boolean {
    return Boolean(authSessionValue && secretMatches(authSessionValue, requestCookie(req, authSessionCookieName)));
  }

  function requestUsesHttps(req: Request): boolean {
    const forwarded = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase();
    return forwarded === "https" || req.protocol === "https";
  }

  function setAuthSessionCookie(req: Request, res: Response): void {
    if (!authSessionValue) return;
    const attributes = [
      `${authSessionCookieName}=${encodeURIComponent(authSessionValue)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      "Max-Age=2592000"
    ];
    if (requestUsesHttps(req)) attributes.push("Secure");
    res.append("Set-Cookie", attributes.join("; "));
  }

  function safeReturnPath(value: unknown): string {
    if (typeof value !== "string" || value.length > 2048) return "/";
    try {
      const parsed = new URL(value, "http://codexpro.local");
      if (parsed.origin !== "http://codexpro.local") return "/";
      parsed.searchParams.delete("codexpro_token");
      parsed.searchParams.delete("token");
      return `${parsed.pathname}${parsed.search}${parsed.hash}` || "/";
    } catch {
      return "/";
    }
  }

  function authLoginPage(returnTo: string, invalid = false): string {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>登录 CodexPro</title>
  <style>
    :root{color-scheme:light dark;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f5f8;color:#152033;padding:20px}.card{width:min(420px,100%);background:#fff;border:1px solid #dce2ea;border-radius:18px;padding:24px;box-shadow:0 18px 50px rgba(30,41,59,.12)}h1{margin:0 0 8px;font-size:24px}p{color:#697386;line-height:1.6}.error{color:#b42318;background:#fff0ee;border:1px solid #f0b8b2;border-radius:10px;padding:9px 11px}label{display:grid;gap:7px;margin-top:18px;font-weight:700}input{width:100%;border:1px solid #c7d0dc;border-radius:10px;padding:11px 12px;font:inherit}button{width:100%;margin-top:14px;border:0;border-radius:10px;padding:11px 14px;background:#2563eb;color:#fff;font:inherit;font-weight:700;cursor:pointer}.note{font-size:12px;margin-bottom:0}@media(prefers-color-scheme:dark){body{background:#10141d;color:#edf2f7}.card{background:#171d28;border-color:#303a4a}.card p{color:#a7b0c0}input{background:#1d2431;border-color:#435067;color:#edf2f7}}
  </style>
</head>
<body>
  <main class="card">
    <h1>登录 CodexPro</h1>
    <p>使用当前 CodexPro 令牌建立安全登录状态。令牌本身不会写入页面或登录凭证。</p>
    ${invalid ? '<div class="error" role="alert">令牌无效，请使用当前正在运行的 CodexPro 令牌。</div>' : ""}
    <form method="post" action="/auth/session">
      <input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
      <label>CodexPro 令牌<input type="password" name="codexpro_token" autocomplete="current-password" required autofocus></label>
      <button type="submit">登录</button>
    </form>
    <p class="note">登录状态仅用于当前 CodexPro 地址；现有令牌不会被更换、重置或覆盖。</p>
  </main>
</body>
</html>`;
  }

  function sendAuthLoginPage(res: Response, returnTo: string, invalid = false): void {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.status(invalid ? 401 : 200).type("html").send(authLoginPage(returnTo, invalid));
  }

  function loopbackAddress(value: string | undefined): boolean {
    const normalized = String(value ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
    return normalized === "localhost"
      || normalized === "::1"
      || normalized.startsWith("127.")
      || normalized.startsWith("::ffff:127.");
  }

  function taskActionLocalOnly(req: Request): boolean {
    return loopbackAddress(config.host) && loopbackAddress(req.socket.remoteAddress);
  }

  function taskActionOriginAllowed(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (Array.isArray(origin)) return false;
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === req.get("host");
    } catch {
      return false;
    }
  }

  function taskActionCsrfAllowed(req: Request): boolean {
    const value = req.headers["x-codexpro-csrf"];
    const token = Array.isArray(value) ? value[0] : value;
    return secretMatches(taskActionCsrfToken, token);
  }

  type AdminMutationGateOptions = {
    codePrefix: string;
    subject: string;
  };

  function adminMutationGate(options: AdminMutationGateOptions) {
    return async function requireAdminMutation(req: Request, res: Response, next: NextFunction): Promise<void> {
      if (!taskActionLocalOnly(req)) {
        const reason = `${options.subject} requires a loopback HTTP binding and loopback client connection.`;
        await auditAdminTransportRejection(req, reason, 403);
        res.locals.diagnosticReason = `${options.codePrefix}_local_only`;
        jsonError(res, 403, `${options.codePrefix}_local_only`, `${options.subject} is available only from localhost.`);
        return;
      }
      if (!taskActionOriginAllowed(req)) {
        const reason = `${options.subject} Origin did not match the current local HTTP host.`;
        await auditAdminTransportRejection(req, reason, 403);
        res.locals.diagnosticReason = `${options.codePrefix}_origin_denied`;
        jsonError(res, 403, `${options.codePrefix}_origin_denied`, `${options.subject} Origin is not allowed.`);
        return;
      }
      if (!taskActionCsrfAllowed(req)) {
        const reason = `${options.subject} CSRF token was missing or invalid.`;
        await auditAdminTransportRejection(req, reason, 403);
        res.locals.diagnosticReason = `${options.codePrefix}_csrf_denied`;
        jsonError(res, 403, `${options.codePrefix}_csrf_denied`, `${options.subject} CSRF token is missing or invalid.`);
        return;
      }
      next();
    };
  }

  function taskActionTaskId(req: Request): string | undefined {
    const match = req.path.match(/^\/admin\/tasks\/([^/]+)\/action$/);
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function attentionMutationPath(req: Request): boolean {
    return /^\/admin\/attention\/[^/]+\/(?:ack|resolve)$/.test(req.path);
  }

  function attentionMutationId(req: Request): string | undefined {
    const match = req.path.match(/^\/admin\/attention\/([^/]+)\/(?:ack|resolve)$/);
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function taskProjectSelector(req: Request): string | undefined {
    return typeof req.query.project === "string" ? req.query.project : undefined;
  }

  async function auditAdminTransportRejection(req: Request, reason: string, resultStatus: number): Promise<void> {
    const taskId = taskActionTaskId(req);
    if (taskId) {
      await taskActionService.auditRejectedAttempt({
        task_id: taskId,
        project_id: taskProjectSelector(req),
        reason,
        result_status: resultStatus
      }).catch(() => undefined);
      return;
    }
    if (attentionMutationPath(req)) {
      await attentionService.auditRejectedAttempt({
        project_id: taskProjectSelector(req),
        attention_id: attentionMutationId(req),
        reason,
        result_status: resultStatus
      }).catch(() => undefined);
    }
  }

  const adminRateWindow = new Map<string, { count: number; resetAt: number }>();

  async function adminRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "local";
    const current = adminRateWindow.get(key);
    if (!current || current.resetAt <= now) {
      adminRateWindow.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    current.count += 1;
    if (current.count > 30) {
      await auditAdminTransportRejection(req, "Admin mutation was rejected by the local rate limit.", 429);
      jsonError(res, 429, "rate_limited", "Too many admin action attempts. Try again in a minute.");
      return;
    }
    next();
  }

  async function adminBodyLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const length = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(length) && length > 32_768) {
      await auditAdminTransportRejection(req, "Admin mutation request body exceeded the local body limit.", 413);
      jsonError(res, 413, "payload_too_large", "Admin request body is too large.");
      return;
    }
    next();
  }

  app.use((req, res, next) => {
    const isMcpRequest = req.path === "/mcp";
    if (!isMcpRequest && !logRequests) {
      next();
      return;
    }

    const traceId = randomUUID();
    const started = process.hrtime.bigint();
    const declaredRequestBytes = Number(req.headers["content-length"] ?? 0);
    let responseBytes = 0;
    let finished = false;
    let emitted = false;
    let clientAborted = false;

    const chunkBytes = (chunk: unknown, encoding?: BufferEncoding): number => {
      if (chunk === undefined || chunk === null) return 0;
      if (Buffer.isBuffer(chunk)) return chunk.byteLength;
      if (chunk instanceof Uint8Array) return chunk.byteLength;
      return Buffer.byteLength(String(chunk), encoding);
    };

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = ((chunk: unknown, encoding?: BufferEncoding, callback?: () => void) => {
      responseBytes += chunkBytes(chunk, encoding);
      return originalWrite(chunk as never, encoding as never, callback as never);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, encoding?: BufferEncoding, callback?: () => void) => {
      responseBytes += chunkBytes(chunk, encoding);
      return originalEnd(chunk as never, encoding as never, callback as never);
    }) as typeof res.end;

    const emitRequestLog = (event: "finish" | "close"): void => {
      if (emitted) return;
      emitted = true;
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const localReason = typeof res.locals.diagnosticReason === "string" ? res.locals.diagnosticReason : undefined;
      const failureReason = localReason
        ?? (clientAborted ? "client_aborted"
          : event === "close" && !finished ? "client_closed_before_response_complete"
            : res.statusCode >= 500 ? "http_5xx"
              : undefined);
      const payload = {
        event: isMcpRequest ? "mcp_request" : "http_request",
        trace_id: traceId,
        method: req.method,
        path: req.path,
        status_code: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        request_bytes: Number.isFinite(declaredRequestBytes) ? declaredRequestBytes : 0,
        response_bytes: responseBytes,
        client_aborted: clientAborted,
        response_completed: finished,
        mcp_session_present: Boolean(req.headers["mcp-session-id"]),
        mcp_route: typeof res.locals.mcpRoute === "string" ? res.locals.mcpRoute : null,
        mcp_declared_protocol_version: typeof res.locals.mcpDeclaredProtocolVersion === "string" ? res.locals.mcpDeclaredProtocolVersion : null,
        mcp_rpc_method: typeof res.locals.mcpRpcMethod === "string" ? res.locals.mcpRpcMethod : null,
        mcp_tool_name: typeof res.locals.mcpToolName === "string" ? res.locals.mcpToolName : null,
        failure_reason: failureReason ?? null
      };
      console.error(`[CodexPro][request] ${JSON.stringify(payload)}`);
    };

    req.on("aborted", () => {
      clientAborted = true;
    });
    res.on("finish", () => {
      finished = true;
      emitRequestLog("finish");
    });
    res.on("close", () => emitRequestLog("close"));
    next();
  });
  app.use(cors({ exposedHeaders: ["Mcp-Session-Id"] }));
  app.get("/favicon.ico", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type("image/svg+xml").send(LOCAL_FAVICON);
  });

  const chromeExtensionIdPattern = /^[a-p]{32}$/;
  const browserExtensionProtocolVersion = "1";
  const extensionIdFromOrigin = (origin: string): string | null => {
    try {
      const parsed = new URL(origin);
      const extensionId = parsed.hostname.toLowerCase();
      return parsed.protocol === "chrome-extension:" && chromeExtensionIdPattern.test(extensionId) ? extensionId : null;
    } catch {
      return null;
    }
  };
  const extensionRequestAllowed = (req: Request): boolean => {
    const host = String(req.hostname ?? "").toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) return false;

    const origin = String(req.headers.origin ?? "").trim();
    const extensionIdHeader = String(req.headers["x-codexpro-extension-id"] ?? "").trim().toLowerCase();
    if (origin) {
      const originExtensionId = extensionIdFromOrigin(origin);
      return Boolean(originExtensionId) && (!extensionIdHeader || extensionIdHeader === originExtensionId);
    }

    // Google Chrome 149+ omits Origin for extension fetches. These Sec-Fetch
    // values are browser-controlled and distinguish an extension-initiated
    // request from an ordinary cross-site webpage request.
    return chromeExtensionIdPattern.test(extensionIdHeader) &&
      String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "none" &&
      String(req.headers["sec-fetch-mode"] ?? "").toLowerCase() === "cors" &&
      String(req.headers["sec-fetch-dest"] ?? "").toLowerCase() === "empty";
  };
  const rejectExtensionRequest = (res: Response): void => {
    res.locals.diagnosticReason = "browser_extension_origin_rejected";
    res.status(403).json({ ok: false, error: "Chrome extension bridge is available only from a verified local Chrome extension request." });
  };
  const extensionProtocolCompatible = (req: Request): boolean => {
    const actual = String(req.headers["x-codexpro-extension-protocol"] ?? "").trim();
    return !actual || actual === browserExtensionProtocolVersion;
  };
  const rejectExtensionProtocol = (req: Request, res: Response): void => {
    const actual = String(req.headers["x-codexpro-extension-protocol"] ?? "").trim() || "missing";
    res.locals.diagnosticReason = "browser_extension_protocol_mismatch";
    res.status(426).json({
      ok: false,
      error: `Chrome extension protocol mismatch: expected ${browserExtensionProtocolVersion}, got ${actual}.`,
      expected_protocol_version: browserExtensionProtocolVersion,
      actual_protocol_version: actual
    });
  };
  const extensionBody = express.json({ limit: "16kb" });
  app.get("/browser-extension/challenge", (req, res) => {
    if (!extensionRequestAllowed(req)) {
      rejectExtensionRequest(res);
      return;
    }
    if (!extensionProtocolCompatible(req)) {
      rejectExtensionProtocol(req, res);
      return;
    }
    try {
      const browserInstanceId = String(req.query.browser_instance_id ?? "");
      res.json({ ok: true, ...browserAuthorizationStore.createChallenge(browserInstanceId) });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/browser-extension/authorize", extensionBody, (req, res) => {
    if (!extensionRequestAllowed(req)) {
      rejectExtensionRequest(res);
      return;
    }
    if (!extensionProtocolCompatible(req)) {
      rejectExtensionProtocol(req, res);
      return;
    }
    const parsed = z.object({
      challenge: z.string().min(1).max(200),
      authorization_id: z.string().min(16).max(128),
      browser_instance_id: z.string().min(8).max(128),
      tab_id: z.number().int().nonnegative(),
      window_id: z.number().int().nonnegative(),
      url: z.string().url(),
      title: z.string().max(500).optional()
    }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "Invalid browser authorization payload.", details: parsed.error.flatten() });
      return;
    }
    try {
      const authorization = browserAuthorizationStore.authorize({
        challenge: parsed.data.challenge,
        authorizationId: parsed.data.authorization_id,
        browserInstanceId: parsed.data.browser_instance_id,
        tabId: parsed.data.tab_id,
        windowId: parsed.data.window_id,
        url: parsed.data.url,
        title: parsed.data.title,
        extensionId: String(req.headers["x-codexpro-extension-id"] ?? "").trim().toLowerCase() || undefined,
        extensionVersion: String(req.headers["x-codexpro-extension-version"] ?? "").trim() || undefined,
        extensionProtocolVersion: String(req.headers["x-codexpro-extension-protocol"] ?? "").trim() || undefined
      });
      res.json({ ok: true, authorization });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/browser-extension/release", extensionBody, (req, res) => {
    if (!extensionRequestAllowed(req)) {
      rejectExtensionRequest(res);
      return;
    }
    if (!extensionProtocolCompatible(req)) {
      rejectExtensionProtocol(req, res);
      return;
    }
    const authorizationId = String(req.body?.authorization_id ?? "");
    res.json({ ok: true, released: browserAuthorizationStore.release(authorizationId) });
  });
  app.get("/browser-extension/status", (req, res) => {
    if (!extensionRequestAllowed(req)) {
      rejectExtensionRequest(res);
      return;
    }
    if (!extensionProtocolCompatible(req)) {
      rejectExtensionProtocol(req, res);
      return;
    }
    res.json({
      ok: true,
      expected_protocol_version: browserExtensionProtocolVersion,
      authorizations: browserAuthorizationStore.list()
    });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    if (!config.mcpOauthHardeningEnabled) {
      res.status(404).json({ error: "MCP OAuth protected-resource metadata is disabled." });
      return;
    }
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(protectedResourceMetadata({
      resource: config.mcpOauthResource,
      audience: config.mcpOauthAudience,
      authorizationServers: config.mcpOauthAuthorizationServers,
      scopesSupported: config.mcpOauthScopes,
      dpopRequired: config.mcpOauthDpopRequired
    }));
  });

  const authFormBody = express.urlencoded({ extended: false, limit: "4kb" });
  app.get("/login", (req, res) => {
    const returnTo = safeReturnPath(req.query.return_to);
    if (!config.authToken || authSessionMatches(req)) {
      res.redirect(303, returnTo);
      return;
    }
    sendAuthLoginPage(res, returnTo);
  });
  app.post("/auth/session", adminRateLimit, authFormBody, (req, res) => {
    const returnTo = safeReturnPath(req.body?.return_to);
    if (!config.authToken || tokenMatches(req.body?.codexpro_token)) {
      setAuthSessionCookie(req, res);
      res.redirect(303, returnTo);
      return;
    }
    sendAuthLoginPage(res, returnTo, true);
  });

  app.use(async (req, res, next) => {
    if (!config.authToken) {
      next();
      return;
    }
    const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    const queryToken = typeof req.query.codexpro_token === "string"
      ? req.query.codexpro_token
      : typeof req.query.token === "string"
        ? req.query.token
        : undefined;
    const queryAuthorized = tokenMatches(queryToken);
    if (queryAuthorized) {
      setAuthSessionCookie(req, res);
      if (req.method === "GET" && ["/", "/setup", "/office"].includes(req.path)) {
        res.redirect(303, safeReturnPath(req.originalUrl));
        return;
      }
    }
    if (!tokenMatches(bearer) && !queryAuthorized && !authSessionMatches(req)) {
      await auditAdminTransportRejection(req, "Admin mutation authentication failed.", 401);
      res.locals.diagnosticReason = "unauthorized";
      if (req.method === "GET" && ["/", "/setup", "/office"].includes(req.path)) {
        const returnTo = safeReturnPath(req.originalUrl);
        res.redirect(303, `/login?return_to=${encodeURIComponent(returnTo)}`);
      } else {
        res.status(401).send("Unauthorized");
      }
      return;
    }
    next();
  });

  type TransportRecord = {
    transport: StreamableHTTPServerTransport;
    createdAt: number;
    lastSeenAt: number;
  };

  const transports = new Map<string, TransportRecord>();
  const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function requestSessionId(req: Request): string | undefined {
    const value = req.headers["mcp-session-id"];
    return Array.isArray(value) ? value[0] : value;
  }

  function sendSessionError(res: Response, sessionId: string | undefined): void {
    const missing = !sessionId;
    const malformed = Boolean(sessionId && !sessionIdPattern.test(sessionId));
    res.locals.diagnosticReason = missing ? "mcp_session_missing" : malformed ? "mcp_session_malformed" : "mcp_session_not_found";
    res.status(missing || malformed ? 400 : 404).json({
      jsonrpc: "2.0",
      error: missing
        ? { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" }
        : malformed
          ? { code: -32000, message: "Bad Request: invalid MCP session id" }
          : { code: -32001, message: "Session not found" },
      id: null
    });
  }

  function closeTransport(record: TransportRecord): void {
    void record.transport.close?.();
  }

  function pruneTransports(): void {
    const now = Date.now();
    for (const [sessionId, record] of transports) {
      if (now - record.lastSeenAt > config.httpSessionTtlMs) {
        transports.delete(sessionId);
        closeTransport(record);
      }
    }
    while (transports.size > config.maxHttpSessions) {
      const oldest = [...transports.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (!oldest) break;
      transports.delete(oldest[0]);
      closeTransport(oldest[1]);
    }
  }

  function getTransport(sessionId: string | undefined): StreamableHTTPServerTransport | undefined {
    if (!sessionId || !sessionIdPattern.test(sessionId)) return undefined;
    pruneTransports();
    const record = transports.get(sessionId);
    if (!record) return undefined;
    record.lastSeenAt = Date.now();
    return record.transport;
  }

  const pruneTimer = setInterval(pruneTransports, Math.min(config.httpSessionTtlMs, 60_000));
  pruneTimer.unref();

  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderOnboardingPage(config, taskActionCsrfToken));
  });

  app.get("/setup", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(renderOnboardingPage(config, taskActionCsrfToken));
  });

  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json({
      ok: true,
      name: "CodexPro",
      defaultRoot: config.defaultRoot,
      allowedRoots: config.allowedRoots,
      bashMode: config.bashMode,
      bashTranscript: config.bashTranscript,
      bashSessionId: config.bashSessionId ?? null,
      requireBashSession: config.requireBashSession,
      codexSessions: config.codexSessions,
      writeMode: config.writeMode,
      toolMode: config.toolMode,
      widgetDomain: config.widgetDomain,
      contextDir: config.contextDir,
      authEnabled: Boolean(config.authToken),
      authRequired: Boolean(config.authToken),
      mcp: {
        sdkVersion: "1.29.0",
        defaultProtocol: "legacy",
        legacyCompatibilityEnabled: true,
        protocol20260728: {
          releaseStatus: "rc",
          enabled: config.mcp20260728Enabled,
          rolloutPercent: config.mcp20260728RolloutPercent,
          stateless: true,
          discovery: true,
          tasksExtension: config.mcpTasksExtensionEnabled,
          multiRoundTrip: config.mcpMrtrEnabled,
          apps: config.mcpAppsEnabled,
          subscriptions: config.mcpSubscriptionsEnabled,
          oauthHardening: config.mcpOauthHardeningEnabled,
          dpopRequired: config.mcpOauthDpopRequired,
          requestStateProtectionConfigured: Boolean(config.mcpRequestStateSecret)
        }
      },
      gold_task: goldTaskRuntimeIdentity(config.defaultRoot)
    });
  });

  app.get("/office", (_req, res) => {
    officeSnapshotService.refreshInBackground();
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(officeSurfacePage(taskActionCsrfToken));
  });

  app.get("/admin/office", async (req, res) => {
    try {
      const officeReadStartedAt = Date.now();
      const office = await officeDashboard(config, officeSnapshotService, req.query as Record<string, unknown>);
      const officeReadDurationMs = Math.max(0, Date.now() - officeReadStartedAt);
      const etag = `"${office.revision}"`;
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.setHeader("ETag", etag);
      res.setHeader("Server-Timing", `office-read;dur=${officeReadDurationMs}, office-refresh;dur=${office.snapshot_observability?.last_refresh_duration_ms ?? 0}`);
      res.setHeader("X-CodexPro-Office-Snapshot-Age-Ms", String(office.snapshot_observability?.age_ms ?? 0));
      res.setHeader("X-CodexPro-Office-Refresh", office.snapshot_observability?.refresh_in_flight ? "running" : "idle");
      const candidates = String(req.headers["if-none-match"] ?? "").split(",").map((item) => item.trim());
      if (candidates.includes(etag) || candidates.includes(`W/${etag}`)) {
        const browserConditionalMode = String(req.headers["x-codexpro-office-not-modified"] ?? "");
        if (browserConditionalMode === "200") {
          res.removeHeader("ETag");
          res.status(200).json({ version: 1, not_modified: true, revision: office.revision, projection_id: office.projection_id });
          return;
        }
        res.status(browserConditionalMode === "204" ? 204 : 304).end();
        return;
      }
      res.json(office);
    } catch (error) {
      const issues = error && typeof error === "object" && "issues" in error ? (error as { issues?: unknown }).issues : undefined;
      jsonError(
        res,
        issues ? 400 : 500,
        issues ? "invalid_office_query" : "office_projection_failed",
        redactSensitiveText(error instanceof Error ? error.message : String(error)),
        issues
      );
    }
  });

  app.get("/admin/office/consistency", async (req, res) => {
    try {
      const office = await officeDashboard(config, officeSnapshotService, req.query as Record<string, unknown>);
      const toolOutcomeConsistency = await Promise.all(office.projects.map(async (project) => {
        try {
          return await officeToolOutcomeService.consistency(project.project_id);
        } catch (error) {
          return {
            version: 1 as const,
            project_id: project.project_id,
            ok: false,
            event_count: 0,
            latest_sequence: 0,
            duplicate_event_ids: [],
            digest_mismatches: [],
            sequence_gaps: [],
            invalid_files: [],
            queued_receipts: [],
            degraded_receipts: [],
            state_authority_changed: false as const,
            error: redactSensitiveText(error instanceof Error ? error.message : String(error))
          };
        }
      }));
      const toolOutcomeViolations = toolOutcomeConsistency.flatMap((result) => {
        if (result.ok) return [];
        const details = [
          result.duplicate_event_ids.length ? `重复事件 ${result.duplicate_event_ids.length}` : "",
          result.digest_mismatches.length ? `摘要不一致 ${result.digest_mismatches.length}` : "",
          result.sequence_gaps.length ? `序号缺口 ${result.sequence_gaps.length}` : "",
          result.invalid_files.length ? `无效文件 ${result.invalid_files.length}` : "",
          result.queued_receipts.length ? `待投影收据 ${result.queued_receipts.length}` : "",
          result.degraded_receipts.length ? `降级收据 ${result.degraded_receipts.length}` : "",
          "error" in result && result.error ? result.error : ""
        ].filter(Boolean).join("；");
        return [`${result.project_id}:工具结果投影异常${details ? `（${details}）` : ""}`];
      });
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.json({
        version: 1,
        ok: office.consistency.ok && toolOutcomeViolations.length === 0,
        projection_id: office.projection_id,
        revision: office.revision,
        generated_at: office.generated_at,
        violations: [...office.consistency.violations, ...toolOutcomeViolations],
        projects: office.projects.map((project) => {
          const toolOutcomes = toolOutcomeConsistency.find((item) => item.project_id === project.project_id) ?? null;
          return {
            project_id: project.project_id,
            ok: project.projection_consistency_errors.length === 0 && toolOutcomes?.ok !== false,
            violations: project.projection_consistency_errors,
            diagnostics: project.projection_diagnostics,
            tool_outcomes: toolOutcomes
          };
        })
      });
    } catch (error) {
      const issues = error && typeof error === "object" && "issues" in error ? (error as { issues?: unknown }).issues : undefined;
      jsonError(
        res,
        issues ? 400 : 500,
        issues ? "invalid_office_query" : "office_consistency_failed",
        redactSensitiveText(error instanceof Error ? error.message : String(error)),
        issues
      );
    }
  });

  const sendOfficeToolOutcomeError = (res: Response, error: unknown): void => {
    if (error instanceof OfficeToolOutcomeServiceError) {
      jsonError(res, error.status, error.code, error.message);
      return;
    }
    jsonError(res, 500, "office_tool_outcome_failed", redactSensitiveText(error instanceof Error ? error.message : String(error)));
  };

  app.get("/admin/office/tool-results/consistency", async (req, res) => {
    try {
      const project = typeof req.query.project === "string" ? req.query.project : "";
      const body = await officeToolOutcomeService.consistency(project);
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.json(body);
    } catch (error) {
      sendOfficeToolOutcomeError(res, error);
    }
  });

  app.get("/admin/office/tool-results", async (req, res) => {
    try {
      const numeric = (value: unknown): number | undefined => {
        if (typeof value !== "string" || !value.trim()) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : Number.NaN;
      };
      const project = typeof req.query.project === "string" ? req.query.project : "";
      const actorRole = typeof req.query.actor_role === "string" ? req.query.actor_role as "executor" | "reviewer" | "observer" | "system" : undefined;
      const body = await officeToolOutcomeService.events({
        project,
        afterSequence: numeric(req.query.after_sequence),
        taskId: typeof req.query.task_id === "string" ? req.query.task_id : undefined,
        actorRole,
        limit: numeric(req.query.limit)
      });
      const etag = `"${body.revision}"`;
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.setHeader("ETag", etag);
      const candidates = String(req.headers["if-none-match"] ?? "").split(",").map((item) => item.trim());
      if (candidates.includes(etag) || candidates.includes(`W/${etag}`)) {
        res.status(304).end();
        return;
      }
      res.json(body);
    } catch (error) {
      sendOfficeToolOutcomeError(res, error);
    }
  });

  app.get("/admin/office/projection-receipts/:eventId", async (req, res) => {
    try {
      const project = typeof req.query.project === "string" ? req.query.project : "";
      const body = await officeToolOutcomeService.receipt(project, req.params.eventId);
      res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
      res.json(body);
    } catch (error) {
      sendOfficeToolOutcomeError(res, error);
    }
  });

  app.get("/admin/office/stream", async (req, res) => {
    if (!officeToolOutcomeFeatures.stream_enabled) {
      jsonError(res, 404, "office_event_stream_disabled", "The Office event stream is disabled.");
      return;
    }
    const project = typeof req.query.project === "string" ? req.query.project : "";
    const taskId = typeof req.query.task_id === "string" ? req.query.task_id : undefined;
    const querySequence = typeof req.query.after_sequence === "string" ? Number(req.query.after_sequence) : Number.NaN;
    const headerSequence = Number(req.headers["last-event-id"] ?? Number.NaN);
    let cursor = Number.isInteger(querySequence) && querySequence >= 0 ? querySequence : Number.isInteger(headerSequence) && headerSequence >= 0 ? headerSequence : 0;
    let closed = false;
    let polling = false;
    let heartbeatAt = Date.now();
    const startedAt = Date.now();
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`retry: 2000\n`);
    res.write(`event: ready\ndata: ${JSON.stringify({ version: 1, project, after_sequence: cursor, state_authority_changed: false })}\n\n`);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      if (!res.writableEnded) res.end();
    };
    const poll = async () => {
      if (closed || polling) return;
      if (Date.now() - startedAt > 10 * 60_000) {
        res.write(`event: reconnect\ndata: ${JSON.stringify({ reason: "connection_age_limit", after_sequence: cursor })}\n\n`);
        close();
        return;
      }
      polling = true;
      try {
        let pages = 0;
        while (!closed && pages < 5) {
          const body = await officeToolOutcomeService.events({ project, afterSequence: cursor, taskId, limit: 100 });
          for (const event of body.events) {
            cursor = Math.max(cursor, event.sequence);
            res.write(`id: ${event.sequence}\nevent: tool_result\ndata: ${JSON.stringify(event)}\n\n`);
          }
          pages += 1;
          if (!body.has_more || body.next_after_sequence <= cursor) break;
          cursor = body.next_after_sequence;
        }
        if (Date.now() - heartbeatAt >= 15_000) {
          heartbeatAt = Date.now();
          res.write(`: heartbeat ${heartbeatAt}\n\n`);
        }
      } catch (error) {
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
        res.write(`event: projection_error\ndata: ${JSON.stringify({ message, after_sequence: cursor, state_authority_changed: false })}\n\n`);
        close();
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void poll(), 250);
    timer.unref();
    req.on("close", close);
    req.on("aborted", close);
    void poll();
  });

  const sendOfficeReportError = (res: Response, error: unknown): void => {
    if (error instanceof OfficeReportServiceError) {
      jsonError(res, error.status, error.code, error.message);
      return;
    }
    jsonError(res, 500, "office_report_failed", redactSensitiveText(error instanceof Error ? error.message : String(error)));
  };

  const sendOfficeReportJson = (req: Request, res: Response, body: { revision: string }): void => {
    const etag = `"${body.revision}"`;
    res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
    res.setHeader("ETag", etag);
    const candidates = String(req.headers["if-none-match"] ?? "").split(",").map((item) => item.trim());
    if (candidates.includes(etag) || candidates.includes(`W/${etag}`)) {
      if (req.headers["x-codexpro-office-compat"] === "json") {
        if (req.headers["x-codexpro-office-revision"] === etag) {
          res.removeHeader("ETag");
          res.status(200).json({ ok: true, not_modified: true, revision: body.revision });
          return;
        }
        res.removeHeader("ETag");
      } else {
        res.status(304).end();
        return;
      }
    }
    res.json(body);
  };

  app.get("/admin/office/reports/:taskId/events/:sequence", async (req, res) => {
    try {
      const project = typeof req.query.project === "string" ? req.query.project : "";
      const sequence = Number(req.params.sequence);
      const body = await officeReportService.detail(project, req.params.taskId, sequence);
      sendOfficeReportJson(req, res, body);
    } catch (error) {
      sendOfficeReportError(res, error);
    }
  });

  app.get("/admin/office/reports/:taskId/stages", async (req, res) => {
    try {
      const project = typeof req.query.project === "string" ? req.query.project : "";
      const body = await officeReportService.stages(project, req.params.taskId);
      sendOfficeReportJson(req, res, body);
    } catch (error) {
      sendOfficeReportError(res, error);
    }
  });

  app.get("/admin/office/reports/:taskId", async (req, res) => {
    try {
      const numeric = (value: unknown): number | undefined => {
        if (typeof value !== "string" || !value.trim()) return undefined;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : Number.NaN;
      };
      const project = typeof req.query.project === "string" ? req.query.project : "";
      const body = await officeReportService.events({
        project,
        taskId: req.params.taskId,
        afterSequence: numeric(req.query.after_sequence),
        beforeSequence: numeric(req.query.before_sequence),
        limit: numeric(req.query.limit)
      });
      sendOfficeReportJson(req, res, body);
    } catch (error) {
      sendOfficeReportError(res, error);
    }
  });

  app.get("/admin/artifact", (req, res) => {
    serveAdminArtifact(config, req, res);
  });

  app.get("/admin/tasks", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await unifiedTaskDashboard(config, req.query as Record<string, unknown>, attentionService));
    } catch (error) {
      jsonError(res, 500, "task_dashboard_failed", error instanceof Error ? error.message : String(error));
    }
  });

  const sendTaskActionError = (res: Response, error: unknown): void => {
    if (error instanceof TaskActionError) {
      jsonError(res, error.status, error.code, error.message);
      return;
    }
    jsonError(res, 500, "task_action_failed", error instanceof Error ? error.message : String(error));
  };

  const sendAttentionError = (res: Response, error: unknown): void => {
    if (error instanceof AttentionServiceError) {
      jsonError(res, error.status, error.code, error.message);
      return;
    }
    jsonError(res, 500, "attention_failed", error instanceof Error ? error.message : String(error));
  };

  const sendStructuredTaskError = (res: Response, error: unknown): void => {
    if (error instanceof StructuredTaskError) {
      jsonError(res, error.status, error.code, error.message, error.issues);
      return;
    }
    jsonError(res, 500, "structured_task_failed", error instanceof Error ? error.message : String(error));
  };

  app.get("/admin/attention", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await attentionService.getAttention(req.query as Record<string, unknown>));
    } catch (error) {
      sendAttentionError(res, error);
    }
  });

  app.post("/admin/structured-tasks", adminRateLimit, adminBodyLimit, express.json({ limit: "32kb" }), async (req, res) => {
    if (!taskActionLocalOnly(req)) {
      jsonError(res, 403, "structured_task_local_only", "Structured task creation is available only from localhost.");
      return;
    }
    if (!taskActionOriginAllowed(req)) {
      jsonError(res, 403, "structured_task_origin_denied", "Structured task Origin is not allowed.");
      return;
    }
    if (!taskActionCsrfAllowed(req)) {
      jsonError(res, 403, "structured_task_csrf_denied", "Structured task CSRF token is missing or invalid.");
      return;
    }
    try {
      res.setHeader("Cache-Control", "no-store");
      const result = await structuredTaskService.create(req.body ?? {});
      res.status(result.status).json(result.body);
    } catch (error) {
      sendStructuredTaskError(res, error);
    }
  });

  app.get("/admin/tasks/:task_id/timeline", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await taskActionService.getTimeline(String(req.params.task_id ?? ""), taskProjectSelector(req)));
    } catch (error) {
      sendTaskActionError(res, error);
    }
  });

  app.get("/admin/tasks/:task_id/evidence", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await taskActionService.getEvidence(String(req.params.task_id ?? ""), taskProjectSelector(req)));
    } catch (error) {
      sendTaskActionError(res, error);
    }
  });

  app.get("/admin/tasks/:task_id/recovery", async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await taskActionService.getRecovery(String(req.params.task_id ?? ""), taskProjectSelector(req)));
    } catch (error) {
      sendTaskActionError(res, error);
    }
  });

  app.post("/admin/tasks/:task_id/action-nonce", adminRateLimit, adminBodyLimit, express.json({ limit: "8kb" }), async (req, res) => {
    const taskId = String(req.params.task_id ?? "");
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    if (!taskActionLocalOnly(req)) {
      jsonError(res, 403, "task_action_local_only", "Task mutation endpoints are available only from localhost.");
      return;
    }
    if (!taskActionOriginAllowed(req)) {
      jsonError(res, 403, "task_action_origin_denied", "Task action Origin is not allowed.");
      return;
    }
    if (!taskActionCsrfAllowed(req)) {
      jsonError(res, 403, "task_action_csrf_denied", "Task action CSRF token is missing or invalid.");
      return;
    }
    const result = await taskActionService.issueActionNonce(taskId, taskProjectSelector(req), body, taskActionCsrfToken);
    res.status(result.status).json(result.body);
  });

  app.post("/admin/tasks/:task_id/action", adminRateLimit, adminBodyLimit, express.json({ limit: "16kb" }), async (req, res) => {
    const taskId = String(req.params.task_id ?? "");
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const auditRejected = async (reason: string, status: number): Promise<void> => {
      await taskActionService.auditRejectedAttempt({
        task_id: taskId,
        project_id: taskProjectSelector(req),
        action: typeof body.action === "string" ? body.action : undefined,
        expected_status: typeof body.expected_status === "string" ? body.expected_status : undefined,
        reason,
        result_status: status
      });
    };
    if (!taskActionLocalOnly(req)) {
      await auditRejected("Task mutation endpoints are available only over a loopback HTTP binding and loopback client connection.", 403);
      jsonError(res, 403, "task_action_local_only", "Task mutation endpoints are available only from localhost.");
      return;
    }
    if (!taskActionOriginAllowed(req)) {
      await auditRejected("Task action Origin did not match the current local HTTP host.", 403);
      jsonError(res, 403, "task_action_origin_denied", "Task action Origin is not allowed.");
      return;
    }
    if (!taskActionCsrfAllowed(req)) {
      await auditRejected("Task action CSRF token was missing or invalid.", 403);
      jsonError(res, 403, "task_action_csrf_denied", "Task action CSRF token is missing or invalid.");
      return;
    }
    const result = await taskActionService.handleAction(taskId, taskProjectSelector(req), body, taskActionCsrfToken);
    res.status(result.status).json(result.body);
  });

  app.post("/admin/git-finalization/retry", adminRateLimit, adminBodyLimit, express.json({ limit: "8kb" }), async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const auditRejected = async (reason: string, status: number): Promise<void> => {
      await taskActionService.auditRejectedAttempt({
        project_id: taskProjectSelector(req),
        action: typeof body.action === "string" ? body.action : "retry_push",
        expected_status: "failed",
        reason,
        result_status: status
      });
    };
    if (!taskActionLocalOnly(req)) {
      await auditRejected("Git retry endpoints are available only over a loopback HTTP binding and loopback client connection.", 403);
      jsonError(res, 403, "git_retry_local_only", "Git push retry is available only from localhost.");
      return;
    }
    if (!taskActionOriginAllowed(req)) {
      await auditRejected("Git retry Origin did not match the current local HTTP host.", 403);
      jsonError(res, 403, "git_retry_origin_denied", "Git retry Origin is not allowed.");
      return;
    }
    if (!taskActionCsrfAllowed(req)) {
      await auditRejected("Git retry CSRF token was missing or invalid.", 403);
      jsonError(res, 403, "git_retry_csrf_denied", "Git retry CSRF token is missing or invalid.");
      return;
    }
    const result = await taskActionService.handleGitRetry(taskProjectSelector(req), body);
    res.status(result.status).json(result.body);
  });

  const handleAttentionResolve = async (req: Request, res: Response): Promise<void> => {
    const attentionId = String(req.params.attention_id ?? "");
    const auditRejected = async (reason: string, status: number): Promise<void> => {
      await attentionService.auditRejectedAttempt({
        project_id: taskProjectSelector(req),
        attention_id: attentionId,
        reason,
        result_status: status
      }).catch(() => undefined);
    };
    if (!taskActionLocalOnly(req)) {
      await auditRejected("Attention mutation endpoints are available only over a loopback binding and client connection.", 403);
      jsonError(res, 403, "attention_local_only", "Attention mutation endpoints are available only from localhost.");
      return;
    }
    if (!taskActionOriginAllowed(req)) {
      await auditRejected("Attention action Origin did not match the current local HTTP host.", 403);
      jsonError(res, 403, "attention_origin_denied", "Attention action Origin is not allowed.");
      return;
    }
    if (!taskActionCsrfAllowed(req)) {
      await auditRejected("Attention action CSRF token was missing or invalid.", 403);
      jsonError(res, 403, "attention_csrf_denied", "Attention action CSRF token is missing or invalid.");
      return;
    }
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await attentionService.acknowledgeAttention(attentionId, taskProjectSelector(req) ?? null));
    } catch (error) {
      const status = error instanceof AttentionServiceError ? error.status : 500;
      await auditRejected(error instanceof Error ? error.message : "Attention acknowledgement failed.", status);
      sendAttentionError(res, error);
    }
  };

  app.post("/admin/attention/:attention_id/ack", adminRateLimit, adminBodyLimit, express.json({ limit: "4kb" }), handleAttentionResolve);
  app.post("/admin/attention/:attention_id/resolve", adminRateLimit, adminBodyLimit, express.json({ limit: "4kb" }), handleAttentionResolve);

  app.post(
    "/admin/action",
    adminRateLimit,
    adminMutationGate({ codePrefix: "admin_action", subject: "Admin console action" }),
    adminBodyLimit,
    express.json({ limit: "4kb" }),
    (req, res) => {
      handleConsoleAction(config, req, res);
    }
  );

  app.get("/admin/profile", (_req, res) => {
    res.json(profileResponse(config));
  });

  app.post(
    "/admin/profile",
    adminRateLimit,
    adminMutationGate({ codePrefix: "admin_profile", subject: "Admin profile update" }),
    adminBodyLimit,
    express.json({ limit: "32kb" }),
    (req, res) => {
      const parsed = AdminProfilePatch.safeParse(req.body ?? {});
      if (!parsed.success) {
        jsonError(res, 400, "invalid_profile", "Invalid profile settings.", parsed.error.flatten());
        return;
      }
      try {
        const existing = readWorkspaceProfile(config.defaultRoot);
        const payload = buildProfilePayload(config, existing, parsed.data);
        const profilePath = saveWorkspaceProfile(config.defaultRoot, payload);
        res.json({
          ...profileResponse(config),
          saved: true,
          profile_path: profilePath,
          message: "Saved. Restart CodexPro for these profile settings to apply."
        });
      } catch (error) {
        jsonError(res, 400, "invalid_profile", error instanceof Error ? error.message : String(error));
      }
    }
  );

  app.all("/admin/profile", (_req, res) => {
    jsonError(res, 405, "method_not_allowed", "Use GET or POST for /admin/profile.");
  });

  app.post("/mcp", express.json({ limit: "20mb" }), async (req, res) => {
    try {
      const requestBody = req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? req.body as Record<string, unknown>
        : {};
      const requestParams = requestBody.params && typeof requestBody.params === "object" && !Array.isArray(requestBody.params)
        ? requestBody.params as Record<string, unknown>
        : {};
      const declaredProtocolVersion = declaredModernProtocolVersion(req.headers as McpHeaderMap, req.body);
      const modernRequest = shouldHandleModernMcpRequest(req.headers as McpHeaderMap, req.body);
      res.locals.mcpRoute = modernRequest ? "modern_2026_07_28" : "legacy_session";
      res.locals.mcpDeclaredProtocolVersion = declaredProtocolVersion ?? null;
      res.locals.mcpRpcMethod = typeof requestBody.method === "string" ? requestBody.method : null;
      res.locals.mcpToolName = typeof requestParams.name === "string" ? requestParams.name : null;
      if (modernRequest) {
        const modern = await handleModernMcpRequest({
          config,
          headers: req.headers as McpHeaderMap,
          body: req.body
        });
        for (const [name, value] of Object.entries(modern.headers)) res.setHeader(name, value);
        res.status(modern.status).json(modern.body);
        recordGoldTaskConnectorConnection({
          workspace_root: config.defaultRoot,
          method: req.method,
          initialize_request: false,
          mcp_session_id: null
        });
        return;
      }

      const sessionId = requestSessionId(req);
      const initializeRequest = !sessionId && isInitializeRequest(req.body);
      let transport: StreamableHTTPServerTransport;

      const existingTransport = getTransport(sessionId);
      if (existingTransport) {
        transport = existingTransport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            pruneTransports();
            transports.set(newSessionId, {
              transport,
              createdAt: Date.now(),
              lastSeenAt: Date.now()
            });
            pruneTransports();
          }
        } as any);

        (transport as any).onclose = () => {
          const closedSessionId = (transport as any).sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
        };

        const server = createCodexProServer(config);
        await server.connect(transport);
      } else {
        sendSessionError(res, sessionId);
        return;
      }

      await transport.handleRequest(req, res, req.body);
      recordGoldTaskConnectorConnection({
        workspace_root: config.defaultRoot,
        method: req.method,
        initialize_request: initializeRequest,
        mcp_session_id: (transport as any).sessionId ?? sessionId ?? null
      });
    } catch (error) {
      res.locals.diagnosticReason = "mcp_internal_error";
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal CodexPro MCP error. Check the local terminal for details." },
          id: null
        });
      }
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = requestSessionId(req);
    const transport = getTransport(sessionId);
    if (!transport) {
      sendSessionError(res, sessionId);
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  app.use(async (error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (!error || typeof error !== "object" || !("type" in error)) {
      next(error);
      return;
    }
    const type = String((error as { type?: unknown }).type ?? "");
    if (type !== "entity.parse.failed" && type !== "entity.too.large") {
      next(error);
      return;
    }
    const status = type === "entity.too.large" ? 413 : 400;
    if (req.path === "/mcp") {
      res.locals.diagnosticReason = type === "entity.too.large" ? "mcp_payload_too_large" : "mcp_parse_error";
      res.status(status).json({
        jsonrpc: "2.0",
        error: {
          code: type === "entity.too.large" ? -32000 : -32700,
          message: type === "entity.too.large" ? "Payload too large." : "Parse error."
        },
        id: null
      });
      return;
    }
    if (taskActionTaskId(req)) {
      await auditAdminTransportRejection(
        req,
        type === "entity.too.large" ? "Task action JSON body exceeded the parser limit." : "Task action body was not valid JSON.",
        status
      );
      jsonError(
        res,
        status,
        type === "entity.too.large" ? "payload_too_large" : "invalid_json",
        type === "entity.too.large" ? "Request body is too large." : "Request body must be valid JSON."
      );
      return;
    }
    if (attentionMutationPath(req)) {
      await auditAdminTransportRejection(
        req,
        type === "entity.too.large" ? "Attention action JSON body exceeded the parser limit." : "Attention action body was not valid JSON.",
        status
      );
      jsonError(
        res,
        status,
        type === "entity.too.large" ? "payload_too_large" : "invalid_json",
        type === "entity.too.large" ? "Request body is too large." : "Request body must be valid JSON."
      );
      return;
    }
    if (req.path === "/admin/profile") {
      jsonError(
        res,
        status,
        type === "entity.too.large" ? "payload_too_large" : "invalid_json",
        type === "entity.too.large" ? "Request body is too large." : "Request body must be valid JSON."
      );
      return;
    }
    next(error);
  });

  app.listen(config.port, config.host, () => {
    console.error(`[CodexPro] HTTP MCP listening on http://${config.host}:${config.port}/mcp`);
    console.error(`[CodexPro] defaultRoot=${config.defaultRoot}`);
    console.error(`[CodexPro] allowedRoots=${config.allowedRoots.join(", ")}`);
    console.error(`[CodexPro] bashMode=${config.bashMode}`);
    console.error(`[CodexPro] writeMode=${config.writeMode}`);
    console.error(`[CodexPro] widgetDomain=${config.widgetDomain}`);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
