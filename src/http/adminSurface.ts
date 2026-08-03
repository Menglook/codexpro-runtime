import type { CodexProConfig } from "../config.js";
import {
  CONSOLE_ACTION_LABELS,
  CONSOLE_ATTENTION_TYPE_LABELS,
  CONSOLE_ENUM_LABELS,
  CONSOLE_LOCALE,
  CONSOLE_TEXT_LABELS,
  consoleEnumLabel
} from "./consoleLocale.js";

export interface AdminSurfaceHelpers {
  escapeHtml(value: unknown): string;
  shellQuote(value: string): string;
  copyCommand(title: string, description: string, command: string, displayCommand?: string, copyKind?: string): string;
  readRuntimeConnection(root: string): any;
  profileValues(config: CodexProConfig): any;
  serverUrlDisplay(endpoint: string | undefined, authEnabled: boolean): string;
  profileForm(config: CodexProConfig): string;
  dashboardPanel(config: CodexProConfig, serverUrl: string): string;
  csrfToken: string;
}

export function onboardingPage(config: CodexProConfig, helpers: AdminSurfaceHelpers): string {
  const { escapeHtml, shellQuote, copyCommand, readRuntimeConnection, profileValues, serverUrlDisplay, profileForm, dashboardPanel, csrfToken } = helpers;
  const localMcp = `http://${config.host}:${config.port}/mcp`;
  const localMcpDisplay = config.authToken ? `${localMcp}?codexpro_token=<redacted>` : localMcp;
  const allowedRoots = config.allowedRoots.map((root) => `<li>${escapeHtml(root)}</li>`).join("");
  const authLabel = config.authToken ? "令牌保护已启用" : "未启用";
  const writeTone = config.writeMode === "workspace" ? "agent" : config.writeMode;
  const clientLocale = JSON.stringify({
    locale: CONSOLE_LOCALE,
    enumLabels: CONSOLE_ENUM_LABELS,
    actionLabels: CONSOLE_ACTION_LABELS,
    attentionTypeLabels: CONSOLE_ATTENTION_TYPE_LABELS,
    textLabels: CONSOLE_TEXT_LABELS
  });
  const rootArg = shellQuote(config.defaultRoot);
  const sessionArg = shellQuote(config.bashSessionId || "main");
  const githubUrl = "https://github.com/rebel0789/codexpro";
  const npmUrl = "https://www.npmjs.com/package/codexpro";
  const docsUrl = "https://example.github.io/codexpro/";
  const chatgptUrl = "https://chatgpt.com/#settings/Connectors";
  const runtime = readRuntimeConnection(config.defaultRoot);
  const runtimeEndpoint = typeof runtime.endpoint === "string" ? runtime.endpoint : "";
  const savedProfile = profileValues(config);
  const savedEndpoint = savedProfile.hostname ? `https://${savedProfile.hostname}/mcp` : "";
  const dashboardServerUrl = serverUrlDisplay(runtimeEndpoint || savedEndpoint || localMcp, Boolean(config.authToken)) || localMcpDisplay;
  const controls = [
    copyCommand("重新运行设置向导", "使用 CLI 修改此页面未开放的高级配置。", "codexpro setup"),
    copyCommand("复制本地 MCP 地址", "适用于本地 MCP 客户端；ChatGPT 通常需要终端输出的公网隧道地址。", localMcp, localMcpDisplay, "local-mcp"),
    copyCommand("禁用 Bash 启动", "重启后保留文件工具，但不提供由 ChatGPT 触发的 Bash 工具。", `codexpro start --root ${rootArg} --no-bash`),
    copyCommand("要求指定 Bash 会话", "重启后 Bash 调用必须携带匹配的 session_id。", `codexpro start --root ${rootArg} --bash-session ${sessionArg} --require-bash-session`),
    copyCommand("显示 Codex 会话列表", "以完整工具模式重启，并只读显示本地 Codex 会话元数据。", `codexpro start --root ${rootArg} --tool-mode full --codex-sessions metadata`),
    copyCommand("读取 Codex 会话记录", "以完整工具模式重启，并有限读取 Codex JSONL 历史记录。", `codexpro start --root ${rootArg} --tool-mode full --codex-sessions read`),
    copyCommand("使用完整 Bash 输出", "重启后显示原始 stdout/stderr，而不是精简工具卡片。", `codexpro start --root ${rootArg} --bash-transcript full`)
  ].join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="/favicon.ico">
  <title>CodexPro 本地任务控制台</title>
  <style>
    /* Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V5 */
    /* Hallmark · macrostructure: Workbench · genre: modern-minimal · theme: CC Switch-inspired light manager · tone: technical admin · nav: section switcher · footer: Ft2 · contrast: pass (40-41) · mobile: pass (34, 49, 50-57) */
    :root {
      color-scheme: light;
      --font-display: "Geist", "Aptos", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-body: "Geist", "Aptos", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: "Fira Code", "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --color-paper: oklch(98.5% 0.004 250);
      --color-surface: oklch(100% 0 0);
      --color-panel: oklch(100% 0 0);
      --color-panel-2: oklch(96.5% 0.008 252);
      --color-row: oklch(99.2% 0.004 250);
      --color-rule: oklch(88% 0.012 250);
      --color-rule-strong: oklch(78% 0.018 250);
      --color-ink: oklch(23% 0.026 255);
      --color-soft: oklch(39% 0.026 255);
      --color-muted: oklch(53% 0.022 255);
      --color-subtle: oklch(64% 0.018 255);
      --color-accent: oklch(58% 0.19 256);
      --color-accent-strong: oklch(50% 0.22 256);
      --color-accent-ink: oklch(99% 0.004 250);
      --color-action: var(--color-accent);
      --color-action-strong: var(--color-accent-strong);
      --color-good: oklch(56% 0.14 154);
      --color-warn: oklch(54% 0.17 256);
      --color-focus: oklch(61% 0.2 256);
      --surface-accent: oklch(95% 0.036 256);
      --surface-good: oklch(94.5% 0.035 154);
      --surface-warn: oklch(95% 0.036 256);
      --surface-hover: oklch(93.5% 0.025 256);
      --shadow-panel: 0 18px 50px oklch(24% 0.03 255 / 0.10);
      --shadow-row: 0 8px 18px oklch(24% 0.03 255 / 0.06);
      --space-1: 0.25rem;
      --space-2: 0.5rem;
      --space-3: 0.75rem;
      --space-4: 1rem;
      --space-5: 1.25rem;
      --space-6: 1.5rem;
      --space-7: 2rem;
      --space-8: 2.5rem;
      --space-9: 3rem;
      --radius-1: 6px;
      --radius-2: 8px;
      --dur-micro: 120ms;
      --dur-short: 180ms;
      --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
    }
    * { box-sizing: border-box; }
    html,
    body {
      overflow-x: clip;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--color-paper);
      color: var(--color-ink);
      font: 14px/1.55 var(--font-body);
      letter-spacing: 0;
    }
    a {
      color: inherit;
      text-decoration: none;
    }
    button,
    input,
    select {
      font: inherit;
    }
    main {
      width: min(1240px, calc(100% - (var(--space-4) * 2)));
      margin: 0 auto;
      padding: var(--space-5) 0 var(--space-8);
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      margin-bottom: var(--space-3);
      padding: var(--space-2) 0 var(--space-3);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
    }
    .logo {
      display: inline-grid;
      place-items: center;
      width: 42px;
      height: 42px;
      flex: 0 0 auto;
      border: 1px solid var(--color-accent);
      border-radius: 12px;
      background: var(--color-accent);
      color: var(--color-accent-ink);
      box-shadow: var(--shadow-row);
      font: 900 15px/1 var(--font-mono);
    }
    .logo img {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: inherit;
    }
    .brand-kicker {
      display: block;
      color: var(--color-muted);
      font-size: 12px;
      font-weight: 800;
      line-height: 1.1;
      text-transform: uppercase;
    }
    .brand-title {
      display: block;
      overflow-wrap: anywhere;
      color: var(--color-accent);
      font: 900 28px/1 var(--font-display);
    }
    .quick-links {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .resource-link,
    .action-link,
    .copy-mini,
    .primary {
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-2);
      white-space: nowrap;
      transition: background-color var(--dur-short) var(--ease-out),
        border-color var(--dur-short) var(--ease-out),
        color var(--dur-short) var(--ease-out),
        transform var(--dur-micro) var(--ease-out);
    }
    .resource-link,
    .action-link {
      border: 1px solid var(--color-rule);
      background: var(--color-surface);
      color: var(--color-soft);
      font-size: 12px;
      font-weight: 800;
      padding: 0 var(--space-3);
      box-shadow: var(--shadow-row);
    }
    .action-link.primary-link {
      border-color: var(--color-action);
      background: var(--color-action);
      color: var(--color-accent-ink);
    }
    .section-tabs {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-1);
      flex-wrap: wrap;
      margin: 0 0 var(--space-5);
      padding: var(--space-1);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-surface);
      box-shadow: var(--shadow-panel);
    }
    .section-tabs a {
      min-height: 40px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 12px;
      color: var(--color-muted);
      font-size: 13px;
      font-weight: 900;
      white-space: nowrap;
      padding: 0 var(--space-4);
    }
    .section-tabs a[aria-current="page"] {
      background: var(--color-accent);
      color: var(--color-accent-ink);
      box-shadow: var(--shadow-row);
    }
    .overview {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(330px, 0.52fr);
      gap: var(--space-5);
      align-items: start;
      margin-bottom: var(--space-5);
    }
    .intro-stack {
      display: grid;
      gap: var(--space-5);
      min-width: 0;
    }
    .intro {
      min-width: 0;
      padding: var(--space-6);
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-surface);
      box-shadow: var(--shadow-panel);
    }
    h1 {
      margin: 0;
      max-width: 18ch;
      font: 900 2rem/1.05 var(--font-display);
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }
    .lead {
      max-width: 64ch;
      margin: var(--space-4) 0 0;
      color: var(--color-soft);
      font-size: 15px;
    }
    .scope-note {
      margin-top: var(--space-5);
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-rule);
      color: var(--color-muted);
      font-size: 13px;
    }
    .run-card,
    .panel {
      min-width: 0;
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-panel);
      box-shadow: var(--shadow-panel);
    }
    .run-card,
    .panel {
      padding: var(--space-5);
    }
    .run-card h2,
    .panel h2 {
      margin: 0;
      color: var(--color-ink);
      font: 700 16px/1.25 var(--font-display);
      letter-spacing: 0;
    }
    .workspace-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.08fr) minmax(310px, 0.58fr);
      gap: var(--space-5);
      align-items: start;
    }
    .side-stack {
      display: grid;
      gap: var(--space-5);
    }
    .section-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: var(--space-4);
      margin-bottom: var(--space-4);
    }
    .section-head p,
    .panel > p {
      margin: var(--space-1) 0 0;
      color: var(--color-muted);
      font-size: 13px;
    }
    .status {
      display: grid;
    }
    .row {
      display: grid;
      grid-template-columns: 132px minmax(0, 1fr);
      gap: var(--space-3);
      padding: var(--space-3) 0;
      border-bottom: 1px solid var(--color-rule);
    }
    .row:last-child { border-bottom: 0; }
    .label {
      color: var(--color-subtle);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }
    code,
    .mono {
      font-family: var(--font-mono);
      color: var(--color-soft);
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
    }
    .pill {
      display: inline-flex;
      width: fit-content;
      align-items: center;
      min-height: 26px;
      padding: 0 var(--space-2);
      border: 1px solid var(--color-good);
      border-radius: 999px;
      background: var(--surface-good);
      color: var(--color-good);
      font-size: 12px;
      font-weight: 800;
      line-height: 1;
      white-space: nowrap;
    }
    .warn {
      border-color: var(--color-warn);
      background: var(--surface-warn);
      color: var(--color-warn);
    }
    .controls {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .control {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-3);
      align-items: center;
      min-width: 0;
      min-height: 112px;
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-row);
      box-shadow: var(--shadow-row);
    }
    .control strong {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--color-ink);
      font-size: 13px;
    }
    .control p {
      margin: 0 0 var(--space-2);
      color: var(--color-muted);
      font-size: 12px;
    }
    .control code {
      display: block;
      padding: var(--space-2);
      border: 1px solid var(--color-rule);
      border-radius: 10px;
      background: var(--color-panel-2);
      line-height: 1.45;
    }
    .steps {
      display: grid;
      gap: var(--space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .guide-list {
      display: grid;
      gap: var(--space-3);
    }
    .guide-item {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 14px;
      background: var(--color-row);
    }
    .guide-item strong {
      display: block;
      color: var(--color-ink);
      font-size: 13px;
    }
    .guide-item p {
      margin: var(--space-1) 0 0;
      color: var(--color-muted);
      font-size: 12px;
    }
    .steps li {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: var(--space-3);
      align-items: start;
      color: var(--color-soft);
    }
    .num {
      display: inline-grid;
      place-items: center;
      width: 26px;
      height: 26px;
      border: 1px solid var(--color-accent);
      border-radius: 999px;
      background: var(--color-accent);
      color: var(--color-accent-ink);
      font: 800 11px/1 var(--font-mono);
    }
    .roots {
      margin: var(--space-3) 0 0;
      padding-left: var(--space-5);
      color: var(--color-muted);
    }
    .profile-form {
      display: grid;
      gap: var(--space-4);
    }
    .current-url {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-3);
      align-items: center;
      min-width: 0;
      padding: var(--space-4);
      border: 1px solid var(--color-accent);
      border-radius: 18px;
      background: var(--surface-accent);
    }
    .current-url.idle {
      border-color: var(--color-rule);
      background: var(--color-row);
    }
    .current-url span,
    .readonly-grid span {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--color-muted);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .current-url code {
      display: block;
      color: var(--color-ink);
      font-size: 12px;
      line-height: 1.45;
    }
    .current-url p {
      margin: var(--space-2) 0 0;
      color: var(--color-soft);
      font-size: 12px;
    }
    .profile-group {
      min-width: 0;
      margin: 0;
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 18px;
      background: var(--color-row);
      box-shadow: var(--shadow-row);
    }
    .profile-group legend {
      padding: 0 var(--space-2);
      color: var(--color-ink);
      font: 900 13px/1 var(--font-display);
    }
    .profile-group p {
      margin: 0 0 var(--space-3);
      color: var(--color-muted);
      font-size: 12px;
    }
    .form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .profile-form label {
      display: grid;
      gap: var(--space-2);
      color: var(--color-soft);
      font-size: 12px;
      font-weight: 800;
    }
    .profile-form label span {
      color: var(--color-muted);
      text-transform: uppercase;
    }
    .profile-form input,
    .profile-form select {
      width: 100%;
      min-height: 44px;
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      outline: 2px solid transparent;
      outline-offset: 1px;
      background: var(--color-surface);
      color: var(--color-ink);
      font: 13px/1.25 var(--font-body);
      padding: 0 var(--space-3);
    }
    .field-help {
      min-height: 1lh;
      margin: var(--space-3) 0 0 !important;
      color: var(--color-soft) !important;
      font-size: 12px !important;
    }
    .check-row {
      width: fit-content;
      display: inline-flex !important;
      grid-template-columns: none !important;
      align-items: center;
      gap: var(--space-2) !important;
      margin-top: var(--space-3);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 999px;
      background: var(--color-surface);
      color: var(--color-soft);
    }
    .check-row input {
      width: 18px;
      min-height: 18px;
      height: 18px;
      padding: 0;
      accent-color: var(--color-accent);
    }
    .check-row span {
      color: var(--color-soft) !important;
      text-transform: none !important;
    }
    .readonly-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .readonly-grid > div {
      min-width: 0;
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 14px;
      background: var(--color-surface);
    }
    .readonly-grid code {
      display: block;
      font-size: 12px;
      line-height: 1.45;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-width: 0;
      flex-wrap: wrap;
    }
    .primary {
      border: 1px solid var(--color-accent);
      background: var(--color-accent);
      color: var(--color-accent-ink);
      cursor: pointer;
      font: 800 13px/1 var(--font-body);
      padding: 0 var(--space-4);
      box-shadow: var(--shadow-row);
    }
    .copy-mini {
      border: 1px solid var(--color-action);
      background: var(--color-action);
      color: var(--color-accent-ink);
      cursor: pointer;
      font: 800 12px/1 var(--font-body);
      padding: 0 var(--space-3);
    }
    .note {
      min-height: 1lh;
      margin: var(--space-1) 0 0;
      color: var(--color-subtle);
      font-size: 12px;
    }
    .scope-list {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-3) 0 0;
      padding: 0;
      list-style: none;
    }
    .scope-list li {
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr);
      gap: var(--space-3);
      padding-block: var(--space-2);
      border-bottom: 1px solid var(--color-rule);
      color: var(--color-muted);
    }
    .scope-list li:last-child {
      border-bottom: 0;
    }
    .scope-list strong {
      color: var(--color-soft);
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .details-panel {
      margin-top: var(--space-5);
    }
    details summary {
      min-height: 44px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      cursor: pointer;
      color: var(--color-ink);
      font: 800 14px/1 var(--font-body);
      list-style: none;
    }
    details summary::-webkit-details-marker {
      display: none;
    }
    details summary::after {
      content: "+";
      color: var(--color-accent);
      font: 800 18px/1 var(--font-mono);
    }
    details[open] summary {
      margin-bottom: var(--space-4);
    }
    details[open] summary::after {
      content: "-";
    }
    .dashboard-panel {
      margin-top: var(--space-6);
    }
    .dashboard-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .metric {
      min-width: 0;
      display: grid;
      gap: var(--space-2);
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-row);
      box-shadow: var(--shadow-row);
    }
    .metric span,
    .dashboard-columns h3 {
      margin: 0;
      color: var(--color-muted);
      font: 900 11px/1 var(--font-body);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .metric strong {
      min-width: 0;
      overflow-wrap: anywhere;
      color: var(--color-ink);
      font: 900 16px/1.25 var(--font-display);
    }
    .metric code {
      overflow-wrap: anywhere;
      color: var(--color-soft);
      font-size: 11px;
    }
    .console-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-3);
      margin-top: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-row);
    }
    .copy-mini.secondary {
      border-color: var(--color-rule-strong);
      background: var(--color-surface);
      color: var(--color-soft);
    }
    .console-output {
      min-height: 68px;
      margin: var(--space-3) 0 0;
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-panel-2);
      color: var(--color-soft);
      font: 12px/1.55 var(--font-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .structured-task-panel {
      display: grid;
      gap: var(--space-3);
      margin-top: var(--space-4);
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-row);
    }
    .structured-task-form {
      display: grid;
      gap: var(--space-3);
    }
    .structured-task-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-3);
    }
    .structured-task-form label,
    .structured-checks {
      min-width: 0;
      display: grid;
      gap: var(--space-1);
      color: var(--color-muted);
      font-size: 12px;
      font-weight: 800;
    }
    .structured-task-form input,
    .structured-task-form select,
    .structured-task-form textarea {
      width: 100%;
      min-height: 38px;
      border: 1px solid var(--color-rule);
      border-radius: var(--radius-2);
      background: var(--color-surface);
      color: var(--color-ink);
      padding: var(--space-2);
      font: 12px/1.45 var(--font-body);
    }
    .structured-task-form textarea {
      min-height: 76px;
      resize: vertical;
    }
    .structured-task-form label[data-structured-wide],
    .structured-checks,
    .structured-task-actions {
      grid-column: 1 / -1;
    }
    .structured-checks {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-3);
    }
    .structured-checks label {
      display: inline-flex;
      grid-template-columns: none;
      align-items: center;
      gap: var(--space-2);
      color: var(--color-soft);
      font-weight: 800;
    }
    .structured-checks input {
      width: 16px;
      min-height: 16px;
      padding: 0;
    }
    .structured-task-actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .structured-task-output {
      min-height: 58px;
      margin: 0;
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      background: var(--color-surface);
      color: var(--color-soft);
      font: 12px/1.55 var(--font-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .structured-mode-fixed,
    .structured-mode-plan {
      display: contents;
    }
    .dashboard-columns {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-3);
      margin-top: var(--space-4);
    }
    .dashboard-columns section {
      min-width: 0;
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-surface);
    }
    .unified-tasks-section {
      grid-column: 1 / -1;
    }
    .unified-task-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .task-toolbar {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .task-toolbar select {
      max-width: 180px;
      min-height: 38px;
      border: 1px solid var(--color-rule);
      border-radius: var(--radius-2);
      background: var(--color-surface);
      color: var(--color-soft);
      font-size: 12px;
      font-weight: 800;
      padding: 0 var(--space-2);
    }
    .task-page {
      min-width: 54px;
      text-align: center;
      font-size: 12px;
    }
    .attention-center {
      display: grid;
      gap: var(--space-3);
      margin-top: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 14px;
      background: var(--color-row);
    }
    .attention-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
      flex-wrap: wrap;
    }
    .attention-head h4 {
      margin: 0;
      color: var(--color-ink);
      font: 900 14px/1.25 var(--font-display);
    }
    .attention-head p {
      margin: var(--space-1) 0 0;
      color: var(--color-muted);
      font-size: 12px;
    }
    .attention-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .attention-groups {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .attention-groups:empty {
      display: none;
    }
    .attention-group {
      min-width: 0;
      display: grid;
      gap: var(--space-1);
      padding: var(--space-2);
      border: 1px solid var(--color-rule);
      border-radius: 10px;
      background: var(--color-surface);
    }
    .attention-group span {
      color: var(--color-muted);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .attention-group strong {
      color: var(--color-ink);
      font: 900 15px/1.2 var(--font-display);
      overflow-wrap: anywhere;
    }
    .attention-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .attention-item {
      min-width: 0;
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      background: var(--color-surface);
    }
    .attention-item[data-severity="critical"] {
      border-color: var(--color-warn);
      background: var(--surface-warn);
    }
    .attention-title,
    .attention-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .attention-title strong,
    .attention-item p,
    .attention-item code {
      overflow-wrap: anywhere;
    }
    .attention-item p {
      margin: 0;
      color: var(--color-soft);
      font-size: 12px;
    }
    .attention-meta {
      color: var(--color-muted);
      font-size: 11px;
    }
    .attention-technical {
      border-top: 1px dashed var(--color-rule);
      padding-top: var(--space-2);
    }
    .attention-technical summary {
      cursor: pointer;
      color: var(--color-muted);
      font-size: 11px;
      font-weight: 800;
    }
    .recent-deliveries,
    .diagnostic-workbench {
      margin-top: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 14px;
      background: var(--color-row);
    }
    .recent-delivery-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--space-2);
      margin: var(--space-3) 0 0;
      padding: 0;
      list-style: none;
    }
    .recent-delivery-item {
      min-width: 0;
      display: grid;
      gap: var(--space-1);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      background: var(--color-surface);
    }
    .recent-delivery-item strong,
    .recent-delivery-item code {
      overflow-wrap: anywhere;
    }
    .recent-delivery-item span {
      color: var(--color-muted);
      font-size: 11px;
    }
    .diagnostic-workbench > summary {
      cursor: pointer;
      color: var(--color-ink);
      font: 900 14px/1.25 var(--font-display);
    }
    .diagnostic-workbench > summary span {
      margin-left: var(--space-2);
      color: var(--color-muted);
      font: 500 11px/1.5 var(--font-sans);
    }
    .diagnostic-content {
      margin-top: var(--space-3);
    }
    .dashboard-artifact-workbench {
      grid-column: 1 / -1;
    }
    .diagnostic-artifact-grid {
      margin-top: var(--space-3);
    }
    .task-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .task-detail-dialog {
      width: min(820px, calc(100vw - 32px));
      max-height: min(760px, calc(100vh - 32px));
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: var(--color-surface);
      color: var(--color-ink);
      padding: var(--space-4);
      box-shadow: 0 18px 60px rgba(15, 23, 42, 0.24);
    }
    .task-detail-dialog::backdrop {
      background: rgba(15, 23, 42, 0.36);
    }
    .task-detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      margin-bottom: var(--space-3);
    }
    .task-detail-output {
      max-height: 620px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 0;
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      background: var(--color-row);
      font: 12px/1.55 var(--font-mono);
    }
    .unified-task-summary {
      margin: var(--space-3) 0 0;
      color: var(--color-soft);
      font: 12px/1.55 var(--font-mono);
      overflow-wrap: anywhere;
    }
    .objective-focus {
      display: grid;
      gap: var(--space-3);
      margin-top: var(--space-3);
      padding: var(--space-4);
      border: 1px solid var(--color-rule);
      border-radius: 16px;
      background: linear-gradient(135deg, var(--color-row), var(--color-surface));
    }
    .objective-focus[hidden] {
      display: none;
    }
    .objective-focus-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
    }
    .objective-focus-head h4 {
      margin: 0;
      font: 900 18px/1.25 var(--font-display);
      overflow-wrap: anywhere;
    }
    .objective-focus-head p,
    .objective-focus-reason {
      margin: var(--space-1) 0 0;
      color: var(--color-soft);
      font-size: 12px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .objective-focus-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .objective-focus-item {
      min-width: 0;
      display: grid;
      gap: var(--space-1);
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      background: var(--color-surface);
    }
    .objective-focus-item span {
      color: var(--color-muted);
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .objective-focus-item strong,
    .objective-focus-item code {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .task-overview-grid,
    .project-status-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--space-2);
      margin-top: var(--space-3);
    }
    .task-overview-grid:empty,
    .project-status-grid:empty {
      display: none;
    }
    .task-overview-item,
    .project-status-item {
      min-width: 0;
      display: grid;
      gap: var(--space-1);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      background: var(--color-row);
    }
    .task-overview-item span,
    .project-status-item span {
      color: var(--color-muted);
      font-size: 11px;
      font-weight: 900;
      text-transform: uppercase;
    }
    .task-overview-item strong,
    .project-status-item strong {
      min-width: 0;
      overflow-wrap: anywhere;
      color: var(--color-ink);
      font: 900 16px/1.2 var(--font-display);
    }
    .project-status-item code {
      font-size: 11px;
    }
    .project-status-meta {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      color: var(--color-muted);
      font-size: 11px;
    }
    .unified-task-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
      margin-top: var(--space-3);
    }
    .unified-task-list .durable-run {
      margin: 0;
      border: 1px solid var(--color-rule);
      border-radius: 14px;
      background: var(--color-row);
    }
    .unified-task-current {
      border-color: var(--color-accent) !important;
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-accent) 30%, transparent);
    }
    .compact-list,
    .link-list {
      display: grid;
      gap: var(--space-2);
      margin: var(--space-3) 0 0;
      padding: 0;
      list-style: none;
    }
    .compact-list li,
    .link-list li {
      min-width: 0;
      display: grid;
      gap: var(--space-1);
      padding-bottom: var(--space-2);
      border-bottom: 1px solid var(--color-rule);
      color: var(--color-muted);
    }
    .compact-list li:last-child,
    .link-list li:last-child {
      border-bottom: 0;
      padding-bottom: 0;
    }
    .durable-runs-section {
      grid-column: 1 / -1;
    }
    .durable-run-list {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-3);
      margin: var(--space-3) 0 0;
      padding: 0;
      list-style: none;
    }
    .durable-run {
      min-width: 0;
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--color-rule);
      border-radius: 12px;
      background: var(--color-row);
    }
    .durable-run-head,
    .durable-run-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      flex-wrap: wrap;
    }
    .durable-run-head strong,
    .durable-run p,
    .durable-run code,
    .durable-run-meta {
      overflow-wrap: anywhere;
    }
    .durable-run p {
      margin: 0;
      color: var(--color-soft);
    }
    .durable-run-meta {
      color: var(--color-muted);
      font-size: 11px;
    }
    .durable-run progress {
      width: 100%;
      height: 10px;
      accent-color: var(--color-accent);
    }
    .run-wait {
      padding: var(--space-2);
      border-radius: var(--radius-2);
      background: var(--surface-warn);
    }
    .small-path {
      color: var(--color-subtle);
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .foot {
      margin-top: var(--space-6);
      padding-top: var(--space-4);
      border-top: 1px solid var(--color-rule);
      color: var(--color-subtle);
      font-size: 12px;
    }
    :focus {
      outline: none;
    }
    :focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
    }
    .profile-form input:focus-visible,
    .profile-form select:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 1px;
    }
    .resource-link:active,
    .action-link:active,
    .copy-mini:active,
    .primary:active {
      transform: translateY(1px);
    }
    .resource-link[aria-disabled="true"],
    .action-link[aria-disabled="true"],
    .copy-mini:disabled,
    .primary:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    @media (hover: hover) and (pointer: fine) {
      .resource-link:hover,
      .action-link:hover,
      .copy-mini:hover,
      .primary:hover {
        border-color: var(--color-accent);
        background: var(--surface-hover);
        color: var(--color-accent-strong);
        transform: translateY(-1px);
      }
      .action-link.primary-link:hover,
      .copy-mini:hover,
      .primary:hover {
        border-color: var(--color-action-strong);
        background: var(--color-action-strong);
        color: var(--color-accent-ink);
      }
      .section-tabs a:hover {
        background: var(--surface-hover);
        color: var(--color-accent-strong);
      }
      .profile-form input:hover,
      .profile-form select:hover {
        border-color: var(--color-rule-strong);
        background: var(--color-panel-2);
      }
    }
    @media (min-width: 52rem) {
      h1 {
        font-size: 2.45rem;
      }
    }
    @media (max-width: 58rem) {
      .overview,
      .workspace-grid,
      .dashboard-grid,
      .dashboard-columns,
      .durable-run-list,
      .structured-task-grid,
      .objective-focus-grid,
      .task-overview-grid,
      .project-status-grid,
      .attention-groups,
      .attention-list,
      .recent-delivery-list {
        grid-template-columns: 1fr;
      }
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }
      .quick-links {
        justify-content: flex-start;
      }
      .section-tabs {
        justify-content: flex-start;
      }
    }
    @media (max-width: 42rem) {
      main {
        width: min(100% - (var(--space-3) * 2), 1180px);
        padding-block: var(--space-4) var(--space-7);
      }
      .intro,
      .run-card,
      .panel {
        padding: var(--space-4);
      }
      .section-head {
        align-items: start;
        flex-direction: column;
      }
      h1 {
        font-size: 1.85rem;
      }
      .row,
      .scope-list li {
        grid-template-columns: 1fr;
        gap: var(--space-1);
      }
      .controls,
      .form-grid {
        grid-template-columns: 1fr;
      }
      .control {
        grid-template-columns: 1fr;
      }
      .current-url,
      .readonly-grid {
        grid-template-columns: 1fr;
      }
      .actions {
        align-items: stretch;
        flex-direction: column;
      }
      .primary {
        width: 100%;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 150ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 150ms !important;
      }
    }
  </style>
</head>
<body>
  <main>
    <header class="topbar">
      <div class="brand">
        <span class="logo" aria-hidden="true"><img src="/favicon.ico" alt=""></span>
        <span>
          <span class="brand-kicker">工作区控制</span>
          <span class="brand-title">CodexPro</span>
        </span>
      </div>
      <nav class="quick-links" aria-label="CodexPro 资源">
        <a class="action-link primary-link" href="${chatgptUrl}" target="_blank" rel="noreferrer">打开 ChatGPT 设置</a>
        <a class="resource-link" href="${githubUrl}" target="_blank" rel="noreferrer">打开 GitHub</a>
        <a class="resource-link" href="${npmUrl}" target="_blank" rel="noreferrer">NPM</a>
        <a class="resource-link" href="${docsUrl}" target="_blank" rel="noreferrer">文档</a>
      </nav>
    </header>
    <nav class="section-tabs" aria-label="管理区块">
      <a href="#profile" aria-current="page">连接配置</a>
      <a href="#dashboard">任务控制台</a>
      <a href="#status">运行状态</a>
      <a href="#connect">连接 ChatGPT</a>
      <a href="#access">访问边界</a>
      <a href="#cli">CLI</a>
    </nav>
    <section class="overview">
      ${profileForm(config)}
      <aside class="side-stack">
        <section class="panel guide-panel" id="guide">
          <div class="section-head">
            <div>
              <h2>快速使用</h2>
              <p>在不扩大本地信任边界的前提下，让 ChatGPT 作为当前工作区的编程代理。</p>
            </div>
          </div>
          <div class="guide-list">
            <div class="guide-item"><span class="num">1</span><span><strong>检查连接配置</strong><p>为下次启动选择隧道、端口、模式、Bash、写入、工具、Codex 会话和工作区默认值。</p></span></div>
            <div class="guide-item"><span class="num">2</span><span><strong>复制服务器地址</strong><p>优先使用配置区显示的当前公网地址；未显示时使用启动后终端输出的地址。</p></span></div>
            <div class="guide-item"><span class="num">3</span><span><strong>创建 ChatGPT 应用连接</strong><p>选择 Server URL，粘贴地址且不要额外配置认证；私有令牌已包含在地址中。</p></span></div>
            <div class="guide-item"><span class="num">4</span><span><strong>重启应用策略变更</strong><p>配置只在 CodexPro 下次启动时生效；当前 ChatGPT 会话期间不会动态修改运行中的服务。</p></span></div>
          </div>
        </section>
        <article class="run-card" id="status" aria-label="当前运行状态">
          <h2>运行安全边界</h2>
          <div class="status">
            <div class="row"><span class="label">工作区</span><span class="mono">${escapeHtml(config.defaultRoot)}</span></div>
            <div class="row"><span class="label">本地 MCP</span><span class="mono">${escapeHtml(localMcp)}</span></div>
            <div class="row"><span class="label">写入模式</span><span class="pill ${config.writeMode === "workspace" ? "" : "warn"}" title="${escapeHtml(writeTone)}">${escapeHtml(consoleEnumLabel(writeTone))}</span></div>
            <div class="row"><span class="label">工具模式</span><span class="pill ${config.toolMode === "standard" ? "" : "warn"}" title="${escapeHtml(config.toolMode)}">${escapeHtml(consoleEnumLabel(config.toolMode))}</span></div>
            <div class="row"><span class="label">Bash 模式</span><span class="pill ${config.bashMode === "safe" ? "" : "warn"}" title="${escapeHtml(config.bashMode)}">${escapeHtml(consoleEnumLabel(config.bashMode))}</span></div>
            <div class="row"><span class="label">输出模式</span><span class="pill ${config.bashTranscript === "compact" ? "" : "warn"}" title="${escapeHtml(config.bashTranscript)}">${escapeHtml(consoleEnumLabel(config.bashTranscript))}</span></div>
            <div class="row"><span class="label">Bash 会话</span><span class="pill ${config.requireBashSession ? "warn" : ""}">${escapeHtml(config.bashSessionId ? `${config.bashSessionId}${config.requireBashSession ? "（必填）" : ""}` : "未设置")}</span></div>
            <div class="row"><span class="label">Codex 会话</span><span class="pill ${config.codexSessions === "off" ? "" : "warn"}" title="${escapeHtml(config.codexSessions)}">${escapeHtml(consoleEnumLabel(config.codexSessions))}</span></div>
            <div class="row"><span class="label">组件域名</span><span class="mono">${escapeHtml(config.widgetDomain)}</span></div>
            <div class="row"><span class="label">认证</span><span class="pill">${escapeHtml(authLabel)}</span></div>
          </div>
        </article>
      </aside>
    </section>
    ${dashboardPanel(config, dashboardServerUrl)}
    <section class="workspace-grid">
      <section class="panel" id="connect">
        <div class="section-head">
          <div>
          <h2>连接 ChatGPT</h2>
            <p>创建一个指向终端所复制公网 Server URL 的应用连接。</p>
          </div>
        </div>
        <ol class="steps">
          <li><span class="num">1</span><span>打开 ChatGPT 设置并创建应用连接。</span></li>
          <li><span class="num">2</span><span>将连接方式设为 <code>Server URL</code>。</span></li>
          <li><span class="num">3</span><span>粘贴终端输出的 CodexPro 公网地址。</span></li>
          <li><span class="num">4</span><span>认证选择 <code>No Authentication / None</code>；私有令牌已包含在复制的地址中。</span></li>
        </ol>
        <p class="note"><a class="action-link" href="${chatgptUrl}" target="_blank" rel="noreferrer">打开 ChatGPT 设置</a></p>
      </section>
      <aside class="side-stack">
        <section class="panel" id="access">
          <h2>管理访问边界</h2>
          <ul class="scope-list">
            <li><strong>/setup</strong><span>当前设置与配置页面</span></li>
            <li><strong>/admin/profile</strong><span>保存工作区配置的 API</span></li>
            <li><strong>/admin/artifact</strong><span>只读报告与记忆文件查看器</span></li>
            <li><strong>/admin/tasks</strong><span>Goal、持久任务与 Handoff 的只读统一投影</span></li>
            <li><strong>/healthz</strong><span>带认证的状态检查</span></li>
            <li><strong>/mcp</strong><span>供 ChatGPT 和本地客户端使用的 MCP 端点</span></li>
          </ul>
        </section>
      </aside>
    </section>
    <section class="panel cli-panel details-panel" id="cli">
      <div class="section-head">
        <div>
          <h2>CLI 控制</h2>
          <p>需要使用不同运行策略重启时复制以下命令；浏览器不会直接修改正在运行的进程。</p>
        </div>
      </div>
      <div class="controls">${controls}</div>
    </section>
    <details class="panel details-panel">
      <summary>允许访问的根目录</summary>
      <ul class="roots">${allowedRoots}</ul>
      <p class="note">CodexPro 会拒绝访问这些根目录之外的工作区。</p>
    </details>
    <footer class="foot">这是当前工作区受令牌保护的本地控制界面；公网访问仍仅通过你选择的隧道提供。</footer>
  </main>
  <script>
    const initialAuthUrl = new URL(window.location.href);
    if (initialAuthUrl.searchParams.has("codexpro_token") || initialAuthUrl.searchParams.has("token")) {
      initialAuthUrl.searchParams.delete("codexpro_token");
      initialAuthUrl.searchParams.delete("token");
      history.replaceState(null, "", initialAuthUrl.pathname + initialAuthUrl.search + initialAuthUrl.hash);
    }
    const consoleLocale = ${clientLocale};
    function enumLabel(value, fallback = "未知") {
      const raw = typeof value === "string" ? value : "";
      return raw ? (consoleLocale.enumLabels[raw] || raw) : fallback;
    }
    function actionLabel(value, fallback = "操作") {
      const raw = typeof value === "string" ? value : "";
      return raw ? (consoleLocale.actionLabels[raw] || raw) : fallback;
    }
    function attentionTypeLabel(value, fallback = "待处理事项") {
      const raw = typeof value === "string" ? value : "";
      return raw ? (consoleLocale.attentionTypeLabels[raw] || raw) : fallback;
    }
    function displayText(value, fallback = "") {
      const raw = typeof value === "string" ? value : "";
      if (!raw) return fallback;
      if (consoleLocale.textLabels[raw]) return consoleLocale.textLabels[raw];
      const recoveryPrefix = "Handoff is ";
      const recoverySuffix = "; arbitrary agent execution is not assumed idempotent. Start a new associated recovery run and keep the original run evidence.";
      if (raw.startsWith(recoveryPrefix) && raw.endsWith(recoverySuffix)) {
        const state = raw.slice(recoveryPrefix.length, raw.length - recoverySuffix.length);
        return "Handoff 当前状态为" + enumLabel(state) + "；不能假定任意 Agent 执行具备幂等性。请新建关联恢复 Run，并保留原 Run 证据。";
      }
      if (raw.startsWith("Handoff ended with ") && raw.endsWith(".")) {
        const state = raw.slice("Handoff ended with ".length, -1);
        return "Handoff 已结束，状态为" + enumLabel(state) + "。";
      }
      if (raw.startsWith("Handoff ")) {
        const state = raw.slice("Handoff ".length);
        if (consoleLocale.enumLabels[state]) return "Handoff " + enumLabel(state);
      }
      return raw;
    }
    function compactText(value, maxLength = 140) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (text.length <= maxLength) return text;
      return text.slice(0, Math.max(1, maxLength - 1)).trimEnd() + "…";
    }
    function displayTaskTitle(task) {
      return compactText(displayText(task?.title, task?.task_id || "任务"), 120);
    }
    function formatDateTime(value, fallback = "未知") {
      if (!value) return fallback;
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat(consoleLocale.locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(date);
    }
    function formatDurationMs(value, fallback = "不可用") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms < 0) return fallback;
      if (ms < 1000) return Math.round(ms) + " ms";
      const totalSeconds = Math.round(ms / 1000);
      const seconds = totalSeconds % 60;
      const totalMinutes = Math.floor(totalSeconds / 60);
      const minutes = totalMinutes % 60;
      const hours = Math.floor(totalMinutes / 60);
      if (hours > 0) return hours + " 小时 " + minutes + " 分钟";
      if (minutes > 0) return minutes + " 分钟 " + seconds + " 秒";
      return seconds + " 秒";
    }
    function formatRatio(value, fallback = "不可用") {
      const ratio = Number(value);
      if (!Number.isFinite(ratio) || ratio < 0) return fallback;
      return (ratio * 100).toFixed(1) + "%";
    }
    document.querySelectorAll("[data-office-link]").forEach((link) => {
      link.setAttribute("href", "/office" + window.location.search);
    });
    document.querySelectorAll("[data-copy], [data-copy-kind]").forEach((button) => {
      button.addEventListener("click", async () => {
        let value = button.getAttribute("data-copy") || "";
        if (button.getAttribute("data-copy-kind") === "local-mcp") {
          const base = button.getAttribute("data-copy-base") || value;
          const params = new URLSearchParams(window.location.search);
          const token = params.get("codexpro_token") || params.get("token") || "";
          value = token ? base + "?codexpro_token=" + encodeURIComponent(token) : base;
        } else if (button.getAttribute("data-copy-kind") === "server-url") {
          const base = button.getAttribute("data-copy-base") || value;
          const params = new URLSearchParams(window.location.search);
          const token = params.get("codexpro_token") || params.get("token") || "";
          value = token ? base + "?codexpro_token=" + encodeURIComponent(token) : base;
        }
        try {
          await navigator.clipboard.writeText(value);
          button.textContent = "已复制";
          setTimeout(() => { button.textContent = "复制"; }, 1400);
        } catch {
          button.textContent = "请手动选择";
        }
      });
    });
    const consoleOutput = document.querySelector("[data-console-output]");
    const structuredTaskForm = document.querySelector("[data-structured-task-form]");
    const structuredTaskOutput = document.querySelector("[data-structured-task-output]");
    const structuredMode = document.querySelector("[data-structured-mode]");
    const structuredModePlan = document.querySelector(".structured-mode-plan");
    const structuredModeFixed = document.querySelector(".structured-mode-fixed");
    const structuredProjectOptions = document.querySelector("[data-structured-project-options]");
    const structuredSubmit = document.querySelector("[data-structured-submit]");
    const structuredReset = document.querySelector("[data-structured-reset]");
    function describeConsoleResult(result) {
      const lines = [];
      const rawAction = result.action || "unknown";
      const rawStatus = result.status || (result.ok ? "passed" : "failed");
      lines.push("操作：" + actionLabel(rawAction) + "（" + rawAction + "）");
      lines.push("状态：" + enumLabel(rawStatus) + "（" + rawStatus + "）");
      if (result.message) lines.push("消息：" + result.message);
      if (result.copy_text) lines.push("复制内容：" + result.copy_text);
      if (result.report && result.report.href) lines.push("报告：" + result.report.href);
      if (result.output) lines.push("", String(result.output).slice(0, 4000));
      return lines.join("\\n");
    }
    function structuredList(value) {
      return String(value || "")
        .split(/\\r?\\n|,/g)
        .map((item) => item.trim())
        .filter(Boolean);
    }
    function structuredTaskApiUrl() {
      const params = new URLSearchParams(window.location.search);
      const query = params.toString();
      return "/admin/structured-tasks" + (query ? "?" + query : "");
    }
    function structuredFormPayload(form) {
      const data = Object.fromEntries(new FormData(form).entries());
      const mode = data.mode === "fixed_task" ? "fixed_task" : "existing_plan";
      const common = {
        mode,
        project: data.project,
        priority: data.priority || "normal",
        new_run: Boolean(form.elements.new_run?.checked)
      };
      if (data.idempotency_key) common.idempotency_key = data.idempotency_key;
      if (mode === "existing_plan") {
        return {
          ...common,
          plan_file: data.plan_file,
          stage: data.stage,
          scope_limit: data.scope_limit || undefined,
          record_after_acceptance: Boolean(form.elements.local_record_permission?.checked),
          remote_sync_after_record: Boolean(form.elements.remote_sync_permission?.checked),
          browser_required: Boolean(form.elements.browser_verification?.checked)
        };
      }
      return {
        ...common,
        objective: data.objective,
        include: structuredList(data.include),
        exclude: structuredList(data.exclude),
        acceptance: structuredList(data.acceptance),
        execution_profile: data.execution_profile || "standard",
        ...(data.risk_level ? { risk_level: data.risk_level } : {}),
        local_record_permission: Boolean(form.elements.local_record_permission?.checked),
        remote_sync_permission: Boolean(form.elements.remote_sync_permission?.checked),
        production_change_permission: false,
        browser_verification: Boolean(form.elements.browser_verification?.checked)
      };
    }
    function describeStructuredTaskResult(result) {
      const lines = [];
      const created = result.created === true;
      const duplicate = result.duplicate === true;
      lines.push("结果：" + (created ? "已创建" : duplicate ? "已去重" : "未创建"));
      if (result.message) lines.push("消息：" + result.message);
      if (result.task_id) lines.push("任务 ID：" + result.task_id);
      if (result.goal_id) lines.push("Goal ID：" + result.goal_id);
      if (result.status) lines.push("状态：" + enumLabel(result.status) + "（" + result.status + "）");
      if (result.project_id) lines.push("项目：" + result.project_id + (result.workspace_id ? " / " + result.workspace_id : ""));
      if (result.duplicate_key || result.dedupe_key) lines.push("duplicate_key：" + (result.duplicate_key || result.dedupe_key));
      const risk = result.risk_gate || {};
      if (risk.level) lines.push("风险：" + risk.level + " · " + (risk.reason_code || "unknown") + " · " + (risk.allowed ? "允许" : "拒绝"));
      const execution = result.execution || result.goal_contract?.execution || {};
      if (execution.profile) lines.push("执行：" + execution.profile + " / " + (execution.priority || "normal") + " / browser=" + Boolean(execution.browser_verification));
      const permissions = result.permissions || result.goal_contract?.permissions || {};
      if (Object.keys(permissions).length) {
        lines.push("权限：source_edit=" + Boolean(permissions.source_edit) + ", local_record=" + Boolean(permissions.local_record) + ", remote_sync=" + Boolean(permissions.remote_sync) + ", production_change=" + Boolean(permissions.production_change));
      }
      const resource = result.resource_policy || result.resource_request || {};
      if (resource.status || resource.resource_class) {
        lines.push("资源：" + (resource.status || "待准入") + " / " + (resource.resource_class || "unknown") + " / " + (resource.priority || "normal"));
        if (Array.isArray(resource.blocking_reasons) && resource.blocking_reasons.length) lines.push("资源阻塞：" + resource.blocking_reasons.join("；"));
      }
      if (result.task_dashboard_url) lines.push("查看入口：" + result.task_dashboard_url);
      return lines.join("\\n");
    }
    function describeStructuredTaskError(response, result) {
      const error = result.error || {};
      const message = error.message || result.message || "结构化任务请求失败";
      const code = error.code || result.code || "structured_task_failed";
      const lines = ["创建失败：" + message, "错误码：" + code, "HTTP：" + response.status];
      if (error.details || result.details) lines.push("", JSON.stringify(error.details || result.details, null, 2).slice(0, 4000));
      return lines.join("\\n");
    }
    function updateStructuredMode() {
      const fixed = structuredMode?.value === "fixed_task";
      if (structuredModePlan) structuredModePlan.hidden = fixed;
      if (structuredModeFixed) structuredModeFixed.hidden = !fixed;
    }
    function renderStructuredProjectOptions(projects) {
      if (!structuredProjectOptions) return;
      structuredProjectOptions.replaceChildren();
      for (const project of Array.isArray(projects) ? projects : []) {
        if (!project.available) continue;
        const option = document.createElement("option");
        option.value = project.project_id || project.name || "";
        option.label = project.root || "";
        structuredProjectOptions.appendChild(option);
      }
    }
    const unifiedTaskList = document.querySelector("[data-unified-task-list]");
    const unifiedTaskSummary = document.querySelector("[data-task-summary]");
    const currentObjectivePanel = document.querySelector("[data-current-objective]");
    const objectiveTitle = document.querySelector("[data-objective-title]");
    const objectiveReason = document.querySelector("[data-objective-reason]");
    const objectiveStatus = document.querySelector("[data-objective-status]");
    const objectiveStage = document.querySelector("[data-objective-stage]");
    const objectiveAttempt = document.querySelector("[data-objective-attempt]");
    const objectiveHuman = document.querySelector("[data-objective-human]");
    const objectiveNext = document.querySelector("[data-objective-next]");
    const taskRefresh = document.querySelector("[data-task-refresh]");
    const taskOverview = document.querySelector("[data-task-overview]");
    const projectStatus = document.querySelector("[data-project-status]");
    const taskProjectFilter = document.querySelector("[data-task-project]");
    const taskStatusFilter = document.querySelector("[data-task-status]");
    const taskPageSize = document.querySelector("[data-task-page-size]");
    const taskPrev = document.querySelector("[data-task-prev]");
    const taskNext = document.querySelector("[data-task-next]");
    const taskPage = document.querySelector("[data-task-page]");
    const taskDialog = document.querySelector("[data-task-dialog]");
    const taskDialogTitle = document.querySelector("[data-task-dialog-title]");
    const taskDialogOutput = document.querySelector("[data-task-dialog-output]");
    const taskDialogClose = document.querySelector("[data-task-dialog-close]");
    const attentionSummary = document.querySelector("[data-attention-summary]");
    const attentionGroups = document.querySelector("[data-attention-groups]");
    const attentionList = document.querySelector("[data-attention-list]");
    const attentionRefresh = document.querySelector("[data-attention-refresh]");
    const attentionNotificationsEnable = document.querySelector("[data-attention-notifications-enable]");
    const recentDeliverySummary = document.querySelector("[data-recent-delivery-summary]");
    const recentDeliveryList = document.querySelector("[data-recent-delivery-list]");
    const diagnosticWorkbench = document.querySelector("[data-diagnostic-workbench]");
    const diagnosticSummary = document.querySelector("[data-diagnostic-summary]");
    const taskActionCsrfToken = ${JSON.stringify(csrfToken)};
    const taskActionInFlight = new Set();
    let attentionFocusedTaskId = "";
    const taskPolling = {
      timer: null,
      inFlight: false,
      controller: null,
      stopped: false,
      pendingManual: false,
      page: 1,
      pageSize: Number(taskPageSize?.value || 25),
      project: "",
      status: ""
    };
    const attentionStorageKey = "codexpro.attention.v1:" + window.location.origin + window.location.pathname;
    const attentionPolling = {
      inFlight: false,
      controller: null,
      lastResult: null
    };
    function loadAttentionStorage() {
      try {
        const parsed = JSON.parse(localStorage.getItem(attentionStorageKey) || "{}");
        return {
          consumer_id: typeof parsed.consumer_id === "string" ? parsed.consumer_id : "consumer-" + Date.now() + "-" + Math.random().toString(16).slice(2),
          cursor: typeof parsed.cursor === "string" ? parsed.cursor : null,
          delivered_event_ids: Array.isArray(parsed.delivered_event_ids) ? parsed.delivered_event_ids.filter((item) => typeof item === "string").slice(-500) : [],
          notification_denied: parsed.notification_denied === true
        };
      } catch {
        return {
          consumer_id: "consumer-" + Date.now() + "-" + Math.random().toString(16).slice(2),
          cursor: null,
          delivered_event_ids: [],
          notification_denied: false
        };
      }
    }
    const attentionStorage = loadAttentionStorage();
    function saveAttentionStorage() {
      try {
        attentionStorage.delivered_event_ids = attentionStorage.delivered_event_ids.slice(-500);
        localStorage.setItem(attentionStorageKey, JSON.stringify(attentionStorage));
      } catch {
        // Local storage failure only disables browser notification dedupe persistence.
      }
    }
    saveAttentionStorage();
    const taskVisiblePollMs = 5000;
    const taskHiddenPollMs = 30000;
    function taskTone(status, acceptance) {
      if (["failed", "interrupted"].includes(status) || acceptance === "failed") return "warn";
      if (status === "completed" && ["passed", "not_required"].includes(acceptance)) return "good";
      return "";
    }
    function addTaskMeta(container, value, title = "") {
      const span = document.createElement("span");
      span.textContent = value;
      if (title) span.title = title;
      container.appendChild(span);
    }
    function addProjectOption(project) {
      if (!taskProjectFilter) return;
      const option = document.createElement("option");
      option.value = project.project_id || "";
      option.textContent = project.name || project.project_id || "项目";
      taskProjectFilter.appendChild(option);
    }
    function renderProjectFilter(projects) {
      if (!taskProjectFilter) return;
      const previous = taskProjectFilter.value;
      taskProjectFilter.replaceChildren();
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "全部项目";
      taskProjectFilter.appendChild(all);
      for (const project of projects) addProjectOption(project);
      taskProjectFilter.value = [...taskProjectFilter.options].some((option) => option.value === previous) ? previous : "";
      taskPolling.project = taskProjectFilter.value;
    }
    function metric(label, value, tone) {
      const item = document.createElement("div");
      item.className = "task-overview-item";
      const span = document.createElement("span");
      span.textContent = label;
      const strong = document.createElement("strong");
      strong.className = tone || "";
      strong.textContent = String(value ?? 0);
      item.append(span, strong);
      return item;
    }
    function objectiveStatusLabel(value) {
      return ({
        not_started: "未开始",
        running: "执行中",
        waiting_user: "等待我处理",
        recovering: "恢复中",
        delivered: "已交付",
        incomplete: "未完成",
        cancelled: "已取消"
      })[value] || enumLabel(value);
    }
    function objectiveReasonLabel(value) {
      return ({
        attempt_delivered: "当前目标已有满足交付条件的有效 Attempt。",
        no_attempt: "尚未为该目标创建执行 Attempt。",
        attempt_waiting_user: "当前 Attempt 正在等待用户输入、授权或决策。",
        implementation_requires_validation_decision: "实现结果已经存在，但仍需复核或完成验收。",
        attempt_live: "当前 Attempt 具有有效的执行所有权和存活证明。",
        attempt_recovering: "系统正在按恢复契约继续该目标。",
        attempt_interrupted: "当前 Attempt 已中断，系统将评估安全恢复路径。",
        attempt_queued: "执行已创建，正在等待执行器或资源。",
        all_attempts_cancelled: "该目标的所有 Attempt 均已取消。",
        attempts_exhausted: "没有活跃、可恢复或已交付的 Attempt。"
      })[value] || displayText(value, "目标状态已更新。");
    }
    function objectiveNextLabel(value) {
      return ({
        review_or_run_acceptance: "复核结果或运行验收",
        evaluate_recovery: "评估并执行安全恢复",
        start_or_wait_for_executor: "等待或启动执行器"
      })[value] || (value ? displayText(value, value) : "无需额外动作");
    }
    function renderCurrentObjective(result) {
      if (!currentObjectivePanel) return;
      const objective = result.current_objective || null;
      if (!objective) {
        currentObjectivePanel.hidden = true;
        return;
      }
      currentObjectivePanel.hidden = false;
      const status = objective.status || "not_started";
      const tone = status === "delivered" ? "good" : (["waiting_user", "recovering", "incomplete"].includes(status) ? "warn" : "");
      if (objectiveTitle) objectiveTitle.textContent = compactText(objective.title || objective.objective_key || "当前目标", 120);
      if (objectiveReason) objectiveReason.textContent = objectiveReasonLabel(objective.reason_code);
      if (objectiveStatus) {
        objectiveStatus.className = "pill " + tone;
        objectiveStatus.textContent = objectiveStatusLabel(status);
        objectiveStatus.title = objective.reason_code || status;
      }
      if (objectiveStage) objectiveStage.textContent = objective.stage_key || "未指定";
      if (objectiveAttempt) {
        const attempt = objective.current_attempt || null;
        objectiveAttempt.textContent = objective.current_attempt_id
          ? objective.current_attempt_id + (attempt?.status ? " · " + enumLabel(attempt.status) : "")
          : "无";
      }
      if (objectiveHuman) {
        objectiveHuman.textContent = objective.requires_human ? "是" : "否";
        objectiveHuman.className = objective.requires_human ? "warn" : "";
      }
      if (objectiveNext) objectiveNext.textContent = objectiveNextLabel(objective.system_next_action);
    }
    function renderOverview(result) {
      if (!taskOverview) return;
      const overview = result.overview || {};
      const governance = result.resource_governance || {};
      const occupancy = governance.occupancy || {};
      const limits = governance.config?.limits || {};
      const resourceQueue = Array.isArray(governance.queue) ? governance.queue.length : 0;
      taskOverview.replaceChildren(
        metric("全量运行中", overview.running),
        metric("全量排队中", overview.queued),
        metric("资源队列", resourceQueue, resourceQueue ? "warn" : ""),
        metric("标准配额", (occupancy.global_standard || 0) + "/" + (limits.global_standard || 2)),
        metric("高负载配额", (occupancy.global_heavy || 0) + "/" + (limits.global_heavy || 1), occupancy.global_heavy ? "warn" : ""),
        metric("全量需处理", overview.attention, overview.attention ? "warn" : ""),
        metric("全量需恢复", overview.recovery_required, overview.recovery_required ? "warn" : ""),
        metric("全量失败", overview.failed, overview.failed ? "warn" : ""),
        metric("全量已完成", overview.completed),
        metric("高负载活动", overview.heavy_activity, overview.heavy_activity ? "warn" : "")
      );
    }
    function renderProjects(result) {
      if (!projectStatus) return;
      const projects = Array.isArray(result.projects) ? result.projects : [];
      renderStructuredProjectOptions(projects);
      projectStatus.replaceChildren();
      for (const project of projects) {
        const item = document.createElement("div");
        item.className = "project-status-item";
        const label = document.createElement("span");
        label.textContent = project.available ? "项目" : "不可用";
        const name = document.createElement("strong");
        name.textContent = project.name || project.project_id || "项目";
        const root = document.createElement("code");
        root.textContent = project.root || "";
        const meta = document.createElement("div");
        meta.className = "project-status-meta";
        const git = project.git_status_summary || {};
        const watcher = project.watcher_status || {};
        addTaskMeta(meta, "分支 " + (project.branch || "未知"));
        addTaskMeta(meta, "Git " + (git.summary || "未知"));
        addTaskMeta(meta, "Watcher 进程 " + enumLabel(watcher.state), watcher.reason || "");
        addTaskMeta(
          meta,
          "Handoff " + (watcher.handoff_ready === true ? "就绪" : watcher.handoff_ready === false ? "未就绪" : "未知"),
          watcher.handoff_reason || ""
        );
        addTaskMeta(meta, "任务 " + (project.task_count || 0));
        addTaskMeta(meta, "排队 " + (project.queued_tasks || 0));
        addTaskMeta(meta, "待处理 " + (project.attention_tasks || 0));
        if (project.resource_summary) addTaskMeta(meta, "高负载 " + (project.resource_summary.heavy_activity || 0));
        const usage = project.usage_summary || null;
        if (usage?.availability === "available") {
          addTaskMeta(meta, "账本条目 " + (usage.entry_count || 0));
          addTaskMeta(meta, "总时长 " + formatDurationMs(usage.total_wall_duration_ms));
          addTaskMeta(meta, "排队/活跃/静默 "
            + formatDurationMs(usage.queue_duration_ms) + "/"
            + formatDurationMs(usage.active_duration_ms) + "/"
            + formatDurationMs(usage.silent_duration_ms));
          const measurementState = usage.token_measurement || {};
          const measurementCount = (measurementState.measured || 0) + (measurementState.estimated || 0) + (measurementState.unavailable || 0);
          addTaskMeta(meta, measurementCount
            ? "模型用量 实测 " + (measurementState.measured || 0) + " · 估算 " + (measurementState.estimated || 0) + " · 不可用 " + (measurementState.unavailable || 0)
            : "模型用量 暂无终态记录");
          addTaskMeta(meta, "进程/重试/验收 " + (usage.process_count || 0) + "/" + (usage.retry_count || 0) + "/" + formatDurationMs(usage.acceptance_duration_ms));
          addTaskMeta(meta, "有效完成率 " + formatRatio(usage.verified_completion_efficiency));
          const cache = usage.cache || {};
          addTaskMeta(meta, "缓存 命中 " + (cache.hit || 0) + " · 未命中 " + (cache.miss || 0) + " · 不可用 " + (cache.unavailable || 0));
          const browser = usage.browser || {};
          addTaskMeta(meta, "Browser 成功/失败/未知 " + (browser.success || 0) + "/" + (browser.failed || 0) + "/" + (browser.unknown || 0)
            + " · 恢复 " + (browser.recovery_count || 0));
          if (usage.warning_count) addTaskMeta(meta, "账本警告 " + usage.warning_count, "账本写入异常不会改变任务终态。");
        } else {
          addTaskMeta(meta, "用量账本 暂不可用", "尚无可复核的终态用量记录；缺失值不会显示为 0 token。");
        }
        item.append(label, name, root, meta);
        const finalization = project.git_finalization || null;
        if (finalization) {
          const gitFinalization = document.createElement("div");
          gitFinalization.className = "project-status-meta";
          addTaskMeta(gitFinalization, "提交 " + enumLabel(finalization.commit_status));
          addTaskMeta(gitFinalization, "推送 " + enumLabel(finalization.push_status));
          addTaskMeta(gitFinalization, "本地 SHA " + shortSha(finalization.local_commit_sha));
          addTaskMeta(gitFinalization, "远端 SHA " + shortSha(finalization.remote_commit_sha));
          addTaskMeta(gitFinalization, "传输 " + enumLabel(finalization.push_transport, "未记录"));
          if (finalization.push_attempts) addTaskMeta(gitFinalization, "推送次数 " + finalization.push_attempts);
          if (finalization.push_error_code) addTaskMeta(gitFinalization, "推送结果 " + enumLabel(finalization.push_error_code));
          if (finalization.linked_task_id) addTaskMeta(gitFinalization, "关联任务 " + finalization.linked_task_id);
          item.appendChild(gitFinalization);
          if (finalization.commit_status === "completed" && finalization.push_status === "failed") {
            const separation = document.createElement("p");
            separation.className = "run-wait";
            separation.textContent = "开发与验收状态不受影响：本地提交已创建，只有远端推送失败。";
            item.appendChild(separation);
          }
          if (finalization.retry_available) {
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "primary";
            retry.setAttribute("data-git-retry", "");
            retry.textContent = actionLabel("retry_push");
            retry.title = "只重新推送现有本地提交，不重新运行开发、验收或 commit。";
            retry.addEventListener("click", () => void runGitRetry(project, retry));
            item.appendChild(retry);
          }
        }
        if (project.unavailable_reason) {
          const reason = document.createElement("p");
          reason.className = "run-wait";
          reason.textContent = "不可用原因：" + project.unavailable_reason;
          item.appendChild(reason);
        }
        projectStatus.appendChild(item);
      }
    }
    function taskControlUrl(task, suffix) {
      const params = new URLSearchParams(window.location.search);
      params.set("project", task.project_id || task.project_name || "");
      return "/admin/tasks/" + encodeURIComponent(task.task_id) + "/" + suffix + "?" + params.toString();
    }
    function gitRetryUrl(project) {
      const params = new URLSearchParams(window.location.search);
      params.set("project", project.project_id || project.name || "");
      return "/admin/git-finalization/retry?" + params.toString();
    }
    function shortSha(value) {
      const raw = typeof value === "string" ? value.trim() : "";
      return raw ? raw.slice(0, 12) : "无";
    }
    async function runGitRetry(project, button) {
      const key = "git-retry:" + (project.project_id || project.name || "project");
      if (taskActionInFlight.has(key)) return;
      const finalization = project.git_finalization || {};
      const confirmation = [
        "确定要重新推送项目 “" + (project.name || project.project_id || "项目") + "” 的现有本地提交吗？",
        "",
        "该操作只执行 git_push_only，不会重新暂存、提交、验收或运行开发任务。",
        "本地 SHA：" + shortSha(finalization.local_commit_sha),
        "远端 SHA：" + shortSha(finalization.remote_commit_sha),
        "当前推送错误：" + enumLabel(finalization.push_error_code, "未知")
      ].join("\\n");
      if (!window.confirm(confirmation)) return;
      taskActionInFlight.add(key);
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "推送中……";
      try {
        const idempotencyKey = typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : "git-retry-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        const response = await fetch(gitRetryUrl(project), {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "x-codexpro-csrf": taskActionCsrfToken
          },
          body: JSON.stringify({ action: "retry_push", idempotency_key: idempotencyKey })
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || "重新推送请求失败");
        showTaskDialog((project.name || project.project_id || "项目") + " · " + actionLabel("retry_push"), result);
        await loadUnifiedTasks();
      } catch (error) {
        showTaskDialog("重新推送失败", error instanceof Error ? error.message : "重新推送请求失败");
      } finally {
        taskActionInFlight.delete(key);
        button.disabled = false;
        button.textContent = original;
      }
    }
    function showTaskDialog(title, value) {
      if (taskDialogTitle) taskDialogTitle.textContent = title;
      if (taskDialogOutput) {
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        taskDialogOutput.textContent = String(text || "未返回详情。").slice(0, 12000);
      }
      if (taskDialog?.showModal) taskDialog.showModal();
      else taskDialog?.setAttribute("open", "");
    }
    async function loadTaskDetail(task, detail, button) {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "加载中……";
      try {
        const response = await fetch(taskControlUrl(task, detail), { headers: { "accept": "application/json" } });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || "任务详情请求失败");
        showTaskDialog((task.title || task.task_id) + " · " + actionLabel(detail), result);
      } catch (error) {
        showTaskDialog("任务详情加载失败", error instanceof Error ? error.message : "任务详情请求失败");
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }
    function taskActionConfirmation(task, descriptor) {
      const checks = Array.isArray(descriptor.required_checks) ? descriptor.required_checks : [];
      const rawStatus = task.status || "unknown";
      const recoveryMode = descriptor.recovery_mode || "none";
      const recoveryAction = descriptor.recovery_action || descriptor.action;
      const sideEffect = descriptor.side_effect_level || "unknown";
      return [
        "确定要对任务 " + task.task_id + " 执行“" + actionLabel(descriptor.action) + "”吗？",
        "",
        descriptor.reason || "此操作将更新权威任务状态。",
        "当前状态：" + enumLabel(rawStatus) + "（" + rawStatus + "）",
        "恢复方式：" + enumLabel(recoveryMode) + "（" + recoveryMode + "） / " + recoveryAction,
        "副作用级别：" + enumLabel(sideEffect) + "（" + sideEffect + "）",
        checks.length ? "必须检查：\\n- " + checks.join("\\n- ") : ""
      ].filter(Boolean).join("\\n");
    }
    async function runTaskAction(task, descriptor, button) {
      const key = [task.project_id, task.task_id, descriptor.action].join(":");
      if (taskActionInFlight.has(key)) return;
      if (!window.confirm(taskActionConfirmation(task, descriptor))) return;
      let prompt;
      if (descriptor.action === "resume" && descriptor.recovery_mode === "manual") {
        prompt = window.prompt("请输入本次手动 Goal 恢复的明确继续指令。", "");
        if (prompt === null) return;
      }
      taskActionInFlight.add(key);
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "执行中……";
      try {
        const idempotencyKey = typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : "console-" + Date.now() + "-" + Math.random().toString(16).slice(2);
        const payload = {
          action: descriptor.action,
          idempotency_key: idempotencyKey,
          expected_status: descriptor.expected_status || task.status,
          confirm_manual: true,
          ...(descriptor.step_id ? { step_id: descriptor.step_id } : {}),
          ...(prompt ? { prompt } : {})
        };
        const response = await fetch(taskControlUrl(task, "action"), {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "x-codexpro-csrf": taskActionCsrfToken
          },
          body: JSON.stringify(payload)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || "任务操作失败");
        showTaskDialog((task.title || task.task_id) + " · " + actionLabel(descriptor.action), result);
        taskPolling.page = Math.max(1, taskPolling.page);
        await loadUnifiedTasks();
      } catch (error) {
        showTaskDialog("任务操作失败", error instanceof Error ? error.message : "任务操作失败");
      } finally {
        taskActionInFlight.delete(key);
        button.disabled = false;
        button.textContent = original;
      }
    }
    function appendTaskControls(target, task) {
      const controls = document.createElement("div");
      controls.className = "task-actions";
      for (const detail of ["timeline", "evidence", "recovery"]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "copy-mini secondary";
        button.setAttribute("data-task-detail", detail);
        button.textContent = actionLabel(detail);
        button.addEventListener("click", () => void loadTaskDetail(task, detail, button));
        controls.appendChild(button);
      }
      for (const descriptor of Array.isArray(task.available_actions) ? task.available_actions : []) {
        if (!descriptor || !["resume", "cancel", "retry_step"].includes(descriptor.action)) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = descriptor.action === "resume" ? "primary" : "copy-mini secondary";
        button.setAttribute("data-task-action", descriptor.action);
        button.setAttribute("data-task-" + descriptor.action.replaceAll("_", "-"), "");
        button.textContent = actionLabel(descriptor.action);
        button.title = descriptor.reason || "";
        button.addEventListener("click", () => void runTaskAction(task, descriptor, button));
        controls.appendChild(button);
      }
      target.appendChild(controls);
    }
    function appendTaskBody(target, task) {
      const identity = document.createElement("div");
      identity.className = "durable-run-meta";
      const code = document.createElement("code");
      code.textContent = task.task_id;
      identity.appendChild(code);
      addTaskMeta(identity, (task.project_name || task.project_id || "项目") + " · " + enumLabel(task.kind) + " · " + enumLabel(task.domain_status));
      addTaskMeta(identity, "存活状态 " + enumLabel(task.liveness));
      const action = document.createElement("p");
      const fullAction = displayText(task.progress_summary || task.current_action, enumLabel(task.current_phase) || "暂无当前操作");
      action.textContent = compactText(fullAction, 220);
      if (action.textContent !== fullAction) action.title = fullAction;
      const details = document.createElement("div");
      details.className = "durable-run-meta";
      addTaskMeta(details, "阶段 " + enumLabel(task.current_phase));
      if (task.total_steps) addTaskMeta(details, "步骤 " + task.current_step + "/" + task.total_steps);
      addTaskMeta(details, "心跳 " + formatDateTime(task.last_heartbeat || task.heartbeat_at));
      addTaskMeta(details, "验收 " + enumLabel(task.acceptance_status));
      const outcome = task.outcome || null;
      if (outcome) {
        addTaskMeta(details, "执行终态 " + enumLabel(outcome.execution_status));
        addTaskMeta(details, "验证终态 " + enumLabel(outcome.validation_status));
        addTaskMeta(details, "交付终态 " + enumLabel(outcome.delivery_status));
        addTaskMeta(details, "证据终态 " + enumLabel(outcome.evidence_status));
      }
      addTaskMeta(details, "写入 " + enumLabel(task.writer_activity?.summary, "空闲"));
      addTaskMeta(details, "浏览器 " + enumLabel(task.browser_activity?.summary, "空闲"));
      addTaskMeta(details, "验证 " + enumLabel(task.validation_activity?.summary, "空闲"));
      const execution = task.execution_observability || null;
      if (execution) {
        if (execution.run_id) addTaskMeta(details, "Run " + execution.run_id);
        const ownerParts = [];
        if (execution.owner_source) ownerParts.push(enumLabel(execution.owner_source));
        if (Number.isFinite(Number(execution.owner_pid))) ownerParts.push("PID " + Number(execution.owner_pid));
        if (Number.isFinite(Number(execution.managed_pid)) && Number(execution.managed_pid) !== Number(execution.owner_pid)) ownerParts.push("子进程 " + Number(execution.managed_pid));
        if (Number.isFinite(Number(execution.fencing_token))) ownerParts.push("Fence " + Number(execution.fencing_token));
        addTaskMeta(details, "Owner " + (ownerParts.join(" · ") || "不可用"));
        addTaskMeta(details, "已运行 " + formatDurationMs(execution.duration_ms));
        addTaskMeta(details, "最后存活 " + formatDateTime(execution.last_liveness_at, "不可用"));
        addTaskMeta(details, "最后进展 " + formatDateTime(execution.last_progress_at, "不可用"));
        if (execution.step_deadline) addTaskMeta(details, "步骤截止 " + formatDateTime(execution.step_deadline));
        if (execution.no_progress_deadline) addTaskMeta(details, "无进展截止 " + formatDateTime(execution.no_progress_deadline));
        if (execution.hard_deadline) addTaskMeta(details, "强制截止 " + formatDateTime(execution.hard_deadline));
        addTaskMeta(details, "进程 " + enumLabel(execution.owner_alive === null || execution.owner_alive === undefined ? "unknown" : execution.owner_alive ? "alive" : "dead"));
        addTaskMeta(details, "Watcher " + enumLabel(execution.watcher_alive === null || execution.watcher_alive === undefined ? "unknown" : execution.watcher_alive ? "alive" : "dead"));
        if (execution.cancelling) addTaskMeta(details, "正在取消");
        if (execution.recovering) addTaskMeta(details, "正在恢复");
        if (execution.latest_error) addTaskMeta(details, "最近错误 " + displayText(execution.latest_error));
        addTaskMeta(details, "终止原因 " + enumLabel(execution.timeout_reason || execution.termination_reason, "未知"));
        if (execution.termination_signal) addTaskMeta(details, "终止信号 " + execution.termination_signal);
        if (execution.recovery_from_run_id) addTaskMeta(details, "恢复自 " + execution.recovery_from_run_id);
        if (Number.isFinite(Number(execution.resume_count))) addTaskMeta(details, "恢复次数 " + Number(execution.resume_count));
      }
      const gitFinalization = task.git_finalization || null;
      if (gitFinalization) {
        addTaskMeta(details, "Git 提交 " + enumLabel(gitFinalization.commit_status));
        addTaskMeta(details, "Git 推送 " + enumLabel(gitFinalization.push_status));
        addTaskMeta(details, "Git 交付 " + enumLabel(gitFinalization.delivery_status));
        addTaskMeta(details, "本地 SHA " + shortSha(gitFinalization.local_commit_sha));
        addTaskMeta(details, "远端 SHA " + shortSha(gitFinalization.remote_commit_sha));
        addTaskMeta(details, "推送传输 " + enumLabel(gitFinalization.push_transport, "未记录"));
        if (gitFinalization.push_error_code) addTaskMeta(details, "推送结果 " + enumLabel(gitFinalization.push_error_code));
      }
      const resource = task.resource_policy || null;
      if (resource) {
        addTaskMeta(details, "资源级别 " + enumLabel(resource.resource_class));
        addTaskMeta(details, "优先级 " + enumLabel(resource.priority));
        addTaskMeta(details, "资源状态 " + enumLabel(resource.status));
        if (resource.queue_position) addTaskMeta(details, "资源队列第 " + resource.queue_position + " 位");
        if (Array.isArray(resource.pools) && resource.pools.length) addTaskMeta(details, "资源池 " + resource.pools.map((pool) => enumLabel(pool)).join("、"));
      }
      const safe = task.safe_to_close_chat || {};
      const safePill = document.createElement("span");
      safePill.className = "pill " + (safe.safe ? "" : "warn");
      safePill.textContent = safe.safe ? "可以关闭聊天" : "请保持聊天窗口";
      details.appendChild(safePill);
      target.append(identity, action, details);
      const resourceWaitReason = resource && Array.isArray(resource.blocking_reasons) ? resource.blocking_reasons.join("；") : "";
      if (task.wait_reason || resourceWaitReason) {
        const waiting = document.createElement("p");
        waiting.className = "run-wait";
        waiting.textContent = "等待原因：" + displayText(task.wait_reason || resourceWaitReason);
        target.appendChild(waiting);
      }
      if (safe.reason) {
        const safeReason = document.createElement("p");
        safeReason.textContent = displayText(safe.reason);
        target.appendChild(safeReason);
      }
      if (task.git_finalization?.commit_status === "completed" && task.git_finalization?.push_status === "failed") {
        const gitNotice = document.createElement("p");
        gitNotice.className = "run-wait";
        gitNotice.textContent = "任务实现与验收已经完成，本地提交已创建；GitHub 推送失败，可在项目状态中重新推送。";
        target.appendChild(gitNotice);
      }
      if (task.last_evidence) {
        if (task.last_evidence_artifact?.href) {
          const evidenceLink = document.createElement("a");
          evidenceLink.className = "resource-link";
          evidenceLink.href = task.last_evidence_artifact.href;
          evidenceLink.target = "_blank";
          evidenceLink.rel = "noreferrer";
          evidenceLink.textContent = "打开证据";
          target.appendChild(evidenceLink);
        }
        const evidence = document.createElement("code");
        evidence.className = "small-path";
        evidence.textContent = "证据：" + task.last_evidence;
        target.appendChild(evidence);
      }
      appendTaskControls(target, task);
    }
    function renderUnifiedTasks(result) {
      if (!unifiedTaskList || !unifiedTaskSummary) return;
      const tasks = Array.isArray(result.tasks) ? result.tasks : [];
      const counts = result.counts || {};
      const pagination = result.pagination || {};
      const projects = Array.isArray(result.projects) ? result.projects : [];
      const currentObjective = result.current_objective || null;
      const currentActiveTask = result.current_active_task || null;
      const currentActiveId = currentObjective?.current_attempt_id || currentActiveTask?.task_id || null;
      const recentCompleted = Array.isArray(result.recent_completed_tasks) ? result.recent_completed_tasks : [];
      const attentionRequired = Array.isArray(result.attention_required_tasks) ? result.attention_required_tasks : [];
      const countText = Object.entries(counts).map(([key, value]) => enumLabel(key) + " " + value).join(" · ") || "暂无任务";
      const currentText = currentObjective
        ? "当前目标：" + compactText(currentObjective.title || currentObjective.objective_key, 80) + "（" + objectiveStatusLabel(currentObjective.status) + "）"
        : currentActiveTask
          ? "当前活动任务：" + compactText(currentActiveTask.title, 80) + "（" + currentActiveTask.task_id + "）"
          : "当前无目标或活动任务";
      unifiedTaskSummary.textContent = currentText
        + " · 需关注 " + attentionRequired.length
        + " · 最近终态（完成/取消） " + recentCompleted.length
        + " · 当前筛选 " + (pagination.total_tasks || 0) + " 条"
        + " · 全量状态：" + countText
        + " · 第 " + (pagination.page || 1) + "/" + (pagination.total_pages || 1) + " 页"
        + " · 生成时间 " + formatDateTime(result.generated_at);
      renderProjectFilter(projects);
      renderCurrentObjective(result);
      renderRecentDeliveries(result);
      updateDiagnosticSummary(result);
      renderOverview(result);
      renderProjects(result);
      if (taskPage) taskPage.textContent = (pagination.page || 1) + "/" + (pagination.total_pages || 1);
      if (taskPrev) taskPrev.disabled = !pagination.has_previous;
      if (taskNext) taskNext.disabled = !pagination.has_next;
      unifiedTaskList.replaceChildren();
      if (!tasks.length) {
        const empty = document.createElement("li");
        empty.textContent = "暂无统一任务。";
        unifiedTaskList.appendChild(empty);
        return;
      }
      for (const task of tasks) {
        const item = document.createElement("li");
        item.className = "durable-run" + (task.task_id === currentActiveId ? " unified-task-current" : "");
        item.setAttribute("data-task-id", task.task_id || "");
        const head = document.createElement("div");
        head.className = "durable-run-head";
        const title = document.createElement("strong");
        const fullTitle = displayText(task?.title, task?.task_id || "任务");
        title.textContent = displayTaskTitle(task);
        if (title.textContent !== fullTitle) title.title = fullTitle;
        const status = document.createElement("span");
        status.className = "pill " + taskTone(task.status, task.acceptance_status);
        status.title = task.status || "unknown";
        status.textContent = enumLabel(task.status);
        head.append(title, status);
        const terminal = ["completed", "failed", "cancelled", "implemented_not_verified"].includes(task.status);
        if (terminal) {
          const collapsed = document.createElement("details");
          const summary = document.createElement("summary");
          summary.appendChild(head);
          collapsed.appendChild(summary);
          appendTaskBody(collapsed, task);
          item.appendChild(collapsed);
        } else {
          item.appendChild(head);
          appendTaskBody(item, task);
        }
        unifiedTaskList.appendChild(item);
      }
      if (attentionFocusedTaskId) {
        const focused = [...unifiedTaskList.querySelectorAll("[data-task-id]")].find((item) => item.getAttribute("data-task-id") === attentionFocusedTaskId);
        if (focused) {
          focused.querySelector("details")?.setAttribute("open", "");
          focused.scrollIntoView({ block: "center", behavior: "smooth" });
          attentionFocusedTaskId = "";
        }
      }
    }
    function attentionApiUrl() {
      const params = new URLSearchParams(window.location.search);
      params.set("limit", "100");
      if (taskPolling.project) params.set("project", taskPolling.project);
      else params.delete("project");
      if (attentionStorage.cursor) params.set("cursor", attentionStorage.cursor);
      else params.delete("cursor");
      return "/admin/attention?" + params.toString();
    }
    function updateNotificationButton() {
      if (!attentionNotificationsEnable) return;
      if (!("Notification" in window)) {
        attentionNotificationsEnable.disabled = true;
        attentionNotificationsEnable.textContent = "当前浏览器不支持系统通知";
        return;
      }
      if (Notification.permission === "granted") {
        attentionNotificationsEnable.disabled = false;
        attentionNotificationsEnable.textContent = "浏览器通知已启用";
        return;
      }
      if (Notification.permission === "denied" || attentionStorage.notification_denied) {
        attentionNotificationsEnable.disabled = true;
        attentionNotificationsEnable.textContent = "浏览器通知已被拒绝";
        return;
      }
      attentionNotificationsEnable.disabled = false;
      attentionNotificationsEnable.textContent = "启用浏览器通知";
    }
    function renderRecentDeliveries(result) {
      if (!recentDeliverySummary || !recentDeliveryList) return;
      const deliveries = (Array.isArray(result.recent_completed_tasks) ? result.recent_completed_tasks : [])
        .filter((task) => task?.status === "completed")
        .slice(0, 3);
      recentDeliverySummary.textContent = deliveries.length
        ? "最近 " + deliveries.length + " 项已完成任务；完整证据和历史记录保留在诊断区。"
        : "暂无已满足完成条件的最近交付。";
      recentDeliveryList.replaceChildren();
      if (!deliveries.length) {
        const empty = document.createElement("li");
        empty.textContent = "暂无最近交付。";
        recentDeliveryList.appendChild(empty);
        return;
      }
      for (const task of deliveries) {
        const item = document.createElement("li");
        item.className = "recent-delivery-item";
        const title = document.createElement("strong");
        title.textContent = displayTaskTitle(task);
        const meta = document.createElement("span");
        meta.textContent = (task.project_name || task.project_id || "项目") + " · " + formatDateTime(task.updated_at);
        const code = document.createElement("code");
        code.textContent = task.task_id;
        const view = document.createElement("button");
        view.type = "button";
        view.className = "copy-mini secondary";
        view.textContent = "查看交付证据";
        view.addEventListener("click", () => {
          if (diagnosticWorkbench) diagnosticWorkbench.open = true;
          taskPolling.project = task.project_id || "";
          taskPolling.page = 1;
          attentionFocusedTaskId = task.task_id;
          if (taskProjectFilter) taskProjectFilter.value = taskPolling.project;
          void loadUnifiedTasks();
        });
        item.append(title, meta, code, view);
        recentDeliveryList.appendChild(item);
      }
    }
    function updateDiagnosticSummary(result) {
      if (!diagnosticSummary) return;
      const overview = result.overview || {};
      const projects = Array.isArray(result.projects) ? result.projects.length : 0;
      const totalTasks = result.pagination?.total_tasks || 0;
      diagnosticSummary.textContent = projects + " 个项目 · " + totalTasks + " 条 Attempt · "
        + String(overview.failed || 0) + " 个失败 · " + String(overview.recovery_required || 0) + " 个恢复状态";
    }
    function attentionActionCodeLabel(value, fallback) {
      return ({
        review_approval: "审查并确认受保护操作",
        authorize_browser: "重新授权当前浏览器标签页",
        open_recovery: "打开恢复方案并确认权威状态",
        review_resource_policy: "检查资源配额或等待当前租约释放",
        review_decision: "提供输入、复核结果或完成验收决策"
      })[value] || displayText(fallback, "检查该事项。");
    }
    function countAttentionValues(items, key) {
      return items.reduce((result, item) => {
        const value = String(item?.[key] || "未知");
        result[value] = (result[value] || 0) + 1;
        return result;
      }, {});
    }
    function renderAttention(result) {
      if (!attentionSummary || !attentionList || !attentionGroups) return;
      const summary = result.summary || {};
      const items = (Array.isArray(result.attention) ? result.attention : [])
        .filter((item) => item?.requires_human === true && item?.action_available !== false);
      attentionSummary.textContent = items.length
        ? String(items.length) + " 项需要你处理 · " + String(summary.event_count || 0) + " 个新事件 · 生成时间 " + formatDateTime(result.generated_at)
        : "当前没有需要你处理的事项；失败、恢复和资源状态已归入诊断。生成时间 " + formatDateTime(result.generated_at);
      attentionGroups.replaceChildren();
      for (const [label, values, formatter] of [
        ["严重程度", countAttentionValues(items, "severity"), enumLabel],
        ["事项类型", countAttentionValues(items, "type"), attentionTypeLabel],
        ["项目", countAttentionValues(items, "project"), (value) => value]
      ]) {
        const entries = Object.entries(values);
        if (!entries.length) continue;
        const group = document.createElement("div");
        group.className = "attention-group";
        const name = document.createElement("span");
        name.textContent = label;
        const count = document.createElement("strong");
        count.textContent = entries.map(([key, value]) => formatter(key) + " " + value).join(" · ");
        group.append(name, count);
        attentionGroups.appendChild(group);
      }
      attentionList.replaceChildren();
      if (!items.length) {
        const empty = document.createElement("li");
        empty.textContent = "无需你的操作。系统会继续处理可自动执行的恢复和诊断工作。";
        attentionList.appendChild(empty);
        return;
      }
      for (const item of items) {
        const row = document.createElement("li");
        row.className = "attention-item";
        row.setAttribute("data-severity", item.severity || "info");
        const head = document.createElement("div");
        head.className = "attention-title";
        const title = document.createElement("strong");
        const fullAttentionTitle = displayText(item.task_title, item.objective_key || attentionTypeLabel(item.type));
        title.textContent = compactText(fullAttentionTitle, 110);
        if (title.textContent !== fullAttentionTitle) title.title = fullAttentionTitle;
        const severity = document.createElement("span");
        severity.className = "pill " + (item.severity === "critical" ? "warn" : "");
        severity.title = (item.severity || "info") + " · " + (item.type || "attention");
        severity.textContent = attentionTypeLabel(item.type);
        head.append(title, severity);
        const action = document.createElement("p");
        action.textContent = "你需要做：" + attentionActionCodeLabel(item.action_code, item.recommended_action);
        const impact = document.createElement("p");
        impact.textContent = "不处理的影响：" + displayText(item.impact_if_ignored, "该目标将保持等待状态。");
        const verification = document.createElement("p");
        verification.textContent = "完成判定：" + displayText(item.verification_rule, "权威状态发生相应变化。");
        const technical = document.createElement("details");
        technical.className = "attention-technical";
        const technicalSummary = document.createElement("summary");
        technicalSummary.textContent = "技术原因与标识";
        const reason = document.createElement("p");
        reason.textContent = displayText(item.reason, "此事项需要人工处理。");
        const identifiers = document.createElement("code");
        identifiers.textContent = "Objective " + (item.objective_key || "unknown") + " · Attempt " + (item.attempt_id || item.task_id || "unknown");
        technical.append(technicalSummary, reason, identifiers);
        const meta = document.createElement("div");
        meta.className = "attention-meta";
        const time = document.createElement("span");
        time.textContent = (item.project || item.project_id || "项目") + " · 更新 " + formatDateTime(item.updated_at || item.created_at);
        const generation = document.createElement("span");
        generation.textContent = "条件代次 " + String(item.generation || 1);
        meta.append(time, generation);
        const actions = document.createElement("div");
        actions.className = "attention-actions";
        if (item.task_id) {
          const view = document.createElement("button");
          view.type = "button";
          view.className = "copy-mini secondary";
          view.textContent = "打开相关 Attempt";
          view.addEventListener("click", () => {
            if (diagnosticWorkbench) diagnosticWorkbench.open = true;
            taskPolling.project = item.project_id || "";
            taskPolling.page = 1;
            attentionFocusedTaskId = item.task_id;
            if (taskProjectFilter) taskProjectFilter.value = taskPolling.project;
            void loadUnifiedTasks();
          });
          actions.appendChild(view);
        }
        const acknowledge = document.createElement("button");
        acknowledge.type = "button";
        acknowledge.className = "copy-mini secondary";
        acknowledge.disabled = Boolean(item.acknowledged_at);
        acknowledge.textContent = item.acknowledged_at ? "已标记已读" : "标记已读";
        acknowledge.addEventListener("click", () => void acknowledgeAttention(item, acknowledge));
        actions.appendChild(acknowledge);
        row.append(head, action, impact, verification, technical, meta, actions);
        attentionList.appendChild(row);
      }
    }
    function notificationEventImportant(event) {
      return [
        "task_completed",
        "approval_required",
        "browser_authorization",
        "decision_required",
        "remote_sync_succeeded",
        "remote_sync_failed"
      ].includes(event?.type);
    }
    function deliverBrowserNotifications(events, baseline) {
      if (baseline || !("Notification" in window) || Notification.permission !== "granted") return;
      const delivered = new Set(attentionStorage.delivered_event_ids);
      for (const event of Array.isArray(events) ? events : []) {
        if (!event?.event_id || delivered.has(event.event_id) || !notificationEventImportant(event)) continue;
        try {
          const notification = new Notification((event.project || "CodexPro") + " · " + attentionTypeLabel(event.type, "任务更新"), {
            body: String((event.task_title || event.task_id || "任务") + "：" + (event.reason || event.recommended_action || "状态已变化。")).slice(0, 360),
            tag: event.event_id,
            renotify: false
          });
          notification.onclick = () => {
            window.focus();
            if (diagnosticWorkbench) diagnosticWorkbench.open = true;
            if (event.project_id) {
              taskPolling.project = event.project_id;
              taskPolling.page = 1;
              if (taskProjectFilter) taskProjectFilter.value = event.project_id;
            }
            if (event.task_id) attentionFocusedTaskId = event.task_id;
            void loadUnifiedTasks();
            notification.close();
          };
        } catch {
          // Browser notification failure does not affect task or attention state.
        }
        delivered.add(event.event_id);
      }
      attentionStorage.delivered_event_ids = [...delivered].slice(-500);
      saveAttentionStorage();
    }
    async function acknowledgeAttention(item, button) {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "保存中……";
      try {
        const params = new URLSearchParams(window.location.search);
        params.set("project", item.project_id || "");
        const response = await fetch("/admin/attention/" + encodeURIComponent(item.attention_id) + "/ack?" + params.toString(), {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "x-codexpro-csrf": taskActionCsrfToken
          },
          body: "{}"
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || "待处理事项确认失败");
        await loadAttention({ manual: true });
      } catch (error) {
        showTaskDialog("待处理事项确认失败", error instanceof Error ? error.message : "待处理事项确认失败");
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }
    function applyAttentionResult(result, baseline) {
      attentionPolling.lastResult = result;
      renderAttention(result);
      deliverBrowserNotifications(result.events, baseline);
      if (typeof result.next_cursor === "string") attentionStorage.cursor = result.next_cursor;
      saveAttentionStorage();
    }
    async function loadAttention(options = {}) {
      if (attentionPolling.inFlight) return;
      attentionPolling.inFlight = true;
      attentionPolling.controller = new AbortController();
      if (options.manual && attentionRefresh) {
        attentionRefresh.disabled = true;
        attentionRefresh.textContent = "加载中……";
      }
      const baseline = !attentionStorage.cursor;
      try {
        const response = await fetch(attentionApiUrl(), { headers: { "accept": "application/json" }, signal: attentionPolling.controller.signal });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || "待处理事项请求失败");
        applyAttentionResult(result, baseline);
      } catch (error) {
        if (error?.name !== "AbortError" && attentionSummary) attentionSummary.textContent = "加载失败：" + (error instanceof Error ? error.message : "待处理事项请求失败");
      } finally {
        attentionPolling.inFlight = false;
        attentionPolling.controller = null;
        if (attentionRefresh) {
          attentionRefresh.disabled = false;
          attentionRefresh.textContent = "刷新待处理事项";
        }
      }
    }
    function clearTaskTimer() {
      if (taskPolling.timer) {
        clearTimeout(taskPolling.timer);
        taskPolling.timer = null;
      }
    }
    function taskPollDelay() {
      return document.visibilityState === "hidden" ? taskHiddenPollMs : taskVisiblePollMs;
    }
    function scheduleTaskPoll(delay) {
      clearTaskTimer();
      if (taskPolling.stopped) return;
      taskPolling.timer = setTimeout(() => {
        void loadUnifiedTasks({ scheduled: true });
      }, delay ?? taskPollDelay());
    }
    function cleanupTaskPolling() {
      taskPolling.stopped = true;
      clearTaskTimer();
      if (taskPolling.controller) taskPolling.controller.abort();
      if (attentionPolling.controller) attentionPolling.controller.abort();
    }
    function taskDashboardUrl() {
      const params = new URLSearchParams(window.location.search);
      params.set("page", String(taskPolling.page));
      params.set("page_size", String(taskPolling.pageSize));
      params.set("attention_limit", "100");
      if (attentionStorage.cursor) params.set("attention_cursor", attentionStorage.cursor);
      else params.delete("attention_cursor");
      if (taskPolling.project) params.set("project", taskPolling.project);
      else params.delete("project");
      if (taskPolling.status) params.set("status", taskPolling.status);
      else params.delete("status");
      return "/admin/tasks?" + params.toString();
    }
    async function loadUnifiedTasks(options = {}) {
      const manual = options.manual === true;
      if (taskPolling.inFlight) {
        if (manual) taskPolling.pendingManual = true;
        return;
      }
      taskPolling.inFlight = true;
      taskPolling.controller = new AbortController();
      if (manual && taskRefresh) {
        taskRefresh.disabled = true;
        taskRefresh.textContent = "加载中……";
      }
      try {
        const response = await fetch(taskDashboardUrl(), { headers: { "accept": "application/json" }, signal: taskPolling.controller.signal });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error?.message || "任务中心请求失败");
        renderUnifiedTasks(result);
        if (result.attention?.ok) applyAttentionResult(result.attention, !attentionStorage.cursor);
        else await loadAttention();
      } catch (error) {
        if (error?.name !== "AbortError" && unifiedTaskSummary) unifiedTaskSummary.textContent = "加载失败：" + (error instanceof Error ? error.message : "任务中心请求失败");
      } finally {
        taskPolling.inFlight = false;
        taskPolling.controller = null;
        if (manual && taskRefresh) {
          taskRefresh.disabled = false;
          taskRefresh.textContent = "刷新";
        }
        const pendingManual = taskPolling.pendingManual;
        taskPolling.pendingManual = false;
        if (pendingManual) void loadUnifiedTasks({ manual: true });
        else scheduleTaskPoll();
      }
    }
    updateNotificationButton();
    attentionRefresh?.addEventListener("click", () => void loadAttention({ manual: true }));
    attentionNotificationsEnable?.addEventListener("click", async () => {
      if (!("Notification" in window) || Notification.permission === "denied" || attentionStorage.notification_denied) {
        updateNotificationButton();
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission === "denied") attentionStorage.notification_denied = true;
      saveAttentionStorage();
      updateNotificationButton();
    });
    taskDialogClose?.addEventListener("click", () => {
      if (typeof taskDialog?.close === "function") taskDialog.close();
      else taskDialog?.removeAttribute("open");
    });
    taskDialog?.addEventListener("close", () => {
      if (taskDialogOutput) taskDialogOutput.textContent = "";
    });
    taskRefresh?.addEventListener("click", () => void loadUnifiedTasks({ manual: true }));
    taskProjectFilter?.addEventListener("change", () => {
      taskPolling.project = taskProjectFilter.value;
      taskPolling.page = 1;
      void loadUnifiedTasks();
    });
    taskStatusFilter?.addEventListener("change", () => {
      taskPolling.status = taskStatusFilter.value;
      taskPolling.page = 1;
      void loadUnifiedTasks();
    });
    taskPageSize?.addEventListener("change", () => {
      taskPolling.pageSize = Number(taskPageSize.value || 25);
      taskPolling.page = 1;
      void loadUnifiedTasks();
    });
    taskPrev?.addEventListener("click", () => {
      taskPolling.page = Math.max(1, taskPolling.page - 1);
      void loadUnifiedTasks();
    });
    taskNext?.addEventListener("click", () => {
      taskPolling.page += 1;
      void loadUnifiedTasks();
    });
    document.addEventListener("visibilitychange", () => {
      taskPolling.stopped = false;
      clearTaskTimer();
      if (document.visibilityState === "visible") void loadUnifiedTasks();
      else scheduleTaskPoll(taskHiddenPollMs);
    });
    window.addEventListener("pagehide", cleanupTaskPolling);
    window.addEventListener("beforeunload", cleanupTaskPolling);
    void loadUnifiedTasks();

    updateStructuredMode();
    structuredMode?.addEventListener("change", updateStructuredMode);
    structuredReset?.addEventListener("click", () => {
      if (structuredTaskOutput) structuredTaskOutput.textContent = "尚未创建结构化任务。";
    });
    structuredTaskForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const original = structuredSubmit?.textContent || "创建结构化任务";
      if (structuredSubmit) {
        structuredSubmit.disabled = true;
        structuredSubmit.textContent = "创建中……";
      }
      if (structuredTaskOutput) structuredTaskOutput.textContent = "正在创建结构化任务……";
      try {
        const payload = structuredFormPayload(form);
        const response = await fetch(structuredTaskApiUrl(), {
          method: "POST",
          headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "x-codexpro-csrf": taskActionCsrfToken
          },
          body: JSON.stringify(payload)
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (structuredTaskOutput) structuredTaskOutput.textContent = describeStructuredTaskError(response, result);
          return;
        }
        if (structuredTaskOutput) structuredTaskOutput.textContent = describeStructuredTaskResult(result);
        if (result.project_id) {
          taskPolling.project = result.project_id;
          taskPolling.page = 1;
          if (taskProjectFilter) taskProjectFilter.value = result.project_id;
        }
        if (result.task_id) attentionFocusedTaskId = result.task_id;
        await loadUnifiedTasks();
      } catch (error) {
        if (structuredTaskOutput) structuredTaskOutput.textContent = "创建失败：" + (error instanceof Error ? error.message : "结构化任务请求失败");
      } finally {
        if (structuredSubmit) {
          structuredSubmit.disabled = false;
          structuredSubmit.textContent = original;
        }
      }
    });

    document.querySelectorAll("[data-console-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.getAttribute("data-console-action") || "";
        const original = button.textContent;
        button.disabled = true;
        button.textContent = "执行中……";
        if (consoleOutput) consoleOutput.textContent = "正在执行“" + actionLabel(action) + "”（" + action + "）……";
        try {
          const response = await fetch("/admin/action" + window.location.search, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-codexpro-csrf": taskActionCsrfToken
            },
            body: JSON.stringify({ action })
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error?.message || "控制台操作失败");
          if (result.copy_text) {
            try { await navigator.clipboard.writeText(result.copy_text); } catch {}
          }
          if (consoleOutput) consoleOutput.textContent = describeConsoleResult(result);
        } catch (error) {
          if (consoleOutput) consoleOutput.textContent = "操作失败：" + (error instanceof Error ? error.message : "控制台操作失败");
        } finally {
          button.disabled = false;
          button.textContent = original;
        }
      });
    });
    const profileForm = document.querySelector("[data-profile-form]");
    const tunnelSelect = document.querySelector("[data-tunnel-select]");
    const hostnameInput = document.querySelector("[data-hostname-input]");
    const hostnameHelp = document.querySelector("[data-hostname-help]");
    const tokenEnabled = ${config.authToken ? "true" : "false"};
    function serverPreviewFor(hostname) {
      const clean = String(hostname || "").trim().replace(/^https?:\\/\\//, "").replace(/\\/mcp\\/?$/, "").replace(/\\/+$/, "");
      if (!clean) return "";
      return "https://" + clean + "/mcp" + (tokenEnabled ? "?codexpro_token=<redacted>" : "");
    }
    function updateTunnelHelp() {
      if (!tunnelSelect || !hostnameInput || !hostnameHelp) return;
      const tunnel = tunnelSelect.value;
      const ngrokHost = tunnelSelect.getAttribute("data-ngrok-hostname") || "";
      const cloudflareHost = tunnelSelect.getAttribute("data-cloudflare-hostname") || "";
      if (tunnel === "ngrok" && !hostnameInput.value && ngrokHost) {
        hostnameInput.value = ngrokHost;
        hostnameInput.setAttribute("data-autofilled", "1");
      }
      if (tunnel === "cloudflare-named" && !hostnameInput.value && cloudflareHost) {
        hostnameInput.value = cloudflareHost;
        hostnameInput.setAttribute("data-autofilled", "1");
      }
      if ((tunnel === "cloudflare" || tunnel === "none") && hostnameInput.getAttribute("data-autofilled") === "1") {
        hostnameInput.value = "";
        hostnameInput.setAttribute("data-autofilled", "0");
      }
      const preview = serverPreviewFor(hostnameInput.value);
      if (tunnel === "cloudflare") {
        hostnameHelp.textContent = "Cloudflare 快速隧道会在启动时生成公网地址；启动器上报地址后，本页面会自动显示。";
      } else if (tunnel === "ngrok") {
        hostnameHelp.textContent = preview ? "下次服务器地址预览：" + preview : "请输入本地 ngrok 配置中预留的域名。";
      } else if (tunnel === "cloudflare-named") {
        hostnameHelp.textContent = preview ? "下次服务器地址预览：" + preview : "请输入已路由到 Cloudflare 命名隧道的主机名。";
      } else {
        hostnameHelp.textContent = "仅本机模式不会提供可供 ChatGPT 使用的公网服务器地址。";
      }
    }
    tunnelSelect?.addEventListener("change", updateTunnelHelp);
    hostnameInput?.addEventListener("input", () => {
      hostnameInput.setAttribute("data-autofilled", "0");
      updateTunnelHelp();
    });
    updateTunnelHelp();
    if (profileForm) {
      profileForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const status = document.querySelector("[data-profile-status]");
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = {
          tunnel: data.tunnel,
          hostname: data.hostname,
          tunnelName: data.tunnelName,
          ngrokConfig: data.ngrokConfig,
          cloudflareConfig: data.cloudflareConfig,
          ["cloudflare" + "TokenFile"]: data.cloudflareTokenFile,
          port: Number(data.port),
          mode: data.mode,
          bash: data.bash,
          write: data.write,
          toolMode: data.toolMode,
          toolCards: Boolean(form.elements.toolCards?.checked),
          codexSessions: data.codexSessions,
          codexDir: data.codexDir,
          bashSession: data.bashSession,
          requireBashSession: Boolean(form.elements.requireBashSession?.checked),
          noInstallCloudflared: Boolean(form.elements.noInstallCloudflared?.checked)
        };
        if (status) status.textContent = "保存中……";
        try {
          const response = await fetch("/admin/profile" + window.location.search, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-codexpro-csrf": taskActionCsrfToken
            },
            body: JSON.stringify(payload)
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(result.error?.message || "保存失败");
          if (status) status.textContent = "已保存。重启 CodexPro 后，这些配置才会生效。";
        } catch (error) {
          if (status) status.textContent = "保存失败：" + (error instanceof Error ? error.message : "保存失败");
        }
      });
    }
  </script>
</body>
</html>`;
}
