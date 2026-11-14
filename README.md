# DawnComicDownloader · 破晓漫画下载器

Nous 插件。在同一个界面里检索六个图库站点，挑出作品，按编号归档下载。

- 七个来源：Xpicvid（niacg.com）、Ahri Gallery、禁漫天堂（18comic.vip）、Pixiv、Hentai League、Rule34（rule34.us）、Rule34Video。
- 文字检索走各站原生接口；图片检索把图片交给 SauceNAO（可选 key）或 IQDB 认出作品，再把标题、作者、作品名回灌成检索词。
- 结果带封面、标题、作者、标签、页数/时长；选中进下载队列，落到 `<下载目录>/<编号> <标题>/001.jpg`。
- 页面在宿主的 sandbox iframe 里运行，不出网；所有请求、封面取回和落盘都由随包的 Windows 原生模块完成。

## 安装

插件协议 1.3，需要 Nous 1.2.0 及以上，平台 `windows-x64`。

1. 安装随 Release 提供的页面包：`dist/app.nous.dawn-comic-downloader-1.0.1.nous-plugin.json`（插件管理 → 本地安装）。
2. 模块由 `manifest.json` 里的 URL 与 SHA-256 固定，宿主安装时校验。
3. 打开插件 → 设置 → 填下载目录 → 保存设置（这一步同时把目录登记为原生模块允许写入的根）。

本机出网若依赖系统代理，需要让宿主进程带上 `HTTPS_PROXY` / `HTTP_PROXY`（原生模块会读这两个变量，也支持 `-Dhttps.proxyHost`）。没有代理且直连被墙时，检索会返回 `E_TIMEOUT`。

## 使用

| 动作 | 结果 |
| --- | --- |
| 顶部输入关键词回车 | 六个开启的站点并行检索，右上角是总数与失败站点数 |
| 点底部的站点方块 | 关闭/开启该站点；关闭后不再参与检索 |
| 点“图片” | 搜索框下方出现图片检索条（选图 → 识别 → “用这个词”回灌） |
| 结果区顶部的 `全部 / 站点名 + 计数` | 只显示该站的结果（不重新请求），再点回到全部 |
| 点结果卡 | 进/出右侧下载队列，卡片右上角打勾 |
| “开始下载” | 逐项解析、建目录、按页序下载；编号从设置的起始值递增，完成后写库 |
| 设置 → 每源条数 | 每个来源最多取多少条（默认 20，4–60）；调小可明显加快出结果 |
| 卡片右下角的下载图标 | 只保存这张封面，落到 `<下载目录>\_covers\<来源>-<id>.<扩展名>` |
| 设置 → 视频清晰度 | 最高可用 / 720p / 480p / 360p；来源提供多个画质时按此选择（目前 Rule34Video 支持） |
| 卡片右下角的箭头 | 在系统浏览器打开该资源页；收藏页的条目也有「打开」 |
| 卡片左上角的书签 | 收藏到任意收藏夹（可当场新建）；侧栏“收藏”页列出所有条目，可一键加入队列或移除 |
| 下载目录旁的“浏览…” | 先调模块的系统目录对话框；模块过旧或无桌面会话时，退回插件内的目录浏览（`fs.list` 逐层进入、可新建文件夹） |

主题跟随宿主：浅色是纸色 `#F3EFE7`，深色是暖炭 `#14110F`，朱色在深色下分标注与按钮两支（见 `docs/design.md`）。下载目录结构：

```
D:\Manga\
  007 [氏とろん] プールの臨時コーチ\
    001.webp
    002.webp
    ...
  008 [MWD] 昔音 cyrene…\
    001.mp4
```

编号位数在设置里改（2–5），文件夹与页文件共用同一宽度。

## 各站能力

| 站点 | 文字 | 浏览 | 标签 | 说明 |
| --- | --- | --- | --- | --- |
| Xpicvid | ✓ | ✓ | ✓ | 帝国 CMS，检索走 `POST /e/search/index.php`，阅读器 `moeupup-*.html` 顺序出图 |
| Ahri Gallery | ✓ | ✓ | ✓ | OpenCart 改造站，检索参数是 `search_key`（站点搜索框的字段名） |
| 禁漫天堂 | ✓ | ✓ | ✓ | HTML 客户端按 JMComic 移植（详情/章节/页图/乱序参数），Cloudflare 质询需在设置里填 `cf_clearance` |
| Hentai League | ✓ | ✓ | ✓ | WordPress `wp-json`，`contentUrl` 直接是 mp4 |
| Rule34 | ✓ | ✓ | ✓ | Gelbooru 0.1.11 改造站，`?r=posts/index&q=` 之后取 `posts/view` 原图 |
| Rule34Video | ✓ | ✓ | ✓ | KVS 内核，播放页 `flashvars` 取 720p/480p/360p 最高一档 |
| Pixiv | ✓ | ✓ | ✓ | 网页 ajax 端点，无需登录；原图在 `i.pximg.net`，必须带 `Referer: pixiv.net` |

### 禁漫天堂的通行证

18comic.vip 对所有路径返回 Cloudflare 管理型质询（HTTP 403，`Just a moment...`）。插件不会伪造质询，只做两件事：

- 识别质询页并返回 `E_CHALLENGE`，不把空结果当成“没有命中”；
- 把设置里的 Cookie 写进原生模块的 cookie 罐（按域保存），后续请求带上。

两条路：

1. **设置页按钮**（推荐）：`设置 → 过 Cloudflare 校验`。宿主会开一个隔离窗口打开 18comic 域名，你完成站点的人机校验后，窗口自动关闭，`cf_clearance` 等 Cookie 直接写进设置与原生模块的 cookie 罐。窗口使用的 User-Agent 与之后引擎请求用的完全一致（`cf_clearance` 同时绑定 UA 和出口 IP，两边不一致会被判为无效）。
2. **手动复制**：浏览器打开站点并过校验 → DevTools → Application → Cookies → `https://18comic.vip` → 复制 `cf_clearance` 的值（连同 `__cf_bm` 更好）→ 粘进 `设置 → 禁漫 Cookie`，形如 `cf_clearance=xxx; __cf_bm=yyy`。手动的代价是要自己保证浏览器 UA 与插件默认 UA（桌面 Chrome 131）一致、且与插件走同一出口 IP。

### Pixiv 的 R-18

R-18 不是地址问题，是账号设置问题：Pixiv 对**未登录或未开启 R-18 显示**的会话直接不返回这类作品（检索里看不到，详情返回 `{"error":true}`）。

两条路：

1. **设置 → 登录 Pixiv**（推荐）：宿主开隔离窗口，登录时**勾选「ログイン状態を保持」**（否则站点在登录前就发了会话 Cookie，窗口会立刻关掉），并在 pixiv 的账号设置里把「閲覧制限 R-18」打开；窗口关闭后 `PHPSESSID` 等 Cookie 自动写入设置与 cookie 罐，并立刻做一次 R-18 检索回报「已开启 / 未开启」。
2. **手动粘贴**：浏览器登录 pixiv → DevTools → Application → Cookies → `https://www.pixiv.net` → 复制 `PHPSESSID`，粘进「设置 → Pixiv Cookie」，保存时会同时写入 `pixiv.net` / `.pixiv.net` / `www.pixiv.net` 三个域。

图片仍在 `i.pximg.net`，只校验 `Referer: https://www.pixiv.net/`，插件自动带上。

Cookie 会过期（Cloudflare 通常几十分钟），过期后检索会重新报 `E_CHALLENGE`，再过一次校验即可。该站的解析按社区客户端的结构实现，**未在本机通过质询验证**，页面结构变化时会在结果里报 `E_PARSE`。

## 开发

```sh
node --test test/engine.test.mjs     # 16 项解析/计划/编码测试，用 test/fixtures 的真实回包
node tools/make-preview.mjs          # 由 ui/index.html 生成三个预览页
node tools/serve.mjs 5399            # http://127.0.0.1:5399/ui/preview-grid.html
node sdk/check.mjs .                 # 协议、权限、资源预检
node sdk/pack.mjs .                  # 出 .nous-plugin.json
python build.py windows              # 出 dist/DawnComicDownloader-windows-x64.module.zip（JDK 17+）
```

预览页用 `ui/demo-host.js` 顶替宿主桥和原生模块，数据来自 `test/fixtures` 和 `shots/covers`（真实回包与真实封面）。它不参与打包。

### 目录

```
ui/            页面：index.html / style.css / app.js（视图与队列）/ engine.js（适配器与解析）
engine/java/   原生模块源码：shared（JSON、HTTP、文件、cookie）+ windows（stdin/stdout 入口）
test/          引擎测试与真实回包夹具
tools/         预览页生成与静态服务
docs/          站点调研、运行时契约、设计记录
sdk/           公开 SDK 1.3.0（MIT，随插件分发以便自检与打包）
```

## 边界

- 只做检索与下载，不做站点的账号、付费或 DRM 绕过；需要登录才有内容的站点，登录由用户自己的浏览器完成。
- 下载文件的版权归原站点与作者，插件不改变这一点。
- 原生模块是可信本机代码，拥有 Nous 自身的设备权限；写入范围被限制在插件数据目录和你登记过的下载目录内。

## 许可

插件本体 MIT。`sdk/` 为 Nous 公开 SDK（MIT）。字体 Archivo 为 SIL Open Font License 1.1（`ui/fonts/OFL.txt`）。
