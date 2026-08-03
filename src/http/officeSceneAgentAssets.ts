import { OFFICE_AGENT_PROTOTYPES, type OfficeAgentIdentityV1 } from "./officeSceneAgentIdentity.js";

const prototypeSymbol = (prototype: string, index: number): string => {
  const head = [
    '<path d="M24 14 31 5h10l8 9-2 24H25z"/>',
    '<path d="M22 17 28 7h16l7 10-5 22H27z"/>',
    '<path d="M26 8h20l6 12-7 18H27l-5-18z"/>',
    '<path d="M23 13 35 4l14 9 2 18-8 9H29l-8-9z"/>'
  ][index % 4];
  const shoulder = [
    "M17 43 27 35h18l11 8-5 9H22z",
    "m13 43 15-9h17l15 9-8 10H21z",
    "m16 40 11-7h20l10 7-2 13H18z",
    "m12 45 16-12h17l16 12-10 9H22z"
  ][index % 4];
  const module = prototype === "hologram"
    ? '<path class="agent-back-module" d="M21 45h36v43H21z" opacity=".18"/>'
    : prototype === "delivery"
      ? '<path class="agent-back-module" d="M18 52h11v23H18zm31 0h11v23H49z"/>'
      : '<path class="agent-back-module" d="M19 43h8v31h-8zm34 0h8v31h-8z"/>';
  return `<symbol id="office-agent-${prototype}" viewBox="0 0 76 112">
    <ellipse class="agent-shadow" cx="38" cy="105" rx="25" ry="6"/>
    <g class="agent-silhouette">
      ${module}
      <g class="agent-legs"><path class="agent-leg actor-leg actor-leg-left" d="m27 78 10 1-2 23H23z"/><path class="agent-leg actor-leg actor-leg-right" d="m40 79 10-1 4 24H42z"/><path class="agent-foot" d="M20 98h16v7H18zm22 0h16l2 7H42z"/></g>
      <g class="agent-torso actor-body"><path class="agent-shoulders" d="${shoulder}"/><path class="agent-chassis" d="M24 45h29l-4 37H28z"/><path class="agent-panel" d="M30 53h17v18H30z"/></g>
      <g class="agent-arm actor-arm actor-arm-left"><path d="m19 46 9 4-8 30-9-4z"/><circle cx="15" cy="80" r="5"/></g>
      <g class="agent-arm actor-arm actor-arm-right"><path d="m49 49 9-4 8 31-9 4z"/><circle cx="61" cy="80" r="5"/></g>
      <g class="agent-head actor-head">${head}<path class="agent-visor" d="M27 20h20l-3 9H29z"/><circle class="agent-sensor" cx="38" cy="24" r="3"/></g>
      <circle class="agent-core" cx="38" cy="59" r="7"/><circle class="agent-core-ring" cx="38" cy="59" r="11"/>
    </g>
  </symbol>`;
};

export const OFFICE_AGENT_SPRITE_DEFINITIONS = `<svg class="office-agent-definitions" aria-hidden="true" focusable="false" width="0" height="0"><defs>${OFFICE_AGENT_PROTOTYPES.map(prototypeSymbol).join("")}</defs></svg>`;

export const OFFICE_AGENT_ASSET_SCRIPT = String.raw`
      const OFFICE_AGENT_PROTOTYPES = Object.freeze(${JSON.stringify(OFFICE_AGENT_PROTOTYPES)});
      function officeAgentSvg(identity){
        const prototype=OFFICE_AGENT_PROTOTYPES.includes(identity?.prototype)?identity.prototype:"developer";
        const style="--agent-core:"+String(identity?.core_color||"#35d7ff")+";--agent-sensor:"+String(identity?.sensor_color||"#9af4ff")+";--agent-delay:-"+Number(identity?.motion_offset_ms||0)+"ms";
        return '<svg class="actor-svg" viewBox="0 0 76 112" style="'+style+'" aria-hidden="true" focusable="false"><g class="agent-assembly actor-head actor-body actor-arm-left actor-arm-right actor-leg-left actor-leg-right"><use href="#office-agent-'+prototype+'"></use></g></svg>';
      }
`;

export function officeAgentAssetForIdentity(identity: OfficeAgentIdentityV1): string {
  return `office-agent-${identity.prototype}`;
}
