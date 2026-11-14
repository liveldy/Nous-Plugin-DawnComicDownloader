/* DawnComicDownloader — view layer. Talks to the native engine through runtime.invoke only.
 * MIT. */
(function () {
  'use strict';

  var E = window.DawnEngine;
  var $ = function (id) { return document.getElementById(id); };
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --------------------------------------------------------------- bridge */

  var Demo = window.__DAWN_DEMO__ || null;
  var Host = {
    ready: null,
    invoke: async function (method, params) {
      var r = await Host.ready;
      return r.invoke(method, params);
    },
    /* storage.* belongs to the host, not to the native engine: sending it through
     * runtime.invoke made the module answer E_UNSUPPORTED on every download. */
    store: async function (method, params) {
      var r = await Host.ready;
      return r.store(method, params);
    }
  };

  Host.ready = (async function () {
    if (Demo) {
      document.documentElement.dataset.theme = Demo.theme || 'light';
      if (typeof Demo.onNav === 'function') Demo.onNav(setView);
      return {
        invoke: Demo.invoke,
        store: Demo.invoke,
        plugin: { theme: Demo.theme || 'light' },
        demo: true
      };
    }
    if (!window.NousPlugin) throw new Error('E_HOST: 缺少宿主桥');
    var ctx = await window.NousPlugin.ready;
    document.documentElement.dataset.theme = ctx.theme === 'dark' ? 'dark' : 'light';
    window.NousPlugin.on('theme.changed', function (t) {
      document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
    });
    window.NousPlugin.on('navigation.changed', function (view) { App.setView(view); });
    return {
      invoke: async function (method, params) {
        try {
          return await window.NousPlugin.request('runtime.invoke', { method: method, params: params || {} }, { timeoutMs: 180000 });
        } catch (err) {
          var msg = String(err && err.message ? err.message : err);
          if (/E_UNSUPPORTED/.test(msg)) {
            throw new Error('E_MODULE: 模块 ' + (App.engineVersion || '未知') + ' 不支持 ' + method + '。插件页与模块版本不一致时请在插件管理里重装一次（模块随包更新）。');
          }
          throw err;
        }
      },
      store: function (method, params) {
        return window.NousPlugin.request(method, params || {});
      },
      plugin: ctx
    };
  })();

  var ctx = {
    get: async function (url, opts) {
      opts = opts || {};
      var r = await Host.invoke('http.request', {
        url: url, method: 'GET', headers: opts.headers || {}, timeoutMs: opts.timeoutMs || 25000
      });
      return normalize(r);
    },
    post: async function (url, body, opts) {
      opts = opts || {};
      var headers = Object.assign({}, opts.headers || {});
      var params = { url: url, method: 'POST', headers: headers, timeoutMs: opts.timeoutMs || 30000 };
      if (opts.bodyBase64) { params.bodyBase64 = opts.bodyBase64; }
      else {
        params.body = body || '';
        if (opts.contentType) headers['Content-Type'] = opts.contentType;
      }
      return normalize(await Host.invoke('http.request', params));
    }
  };

  Object.defineProperty(ctx, 'settings', { get: function () { return App.settings; } });

  function normalize(r) {
    return { status: r.status || 0, body: r.body || '', url: r.url || '', headers: r.headers || {} };
  }

  /* ---------------------------------------------------------------- state */

  var App = {
    view: 'search',
    mode: 'text',
    page: 1,
    query: '',
    items: [],
    results: {},
    queue: [],
    scanning: false,
    settings: { root: '', sauce: '', width: 3, start: 1, jmCookie: '', jmDomain: '18comic.vip', jmDescramble: true, ua: '' },
    disabled: {},
    filter: null,
    kind: null,
    counter: 1,
    coverCache: new Map(),
    coversInFlight: 0
  };

  var COVER_CONCURRENCY = 4;
  var COVER_QUEUE = [];

  /* ------------------------------------------------------------ storage */

  async function loadState() {
    try {
      var s = await Host.store('storage.get', { key: 'settings' });
      if (s && typeof s === 'object') App.settings = Object.assign(App.settings, s);
    } catch (e) { /* first run */ }
    try {
      var c = await Host.store('storage.get', { key: 'counter' });
      if (c && typeof c === 'number') App.counter = c;
    } catch (e) { /* first run */ }
    try {
      var d = await Host.store('storage.get', { key: 'disabled' });
      if (d && typeof d === 'object') App.disabled = d;
    } catch (e) { /* first run */ }
  }

  function saveSettings() {
    return Host.store('storage.set', { key: 'settings', value: App.settings }).catch(function () {});
  }

  /* -------------------------------------------------------------- render */

  var CAP_WORD = { text: '文字', browse: '浏览', tag: '标签', image: '反查' };

  /* The six sites live at the foot of the page: one row, a hairline between
   * each, the capability line under the host. A click turns that site off or
   * on for the next search; the dot follows. */
  function renderSites() {
    var wrap = $('sites');
    if (!wrap) return;
    wrap.textContent = '';
    E.sourceInfo().forEach(function (s) {
      var on = !App.disabled[s.id];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'site';
      btn.dataset.id = s.id;
      btn.dataset.state = 'idle';
      btn.setAttribute('aria-pressed', String(on));
      btn.title = s.note || s.host;
      btn.innerHTML = '<span class="sh"><span class="dot" aria-hidden="true"></span><span class="sname"></span><span class="n"></span></span>' +
        '<span class="shost"></span><span class="scaps"></span>';
      btn.querySelector('.sname').textContent = s.label;
      btn.querySelector('.shost').textContent = s.host;
      btn.querySelector('.scaps').textContent = ['text', 'browse', 'tag', 'image']
        .filter(function (k) { return s.caps[k]; })
        .map(function (k) { return CAP_WORD[k]; }).join(' · ');
      btn.addEventListener('click', function () {
        if (App.disabled[s.id]) delete App.disabled[s.id];
        else App.disabled[s.id] = 1;
        btn.setAttribute('aria-pressed', String(!App.disabled[s.id]));
        Host.store('storage.set', { key: 'disabled', value: App.disabled }).catch(function () {});
      });
      wrap.appendChild(btn);
      loadFavicon(btn, s);
    });
  }

  function loadFavicon(btn, s) {
    Host.invoke('image.proxy', { url: 'https://' + s.host + '/favicon.ico', maxBytes: 120000 }).then(function (r) {
      if (!r || !r.dataUrl) return;
      var img = new Image();
      img.className = 'favicon';
      img.alt = '';
      img.src = r.dataUrl;
      img.onerror = function () { img.remove(); };
      var dot = btn.querySelector('.dot');
      if (dot) dot.replaceWith(img);
    }).catch(function () {});
  }

  function setSiteState(id, state, count) {
    var el = document.querySelector('.site[data-id="' + id + '"]');
    if (!el) return;
    el.dataset.state = state;
    el.querySelector('.n').textContent = count ? String(count) : '';
  }

  /* One line of source filters above the grid: the counts come from the last
   * search, a click narrows the grid without asking any site again. */
  function renderFilters() {
    var bar = $('filters');
    var results = (App.results && App.results.results) || [];
    var total = App.items.length;
    if (!total) { bar.hidden = true; bar.textContent = ''; return; }
    bar.hidden = false;
    bar.textContent = '';
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip';
    all.dataset.id = '';
    all.setAttribute('aria-pressed', String(!App.filter && !App.kind));
    all.innerHTML = '<span class="cl"></span><span class="cn"></span>';
    all.querySelector('.cl').textContent = '全部';
    all.querySelector('.cn').textContent = String(total);
    all.addEventListener('click', function () {
      App.filter = null;
      App.kind = null;
      renderFilters();
      renderItems(true);
    });
    bar.appendChild(all);
    results.forEach(function (r) {
      if (!r.items.length) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.id = r.id;
      b.setAttribute('aria-pressed', String(App.filter === r.id));
      b.innerHTML = '<span class="cl"></span><span class="cn"></span>';
      b.querySelector('.cl').textContent = r.label;
      b.querySelector('.cn').textContent = String(r.items.length);
      b.addEventListener('click', function () {
        App.filter = App.filter === r.id ? null : r.id;
        renderFilters();
        renderItems(true);
      });
      bar.appendChild(b);
    });
    var kinds = [
      { id: 'gallery', label: '漫画', n: App.items.filter(function (it) { return it.kind === 'gallery'; }).length },
      { id: 'video', label: '视频', n: App.items.filter(function (it) { return it.kind === 'video'; }).length }
    ].filter(function (k) { return k.n > 0; });
    if (kinds.length > 1) {
      var sep = document.createElement('span');
      sep.className = 'chip-sep';
      sep.setAttribute('aria-hidden', 'true');
      bar.appendChild(sep);
      kinds.forEach(function (k) {
        var kb = document.createElement('button');
        kb.type = 'button';
        kb.className = 'chip';
        kb.dataset.kind = k.id;
        kb.setAttribute('aria-pressed', String(App.kind === k.id));
        kb.innerHTML = '<span class="cl"></span><span class="cn"></span>';
        kb.querySelector('.cl').textContent = k.label;
        kb.querySelector('.cn').textContent = String(k.n);
        kb.addEventListener('click', function () {
          App.kind = App.kind === k.id ? null : k.id;
          renderFilters();
          renderItems(true);
        });
        bar.appendChild(kb);
      });
    }
  }

  function visibleItems() {
    return App.items.filter(function (it) {
      if (App.filter && it.source !== App.filter) return false;
      if (App.kind && it.kind !== App.kind) return false;
      return true;
    });
  }

  /* Before the first search the grid holds four quiet frames: the shape results
   * will take, no words needed. */
  function renderGhosts() {
    var grid = $('grid');
    grid.textContent = '';
    for (var i = 0; i < 4; i++) {
      var g = document.createElement('span');
      g.className = 'frame';
      g.setAttribute('aria-hidden', 'true');
      grid.appendChild(g);
    }
    document.documentElement.dataset.hasResults = 'false';
  }
  function makeCard(item, i) {
    var card = document.createElement('button');
    card.type = 'button';
    card.className = 'card';
    card.dataset.uid = item.uid;
    card.style.setProperty('--i', String(Math.min(i, 12)));
    card.setAttribute('aria-selected', String(isQueued(item.uid)));
    card.innerHTML =
      '<span class="shot"><img alt="" decoding="async">' +
      (item.duration ? '<span class="badge"></span>' : '') +
      '<span class="pick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 13 4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span></span>' +
      '<span class="meta"><h3></h3><p class="by"></p><p class="tags"></p></span>';
    card.querySelector('h3').textContent = item.title;
    card.querySelector('.by').textContent = item.author;
    card.querySelector('.tags').textContent = item.tags.join(' · ');
    if (item.duration) card.querySelector('.badge').textContent = item.duration;
    card.addEventListener('click', function () { togglePick(item, card); });
    requestCover(item.cover, card.querySelector('img'), item.url);
    return card;
  }

  function renderItems(reset) {
    var grid = $('grid');
    if (reset) grid.textContent = '';
    var list = visibleItems();
    list.forEach(function (item, i) { grid.appendChild(makeCard(item, i)); });
    document.documentElement.dataset.hasResults = App.items.length ? 'true' : 'false';
    $('blank').hidden = !(App.items.length && !list.length);
    if (App.items.length && !list.length) $('blank').textContent = '这个来源这次没有结果。';
  }

  function appendItems(list) {
    var grid = $('grid');
    var base = App.items.length - list.length;
    list.forEach(function (item, i) { grid.appendChild(makeCard(item, base + i)); });
    if (!base) document.documentElement.dataset.hasResults = 'true';
  }

  function requestCover(url, img, referer) {
    if (!url) return;
    if (App.coverCache.has(url)) {
      img.src = App.coverCache.get(url);
      img.classList.add('is-in');
      return;
    }
    COVER_QUEUE.push({ url: url, img: img, referer: referer || '' });
    pumpCovers();
  }

  /* Some CDNs answer image requests only with a Referer, and some answer with
   * application/octet-stream; the browser will not render the latter, so the
   * magic bytes decide the data URL's type. */
  function fixDataUrlType(dataUrl) {
    var m = /^data:([^;,]*)(;base64,)([\s\S]*)$/.exec(dataUrl || '');
    if (!m) return dataUrl;
    var declared = (m[1] || '').toLowerCase();
    if (declared && declared.indexOf('image/') === 0) return dataUrl;
    var head = E.base64ToBytes(m[3].slice(0, 24));
    var type = '';
    if (head[0] === 0xff && head[1] === 0xd8) type = 'image/jpeg';
    else if (head[0] === 0x89 && head[1] === 0x50) type = 'image/png';
    else if (head[0] === 0x47 && head[1] === 0x49) type = 'image/gif';
    else if (head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57) type = 'image/webp';
    else if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) type = 'image/avif';
    return type ? 'data:' + type + m[2] + m[3] : dataUrl;
  }

  function pumpCovers() {
    while (App.coversInFlight < COVER_CONCURRENCY && COVER_QUEUE.length) {
      var job = COVER_QUEUE.shift();
      App.coversInFlight++;
      (async function (j) {
        try {
          var r = null;
          try {
            r = await Host.invoke('image.proxy', { url: j.url, maxBytes: 1400000, referer: j.referer });
          } catch (err) {
            if (!j.referer) throw err;
            r = await Host.invoke('image.proxy', { url: j.url, maxBytes: 1400000 });
          }
          if (!r || !r.dataUrl) return;
          var src = fixDataUrlType(r.dataUrl);
          App.coverCache.set(j.url, src);
          j.img.src = src;
          j.img.classList.add('is-in');
        } catch (e) {
          j.img.removeAttribute('src');
        } finally {
          App.coversInFlight--;
          pumpCovers();
        }
      })(job);
    }
  }

  /* ------------------------------------------------------------- picking */

  function isQueued(uid) {
    return App.queue.some(function (r) { return r.uid === uid; });
  }

  function togglePick(item, card) {
    var at = App.queue.findIndex(function (r) { return r.uid === item.uid; });
    if (at >= 0) App.queue.splice(at, 1);
    else App.queue.push({ uid: item.uid, item: item, state: 'queued', done: 0, total: 0, msg: '' });
    card.setAttribute('aria-selected', String(at < 0));
    renderQueue();
  }

  function renderQueue() {
    var list = $('qlist');
    list.textContent = '';
    $('qcount').textContent = String(App.queue.length);
    $('qempty').hidden = App.queue.length > 0;
    $('start').disabled = !App.queue.some(function (r) { return r.state === 'queued' || r.state === 'failed'; });
    var open = 0;
    App.queue.forEach(function (row) {
      var planned = App.counter + open;
      if (row.state !== 'done') open++;
      var li = document.createElement('li');
      li.className = 'qrow';
      li.dataset.state = row.state;
      li.innerHTML = '<span class="idx"></span><span class="qmain"><span class="t"></span><span class="s"></span></span><button class="drop" type="button" aria-label="移除"></button>';
      li.querySelector('.idx').textContent = row.state === 'done' ? '' : E.pad(planned, App.settings.width);
      li.querySelector('.t').textContent = row.item.title;
      li.querySelector('.s').textContent = statusLine(row);
      var drop = li.querySelector('.drop');
      drop.className = 'drop-item';
      drop.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13"><path d="M5 5l14 14M19 5 5 19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';
      drop.addEventListener('click', function () {
        App.queue = App.queue.filter(function (r) { return r.uid !== row.uid; });
        var card = document.querySelector('.card[data-uid="' + row.uid + '"]');
        if (card) card.setAttribute('aria-selected', 'false');
        renderQueue();
      });
      list.appendChild(li);
    });
    var done = App.queue.filter(function (r) { return r.state === 'done'; }).length;
    $('qbar').style.width = App.queue.length ? (done / App.queue.length) * 100 + '%' : '0';
    var root = App.settings.root;
    $('rootline').textContent = root || '未设置下载目录';
    $('openroot').hidden = !root;
  }

  function reportError(title, message) {
    var box = $('qerr');
    if (!box) return;
    box.hidden = false;
    box.textContent = title.slice(0, 28) + ' — ' + message;
  }

  function statusLine(row) {
    if (row.state === 'queued') return row.item.sourceLabel + ' · 待下载';
    if (row.state === 'working') return row.total ? row.done + '/' + row.total : '解析中';
    if (row.state === 'done') return row.item.sourceLabel + ' · ' + row.total + ' 页';
    if (row.state === 'failed') return row.msg || '失败';
    return '';
  }

  /* -------------------------------------------------------------- search */

  async function runSearch(page, append, only) {
    if (App.view !== 'search') App.setView('search');
    var query = App.mode === 'text' ? $('q').value.trim() : App.query;
    if (App.scanning) return;
    App.scanning = true;
    $('more').hidden = true;
    $('blank').hidden = true;
    var active = E.sourceInfo().map(function (s) { return s.id; }).filter(function (id) { return !App.disabled[id]; });
    if (only) active = [only];
    active.forEach(function (id) { setSiteState(id, 'busy', 0); });
    $('tally').textContent = '检索中';

    try {
      var res = await E.searchAll(ctx, { query: query, sources: active, page: page || 1 });
      App.page = page || 1;
      var merged = [];
      var failed = 0;
      res.results.forEach(function (r) {
        if (r.error) {
          failed++;
          setSiteState(r.id, 'error', 0);
          var siteEl = document.querySelector('.site[data-id="' + r.id + '"]');
          if (siteEl) siteEl.title = r.error;
        } else {
          setSiteState(r.id, r.items.length ? 'idle' : 'empty', r.items.length);
          merged = merged.concat(r.items);
        }
      });
      App.items = append ? App.items.concat(merged) : merged;
      if (!append) { App.filter = null; App.kind = null; }
      App.results = res;
      renderItems(!append);
      renderFilters();
      if (append) appendItems(merged);
      var shown = App.items.length;
      $('tally').textContent = shown ? shown + (failed ? ' · ' + failed + ' 站未响应' : '') : '0';
      $('more').hidden = shown < 8;
      if (!shown) {
        $('blank').textContent = failed
          ? '这些站点没有响应。18comic 需要在设置里填 cf_clearance，其余检查网络与 cookie。'
          : '没有命中。换一个 tag，或把这个站点头像关掉再试其它五站。';
        $('blank').hidden = false;
      }
    } catch (e) {
      $('blank').textContent = String(e && e.message ? e.message : e);
      $('blank').hidden = false;
      $('tally').textContent = '—';
    } finally {
      App.scanning = false;
    }
  }

  /* ------------------------------------------------------------ download */

  async function ensureRoot() {
    var root = App.settings.root;
    if (!root) throw new Error('先在设置里填下载目录');
    await Host.invoke('fs.allowRoot', { path: root });
    return root;
  }

  /* CDN edges behind a filtered network drop a body now and then; one retry
   * per page costs little and the module never leaves a half file behind. */
  async function downloadPage(file, dir, referer, page) {
    if (page && page.num > 0 && App.settings.jmDescramble !== false) {
      return downloadDescrambled(file, dir, referer, page);
    }
    var path = dir + '\\' + file.name;
    var last;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        return await Host.invoke('http.download', {
          url: file.url,
          path: path,
          headers: { 'User-Agent': E.UA, Referer: referer },
          skipExisting: true,
          timeoutMs: 180000
        });
      } catch (err) {
        last = err;
        await Host.invoke('fs.delete', { path: path + '.part' }).catch(function () {});
        await new Promise(function (r) { setTimeout(r, 500 * (attempt + 1)); });
      }
    }
    throw last;
  }

  /* 18comic serves page images with their horizontal bands shuffled. The
   * browser is where a decoder exists, so the page unstacks the bands and the
   * engine only writes the bytes back. Result is a PNG next to the numbering. */
  async function downloadDescrambled(file, dir, referer, page) {
    var path = dir + '\\' + file.name.replace(/\.(jpe?g|webp|png|avif)$/i, '.png');
    var pulled;
    try {
      pulled = await fetchImageBytes(file.url, referer);
    } catch (err) {
      throw new Error('取图失败（' + String(err && err.message ? err.message : err).slice(0, 100) +
        '）。这一步要把页图从站点读进页面，若宿主限制结果体积，可先关掉“还原乱序页图”对比。');
    }
    var bytes = pulled.bytes;
    if (!bytes.length) throw new Error('取图失败：图片为空');
    var mime = pulled.mime || 'image/jpeg';

    var bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mime.split(';')[0] }));
    } catch (err) {
      throw new Error('解码失败（' + bytes.length + ' 字节，' + mime.split(';')[0] + '）');
    }
    var canvas = makeCanvas(bitmap.width, bitmap.height);
    var g = canvas.getContext('2d');
    E.jmScramblePlan(page.num, bitmap.height).forEach(function (band) {
      g.drawImage(bitmap, 0, band.src, bitmap.width, band.h, 0, band.dst, bitmap.width, band.h);
    });
    if (bitmap.close) bitmap.close();
    var blob = await canvasToBlob(canvas);
    var buffer = await blob.arrayBuffer();
    try {
      await writeBytes(path, new Uint8Array(buffer));
    } catch (err) {
      throw new Error('写盘失败（' + buffer.byteLength + ' 字节）：' + String(err && err.message ? err.message : err).slice(0, 90) +
        '。可先关掉“还原乱序页图”再试：不还原时页图由模块直接落盘，不经过页面与宿主的大数据往返。');
    }
    return { path: path, bytes: buffer.byteLength };
  }

  /* The host caps a request at 1 MiB and a result at 4 MiB. A page image can be
   * several megabytes, so big ones are pulled with Range requests: net.probe
   * gives the size, then 1 MiB slices keep every result under the cap. When the
   * size is unknown the slice that comes back short ends the stream. */
  async function fetchImageBytes(url, referer) {
    var headers = { 'User-Agent': E.currentUserAgent(), Referer: referer };
    var size = 0;
    try {
      var probe = await Host.invoke('net.probe', { url: url, timeoutMs: 20000 });
      size = (probe && probe.bytes) || 0;
    } catch (err) { size = 0; }

    if (size > 2 * 1024 * 1024) return rangeFetch(url, headers, size);

    try {
      var one = await Host.invoke('http.request', {
        url: url, method: 'GET', binary: true, headers: headers, timeoutMs: 180000
      });
      return {
        bytes: new Uint8Array(E.base64ToBytes(one.bodyBase64 || '')),
        mime: (one.headers && one.headers['content-type']) || 'image/jpeg'
      };
    } catch (err) {
      var msg = String(err && err.message ? err.message : err);
      if (!/过大|too large|TOO_LARGE/i.test(msg)) throw err;
      return rangeFetch(url, headers, 0);
    }
  }

  async function rangeFetch(url, headers, size) {
    var slice = 1024 * 1024;
    var parts = [];
    var got = 0;
    for (;;) {
      var to = size ? Math.min(got + slice, size) - 1 : got + slice - 1;
      var r = await Host.invoke('http.request', {
        url: url,
        method: 'GET',
        binary: true,
        headers: Object.assign({ Range: 'bytes=' + got + '-' + to }, headers),
        timeoutMs: 120000
      });
      if (r.status === 416) break;
      var chunk = new Uint8Array(E.base64ToBytes(r.bodyBase64 || ''));
      if (!chunk.length) break;
      parts.push(chunk);
      got += chunk.length;
      if (size && got >= size) break;
      if (!size && chunk.length < slice) break;
      if (!size && got > 64 * 1024 * 1024) break;
    }
    if (!parts.length) throw new Error('E_HTTP: 分段取图为空');
    var total = parts.reduce(function (n, p) { return n + p.length; }, 0);
    var merged = new Uint8Array(total);
    var at = 0;
    parts.forEach(function (part) { merged.set(part, at); at += part.length; });
    return { bytes: merged, mime: '' };
  }
  /* The host refuses a payload it considers too large, but the exact threshold
   * has not matched the documented 1 MiB for every call. So the writer starts at
   * 128 KiB and halves itself whenever a chunk is refused, down to 8 KiB; the
   * error names the smallest size that still failed. */
  async function writeBytes(path, bytes) {
    var chunk = 128 * 1024;
    var offset = 0;
    var first = true;
    try {
      while (offset < bytes.length) {
        var size = Math.min(chunk, bytes.length - offset);
        var b64 = E.bytesToBase64(bytes.subarray(offset, offset + size));
        var wrote = false;
        var attempt = 0;
        for (;;) {
          try {
            await Host.invoke('file.writeBase64', { path: path, base64: b64, append: !first });
            wrote = true;
            break;
          } catch (err) {
            var msg = String(err && err.message ? err.message : err);
            if (/过大|too large|TOO_LARGE/i.test(msg) && size > 8 * 1024) {
              chunk = Math.max(8 * 1024, Math.floor(size / 2));
              break;
            }
            if (++attempt >= 3) throw err;
            await new Promise(function (r) { setTimeout(r, 220 * attempt); });
          }
        }
        if (!wrote) continue;
        first = false;
        offset += size;
      }
    } catch (err) {
      await Host.invoke('fs.delete', { path: path }).catch(function () {});
      var note = String(err && err.message ? err.message : err);
      if (/过大|too large|TOO_LARGE/i.test(note)) {
        note += '（分片已降到 ' + Math.round(chunk / 1024) + ' KiB 仍被拒）';
      }
      throw new Error(note);
    }
  }
  async function runQueue() {
    $('start').disabled = true;
    var rows = App.queue.filter(function (r) { return r.state === 'queued' || r.state === 'failed'; });
    if (!rows.length) return;
    var root;
    try { root = await ensureRoot(); } catch (e) { $('blank').hidden = false; $('blank').textContent = e.message; return; }

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      row.state = 'working';
      row.msg = '';
      renderQueue();
      try {
        var spec = E.getSource(row.item.source);
        var detail = await spec.detail(ctx, row.item.raw);
        var plan = E.planExport(row.item, {
          root: root, index: App.counter, width: App.settings.width, pages: detail.pages
        });
        if (!plan.files.length) throw new Error('解析到 0 页：' + (detail.count ? '站点说有 ' + detail.count + ' 页但没取到图' : '章节里没有可用图片'));
        row.total = plan.files.length;
        row.done = 0;
        renderQueue();
        await Host.invoke('fs.mkdirs', { path: plan.dir });
        for (var f = 0; f < plan.files.length; f++) {
          var file = plan.files[f];
          await downloadPage(file, plan.dir, row.item.url, detail.pages[f]);
          row.done = f + 1;
          renderQueue();
        }
        row.state = 'done';
        App.counter += 1;
        await Host.store('storage.set', { key: 'counter', value: App.counter });
        await Host.store('storage.set', {
          key: 'library.' + App.counter,
          value: { title: row.item.title, source: row.item.source, dir: plan.dir, pages: plan.files.length, at: Date.now() }
        }).catch(function () {});
      } catch (err) {
        row.state = 'failed';
        row.msg = String(err && err.message ? err.message : err);
        reportError(row.item.title, row.msg);
      }
      renderQueue();
    }
    $('start').disabled = false;
  }

  /* ---------------------------------------------------------- image mode */

  async function identify(file) {
    var matches = $('matches');
    matches.textContent = '';
    var hint = $('hint');
    hint.textContent = '识别中';
    try {
      var dataUrl = await readAsDataUrl(file);
      var comma = dataUrl.indexOf(',');
      var base64 = dataUrl.slice(comma + 1);
      var mime = /^data:([^;]+)/.exec(dataUrl)[1];
      var found = await E.identifyImage(ctx, {
        base64: base64,
        mime: mime,
        ext: (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg'),
        apiKey: App.settings.sauce,
        minSimilarity: 50
      });
      hint.textContent = found.length ? '挑一条回灌关键词' : '没有足够相似的结果';
      found.forEach(function (m) {
        var row = document.createElement('div');
        row.className = 'match';
        row.innerHTML = '<span class="sim"></span><span><span class="mt"></span><br><span class="mm"></span></span><button class="use" type="button">用这个词</button>';
        row.querySelector('.sim').textContent = Math.round(m.similarity) + '%';
        row.querySelector('.mt').textContent = m.title || m.material || m.source || '未命名';
        row.querySelector('.mm').textContent = [m.author, m.material, m.engine].filter(Boolean).join(' · ');
        var q = E.queriesFromMatch(m)[0];
        var btn = row.querySelector('.use');
        btn.disabled = !q;
        btn.addEventListener('click', function () {
          setMode('text');
          $('q').value = q;
          runSearch(1, false);
        });
        matches.appendChild(row);
      });
    } catch (err) {
      hint.textContent = String(err && err.message ? err.message : err).slice(0, 120);
    }
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result)); };
      fr.onerror = function () { reject(new Error('E_IO: 读不到文件')); };
      fr.readAsDataURL(file);
    });
  }

  function setMode(mode) {
    App.mode = mode;
    document.querySelectorAll('.mode').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.mode === mode);
    });
    $('panel').hidden = mode !== 'image';
    $('q').placeholder = mode === 'image' ? '先用图片识别，再回灌关键词' : '画师、作品名、tag';
  }

  /* ------------------------------------------------------------- settings */

  function fillSettings() {
    var form = $('fields');
    form.root.value = App.settings.root || '';
    form.sauce.value = App.settings.sauce || '';
    form.width.value = String(App.settings.width || 3);
    form.start.value = String(App.counter);
    form.jmCookie.value = App.settings.jmCookie || '';
    form.jmDomain.value = App.settings.jmDomain || '18comic.vip';
    form.jmDescramble.checked = App.settings.jmDescramble !== false;
    form.ua.value = App.settings.ua || '';
  }

  function setView(view) {
    App.view = view === 'settings' ? 'settings' : 'search';
    $('settings').hidden = App.view !== 'settings';
    document.querySelector('.shell').hidden = App.view === 'settings';
    document.querySelector('.sites-wrap').hidden = App.view === 'settings';
    if (App.view === 'settings') fillSettings();
  }

  App.setView = setView;

  /* ----------------------------------------------------------------- boot */

  function bind() {
    $('find').addEventListener('submit', function (e) {
      e.preventDefault();
      App.query = $('q').value.trim();
      setMode('text');
      runSearch(1, false);
    });
    $('more').addEventListener('click', function () { runSearch(App.page + 1, true); });
    document.querySelectorAll('.mode').forEach(function (b) {
      b.addEventListener('click', function () { setMode(b.dataset.mode); });
    });
    $('pickfile').addEventListener('click', function () { $('file').click(); });
    $('file').addEventListener('change', function () {
      if ($('file').files && $('file').files[0]) identify($('file').files[0]);
    });
    $('drop').addEventListener('submit', function (e) { e.preventDefault(); });
    $('start').addEventListener('click', function () { runQueue(); });
    $('openroot').addEventListener('click', function () {
      if (App.settings.root) Host.invoke('system.openFolder', { path: App.settings.root }).catch(function () {});
    });
    $('browseRoot').addEventListener('click', function () { Picker.open($('fields').root.value.trim()); });
    if ($('jmProbe')) $('jmProbe').addEventListener('click', probeJm);
    if ($('dlTest')) $('dlTest').addEventListener('click', testDownload);
    $('pickerUp').addEventListener('click', function () { Picker.up(); });
    $('pickerNew').addEventListener('click', function () { Picker.create(); });
    $('pickerCancel').addEventListener('click', function () { $('picker').hidden = true; });
    $('pickerOk').addEventListener('click', function () {
      commitRoot($('pickerPath').value.trim() || Picker.path);
      $('picker').hidden = true;
    });
    $('pickerPath').addEventListener('change', function () {
      Picker.path = $('pickerPath').value.trim();
      Picker.list();
    });
    if ($('jmLogin')) {
      if (window.NousPlugin) $('jmLogin').addEventListener('click', passChallenge);
      else $('jmLogin').hidden = true;
    }
    $('fields').addEventListener('submit', async function (e) {
      e.preventDefault();
      var form = e.target;
      App.settings.root = form.root.value.trim();
      App.settings.sauce = form.sauce.value.trim();
      App.settings.width = Math.min(5, Math.max(2, parseInt(form.width.value, 10) || 3));
      App.settings.jmCookie = form.jmCookie.value.trim();
      App.settings.jmDomain = (form.jmDomain.value.trim() || '18comic.vip').replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      App.settings.jmDescramble = form.jmDescramble.checked;
      App.settings.ua = form.ua.value.trim();
      E.setUserAgent(App.settings.ua);
      var start = Math.max(1, parseInt(form.start.value, 10) || 1);
      App.counter = start;
      await saveSettings();
      await Host.store('storage.set', { key: 'counter', value: App.counter }).catch(function () {});
      if (App.settings.jmCookie) {
        var jmHost = App.settings.jmDomain;
        await Host.invoke('cookie.set', { host: jmHost, cookie: App.settings.jmCookie }).catch(function () {});
        await Host.invoke('cookie.set', { host: '.' + jmHost, cookie: App.settings.jmCookie }).catch(function () {});
      }
      if (App.settings.root) {
        await Host.invoke('fs.allowRoot', { path: App.settings.root }).catch(function () {});
      }
      $('saved').textContent = '已保存';
      setTimeout(function () { $('saved').textContent = ''; }, 2400);
      renderQueue();
    });
    $('q').addEventListener('focus', function () { if (App.mode === 'image') setMode('text'); });
  }

  (async function boot() {
    renderSites();
    renderGhosts();
    bind();
    renderQueue();
    setMode('text');
    try {
      await Host.ready;
      await loadState();
      E.setUserAgent(App.settings.ua || '');
      renderQueue();
      if (App.settings.root) {
        await Host.invoke('fs.allowRoot', { path: App.settings.root }).catch(function () {});
      }
      try {
        var info = await Host.invoke('engine.info', {});
        App.engineVersion = info && info.version ? info.version : '';
      } catch (e) { App.engineVersion = ''; }
      var view = (await Host.ready).plugin && (await Host.ready).plugin.view;
      setView(view || 'search');
    } catch (e) {
      $('blank').hidden = false;
      $('blank').textContent = '原生引擎未就绪：' + String(e && e.message ? e.message : e);
      $('tally').textContent = '—';
    }
  })();
})();
