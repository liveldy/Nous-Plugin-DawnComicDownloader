# DawnComicDownloader · 破晓漫画下载器

Nous 插件。在同一个界面里检索六个图库站点，挑出作品，按编号归档下载。

- 六个来源：Xpicvid（niacg.com）、Ahri Gallery、禁漫天堂（18comic.vip）、Hentai League、Rule34（rule34.us）、Rule34Video。
- 文字检索走各站原生接口；图片检索把图片交给 SauceNAO（可选 key）或 IQDB 认出作品，再把标题、作者、作品名回灌成检索词。
- 结果带封面、标题、作者、标签、页数/时长；选中进下载队列，落到 `<下载目录>/<编号> <标题>/001.jpg`。
- 页面在宿主的 sandbox iframe 里运行，不出网；所有请求、封面取回和落盘都由随包的 Windows 原生模块完成。

## 安装

插件协议 1.3，需要 Nous 1.2.0 及以上，平台 `windows-x64`。

1. 安装随 Release 提供的 `DawnComicDownloader-windows-x64.module.zip` 所声明的页面包：`dist/app.nous.dawn-comic-downloader-1.0.0.nous-plugin.json`（插件管理 → 本地安装）。
2. 模块由 `manifest.json` 里的 URL 与 SHA-256 固定，宿主安装时校验。
3. 打开插件 → 设置 → 填下载目录 → 保存设置（这一步同时把目录登记为原生模块允许写入的根）。

本机出网若依赖系统代理，需要让宿主进程带上 `HTTPS_PROXY` / `HTTP_PROXY`（原生模块会读这两个变量，也支持 `-Dhttps.proxyHost`）。没有代理且直连被墙时，检索会返回 `E_TIMEOUT`。

## 使用

| 动作 | 结果 |
| --- | --- |
| 顶部输入关键词回车 | 六个开启的站点并行检索，右上角是总数与失败站点数 |
| 点底部的站点方块 | 关闭/开启该站点；关闭后不再参与检索 |
| 点“图片” | 选一张图 → 识别结果列表 → “用这个词”回灌检索 |
| 结果区顶部的 `全部 / 站点名 + 计数` | 只显示该站的结果（不重新请求），再点回到全部 |
| 点结果卡 | 进/出右侧下载队列，卡片右上角打勾 |
| “开始下载” | 逐项解析、建目录、按页序下载；编号从设置的起始值递增，完成后写库 |

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
| Ahri Gallery | — | ✓ | — | 站内无文字检索：拉最近 3 页后按标题本地筛选 |
| 禁漫天堂 | ✓ | ✓ | ✓ | Cloudflare 管理型质询，需在设置里填 `cf_clearance`（见下） |
| Hentai League | ✓ | ✓ | ✓ | WordPress `wp-json`，`contentUrl` 直接是 mp4 |
| Rule34 | ✓ | ✓ | ✓ | Gelbooru 0.1.11 改造站，`?r=posts/index&q=` 之后取 `posts/view` 原图 |
| Rule34Video | ✓ | ✓ | ✓ | KVS 内核，播放页 `flashvars` 取 720p/480p/360p 最高一档 |

### 禁漫天堂的通行证

18comic.vip 对所有路径返回 Cloudflare 管理型质询（HTTP 403，`Just a moment...`）。插件不会伪造质询，只做两件事：

- 识别质询页并返回 `E_CHALLENGE`，不把空结果当成“没有命中”；
- 把设置里的 Cookie 写进原生模块的 cookie 罐（按域保存），后续请求带上。

做法：浏览器登录 18comic.vip 并通过人机校验 → 复制该域的 `cf_clearance`（连同 `__cf_bm` 等）填进设置。该站的解析按社区客户端的结构实现，**未在本机通过质询验证**，页面结构变化时会在结果里报 `E_PARSE`。

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
