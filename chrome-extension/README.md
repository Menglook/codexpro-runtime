# CodexPro Browser Bridge Chrome 扩展

CodexPro 默认通过专用 Chrome 的 CDP 连接直接创建并控制自己打开的标签页，不要求点击扩展授权。当前 ChatGPT 工具不再提供授权状态、绑定授权标签页或释放授权入口；该扩展目录仅为旧版本兼容保留。页面读取、CDP 控制、语义观察和视觉取帧均由本机 CodexPro 完成。

## 本地安装

Google Chrome 149 及以后版本不允许再通过 `--load-extension` 自动载入本地扩展。Browser Bridge 会先把本目录同步到 `%LOCALAPPDATA%\CodexPro\browser-extension-v2`，然后需要在专用 Chrome Profile 中手动安装一次。

1. 先运行 `npm run browser-bridge:start`。
2. 打开 `chrome://extensions`。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”。
5. 选择 `%LOCALAPPDATA%\CodexPro\browser-extension-v2`。
6. 确认 CodexPro HTTP 服务运行在 `http://127.0.0.1:8787`，或在扩展弹窗中填写实际本机端口。
7. 日常使用无需点击扩展；直接调用 `browser_open`，CodexPro 会在专用 Chrome 中创建自己的标签页。

同一个专用 Profile 会保留安装状态，后续重启无需重复安装。扩展源码更新后，需要在 `chrome://extensions` 对已安装扩展执行一次“重新加载”，否则专用 Profile 仍会运行旧副本。

## 旧版本兼容

旧扩展中的授权租约和标签页标记代码暂时保留，避免升级时破坏旧 Profile；它们不再是当前 ChatGPT 浏览器工具的运行前提，也不会要求用户授权。

## 真实运行状态判断

- Chrome 启动命令中出现 `--load-extension` 不能证明扩展已安装或运行；Chrome 149 可能直接忽略该参数。
- CodexPro 通过专用 Profile 的 `Secure Preferences` / `Preferences` 验证扩展是否已注册并启用。
- Manifest V3 Service Worker 会休眠；`sleeping_or_inactive` 表示扩展已安装但 Worker 当前休眠，不等于未安装。
- 扩展向本机 Bridge 发送扩展版本和协议版本；协议不兼容时 Bridge 返回 HTTP 426，不继续授权。
- `browser_runtime_probe` 直接连接并观察当前受控标签页，不导航、不刷新、不点击、不输入；只有真实语义观察成功才报告 `usable=true`。

扩展只发送授权 ID、浏览器实例 ID、tab/window ID、URL、标题、扩展版本和协议版本。它不会发送 Cookie、密码、Token、Local Storage、Session Storage 或页面 HTML。

付款、提交订单、删除、发布、发送消息、修改密码和生产配置等高风险动作仍受 CodexPro 浏览器安全门禁限制；“信任标签页”不等于允许高风险写操作。
