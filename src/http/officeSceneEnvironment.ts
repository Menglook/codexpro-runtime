export const OFFICE_SCENE_ENVIRONMENT_HTML = String.raw`
          <div class="scene-depth-grid" aria-hidden="true"></div>
          <div class="scene-command-halo" aria-hidden="true"><span></span><span></span><span></span></div>
          <div class="scene-holo-ticker" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
`;

export const OFFICE_SCENE_ENVIRONMENT_STYLES = String.raw`
    .scene-depth-grid{position:absolute;inset:0;background:linear-gradient(90deg,transparent 49.8%,rgba(61,213,255,.045) 50%,transparent 50.2%),linear-gradient(0deg,transparent 49.8%,rgba(61,213,255,.04) 50%,transparent 50.2%);background-size:72px 72px;transform:translate(var(--scene-parallax-x,0),var(--scene-parallax-y,0)) perspective(900px) rotateX(8deg) scale(1.06);transition:transform .18s ease-out;transform-origin:center bottom;opacity:.7}
    .scene-command-halo{position:absolute;left:43.5%;top:63%;width:170px;height:70px;transform:translate(-50%,-50%) rotateX(64deg);border:2px solid rgba(52,216,255,.28);border-radius:50%;box-shadow:0 0 34px rgba(52,216,255,.1),inset 0 0 22px rgba(52,216,255,.08)}.scene-command-halo span{position:absolute;inset:10px;border:1px dashed rgba(100,242,180,.25);border-radius:50%}.scene-command-halo span:nth-child(2){inset:20px;border-color:rgba(165,123,255,.35)}.scene-command-halo span:nth-child(3){inset:29px;border-style:solid;border-color:rgba(246,223,115,.25)}
    .scene-holo-ticker{position:absolute;left:26%;top:9%;display:flex;align-items:flex-end;gap:4px;width:120px;height:34px;border:1px solid rgba(52,216,255,.2);border-radius:7px;background:rgba(5,17,32,.62);padding:6px;box-shadow:0 0 18px rgba(52,216,255,.08)}.scene-holo-ticker i{display:block;flex:1;border-radius:2px 2px 0 0;background:linear-gradient(180deg,var(--scene-cyan),rgba(52,216,255,.18))}.scene-holo-ticker i:nth-child(1){height:45%}.scene-holo-ticker i:nth-child(2){height:78%}.scene-holo-ticker i:nth-child(3){height:58%}.scene-holo-ticker i:nth-child(4){height:90%}.scene-holo-ticker i:nth-child(5){height:68%}
`;
