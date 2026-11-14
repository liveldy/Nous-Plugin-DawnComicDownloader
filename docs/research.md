# 六个站点的接口调研

调研时间：2026-11-14。方式：GitHub Search API（关键词见下）、各站首页与检索页的实际抓取（Chrome 131 UA，curl 保存原始回包）、以及开源客户端源码的公开结构。质量高的回包留在 `test/fixtures/`，解析测试直接跑它们。没有做批量抓取。

结论先说：六个站点里只有禁漫天堂有成规模的公开开源客户端；Rule34 与 Rule34Video 有小型项目；Xpicvid、Ahri Gallery、HentaiLeague **没有**可用项目，只能按站点自身结构写适配器。

## 1. 现成的开源项目

GitHub 搜索词：`xpicvid`、`niacg`、`ahri-gallery`、`18comic`、`jmcomic`、`hentaileague`、`rule34 api`、`rule34video`、`nhentai downloader`、`manga gallery downloader`。

| 站点 | 项目 | 许可 | 星 | 可用性 |
| --- | --- | --- | --- | --- |
| 禁漫天堂 | [hect0x7/JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python) | MIT | 8.0k | 事实标准：网页端 + 移动端 API 封装，含 Cloudflare 处理与 GitHub Actions 下载流程 |
| 禁漫天堂 | [tonquer/JMComic-qt](https://github.com/tonquer/JMComic-qt) | LGPL-3.0 | 4.2k | PyQt 桌面客户端，含登录、收藏、阅读器 |
| 禁漫天堂 | [lanyeeee/jmcomic-downloader](https://github.com/lanyeeee/jmcomic-downloader) | MIT | 1.8k | Rust + GUI，多线程下载，结构清晰 |
| 禁漫天堂 | [wgh136/PicaComic](https://github.com/wgh136/PicaComic) | MIT | 8.7k | Flutter 多源阅读器，含禁漫源实现 |
| Rule34 | [DaxEleven/Rule34.xxx-Downloader](https://github.com/DaxEleven/Rule34.xxx-Downloader) | MIT | 273 | 走官方 API 的 Windows 下载器（rule34.xxx，非 rule34.us） |
| Rule34 | [b3yc0d3/rule34Py](https://github.com/b3yc0d3/rule34Py) | GPL-3.0 | 53 | Python API 包装（同上，xxx 域） |
| Rule34Video | [Hanestl/HaRu](https://github.com/Hanestl/HaRu) | MIT | 125 | Android 客户端，Rule34Video / Hanime |
| Rule34Video | [vmoranv/astrbot_plugin_rule34video](https://github.com/vmoranv/astrbot_plugin_rule34video) | AGPL-3.0 | 1 | 聊天机器人插件，抓取逻辑可参考 |
| 通用 | [mikf/gallery-dl](https://github.com/mikf/gallery-dl) | GPL-2.0 | 大 | 支持 `gelbooru_v02`（rule34.xxx / safebooru / xbooru）、e-hentai、nhentai 等；**不支持**本清单的 18comic、rule34.us、rule34video、ahri-gallery、niacg、hentaileague |
| Xpicvid | — | — | — | 搜索无结果 |
| Ahri Gallery | [mrodii/ahri-gallery](https://github.com/mrodii/ahri-gallery) | 无 | 0 | 2019 年的同名前端练习，与本无关 |
| HentaiLeague | — | — | — | 搜索无结果 |

可以直接借鉴的是**协议与流程**，不是代码：禁漫的 `cf_clearance` 处理、Rule34 的 Gelbooru 分页语义、gallery-dl 的“先列页再逐页取图”调度。本插件没有内嵌上述项目代码，许可也因此干净。

## 2. 逐站的接口形状

每条的“验证”指：本机抓到了真实回包并写进 `test/fixtures/`，解析测试通过。

### Xpicvid · https://www.niacg.com/

帝国 CMS。**验证**。

| 用途 | 请求 |
| --- | --- |
| 检索 | `POST /e/search/index.php`，body `keyboard=<词>&show=title&tempid=1&tbname=news&Submit=1` → 302 → `/e/search/result/?searchid=<id>` |
| 列表 | `GET /listinfo-<classid>-<page>.html`（3 本子 / 9 A漫 / 1 COS / 2 CG / 4 套图 / 14 日漫 / 15 韩漫） |
| 标签 | `GET /tags-<tag>-<page>.html` |
| 详情 | `GET /moehome-<classid>-<id>.html`（`<h1 id="book-name">`、`itemprop="author"`、`span[data-type=works]`） |
| 阅读器 | `GET /moeupup-<classid>-<id>.html`，页面图 `<img class="comic_img" data-page="N" data-src="...index_hash.webp">` |

卡片结构：`div.thumb-overlay-albums > a[href=/moehome-...][title] > img[data-src]`。检索结果页与列表页共用这套卡片。

站点自带“以图搜图”入口，图片被传到 `https://www.suacg.com/` 再由站内搜索；具体检索端点没有公开文档，插件不猜，改走 SauceNAO/IQDB（见第 3 节）。

### Ahri Gallery · https://ahri-gallery.com/

OpenCart 改造站。**验证**。

| 用途 | 请求 |
| --- | --- |
| 列表 | `GET /index.php?route=comic/list&t=<ts>&category_id=<1..8>&page=<n>`（每页 108 个槽位，其中 100 个是真卡片） |
| 详情 | `GET /index.php?route=comic/article&comic_id=<id>&c_id=<hash>` |
| 阅读器 | 详情页里的 `?route=comic/reader&gk_id=<opaque>&c_id=<hash>` |
| 页面图 | 阅读器内联 `IMAGE_SERVER`（按 id 的 CDN 池）+ `IMAGE_FOLDER` + `Image_List[{sort,extension}]` → `https://<CDN>/image/<folder><sort>.<ext>` |

**没有**服务端文字检索：`keyword` / `search` / `q` / `tag` 参数都被忽略（用不存在的关键词测试，仍返回同样的 100 张卡片）。插件的做法是拉最近 3 页（约 300 条）再按标题分词本地筛选，速度换准确度，这一点在结果里以 `note` 标注。

### 禁漫天堂 · https://18comic.vip/

Cloudflare 管理型质询。**未验证解析**。

| 用途 | 请求 |
| --- | --- |
| 检索 | `GET /search/photos?search_query=<词>&page=<n>&main_tag=0` |
| 列表 | `GET /albums?page=<n>` |
| 详情 | `GET /album/<id>/<slug>/` → 章节 `href="/photo/<cid>"` |
| 页面图 | 章节页 `data-original` 指向 `/media/photos/...` |

首页、`/api/*`、`/search/photos` 在本机全部 403（`Just a moment...`），所以这套结构来自社区客户端的公开实现，插件里按“宽容选择器”解析并在结构不符时报 `E_PARSE`，不自造 JSON API。

通行证由用户浏览器取得后填进设置（`cf_clearance` 等），插件按域写进 cookie 罐；UA 必须与取得该 Cookie 的浏览器一致，否则 Cloudflare 不认。插件默认发送桌面 Chrome UA，与设置里提示的浏览器保持一致即可。

### Hentai League · https://hentaileague.com/

WordPress + VideoPack(kgvid)。**验证**。

| 用途 | 请求 |
| --- | --- |
| 检索 | `GET /wp-json/wp/v2/posts?search=<词>&per_page=24&page=<n>&_embed=1` |
| 列表 | 同上，`orderby=date` |
| 视频 | `content.rendered` 内 `<meta itemprop="contentUrl" content="...mp4">` |
| 封面 | `<meta itemprop="thumbnailUrl">` 或 `_embedded["wp:featuredmedia"][0].source_url` |
| 标签 | `_embedded["wp:term"]` 中 `taxonomy === "post_tag"` 的 `name` |
| 作者 | `_embedded.author[0].name` |

`page` 超出范围时 WP 返回 400，适配器把它当成“没有更多”。

### Rule34 · https://rule34.us/

Gelbooru Beta 0.1.11（改造版）。**验证**。

| 用途 | 请求 |
| --- | --- |
| 检索 | `GET /index.php?r=posts/index&q=<tag1+tag2>&pid=<n>`（pid 从 0 起） |
| 帖子 | `GET /index.php?r=posts/view&id=<id>` |
| 原图 | 帖子页里 `img2.rule34.us/images/...png|jpg|gif|webp`；视频帖为 `.mp4|.webm` |

卡片结构：`a#<postid>[href=?r=posts/view&id=] > img[src=thumbnails][title="tag, tag, ..."]`——标签就在 `title` 属性里，一次请求就能拿到元信息。

`?json=1` 与 `page=dapi&s=post&q=index` 在这个实例上都返回首页，**没有**可用的 JSON API。

### Rule34Video · https://rule34video.com/

KVS（Kernel Video Sharing）。**验证**。

| 用途 | 请求 |
| --- | --- |
| 检索 | `GET /search/?q=<词>&from=<(page-1)*24+1>` |
| 最新 | `GET /latest-updates/<page>/` |
| 播放页 | `GET /video/<id>/<slug>/` |
| 视频源 | 播放页 `flashvars`：`video_url`(360p) / `video_alt_url`(480p) / `video_alt_url2`(720p)，带 `v-acctoken` |

卡片结构：`div.item.thumb[data-video-card-id] > a.th[href=/video/...][title] > img.thumb` + `div.time` 时长。列表每页 24 条。

## 3. 图片检索怎么做

六个站点里只有 Xpicvid 有站内以图搜图，且走私有上传端点，不可复现。所以“图片搜索”实现为**先识别、再回灌**：

1. 图片 → SauceNAO（`output_type=2`，设置里填免费 API key 时启用）或 IQDB（无需 key，作为兜底）。
2. 归一化为 `{相似度, 标题, 作者, 作品/系列, 来源链接}`，过滤相似度 < 50。
3. `queriesFromMatch()` 生成有序检索词：`标题` → `作者 标题` → `作品名`。
4. 在六个开启的站点上跑这些词，结果列表与文字检索完全一致。

插件自己拼 multipart 请求体（页面拿到 base64 图片，拼好边界后整段 `bodyBase64` 交给原生模块发送），所以原生模块不需要额外的上传方法。

## 4. 已知风险

| 风险 | 表现 | 处理 |
| --- | --- | --- |
| 站点改版 | 解析器返回 0 条或 `E_PARSE` | 选择器按“块级标记 + 字段就近”写，不依赖整页 DOM 顺序；夹具测试锁住现有结构 |
| Cloudflare | 18comic 全程 403 | 只报告质询、不绕过；由用户提供 Cookie |
| 地区/代理 | 直连超时 | 原生模块读 `HTTPS_PROXY`/`HTTP_PROXY`；无代理时报 `E_TIMEOUT` |
| 站点本身是视频站 | HentaiLeague / Rule34Video 下的是视频不是图集 | 统一成 `pages[]`，视频就是 1 项，文件名为 `001.mp4` |
| 内容分级 | 六个站点全部为成人内容 | 插件不改变站点内容与访问条件；下载属地版权归原站与作者 |

## 5. 禁漫天堂：JMComic 移植说明

`ui/engine.js` 的 `jm` 适配器按 [hect0x7/JMComic-Crawler-Python](https://github.com/hect0x7/JMComic-Crawler-Python)（MIT）的 **HTML 客户端**重写。取过来的部分：

| 机制 | 原实现 | 本插件 |
| --- | --- | --- |
| 检索 | `JmHtmlClient.search` → `/search/photos`，参数 `main_tag/search_query/page/o/t` | 同参数集，`o=mr&t=a`；纯数字查询直接开 `/album/{id}/` |
| 分类 | `API_CATEGORY = '/albums'` | 浏览模式 `/albums?page=` |
| 详情 | `fetch_detail_entity` → `/album/{id}/`，字段 `id="book-name"`、`itemprop="author" data-type="author|works"`、`itemprop="genre" data-type="tags"`、`pagecount`、`var scramble_id` | 同字段，`jm.albumMeta()` |
| 章节 | 详情页里的 `/photo/{id}` 链接 | 逐个取（上限 20 章），按章序拼接页列表 |
| 页图 | `/photo/{id}` 的 `data-original`（`/media/photos/…`） | 同上，过滤 `blank.gif` |
| 包裹页 | `parse_jm_base64_html`：`const html = base64DecodeUtf8("…")` | `jm.unwrap()` |
| 乱序参数 | `fetch_scramble_id` → `/chapter_view_template?id=&mode=vertical&page=0&app_img_shunt=1&express=off&v=` → `var scramble_id` | 先读章节页的 `var scramble_id`，取不到再回落到本子详情页 |
| 分段数 | `JmImageTool.get_num(scramble_id, aid, filename)` | `jmScrambleNum()`：`aid<scramble_id→0`；`aid<268850→10`；否则 `md5(str(aid)+filename)` 末位取模（`aid<421926` 用 10，否则 8）`×2+2` |
| 还原 | `decode_and_save`：按 num 等分高度，第 i 段从 `h-(move*(i+1))-over` 搬到 `move*i`（首段加 `over`） | `jmScramblePlan()` 输出 `{src,dst,h}` 三元组，页面用 canvas 重排后写 PNG |
| 域名 | `DOMAIN_HTML_LIST` 轮询 | 设置页可改域名，默认 `18comic.vip`，内置 `18comic.org / 18comic.cc / jm-comic2.cc` 备选 |

**没有移植**：`JmApiClient`（App 接口）。它需要 `APP_TOKEN_SECRET` / `APP_DATA_SECRET` 两个硬编码密钥、`token/tokenparam` 头、`APP_VERSION` 跟随，以及 AES-ECB 解密响应（`JmCryptoTool.decode_resp_data`）。这和 HTML 客户端拿到的内容相同，却把插件绑在会变的应用版本和密钥上；沙箱页面也没有同步 AES-ECB。需要时再按 `client: api` 另开分支。

**验证状态**：本机对 18comic 全站只能拿到 Cloudflare 质询页（HTTP 403），上述解析与还原逻辑因此只做到“结构与算法对齐 + 单测锁住”，没有真实页面回放。已在单测里锁住：md5 向量、5 组 `get_num` 参考值（与 Python 计算一致）、分段计划不重叠且覆盖整幅、base64 包裹页展开、页图顺序与 `blank.gif` 过滤。首次在能过质询的环境里跑通后，应把真实回包加入 `test/fixtures/`。