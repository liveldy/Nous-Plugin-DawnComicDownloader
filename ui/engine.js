/* DawnComicDownloader search engine — pure adapters, no DOM, no network of its own.
 * Every request goes through ctx (the host bridge). Parsers are pure string
 * functions so they can be unit-tested against saved pages in test/fixtures.
 * MIT. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DawnEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ text */

  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

  function decodeEntities(s) {
    if (!s) return '';
    return String(s)
      .replace(/&#x([0-9a-f]+);/gi, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&([a-z]+|#\d+);/gi, function (m, n) { return ENT[n.toLowerCase()] || m; });
  }

  function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  function collapse(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function uniq(list) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || seen[v]) continue;
      seen[v] = 1;
      out.push(v);
    }
    return out;
  }

  function trimTo(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function absolute(base, href) {
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    if (href.indexOf('//') === 0) return 'https:' + href;
    try { return new URL(href, base).href; } catch (e) { return ''; }
  }

  function host(url) {
    try { return new URL(url).host; } catch (e) { return ''; }
  }

  function qs(obj) {
    return Object.keys(obj)
      .filter(function (k) { return obj[k] !== undefined && obj[k] !== null && obj[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(String(obj[k])); })
      .join('&');
  }

  function form(obj) { return qs(obj); }

  function indexOfBlock(html, needle, from) {
    var i = html.indexOf(needle, from || 0);
    return i;
  }

  /* --------------------------------------------------------------- naming */

  var ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

  function safeName(s, max) {
    var v = String(s || 'untitled')
      .replace(ILLEGAL, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[. ]+|[. ]+$/g, '')
      .trim();
    if (!v) v = 'untitled';
    var cap = max || 72;
    if (v.length > cap) v = v.slice(0, cap).replace(/[. ]+$/, '');
    return v;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < (width || 3)) s = '0' + s;
    return s;
  }

  function extensionOf(url, fallback) {
    var m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(String(url || ''));
    if (!m) return fallback || 'jpg';
    var ext = m[1].toLowerCase();
    if (ext === 'jpeg') return 'jpg';
    if (/^(jpg|png|gif|webp|avif|bmp|mp4|webm|mkv|m4v|mov)$/.test(ext)) return ext;
    return fallback || 'jpg';
  }

  function shortAuthor(s) {
    var v = collapse(s);
    v = v.replace(/^\[[^\]]*\]\s*/, '');
    return trimTo(v, 60);
  }

  /* ------------------------------------------------------------- registry */

  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  function baseHeaders(referer) {
    var h = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7'
    };
    if (referer) h.Referer = referer;
    return h;
  }

  /* --------------------------------------------------------- Xpicvid/niacg */

  var niacg = {
    id: 'niacg',
    label: 'Xpicvid',
    host: 'www.niacg.com',
    base: 'https://www.niacg.com',
    kind: 'gallery',
    caps: { text: true, browse: true, tag: true, image: false },
    challenge: false,
    note: '帝国 CMS：搜索走 /e/search/index.php，阅读器 /moeupup-*.html 顺序出图。',

    parseCards: function (html) {
      var out = [];
      var re = /<div class="thumb-overlay-albums">([\s\S]*?)<\/div>\s*<\/a>|<div class="thumb-overlay-albums">([\s\S]{0,1200}?)<\/div>\s*<\/div>/g;
      var blocks = html.split('class="thumb-overlay-albums"').slice(1);
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i].slice(0, 1400);
        var link = /href="([^"]*?-(?:[a-z]+)-(\d+)\.html|[^"]+\.html)"/.exec(b);
        var href = link ? link[1] : '';
        var idm = /-(\d+)\.html/.exec(href);
        var title = /title="([^"]*)"/.exec(b);
        var img = /data-src="([^"]+)"|src="([^"]+)"/.exec(b);
        var cover = img ? (img[1] || img[2]) : '';
        if (!idm || !href || /\/tags-/.test(href)) continue;
        if (/blank\.jpg|imgloading|\.gif$/.test(cover)) {
          var later = /data-src="([^"]+)"/.exec(b);
          cover = later ? later[1] : cover;
        }
        out.push({
          id: idm[1],
          url: absolute(niacg.base, href.replace(/&amp;/g, '&')),
          title: collapse(decodeEntities(title ? title[1] : '')),
          cover: absolute(niacg.base, cover),
          author: '',
          tags: []
        });
      }
      return dedupe(out);
    },

    search: function (ctx, query, page) {
      if (!query) return this.browse(ctx, page);
      var body = form({ keyboard: query, show: 'title', tempid: '1', tbname: 'news', Submit: '搜索' });
      return ctx.post(niacg.base + '/e/search/index.php', body, {
        headers: baseHeaders(niacg.base + '/'),
        contentType: 'application/x-www-form-urlencoded'
      }).then(function (res) {
        var html = res.body || '';
        var items = niacg.parseCards(html);
        return { items: items, hasMore: false, raw: 'search' };
      });
    },

    browse: function (ctx, page) {
      var p = Math.max(0, (page || 1) - 1);
      var url = niacg.base + '/listinfo-3-' + p + '.html';
      return ctx.get(url, { headers: baseHeaders(niacg.base + '/') }).then(function (res) {
        return { items: niacg.parseCards(res.body || ''), hasMore: true };
      });
    },

    meta: function (html) {
      var author = /data-type="author">\s*<a[^>]*>([^<]+)<\/a>/.exec(html);
      var works = /data-type="works">\s*<a[^>]*>([^<]+)<\/a>/.exec(html);
      var tags = [];
      var tre = /class="btn btn-sm btn-primary">([^<]{1,40})<\/a>/g, m;
      while ((m = tre.exec(html))) tags.push(collapse(decodeEntities(m[1])));
      var title = /<h1[^>]*id="book-name"[^>]*>([\s\S]*?)<\/h1>/.exec(html);
      var cover = /id="album_photo_cover"[\s\S]{0,600}?data-src="([^"]+)"/.exec(html);
      return {
        title: title ? collapse(stripTags(title[1])) : '',
        author: author ? collapse(decodeEntities(author[1])) : '',
        works: works ? collapse(decodeEntities(works[1])) : '',
        tags: uniq(tags).slice(0, 12),
        cover: cover ? absolute(niacg.base, cover[1]) : ''
      };
    },

    detail: function (ctx, item) {
      return ctx.get(item.url, { headers: baseHeaders(niacg.base + '/') }).then(function (res) {
        var html = res.body || '';
        var meta = niacg.meta(html);
        var readerHref = /href="([^"]*moeupup-[^"]+\.html)"/.exec(html);
        if (!readerHref) throw new Error('E_PARSE: 未找到阅读器入口');
        var reader = absolute(niacg.base, readerHref[1].replace(/&amp;/g, '&'));
        return ctx.get(reader, { headers: baseHeaders(item.url) }).then(function (r2) {
          var pages = niacg.pages(r2.body || '');
          if (!pages.length) throw new Error('E_PARSE: 阅读器没有图片');
          return { meta: meta, pages: pages, reader: reader };
        });
      });
    },

    /* Reader pages carry class="comic_img" and data-page="N"; recommendation
     * tiles in the same document do not. Fall back to the file-name index. */
    pages: function (html) {
      var keyed = [];
      var tagRe = /<img[^>]*class="[^"]*comic_img[^"]*"[^>]*>/g, tag;
      while ((tag = tagRe.exec(html))) {
        var src = /data-src="([^"]+)"/.exec(tag[0]) || /data-original="([^"]+)"/.exec(tag[0]) || /src="([^"]+)"/.exec(tag[0]);
        var idx = /data-page="(\d+)"/.exec(tag[0]);
        if (!src) continue;
        var tail = /\/(\d+)_[0-9a-f]+\.(?:webp|jpg|jpeg|png)$/i.exec(src[1]);
        var n = idx ? parseInt(idx[1], 10) : tail ? parseInt(tail[1], 10) : keyed.length;
        keyed.push({ url: src[1], i: n });
      }
      if (!keyed.length) {
        var re = /<img[^>]*id="page_\d+"[^>]*>/g, m;
        while ((m = re.exec(html))) {
          var s2 = /data-src="([^"]+)"/.exec(m[0]);
          if (s2) keyed.push({ url: s2[1], i: keyed.length });
        }
      }
      keyed.sort(function (a, b) { return a.i - b.i; });
      return keyed.map(function (k) { return { url: k.url }; });
    }
  };

  /* ---------------------------------------------------------- ahri-gallery */

  var ahri = {
    id: 'ahri',
    label: 'Ahri Gallery',
    host: 'ahri-gallery.com',
    base: 'https://ahri-gallery.com',
    kind: 'gallery',
    caps: { text: false, browse: true, tag: false, image: false },
    challenge: false,
    note: 'OpenCart 改造站：列表 ?route=comic/list，阅读器给出 IMAGE_SERVER/IMAGE_FOLDER/Image_List。站内无文字检索，按标题本地筛选。',

    parseCards: function (html) {
      var out = [];
      var blocks = html.split('class="image gallery-group').slice(1);
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i].slice(0, 3000);
        var href = /href="(index\.php\?route=comic\/article[^"]+)"/.exec(b);
        if (!href) continue;
        var idm = /comic_id=(\d+)/.exec(href[1]);
        if (!idm) continue;
        var title = /data-toggle="tooltip" title="([^"]*)"/.exec(b);
        var span = /<span class="d">([\s\S]*?)<\/span>/.exec(b);
        var img = /<img[^>]+src="([^"]+)"/.exec(b);
        out.push({
          id: idm[1],
          url: absolute(ahri.base + '/', decodeEntities(href[1]).replace(/&amp;/g, '&')),
          title: collapse(decodeEntities(title ? title[1] : span ? stripTags(span[1]) : '')),
          cover: img ? absolute(ahri.base, img[1]) : '',
          author: '',
          tags: []
        });
      }
      return dedupe(out);
    },

    search: function (ctx, query, page) {
      var tokens = tokenize(query);
      var pages = tokens.length ? Math.max(3, page || 1) : (page || 1);
      return this.browse(ctx, page).then(function (first) {
        if (!tokens.length) return first;
        var items = first.items;
        var chain = Promise.resolve();
        for (var p = 2; p <= pages; p++) {
          (function (pn) {
            chain = chain.then(function () {
              return ahri.browse(ctx, pn).then(function (r) { items = items.concat(r.items); });
            });
          })(p);
        }
        return chain.then(function () {
          var hit = items.filter(function (it) {
            var hay = (it.title + ' ' + it.author).toLowerCase();
            return tokens.every(function (t) { return hay.indexOf(t) >= 0; });
          });
          return { items: hit, hasMore: items.length > 0, note: '本地标题筛选' };
        });
      });
    },

    browse: function (ctx, page) {
      var p = Math.max(1, page || 1);
      var url = ahri.base + '/index.php?route=comic/list' + (p > 1 ? '&page=' + p : '');
      return ctx.get(url, { headers: baseHeaders(ahri.base + '/') }).then(function (res) {
        return { items: ahri.parseCards(res.body || ''), hasMore: true };
      });
    },

    detail: function (ctx, item) {
      return ctx.get(item.url, { headers: baseHeaders(ahri.base + '/') }).then(function (res) {
        var html = res.body || '';
        var gk = /route=comic\/reader&amp;gk_id=([^&"]+)/.exec(html) || /route=comic\/reader&gk_id=([^&"]+)/.exec(html);
        if (!gk) throw new Error('E_PARSE: 未找到阅读器凭据');
        var cid = /c_id=([0-9a-f]{16,})/.exec(html);
        var url = ahri.base + '/index.php?route=comic/reader&gk_id=' + encodeURIComponent(decodeEntities(gk[1])) +
          (cid ? '&c_id=' + cid[1] : '');
        var title = /<h4[^>]*>([\s\S]{0,200}?)<\/h4>/.exec(html) || /title="([^"]{2,120})"/.exec(html);
        var tags = [];
        var tm = /"name_ch2":"([^"]{1,40})"/g, m;
        while ((m = tm.exec(html))) tags.push(decodeEntities(m[1]).replace(/\\u([0-9a-f]{4})/gi, function (_, h) { return String.fromCharCode(parseInt(h, 16)); }));
        return ctx.get(url, { headers: baseHeaders(item.url) }).then(function (r2) {
          var pages = ahri.pages(r2.body || '');
          if (!pages.length) throw new Error('E_PARSE: 阅读器结构变化');
          return {
            meta: { title: title ? collapse(stripTags(title[1])) : item.title, tags: uniq(tags).slice(0, 12) },
            pages: pages
          };
        });
      });
    },

    pages: function (html) {
      var folder = /var\s+IMAGE_FOLDER\s*=\s*"([^"]+)"/.exec(html);
      var list = /Image_List\s*=\s*(\[[\s\S]*?\]);/.exec(html);
      var serverId = /var\s+image_server_id\s*=\s*(\d+)/.exec(html);
      var serverJson = /var\s+IMAGE_SERVER\s*=\s*(\{[\s\S]*?\});/.exec(html);
      if (!folder || !list || !serverJson) return [];
      var hosts;
      try { hosts = JSON.parse(serverJson[1].replace(/\\\//g, '/')); } catch (e) { return []; }
      var pool = hosts[serverId ? serverId[1] : Object.keys(hosts)[0]];
      if (!pool || !pool.length) return [];
      var base = pool[0];
      var entries;
      try { entries = JSON.parse(list[1]); } catch (e) { return []; }
      entries.sort(function (a, b) { return parseInt(a.sort, 10) - parseInt(b.sort, 10); });
      return entries.map(function (e) {
        return { url: absolute('https:' + base, base + folder[1] + e.sort + '.' + e.extension) };
      });
    }
  };

  /* -------------------------------------------------------------- 18comic */

  var jm = {
    id: 'jm',
    label: '禁漫天堂',
    host: '18comic.vip',
    base: 'https://18comic.vip',
    kind: 'gallery',
    caps: { text: true, browse: true, tag: true, image: false },
    challenge: true,
    note: 'Cloudflare 管理型质询：需在宿主登录窗口过一次人机校验取得 cf_clearance，之后由 cookie 罐随请求发送。结构按社区客户端实现，未在本机通过质询验证。',

    challengeCheck: function (html) {
      return /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies/i.test(html || '');
    },

    parseCards: function (html) {
      var out = [];
      var re = /<a[^>]+href="(\/album\/(\d+)\/[^"]*)"[^>]*>([\s\S]{0,700}?)<\/a>/g, m;
      while ((m = re.exec(html))) {
        var body = m[3];
        var img = /(?:data-original|data-src|src)="([^"]+)"/.exec(body);
        var title = /<div class="[^"]*(?:album-title|title)[^"]*"[^>]*>([\s\S]{0,160}?)<\/div>/.exec(m[0]) ||
          /<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]{0,160}?)<\/span>/.exec(m[0]) ||
          /title="([^"]{2,160})"/.exec(m[0]);
        out.push({
          id: m[2],
          url: absolute(jm.base, m[1]),
          title: title ? collapse(stripTags(title[1])) : '#' + m[2],
          cover: img ? absolute(jm.base, img[1]) : '',
          author: '',
          tags: []
        });
      }
      return dedupe(out);
    },

    search: function (ctx, query, page) {
      var p = Math.max(1, page || 1);
      var url = jm.base + '/search/photos?' + qs({ search_query: query, page: p, main_tag: 0 });
      return ctx.get(url, { headers: baseHeaders(jm.base + '/') }).then(function (res) {
        if (jm.challengeCheck(res.body)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
        return { items: jm.parseCards(res.body || ''), hasMore: true };
      });
    },

    browse: function (ctx, page) {
      var p = Math.max(1, page || 1);
      return ctx.get(jm.base + '/albums?page=' + p, { headers: baseHeaders(jm.base + '/') }).then(function (res) {
        if (jm.challengeCheck(res.body)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
        return { items: jm.parseCards(res.body || ''), hasMore: true };
      });
    },

    detail: function (ctx, item) {
      return ctx.get(item.url, { headers: baseHeaders(jm.base + '/') }).then(function (res) {
        var html = res.body || '';
        if (jm.challengeCheck(html)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
        var chapter = /href="(\/photo\/\d+[^"]*)"/.exec(html) || /href="(\/chapter\/[^"]*)"/.exec(html);
        var albumTitle = /<h1[^>]*>([\s\S]{0,200}?)<\/h1>/.exec(html);
        if (!chapter) throw new Error('E_PARSE: 未找到章节入口');
        var target = absolute(jm.base, chapter[1]);
        return ctx.get(target, { headers: baseHeaders(item.url) }).then(function (r2) {
          var pages = jm.pages(r2.body || '');
          if (!pages.length) throw new Error('E_PARSE: 章节内没有图片');
          return { meta: { title: albumTitle ? collapse(stripTags(albumTitle[1])) : item.title, tags: [] }, pages: pages };
        });
      });
    },

    pages: function (html) {
      var urls = [];
      var re = /(?:data-original|data-src|src)="([^"]+\/media\/photos\/[^"]+)"/g, m;
      while ((m = re.exec(html))) urls.push(absolute(jm.base, m[1]));
      return uniq(urls).map(function (u) { return { url: u }; });
    }
  };

  /* ----------------------------------------------------------- HentaiLeague */

  var hentaileague = {
    id: 'hentaileague',
    label: 'Hentai League',
    host: 'hentaileague.com',
    base: 'https://hentaileague.com',
    kind: 'video',
    caps: { text: true, browse: true, tag: true, image: false },
    challenge: false,
    note: 'WordPress + VideoPack：wp-json 直接给出标题、标签与 contentUrl。',

    parsePosts: function (posts) {
      var out = [];
      for (var i = 0; i < posts.length; i++) {
        var p = posts[i];
        var html = (p.content && p.content.rendered) || '';
        var file = /itemprop="contentUrl"\s+content="([^"]+)"/.exec(html) || /<source[^>]+src="([^"]+)"/.exec(html);
        var thumb = /itemprop="thumbnailUrl"\s+content="([^"]+)"/.exec(html);
        var embedded = p._embedded || {};
        var media = embedded['wp:featuredmedia'] && embedded['wp:featuredmedia'][0];
        var tags = [];
        var terms = embedded['wp:term'] || [];
        for (var t = 0; t < terms.length; t++) {
          var group = terms[t] || [];
          for (var g = 0; g < group.length; g++) {
            if (group[g].taxonomy === 'post_tag') tags.push(collapse(group[g].name));
          }
        }
        var author = embedded.author && embedded.author[0] ? embedded.author[0].name : '';
        out.push({
          id: String(p.id),
          url: p.link,
          title: collapse(stripTags(p.title && p.title.rendered)),
          cover: (thumb ? thumb[1] : media ? media.source_url : ''),
          author: author,
          tags: tags,
          pages: file ? [{ url: file[1] }] : [],
          extra: { duration: /<span[^>]*class="[^"]*duration[^"]*"[^>]*>([^<]+)</.exec(html) ? /<span[^>]*class="[^"]*duration[^"]*"[^>]*>([^<]+)</.exec(html)[1] : '' }
        });
      }
      return out;
    },

    search: function (ctx, query, page) {
      var p = Math.max(1, page || 1);
      var url = hentaileague.base + '/wp-json/wp/v2/posts?' + qs({ search: query, per_page: 24, page: p, _embed: 1 });
      return ctx.get(url, { headers: baseHeaders(hentaileague.base + '/') }).then(function (res) {
        if (res.status === 400) return { items: [], hasMore: false };
        var posts;
        try { posts = JSON.parse(res.body); } catch (e) { throw new Error('E_PARSE: wp-json 返回非 JSON'); }
        return { items: hentaileague.parsePosts(posts), hasMore: posts.length >= 24 };
      });
    },

    browse: function (ctx, page) {
      var p = Math.max(1, page || 1);
      var url = hentaileague.base + '/wp-json/wp/v2/posts?' + qs({ per_page: 24, page: p, _embed: 1, orderby: 'date' });
      return ctx.get(url, { headers: baseHeaders(hentaileague.base + '/') }).then(function (res) {
        var posts = JSON.parse(res.body);
        return { items: hentaileague.parsePosts(posts), hasMore: true };
      });
    },

    detail: function (ctx, item) {
      return Promise.resolve({ meta: { title: item.title, tags: item.tags }, pages: item.pages });
    }
  };

  /* -------------------------------------------------------------- Rule34.us */

  var rule34us = {
    id: 'rule34us',
    label: 'Rule34',
    host: 'rule34.us',
    base: 'https://rule34.us',
    kind: 'gallery',
    caps: { text: true, browse: true, tag: true, image: false },
    challenge: false,
    note: 'Gelbooru Beta 0.1.11 改造版：tag 检索走 ?r=posts/index&q=，点击后取原图。',

    parseCards: function (html) {
      var out = [];
      var re = /<a\s+id="(\d+)"\s+href="([^"]*posts\/view[^"]*)"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*title="([^"]*)"/g, m;
      while ((m = re.exec(html))) {
        out.push({
          id: m[1],
          url: absolute(rule34us.base, decodeEntities(m[2]).replace(/&amp;/g, '&')),
          cover: absolute(rule34us.base, m[3]),
          title: '',
          author: '',
          tags: m[4] ? m[4].split(',').map(collapse).filter(Boolean).slice(0, 14) : []
        });
      }
      if (!out.length) {
        var re2 = /href="([^"]*posts\/view&amp;id=(\d+)[^"]*)"[\s\S]{0,400}?src="([^"]+)"/g;
        while ((m = re2.exec(html))) {
          out.push({ id: m[2], url: absolute(rule34us.base, decodeEntities(m[1]).replace(/&amp;/g, '&')), cover: m[3], title: '', tags: [] });
        }
      }
      return dedupe(out);
    },

    search: function (ctx, query, page) {
      var p = Math.max(0, (page || 1) - 1);
      var url = rule34us.base + '/index.php?' + qs({ r: 'posts/index', q: query, pid: p });
      return ctx.get(url.replace(/%26/g, '&'), { headers: baseHeaders(rule34us.base + '/') }).then(function (res) {
        return { items: rule34us.parseCards(res.body || ''), hasMore: true };
      });
    },

    browse: function (ctx, page) {
      return this.search(ctx, '', page);
    },

    detail: function (ctx, item) {
      return ctx.get(item.url, { headers: baseHeaders(rule34us.base + '/') }).then(function (res) {
        var html = res.body || '';
        var full = /https?:\/\/img\d*\.rule34\.us\/images\/[^"'\s]+\.(?:jpe?g|png|gif|webp)/i.exec(html);
        var video = /https?:\/\/[^"'\s]+\.(?:mp4|webm)/i.exec(html);
        var title = /<title>([\s\S]*?)<\/title>/.exec(html);
        var pages = [];
        if (full) pages.push({ url: full[0] });
        if (video) pages = [{ url: video[0] }];
        if (!pages.length) throw new Error('E_PARSE: 未找到原图地址');
        return {
          meta: {
            title: title ? collapse(stripTags(title[1])).replace(/\s*-\s*Rule 34.*$/i, '') : item.title,
            tags: item.tags
          },
          pages: pages
        };
      });
    }
  };

  /* ------------------------------------------------------------ Rule34Video */

  var r34video = {
    id: 'r34video',
    label: 'Rule34Video',
    host: 'rule34video.com',
    base: 'https://rule34video.com',
    kind: 'video',
    caps: { text: true, browse: true, tag: true, image: false },
    challenge: false,
    note: 'KVS 内核：列表 24 条/页，播放页 flashvars 给出 360/480/720 源。',

    parseCards: function (html) {
      var out = [];
      var blocks = html.split('class="item thumb').slice(1);
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i].slice(0, 2200);
        var link = /<a[^>]+href="(https:\/\/rule34video\.com\/video\/(\d+)\/[^"]*)"[^>]*title="([^"]*)"/.exec(b);
        if (!link) continue;
        var img = /<img[^>]+src="([^"]+)"/.exec(b);
        var time = /class="time"[^>]*>([^<]+)</.exec(b);
        out.push({
          id: link[2],
          url: link[1],
          title: collapse(decodeEntities(link[3])),
          cover: img ? img[1] : '',
          author: '',
          tags: [],
          extra: { duration: time ? collapse(time[1]) : '' }
        });
      }
      return dedupe(out);
    },

    search: function (ctx, query, page) {
      var p = Math.max(1, page || 1);
      var url = r34video.base + '/search/?' + qs({ q: query, from: (p - 1) * 24 + 1 });
      return ctx.get(url, { headers: baseHeaders(r34video.base + '/') }).then(function (res) {
        var items = r34video.parseCards(res.body || '');
        return { items: items, hasMore: items.length > 0 };
      });
    },

    browse: function (ctx, page) {
      var p = Math.max(1, page || 1);
      var url = r34video.base + '/latest-updates/' + (p > 1 ? p + '/' : '');
      return ctx.get(url, { headers: baseHeaders(r34video.base + '/') }).then(function (res) {
        return { items: r34video.parseCards(res.body || ''), hasMore: true };
      });
    },

    detail: function (ctx, item) {
      return ctx.get(item.url, { headers: baseHeaders(r34video.base + '/') }).then(function (res) {
        var html = res.body || '';
        var variants = [];
        var re = /(video_url|video_alt_url2?):\s*'([^']+)'/g, m;
        while ((m = re.exec(html))) variants.push({ key: m[1], url: m[2].replace(/\\\//g, '/') });
        var direct = /https:\/\/rule34video\.com\/get_file\/[^"'\s]+?\/\d+\.mp4\/[^"'\s]*/.exec(html);
        var best = '';
        var order = { video_alt_url2: 3, video_alt_url: 2, video_url: 1 };
        variants.sort(function (a, b) { return (order[b.key] || 0) - (order[a.key] || 0); });
        if (variants.length) best = variants[0].url;
        else if (direct) best = direct[0];
        if (!best) throw new Error('E_PARSE: 未找到视频源');
        var title = /<title>([\s\S]*?)<\/title>/.exec(html);
        var tags = [];
        var tre = /href="https:\/\/rule34video\.com\/tags\/[^"]+"[^>]*>([^<]{1,40})<\/a>/g, tm;
        while ((tm = tre.exec(html))) tags.push(collapse(decodeEntities(tm[1])));
        return {
          meta: {
            title: title ? collapse(stripTags(title[1])).replace(/\s*\|\s*Rule 34 Video.*$/i, '') : item.title,
            tags: uniq(tags).slice(0, 14)
          },
          pages: [{ url: best }]
        };
      });
    }
  };

  /* ------------------------------------------------------------- utilities */

  function dedupe(items) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.id || seen[it.id + it.url]) continue;
      seen[it.id + it.url] = 1;
      out.push(it);
    }
    return out;
  }

  function tokenize(q) {
    return String(q || '').toLowerCase().split(/[\s,，、]+/).filter(function (t) { return t.length > 1; });
  }

  var SOURCES = [niacg, ahri, jm, hentaileague, rule34us, r34video];

  function getSource(id) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i];
    return null;
  }

  function sourceInfo() {
    return SOURCES.map(function (s) {
      return { id: s.id, label: s.label, host: s.host, kind: s.kind, caps: s.caps, challenge: s.challenge, note: s.note };
    });
  }

  /* Normalised card used by the UI. `source` is added by the fan-out. */
  function normalize(spec, item) {
    var title = collapse(item.title);
    if (!title && item.tags && item.tags.length) title = item.tags.slice(0, 4).join(' · ');
    if (!title) title = 'post ' + item.id;
    var kind = spec.kind;
    return {
      uid: spec.id + ':' + item.id,
      source: spec.id,
      sourceLabel: spec.label,
      id: String(item.id),
      title: title,
      author: shortAuthor(item.author || ''),
      tags: (item.tags || []).slice(0, 8),
      cover: item.cover || '',
      kind: kind,
      pages: item.pages && item.pages.length ? item.pages.length : (item.extra && item.extra.count) || 0,
      duration: (item.extra && item.extra.duration) || '',
      url: item.url,
      raw: item
    };
  }

  /* Fan out one query over the selected sources, isolating failures. */
  function searchAll(ctx, opts) {
    var ids = opts.sources && opts.sources.length ? opts.sources : SOURCES.map(function (s) { return s.id; });
    var query = collapse(opts.query);
    var page = opts.page || 1;
    var jobs = ids.map(function (id) {
      var spec = getSource(id);
      if (!spec) return Promise.resolve({ id: id, items: [], error: 'E_SOURCE: 未知来源' });
      var call = query ? spec.search(ctx, query, page) : (spec.browse ? spec.browse(ctx, page) : spec.search(ctx, query, page));
      return Promise.resolve()
        .then(function () { return call; })
        .then(function (res) {
          var items = (res.items || []).map(function (it) { return normalize(spec, it); });
          return { id: id, label: spec.label, items: items, hasMore: !!res.hasMore, note: res.note || '' };
        })
        .catch(function (err) {
          return { id: id, label: spec.label, items: [], error: String(err && err.message ? err.message : err) };
        });
    });
    return Promise.all(jobs).then(function (results) {
      return { query: query, page: page, results: results };
    });
  }

  /* --------------------------------------------------------- image search */

  function multipart(fields, fileField, fileName, mime, base64) {
    var boundary = '----DawnComicDownloaderBoundary' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    var head = '';
    Object.keys(fields || {}).forEach(function (k) {
      head += '--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n';
    });
    head += '--' + boundary + '\r\nContent-Disposition: form-data; name="' + fileField + '"; filename="' + fileName + '"\r\n' +
      'Content-Type: ' + mime + '\r\n\r\n';
    var tail = '\r\n--' + boundary + '--\r\n';
    var body = asciiBytes(head).concat(base64ToBytes(base64), asciiBytes(tail));
    return { boundary: boundary, base64: bytesToBase64(body) };
  }

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function base64ToBytes(b64) {
    var clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
    var out = [], buf = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
      var c = clean[i];
      if (c === '=') break;
      var v = B64.indexOf(c);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((buf >> bits) & 0xff);
      }
    }
    return out;
  }

  function bytesToBase64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[(b0 >> 2) & 63];
      out += B64[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
      out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 || 0) >> 6)] : '=';
      out += i + 2 < bytes.length ? B64[b2 & 63] : '=';
    }
    return out;
  }

  function asciiBytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out.push(c & 0xff);
    }
    return out;
  }

  /* SauceNAO: needs a free API key. Returns normalised matches. */
  function sauceNao(ctx, opts) {
    var body = multipart(
      { output_type: 2, numres: 6, db: 999, api_key: opts.apiKey || '' },
      'file', 'query.' + (opts.ext || 'jpg'), opts.mime || 'image/jpeg', opts.base64
    );
    return ctx.post('https://saucenao.com/search.php', '', {
      headers: Object.assign(baseHeaders('https://saucenao.com/'), {
        'Content-Type': 'multipart/form-data; boundary=' + body.boundary
      }),
      bodyBase64: body.base64
    }).then(function (res) {
      var json;
      try { json = JSON.parse(res.body); } catch (e) { throw new Error('E_PARSE: SauceNAO 返回非 JSON'); }
      var out = [];
      (json.results || []).forEach(function (r) {
        var h = r.header || {}, d = r.data || {};
        out.push({
          engine: 'saucenao',
          similarity: parseFloat(h.similarity || '0'),
          index: h.index_id,
          title: collapse(d.title || d.jp_name || ''),
          author: collapse(d.author_name || d.member_name || ''),
          material: collapse(d.material || ''),
          source: (Object.keys(d).indexOf('ext_urls') >= 0 && d.ext_urls[0]) || ''
        });
      });
      return out;
    });
  }

  /* IQDB: keyless fallback, decent for anime/manga frames. */
  function iqdb(ctx, opts) {
    var body = multipart({ 'service[]': 1 }, 'file', 'query.' + (opts.ext || 'jpg'), opts.mime || 'image/jpeg', opts.base64);
    return ctx.post('https://iqdb.org/', '', {
      headers: Object.assign(baseHeaders('https://iqdb.org/'), { 'Content-Type': 'multipart/form-data; boundary=' + body.boundary }),
      bodyBase64: body.base64
    }).then(function (res) {
      var html = res.body || '';
      var out = [];
      var blocks = html.split('class="match"').slice(1);
      blocks.forEach(function (b) {
        var sim = /(\d{1,3})%/.exec(b);
        var src = /href="(\/\/[^"]+|https?:\/\/[^"]+)"/.exec(b);
        var meta = /class="tag"?[^>]*>([\s\S]{0,200}?)<\/td>/.exec(b);
        out.push({
          engine: 'iqdb',
          similarity: sim ? parseInt(sim[1], 10) : 0,
          title: meta ? collapse(stripTags(meta[1])) : '',
          author: '',
          material: '',
          source: src ? absolute('https://iqdb.org/', src[1]) : ''
        });
      });
      return out;
    });
  }

  function identifyImage(ctx, opts) {
    var primary = opts.apiKey ? sauceNao(ctx, opts) : Promise.reject(new Error('E_NO_KEY: 未设置 SauceNAO API Key'));
    return primary
      .catch(function (err) { return iqdb(ctx, opts).then(function (list) { return list; }).catch(function () { throw err; }); })
      .then(function (matches) {
        return matches
          .filter(function (m) { return m.similarity >= (opts.minSimilarity || 55); })
          .sort(function (a, b) { return b.similarity - a.similarity; });
      });
  }

  /* Turn one identification into ranked text queries for the six sources. */
  function queriesFromMatch(m) {
    var q = [];
    if (m.title) q.push(m.title);
    if (m.author && m.title) q.push(m.author + ' ' + m.title);
    else if (m.author) q.push(m.author);
    if (m.material) q.push(m.material);
    return uniq(q.map(collapse).filter(function (v) { return v.length > 1; }));
  }

  /* ------------------------------------------------------------- download */

  function planExport(item, opts) {
    var root = opts.root ? String(opts.root).replace(/[\\/]+$/, '') : '';
    var width = opts.indexWidth || 3;
    var index = opts.index || 1;
    var folder = pad(index, width) + ' ' + safeName(opts.name || item.title);
    var pages = (opts.pages || []).map(function (p, i) {
      var ext = extensionOf(p.url, item.kind === 'video' ? 'mp4' : 'jpg');
      return { url: p.url, name: pad(i + 1, width) + '.' + ext, index: i + 1 };
    });
    return {
      folder: folder,
      dir: root ? root + '\\' + folder : folder,
      files: pages
    };
  }

  /* A small, stable fingerprint used to key the cover cache and the library. */
  function fingerprint(item) {
    var s = item.uid + '|' + item.title;
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0x7fffffff;
    return h.toString(36);
  }

  return {
    SOURCES: SOURCES,
    UA: UA,
    sourceInfo: sourceInfo,
    getSource: getSource,
    baseHeaders: baseHeaders,
    searchAll: searchAll,
    normalize: normalize,
    identifyImage: identifyImage,
    queriesFromMatch: queriesFromMatch,
    planExport: planExport,
    fingerprint: fingerprint,
    safeName: safeName,
    pad: pad,
    extensionOf: extensionOf,
    stripTags: stripTags,
    decodeEntities: decodeEntities,
    collapse: collapse,
    tokenize: tokenize,
    multipart: multipart,
    base64ToBytes: base64ToBytes,
    bytesToBase64: bytesToBase64,
    asciiBytes: asciiBytes,
    parsers: {
      niacgCards: niacg.parseCards,
      niacgPages: niacg.pages,
      niacgMeta: niacg.meta,
      ahriCards: ahri.parseCards,
      ahriPages: ahri.pages,
      jmCards: jm.parseCards,
      jmPages: jm.pages,
      jmChallenge: jm.challengeCheck,
      hlPosts: hentaileague.parsePosts,
      rule34Cards: rule34us.parseCards,
      r34videoCards: r34video.parseCards
    }
  };
});
