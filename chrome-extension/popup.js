const page = document.querySelector("#page");
const state = document.querySelector("#state");
const message = document.querySelector("#message");
const bridgeInput = document.querySelector("#bridge-url");
const authorizeButton = document.querySelector("#authorize");
const releaseButton = document.querySelector("#release");

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

function busy(value) {
  authorizeButton.disabled = value;
  releaseButton.disabled = value;
}

async function refresh() {
  const result = await send("get-active-status");
  if (!result.ok) throw new Error(result.error);
  bridgeInput.value = result.bridgeUrl;
  page.textContent = result.tab?.title ? `${result.tab.title}\n${result.tab.url || ""}` : "无法读取当前标签页";
  const trusted = Boolean(result.trusted && result.trust);
  const expiresAtMs = Date.parse(String(result.authorization?.expiresAt || ""));
  const leaseState = Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()
    ? `当前租约至 ${new Date(expiresAtMs).toLocaleTimeString()}`
    : "等待 Bridge 恢复";
  state.textContent = trusted ? `已手动绑定 · 自动续期 · ${leaseState}` : "无需授权 · 可选手动绑定";
  state.classList.toggle("on", trusted);
  authorizeButton.textContent = trusted ? "重新登记当前标签页" : "可选：绑定当前标签页";
  releaseButton.disabled = !trusted;
}

bridgeInput.addEventListener("change", async () => {
  message.textContent = "";
  const result = await send("set-bridge-url", { url: bridgeInput.value });
  if (!result.ok) message.textContent = result.error;
  else bridgeInput.value = result.bridgeUrl;
});

authorizeButton.addEventListener("click", async () => {
  busy(true);
  message.textContent = "";
  try {
    const save = await send("set-bridge-url", { url: bridgeInput.value });
    if (!save.ok) throw new Error(save.error);
    const result = await send("authorize-active-tab");
    if (!result.ok) throw new Error(result.error);
    await refresh();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy(false);
  }
});

releaseButton.addEventListener("click", async () => {
  busy(true);
  message.textContent = "";
  try {
    const result = await send("release-active-tab");
    if (!result.ok) throw new Error(result.error);
    await refresh();
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    busy(false);
  }
});

refresh().catch((error) => {
  message.textContent = error instanceof Error ? error.message : String(error);
});
