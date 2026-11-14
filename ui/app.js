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
    /* Bytes too big for one host request go through a file: written in chunks,
     * streamed by the engine, then removed. */
    upload: async function (url, opts) {
      opts = opts || {};
      var bytes = opts.bytes || [];
      var dir = (App.dataRoot || "").replace(/[\\/]+$/, "");
      if (!dir) throw new Error("E_IO: 还没有拿到 module 的数据目录");
      var path = dir + "\\upload-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8) + ".bin";
      await writeBytes(path, new Uint8Array(bytes));
      try {
        var r = await Host.invoke("http.request", {
          url: url, method: "POST", headers: opts.headers || {}, bodyFile: path, timeoutMs: opts.timeoutMs || 60000
        });
        return normalize(r);
      } finally {
        await Host.invoke("fs.delete", { path: path }).catch(function () {});
      }
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
    seen: {},
    pages: {},
    pending: {},
    exhausted: {},
    results: {},
    queue: [],
    scanning: false,
    settings: { root: '', sauce: '', width: 3, start: 1, jmCookie: '', jmDomain: '18comic.vip', jmDescramble: true, ua: '', perSource: 20, pixivCookie: '', videoQuality: 'best' },
    disabled: {},
    filter: null,
    kind: null,
    counter: 1,
    coverCache: new Map(),
    coversInFlight: 0
  };

  var COVER_CONCURRENCY = 6;
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
    var results = E.sourceInfo().map(function (s) {
      return { id: s.id, label: s.label, items: App.items.filter(function (it) { return it.source === s.id; }) };
    });
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
    var wrap = document.createElement('div');
    wrap.className = 'card-wrap';
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

    var mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'bookmark';
    mark.dataset.uid = item.uid;
    mark.setAttribute('aria-label', '收藏');
    mark.title = '收藏';
    mark.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v16l-5-4-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    mark.addEventListener('click', function (e) {
      e.stopPropagation();
      openFavPop(item, mark);
    });
    wrap.appendChild(mark);
    if ((App.fav.folders || []).some(function (f) { return favHas(f.id, item.uid); })) mark.dataset.saved = 'true';
    var tools = document.createElement('div');
    tools.className = 'cover-tools';
    var openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'tool';
    openBtn.title = '在浏览器打开';
    openBtn.setAttribute('aria-label', '在浏览器打开');
    openBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 5h5v5M19 5l-8 8M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    openBtn.addEventListener('click', function (e) { e.stopPropagation(); openInBrowser(item); });
    tools.appendChild(openBtn);
    if (item.cover) {
      var save = document.createElement('button');
      save.type = 'button';
      save.className = 'tool';
      save.title = '保存封面';
      save.setAttribute('aria-label', '保存封面');
      save.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m-4-4 4 4 4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      save.addEventListener('click', function (e) { e.stopPropagation(); saveCover(item); });
      tools.appendChild(save);
    }
    wrap.appendChild(card);
    wrap.appendChild(tools);
    return wrap;
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



  function requestCover(url, img, referer) {
    if (!url) return;
    if (App.coverCache.has(url)) {
      img.src = App.coverCache.get(url);
      img.classList.add('is-in');
      return;
    }
    var job = { url: url, img: img, referer: referer || '' };
    /* Covers are the slowest part of a search: ask for one only when its card is
     * near the viewport. */
    if (typeof IntersectionObserver === 'undefined') {
      COVER_QUEUE.push(job);
      pumpCovers();
      return;
    }
    if (!App.coverObserver) {
      App.coverObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          App.coverObserver.unobserve(entry.target);
          var pending = entry.target.__coverJob;
          if (pending) {
            COVER_QUEUE.push(pending);
            pumpCovers();
          }
        });
      }, { rootMargin: '400px 0px' });
    }
    img.__coverJob = job;
    App.coverObserver.observe(img);
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

  /* The card's tick mirrors "queued here, not started yet". Once a row is
   * running (or finished), unticking the card only clears the tick — the
   * download keeps going. Removing with the row's own × still cancels it. */
  function togglePick(item, card) {
    var at = App.queue.findIndex(function (r) { return r.uid === item.uid; });
    if (at >= 0) {
      var row = App.queue[at];
      if (row.state !== 'queued') {
        card.setAttribute('aria-selected', 'false');
        return;
      }
      App.queue.splice(at, 1);
      card.setAttribute('aria-selected', 'false');
    } else {
      App.queue.push({ uid: item.uid, item: item, state: 'queued', done: 0, total: 0, msg: '' });
      card.setAttribute('aria-selected', 'true');
    }
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

  /* Drains at most `limit` unseen items of one source out of its buffer. */
  function drainPending(id, limit, fresh) {
    var pool = App.pending[id] || (App.pending[id] = []);
    var taken = 0;
    while (pool.length && taken < limit) {
      var it = pool.shift();
      if (App.seen[it.uid]) continue;
      App.seen[it.uid] = 1;
      fresh.push(it);
      taken++;
    }
    return taken;
  }

  function pendingLeft(id) {
    return (App.pending[id] || []).length;
  }

  async function runSearch(page, append, only) {
    if (App.view !== 'search') App.setView('search');
    var query = App.mode === 'text' ? $('q').value.trim() : App.query;
    if (App.scanning) return;
    App.scanning = true;
    $('more').hidden = true;
    $('blank').hidden = true;
    var active = E.sourceInfo().map(function (s) { return s.id; }).filter(function (id) { return !App.disabled[id]; });
    if (only) active = [only];
    /* With a source filter on, "more" may only advance that source. */
    if (append && App.filter) active = [App.filter];
    var limit = Math.max(1, parseInt(App.settings.perSource, 10) || 20);

    if (!append) {
      App.items = [];
      App.seen = {};
      App.pending = {};
      App.pages = {};
      App.exhausted = {};
      App.filter = null;
      App.kind = null;
    }

    /* Only sources with an empty buffer need a request; page number is per source. */
    var need = active.filter(function (id) { return !append || (!pendingLeft(id) && !App.exhausted[id]); });
    if (!need.length) {
      var drainedOnly = [];
      active.forEach(function (id) { drainPending(id, limit, drainedOnly); });
      App.items = App.items.concat(drainedOnly);
      renderItems(true);
      renderFilters();
      $('more').hidden = !active.some(function (id) { return pendingLeft(id) || !App.exhausted[id]; }) || App.items.length < 8;
      App.scanning = false;
      return;
    }

    var pages = {};
    need.forEach(function (id) {
      pages[id] = append ? (App.pages[id] || 1) + 1 : 1;
      setSiteState(id, 'busy', 0);
    });
    $('tally').textContent = '检索中';

    try {
      var res = await E.searchAll(ctx, { query: query, sources: need, pages: pages, limit: 0 });
      var failed = 0;
      res.results.forEach(function (r) {
        if (r.error) {
          failed++;
          setSiteState(r.id, 'error', 0);
          var siteEl = document.querySelector('.site[data-id="' + r.id + '"]');
          if (siteEl) siteEl.title = r.error;
          return;
        }
        App.pages[r.id] = pages[r.id];
        var pool = App.pending[r.id] || (App.pending[r.id] = []);
        r.items.forEach(function (it) { pool.push(it); });
        if (!r.items.length) App.exhausted[r.id] = true;
        setSiteState(r.id, r.items.length ? 'idle' : 'empty', r.items.length);
      });

      var fresh = [];
      active.forEach(function (id) {
        var before = fresh.length;
        drainPending(id, limit, fresh);
        if (append && !App.pending[id].length && fresh.length === before) {
          /* a page that only repeated what is already on screen ends the stream */
          if (pages[id]) App.exhausted[id] = true;
        }
      });
      App.items = App.items.concat(fresh);
      App.results = res;
      renderItems(true);
      renderFilters();
      var shown = App.items.length;
      $('tally').textContent = shown ? shown + (failed ? ' · ' + failed + ' 站未响应' : '') : '0';
      var more = active.some(function (id) { return pendingLeft(id) || !App.exhausted[id]; });
      $('more').hidden = shown < 8 || !more;
      if (!shown) {
        $('blank').textContent = failed
          ? '这些站点没有响应：先在设置里点“测试禁漫”，其余检查网络与 cookie。'
          : '没有命中。换一个 tag，或把底部某个站点关掉再试其它站。';
        $('blank').hidden = false;
      } else if (append && !fresh.length && !more) {
        $('tally').textContent = shown + ' · 没有更多了';
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
  /* Rule34Video publishes several renditions; honour the setting, else keep the
   * best the source offered. */
  function pickVariant(detail) {
    var want = App.settings.videoQuality || "best";
    var list = (detail && detail.variants) || [];
    if (!list.length) return null;
    if (want === "best") return list[0];
    var exact = list.filter(function (v) { return v.label === want; })[0];
    if (exact) return exact;
    var rank = function (label) { return parseInt(String(label).replace(/[^0-9]/g, ""), 10) || 0; };
    var below = list.filter(function (v) { return rank(v.label) <= rank(want); });
    return below[0] || list[list.length - 1];
  }

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

    /* PNG of a manga page runs 1.5–3 MB and every byte crosses the host IPC.
     * Over 600 KB it is re-encoded as JPEG 0.92 — a fifth of the payload, still
     * clean for line art — and the file name follows the real format. */
    var blob = await canvasToBlob(canvas, 'image/png');
    if (blob.size > 600 * 1024) {
      var jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      if (jpeg.size < blob.size) {
        blob = jpeg;
        path = path.replace(/\.png$/i, '.jpg');
      }
    }
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
        if (offset < bytes.length) await new Promise(function (r) { setTimeout(r, 24); });
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
  /* Canvas helpers. They were lost in an earlier edit that replaced a block of
   * this file wholesale; the descramble path needs both. */
  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function canvasToBlob(canvas, type, quality) {
    type = type || 'image/png';
    var opts = { type: type };
    if (quality) opts.quality = quality;
    if (canvas.convertToBlob) return canvas.convertToBlob(opts);
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }

  /* ------------------------------------------------- settings diagnostics */

  /* allowRoot → mkdirs → download → delete, with the error text kept verbatim so
   * a failing install can be diagnosed without guessing which hop broke. */
  async function testDownload() {
    var status = $('jmStatus');
    var root = ($('fields').root.value || App.settings.root || '').trim();
    var steps = [];
    if (!root) { status.textContent = '先填下载目录'; return; }
    status.textContent = '测试中…';
    try {
      await Host.invoke('fs.allowRoot', { path: root });
      steps.push('allowRoot ok');
      var dir = root.replace(/[\\/]+$/, '') + '\\_selftest';
      await Host.invoke('fs.mkdirs', { path: dir });
      steps.push('mkdirs ok');
      var got = await Host.invoke('http.download', {
        url: 'https://hentaileague.com/wp-json/',
        path: dir + '\\probe.json',
        headers: { 'User-Agent': E.currentUserAgent() },
        skipExisting: false,
        timeoutMs: 60000
      });
      steps.push('download ' + got.bytes + 'B ' + (got.contentType || ''));
      await Host.invoke('fs.delete', { path: dir }).catch(function () {});
      steps.push('清理 ok');
    } catch (err) {
      steps.push('失败：' + String(err && err.message ? err.message : err).slice(0, 120));
    }
    status.textContent = steps.join(' · ');
  }

  /* The host opens an isolated window, lets the user pass the challenge, and
   * hands back the cookies for the declared domain with the same User-Agent the
   * engine uses afterwards (cf_clearance is bound to UA + client IP). */
  async function passChallenge() {
    var status = $('jmStatus');
    var domain = App.settings.jmDomain || '18comic.vip';
    if (!window.NousPlugin) { status.textContent = '只有正式宿主能开校验窗口'; return; }
    status.textContent = '已打开窗口，完成站点校验后会自动保存';
    try {
      var res = await window.NousPlugin.request('runtime.webLogin', {
        url: 'https://' + domain + '/',
        domains: [domain],
        cookieUrls: ['https://' + domain + '/'],
        requiredCookies: [['cf_clearance']],
        userAgents: { 'windows-x64': E.currentUserAgent() },
        urls: { 'windows-x64': 'https://' + domain + '/' }
      }, { timeoutMs: 600000 });
      var cookie = String((res && res.cookie) || '');
      if (!cookie) throw new Error('E_AUTH: 没有取到 Cookie');
      App.settings.jmCookie = cookie;
      $('fields').jmCookie.value = cookie;
      await saveSettings();
      await Host.invoke('cookie.set', { host: domain, cookie: cookie }).catch(function () {});
      await Host.invoke('cookie.set', { host: '.' + domain, cookie: cookie }).catch(function () {});
      var check = await ctx.get('https://' + domain + '/', { headers: E.baseHeaders('https://' + domain + '/', true) });
      var ok = !E.getSource('jm').challengeCheck(check.body) && check.status < 400;
      status.textContent = '已保存 ' + cookie.split(';').length + ' 项 · 复检 ' + check.status + '/' + check.body.length + 'B' + (ok ? '·通过' : '·仍被拦');
    } catch (err) {
      status.textContent = String(err && err.message ? err.message : err).slice(0, 80);
    }
  }

  /* One line the user can paste back: home, search, the first album's chapters,
   * the cookies the jar holds and the User-Agent in use. */
  async function probeJm() {
    var status = $('jmStatus');
    var domain = App.settings.jmDomain || '18comic.vip';
    var base = 'https://' + domain;
    var spec = E.getSource('jm');
    var lines = [];
    status.textContent = '测试中…';
    try {
      var home = await ctx.get(base + '/', { headers: E.baseHeaders(base + '/', true) });
      lines.push('首页 ' + home.status + '/' + home.body.length + 'B' + (spec.challengeCheck(home.body) ? '·质询' : '·正常'));
      var q = $('q').value.trim() || 'test';
      var search = await ctx.get(base + '/search/photos?' + [
        'search_query=' + encodeURIComponent(q), 'page=1', 'main_tag=0', 'o=mr', 't=a'
      ].join('&'), { headers: E.baseHeaders(base + '/', true) });
      var cards = spec.parseCards(spec.unwrap(search.body), base);
      lines.push('检索 "' + q + '" ' + search.status + '/' + search.body.length + 'B/' + cards.length + '条' +
        (spec.challengeCheck(search.body) ? '·质询' : ''));
      if (cards.length) {
        var first = cards[0];
        var album = await ctx.get(first.url, { headers: E.baseHeaders(base + '/', true) });
        var body = spec.unwrap(album.body);
        var meta = E.parsers.jmAlbumMeta(body);
        lines.push('本子 ' + first.id + ' ' + album.status + '/' + body.length + 'B · 章节 ' + meta.chapters.length +
          ' · 页数 ' + (meta.count || 0) + ' · scramble ' + (meta.scrambleId || '—'));
      }
      var jar = await Host.invoke('cookie.list', {});
      var hosts = (jar && jar.hosts) || {};
      var named = Object.keys(hosts).map(function (h) {
        var names = String(hosts[h] || '').split(';').map(function (p) { return p.split('=')[0].trim(); }).filter(Boolean);
        return h + ':' + (names.join('/') || '空');
      });
      lines.push('Cookie ' + (named.length ? named.join(' , ') : '空'));
      lines.push('UA ' + E.currentUserAgent().slice(0, 48));
    } catch (err) {
      lines.push('错误 ' + String(err && err.message ? err.message : err).slice(0, 70));
    }
    status.textContent = lines.join(' · ');
  }


  /* Pixiv's R-18 works are not a URL problem: the site hides them from anyone
   * whose session has not enabled "R-18" in the account's viewing settings. The
   * host window lets the user log in and turn that on, then hands back the
   * session cookie; the same window uses the User-Agent the engine sends. */
  async function passPixivLogin() {
    var status = $('pixivStatus');
    if (!window.NousPlugin) { status.textContent = '只有正式宿主能开登录窗口'; return; }
    status.textContent = '窗口已打开：登录完成后它会自动关闭（以 pixiv 返回的登录态为准），随后请确认 R-18 是否已开启';
    try {
      var res = await window.NousPlugin.request('runtime.webLogin', {
        url: 'https://www.pixiv.net/',
        domains: ['pixiv.net', 'www.pixiv.net'],
        cookieUrls: ['https://www.pixiv.net/', 'https://www.pixiv.net/setting_user.php'],
        requiredCookies: [['PHPSESSID']],
        // /ajax/user/self answers {"userData":null} until the account is really
        // signed in; the host keeps the window open until this check passes.
        validation: {
          url: 'https://www.pixiv.net/ajax/user/self',
          path: 'userData',
          nonEmpty: true,
          userAgent: E.currentUserAgent()
        },
        userAgents: { 'windows-x64': E.currentUserAgent() },
        urls: { 'windows-x64': 'https://www.pixiv.net/' }
      }, { timeoutMs: 600000 });
      var cookie = String((res && res.cookie) || '');
      if (!cookie) throw new Error('E_AUTH: 没有取到 Cookie');
      App.settings.pixivCookie = cookie;
      $('fields').pixivCookie.value = cookie;
      await saveSettings();
      var hosts = ['pixiv.net', '.pixiv.net', 'www.pixiv.net'];
      for (var i = 0; i < hosts.length; i++) {
        await Host.invoke('cookie.set', { host: hosts[i], cookie: cookie }).catch(function () {});
      }
      var self = await pixivSelf();
      if (!self) {
        status.textContent = '窗口在登录前就关闭了（本次是匿名会话）。请改用：浏览器登录 pixiv → 复制 PHPSESSID → 粘到上方输入框 → 保存设置';
        return;
      }
      status.textContent = '已登录 ' + self + ' · ' + await pixivR18State();
    } catch (err) {
      status.textContent = String(err && err.message ? err.message : err).slice(0, 90);
    }
  }


  /* Who is signed in, if anyone: /ajax/user/self answers {userData:null} for an
   * anonymous session, and an object with userId once logged in. */
  async function pixivSelf() {
    try {
      var r = await ctx.get('https://www.pixiv.net/ajax/user/self', { headers: E.getSource('pixiv').headers() });
      var json = JSON.parse(r.body);
      var user = json && json.userData;
      if (!user) return '';
      return user.pixivId ? ('pixivId ' + user.pixivId) : ('userId ' + (user.userId || ''));
    } catch (err) {
      return '';
    }
  }

  /* One R-18 query tells whether the account may actually see such works. */
  async function pixivR18State() {
    try {
      var url = 'https://www.pixiv.net/ajax/search/artworks/%E3%83%86%E3%82%B9%E3%83%88?' + [
        'word=' + encodeURIComponent('テスト'), 'p=1', 'lang=zh', 'mode=r18'
      ].join('&');
      var r = await ctx.get(url, { headers: E.getSource('pixiv').headers() });
      var json = JSON.parse(r.body);
      var list = ((json.body && json.body.illustManga) || {}).data || [];
      var r18 = list.filter(function (it) { return String(it.xRestrict) !== '0'; }).length;
      return r18 > 0 ? ('R-18 已开启（本次检索 ' + r18 + ' 条）') : '账号似乎未开启 R-18 显示（检索 0 条）';
    } catch (err) {
      return 'R-18 状态未知';
    }
  }


  /* Saves one cover next to the downloads: <root>\\_covers\\<source>-<id>.<ext>. */
  async function saveCover(item) {
    try {
      var root = await ensureRoot();
      var dir = root.replace(/[\\/]+$/, '') + '\\_covers';
      await Host.invoke('fs.mkdirs', { path: dir });
      var ext = E.extensionOf(item.cover, 'jpg');
      var name = E.safeName(item.source + '-' + item.id, 40) + '.' + ext;
      var got = await Host.invoke('http.download', {
        url: item.cover,
        path: dir + '\\' + name,
        headers: { 'User-Agent': E.currentUserAgent(), Referer: item.url || '' },
        skipExisting: false,
        timeoutMs: 60000
      });
      toast('封面已保存 ' + name + '（' + Math.round(got.bytes / 1024) + ' KB）');
    } catch (err) {
      toast('封面保存失败：' + String(err && err.message ? err.message : err).slice(0, 70));
    }
  }

  /* Hands the resource page to the system browser; the host refuses anything
   * that is not https, which every source is. */
  function openInBrowser(item) {
    var url = item && item.url;
    if (!url) { toast("这条没有可打开的链接"); return; }
    if (!window.NousPlugin) { toast("只有正式宿主能打开浏览器"); return; }
    window.NousPlugin.request("external.open", { url: url })
      .catch(function (err) { toast("打开失败：" + String(err && err.message ? err.message : err).slice(0, 60)); });
  }

  function toast(message) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function commitRoot(path) {
    App.settings.root = path;
    var form = $('fields');
    if (form) form.root.value = path;
    Host.invoke('fs.allowRoot', { path: path }).catch(function () {});
    saveSettings();
    renderQueue();
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
      var plan = null;
      try {
        var spec = E.getSource(row.item.source);
        var detail = await spec.detail(ctx, row.item.raw);
        plan = E.planExport(row.item, {
          root: root, index: App.counter, width: App.settings.width, pages: detail.pages
        });
        if (!plan.files.length) throw new Error('解析到 0 页：' + (detail.count ? '站点说有 ' + detail.count + ' 页但没取到图' : '章节里没有可用图片'));
        row.total = plan.files.length;
        row.done = 0;
        renderQueue();
        await Host.invoke('fs.mkdirs', { path: plan.dir });
        for (var f = 0; f < plan.files.length; f++) {
          if (row.cancelled) throw { cancelled: true };
          var file = plan.files[f];
          await downloadPage(file, plan.dir, row.item.url, detail.pages[f]);
          row.done = f + 1;
          renderQueue();
        }
        if (row.cancelled) throw { cancelled: true };
        row.state = 'done';
        if (App.queue.indexOf(row) < 0) continue; // removed while running
        App.counter += 1;
        await Host.store('storage.set', { key: 'counter', value: App.counter });
        await Host.store('storage.set', {
          key: 'library.' + App.counter,
          value: { title: row.item.title, source: row.item.source, dir: plan.dir, pages: plan.files.length, at: Date.now() }
        }).catch(function () {});
      } catch (err) {
        if ((err && err.cancelled) || row.cancelled) {
          /* Cancelled from the card while running: drop the half-written folder
           * and leave no counter step or library record behind. */
          row.state = 'cancelled';
          await Host.invoke('fs.delete', { path: plan ? plan.dir : '' }).catch(function () {});
          reportError(row.item.title, '已取消，未写入记录');
        } else {
          row.state = 'failed';
          row.msg = String(err && err.message ? err.message : err);
          reportError(row.item.title, row.msg);
        }
      }
      renderQueue();
    }
    $('start').disabled = false;
  }


  /* ------------------------------------------------------------ favourites */

  /* A folder is a name and an id; an item is a compact snapshot, because the
   * plugin storage is a single JSON value with a modest cap. Videos keep their
   * page url so they can still be downloaded straight from a folder. */
  var FAV_KEY = 'fav';
  var FAV_LIMIT = 200;

  function favDefault() { return { folders: [], items: {}, active: '' }; }

  function favLoad() {
    App.fav = App.fav || favDefault();
    Host.store('storage.get', { key: FAV_KEY }).then(function (value) {
      if (value && typeof value === 'object' && Array.isArray(value.folders)) {
        App.fav = value;
        if (!App.fav.items) App.fav.items = {};
        renderFavs();
      }
    }).catch(function () {});
  }

  function favSave() {
    return Host.store('storage.set', { key: FAV_KEY, value: App.fav }).catch(function () {});
  }

  function favCount(folderId) {
    return ((App.fav.items || {})[folderId] || []).length;
  }

  function favTotal() {
    var total = 0;
    Object.keys(App.fav.items || {}).forEach(function (k) { total += App.fav.items[k].length; });
    return total;
  }

  function favSnapshot(item) {
    var snap = {
      uid: item.uid, source: item.source, sourceLabel: item.sourceLabel,
      id: item.id, title: String(item.title || '').slice(0, 90),
      author: String(item.author || '').slice(0, 40),
      cover: item.cover || '', kind: item.kind, url: item.url || '',
      pages: item.kind === 'video' && item.raw && item.raw.pages ? item.raw.pages.slice(0, 1) : []
    };
    return snap;
  }

  function favHas(folderId, uid) {
    return ((App.fav.items || {})[folderId] || []).some(function (it) { return it.uid === uid; });
  }

  function favAdd(item, folderId) {
    var list = App.fav.items[folderId] || (App.fav.items[folderId] = []);
    if (list.some(function (it) { return it.uid === item.uid; })) return false;
    if (favTotal() >= FAV_LIMIT) { toast('收藏已满 ' + FAV_LIMIT + ' 项'); return false; }
    list.unshift(favSnapshot(item));
    favSave();
    renderFavs();
    return true;
  }

  function favRemove(folderId, uid) {
    App.fav.items[folderId] = (App.fav.items[folderId] || []).filter(function (it) { return it.uid !== uid; });
    favSave();
    renderFavs();
    paintBookmarks();
  }

  function favCreate(name) {
    var clean = String(name || '').trim();
    if (!clean) return null;
    var folder = { id: 'f' + Date.now().toString(36), name: clean.slice(0, 24), at: Date.now() };
    App.fav.folders.push(folder);
    App.fav.items[folder.id] = [];
    favSave();
    renderFavs();
    return folder;
  }

  function favRenameFolder(folderId, name) {
    var clean = String(name || '').trim().slice(0, 24);
    var folder = favFolder(folderId);
    if (!folder || !clean) return false;
    folder.name = clean;
    favSave();
    renderFavs();
    return true;
  }

  function favDeleteFolder(folderId) {
    App.fav.folders = (App.fav.folders || []).filter(function (f) { return f.id !== folderId; });
    if (App.fav.items) delete App.fav.items[folderId];
    if (App.fav.active === folderId) {
      App.fav.active = App.fav.folders.length ? App.fav.folders[0].id : '';
    }
    favSave();
    renderFavs();
    paintBookmarks();
  }

  function favFolder(folderId) {
    return (App.fav.folders || []).filter(function (f) { return f.id === folderId; })[0] || null;
  }

  function paintBookmarks() {
    document.querySelectorAll('.bookmark').forEach(function (btn) {
      var uid = btn.dataset.uid;
      var saved = (App.fav.folders || []).some(function (f) { return favHas(f.id, uid); });
      btn.setAttribute('data-saved', String(saved));
    });
  }

  var favPopItem = null;

  function openFavPop(item, anchor) {
    var pop = $('favPop');
    favPopItem = item;
    var list = $('favPopList');
    list.textContent = '';
    var folders = App.fav.folders || [];
    if (!folders.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '还没有收藏夹，先建一个';
      list.appendChild(empty);
    }
    folders.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<span class="t"></span><span class="n"></span>';
      b.querySelector('.t').textContent = f.name;
      b.querySelector('.n').textContent = favHas(f.id, item.uid) ? '已收藏' : String(favCount(f.id));
      b.addEventListener('click', function () {
        if (favHas(f.id, item.uid)) favRemove(f.id, item.uid);
        else if (favAdd(item, f.id)) toast('已收藏到「' + f.name + '」');
        paintBookmarks();
        pop.hidden = true;
      });
      list.appendChild(b);
    });
    var rect = anchor.getBoundingClientRect();
    pop.hidden = false;
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 244)) + 'px';
    pop.style.top = Math.min(rect.bottom + 6, window.innerHeight - 260) + 'px';
    $('favNewName').value = '';
  }

  function renderFavs() {
    var bar = $('favFolders');
    var grid = $('favGrid');
    var blank = $('favBlank');
    var tools = $('favTools');
    if (!bar || !grid) return;
    var folders = App.fav.folders || [];
    if (!folders.length) App.fav.active = '';
    else if (!favFolder(App.fav.active)) App.fav.active = folders[0].id;

    bar.textContent = '';
    folders.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(App.fav.active === f.id));
      b.innerHTML = '<span class="t"></span><span class="n"></span>';
      b.querySelector('.t').textContent = f.name;
      b.querySelector('.n').textContent = String(favCount(f.id));
      b.addEventListener('click', function () {
        App.fav.active = f.id;
        $('favEditWrap').hidden = true;
        favSave();
        renderFavs();
      });
      bar.appendChild(b);
    });

    if (tools) tools.hidden = !folders.length;

    grid.textContent = '';
    var list = (App.fav.items || {})[App.fav.active] || [];
    list.forEach(function (snap) {
      var cell = document.createElement('div');
      cell.className = 'favcard';
      var shot = document.createElement('span');
      shot.className = 'shot';
      var img = document.createElement('img');
      img.alt = '';
      shot.appendChild(img);
      var meta = document.createElement('p');
      meta.className = 'by';
      var nameEl = document.createElement('strong');
      nameEl.textContent = snap.title;
      var srcEl = document.createElement('span');
      srcEl.textContent = snap.sourceLabel + (snap.kind === 'video' ? ' · 视频' : '');
      meta.appendChild(nameEl);
      meta.appendChild(srcEl);
      var row = document.createElement('div');
      row.className = 'row';
      var pull = document.createElement('button');
      pull.type = 'button';
      pull.textContent = '加入队列';
      pull.addEventListener('click', function () {
        if (isQueued(snap.uid)) { toast('已经在队列里'); return; }
        App.queue.push({ uid: snap.uid, item: favToItem(snap), state: 'queued', done: 0, total: 0, msg: '' });
        renderQueue();
        toast('已加入下载队列');
      });
      var openFav = document.createElement('button');
      openFav.type = 'button';
      openFav.textContent = '打开';
      openFav.addEventListener('click', function () { openInBrowser({ url: snap.url }); });
      var drop = document.createElement('button');
      drop.type = 'button';
      drop.textContent = '移除';
      drop.addEventListener('click', function () { favRemove(App.fav.active, snap.uid); });
      row.appendChild(pull);
      row.appendChild(openFav);
      row.appendChild(drop);
      cell.appendChild(shot);
      cell.appendChild(meta);
      cell.appendChild(row);
      grid.appendChild(cell);
      requestCover(snap.cover, img, snap.url);
    });

    blank.hidden = list.length > 0 || !folders.length;
    if (!folders.length) blank.textContent = '还没有收藏夹。用上面的输入框建一个，再回搜索页点卡片左上角的书签。';
    else if (!list.length) blank.textContent = '这个收藏夹还是空的。回到搜索页，点卡片左上角的书签即可收藏。';
    if (App.view === 'favs') paintBookmarks();
  }


  function favToItem(snap) {
    return {
      uid: snap.uid, source: snap.source, sourceLabel: snap.sourceLabel, id: snap.id,
      title: snap.title, author: snap.author, tags: [], cover: snap.cover, kind: snap.kind,
      pages: (snap.pages || []).length, duration: '', url: snap.url,
      raw: { id: snap.id, url: snap.url, title: snap.title, cover: snap.cover, author: snap.author, tags: [], pages: snap.pages || [], extra: {} }
    };
  }

  /* ---------------------------------------------------------- image mode */

  /* A dropped screenshot can be several megabytes, and the host refuses a
   * request over 1 MiB — the image travels inside one. So it is re-encoded in
   * the page: longest side 1024, JPEG, quality stepped down until the payload
   * fits. This also converts WebP/AVIF into a format both lookup services read. */
  async function prepareQueryImage(file) {
    var bitmap = await createImageBitmap(file);
    var budget = 700 * 1024;
    var maxSide = 1024;
    var quality = 0.9;
    var blob = null;
    for (var attempt = 0; attempt < 6; attempt++) {
      var scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      var w = Math.max(1, Math.round(bitmap.width * scale));
      var h = Math.max(1, Math.round(bitmap.height * scale));
      var canvas = makeCanvas(w, h);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      blob = await canvasToBlob(canvas, 'image/jpeg', quality);
      if (blob.size <= budget) break;
      if (quality > 0.55) quality -= 0.15;
      else maxSide = Math.max(320, Math.round(maxSide * 0.75));
    }
    if (bitmap.close) bitmap.close();
    var buf = await blob.arrayBuffer();
    return { imageBytes: Array.prototype.slice.call(new Uint8Array(buf)), mime: 'image/jpeg', ext: 'jpg', bytes: blob.size };
  }

  async function identify(file) {
    var matches = $('matches');
    matches.textContent = '';
    var hint = $('hint');
    hint.textContent = '识别中';
    try {
      var prep = await prepareQueryImage(file);
      var found = await E.identifyImage(ctx, {
        imageBytes: prep.imageBytes,
        mime: prep.mime,
        ext: prep.ext,
        apiKey: App.settings.sauce,
        minSimilarity: 50
      });
      hint.textContent = found.length
        ? '挑一条回灌关键词（' + Math.round(prep.bytes / 1024) + ' KB 已缩放）'
        : (App.settings.sauce ? '没有足够相似的结果' : '未配置 SauceNAO API Key，IQDB 也没有可用结果');
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
    form.perSource.value = String(App.settings.perSource || 20);
    form.videoQuality.value = App.settings.videoQuality || 'best';
    form.pixivCookie.value = App.settings.pixivCookie || '';
  }

  function setView(view) {
    App.view = view === 'settings' ? 'settings' : (view === 'favs' ? 'favs' : 'search');
    if (App.view === 'favs') renderFavs();
    $('settings').hidden = App.view !== 'settings';
    if ($('favs')) $('favs').hidden = App.view !== 'favs';
    document.querySelector('.shell').hidden = App.view === 'settings' || App.view === 'favs';
    document.querySelector('.sites-wrap').hidden = App.view === 'settings' || App.view === 'favs';
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
    $('more').addEventListener('click', function () { runSearch(null, true); });
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
    if ($('favAddFolder')) {
      $('favAddFolder').addEventListener('click', function () {
        var folder = favCreate($('favFolderName').value);
        if (!folder) return;
        App.fav.active = folder.id;
        $('favFolderName').value = '';
        favSave();
        renderFavs();
        toast('已建立「' + folder.name + '」');
      });
      $('favFolderName').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('favAddFolder').click(); }
      });
      $('favRename').addEventListener('click', function () {
        var folder = favFolder(App.fav.active);
        if (!folder) return;
        $('favEditName').value = folder.name;
        $('favEditWrap').hidden = false;
        $('favEditName').focus();
      });
      $('favEditSave').addEventListener('click', function () {
        if (favRenameFolder(App.fav.active, $('favEditName').value)) {
          $('favEditWrap').hidden = true;
          toast('已重命名');
        }
      });
      $('favEditCancel').addEventListener('click', function () { $('favEditWrap').hidden = true; });
      $('favEditName').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); $('favEditSave').click(); }
      });
      var armed = 0;
      $('favDelete').addEventListener('click', function () {
        var folder = favFolder(App.fav.active);
        if (!folder) return;
        if (Date.now() - armed > 3000) {
          armed = Date.now();
          $('favDelete').textContent = '确认删除「' + folder.name + '」';
          setTimeout(function () { $('favDelete').textContent = '删除收藏夹'; }, 3200);
          return;
        }
        armed = 0;
        $('favDelete').textContent = '删除收藏夹';
        favDeleteFolder(folder.id);
        toast('已删除收藏夹');
      });
    }
    if ($('favNewBtn')) {
      $('favNewBtn').addEventListener('click', function () {
        var folder = favCreate($('favNewName').value);
        if (!folder) return;
        App.fav.active = folder.id;
        favSave();
        renderFavs();
        $('favNewName').value = '';
        if (favPopItem) { toast('已建立「' + folder.name + '」'); $('favPop').hidden = true; }
      });
    }
    document.addEventListener('click', function (e) {
      var pop = $('favPop');
      if (!pop || pop.hidden) return;
      if (pop.contains(e.target) || (e.target.closest && e.target.closest('.bookmark'))) return;
      pop.hidden = true;
    });
    if ($('jmProbe')) $('jmProbe').addEventListener('click', probeJm);
    if ($('pixivOpen')) {
      $('pixivOpen').addEventListener('click', function () {
        window.NousPlugin.request('external.open', { url: 'https://www.pixiv.net/setting_user.php' })
          .catch(function () { toast('\u6d4f\u89c8\u5668\u6ca1\u80fd\u6253\u5f00'); });
      });
    }
    if ($('pixivLogin')) {
      if (window.NousPlugin) $('pixivLogin').addEventListener('click', passPixivLogin);
      else $('pixivLogin').hidden = true;
    }
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
      App.settings.perSource = Math.min(60, Math.max(4, parseInt(form.perSource.value, 10) || 20));
      App.settings.videoQuality = form.videoQuality.value || 'best';
      App.settings.pixivCookie = form.pixivCookie.value.trim();
      if (App.settings.pixivCookie) {
        var pxHosts = ['pixiv.net', '.pixiv.net', 'www.pixiv.net'];
        for (var pi = 0; pi < pxHosts.length; pi++) {
          await Host.invoke('cookie.set', { host: pxHosts[pi], cookie: App.settings.pixivCookie }).catch(function () {});
        }
      }
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
    if (!window.DawnEngine) {
      $('blank').hidden = false;
      $('blank').textContent = '引擎脚本没加载：ui/engine.js 缺失或被截断，请重装插件。';
      return;
    }
    try {
      renderSites();
      renderGhosts();
      bind();
      renderQueue();
      setMode('text');
    } catch (err) {
      $('blank').hidden = false;
      $('blank').textContent = '页面初始化失败：' + String(err && err.message ? err.message : err);
      return;
    }
    try {
      await Host.ready;
      await loadState();
      E.setUserAgent(App.settings.ua || '');
      renderQueue();
      favLoad();
      if (App.settings.root) {
        await Host.invoke('fs.allowRoot', { path: App.settings.root }).catch(function () {});
      }
      try {
        var info = await Host.invoke('engine.info', {});
        App.engineVersion = info && info.version ? info.version : '';
        App.dataRoot = info && info.dataRoot ? info.dataRoot : '';
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
