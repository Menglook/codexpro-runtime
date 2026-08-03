import {
  OFFICE_REPORT_SURFACE_CSS,
  OFFICE_REPORT_SURFACE_HTML,
  OFFICE_REPORT_SURFACE_SCRIPT,
  officeReportFeatureFlag,
  type OfficeReportFeatureFlag
} from "./officeReportSurface.js";
import { officeSceneFeatureFlag, type OfficeSceneFeatureFlag } from "./officeSceneSurface.js";
import { OFFICE_SCENE_SURFACE_HTML, OFFICE_SCENE_SURFACE_SCRIPT } from "./officeSceneSurface.js";
import { OFFICE_SCENE_STYLES } from "./officeSceneStyles.js";
import { officePlainLanguageFeatureFlag } from "./officePlainLanguage.js";
import { officeToolOutcomeFeatureFlag } from "./officeToolOutcomeService.js";
import { officeProcessAnimationFeatureFlag } from "./officeSceneProcessRuntime.js";

export function officeSurfacePage(
  taskActionCsrfToken: string,
  officeReportFeature: OfficeReportFeatureFlag = officeReportFeatureFlag(),
  officeSceneFeature: OfficeSceneFeatureFlag = officeSceneFeatureFlag()
): string {
  const csrfLiteral = JSON.stringify(taskActionCsrfToken).replace(/</g, "\\u003c");
  const officeReportFeatureLiteral = JSON.stringify(officeReportFeature).replace(/</g, "\\u003c");
  const officeSceneFeatureLiteral = JSON.stringify(officeSceneFeature).replace(/</g, "\\u003c");
  const officePlainLanguageFeatureLiteral = JSON.stringify(officePlainLanguageFeatureFlag()).replace(/</g, "\\u003c");
  const officeToolOutcomeFeatureLiteral = JSON.stringify(officeToolOutcomeFeatureFlag()).replace(/</g, "\\u003c");
  const officeProcessAnimationFeatureLiteral = JSON.stringify(officeProcessAnimationFeatureFlag()).replace(/</g, "\\u003c");
  const officeSceneCapable = officeSceneFeature.enabled || officeSceneFeature.projects.length > 0;
  const officeSceneStyles = officeSceneCapable ? OFFICE_SCENE_STYLES : "";
  const officeSceneHtml = officeSceneCapable ? OFFICE_SCENE_SURFACE_HTML : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>CodexPro 办公室</title>
  <style>
    :root{color-scheme:light dark;--bg:#f3f5f8;--panel:#fff;--card:#fff;--text:#152033;--muted:#697386;--border:#dce2ea;--accent:#2563eb;--accent-soft:#eaf1ff;--danger:#b42318;--danger-soft:#fff0ee;--warn:#a15c00;--warn-soft:#fff7e6;--ok:#147d4f;--ok-soft:#eaf8f0;--shadow:0 8px 28px rgba(30,41,59,.08)}
    @media(prefers-color-scheme:dark){:root{--bg:#10141d;--panel:#171d28;--card:#1d2431;--text:#edf2f7;--muted:#a7b0c0;--border:#303a4a;--accent:#79a7ff;--accent-soft:#1b315c;--danger:#ff8f87;--danger-soft:#4a2020;--warn:#ffc66d;--warn-soft:#45371d;--ok:#65d6a2;--ok-soft:#17392d;--shadow:none}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}button,input,select{font:inherit;color:inherit}a{color:var(--accent)}
    .shell{max-width:1680px;margin:0 auto;padding:18px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.brand{display:flex;align-items:center;gap:12px}.brand-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--accent);color:#fff;font-weight:800}.brand h1{font-size:22px;margin:0}.sub{color:var(--muted);font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{border:1px solid var(--border);border-radius:10px;background:var(--panel);padding:8px 12px;text-decoration:none;cursor:pointer}.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
    .metrics{display:grid;grid-template-columns:repeat(9,minmax(105px,1fr));gap:10px;margin-bottom:14px}.metric{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:12px}.metric b{display:block;font-size:22px}.metric span{color:var(--muted);font-size:12px}.metric.attn b{color:var(--danger)}
    .toolbar{display:flex;align-items:end;gap:12px;flex-wrap:wrap;background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:12px;margin-bottom:14px}.field{display:grid;gap:5px;min-width:180px}.field label{font-size:12px;color:var(--muted)}.field select{background:var(--card);border:1px solid var(--border);border-radius:9px;padding:8px}.check{display:flex;align-items:center;gap:7px;padding:8px}.sync{margin-left:auto;color:var(--muted);font-size:12px}
    .notice{display:none;border:1px solid var(--border);background:var(--panel);border-radius:12px;padding:12px;margin-bottom:14px}.notice.show{display:block}.notice.error{border-color:var(--danger);background:var(--danger-soft);color:var(--danger)}
    .floor{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:14px;margin-bottom:18px;box-shadow:var(--shadow)}.floor-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:12px}.floor-title h2{margin:0;font-size:18px}.floor-meta{color:var(--muted);font-size:12px;word-break:break-all}.writer{border:1px solid var(--border);border-radius:10px;padding:8px 10px;min-width:240px}.writer.active{background:var(--ok-soft);border-color:var(--ok)}.writer.queued{background:var(--warn-soft);border-color:var(--warn)}.floor-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.floor-card{background:var(--panel);border:1px solid var(--border);border-radius:16px;padding:14px;box-shadow:var(--shadow)}.floor-card.incident{border-color:var(--danger)}.floor-card.waiting{border-color:var(--warn)}.floor-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.floor-card h2{font-size:17px;margin:0}.floor-status{border:1px solid var(--border);border-radius:999px;padding:2px 8px;font-size:11px}.zone-strip{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0}.zone-pill{border:1px solid var(--border);border-radius:999px;padding:4px 8px;font-size:11px;background:var(--bg)}.zone-pill.hot{border-color:var(--danger);color:var(--danger)}.floor-card-actions{display:flex;justify-content:flex-end;margin-top:12px}
    .office-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;min-width:0}.zone{border:1px solid var(--border);border-radius:12px;background:var(--bg);min-height:132px;min-width:0;padding:10px;overflow:hidden}.zone-head{display:flex;justify-content:space-between;align-items:center;min-width:0;margin-bottom:8px}.zone-head h3{font-size:14px;margin:0}.count{display:inline-grid;place-items:center;min-width:24px;height:24px;border-radius:12px;background:var(--panel);border:1px solid var(--border);font-size:12px}.zone[data-zone="waiting_user"],.zone[data-zone="incident"]{border-color:color-mix(in srgb,var(--danger) 55%,var(--border))}.zone[data-zone="validation"],.zone[data-zone="browser"]{border-color:color-mix(in srgb,var(--accent) 55%,var(--border))}.zone[data-zone="archive"]{opacity:.82}.empty{color:var(--muted);font-size:12px;padding:12px 2px}
    .objective{width:100%;min-width:0;max-width:100%;overflow-wrap:anywhere;text-align:left;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;margin-top:8px;cursor:pointer;transition:border-color .18s ease,background-color .18s ease}.objective:hover,.objective:focus{border-color:var(--accent)}.objective.changed{background:var(--accent-soft)}.obj-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.obj-title{font-weight:700}.badges{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}.badge{border:1px solid var(--border);border-radius:999px;padding:2px 7px;font-size:11px;color:var(--muted)}.badge.hot{color:var(--danger);border-color:var(--danger)}.obj-summary{color:var(--muted);font-size:12px;margin-top:7px}.obj-state-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;margin-top:8px}.obj-state{border:1px solid var(--border);border-radius:7px;background:var(--bg);padding:5px;min-width:0}.obj-state span{display:block;color:var(--muted);font-size:9px}.obj-state b{display:block;font-size:11px;overflow-wrap:anywhere}.obj-current{margin-top:6px;border-left:3px solid var(--accent);padding:4px 7px;background:var(--accent-soft);border-radius:5px}.obj-current span{display:block;color:var(--muted);font-size:9px}.obj-current strong{font-size:11px;font-weight:650}.executors,.devices{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.person,.device-chip{display:flex;align-items:center;gap:5px;border-radius:8px;background:var(--bg);padding:4px 7px;font-size:11px}.device-chip{border:1px dashed var(--border)}.device-icon{font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}.dot.active{background:var(--ok)}.dot.waiting{background:var(--warn)}.dot.stale{background:var(--danger)}
    .zone[data-density="compact"] .objective{padding:7px;margin-top:6px}.zone[data-density="compact"] .obj-summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.zone[data-density="compact"] .executors,.zone[data-density="compact"] .devices{margin-top:5px;gap:4px}.zone[data-density="compact"] .person,.zone[data-density="compact"] .device-chip{padding:2px 5px}.zone[data-density="grouped"]>[data-zone-items]{display:grid;gap:7px}.team-group{border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden;min-width:0}.team-group.attention{border-color:var(--danger)}.team-group-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;border:0;background:transparent;padding:9px;text-align:left;cursor:pointer}.team-group-title{font-weight:750;overflow-wrap:anywhere}.team-group-meta{color:var(--muted);font-size:11px}.team-group-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:0 9px 9px}.team-stat{border:1px solid var(--border);border-radius:7px;padding:4px;min-width:0;text-align:center;font-size:10px;color:var(--muted)}.team-stat b{display:block;color:var(--text);font-size:13px}.team-group-body{display:grid;gap:6px;padding:0 8px 8px}.team-group[aria-expanded="false"] .team-group-body{display:none}.team-group-toggle{white-space:nowrap}.zone-density-note{color:var(--muted);font-size:10px;margin-left:auto;margin-right:6px}.pinned-objective{outline:1px solid color-mix(in srgb,var(--warn) 55%,transparent)}
    .drawer-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.35);display:none;z-index:20}.drawer-backdrop.open{display:block}.drawer{position:absolute;right:0;top:0;height:100%;width:min(720px,96vw);overflow:auto;background:var(--panel);border-left:1px solid var(--border);padding:20px}.drawer-head{display:flex;justify-content:space-between;gap:12px}.drawer h2{margin:0}.close{border:1px solid var(--border);border-radius:9px;background:var(--card);padding:7px 10px;cursor:pointer}.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0}.detail{border:1px solid var(--border);border-radius:10px;padding:10px}.detail span{display:block;color:var(--muted);font-size:11px}.detail b{word-break:break-word}.section{margin-top:18px}.section h3{font-size:14px}.graph-note{padding:9px;border-radius:9px;background:var(--bg);color:var(--muted);font-size:12px}.drawer-actions{display:flex;gap:7px;flex-wrap:wrap}.drawer-actions .btn{font-size:12px}.detail-output{min-height:72px;max-height:360px;overflow:auto;white-space:pre-wrap;word-break:break-word;border:1px solid var(--border);border-radius:10px;background:var(--bg);padding:10px;font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace}.alert-list{display:grid;gap:6px}.alert-item{border-left:3px solid var(--danger);background:var(--danger-soft);padding:7px 9px;border-radius:6px;font-size:12px}.graph{width:100%;height:auto;border:1px solid var(--border);border-radius:10px;background:var(--bg)}.attempt-list{display:grid;gap:7px}.attempt-row{border-left:3px solid var(--border);padding:6px 9px;background:var(--bg);font-size:12px}.legend{display:flex;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:12px;margin:10px 2px 22px}.loading{padding:50px;text-align:center;color:var(--muted)}
    .perspective-switch{display:flex;gap:3px;border:1px solid var(--border);border-radius:11px;background:var(--panel);padding:3px}.perspective-switch button{border:0;border-radius:8px;background:transparent;padding:7px 10px;cursor:pointer}.perspective-switch button.active{background:var(--accent);color:#fff}.boss-summary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin:14px 0}.boss-summary-card{min-height:78px;border:1px solid var(--border);border-radius:12px;background:var(--bg);padding:11px}.boss-summary-card.primary{grid-column:1/-1;border-color:color-mix(in srgb,var(--accent) 45%,var(--border));background:var(--accent-soft)}.boss-summary-card.attention{border-color:var(--warn);background:var(--warn-soft)}.boss-summary-card span{display:block;color:var(--muted);font-size:11px}.boss-summary-card b{display:block;margin-top:3px;font-size:14px;line-height:1.45}.business-progress{display:grid;gap:7px}.business-progress .attempt-row{border-left-color:var(--accent)}.technical-details{margin-top:18px;border:1px solid var(--border);border-radius:12px;background:var(--bg);overflow:hidden}.technical-details>summary{cursor:pointer;padding:12px 14px;font-weight:750}.technical-details>[data-technical-content]{padding:0 14px 15px}.technical-only{display:none}.office-tech-view .technical-only{display:block}.office-tech-view .technical-details>summary{color:var(--accent)}
    .workspace-conflict{display:none;margin:10px 0;border:1px solid var(--danger);border-radius:10px;background:var(--danger-soft);color:var(--danger);padding:9px 11px;font-weight:700}.workspace-conflict.show{display:block}.objective.incident-blocked,.objective.incident-failed{border-left:4px solid var(--danger)}.objective.incident-stalled{border-left:4px dashed var(--warn)}.objective.incident-orphaned{border:2px dashed var(--danger);opacity:.86}.objective.incident-waiting_approval{border-left:4px solid var(--warn)}
    .capability-registry{margin:0 0 18px;border:1px solid var(--border);border-radius:14px;background:var(--panel);overflow:hidden}.capability-registry>summary{cursor:pointer;padding:12px 14px;font-weight:750}.capability-registry-body{display:grid;gap:12px;padding:0 14px 14px}.capability-zone h3{margin:0 0 7px;font-size:13px}.capability-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.capability-card{border:1px solid var(--border);border-radius:9px;background:var(--bg);padding:8px;min-width:0}.capability-card b,.capability-card span{display:block;overflow-wrap:anywhere}.capability-card span{font-size:11px;color:var(--muted)}.tool-evidence{margin-top:6px;border:1px solid var(--border);border-radius:7px;padding:5px 7px}.tool-evidence summary{cursor:pointer;font-weight:650}.evidence-list{margin:6px 0 0;padding-left:18px}.git-desk{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.git-desk .detail{background:var(--bg)}
${OFFICE_REPORT_SURFACE_CSS}
${officeSceneStyles}
    .state-event{display:none;margin-top:7px;border-left:3px solid var(--accent);border-radius:6px;background:var(--accent-soft);padding:5px 7px;color:var(--text);font-size:11px}.state-event.show{display:block}.human-hand{display:none}.objective.is-human-wait .human-hand{display:inline-flex;color:var(--warn);border-color:var(--warn)}.objective.is-stale{opacity:.72;border-color:var(--danger)}.objective.is-recovering{border-color:var(--warn);background:var(--warn-soft)}.objective.is-archived{opacity:.82}.device-chip.device-browser.active,.device-chip.device-acceptance.active{border-color:var(--accent)}.writer.writer-stale{border-color:var(--danger);background:var(--danger-soft)}[data-graph-edge-key].route-selected{stroke:var(--accent);opacity:1;stroke-width:3}[data-graph-node-key][data-state="stale"] rect{stroke:var(--danger)}[data-graph-node-key][data-state="waiting"] rect{stroke:var(--warn)}
    @keyframes officePulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 45%,transparent)}60%{box-shadow:0 0 0 9px transparent}100%{box-shadow:none}}
    @keyframes officeLift{0%{transform:translateY(7px);opacity:.68}100%{transform:translateY(0);opacity:1}}
    @keyframes officeShake{0%,100%{transform:translateX(0)}30%{transform:translateX(-4px)}70%{transform:translateX(4px)}}
    @keyframes officeRoute{0%{stroke-dasharray:2 9;stroke-dashoffset:18}100%{stroke-dasharray:10 0;stroke-dashoffset:0}}
    @keyframes officeBubble{0%{transform:translateY(4px);opacity:0}25%{transform:translateY(0);opacity:1}100%{opacity:1}}
    @keyframes officeHand{0%{transform:rotate(0deg)}45%{transform:rotate(-13deg)}100%{transform:rotate(0deg)}}
    .anim-objective-enter,.anim-objective-move,.anim-person-follow,.anim-queue,.anim-recovery,.anim-graph-node,.anim-git-delivery,.anim-archive{animation:officeLift .52s ease-out 1 both}.anim-progress,.anim-browser,.anim-acceptance-pass,.anim-writer-acquired,.anim-join-ready{animation:officePulse .7s ease-out 1 both}.anim-human-wait .human-hand{animation:officeHand .62s ease-out 1 both}.anim-stale,.anim-acceptance-fail,.anim-git-fail,.anim-writer-expired{animation:officeShake .46s ease-out 1 both}.anim-branch-selected,.anim-parallel,.anim-handoff,.anim-retry{animation:officeRoute .66s ease-out 1 both}.state-event.anim-event{animation:officeBubble .42s ease-out 1 both}.anim-writer-queued,.anim-writer-released,.anim-browser-stop,.anim-acceptance-start,.anim-graph-complete{animation:officePulse .52s ease-out 1 both}
    @media(prefers-reduced-motion:reduce){.anim-objective-enter,.anim-objective-move,.anim-person-follow,.anim-queue,.anim-recovery,.anim-graph-node,.anim-git-delivery,.anim-archive,.anim-progress,.anim-browser,.anim-acceptance-pass,.anim-writer-acquired,.anim-join-ready,.anim-human-wait .human-hand,.anim-stale,.anim-acceptance-fail,.anim-git-fail,.anim-writer-expired,.anim-branch-selected,.anim-parallel,.anim-handoff,.anim-retry,.state-event.anim-event,.anim-writer-queued,.anim-writer-released,.anim-browser-stop,.anim-acceptance-start,.anim-graph-complete{animation:none!important;transform:none!important;transition:none!important}.state-event.show{display:block}}
    @media(max-width:1100px){.metrics{grid-template-columns:repeat(3,1fr)}.office-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.floor-overview{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:720px){.obj-state-grid,.boss-summary-grid,.git-desk,.capability-grid{grid-template-columns:1fr}.boss-summary-card.primary{grid-column:auto}.shell{padding:10px}.topbar,.floor-head{align-items:stretch;flex-direction:column}.actions{width:100%}.btn{flex:1;text-align:center}.perspective-switch{width:100%}.perspective-switch button{flex:1}.metrics{grid-template-columns:repeat(2,1fr)}.toolbar{display:grid;grid-template-columns:1fr}.field{min-width:0}.sync{margin-left:0}.floor-overview{grid-template-columns:1fr}.office-grid{display:block}.zone{margin-bottom:9px;min-height:0}.writer{min-width:0}.detail-grid{grid-template-columns:1fr}.drawer{width:100%;padding:16px}.team-group-head{grid-template-columns:minmax(0,1fr) auto}.team-group-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.team-group-meta{display:block;margin-top:2px}.objective,.team-group{max-width:100%;overflow-wrap:anywhere}}
    @media(max-width:360px){.shell{padding:7px}.zone{padding:7px}.objective{padding:7px}.team-group-head{padding:7px}.team-group-stats{padding:0 7px 7px}.team-group-toggle{padding:6px 8px}.badges{gap:3px}.badge{padding:1px 5px}.person,.device-chip{max-width:100%;overflow-wrap:anywhere}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark">CP</div><div><h1>CodexPro 办公室</h1><div class="sub">任务状态、智能体动作和设备灯光均来自真实持久记录</div></div></div>
      <div class="actions"><div class="perspective-switch" id="officePerspectiveSwitch" aria-label="信息视角"><button type="button" data-office-perspective="boss">老板视角</button><button type="button" data-office-perspective="tech">技术视角</button></div><a class="btn" id="consoleLink" href="/">返回控制台</a><button class="btn primary" id="refreshButton" type="button">立即刷新</button></div>
    </header>
    <section class="metrics" id="metrics" aria-label="老板指标"></section>
    <section class="toolbar" aria-label="办公室筛选">
      <div class="field"><label for="projectFilter">项目视图</label><select id="projectFilter"><option value="">全部项目 · 楼层总览</option></select></div>
      <label class="check"><input id="archiveToggle" type="checkbox" /> 显示已结束任务</label>
      <label class="check"><input id="testHistoryToggle" type="checkbox" /> 显示历史测试任务</label>
      <div class="sync" id="syncState" aria-live="polite">准备读取真实状态…</div>
${officeSceneHtml || "    </section>\n  <section id=\"officeBoardBoundary\">"}
    <div class="notice" id="notice" role="status"></div>
    <section id="floors"><div class="loading">正在读取办公室状态…</div></section>
    <details class="capability-registry technical-only" id="capabilityRegistry"><summary id="capabilityRegistrySummary">办公室能力目录</summary><div class="capability-registry-body" id="capabilityRegistryBody"></div></details>
    <div class="legend"><span>● 活跃：有最新执行依据</span><span>● 等待：正在排队或需要老板处理</span><span>● 异常：执行失败、停滞或后台失联</span><span>没有依据的任务关系和设备活动不会被补画</span></div>
    </section>
  </main>
  <div class="drawer-backdrop" id="drawerBackdrop" aria-hidden="true"><aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawerTitle"><div class="drawer-head"><div><h2 id="drawerTitle">任务详情</h2><div class="sub" id="drawerSubtitle"></div></div><button class="close" id="drawerClose" type="button">关闭</button></div><div id="drawerBody"></div></aside></div>
${OFFICE_REPORT_SURFACE_HTML}
  <script>
    (() => {
      const initialAuthUrl = new URL(window.location.href);
      if (initialAuthUrl.searchParams.has("codexpro_token") || initialAuthUrl.searchParams.has("token")) {
        initialAuthUrl.searchParams.delete("codexpro_token");
        initialAuthUrl.searchParams.delete("token");
        history.replaceState(null, "", initialAuthUrl.pathname + initialAuthUrl.search + initialAuthUrl.hash);
      }
${OFFICE_REPORT_SURFACE_SCRIPT}
${OFFICE_SCENE_SURFACE_SCRIPT}
      const ZONES = [
        ["waiting_user","等待老板"],["incident","故障处理室"],["recovering","恢复处理区"],
        ["validation","测试验收室"],["browser","浏览器操作室"],["development","开发工作区"],
        ["delivery","提交交付区"],["dispatch","任务分派台"],["archive","已完成归档区"]
      ];
      const taskActionCsrfToken = ${csrfLiteral};
      const officeReportFeature = ${officeReportFeatureLiteral};
      const officeSceneFeature = ${officeSceneFeatureLiteral};
      const officePlainLanguageFeature = ${officePlainLanguageFeatureLiteral};
      const officeToolOutcomeFeature = ${officeToolOutcomeFeatureLiteral};
      const officeProcessAnimationFeature = ${officeProcessAnimationFeatureLiteral};
      const state = {
        revision: "",
        etag: "",
        data: null,
        request: null,
        requestSequence: 0,
        timer: null,
        snapshotRetry: null,
        pendingFullRefresh: false,
        needsFullRebuild: true,
        destroyed: false,
        offline: !navigator.onLine,
        selectedKey: null,
        initialProject: new URLSearchParams(location.search).get("project") || "",
        projectCatalog: [],
        fingerprints: new Map(),
        actionInFlight: new Set(),
        auxiliaryRequests: new Set(),
        expandedGroups: new Set(),
        projectionIndex: null,
        viewMode: null,
        perspective: officePlainLanguageFeature.enabled ? "boss" : "tech",
        drawerFingerprint: "",
        report: initializeOfficeReportState(),
        scene: initializeOfficeSceneState(),
        toolOutcomes: { source:null, projectId:null, reconnectTimer:null, pollTimer:null, refreshTimer:null, sequences:new Map(), events:new Map(), order:[], status:"idle" },
        dom: {
          projects: new Map(),
          zones: new Map(),
          teamGroups: new Map(),
          objectives: new Map(),
          executors: new Map(),
          devices: new Map(),
          graphNodes: new Map(),
          graphEdges: new Map()
        },
        polling: { skipped: 0, explicit_aborts: 0, network_failures: 0 },
        animations: {
          timers: new Map(),
          writerLocks: new Map(),
          reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          events: []
        }
      };
      const $ = (id) => document.getElementById(id);
      const metrics = $("metrics"), floors = $("floors"), notice = $("notice"), sync = $("syncState");
      const projectFilter = $("projectFilter"), archiveToggle = $("archiveToggle"), testHistoryToggle = $("testHistoryToggle");
      const initialQuery = new URLSearchParams(location.search);
      archiveToggle.checked = ["1","true"].includes((initialQuery.get("include_archived") || "").toLowerCase());
      testHistoryToggle.checked = ["1","true"].includes((initialQuery.get("include_test_history") || "").toLowerCase());
      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : char.charCodeAt(0) === 34 ? "&quot;" : "&#39;");
      const authQuery = () => {
        const source = new URLSearchParams(location.search);
        const value = source.get("codexpro_token") || source.get("token");
        const output = new URLSearchParams();
        if (value) output.set("codexpro_token", value);
        return output;
      };
      const consoleParams = authQuery();
      $("consoleLink").href = "/" + (consoleParams.size ? "?" + consoleParams.toString() : "");
      function setOfficePerspective(view,persist=true){
        const next=view==="tech"&&officePlainLanguageFeature.tech_view_enabled?"tech":"boss";
        state.perspective=next;document.body.classList.toggle("office-tech-view",next==="tech");document.body.dataset.officePerspective=next;
        for(const button of $("officePerspectiveSwitch").querySelectorAll("[data-office-perspective]")){const active=button.dataset.officePerspective===next;button.classList.toggle("active",active);button.setAttribute("aria-pressed",String(active));}
        const technical=$("drawerBody").querySelector(".technical-details");if(technical)technical.open=next==="tech";
        if(persist)try{localStorage.setItem("codexpro.office.perspective",next);}catch{}
        if(state.selectedKey&&state.data)openDrawer(state.selectedKey,false,true);
      }
      function installOfficePerspective(){
        const switcher=$("officePerspectiveSwitch");if(!officePlainLanguageFeature.enabled){switcher.hidden=true;setOfficePerspective("tech",false);return;}
        if(!officePlainLanguageFeature.tech_view_enabled)switcher.querySelector('[data-office-perspective="tech"]')?.remove();
        for(const button of switcher.querySelectorAll("[data-office-perspective]"))button.addEventListener("click",()=>setOfficePerspective(button.dataset.officePerspective));
        let preferred="boss";try{preferred=localStorage.getItem("codexpro.office.perspective")||"boss";}catch{}setOfficePerspective(preferred,false);
      }
      const officeParams = () => {
        const params = authQuery();
        const selectedProject = projectFilter.value || state.initialProject;
        if (selectedProject) params.set("project", selectedProject);
        params.set("include_archived", archiveToggle.checked ? "true" : "false");
        if (testHistoryToggle.checked) params.set("include_test_history", "true");
        params.set("archive_limit", "10");
        params.set("active_limit_per_project", "50");
        return params;
      };
      const timeFormatter = new Intl.DateTimeFormat("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"});
      const timeText = (value) => {
        if (!value) return "未知";
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? timeFormatter.format(date) : "时间无效";
      };
      const relativeTimeText = (value) => {
        const timestamp=Date.parse(value||"");if(!Number.isFinite(timestamp))return "时间暂时无法确认";const seconds=Math.max(0,Math.floor((Date.now()-timestamp)/1000));
        if(seconds<10)return "刚刚";if(seconds<60)return seconds+" 秒前";const minutes=Math.floor(seconds/60);if(minutes<60)return minutes+" 分钟前";const hours=Math.floor(minutes/60);if(hours<24)return hours+" 小时前";return Math.floor(hours/24)+" 天前";
      };
      const metric = (label, value, attention=false) => '<div class="metric '+(attention?'attn':'')+'"><b>'+escapeHtml(value)+'</b><span>'+escapeHtml(label)+'</span></div>';
      const CLIENT_STATUS_LABELS = {active:"运行中",waiting:"需关注",incident:"有异常",idle:"空闲",unknown:"状态待确认",fresh:"进展正常",quiet:"暂时没有新进展",stalled:"疑似停滞",severe:"长时间没有新进展",running:"正在执行",completed:"已完成",failed:"执行失败",cancelled:"已取消",passed:"已通过",not_requested:"尚未开始",committed:"已本地提交",pushed:"已同步远端",validating:"正在验收",recovering:"正在恢复",queued:"正在排队",terminal:"已经结束",stopped:"已经停止"};
      const clientStatus = (value,fallback="状态待识别") => CLIENT_STATUS_LABELS[String(value||"").toLowerCase()] || fallback;
      function projectionIntegrityError(data) {
        const revision=String(data?.revision||""),projectionId=String(data?.projection_id||"");
        if(!revision||!projectionId||revision!==projectionId)return "办公室主快照版本不一致，已拒绝混合展示。";
        const visual=data?.visual_snapshot;
        if(visual&&(String(visual.projection_revision||"")!==revision||String(visual.projection_id||"")!==projectionId))return "动画办公室与状态看板版本不一致，已拒绝混合展示。";
        if(visual?.projects?.some((project)=>String(project.projection_revision||"")!==revision))return "动画项目快照版本不一致，已拒绝混合展示。";
        return null;
      }
      function snapshotHealth(data) {
        const observability=data?.snapshot_observability||{},age=Number(observability.age_ms),fresh=Number(observability.fresh_for_ms||4000);
        const stale=Number.isFinite(age)&&age>Math.max(10000,fresh*2);
        const refreshError=String(observability.last_refresh_error||"").trim();
        const violations=Array.isArray(data?.consistency?.violations)?data.consistency.violations:[];
        return {stale:stale||Boolean(refreshError),refreshError,violations,inconsistent:data?.consistency?.ok===false||violations.length>0};
      }
      function renderMetrics(data) {
        const summary=data.objective_summary||{},attention=data.attention_summary||{},health=snapshotHealth(data);
        const system=health.inconsistent?"投影异常":health.stale?"状态过期":summary.unresolved_incidents>0?"存在异常":summary.waiting_user>0?"需要关注":summary.recovering>0?"正在恢复":"运行正常";
        const systemAttention=health.inconsistent||health.stale||summary.unresolved_incidents>0;
        metrics.innerHTML = [
          metric("当前目标",summary.current??attention.total_objectives??0),metric("正在执行",summary.executing||0),metric("等待老板",summary.waiting_user||0,summary.waiting_user>0),
          metric("自动恢复",summary.recovering||0),metric("未解决异常",summary.unresolved_incidents||0,systemAttention),
          metric("今日完成",summary.completed_today||0),metric("待交付",summary.pending_delivery||0),metric("系统状态",system,systemAttention)
        ].join("");
      }
      function renderCapabilityRegistry(data) {
        const registry=data.capability_registry,root=$("capabilityRegistry"),body=$("capabilityRegistryBody");
        if(!registry||!Array.isArray(registry.capabilities)){root.hidden=true;return;}
        root.hidden=false;$("capabilityRegistrySummary").textContent="办公室能力目录 · "+registry.count+" 项 · "+registry.tool_mode+" 模式";
        const groups=new Map();for(const capability of registry.capabilities){const zone=capability.office_zone||"项目控制台";if(!groups.has(zone))groups.set(zone,[]);groups.get(zone).push(capability);}
        body.innerHTML=[...groups.entries()].map(([zone,items])=>'<section class="capability-zone"><h3>'+escapeHtml(zone)+' · '+items.length+' 项</h3><div class="capability-grid">'+items.map((item)=>'<article class="capability-card"><b>'+escapeHtml(item.display_name_cn)+'</b><span>'+escapeHtml(item.plain_description_cn)+'</span><span>角色：'+escapeHtml(item.office_role)+' · 操作：'+escapeHtml(item.operation_type)+' · 副作用：'+escapeHtml(item.side_effect_level)+'</span><span>审批：'+(item.approval_required?'需要':'不需要')+' · 工作区代次：'+(item.workspace_generation_required?'必须':'兼容读取')+' · 可用：'+(item.available?'是':'否')+'</span><span>原始工具名：'+escapeHtml(item.tool_name)+' · 输入 '+escapeHtml(item.input_schema_version)+' · 输出 '+escapeHtml(item.output_schema_version)+'</span></article>').join('')+'</div></section>').join('');
      }
      function writerText(writer) {
        const age = writer.age_ms === null ? "" : " · 已持有 "+Math.floor(writer.age_ms/1000)+" 秒";
        const waiting = writer.waiting_count ? " · 等待 "+writer.waiting_count+" 个" : "";
        const stale = writer.stale ? " · 写入占用异常" : "";
        if (writer.state === "active") return "文件写入台正在使用"+age+waiting+stale;
        if (writer.state === "queued") return "文件写入正在排队"+(writer.queue_position ? " · 第 "+writer.queue_position+" 位" : "")+waiting;
        return writer.state === "idle" ? "文件写入台空闲" : "文件写入状态待确认";
      }
      function projectResourceText(project) {
        const value = project.resource_summary;
        return "项目"+clientStatus(project.floor_status)+" · 写入 "+value.writers+" · 只读 "+value.readers+" · 浏览器 "+value.browsers+" · 验收 "+value.validations+" · 排队 "+value.queue_length+(value.stale_writer_leases ? " · 写入异常 "+value.stale_writer_leases : "");
      }
      function executorHtml(executor) {
        const flags = [executor.read_write_mode === "writer" ? "写入" : executor.read_write_mode === "read_only" ? "只读" : "",executor.browser?"浏览器":"",executor.validation?"验收":""].filter(Boolean).join("/");
        return '<span class="person"><span class="dot '+escapeHtml(executor.state)+'"></span>'+escapeHtml(executor.label)+(flags?' · '+escapeHtml(flags):'')+'</span>';
      }
      function deviceHtml(device) {
        const icon = device.device_kind === "browser" ? "▣" : device.device_kind === "acceptance" ? "✓" : device.device_kind === "writer_lease" ? "✎" : "◇";
        return '<span class="device-chip" title="'+escapeHtml(device.evidence_source)+'"><span class="device-icon">'+icon+'</span><span class="dot '+escapeHtml(device.state)+'"></span>'+escapeHtml(device.label)+'</span>';
      }
      const stableFingerprint = (value) => JSON.stringify(value);
      function projectionIndex(data) {
        const index = { projects:new Map(), teamGroups:new Map(), objectives:new Map(), executors:new Map(), devices:new Map(), graphNodes:new Map(), graphEdges:new Map() };
        for (const project of data.projects || []) {
          index.projects.set(project.project_id, { value:project, fingerprint:stableFingerprint(project) });
          for (const [zoneKey] of ZONES) {
            for (const group of project.zone_layouts?.[zoneKey]?.groups || []) {
              const key=teamGroupRegistryKey(project.project_id,group.group_id); index.teamGroups.set(key,{value:group,fingerprint:stableFingerprint(group)});
            }
            for (const objective of project.zones[zoneKey] || []) {
              index.objectives.set(objective.stable_key, { value:objective, project_id:project.project_id, zone:zoneKey, fingerprint:stableFingerprint(objective) });
              for (const executor of objective.executors || []) index.executors.set(objective.stable_key+"\u0000"+executor.executor_id, {value:executor,fingerprint:stableFingerprint(executor)});
              for (const device of objective.devices || []) index.devices.set(objective.stable_key+"\u0000"+device.device_id, {value:device,fingerprint:stableFingerprint(device)});
              for (const node of objective.execution_graph?.nodes || []) index.graphNodes.set(objective.stable_key+"\u0000"+node.node_id, {value:node,fingerprint:stableFingerprint(node)});
              for (const edge of objective.execution_graph?.edges || []) index.graphEdges.set(objective.stable_key+"\u0000"+edge.edge_id, {value:edge,fingerprint:stableFingerprint(edge)});
            }
          }
        }
        return index;
      }
      function projectionDiff(previous, next) {
        const output = { added:[], updated:[], moved:[], deleted:[], writerLeaseChanged:[], graphAuthorityDropped:[] };
        if (!previous) {
          output.added = [...next.objectives.keys()];
          return output;
        }
        for (const [key,current] of next.objectives) {
          const prior = previous.objectives.get(key);
          if (!prior) output.added.push(key);
          else if (prior.zone !== current.zone || prior.project_id !== current.project_id) output.moved.push(key);
          else if (prior.fingerprint !== current.fingerprint) output.updated.push(key);
          const oldAuthority = prior?.value?.execution_graph?.authority;
          const newAuthority = current.value?.execution_graph?.authority;
          if (oldAuthority === "explicit" && newAuthority !== "explicit") output.graphAuthorityDropped.push(key);
        }
        for (const key of previous.objectives.keys()) if (!next.objectives.has(key)) output.deleted.push(key);
        for (const [key,current] of next.projects) {
          const prior = previous.projects.get(key);
          if (prior && stableFingerprint(prior.value.writer_lease) !== stableFingerprint(current.value.writer_lease)) output.writerLeaseChanged.push(key);
        }
        return output;
      }
      function semanticProgress(objective) {
        return stableFingerprint({
          phase:objective.current_attempt?.phase ?? null,
          action:objective.current_attempt?.action ?? null,
          step:objective.current_attempt?.progress?.current ?? null,
          total:objective.current_attempt?.progress?.total ?? null,
          components:(objective.components || []).map((item)=>[item.component_id,item.status,item.progress_marker]).sort(),
          graph:(objective.execution_graph?.nodes || []).map((item)=>[item.node_id,item.state,item.transition_reason,item.attempt]).sort()
        });
      }
      function semanticQueue(objective) {
        return stableFingerprint({
          status:objective.current_attempt?.resource?.status ?? null,
          position:objective.current_attempt?.resource?.queue_position ?? objective.writer_lease?.queue_position ?? null,
          reasons:[...(objective.current_attempt?.resource?.blocking_reasons || [])].sort(),
          waiting:objective.writer_lease?.waiting_count ?? null
        });
      }
      function semanticWriter(objective) {
        const writer=objective.writer_lease || {};
        return stableFingerprint({state:writer.state,holder:writer.holder_task_id,fence:writer.fence,position:writer.queue_position,stale:writer.stale});
      }
      function semanticStale(objective) {
        return stableFingerprint({incident_state:objective.current_attempt?.incident_state ?? null,owner_alive:objective.current_attempt?.observability?.owner_alive ?? null,liveness:objective.current_attempt?.liveness ?? null,devices:(objective.devices || []).filter((item)=>item.state==="stale").map((item)=>item.device_id).sort()});
      }
      function semanticRecovery(objective) {
        return stableFingerprint({zone:objective.zone==="recovering",recovering:objective.current_attempt?.observability?.recovering ?? false,from:objective.current_attempt?.observability?.recovery_from_run_id ?? null});
      }
      function semanticGit(objective) {
        return stableFingerprint({validation:objective.current_attempt?.validation_status ?? null,delivery:objective.current_attempt?.delivery_status ?? null,commit:objective.current_attempt?.git?.commit_status ?? null,push:objective.current_attempt?.git?.push_status ?? null,git_delivery:objective.current_attempt?.git?.delivery_status ?? null,reason:objective.current_attempt?.git?.reason_code ?? null});
      }
      function mapBy(values,key) { const output=new Map(); for (const value of values || []) if (value?.[key]) output.set(value[key],value); return output; }
      function animationSignal(kind,objective,entityId=null) { return {kind,objective_key:objective.stable_key,project_id:objective.project_id,entity_id:entityId}; }
      function animationSignals(previous,next) {
        if (!previous) return [];
        const output=[];
        if (previous.zone!==next.zone) {
          output.push(animationSignal("objective_move",next));
          const beforeIds=(previous.executors || []).map((item)=>item.executor_id).sort();
          const afterIds=(next.executors || []).map((item)=>item.executor_id).sort();
          if (afterIds.length && stableFingerprint(beforeIds)===stableFingerprint(afterIds)) output.push(animationSignal("person_follow",next,afterIds.join(",")));
        }
        if (semanticProgress(previous)!==semanticProgress(next)) output.push(animationSignal("progress",next));
        if (previous.requires_human!==true && next.requires_human===true) output.push(animationSignal("human_wait",next));
        if (semanticQueue(previous)!==semanticQueue(next)) output.push(animationSignal("queue",next));
        const oldDevices=mapBy(previous.devices,"device_id");
        for (const device of next.devices || []) {
          const old=oldDevices.get(device.device_id);
          if ((device.device_kind==="browser" || device.device_kind==="acceptance") && old?.state!==device.state) output.push(animationSignal(device.device_kind,next,device.device_id));
        }
        if (semanticWriter(previous)!==semanticWriter(next)) output.push(animationSignal("writer_lease",next,next.writer_lease?.holder_task_id || null));
        if (semanticStale(previous)!==semanticStale(next)) output.push(animationSignal("stale",next));
        if (semanticRecovery(previous)!==semanticRecovery(next)) output.push(animationSignal("recovery",next));
        const oldNodes=mapBy(previous.execution_graph?.nodes,"node_id");
        for (const graphNode of next.execution_graph?.nodes || []) {
          const old=oldNodes.get(graphNode.node_id);
          if (stableFingerprint(old ? [old.state,old.transition_reason,old.attempt] : null)!==stableFingerprint([graphNode.state,graphNode.transition_reason,graphNode.attempt])) output.push(animationSignal("graph_node",next,graphNode.node_id));
        }
        const oldEdges=mapBy(previous.execution_graph?.edges,"edge_id");
        for (const edge of next.execution_graph?.edges || []) {
          const old=oldEdges.get(edge.edge_id);
          if (edge.edge_kind==="branch" && edge.selected===true && old?.selected!==true) output.push(animationSignal("branch",next,edge.edge_id));
          if (edge.edge_kind==="parallel" && stableFingerprint(old ? [old.relation_group,old.dependency_satisfied] : null)!==stableFingerprint([edge.relation_group,edge.dependency_satisfied])) output.push(animationSignal("parallel",next,edge.edge_id));
          if (edge.edge_kind==="join" && (old?.dependency_satisfied===true)!==(edge.dependency_satisfied===true)) output.push(animationSignal("join",next,edge.edge_id));
        }
        if (semanticGit(previous)!==semanticGit(next)) output.push(animationSignal("git_delivery",next));
        const delivered=["pushed","completed","delivered"].includes(next.current_attempt?.git?.delivery_status || next.current_attempt?.delivery_status || "");
        if (previous.zone!=="archive" && next.zone==="archive" && delivered) output.push(animationSignal("archive",next));
        return output;
      }
      function animationEvent(objective,message) {
        const node=state.dom.objectives.get(objective.stable_key); if (!node) return;
        const event=node.querySelector("[data-objective-event]"); if (!event) return;
        event.textContent=message; event.classList.add("show"); animateOnce(event,"anim-event",700);
        const key="event:"+objective.stable_key; clearTimeout(state.animations.timers.get(key));
        state.animations.timers.set(key,setTimeout(()=>{event.classList.remove("show","anim-event");event.textContent="";state.animations.timers.delete(key);},2600));
        state.animations.events.push({objective_key:objective.stable_key,message});
        if (state.animations.events.length>50) state.animations.events.shift();
      }
      function animateOnce(element,className,duration=850,writerProject=null) {
        if (!element) return false;
        if (writerProject && state.animations.writerLocks.has(writerProject)) return false;
        const key=className+":"+(element.dataset.objectiveKey || element.dataset.executorKey || element.dataset.deviceKey || element.dataset.graphNodeKey || element.dataset.graphEdgeKey || writerProject || "element");
        try {
          clearTimeout(state.animations.timers.get(key)); element.classList.remove(className); void element.offsetWidth; element.classList.add(className);
          if (writerProject) state.animations.writerLocks.set(writerProject,key);
          state.animations.timers.set(key,setTimeout(()=>{element.classList.remove(className);state.animations.timers.delete(key);if(writerProject && state.animations.writerLocks.get(writerProject)===key)state.animations.writerLocks.delete(writerProject);},duration));
          return true;
        } catch { return false; }
      }
      function captureObjectiveRects(diff) {
        const positions=new Map();
        for (const key of diff.moved) { const node=state.dom.objectives.get(key); if (node) positions.set(key,node.getBoundingClientRect()); }
        return positions;
      }
      function animateObjectiveMove(node,oldRect) {
        if (!node || !oldRect) return;
        const nextRect=node.getBoundingClientRect(),dx=oldRect.left-nextRect.left,dy=oldRect.top-nextRect.top;
        if (!state.animations.reducedMotion && (Math.abs(dx)>1 || Math.abs(dy)>1) && typeof node.animate==="function") {
          try { node.animate([{transform:"translate("+dx+"px,"+dy+"px)"},{transform:"translate(0,0)"}],{duration:520,easing:"ease-out",iterations:1}); }
          catch { animateOnce(node,"anim-objective-move",620); }
        } else animateOnce(node,"anim-objective-move",620);
      }
      function graphEntity(objectiveKey,entityId,registry) { return registry.get(objectiveKey+"\u0000"+entityId); }
      function applyProjectionAnimations(previous,next,diff,oldRects,full) {
        if (full || !previous) return;
        for (const key of diff.added) { const item=next.objectives.get(key); if (item) animateOnce(state.dom.objectives.get(key),"anim-objective-enter",620); }
        for (const [key,current] of next.objectives) {
          const prior=previous.objectives.get(key); if (!prior) continue;
          const objective=current.value,node=state.dom.objectives.get(key),signals=animationSignals(prior.value,objective);
          for (const signal of signals) {
            if (signal.kind==="objective_move") { animateObjectiveMove(node,oldRects.get(key)); animationEvent(objective,"任务已进入“"+objective.zone_reason+"”"); }
            else if (signal.kind==="person_follow") for (const [executorKey,executorNode] of state.dom.executors) if (executorKey.startsWith(key+"\u0000")) animateOnce(executorNode,"anim-person-follow",620);
            else if (signal.kind==="progress") { animateOnce(node,"anim-progress",800); animationEvent(objective,objective.current_attempt?.action || objective.summary || "真实进展已更新"); }
            else if (signal.kind==="human_wait") { animateOnce(node,"anim-human-wait",760); animationEvent(objective,"需要老板处理"); }
            else if (signal.kind==="queue") { animateOnce(node,"anim-queue",620); animationEvent(objective,"资源排队位置或阻塞原因已更新"); }
            else if (signal.kind==="browser") {
              const device=graphEntity(key,signal.entity_id,state.dom.devices),active=(objective.devices || []).find((item)=>item.device_id===signal.entity_id)?.state==="active";
              animateOnce(device,active?"anim-browser":"anim-browser-stop",720); animationEvent(objective,active?"浏览器设备开始活动":"浏览器设备活动结束");
            } else if (signal.kind==="acceptance") {
              const device=graphEntity(key,signal.entity_id,state.dom.devices),status=objective.current_attempt?.validation_status || objective.current_attempt?.acceptance_status || "";
              const className=status==="failed"?"anim-acceptance-fail":status==="passed"?"anim-acceptance-pass":"anim-acceptance-start";
              animateOnce(device,className,760); animationEvent(objective,status==="failed"?"验收失败":status==="passed"?"验收通过":"验收开始");
            } else if (signal.kind==="writer_lease") {
              const projectNode=state.dom.projects.get(objective.project_id),writer=projectNode?.querySelector(".writer"),writerState=objective.writer_lease?.stale?"expired":objective.writer_lease?.state || "released";
              const className=writerState==="active"?"anim-writer-acquired":writerState==="queued"?"anim-writer-queued":writerState==="expired"?"anim-writer-expired":"anim-writer-released";
              if (animateOnce(writer,className,820,objective.project_id)) animationEvent(objective,"写入工位状态："+writerText(objective.writer_lease));
            } else if (signal.kind==="stale") { const incident=objective.current_attempt?.incident_state;animateOnce(node,"anim-stale",640);animationEvent(objective,incident==="blocked"?"任务已阻塞":incident==="stalled"?"任务疑似停滞":incident==="orphaned"?"后台执行已失联":incident==="failed"?"任务执行失败":"执行存活证据发生变化"); }
            else if (signal.kind==="recovery") { animateOnce(node,"anim-recovery",700); animationEvent(objective,"任务恢复状态已更新"); }
            else if (signal.kind==="graph_node") {
              const graphNode=graphEntity(key,signal.entity_id,state.dom.graphNodes),model=(objective.execution_graph?.nodes || []).find((item)=>item.node_id===signal.entity_id),reason=(model?.transition_reason || "").toLowerCase();
              const className=reason.includes("retry")||reason.includes("重试")?"anim-retry":reason.includes("handoff")||reason.includes("交接")?"anim-handoff":model?.state==="terminal"?"anim-graph-complete":"anim-graph-node";
              animateOnce(graphNode,className,760);
            } else if (signal.kind==="branch") animateOnce(graphEntity(key,signal.entity_id,state.dom.graphEdges),"anim-branch-selected",780);
            else if (signal.kind==="parallel") {
              const edge=(objective.execution_graph?.edges || []).find((item)=>item.edge_id===signal.entity_id); animateOnce(graphEntity(key,signal.entity_id,state.dom.graphEdges),"anim-parallel",780);
              if (edge) { animateOnce(graphEntity(key,edge.from_node_id,state.dom.graphNodes),"anim-graph-node",720); animateOnce(graphEntity(key,edge.to_node_id,state.dom.graphNodes),"anim-graph-node",720); }
            } else if (signal.kind==="join") animateOnce(graphEntity(key,signal.entity_id,state.dom.graphEdges),"anim-join-ready",780);
            else if (signal.kind==="git_delivery") {
              const failed=objective.current_attempt?.git?.push_status==="failed" || objective.current_attempt?.delivery_status==="failed";
              if (animateOnce(node,failed?"anim-git-fail":"anim-git-delivery",760,objective.project_id)) animationEvent(objective,failed?"Git 交付失败":"Git 交付状态已更新");
            } else if (signal.kind==="archive") { animateOnce(node,"anim-archive",760); animationEvent(objective,"真实交付完成，任务已归档"); }
          }
        }
      }
      function updateProjectCatalog(data) {
        const previousSelection = projectFilter.value || state.initialProject;
        if (!previousSelection && data.projects.length) state.projectCatalog = data.projects.map((project) => ({project_id:project.project_id,name:project.name}));
        const catalog = state.projectCatalog.length ? state.projectCatalog : data.projects.map((project) => ({project_id:project.project_id,name:project.name}));
        const desired = new Set(["", ...catalog.map((project) => project.project_id)]);
        for (const option of [...projectFilter.options]) if (!desired.has(option.value)) option.remove();
        if (![...projectFilter.options].some((option) => option.value === "")) projectFilter.add(new Option("全部项目 · 楼层总览", ""), 0);
        for (const project of catalog) {
          let option = [...projectFilter.options].find((candidate) => candidate.value === project.project_id);
          if (!option) { option = new Option(project.name, project.project_id); projectFilter.add(option); }
          else option.textContent = project.name;
        }
        if ([...projectFilter.options].some((option) => option.value === previousSelection)) projectFilter.value = previousSelection;
        state.initialProject = projectFilter.value;
      }
      function clearDomRegistries() {
        for (const timer of state.animations.timers.values()) clearTimeout(timer);
        state.animations.timers.clear(); state.animations.writerLocks.clear();
        for (const registry of Object.values(state.dom)) registry.clear();
        state.fingerprints.clear();
        state.drawerFingerprint = "";
      }
      function removeRegistryPrefix(registry, prefix, desired) {
        for (const [key,node] of [...registry.entries()]) if (key.startsWith(prefix) && !desired.has(key)) { node.remove(); registry.delete(key); }
      }
      function patchExecutorList(objective, container) {
        const prefix = objective.stable_key+"\u0000";
        const desired = new Set();
        for (const executor of (objective.executors || []).slice(0,4)) {
          const key = prefix+executor.executor_id; desired.add(key);
          let node = state.dom.executors.get(key);
          if (!node) {
            node = document.createElement("span"); node.className = "person"; node.dataset.executorKey = key;
            node.innerHTML = '<span class="dot"></span><span data-person-label></span>';
            state.dom.executors.set(key,node);
          }
          const flags = [executor.read_write_mode === "writer" ? "写入" : executor.read_write_mode === "read_only" ? "只读" : "",executor.browser?"浏览器":"",executor.validation?"验收":""].filter(Boolean).join("/");
          node.className = "person "+executor.state+(executor.read_write_mode==="writer"?" person-writer":"")+(executor.browser?" person-browser":"")+(executor.validation?" person-validation":"");
          node.querySelector(".dot").className = "dot "+executor.state;
          node.querySelector("[data-person-label]").textContent = executor.label+(flags?" · "+flags:"");
          node.title = objective.plain_summary?.current_work || "查看当前任务";
          container.appendChild(node);
        }
        removeRegistryPrefix(state.dom.executors,prefix,desired);
        container.hidden = desired.size === 0;
      }
      function patchDeviceList(objective, container) {
        const prefix = objective.stable_key+"\u0000";
        const desired = new Set();
        for (const device of (objective.devices || []).slice(0,4)) {
          const key = prefix+device.device_id; desired.add(key);
          let node = state.dom.devices.get(key);
          if (!node) {
            node = document.createElement("span"); node.className = "device-chip"; node.dataset.deviceKey = key;
            node.innerHTML = '<span class="device-icon"></span><span class="dot"></span><span data-device-label></span>';
            state.dom.devices.set(key,node);
          }
          node.className = "device-chip device-"+device.device_kind+" "+device.state;
          node.querySelector(".device-icon").textContent = device.device_kind === "browser" ? "▣" : device.device_kind === "acceptance" ? "✓" : device.device_kind === "writer_lease" ? "✎" : "◇";
          node.querySelector(".dot").className = "dot "+device.state;
          node.querySelector("[data-device-label]").textContent = device.device_kind === "browser" ? "浏览器操作" : device.device_kind === "acceptance" ? "测试验收" : device.device_kind === "writer_lease" ? "文件写入" : "后台步骤";
          node.title = objective.plain_summary?.current_work || "查看设备状态";
          container.appendChild(node);
        }
        removeRegistryPrefix(state.dom.devices,prefix,desired);
        container.hidden = desired.size === 0;
      }
      function createObjectiveNode(objective) {
        const node = document.createElement("button");
        node.type = "button"; node.className = "objective"; node.dataset.objectiveKey = objective.stable_key;
        node.innerHTML = '<div class="obj-top"><span class="obj-title"></span><span class="sub" data-objective-time></span></div><div class="obj-state-grid"><div class="obj-state"><span>任务状态</span><b data-objective-goal-state></b></div><div class="obj-state"><span>现在正在做</span><b data-objective-executor-state></b></div><div class="obj-state"><span>最近更新时间</span><b data-objective-progress-time></b></div></div><div class="obj-current"><span>最新完成</span><strong data-objective-current-action></strong></div><div class="badges"></div><div class="obj-summary"></div><div class="state-event" data-objective-event aria-live="polite"></div><div class="executors" data-objective-executors></div><div class="devices" data-objective-devices></div>';
        node.addEventListener("click",()=>openDrawer(objective.stable_key));
        state.dom.objectives.set(objective.stable_key,node);
        return node;
      }
      function patchObjectiveNode(objective) {
        const node = state.dom.objectives.get(objective.stable_key) || createObjectiveNode(objective);
        const attempt = objective.current_attempt;
        const fingerprint = stableFingerprint(objective);
        const changed = state.fingerprints.has(objective.stable_key) && state.fingerprints.get(objective.stable_key) !== fingerprint;
        state.fingerprints.set(objective.stable_key,fingerprint);
        node.classList.toggle("changed",changed);
        node.classList.toggle("is-human-wait",objective.user_action_required?.required===true);
        node.classList.toggle("is-stale",objective.activity_state==="stalled" || objective.current_attempt?.observability?.owner_alive===false || objective.current_attempt?.liveness==="stale");
        node.classList.toggle("is-recovering",objective.zone==="recovering");
        node.classList.toggle("is-archived",objective.zone==="archive");
        node.classList.toggle("is-delivery",objective.zone==="delivery");
        for(const incident of ["blocked","stalled","orphaned","failed","waiting_approval"])node.classList.toggle("incident-"+incident,attempt?.incident_state===incident);
        node.querySelector(".obj-title").textContent = objective.title;
        node.querySelector("[data-objective-time]").textContent = timeText(objective.updated_at);
        const plain=objective.plain_summary||{};
        node.querySelector("[data-objective-goal-state]").textContent = plain.task_status || clientStatus(objective.objective_status);
        node.querySelector("[data-objective-executor-state]").textContent = plain.current_work || "执行步骤待识别";
        node.querySelector("[data-objective-progress-time]").textContent = timeText(objective.last_meaningful_progress_at);
        node.querySelector("[data-objective-current-action]").textContent = plain.latest_result || "尚无新的已完成结果";
        const reportUnread = reportFeatureEnabled({project_id:objective.project_id,name:objective.project_name}) ? reportUnreadCount(objective) : 0;
        node.querySelector(".badges").innerHTML = [
          attempt?.validation_status && attempt.validation_status !== "not_requested" ? '<span class="badge">'+escapeHtml(plain.validation_status||"测试验收状态待识别")+'</span>' : '',
          attempt?.delivery_status && attempt.delivery_status !== "not_requested" ? '<span class="badge">'+escapeHtml(plain.delivery_status||"代码交付状态待识别")+'</span>' : '',
          objective.user_action_required?.required ? '<span class="badge human-hand" aria-label="等待用户处理">✋ '+escapeHtml(objective.user_action_required.label)+'</span>' : '',
          objective.no_progress_level === "quiet" ? '<span class="badge">暂无新证据</span>' : '',
          ["stalled","severe"].includes(objective.no_progress_level) ? '<span class="badge hot">疑似停滞</span>' : '',
          attempt?.incident_state ? '<span class="badge hot">'+escapeHtml({blocked:"任务阻塞",stalled:"任务停滞",orphaned:"后台失联",failed:"执行失败",waiting_approval:"等待审批"}[attempt.incident_state]||attempt.incident_state)+'</span>' : '',
          attempt?.safe_to_close_chat?.safe ? '<span class="badge">可关闭聊天</span>' : attempt ? '<span class="badge hot">依赖当前对话</span>' : '',
          attempt?.resource?.queue_position ? '<span class="badge">排队第 '+escapeHtml(attempt.resource.queue_position)+' 位</span>' : '',
          '<span class="badge">已执行 '+objective.attempt_count+' 次</span>',
          reportUnread ? '<span class="badge hot">回报未读 '+escapeHtml(reportUnread)+'</span>' : ''
        ].join("");
        node.querySelector(".obj-summary").textContent = objective.requires_human ? plain.owner_action : plain.risk_status;
        patchExecutorList(objective,node.querySelector("[data-objective-executors]"));
        patchDeviceList(objective,node.querySelector("[data-objective-devices]"));
        return node;
      }
      function createOverviewNode(project) {
        const node = document.createElement("article"); node.className = "floor-card"; node.dataset.projectSummary = project.project_id;
        state.dom.projects.set(project.project_id,node); return node;
      }
      function overviewMiniScene(project,visualProject){if(!visualProject)return "";const actors=(visualProject.actors||[]).slice(0,3),figures=actors.map((actor)=>'<span class="floor-mini-actor" data-mini-actor="'+escapeHtml(actor.actor_id)+'" title="'+escapeHtml(actor.label+" · "+(actor.action||"状态已同步"))+'">'+officeAgentSvg(actor.identity)+'</span>').join("");const counts='等待老板 '+project.counts.waiting_user+' · 异常 '+project.counts.incident+' · 浏览器 '+project.resource_summary.browsers+' · 写入 '+project.resource_summary.writers;return '<div class="floor-mini-scene" data-mini-scene="'+escapeHtml(project.project_id)+'" aria-label="轻量智能体摘要，最多三个">'+figures+'<span class="floor-mini-counts">'+escapeHtml(counts)+'</span></div>';}
      function patchProjectOverview(project,container,visualProject=null) {
        const node = state.dom.projects.get(project.project_id) || createOverviewNode(project);
        const reportEnabled = reportFeatureEnabled(project);
        const reportText = reportEnabled ? projectReportSummaryText(project) : "";
        const miniScene = overviewMiniScene(project,visualProject);
        const fingerprint = stableFingerprint([project.name,project.floor_status,project.branch,project.git_summary,project.counts,project.resource_summary,project.writer_lease,project.workspace_conflict,project.workspace_generation,project.current_task_id,reportText,miniScene]);
        if (node.dataset.fingerprint !== fingerprint) {
          const pills = ZONES.filter(([key]) => project.counts[key] > 0).map(([key,label]) => '<span class="zone-pill '+(["waiting_user","incident"].includes(key)?'hot':'')+'">'+escapeHtml(label)+' '+project.counts[key]+'</span>').join("");
          node.className = "floor-card "+project.floor_status;
          node.innerHTML = '<div class="floor-card-head"><div><h2>'+escapeHtml(project.name)+'</h2><div class="floor-meta technical-only">分支 '+escapeHtml(project.branch || "未知")+' · '+escapeHtml(project.git_summary || "代码状态未知")+' · 工作区 '+escapeHtml(project.workspace_id||"未知")+' / 第 '+escapeHtml(project.workspace_generation??"?")+' 代</div></div><span class="floor-status">'+escapeHtml(clientStatus(project.floor_status))+'</span></div>'+(project.workspace_conflict?'<div class="workspace-conflict show">工作区绑定冲突：已停止投影可变更操作，请先重新打开当前项目。</div>':'')+'<div class="zone-strip">'+(pills || '<span class="zone-pill">当前无活动任务</span>')+'</div><div class="floor-meta">'+escapeHtml(projectResourceText(project))+'</div><div class="floor-meta">'+escapeHtml(writerText(project.writer_lease))+'</div>'+miniScene+(reportEnabled?'<div class="floor-report"><b>最新任务回报</b>'+escapeHtml(reportText)+'</div>':'')+'<div class="floor-card-actions"><button class="btn primary" type="button" data-enter-project="'+escapeHtml(project.project_id)+'">进入智能体办公室</button></div>';
          node.dataset.fingerprint = fingerprint;
        }
        container.appendChild(node);
      }
      function teamGroupRegistryKey(projectId,groupId) { return projectId+"::"+groupId; }
      function fallbackZoneLayout(zoneKey,items) {
        return {version:1,zone:zoneKey,mode:items.length<=6?"regular":items.length<=12?"compact":"grouped",objective_count:items.length,pinned_objective_keys:[],groups:[],collapsed_objective_count:0};
      }
      function createTeamGroup(project,group) {
        const registryKey=teamGroupRegistryKey(project.project_id,group.group_id);
        const node=document.createElement("section"); node.className="team-group"; node.dataset.teamGroupKey=registryKey;
        node.innerHTML='<button type="button" class="team-group-head" data-team-group-toggle="'+escapeHtml(registryKey)+'"><span><span class="team-group-title" data-team-title></span><span class="team-group-meta" data-team-meta></span></span><span class="btn team-group-toggle" data-team-toggle-label></span></button><div class="team-group-stats" data-team-stats></div><div class="team-group-body" data-team-body></div>';
        state.dom.teamGroups.set(registryKey,node); return node;
      }
      function patchTeamGroup(project,group,objectiveMap) {
        const registryKey=teamGroupRegistryKey(project.project_id,group.group_id);
        const node=state.dom.teamGroups.get(registryKey)||createTeamGroup(project,group);
        const expanded=state.expandedGroups.has(registryKey);
        node.setAttribute("aria-expanded",String(expanded));
        node.classList.toggle("attention",group.incident_count>0||group.waiting_count>0||group.writer_count>0);
        node.querySelector("[data-team-title]").textContent=group.label;
        node.querySelector("[data-team-meta]").textContent=" · "+group.objective_count+" 个真实任务 · "+group.evidence_refs.length+" 条状态依据";
        node.querySelector("[data-team-toggle-label]").textContent=expanded?"收起":"展开";
        node.querySelector("[data-team-stats]").innerHTML=[
          ["任务",group.objective_count],["活跃智能体",group.active_executor_count],["写入者",group.writer_count],
          ["只读",group.reader_count],["异常",group.incident_count],["等待",group.waiting_count]
        ].map(([label,value])=>'<div class="team-stat"><b>'+escapeHtml(value)+'</b>'+escapeHtml(label)+'</div>').join("");
        const body=node.querySelector("[data-team-body]");
        if (expanded) {
          for (const objectiveKey of group.objective_keys) {
            const objective=objectiveMap.get(objectiveKey); if (objective) body.appendChild(patchObjectiveNode(objective));
          }
        } else body.replaceChildren();
        node.dataset.fingerprint=stableFingerprint([group,expanded]);
        return node;
      }
      function patchZoneItems(project,zoneKey,zone,itemsContainer,items) {
        const layout=project.zone_layouts?.[zoneKey]||fallbackZoneLayout(zoneKey,items);
        zone.dataset.density=layout.mode;
        zone.querySelector("[data-zone-density]").textContent=layout.mode==="compact"?"紧凑":layout.mode==="grouped"?"团队组":"常规";
        const objectiveMap=new Map(items.map((objective)=>[objective.stable_key,objective]));
        const rendered=new Set();
        if (layout.mode!=="grouped") {
          for (const objective of items) { const objectiveNode=patchObjectiveNode(objective); objectiveNode.classList.remove("pinned-objective"); itemsContainer.appendChild(objectiveNode); rendered.add(objective.stable_key); }
        } else {
          for (const objectiveKey of layout.pinned_objective_keys||[]) {
            const objective=objectiveMap.get(objectiveKey); if (!objective) continue;
            const objectiveNode=patchObjectiveNode(objective); objectiveNode.classList.add("pinned-objective"); itemsContainer.appendChild(objectiveNode); rendered.add(objectiveKey);
          }
          const desiredGroups=new Set();
          for (const group of layout.groups||[]) {
            const registryKey=teamGroupRegistryKey(project.project_id,group.group_id); desiredGroups.add(registryKey);
            itemsContainer.appendChild(patchTeamGroup(project,group,objectiveMap));
            for (const objectiveKey of group.objective_keys) rendered.add(objectiveKey);
          }
          removeRegistryPrefix(state.dom.teamGroups,project.project_id+"::team:"+zoneKey+":",desiredGroups);
          for (const objective of items) if (!rendered.has(objective.stable_key)) {
            const objectiveNode=patchObjectiveNode(objective); objectiveNode.classList.add("pinned-objective"); itemsContainer.appendChild(objectiveNode);
          }
        }
        let empty=itemsContainer.querySelector("[data-zone-empty]");
        if (!items.length&&!empty) { empty=document.createElement("div");empty.className="empty";empty.dataset.zoneEmpty="true";empty.textContent="暂无任务";itemsContainer.appendChild(empty); }
        if (items.length&&empty) empty.remove();
      }
      function createProjectFloor(project) {
        const node = document.createElement("article"); node.className = "floor"; node.dataset.projectKey = project.project_id;
        node.innerHTML = '<div class="floor-head"><div class="floor-title"><h2 data-floor-name></h2><div class="floor-meta" data-floor-meta></div><div class="floor-meta technical-only" data-floor-technical></div><div class="floor-meta" data-floor-resource></div></div><div class="writer"><span data-writer-text></span><div class="sub technical-only" data-writer-evidence></div></div></div><div class="workspace-conflict" data-workspace-conflict></div><div class="notice" data-project-unavailable></div><div class="office-grid"></div><div class="sub" data-hidden-history></div><div class="sub" data-truncated-active></div>';
        const grid = node.querySelector(".office-grid");
        for (const [key,label] of ZONES) {
          const zone = document.createElement("section"); zone.className = "zone"; zone.dataset.zone = key;
          zone.innerHTML = '<div class="zone-head"><h3>'+escapeHtml(label)+'</h3><span class="zone-density-note" data-zone-density>常规</span><span class="count" data-zone-count>0</span></div><div data-zone-items></div>';
          grid.appendChild(zone); state.dom.zones.set(project.project_id+"\u0000"+key,zone);
        }
        state.dom.projects.set(project.project_id,node); return node;
      }
      function patchProjectFloor(project) {
        const node = state.dom.projects.get(project.project_id) || createProjectFloor(project);
        node.querySelector("[data-floor-name]").textContent = project.name;
        node.querySelector("[data-floor-meta]").textContent = "项目状态："+clientStatus(project.floor_status);
        node.querySelector("[data-floor-technical]").textContent = project.canonical_root+" · 工作区 "+(project.workspace_id||"未知")+" / 第 "+(project.workspace_generation??"?")+" 代 · HEAD "+(project.head_sha||"未知")+" · 当前任务 "+(project.current_task_id||"无")+" · 阶段 "+(project.current_stage||"无")+" · Owner "+(project.current_owner||"未知")+" · 最近活动 "+timeText(project.last_activity_at)+" · 最近进展 "+timeText(project.last_progress_at)+" · 分支 "+(project.branch || "未知")+" · "+(project.git_summary || "代码状态未知")+" · 监控 "+clientStatus(project.watcher_state);
        node.querySelector("[data-floor-resource]").textContent = projectResourceText(project);
        const writer = node.querySelector(".writer"); writer.className = "writer "+project.writer_lease.state+(project.writer_lease.stale?" queued writer-stale":"");
        node.querySelector("[data-writer-text]").textContent = writerText(project.writer_lease);
        node.querySelector("[data-writer-evidence]").textContent = "原始状态依据："+project.writer_lease.evidence;
        const conflict=node.querySelector("[data-workspace-conflict]");conflict.className=project.workspace_conflict?"workspace-conflict show":"workspace-conflict";conflict.textContent=project.workspace_conflict?"工作区绑定冲突：已停止投影可变更操作，请先重新打开当前项目。":"";
        const unavailable = node.querySelector("[data-project-unavailable]");
        unavailable.className = project.available ? "notice" : "notice show error";
        unavailable.textContent = project.available ? "" : "项目不可读取："+(project.unavailable_reason || "未知原因");
        for (const [zoneKey] of ZONES) {
          const zone = state.dom.zones.get(project.project_id+"\u0000"+zoneKey);
          const itemsContainer = zone.querySelector("[data-zone-items]");
          const items = project.zones[zoneKey] || [];
          zone.querySelector("[data-zone-count]").textContent = String(project.counts[zoneKey] || 0);
          patchZoneItems(project,zoneKey,zone,itemsContainer,items);
        }
        node.querySelector("[data-hidden-history]").textContent = project.hidden_test_history_count ? "已默认隐藏 "+project.hidden_test_history_count+" 条历史测试任务；可在顶部选择显示。" : "";
        node.querySelector("[data-truncated-active]").textContent = project.truncated_active_count ? "另有 "+project.truncated_active_count+" 个活动任务因首屏上限未展开；顶部总数仍包含它们。" : "";
        floors.appendChild(node);
      }
      function removeDeletedDom(nextIndex) {
        for (const [key,node] of [...state.dom.objectives.entries()]) if (!nextIndex.objectives.has(key)) {
          node.remove(); state.dom.objectives.delete(key); state.fingerprints.delete(key);
          removeRegistryPrefix(state.dom.executors,key+"\u0000",new Set());
          removeRegistryPrefix(state.dom.devices,key+"\u0000",new Set());
        }
        for (const [key,node] of [...state.dom.teamGroups.entries()]) if (!nextIndex.teamGroups.has(key)) {
          node.remove(); state.dom.teamGroups.delete(key); state.expandedGroups.delete(key);
        }
        for (const [key,node] of [...state.dom.projects.entries()]) if (!nextIndex.projects.has(key)) {
          node.remove(); state.dom.projects.delete(key);
          removeRegistryPrefix(state.dom.zones,key+"\u0000",new Set());
          removeRegistryPrefix(state.dom.teamGroups,key+"::",new Set());
        }
      }
      function render(data,options={}) {
        renderMetrics(data);
        renderCapabilityRegistry(data);
        updateProjectCatalog(data);
        const selectedProject = projectFilter.value;
        const mode = selectedProject ? "project" : "overview";
        const previousIndex = state.projectionIndex;
        const nextIndex = projectionIndex(data);
        const diff = projectionDiff(previousIndex,nextIndex);
        const full = options.full === true || state.needsFullRebuild || state.viewMode !== mode || !previousIndex;
        const oldRects = full ? new Map() : captureObjectiveRects(diff);
        if (full) {
          clearDomRegistries(); floors.replaceChildren();
          if (mode === "overview" && data.projects.length) { const overview=document.createElement("section"); overview.className="floor-overview"; overview.setAttribute("aria-label","紧凑楼层总览"); floors.appendChild(overview); }
        }
        if (!data.projects.length) {
          floors.replaceChildren(); const empty=document.createElement("div"); empty.className="notice show"; empty.textContent="没有符合筛选条件的项目。"; floors.appendChild(empty);
        } else if (mode === "overview") {
          const overview = floors.querySelector(".floor-overview");
          for (const project of data.projects) patchProjectOverview(project,overview,data.visual_snapshot?.projects?.find((item)=>item.project_id===project.project_id));
        } else {
          for (const project of data.projects) patchProjectFloor(project);
        }
        removeDeletedDom(nextIndex);
        state.data = data; state.projectionIndex = nextIndex; state.viewMode = mode; state.needsFullRebuild = false;
        updateOfficeScene(data,mode,full);
        applyProjectionAnimations(previousIndex,nextIndex,diff,oldRects,full);
        if (state.selectedKey) {
          const affected = full || diff.added.includes(state.selectedKey) || diff.updated.includes(state.selectedKey) || diff.moved.includes(state.selectedKey) || diff.deleted.includes(state.selectedKey) || diff.graphAuthorityDropped.includes(state.selectedKey);
          if (affected) openDrawer(state.selectedKey,false,true);
        }
        return diff;
      }
      function findObjective(key) {
        if (!state.data) return null;
        for (const project of state.data.projects) for (const [zone] of ZONES) for (const objective of project.zones[zone] || []) if (objective.stable_key === key) return objective;
        return null;
      }
      function projectParams(objective) {
        const params = authQuery();
        params.set("project", objective.project_id);
        return params;
      }
      function taskUrl(objective, suffix) {
        return "/admin/tasks/"+encodeURIComponent(objective.current_attempt.task_id)+"/"+suffix+"?"+projectParams(objective).toString();
      }
      function idempotencyKey(prefix) {
        return prefix+":"+(globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : Date.now()+":"+state.revision.slice(0,12));
      }
      function detailOutput(message, error=false) {
        const output = $("detailOutput");
        if (!output) return;
        output.textContent = typeof message === "string" ? message : JSON.stringify(message, null, 2);
        output.style.borderColor = error ? "var(--danger)" : "var(--border)";
      }
      function auxiliaryRequestController() {
        const controller = new AbortController();
        state.auxiliaryRequests.add(controller);
        return controller;
      }
      function auxiliaryRequestCancelled(error) {
        return state.destroyed && error?.name === "AbortError";
      }
      async function loadTaskDetail(objective, kind) {
        if (!objective.current_attempt) return;
        detailOutput("正在读取"+(kind === "timeline" ? "时间线" : kind === "evidence" ? "证据" : "恢复信息")+"…");
        const controller = auxiliaryRequestController();
        try {
          const response = await fetch(taskUrl(objective, kind), { cache:"no-store", signal:controller.signal });
          const body = await response.json().catch(()=>({ error:"响应无法解析" }));
          if (!response.ok) throw new Error(body.message || body.error || "读取失败（HTTP "+response.status+"）");
          detailOutput(body);
        } catch (error) {
          if (auxiliaryRequestCancelled(error)) return;
          detailOutput(error.message || String(error), true);
        } finally {
          state.auxiliaryRequests.delete(controller);
        }
      }
      async function runTaskAction(objective, actionIndex) {
        const attempt = objective.current_attempt;
        const descriptor = attempt?.available_actions?.[actionIndex];
        if (!attempt || !descriptor) return;
        const operationKey = attempt.task_id+":"+descriptor.action;
        if (state.actionInFlight.has(operationKey)) return;
        const confirmationPrompt = descriptor.action === "cancel" ? "确认取消当前 Attempt？" : (descriptor.action === "retry_step" ? "确认按既有恢复策略重试当前步骤？" : "确认恢复当前 Attempt？");
        let recoveryPrompt = "";
        if (descriptor.confirmation_mode === "prompt" || descriptor.prompt_required) {
          const input = window.prompt(confirmationPrompt+"\\n\\n"+descriptor.reason+"\\n\\n请输入恢复指令：", "继续完成当前目标，但不要重放已经完成的步骤。");
          if (input === null) return;
          recoveryPrompt = input.trim();
          if (!recoveryPrompt) { detailOutput("恢复指令不能为空。", true); return; }
        } else if ((descriptor.confirmation_mode || (descriptor.requires_confirmation ? "simple" : "none")) === "simple") {
          if (!window.confirm(confirmationPrompt+"\\n\\n"+descriptor.reason)) return;
        }
        state.actionInFlight.add(operationKey);
        const controller = auxiliaryRequestController();
        detailOutput("正在执行："+descriptor.label+"…");
        try {
          let actionNonce = "";
          if (descriptor.action_nonce_required) {
            const nonceResponse = await fetch("/admin/tasks/"+encodeURIComponent(attempt.task_id)+"/action-nonce?"+projectParams(objective).toString(), {
              method:"POST",
              headers:{"Content-Type":"application/json","x-codexpro-csrf":taskActionCsrfToken},
              signal:controller.signal,
              body:JSON.stringify({
                action:descriptor.action,
                expected_status:descriptor.expected_status,
                ...(descriptor.step_id ? {step_id:descriptor.step_id} : {})
              })
            });
            const nonceBody = await nonceResponse.json().catch(()=>({ error:"确认凭证响应无法解析" }));
            if (!nonceResponse.ok || !nonceBody.action_nonce) throw new Error(nonceBody.message || nonceBody.error?.message || nonceBody.error || "无法创建一次性确认凭证");
            actionNonce = nonceBody.action_nonce;
          }
          const response = await fetch("/admin/tasks/"+encodeURIComponent(attempt.task_id)+"/action?"+projectParams(objective).toString(), {
            method:"POST",
            headers:{"Content-Type":"application/json","x-codexpro-csrf":taskActionCsrfToken},
            signal:controller.signal,
            body:JSON.stringify({
              action:descriptor.action,
              idempotency_key:idempotencyKey("office-"+descriptor.action),
              expected_status:descriptor.expected_status,
              ...(descriptor.step_id ? {step_id:descriptor.step_id} : {}),
              ...(recoveryPrompt ? {prompt:recoveryPrompt} : {}),
              ...(actionNonce ? {action_nonce:actionNonce} : {})
            })
          });
          const body = await response.json().catch(()=>({ error:"响应无法解析" }));
          if (!response.ok) throw new Error(body.message || body.error || "操作失败（HTTP "+response.status+"）");
          state.etag=""; state.revision=""; await refresh(true); detailOutput(body);
        } catch (error) {
          if (auxiliaryRequestCancelled(error)) return;
          detailOutput(error.message || String(error), true);
        } finally {
          state.auxiliaryRequests.delete(controller);
          state.actionInFlight.delete(operationKey);
        }
      }
      async function retryGitDelivery(objective) {
        const attempt = objective.current_attempt;
        if (!attempt?.git?.retry_available) return;
        const operationKey = objective.project_id+":retry_push";
        if (state.actionInFlight.has(operationKey)) return;
        if (!window.confirm("确认只重试 Git 推送？实现和验收不会重复执行。")) return;
        state.actionInFlight.add(operationKey);
        const controller = auxiliaryRequestController();
        detailOutput("正在重试 Git 推送…");
        try {
          const response = await fetch("/admin/git-finalization/retry?"+projectParams(objective).toString(), {
            method:"POST",
            headers:{"Content-Type":"application/json","x-codexpro-csrf":taskActionCsrfToken},
            signal:controller.signal,
            body:JSON.stringify({action:"retry_push",idempotency_key:idempotencyKey("office-retry-push")})
          });
          const body = await response.json().catch(()=>({ error:"响应无法解析" }));
          if (!response.ok) throw new Error(body.message || body.error || "推送重试失败（HTTP "+response.status+"）");
          state.etag=""; state.revision=""; await refresh(true); detailOutput(body);
        } catch (error) {
          if (auxiliaryRequestCancelled(error)) return;
          detailOutput(error.message || String(error), true);
        } finally {
          state.auxiliaryRequests.delete(controller);
          state.actionInFlight.delete(operationKey);
        }
      }
      const SVG_NS = "http://www.w3.org/2000/svg";
      function graphNodeDetails(graph) {
        return graph.nodes.slice(0,20).map((node)=>'<div class="attempt-row"><b>'+escapeHtml(node.node_type)+' · '+escapeHtml(node.label)+'</b><div class="sub">状态 '+escapeHtml(node.state)+' · 来源 '+escapeHtml(node.route_source)+' · 读写 '+escapeHtml(node.read_write_mode)+' · 重试 '+escapeHtml(node.retry_policy)+' · 可重放 '+escapeHtml(node.replay_allowed === null ? "未知" : (node.replay_allowed ? "是" : "否"))+' · 尝试 '+escapeHtml(node.attempt === null ? "未知" : node.attempt)+'/'+escapeHtml(node.max_attempts === null ? "未知" : node.max_attempts)+'</div>'+(node.transition_reason?'<div>'+escapeHtml(node.transition_reason)+'</div>':'')+'</div>').join("");
      }
      function ensureDrawerSkeleton() {
        const body = $("drawerBody");
        if (body.querySelector("[data-drawer-details]")) return;
        body.innerHTML = '<div class="boss-summary-grid" data-drawer-boss-summary></div><div data-drawer-alerts></div><div class="section" data-tool-results-section><h3>最新工具事实</h3><div class="business-progress" data-drawer-tool-results></div></div><div class="section"><h3>最近进展</h3><div class="business-progress" data-drawer-business-progress></div></div><div class="section"><h3>Git 发布台</h3><div class="git-desk" data-drawer-git-desk></div></div><div class="section"><h3>重要信息</h3><div class="graph-note" data-drawer-action></div></div><div class="section"><h3>任务摘要</h3><div class="graph-note" data-drawer-summary></div></div><div data-drawer-controls></div><details class="technical-details"><summary>查看技术详情</summary><div data-technical-content><div class="detail-grid" data-drawer-details></div><div data-drawer-technical-alerts></div><div class="section" data-tool-details-section><h3>证据抽屉 · 工具结果</h3><div class="attempt-list" data-drawer-tool-details></div></div><div class="section"><h3>执行智能体</h3><div class="attempt-list" data-drawer-executors></div></div><div class="section"><h3>真实设备与状态依据</h3><div class="attempt-list" data-drawer-devices></div></div><div class="section"><h3>后台执行步骤</h3><div class="attempt-list" data-drawer-components></div></div><div class="section"><h3 data-graph-title>原始执行图</h3><div class="graph-note" data-graph-note></div><svg class="graph" data-graph-svg role="img" aria-label="已证明的任务执行节点与关系"><g data-graph-edges></g><g data-graph-nodes></g></svg><div class="attempt-list" data-graph-details></div></div><div class="section"><h3>历史执行记录</h3><div class="attempt-list" data-drawer-attempts></div></div></div></details>';
        body.querySelector("[data-tool-results-section]").hidden=officeToolOutcomeFeature.projection_enabled!==true;
        body.querySelector("[data-tool-details-section]").hidden=officeToolOutcomeFeature.detail_enabled!==true;
      }
      function patchHtml(node,html,fingerprint) {
        if (node.dataset.fingerprint === fingerprint) return;
        node.innerHTML = html; node.dataset.fingerprint = fingerprint;
      }
      function patchGraphSvg(objective,graph) {
        const svg = $("drawerBody").querySelector("[data-graph-svg]");
        const edgeLayer = svg.querySelector("[data-graph-edges]");
        const nodeLayer = svg.querySelector("[data-graph-nodes]");
        const nodes = graph.nodes.slice(0,12), width=640, row=44, height=Math.max(80,nodes.length*row+24);
        const positions = new Map(nodes.map((node,index)=>[node.node_id,{x:index<2?22:250,y:18+index*row}]));
        const prefix = objective.stable_key+"\u0000";
        const desiredEdges = new Set();
        for (const edge of graph.edges.filter((candidate)=>positions.has(candidate.from)&&positions.has(candidate.to))) {
          const key=prefix+edge.edge_id; desiredEdges.add(key);
          let line=state.dom.graphEdges.get(key);
          if (!line) { line=document.createElementNS(SVG_NS,"line"); line.dataset.graphEdgeKey=key; state.dom.graphEdges.set(key,line); }
          const from=positions.get(edge.from),to=positions.get(edge.to);
          line.setAttribute("x1",String(from.x+160)); line.setAttribute("y1",String(from.y+14)); line.setAttribute("x2",String(to.x)); line.setAttribute("y2",String(to.y+14));
          line.setAttribute("stroke","currentColor"); line.setAttribute("opacity",edge.selected===true?".8":".35");
          line.classList.toggle("route-selected",objective.execution_graph?.authority==="explicit" && edge.selected===true);
          line.dataset.edgeKind=edge.edge_kind; line.dataset.selected=String(edge.selected); line.dataset.relationGroup=edge.relation_group || ""; line.dataset.dependencySatisfied=String(edge.dependency_satisfied); edgeLayer.appendChild(line);
        }
        removeRegistryPrefix(state.dom.graphEdges,prefix,desiredEdges);
        const desiredNodes = new Set();
        for (const graphNode of nodes) {
          const key=prefix+graphNode.node_id; desiredNodes.add(key);
          let group=state.dom.graphNodes.get(key);
          if (!group) {
            group=document.createElementNS(SVG_NS,"g"); group.dataset.graphNodeKey=key;
            const rect=document.createElementNS(SVG_NS,"rect"); const circle=document.createElementNS(SVG_NS,"circle"); const label=document.createElementNS(SVG_NS,"text");
            rect.setAttribute("width","160"); rect.setAttribute("height","29"); rect.setAttribute("rx","7"); rect.setAttribute("fill","var(--card)"); rect.setAttribute("stroke","var(--border)");
            circle.setAttribute("r","4"); circle.setAttribute("fill","var(--accent)");
            label.setAttribute("fill","var(--text)"); label.setAttribute("font-size","11"); label.dataset.graphLabel="true";
            group.append(rect,circle,label); state.dom.graphNodes.set(key,group);
          }
          const position=positions.get(graphNode.node_id),rect=group.children[0],circle=group.children[1],label=group.children[2];
          rect.setAttribute("x",String(position.x)); rect.setAttribute("y",String(position.y));
          circle.setAttribute("cx",String(position.x+13)); circle.setAttribute("cy",String(position.y+14));
          label.setAttribute("x",String(position.x+24)); label.setAttribute("y",String(position.y+18)); label.textContent=graphNode.label.slice(0,20);
          group.dataset.state=graphNode.state; nodeLayer.appendChild(group);
        }
        removeRegistryPrefix(state.dom.graphNodes,prefix,desiredNodes);
        svg.setAttribute("viewBox","0 0 "+width+" "+height);
      }
      function focusToken(element) {
        if (!element || !$("drawerBody").contains(element)) return null;
        if (element.dataset.detailKind) return ["detail",element.dataset.detailKind];
        if (element.dataset.taskActionIndex) return ["action",element.dataset.taskActionIndex];
        if (element.hasAttribute("data-git-retry")) return ["git",""];
        return null;
      }
      function restoreDrawerFocus(token) {
        if (!token) return;
        const selector = token[0] === "detail" ? '[data-detail-kind="'+CSS.escape(token[1])+'"]' : token[0] === "action" ? '[data-task-action-index="'+CSS.escape(token[1])+'"]' : "[data-git-retry]";
        $("drawerBody").querySelector(selector)?.focus({preventScroll:true});
      }
      function openDrawer(key,focus=true,updateOnly=false) {
        const objective=findObjective(key);
        if (!objective) { if (state.selectedKey===key) closeDrawer(); return; }
        const selectionChanged=state.selectedKey!==key;
        if (selectionChanged) {
          for (const node of state.dom.graphNodes.values()) node.remove();
          for (const edge of state.dom.graphEdges.values()) edge.remove();
          state.dom.graphNodes.clear(); state.dom.graphEdges.clear(); state.drawerFingerprint="";
        }
        state.selectedKey=key; ensureDrawerSkeleton();
        const drawer=$("drawerBackdrop").querySelector(".drawer"),scrollTop=drawer.scrollTop,activeToken=focusToken(document.activeElement);
        const attempt=objective.current_attempt,graph=objective.execution_graph,project=(state.data?.projects||[]).find((item)=>item.project_id===objective.project_id)||null;
        const plain=objective.plain_summary||{};
        $("drawerTitle").textContent=objective.title; $("drawerSubtitle").textContent=objective.project_name+" · "+(plain.task_status||"状态待识别");
        const leaseAge=objective.writer_lease.age_ms===null?"未知":Math.floor(objective.writer_lease.age_ms/1000)+" 秒";
        const bossCards=[
          ["当前状态",plain.task_status||clientStatus(objective.objective_status),"primary"],
          ["现在正在做",plain.current_work||"执行步骤待识别",""],
          ["最新完成",plain.latest_result||"尚无新的已完成结果",""],
          ["下一步",plain.next_step||"尚无已确认的下一步",""],
          ["是否需要老板处理",plain.owner_action||"暂时不需要老板处理",objective.requires_human?"attention":""],
          ["后台是否继续运行",plain.background_continuation||"后台状态暂时无法确认",""],
          ["最近更新时间",relativeTimeText(objective.updated_at),""]
        ].map(([label,value,className])=>'<div class="boss-summary-card '+className+'"><span>'+escapeHtml(label)+'</span><b>'+escapeHtml(value)+'</b></div>').join("");
        patchHtml($("drawerBody").querySelector("[data-drawer-boss-summary]"),bossCards,stableFingerprint(bossCards));
        const businessProgress=[plain.latest_result,plain.validation_status,plain.delivery_status].filter(Boolean).map((value)=>'<div class="attempt-row">'+escapeHtml(value)+'</div>').join("")||'<div class="empty">尚无新的重要进展。</div>';
        patchHtml($("drawerBody").querySelector("[data-drawer-business-progress]"),businessProgress,stableFingerprint(businessProgress));
        const git=attempt?.git;const gitDesk=git?[
          ["分支",git.branch||project?.branch||"未知"],["提交状态",clientStatus(git.commit_status)],["推送状态",clientStatus(git.push_status)],["交付状态",clientStatus(git.delivery_status)],
          ["本地提交",git.local_commit_sha||"尚无"],["远端提交",git.remote_commit_sha||"尚无"],["提交说明",git.commit_message||"尚无"],["变更文件",git.changed_files?.length?git.changed_files.join("、"):"无"]
        ].map(([label,value])=>'<div class="detail"><span>'+escapeHtml(label)+'</span><b>'+escapeHtml(value)+'</b></div>').join(""):'<div class="empty">当前任务没有真实 Git 提交或推送事实；提交建议不会被当作已提交。</div>';
        patchHtml($("drawerBody").querySelector("[data-drawer-git-desk]"),gitDesk,stableFingerprint(git));
        const toolEvents=attempt?[...state.toolOutcomes.events.values()].filter((event)=>event.task_id===attempt.task_id&&event.actor_role!=="observer").sort((left,right)=>Number(right.sequence||0)-Number(left.sequence||0)).slice(0,5):[];
        const toolResults=toolEvents.length?toolEvents.slice(0,3).map((event)=>'<div class="attempt-row"><b>'+escapeHtml(event.public_title||event.tool_name)+'</b><div>'+escapeHtml(event.public_summary||"工具结果已更新")+'</div><div class="sub">'+escapeHtml(event.tool_category||"other")+' · '+escapeHtml(event.status||"unknown")+' · '+escapeHtml(relativeTimeText(event.completed_at))+'</div></div>').join(""):'<div class="empty">尚无与当前任务绑定的工具结果。</div>';
        patchHtml($("drawerBody").querySelector("[data-drawer-tool-results]"),toolResults,stableFingerprint(toolEvents.slice(0,3)));
        const toolDetails=toolEvents.length?toolEvents.map((event)=>{const metrics=Object.entries(event.result_metrics||{}).map(([name,value])=>'<li>'+escapeHtml(name)+'：'+escapeHtml(value)+'</li>').join('')||'<li>无指标</li>';const evidence=(event.evidence_refs||[]).map((ref)=>'<li>'+escapeHtml(ref)+'</li>').join('')||'<li>无证据引用</li>';const findings=(event.findings||[]).map((finding)=>'<li>'+escapeHtml(finding.kind)+'：'+escapeHtml(finding.summary)+(finding.evidence_refs?.length?' · '+escapeHtml(finding.evidence_refs.join('、')):'')+'</li>').join('')||'<li>无发现项</li>';return '<div class="attempt-row"><b>'+escapeHtml(event.event_id)+' · '+escapeHtml(event.tool_name)+'</b><div>'+escapeHtml(event.public_summary||"")+'</div><div class="sub">状态 '+escapeHtml(event.status||"unknown")+' · correlation '+escapeHtml(event.correlation_id)+' · digest '+escapeHtml(event.result_digest)+' · '+escapeHtml(event.duration_ms)+'ms · 脱敏 '+escapeHtml(event.redaction_applied?"是":"否")+' · 截断 '+escapeHtml(event.truncated?"是":"否")+'</div><details class="tool-evidence"><summary>查看指标、发现与证据</summary><b>结果指标</b><ul class="evidence-list">'+metrics+'</ul><b>发现项</b><ul class="evidence-list">'+findings+'</ul><b>证据引用</b><ul class="evidence-list">'+evidence+'</ul>'+(event.status==="failed"||event.status==="blocked"?'<b>错误摘要</b><div>'+escapeHtml(event.public_summary||"工具未成功完成")+'</div>':'')+'</details></div>';}).join(""):'<div class="empty">当前没有工具结果技术记录。</div>';
        patchHtml($("drawerBody").querySelector("[data-drawer-tool-details]"),toolDetails,stableFingerprint(toolEvents));
        $("drawerBody").querySelector("[data-drawer-action]").textContent=plain.risk_status||"当前没有发现需要老板立即处理的风险";
        $("drawerBody").querySelector("[data-drawer-summary]").textContent=(plain.current_work||"当前任务状态已同步")+"。"+(plain.next_step||"尚无已确认的下一步")+"。";
        const details=[
          ["任务编号（Objective ID）",objective.objective_key],["目标层原始状态",objective.objective_status],["阶段层（Stage）",objective.stage_key||"无"],["所在区域原始值",objective.zone],["执行层（Attempt）",objective.current_attempt_id||"无"],
          ["任务键（Task ID）",attempt?.task_id||"无"],["运行编号（Run ID）",attempt?.run_id||"无"],["已执行次数",objective.attempt_count],["活动层（Activity）",objective.activity_state],
          ["工作区 ID",attempt?.workspace_id||project?.workspace_id||"无"],["工作区代次",attempt?.workspace_generation??project?.workspace_generation??"无"],["规范项目根目录",project?.canonical_root||attempt?.workspace_root||"无"],["当前 Owner",project?.current_owner||attempt?.actor_id||"无"],
          ["进度口径",attempt?.progress?.label||"尚无进展记录"],
          ["原始当前动作",attempt?.action||objective.summary],["无进展原始等级",objective.no_progress_level],["老板待办原文",objective.user_action_required?.prompt||"无"],["实现原始状态",attempt?.implementation_status||"未知"],
          ["验收原始状态",attempt?.validation_status||"未知"],["浏览器验收状态",attempt?.completion_state?.browser_acceptance_status||"未请求"],["代码交付原始状态",attempt?.delivery_status||"未请求"],["完成层级",attempt?.completion_state?.completion_level||"未知"],["闭环就绪",attempt?.completion_state?.closure_ready?"是":"否"],["后台存活原始状态",attempt?.liveness||"未知"],["事故状态",attempt?.incident_state||"无"],["最近真实进展",timeText(objective.last_meaningful_progress_at)],
          ["后台执行进程（Owner）存活",attempt?.observability?.owner_alive===null||attempt?.observability?.owner_alive===undefined?"未知":(attempt.observability.owner_alive?"是":"否")],["最近错误",attempt?.latest_error||"无"],["恢复来源运行编号",attempt?.observability?.recovery_from_run_id||"无"],["文件写入权原始状态",objective.writer_lease.state],
          ["写入权持有任务",objective.writer_lease.holder_task_id||"无"],["写入权代次",objective.writer_lease.fence??"无"],["写入权年龄",leaseAge],["写入权获取",timeText(objective.writer_lease.acquired_at)],
          ["写入权到期",timeText(objective.writer_lease.expires_at)],["写入等待人数",objective.writer_lease.waiting_count],["独立运行依据",attempt?.safe_to_close_chat?.reason||"未提供"],["系统下一步原文",objective.system_next_action||"未提供"]
        ].map(([label,value])=>'<div class="detail"><span>'+escapeHtml(label)+'</span><b>'+escapeHtml(value)+'</b></div>').join("");
        patchHtml($("drawerBody").querySelector("[data-drawer-details]"),details,stableFingerprint(details));
        const alerts=objective.resource_alerts.length?'<div class="section"><h3>需要关注</h3><div class="alert-list"><div class="alert-item">'+escapeHtml(plain.risk_status||"发现需要关注的问题")+'</div></div></div>':'';
        patchHtml($("drawerBody").querySelector("[data-drawer-alerts]"),alerts,stableFingerprint([plain.risk_status,objective.resource_alerts.length]));
        const technicalAlerts=objective.resource_alerts.length?'<div class="section"><h3>原始资源与存活异常</h3><div class="alert-list">'+objective.resource_alerts.map((item)=>'<div class="alert-item">'+escapeHtml(item)+'</div>').join("")+'</div></div>':'';
        patchHtml($("drawerBody").querySelector("[data-drawer-technical-alerts]"),technicalAlerts,stableFingerprint(objective.resource_alerts));
        const detailButtons=attempt?['timeline','evidence','recovery'].map((kind)=>'<button class="btn" type="button" data-detail-kind="'+kind+'">'+(kind==='timeline'?'任务时间线':kind==='evidence'?'状态依据':'恢复信息')+'</button>').join(""):'';
        const actionButtons=attempt?.available_actions?.map((action,index)=>'<button class="btn" type="button" data-task-action-index="'+index+'">'+escapeHtml(action.label)+'</button>').join("")||'';
        const gitButton=attempt?.git?.retry_available?'<button class="btn" type="button" data-git-retry>只重新同步代码</button>':'';
        const reportButton=attempt&&reportFeatureEnabled({project_id:objective.project_id,name:objective.project_name})?'<button class="btn primary report-launch" type="button" data-open-report>打开任务回报中心'+(reportUnreadCount(objective)?'<span class="report-unread">'+escapeHtml(reportUnreadCount(objective))+'</span>':'')+'</button>':'';
        const controls=attempt?'<div class="section"><h3>任务回报与安全操作</h3><div class="drawer-actions">'+reportButton+actionButtons+gitButton+detailButtons+'</div><pre class="detail-output" id="detailOutput">可查看任务时间线、状态依据和恢复信息。所有写操作继续受既有安全保护。</pre></div>':'';
        patchHtml($("drawerBody").querySelector("[data-drawer-controls]"),controls,stableFingerprint([attempt?.available_actions,attempt?.git?.retry_available,Boolean(attempt),reportUnreadCount(objective),Boolean(reportButton)]));
        const executors=objective.executors.length?objective.executors.map((executor)=>'<div class="attempt-row">'+executorHtml(executor)+'<div><b>'+escapeHtml(executor.activity_state)+'</b> · '+escapeHtml(executor.current_action||"无进展摘要")+'</div><div class="sub">执行器 '+escapeHtml(executor.executor_id)+' · 组件 '+escapeHtml(executor.component_ids.join(', ')||"无映射")+' · 最近真实进展 '+escapeHtml(timeText(executor.last_progress_at))+'</div></div>').join(""):'<div class="empty">没有可证明的执行器人物。</div>';
        const components=objective.components.length?objective.components.map((component)=>'<div class="attempt-row"><b>'+escapeHtml(component.component_kind)+' · '+escapeHtml(component.component_id)+'</b><div>'+escapeHtml(component.progress_marker||"无组件进展摘要")+'</div><div class="sub">'+escapeHtml(component.read_write_mode)+' · '+escapeHtml(component.raw_state)+' · 父 Run '+escapeHtml(component.parent_run_id||"不可用")+' · 执行器 '+escapeHtml(component.executor_ids.join(', ')||"无映射")+' · '+escapeHtml(timeText(component.last_progress_at))+'</div></div>').join(""):'<div class="empty">没有可证明的模型流、工具进程或工作器组件。</div>';
        const devices=objective.devices.length?objective.devices.map((device)=>'<div class="attempt-row">'+deviceHtml(device)+'<div>'+escapeHtml(device.details)+'</div><div class="sub">绑定执行器 '+escapeHtml(device.executor_ids.join(', ')||"未证明")+' · 组件 '+escapeHtml(device.component_ids.join(', ')||"无")+' · 证据 '+escapeHtml(device.evidence_source)+(device.evidence_ref?' · '+escapeHtml(device.evidence_ref):'')+'</div></div>').join(""):'<div class="empty">当前 Attempt 没有浏览器、验收、写入租约或组件设备证据。</div>';
        const attempts=objective.historical_attempts.length?objective.historical_attempts.map((item)=>'<div class="attempt-row"><b>'+escapeHtml(item.attempt_id)+'</b> · '+escapeHtml(item.status)+' · '+escapeHtml(item.supersession)+'<div class="sub">'+escapeHtml(timeText(item.updated_at))+'</div></div>').join(""):'<div class="empty">没有历史 Attempt。</div>';
        patchHtml($("drawerBody").querySelector("[data-drawer-executors]"),executors,stableFingerprint(objective.executors));
        patchHtml($("drawerBody").querySelector("[data-drawer-devices]"),devices,stableFingerprint(objective.devices));
        patchHtml($("drawerBody").querySelector("[data-drawer-components]"),components,stableFingerprint(objective.components));
        patchHtml($("drawerBody").querySelector("[data-drawer-attempts]"),attempts,stableFingerprint(objective.historical_attempts));
        const graphAuthority={explicit:"完整权威",partial:"部分权威",unavailable:"暂不可用"}[graph.authority]||"状态待识别";
        $("drawerBody").querySelector("[data-graph-title]").textContent="原始执行图 · "+graphAuthority+"（"+graph.authority+"）";
        $("drawerBody").querySelector("[data-graph-note]").textContent=graph.reason+(graph.truncated?" · 图已按上限截断":"");
        patchGraphSvg(objective,graph);
        patchHtml($("drawerBody").querySelector("[data-graph-details]"),graphNodeDetails(graph),stableFingerprint(graph.nodes));
        const technicalDetails=$("drawerBody").querySelector(".technical-details");if(state.perspective==="tech")technicalDetails.open=true;else if(selectionChanged)technicalDetails.open=false;
        state.drawerFingerprint=stableFingerprint(objective);
        $("drawerBackdrop").classList.add("open"); $("drawerBackdrop").setAttribute("aria-hidden","false");
        if (!selectionChanged || updateOnly) { drawer.scrollTop=scrollTop; restoreDrawerFocus(activeToken); }
        else if (focus) $("drawerClose").focus();
      }
      function closeDrawer(){state.selectedKey=null;state.drawerFingerprint="";$("drawerBackdrop").classList.remove("open");$("drawerBackdrop").setAttribute("aria-hidden","true");}
      const EXPLICIT_ABORT_REASONS = new Set(["project_change","filter_change","force_refresh","network_offline","page_destroy"]);
      function cancelActiveRequest(reason) {
        if (!state.request) return false;
        state.request.abortReason = reason; state.polling.explicit_aborts += 1; state.request.controller.abort(); return true;
      }
      function refreshOptions(value) {
        if (typeof value === "boolean") return { force:value, reason:value?"force_refresh":"poll", cancelPrevious:value, full:false };
        return { force:false, reason:"poll", cancelPrevious:false, full:false, ...(value || {}) };
      }
      async function refresh(input=false) {
        if (state.destroyed) return { status:"cancelled", reason:"page_destroy" };
        const options = refreshOptions(input);
        if (state.offline || navigator.onLine === false) {
          sync.textContent = "网络已断开，等待恢复…";
          return { status:"skipped", reason:"network_offline" };
        }
        if (state.request) {
          if (options.cancelPrevious && EXPLICIT_ABORT_REASONS.has(options.reason)) cancelActiveRequest(options.reason);
          else {
            state.polling.skipped += 1;
            if (options.force || options.reason === "network_recovery") state.pendingFullRefresh = true;
            sync.textContent = "上一轮仍在读取，本轮已跳过";
            return { status:"skipped", reason:"request_in_flight" };
          }
        }
        const controller = new AbortController();
        const request = { id:++state.requestSequence, controller, reason:options.reason, abortReason:null, startedAt:Date.now() };
        state.request = request;
        sync.textContent = state.offline ? "网络已断开，等待恢复…" : "读取中…";
        const headers = {}; if (!options.force && state.etag) {
          headers["If-None-Match"] = state.etag;
          headers["X-CodexPro-Office-Not-Modified"] = "200";
        }
        try {
          const response = await fetch("/admin/office?"+officeParams().toString(), {headers,signal:controller.signal,cache:options.force?"no-store":"no-cache"});
          if (response.status === 204 || response.status === 304) {
            sync.textContent = "状态未变化 · "+new Date().toLocaleTimeString("zh-CN");
            return { status:"not_modified" };
          }
          if (!response.ok) throw new Error("读取失败（HTTP "+response.status+"）");
          const data = await response.json(); state.etag = response.headers.get("ETag") || state.etag;
          if (data?.not_modified === true) {
            sync.textContent = "状态未变化 · "+new Date().toLocaleTimeString("zh-CN");
            return { status:"not_modified" };
          }
          const integrityError=projectionIntegrityError(data);
          if(integrityError)throw new Error(integrityError);
          if (options.force || data.revision !== state.revision || state.needsFullRebuild) {
            render(data,{full:options.full || state.needsFullRebuild}); state.revision=data.revision;
          }
          if (data.snapshot_observability?.snapshot_ready === false) {
            notice.textContent="办公室正在读取最新持久证据，页面会自动更新。"; notice.className="notice show"; sync.textContent="快照准备中…";
            clearTimeout(state.snapshotRetry); state.snapshotRetry=setTimeout(()=>refresh({force:true,reason:"snapshot_retry",cancelPrevious:false}),750);
            return { status:"snapshot_pending" };
          }
          clearTimeout(state.snapshotRetry); state.snapshotRetry=null;
          const truth=data.synchronization||{},lag=Math.max(0,Number(truth.office_projection_lag_ms||0)),orphans=Number(truth.orphan_run_count||0)+Number(truth.orphan_resource_count||0),health=snapshotHealth(data);
          if(health.inconsistent){notice.textContent="办公室状态投影异常："+health.violations.slice(0,3).join("；");notice.className="notice show error";sync.textContent="状态投影异常";}
          else if(health.stale){const age=Math.max(0,Number(data.snapshot_observability?.age_ms||0));notice.textContent="状态数据已过期，最后可信快照为 "+Math.ceil(age/1000)+" 秒前。"+(health.refreshError?" 刷新错误："+health.refreshError:"");notice.className="notice show error";sync.textContent="状态数据已过期";}
          else{notice.className="notice";sync.textContent=orphans>0?"投影诊断：发现 "+orphans+" 个无法关联的运行或资源":lag>10000?"投影延迟 "+Math.ceil(lag/1000)+" 秒":"已同步 · "+relativeTimeText(truth.snapshot_generated_at||data.generated_at);}
          void startToolOutcomeStream();
          return { status:"updated" };
        } catch (error) {
          if (error.name === "AbortError") {
            if (request.abortReason && EXPLICIT_ABORT_REASONS.has(request.abortReason)) return { status:"cancelled", reason:request.abortReason };
            state.polling.network_failures += 1;
            notice.textContent="请求意外中断，未自动重复提交。"; notice.className="notice show error"; sync.textContent="同步中断";
            return { status:"failed", reason:"unexpected_abort" };
          }
          state.polling.network_failures += 1;
          notice.textContent = error.message || String(error); notice.className="notice show error"; sync.textContent=state.offline?"网络已断开":"同步失败";
          return { status:"failed", reason:"network_error" };
        } finally {
          if (state.request === request) state.request=null;
          if (!state.destroyed && !state.request && state.pendingFullRefresh) {
            state.pendingFullRefresh=false; state.needsFullRebuild=true; state.etag=""; state.revision="";
            queueMicrotask(()=>refresh({force:true,reason:"network_recovery",cancelPrevious:false,full:true}));
          }
        }
      }
      function selectedToolOutcomeProject(){return projectFilter.value||state.initialProject||"";}
      function closeToolOutcomeStream(){
        state.toolOutcomes.source?.close();state.toolOutcomes.source=null;state.toolOutcomes.projectId=null;state.toolOutcomes.status="idle";
        clearTimeout(state.toolOutcomes.reconnectTimer);clearTimeout(state.toolOutcomes.pollTimer);clearTimeout(state.toolOutcomes.refreshTimer);
        state.toolOutcomes.reconnectTimer=null;state.toolOutcomes.pollTimer=null;state.toolOutcomes.refreshTimer=null;
      }
      function storeToolOutcomeEvent(event,animate=false){
        if(!event||!event.event_id||state.toolOutcomes.events.has(event.event_id))return false;
        state.toolOutcomes.events.set(event.event_id,event);state.toolOutcomes.order.push(event.event_id);
        while(state.toolOutcomes.order.length>200){const oldest=state.toolOutcomes.order.shift();state.toolOutcomes.events.delete(oldest);}
        const project=state.toolOutcomes.projectId||selectedToolOutcomeProject();const sequence=Math.max(0,Number(event.sequence||0));
        if(project&&sequence>Number(state.toolOutcomes.sequences.get(project)||0))state.toolOutcomes.sequences.set(project,sequence);
        if(animate)enqueueOfficeToolOutcomeProcess(event);
        if(state.selectedKey&&state.data){const objective=findObjective(state.selectedKey);if(objective?.current_attempt?.task_id===event.task_id)openDrawer(state.selectedKey,false,true);}
        clearTimeout(state.toolOutcomes.refreshTimer);state.toolOutcomes.refreshTimer=setTimeout(()=>refresh({reason:"tool_event"}),250);
        return true;
      }
      async function fetchToolOutcomeEvents(project,afterSequence){
        const params=authQuery();params.set("project",project);params.set("after_sequence",String(Math.max(0,Number(afterSequence||0))));params.set("limit","100");
        const response=await fetch("/admin/office/tool-results?"+params.toString(),{cache:"no-store"});
        const body=await response.json().catch(()=>({error:"响应无法解析"}));if(!response.ok)throw new Error(body.message||body.error||"读取工具结果失败（HTTP "+response.status+"）");
        for(const event of body.events||[])storeToolOutcomeEvent(event,Number(afterSequence||0)>0);
        const latest=Math.max(Number(state.toolOutcomes.sequences.get(project)||0),Number(body.latest_sequence||0));state.toolOutcomes.sequences.set(project,latest);
        return body;
      }
      function scheduleToolOutcomeFallback(project){
        clearTimeout(state.toolOutcomes.pollTimer);if(state.destroyed||state.offline||selectedToolOutcomeProject()!==project)return;
        state.toolOutcomes.pollTimer=setTimeout(async()=>{try{await fetchToolOutcomeEvents(project,state.toolOutcomes.sequences.get(project)||0);state.toolOutcomes.status="polling";}catch{state.toolOutcomes.status="delayed";}scheduleToolOutcomeFallback(project);},document.hidden?30000:5000);
      }
      async function startToolOutcomeStream(){
        const project=selectedToolOutcomeProject();
        if(!officeToolOutcomeFeature.projection_enabled||!officeToolOutcomeFeature.stream_enabled||!project||state.destroyed||state.offline){closeToolOutcomeStream();return;}
        if(state.toolOutcomes.source&&state.toolOutcomes.projectId===project)return;
        closeToolOutcomeStream();state.toolOutcomes.projectId=project;state.toolOutcomes.status="connecting";
        try{
          if(!state.toolOutcomes.sequences.has(project)){const baseline=await fetchToolOutcomeEvents(project,0);state.toolOutcomes.sequences.set(project,Number(baseline.latest_sequence||0));}
          if(state.destroyed||state.offline||selectedToolOutcomeProject()!==project)return;
          if(typeof EventSource!=="function"){scheduleToolOutcomeFallback(project);return;}
          const params=authQuery();params.set("project",project);params.set("after_sequence",String(state.toolOutcomes.sequences.get(project)||0));
          const source=new EventSource("/admin/office/stream?"+params.toString(),{withCredentials:true});state.toolOutcomes.source=source;
          source.addEventListener("ready",()=>{state.toolOutcomes.status="streaming";});
          source.addEventListener("tool_result",(message)=>{try{storeToolOutcomeEvent(JSON.parse(message.data),true);state.toolOutcomes.status="streaming";}catch{state.toolOutcomes.status="degraded";}});
          source.addEventListener("reconnect",()=>{source.close();state.toolOutcomes.source=null;scheduleToolOutcomeFallback(project);});
          source.addEventListener("projection_error",()=>{state.toolOutcomes.status="degraded";source.close();state.toolOutcomes.source=null;scheduleToolOutcomeFallback(project);});
          source.onerror=()=>{state.toolOutcomes.status="reconnecting";source.close();state.toolOutcomes.source=null;scheduleToolOutcomeFallback(project);clearTimeout(state.toolOutcomes.reconnectTimer);state.toolOutcomes.reconnectTimer=setTimeout(()=>startToolOutcomeStream(),15000);};
        }catch{state.toolOutcomes.status="delayed";scheduleToolOutcomeFallback(project);}
      }
      function schedule() { clearTimeout(state.timer); if(state.destroyed)return; state.timer=setTimeout(async()=>{await refresh({reason:"poll"});schedule();},document.hidden?30000:5000); }
      function changeProjectionScope(reason,closeDetails=false) {
        state.etag=""; state.revision=""; state.needsFullRebuild=true;closeToolOutcomeStream();
        if (closeDetails) { state.initialProject=""; closeReportCenter(); closeDrawer(); }
        refresh({force:true,reason,cancelPrevious:true,full:true}).finally(()=>startToolOutcomeStream());
      }
      $("refreshButton").addEventListener("click",()=>refresh({force:true,reason:"force_refresh",cancelPrevious:true}));
      floors.addEventListener("click",(event)=>{
        const groupToggle=event.target.closest("[data-team-group-toggle]");
        if (groupToggle) {
          const key=groupToggle.dataset.teamGroupToggle;
          if (state.expandedGroups.has(key)) state.expandedGroups.delete(key); else state.expandedGroups.add(key);
          if (state.data) render(state.data,{full:false});
          groupToggle.focus({preventScroll:true});
          return;
        }
        const enter=event.target.closest("[data-enter-project]"); if (!enter) return;
        projectFilter.value=enter.dataset.enterProject; state.selectedKey=null; changeProjectionScope("project_change",true);
      });
      projectFilter.addEventListener("change",()=>changeProjectionScope("project_change",true));
      archiveToggle.addEventListener("change",()=>changeProjectionScope("filter_change"));
      testHistoryToggle.addEventListener("change",()=>changeProjectionScope("filter_change"));
      $("drawerBody").addEventListener("click",(event)=>{
        const objective=state.selectedKey?findObjective(state.selectedKey):null; if (!objective) return;
        if (event.target.closest("[data-open-report]")) { openReportCenter(objective); return; }
        const detail=event.target.closest("[data-detail-kind]"); if (detail) { loadTaskDetail(objective,detail.dataset.detailKind); return; }
        const action=event.target.closest("[data-task-action-index]"); if (action) { runTaskAction(objective,Number(action.dataset.taskActionIndex)); return; }
        if (event.target.closest("[data-git-retry]")) retryGitDelivery(objective);
      });
      $("drawerClose").addEventListener("click",closeDrawer);
      $("drawerBackdrop").addEventListener("click",(event)=>{if(event.target===$("drawerBackdrop"))closeDrawer();});
      document.addEventListener("keydown",(event)=>{if(event.key==="Escape"){if(state.report.open)closeReportCenter();else closeDrawer();}});
      document.addEventListener("visibilitychange",()=>{setOfficeScenePaused(document.hidden);if(!document.hidden){refresh({reason:"visibility_resume"});if(state.report.open)fetchReportEvents("incremental");startToolOutcomeStream();}schedule();scheduleReportPoll();});
      document.addEventListener("freeze",()=>setOfficeScenePaused(true));
      document.addEventListener("resume",()=>setOfficeScenePaused(state.scene.reducedMotion||document.hidden));
      window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change",(event)=>{state.animations.reducedMotion=event.matches;state.scene.reducedMotion=event.matches;setOfficeScenePaused(event.matches||document.hidden);});
      window.addEventListener("offline",()=>{state.offline=true;cancelActiveRequest("network_offline");cancelReportRequest();closeToolOutcomeStream();cancelAllSceneMovements(true);setOfficeScenePaused(true);notice.textContent="网络已断开，恢复后会重新获取完整办公室投影。";notice.className="notice show error";sync.textContent="网络已断开";});
      window.addEventListener("online",()=>{
        state.offline=false; state.needsFullRebuild=true; setOfficeScenePaused(state.scene.reducedMotion||document.hidden);
        if (state.request) state.pendingFullRefresh=true;
        else refresh({force:true,reason:"network_recovery",cancelPrevious:false,full:true});
        if(state.report.open){state.report.controller?.abort();state.report.controller=null;fetchReportEvents("incremental");}
        startToolOutcomeStream();
      });
      function destroyPage() {
        if(state.destroyed)return;
        state.destroyed=true; state.pendingFullRefresh=false;
        cancelActiveRequest("page_destroy"); cancelReportRequest(); closeToolOutcomeStream(); clearTimeout(state.timer); clearTimeout(state.snapshotRetry); clearTimeout(state.report.timer); clearTimeout(state.report.focusTimer);
        state.timer=null; state.snapshotRetry=null; state.report.timer=null; state.report.focusTimer=null;
        for(const controller of state.auxiliaryRequests)controller.abort();
        state.auxiliaryRequests.clear();
        for(const timer of state.animations.timers.values())clearTimeout(timer);
        state.animations.timers.clear(); state.animations.writerLocks.clear(); state.actionInFlight.clear();
        destroyOfficeScene();
        uninstallOfficeSceneSurface();
      }
      window.addEventListener("pagehide",destroyPage);
      window.addEventListener("beforeunload",destroyPage);
      window.addEventListener("pageshow",(event)=>{
        if(!event.persisted)return;
        state.destroyed=false; state.pendingFullRefresh=false; state.needsFullRebuild=true; state.etag=""; state.revision="";
        installOfficeSceneSurface();
        refresh({force:true,reason:"visibility_resume",cancelPrevious:false,full:true}); schedule(); scheduleReportPoll(); startToolOutcomeStream();
      });
      installReportSurface();
      installOfficeSceneSurface();
      installOfficePerspective();
      refresh({force:true,reason:"initial_load",full:true}).finally(()=>startToolOutcomeStream()); schedule();
    })();
  </script>
</body>
</html>`;
}
