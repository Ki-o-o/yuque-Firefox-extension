# 语雀浏览器插件 Firefox 适配版 (v2.0.5)

本项目基于 [语雀 Chrome/Edge 浏览器插件](https://github.com/yuque/yuque-chrome-extension) v2.0.5 版本进行 Firefox 适配。原版插件使用 Chrome Manifest V3 构建，依赖大量 Chrome/Edge 独有的 API（如 `service_worker`、`sidePanel`、`offscreen` 等）。本适配通过编写三层 polyfill 脚本，在不修改任何编译后业务代码的前提下，使插件在 Firefox 浏览器中完整运行。

## 功能完整性

| 功能 | Edge 原版 | Firefox 适配版 | 说明 |
|------|-----------|----------------|------|
| 笔记保存 | ✅ | ✅ | 完全正常 |
| 剪藏 (Clip) | ✅ | ✅ | 侧边栏 + 浮动界面均可用 |
| OCR 截图识别 | ✅ | ✅ | 侧边栏 + 浮动界面均可用 |
| 全文提取 | ✅ | ✅ | 侧边栏 + 浮动界面均可用 |
| 图片列表 | ✅ | ✅ | 完全正常 |
| 键盘快捷键 | ✅ | ✅ | Ctrl+Shift+P 打开侧边栏等 |
| 右键菜单 | ✅ | ✅ | 完全正常 |
| 侧边栏 | ✅ (sidePanel) | ✅ (sidebarAction) | API 不同，已适配 |
| 浮动界面 | ✅ | ✅ | 通过 iframe API 代理实现 |
| 登录认证 | ✅ | ✅ | 完全正常 |
| 离屏文档 (Offscreen) | ✅ | ❌ (Stub) | Firefox 不支持，已用空实现替代 |

## 文件改动概览

### 新增文件

| 文件 | 作用 |
|------|------|
| `firefox-polyfill.js` | **后台脚本 polyfill**（约 1200 行）。在 `static/background/index.js` 之前加载，修补 15+ 项 Chrome/Firefox API 差异，包含完整的 ChromeAPI 和 DocumentAPI 实现 |
| `firefox-sidebar-polyfill.js` | **侧边栏/选项页 polyfill**（约 380 行）。在 `tabs/sandbox.html` 和 `options.html` 中加载，修补环境检测、API 代理、sendMessage 兼容性 |
| `firefox-content-polyfill.js` | **内容脚本 polyfill**（约 230 行）。在所有网页中最先加载（`document_start`），修补 API 兼容性并修复浮动球 CSS 问题 |

### 修改文件

| 文件 | 改动说明 |
|------|----------|
| `manifest.json` | 添加 Firefox 专属配置、更改 background 为 scripts 模式、添加 sidebar_action、调整内容脚本加载顺序、移除不兼容的配置项 |
| `tabs/sandbox.html` | 添加防双层滚动条 CSS、加载 sidebar polyfill 脚本 |
| `options.html` | 加载 sidebar polyfill 脚本 |

### 删除/移除的内容

| 内容 | 原因 |
|------|------|
| `update_url` 字段 | Chrome/Edge 专用的自动更新 URL |
| `offscreen` 权限 | Firefox 不支持 offscreen documents API |
| `externally_connectable` 字段 | Firefox 不支持此配置 |
| 第二个空的 `web_accessible_resources` 条目 | 无实际作用，清理冗余 |

### 未修改的文件

所有编译后的业务代码文件均**未做任何修改**，与 Edge 原版完全一致：

- `static/background/index.js` — 后台业务逻辑
- `tabs/sandbox.61cac5db.js` — 侧边栏 React 应用
- `content-app.87739400.js` — 内容脚本（DOM 解析/剪藏）
- `app.d8f06386.js` — 浮动球 UI
- `overlay-app.a6405488.js` — 浮动面板控制
- `context-menu.175d24e9.js` — 右键菜单
- `user-selection.2575c452.js` — 文本选区
- `adapter.53d16c67.js` — 消息适配器
- `user.7868b395.js` / `user.fcde16e1.js` — 用户脚本
- `inject-script.d7a55473.js` — 注入脚本
- `esm-19.66294edf.js` — ESM 模块
- `offscreen.*` — 离屏文档（保留但不生效）
- `lakex/*` — Lake 编辑器库
- 所有 CSS 和图标文件

---

## 详细改动说明

### manifest.json

```diff
+ "browser_specific_settings": {
+   "gecko": {
+     "id": "yuque-browser-plugin@antgroup.com",
+     "strict_min_version": "109.0"
+   }
+ }
```
**原因**：Firefox 要求扩展声明 gecko 特定的扩展 ID 和最低版本。

```diff
- "background": {
-   "service_worker": "static/background/index.js"
- }
+ "background": {
+   "scripts": ["firefox-polyfill.js", "static/background/index.js"]
+ }
```
**原因**：Firefox MV3 不支持 `service_worker`，使用 `scripts` 数组模式。`firefox-polyfill.js` 必须在 `index.js` 之前加载，以便在业务代码执行前完成所有 API 补丁。

```diff
+ "sidebar_action": {
+   "default_title": "语雀",
+   "default_panel": "tabs/sandbox.html",
+   "default_icon": {
+     "16": "icon16.plasmo.26020647.png",
+     "32": "icon32.plasmo.6b45357b.png",
+     "48": "icon48.plasmo.807be196.png",
+     "64": "icon64.plasmo.4b24a360.png",
+     "128": "icon128.plasmo.6e43d482.png"
+   }
+ }
```
**原因**：Edge 使用 `chrome.sidePanel` API 打开侧边面板，Firefox 使用 `browser.sidebarAction` API。

```diff
  "content_scripts": [
+   {
+     "matches": ["https://*/*", "http://*/*"],
+     "js": ["firefox-content-polyfill.js"],
+     "run_at": "document_start"
+   },
    ...
  ]
```
**原因**：内容脚本 polyfill 必须在 `document_start` 阶段最先运行，在所有其他内容脚本之前完成 API 补丁。

```diff
- "permissions": [..., "offscreen", ...]
+ "permissions": [...] // 移除 offscreen
```
**原因**：Firefox 不支持 `offscreen` 权限。

```diff
- "externally_connectable": {
-   "matches": ["https://*.yuque.com/*", ...]
- }
```
**原因**：Firefox 不支持 `externally_connectable` 配置。

---

### firefox-polyfill.js（后台 polyfill）

此文件是适配的核心，包含 15+ 个修补段落。在后台脚本上下文中运行，在编译后的 `index.js` 之前执行。

#### Section -1: Chrome API 桥接

```javascript
var apis = ['scripting', 'tabs', 'storage', 'cookies', 'webRequest',
            'commands', 'contextMenus', 'action', 'notifications',
            'windows', 'i18n', 'alarms', 'permissions'];
apis.forEach(function (api) {
  if (chrome[api] === undefined && browser[api] !== undefined) {
    chrome[api] = browser[api];
  }
});
```

**原因**：Firefox 的 chrome 兼容层可能缺少 `chrome.scripting` 等较新 API，但 `browser.scripting` 存在。编译后的代码全部使用 `chrome.*` 命名空间。剪藏、OCR、全文提取功能依赖 `chrome.scripting.executeScript`，缺失则功能完全失效。

#### Section 0: 异步消息监听器修复

```javascript
chrome.runtime.onMessage.addListener = function (listener) {
  var wrapper = function (msg, sender, sendResponse) {
    var result = listener(msg, sender, sendResponse);
    if (result && typeof result.then === 'function') {
      result.catch(function (e) { /* 记录错误 */ });
      return true; // 保持通道开启
    }
    return result;
  };
  _localListeners.push(wrapper);
  return _origAdd(wrapper);
};
```

**原因**：这是**登录功能失败的根本原因修复**。编译后的 App 类注册了 `async onMessageListener`。在 Firefox 中，async 函数返回 Promise，Firefox 将 Promise 的 resolved value（`true`）作为响应发送给调用方，而非通过 `sendResponse()` 发送的实际数据。修复方式：包装监听器，当检测到返回 Promise 时立即 `return true`（告诉 Firefox "我会异步调用 sendResponse"），让内部的 `sendResponse()` 调用正确传递数据。

#### Section 1: declarativeNetRequest 修补

**原因**：Firefox 使用 `initiatorDomains` 而 Chrome 使用 `domains`。编译后代码使用 `condition.domains`，Firefox 会拒绝。修补将 `domains` 重命名为 `initiatorDomains`，过滤无效域名值（如包含 `@` 的值），并用 try/catch 包装防止未处理异常。

#### Section 2: sidePanel → sidebarAction 映射

**原因**：Chrome/Edge 使用 `chrome.sidePanel.open()` 打开侧边面板，Firefox 使用 `browser.sidebarAction.open()`。创建 `chrome.sidePanel` 对象，将 `open/close` 方法委托给 `browser.sidebarAction`，`getOptions/setOptions/setPanelBehavior` 提供空实现。

#### Section 3: offscreen 空实现

**原因**：Chrome 支持离屏文档 API，Firefox 不支持。提供 `createDocument()`、`closeDocument()`、`hasDocument()` 的空实现，返回空 Promise/false，防止 TypeError。

#### Section 4: getContexts 返回空数组

**原因**：Firefox 121+ 有 `runtime.getContexts` 但不支持 `"OFFSCREEN_DOCUMENT"` 枚举值，会抛出异常。始终替换为返回 `[]` 的 stub，使 `initOffscreen()` 正常流转到 `createDocument`（即 Section 3 的空实现）。

#### Section 5: onMessageExternal 空实现

**原因**：编译后代码调用 `chrome.runtime.onMessageExternal.addListener()`。如果该 API 未定义，TypeError 会阻止后续的 `onMessage.addListener` 注册，导致**所有后台消息路由中断**。

#### Section 5b: debugger API 空实现

**原因**：编译后代码可能调用 debugger 方法，缺失则 TypeError 中断执行。

#### Section 6: cookies.getAll 移除 partitionKey

**原因**：Firefox 不支持 `partitionKey` 字段，留存会导致 cookie 操作失败。

#### Section 7: getURL 返回值修复

```javascript
chrome.runtime.getURL = function (path) {
  var url = _origGetURL(path || '');
  if (!path) {
    return url.replace('moz-extension://', 'chrome-extension://');
  }
  return url;
};
```

**原因**：编译后的 HTTP 客户端通过 `getURL("").replace("chrome-extension://","").replace("/","")` 提取扩展 UUID 作为请求头。Firefox 的 `getURL("")` 返回 `"moz-extension://uuid/"`，replace 链产生畸形字符串 `"moz-extension:/uuid/"`，导致服务端拒绝请求。

#### Section 8: webRequest 空 URL 数组修复

**原因**：`openYuqueLogin()` 调用 `addListener(fn, {urls: [], tabId: id})`，Firefox 对空 `urls[]` 抛出异常。默认替换为 `['<all_urls>']`。

#### Section 9: sendMessage 拦截器（核心修复）

这是最复杂的一个修补，解决两个关键问题：

**问题 A — Plasmo null extensionId**：Plasmo 的 `sendToBackground(msg)` 编译为 `sendMessage(msg.extensionId ?? null, msg)`。当 extensionId 不存在时，null 作为第一个参数传递。Firefox 不将 null 视为"省略的 extensionId"，导致消息格式错误。

**问题 B — 后台自消息**：Firefox 的 `background.scripts` 模式下，后台脚本使用 `sendMessage` 发送的消息无法被自己的 `onMessage` 监听器接收。但 Plasmo 的环境检测判断 background 有 `window` 对象，返回 `"unknown"` 而非 `"background"`，导致所有 ChromeAPI 调用通过 bridge proxy 使用 `sendMessage()`。

**修复**：(A) 剥离 null/undefined 的第一个参数；(B) 拦截 `bridge/*` 消息并本地投递给 `_localListeners` 数组，将 httpRequest 等消息转换为 background handler 期望的直接格式。

#### Section 10/10b: CSRF Token 自动注入

**原因**：语雀服务端要求 POST/PUT/DELETE 请求携带 `x-csrf-token` 头（值为 `yuque_ctoken` cookie），否则返回 403 Forbidden。Section 10 修补 XMLHttpRequest，Section 10b 修补 Fetch API（Axios 使用 fetch adapter）。

#### Section 11/12: bridge 消息路由

**原因**：侧边栏通过 `bridge/document` 和 `bridge/background` 消息调用 ChromeAPI/DocumentAPI。编译后的 background handler 没有这些消息的 case。注册独立的 onMessage 监听器处理这些消息，路由到内置的 API 实现。

#### Section 12b: screenshot removeCut 响应修复

**原因**：编译后的 handler 对 screenshot `"removeCut"` 操作执行 `executeScript` 但不发送响应。Firefox 保持消息通道开启后无响应到达，Promise 以 "Promised response went out of scope" 错误 reject。修复：拦截该消息，执行脚本后主动发送 `{status: 'ok'}`。

#### Section 13: commands.onCommand 注入 Tab 参数

**原因**：Firefox 的 `commands.onCommand` 监听器只接收 `(command)` 一个参数，而 Chrome/Edge 传递 `(command, tab)`。编译后代码访问 `tab.id` 且无 null 检查，导致 TypeError。修补注入当前活动标签页作为第二个参数。

#### Section 14: open_sidepanel 快捷键处理

**原因**：用户按 Ctrl+Shift+P 时需要打开侧边栏，通过 `browser.sidebarAction.open()` 实现。

#### Section 15: iframe API 代理

**原因**：`tabs/sandbox.html` 作为 iframe 加载在网页中时（浮动面板模式），Firefox 将其视为 web-accessible resource，只有 `runtime.sendMessage` 等基础 API 可用，没有 `chrome.tabs`、`chrome.scripting`。sidebar polyfill 创建的 API shim 通过特殊消息名委托到此处理器。

支持的代理操作：
- `__FF_TABS_QUERY__` — 查询标签页
- `__FF_TABS_SEND_MESSAGE__` — 向标签页发消息
- `__FF_TABS_GET__` — 获取标签页信息
- `__FF_TABS_CREATE__` — 创建新标签页（"保存成功 > 点击查看"功能）
- `__FF_TABS_UPDATE__` — 更新标签页
- `__FF_TABS_REMOVE__` — 关闭标签页

---

### firefox-sidebar-polyfill.js（侧边栏 polyfill）

在 `tabs/sandbox.html` 和 `options.html` 中加载，先于业务脚本执行。

#### Fix 0: String.prototype.includes 补丁

**原因**：Plasmo 环境检测器通过 `window.location.href.includes("chrome-extension://")` 判断是否在扩展侧边栏中。Firefox 使用 `moz-extension://` 协议，检测失败返回 `"unknown"` 而非 `"side_panel"`，导致 UI 渲染异常。修补 `String.prototype.includes`，当搜索字符串为 `"chrome-extension://"` 且被搜索字符串含 `"moz-extension://"` 时返回 true。

#### Fix 0b: getURL 返回值修复

**原因**：同后台 Section 7。在 sidebar 上下文中也需要修补，因为 Axios 请求拦截器在 sidebar 上下文中同样执行 UUID 提取逻辑。同时修补 `browser.runtime.getURL` 和 `chrome.runtime.getURL`。

#### Fix 0e: iframe 上下文 API Shim

**原因**：当 `sandbox.html` 作为浮动面板的 iframe 加载时，Firefox 不提供 `chrome.tabs` 等特权 API。检测方式：尝试访问 `chrome.tabs.query`，不存在则判定为 iframe 上下文。创建 `chrome.tabs` shim 对象，将 `query`/`sendMessage`/`get`/`create`/`update`/`remove` 方法通过 `runtime.sendMessage` 委托给后台（后台 Section 15 处理）。

#### Fix 1: window.chrome Proxy

**原因**：部分 API 可能未被显式桥接到 chrome 对象。创建 Proxy 拦截 `chrome.*` 属性访问，当 chrome 上不存在时自动回退到 `browser.*`。三级降级策略：Object.defineProperty → 直接赋值 → 逐 key 补丁。

#### Fix 2: sendMessage null extensionId 修复

**原因**：同后台 Section 9 问题 A。Plasmo 的 `sendToBackground()` 编译后传递 null 作为 extensionId。在 sidebar 上下文中同样需要修补。三级降级策略修补 `browser.runtime.sendMessage` 和 `chrome.runtime.sendMessage`。

---

### firefox-content-polyfill.js（内容脚本 polyfill）

在所有网页中 `document_start` 阶段最先加载。

#### Fix 0: String.prototype.includes 补丁

**原因**：与 sidebar Fix 0 相同。内容脚本中的环境检测也需要正确识别扩展协议。

#### Fix 1: getURL 返回值修复

**原因**：与后台 Section 7 相同。内容脚本中的 UUID 提取也需要正确工作。

#### Fix 2: sendMessage null extensionId 修复

**原因**：与 sidebar Fix 2 相同。内容脚本向后台发送消息时也可能遇到 Plasmo 的 null extensionId 问题。采用三级降级策略确保可靠修补。

#### Fix 3: Chrome API 桥接

**原因**：确保内容脚本中 `chrome.*` 命名空间可以访问 `browser.*` 的 API。

#### Fix 5: 浮动球悬停区域修复

**原因**：浮动球的 Wrapper 组件使用 `position: fixed; right: 0` 但未设置 width，导致其布局区域可能覆盖整个视口宽度，与面板 iframe 重叠。鼠标在面板区域移动时误触发浮动球的 `onMouseEnter` 展开菜单。通过 MutationObserver 监测 `csui-app` Shadow DOM 元素的创建，注入 CSS 将 Wrapper 约束为 `width: fit-content`。

---

### tabs/sandbox.html

```diff
+ <style>
+ html, body {
+   overflow: hidden !important;
+   height: 100% !important;
+   margin: 0 !important;
+   padding: 0 !important;
+ }
+ #__plasmo { height: 100% !important; overflow: hidden !important; ... }
+ #qingai-extension-app-container { height: 100% !important; overflow: hidden !important; ... }
+ #qingai-extension-app-container > div { height: 100% !important; overflow: hidden !important; ... }
+ /* 排除固定定位的菜单按钮 */
+ #qingai-extension-app-container > div > div:not([style*="position: fixed"]) {
+   height: 100% !important;
+   overflow: hidden !important;
+   flex: 1 !important;
+ }
+ </style>
```

**原因**：Firefox 中 iframe 内的 sandbox 页面出现双层滚动条（外层容器和内层编辑器各一个）。通过逐级设置 `overflow: hidden; height: 100%` 约束布局。使用 `:not([style*="position: fixed"])` 排除右上角菜单按钮容器，避免将其强制拉伸到 100% 高度（这会导致菜单触发区域异常扩大）。

```diff
+ <script src="/firefox-sidebar-polyfill.js"></script>
  <script src="/user.7868b395.js"></script>
```

**原因**：sidebar polyfill 必须在 `user.7868b395.js` 之前加载，先完成 API 补丁再初始化业务逻辑。

---

### options.html

```diff
+ <script src="/firefox-sidebar-polyfill.js"></script>
  <script src="/user.7868b395.js"></script>
```

**原因**：选项页同样需要 sidebar polyfill 提供的 API 兼容层。

---

## 安装使用

### 方式一：临时加载（开发调试）

1. 在 Firefox 地址栏输入 `about:debugging#/runtime/this-firefox`
2. 点击"临时载入附加组件..."
3. 选择项目目录中的 `manifest.json` 文件
4. 插件加载完成后即可使用（浏览器重启后需重新加载）

### 方式二：打包为 .xpi 安装（持久安装）

1. 将项目目录中的所有文件（**不包括** `yuque.2.0.5_edge/` 目录和 `.claude/` 目录）打包为 `.zip` 文件
2. 将 `.zip` 后缀名改为 `.xpi`
3. 在 Firefox 中打开 `about:addons`，点击齿轮图标 → "从文件安装附加组件..."
4. 选择 `.xpi` 文件安装

> **注意**：未签名的 .xpi 只能在 Firefox Developer Edition 或 Nightly 版本中安装。正式版 Firefox 要求扩展经过 [Mozilla AMO](https://addons.mozilla.org/) 签名。如需在正式版中使用，可以：
> - 使用 `about:config` 将 `xpinstall.signatures.required` 设为 `false`（仅 Developer Edition / Nightly 有效）
> - 或通过 [web-ext](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/) 工具签名：`web-ext sign --api-key=YOUR_KEY --api-secret=YOUR_SECRET`

### 方式三：使用 web-ext 工具

```bash
# 安装 web-ext
npm install -g web-ext

# 在项目目录中运行（自动打开 Firefox 并加载插件）
cd /path/to/yuque_code
web-ext run

# 打包为 .zip
web-ext build --ignore-files="yuque.2.0.5_edge/**" --ignore-files=".claude/**"
```

### 使用说明

1. 安装后在 Firefox 工具栏找到语雀图标
2. **侧边栏模式**：点击 `查看 → 侧栏 → 语雀` 或按 `Ctrl+Shift+P` 打开侧边栏
3. **浮动界面模式**：点击工具栏语雀图标，在页面右侧出现浮动球，点击浮动球展开面板
4. 首次使用需要登录语雀账号（访问 `www.yuque.com` 登录后刷新插件）
