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

  /* HTML client ported from hect0x7/JMComic-Crawler-Python (MIT). What came
   * across is the part that matters: the search parameter set, the album /
   * photo page fields, the base64-wrapped page body, the domain choice, and the
   * band-shuffle key every 18comic page image is served with. The library's
   * encrypted app API is not used here — it needs hardcoded app secrets and an
   * AES-ECB step the sandboxed page cannot run; the HTML client returns the
   * same content. */

  var JM = {
    SCRAMBLE_220980: 220980,
    SCRAMBLE_268850: 268850,
    SCRAMBLE_421926: 421926,
    DOMAINS: ['18comic.vip', '18comic.org', '18comic.cc', 'jm-comic2.cc'],
    VERSION: '2.1.13'
  };

  /* MD5, because 18comic derives the band count from md5(aid + file name) and
   * WebCrypto has no MD5. Straight RFC 1321, byte in, hex out. */
  function md5Hex(bytes) {
    var s = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    var K = [];
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
    var len = bytes.length;
    var withPad = len + 9;
    var total = ((withPad + 63) >> 6) << 6;
    var msg = new Uint8Array(total);
    msg.set(bytes);
    msg[len] = 0x80;
    var bitsLo = (len * 8) >>> 0, bitsHi = Math.floor(len / 536870912) >>> 0;
    msg[total - 8] = bitsLo & 0xff; msg[total - 7] = (bitsLo >>> 8) & 0xff;
    msg[total - 6] = (bitsLo >>> 16) & 0xff; msg[total - 5] = (bitsLo >>> 24) & 0xff;
    msg[total - 4] = bitsHi & 0xff; msg[total - 3] = (bitsHi >>> 8) & 0xff;

    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

    function rol(x, c) { return ((x << c) | (x >>> (32 - c))) | 0; }

    for (var off = 0; off < total; off += 64) {
      var M = new Array(16);
      for (var j = 0; j < 16; j++) {
        M[j] = msg[off + j * 4] | (msg[off + j * 4 + 1] << 8) | (msg[off + j * 4 + 2] << 16) | (msg[off + j * 4 + 3] << 24);
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (var k = 0; k < 64; k++) {
        var F, g;
        if (k < 16) { F = (B & C) | (~B & D); g = k; }
        else if (k < 32) { F = (D & B) | (~D & C); g = (5 * k + 1) & 15; }
        else if (k < 48) { F = B ^ C ^ D; g = (3 * k + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * k) & 15; }
        var tmp = D;
        D = C;
        C = B;
        var sum = (A + F + K[k] + M[g]) | 0;
        B = (B + rol(sum, s[(k >> 4) * 4 + (k % 4)])) | 0;
        A = tmp;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }

    function hex32(n) {
      var out = '';
      for (var b = 0; b < 4; b++) out += ('0' + ((n >>> (b * 8)) & 0xff).toString(16)).slice(-2);
      return out;
    }
    return hex32(a0) + hex32(b0) + hex32(c0) + hex32(d0);
  }

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0xd800 || c >= 0xe000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else {
        var cp = 0x10000 + ((c - 0xd800) << 10) + (str.charCodeAt(++i) - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return out;
  }

  function decodeUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  /* How many horizontal bands an 18comic page image was shuffled into, and
   * therefore how many to re-stack. 0 means "served as is". Same thresholds and
   * the same md5 trick as JMComic's JmImageTool.get_num. */
  function jmScrambleNum(scrambleId, aid, fileName) {
    if (scrambleId === undefined || scrambleId === null || scrambleId === '') return 0;
    var sid = parseInt(scrambleId, 10) || 0;
    var album = parseInt(aid, 10) || 0;
    if (album < sid) return 0;
    if (album < JM.SCRAMBLE_268850) return 10;
    var x = album < JM.SCRAMBLE_421926 ? 10 : 8;
    var hex = md5Hex(utf8Bytes(String(album) + String(fileName)));
    var num = hex.charCodeAt(hex.length - 1) % x;
    return num * 2 + 2;
  }

  /* Band permutation, as (sourceY, destY, height) triples, so the page can
   * apply it with a canvas and the test suite can check it without one. */
  function jmScramblePlan(num, height) {
    if (!num || num <= 0) return [];
    var move = Math.floor(height / num);
    var over = height % num;
    var plan = [];
    for (var i = 0; i < num; i++) {
      var step = move;
      var ySrc = height - (move * (i + 1)) - over;
      var yDst = move * i;
      if (i === 0) step += over;
      else yDst += over;
      plan.push({ src: ySrc, dst: yDst, h: step });
    }
    return plan;
  }

  var jm = {
    id: 'jm',
    label: '禁漫天堂',
    host: '18comic.vip',
    base: 'https://18comic.vip',
    kind: 'gallery',
    caps: { text: true, browse: true, tag: true, image: false },
    challenge: true,
    note: 'HTML 客户端按 JMComic-Crawler-Python 移植：/search/photos 检索、/album 详情、/photo 取页、chapter_view_template 取乱序参数；域名可在设置里换。未在本机通过 Cloudflare 质询验证。',

    domain: function (ctx) {
      var raw = (ctx && ctx.settings && ctx.settings.jmDomain) || JM.DOMAINS[0];
      var host = String(raw).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase();
      return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : JM.DOMAINS[0];
    },

    baseOf: function (ctx) { return 'https://' + jm.domain(ctx); },

    challengeCheck: function (html) {
      return /Just a moment|cf_chl|challenge-platform|Enable JavaScript and cookies/i.test(html || '');
    },

    /* Newer 18comic pages ship the real markup inside base64Utf8(...). */
    unwrap: function (html) {
      var m = /const html = base64DecodeUtf8\("([\s\S]*?)"\)/.exec(html || '');
      if (!m) return html || '';
      try { return decodeUtf8(base64ToBytes(m[1])); } catch (e) { return html || ''; }
    },

    parseCards: function (html, base) {
      var out = [];
      var re = /<a[^>]+href="(\/album\/(\d+)\/[^"]*)"[^>]*>([\s\S]{0,900}?)<\/a>/g, m;
      while ((m = re.exec(html))) {
        var body = m[3];
        var img = /(?:data-original|data-src|src)="([^"]+)"/.exec(body);
        var title = /<div class="[^"]*(?:album-title|title)[^"]*"[^>]*>([\s\S]{0,200}?)<\/div>/.exec(m[0]) ||
          /<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]{0,200}?)<\/span>/.exec(m[0]) ||
          /title="([^"]{2,160})"/.exec(m[0]);
        out.push({
          id: m[2],
          url: absolute(base, m[1]),
          title: title ? collapse(stripTags(title[1])) : '#' + m[2],
          cover: img ? absolute(base, img[1]) : '',
          author: '',
          tags: []
        });
      }
      return dedupe(out);
    },

    /* Search takes the same parameter set as JMComic's html client. A purely
     * numeric query is an album id, which the site would redirect to anyway. */
    search: function (ctx, query, page) {
      var base = jm.baseOf(ctx);
      var p = Math.max(1, page || 1);
      var q = collapse(query);
      if (/^\d{2,}$/.test(q)) {
        return ctx.get(base + '/album/' + q + '/', { headers: baseHeaders(base + '/') }).then(function (res) {
          var html = jm.unwrap(res.body);
          if (jm.challengeCheck(html)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
          var meta = jm.albumMeta(html);
          return {
            items: [{ id: q, url: base + '/album/' + q + '/', title: meta.title || ('#' + q), cover: meta.cover, author: meta.authors[0] || '', tags: meta.tags.slice(0, 6) }],
            hasMore: false
          };
        });
      }
      var url = base + '/search/photos?' + qs({ search_query: q, page: p, main_tag: 0, o: 'mr', t: 'a' });
      return ctx.get(url, { headers: baseHeaders(base + '/') }).then(function (res) {
        var html = jm.unwrap(res.body);
        if (jm.challengeCheck(html)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
        var items = jm.parseCards(html, base);
        return { items: items, hasMore: items.length > 0 };
      });
    },

    browse: function (ctx, page) {
      var base = jm.baseOf(ctx);
      var p = Math.max(1, page || 1);
      return ctx.get(base + '/albums?page=' + p, { headers: baseHeaders(base + '/') }).then(function (res) {
        var html = jm.unwrap(res.body);
        if (jm.challengeCheck(html)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
        return { items: jm.parseCards(html, base), hasMore: true };
      });
    },

    albumMeta: function (html) {
      var name = /id="book-name"[^>]*>([\s\S]*?)</.exec(html) || /<title>([\s\S]*?)\|/.exec(html);
      var cover = /<meta property="og:image" content="([^"]+)"/.exec(html) ||
        /<div class="[^"]*thumb-overlay[^"]*"[\s\S]{0,400}?data-original="([^"]+)"/.exec(html);
      var authors = [];
      var block = /<span itemprop="author" data-type="author">([\s\S]*?)<\/span>/.exec(html);
      if (block) {
        var re = /<a[^>]*>([\s\S]*?)<\/a>/g, m;
        while ((m = re.exec(block[1]))) authors.push(collapse(stripTags(m[1])));
      }
      var works = [];
      var wb = /<span itemprop="author" data-type="works">([\s\S]*?)<\/span>/.exec(html);
      if (wb) {
        var rw = /<a[^>]*>([\s\S]*?)<\/a>/g, mw;
        while ((mw = rw.exec(wb[1]))) works.push(collapse(stripTags(mw[1])));
      }
      var tags = works.slice();
      var tb = /<span itemprop="genre" data-type="tags">([\s\S]*?)<\/span>/.exec(html);
      if (tb) {
        var rt = /<a[^>]*>([\s\S]*?)<\/a>/g, mt;
        while ((mt = rt.exec(tb[1]))) tags.push(collapse(stripTags(mt[1])));
      }
      var count = /<span class="pagecount"[\s\S]{0,40}?:(\d+)<\/span>/.exec(html);
      var scramble = /var scramble_id = (\d+);/.exec(html);
      var chapters = [];
      var rc = /href="(\/photo\/(\d+)\/?)"/g, mc;
      while ((mc = rc.exec(html))) {
        if (chapters.indexOf(mc[2]) < 0) chapters.push(mc[2]);
      }
      return {
        title: name ? collapse(stripTags(name[1])) : '',
        cover: cover ? absolute(jm.base, cover[1]) : '',
        authors: uniq(authors),
        tags: uniq(tags),
        works: uniq(works),
        count: count ? parseInt(count[1], 10) : 0,
        scrambleId: scramble ? scramble[1] : '',
        chapters: chapters
      };
    },

    detail: function (ctx, item) {
      var base = jm.baseOf(ctx);
      var aid = String(item.id || '');
      return ctx.get(item.url || (base + '/album/' + aid + '/'), { headers: baseHeaders(base + '/') }).then(function (res) {
        var html = jm.unwrap(res.body);
        if (jm.challengeCheck(html)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
        var meta = jm.albumMeta(html);
        var chapters = meta.chapters.length ? meta.chapters : [aid];
        var queue = chapters.slice(0, 20);
        var pages = [];
        var chain = Promise.resolve();
        queue.forEach(function (pid) {
          chain = chain.then(function () {
            return ctx.get(base + '/photo/' + pid + '/', { headers: baseHeaders(base + '/album/' + aid + '/') })
              .then(function (r) {
                var body = jm.unwrap(r.body);
                if (jm.challengeCheck(body)) throw new Error('E_CHALLENGE: 需要先通过站点人机校验');
                var scramble = (/var scramble_id = (\d+);/.exec(body) || [])[1] || meta.scrambleId;
                jm.pageUrls(body, base).forEach(function (url) {
                  var file = url.split('/').pop().split('?')[0];
                  pages.push({ url: url, num: jmScrambleNum(scramble, aid, file), scrambleId: scramble, aid: aid });
                });
              });
          });
        });
        return chain.then(function () {
          if (!pages.length) throw new Error('E_PARSE: 章节内没有图片');
          return {
            meta: { title: meta.title || item.title, author: meta.authors[0] || '', tags: meta.tags.slice(0, 10) },
            pages: pages,
            count: meta.count
          };
        });
      });
    },

    pageUrls: function (html, base) {
      var urls = [];
      var re = /data-original="([^"]+)"/g, m;
      while ((m = re.exec(html))) {
        var u = absolute(base, m[1]);
        if (/\/media\/(photos|albums)\//.test(u) && !/blank\.(?:gif|png|jpg)$/i.test(u)) urls.push(u);
      }
      if (!urls.length) {
        var re2 = /<img[^>]+id="album_photo_[^"]*"[^>]+(?:data-original|src)="([^"]+)"/g, m2;
        while ((m2 = re2.exec(html))) urls.push(absolute(base, m2[1]));
      }
      return uniq(urls);
    },

    pages: function (html, base) {
      return jm.pageUrls(html, base).map(function (u) { return { url: u }; });
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
    md5Hex: md5Hex,
    jmScrambleNum: jmScrambleNum,
    jmScramblePlan: jmScramblePlan,
    jmDomains: JM.DOMAINS,
    parsers: {
      niacgCards: niacg.parseCards,
      niacgPages: niacg.pages,
      niacgMeta: niacg.meta,
      ahriCards: ahri.parseCards,
      ahriPages: ahri.pages,
      jmCards: jm.parseCards,
      jmPages: jm.pages,
      jmChallenge: jm.challengeCheck,
      jmAlbumMeta: jm.albumMeta,
      jmPageUrls: jm.pageUrls,
      hlPosts: hentaileague.parsePosts,
      rule34Cards: rule34us.parseCards,
      r34videoCards: r34video.parseCards
    }
  };
});
