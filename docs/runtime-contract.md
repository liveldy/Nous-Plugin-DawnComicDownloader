# 页面 ↔ 原生模块的调用契约

页面运行在宿主的 sandbox iframe 里，自身不能出网、不能写盘。所有副作用都走一次 `runtime.invoke`：

```js
await NousPlugin.request('runtime.invoke', {method, params}, {timeoutMs});
```

模块是 Windows JVM 实现（`app.dawncomic.PluginMain`），从 stdin 读一行 JSON、向 stdout 写一行 JSON。一次请求一行回答；stdout 不混日志（日志走 stderr）。参数与返回值都是 JSON 对象，出错时返回 `{"error":"E_<CODE>: 说明"}`。

页面只在 `ui/app.js` 的 `Host.invoke` 与 `ctx` 里使用这些方法；`ui/engine.js` 只认 `ctx.get/post`。

## 方法与用途

| 方法 | 参数 | 返回 | 页面用途 |
| --- | --- | --- | --- |
| `engine.ping` | `{}` | `{pong, uptimeMs}` | 启动自检 |
| `engine.info` | `{}` | `{name, version, java, os, dataRoot, engineHome, userAgent}` | 诊断 |
| `http.request` | `{url, method?, headers?, body?, bodyBase64?, binary?, useCookies?, redirects?, timeoutMs?}` | `{status, url, headers, body, bodyBase64, bytes}` | 站点检索、详情、阅读器、SauceNAO/IQDB（multipart 由页面拼好放 `bodyBase64`） |
| `http.download` | `{url, path, headers?, useCookies?, skipExisting?, timeoutMs?}` | `{path, bytes, sha256, status, contentType, skipped}` | 逐页/逐视频落盘，先写 `.part` 再改名 |
| `fs.allowRoot` | `{path}` | `{path}` | 保存设置时登记下载目录；之后写入只允许在该目录与插件数据目录内 |
| `fs.mkdirs` | `{path}` | `{path, created}` | 建 `<编号> <标题>/` |
| `fs.stat` / `fs.list` / `fs.delete` | `{path}` | 文件信息 / 列表 / `{deleted, files}` | 目录检查、清理 |
| `file.readBase64` | `{path, maxBytes?}` | `{base64, bytes, mime}` | 把本机图片送进反查 |
| `cookie.set` / `cookie.list` / `cookie.clear` | `{host, cookie}` / `{}` / `{host?}` | — | 18comic 的 `cf_clearance` 等通行证，按域持久化到数据目录的 `cookies.json` |
| `net.probe` | `{url, timeoutMs?}` | `{status, contentType, bytes, finalUrl}` | 设置页测连通 |
| `image.proxy` | `{url, maxBytes?=1500000, referer?}` | `{dataUrl, bytes, mime}` | 封面/站点图标以 `data:` URL 回传，绕过 iframe 的 CSP；非图片类型拒绝 |
| `system.openFolder` | `{path}` | `{opened}` | “打开目录” |

## 行为约定（页面依赖的部分）

- **超时**：`timeoutMs` 1000–600000，默认 30000；覆盖整个收发过程，含响应体。大文件下载用 120000。
- **重定向**：默认跟随最多 5 跳；`redirects:0` 时保留 3xx。Xpicvid 的检索依赖这一跳（POST → 302 → 结果页），Cookie 在跳转中保留。
- **Cookie**：进程内 web 请求默认带上 cookie 罐里该域的 Cookie；`set-cookie` 不会回传给页面。
- **二进制**：`binary:true` 时只填 `bodyBase64`，`body` 为空（避免双倍体积）。文本响应则相反。
- **已存在文件**：`skipExisting` 为真且目标大小 > 0 时返回 `skipped:true`、`status:0`、`contentType:""`；超过 64 MiB 的既有文件不再算 sha256（返回空串）。
- **写入范围**：`fs.*` 的写操作只允许插件数据目录与 `fs.allowRoot` 登记过的目录；删除不允许命中根目录本身。读操作（`fs.list/stat/readBase64`）不设根限制。
- **空行**：stdin 的空行/纯空白行不产生任何输出（多一行输出会顶掉下一条请求的响应）。
- **网络出口**：`java.net.http` 默认不读环境变量，模块里的 `EnvProxy` 会读 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY`，也接受 `-Dhttps.proxyHost` 与 `java.net.useSystemProxies=true`；都没有时直连。

## 错误码

`E_INVALID_PARAMS` 参数不合法 · `E_HTTP` HTTP/网络失败 · `E_TIMEOUT` 超时 · `E_IO` 文件系统 · `E_TOO_LARGE` 超过大小上限 · `E_DENIED` 越出允许写入的根 · `E_UNSUPPORTED` 未知方法或不支持的协议。

页面上的 `E_CHALLENGE` / `E_PARSE` 由 `ui/engine.js` 产生，用于区分“站点拦截”与“解析结构变化”，不要与模块错误的语义混用。

## ABI 与打包

- 模块 ZIP：`app/plugin.jar`（入口 `app.dawncomic.PluginMain`）+ `runtime/`（`jlink` 出来的 `java.base,java.logging,java.net.http,jdk.crypto.ec,jdk.zipfs`）。
- `manifest.json` 的 `runtime.windows-x64` 固定模块 URL、SHA-256 与字节数；宿主安装前校验。
- 构建：`python build.py windows`（JDK 17+；本机用 JDK 26 以 `--release 17` 编译）。构建可复现：jar 固定 `--date`，ZIP 用固定时间戳，同一源码两次构建的 SHA-256 相同。
