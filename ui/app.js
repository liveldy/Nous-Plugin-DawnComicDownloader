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
    }
  };

  Host.ready = (async function () {
    if (Demo) {
      document.documentElement.dataset.theme = Demo.theme || 'light';
      return { invoke: Demo.invoke, plugin: { theme: Demo.theme || 'light' }, demo: true };
    }
    if (!window.NousPlugin) throw new Error('E_HOST: 缺少宿主桥');
    var ctx = await window.NousPlugin.ready;
    document.documentElement.dataset.theme = ctx.theme === 'dark' ? 'dark' : 'light';
    window.NousPlugin.on('theme.changed', function (t) {
      document.documentElement.dataset.theme = t === 'dark' ? 'dark' : 'light';
    });
    window.NousPlugin.on('navigation.changed', function (view) { App.setView(view); });
    return {
      invoke: function (method, params) {
        return window.NousPlugin.request('runtime.invoke', { method: method, params: params || {} }, { timeoutMs: 120000 });
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
    settings: { root: '', sauce: '', width: 3, start: 1, jmCookie: '' },
    disabled: {},
    counter: 1,
    coverCache: new Map(),
    coversInFlight: 0
  };

  var COVER_CONCURRENCY = 4;
  var COVER_QUEUE = [];

  /* ------------------------------------------------------------ storage */

  async function loadState() {
    try {
      var s = await Host.invoke('storage.get', { key: 'settings' });
      if (s && typeof s === 'object') App.settings = Object.assign(App.settings, s);
    } catch (e) { /* first run */ }
    try {
      var c = await Host.invoke('storage.get', { key: 'counter' });
      if (c && typeof c === 'number') App.counter = c;
    } catch (e) { /* first run */ }
    try {
      var d = await Host.invoke('storage.get', { key: 'disabled' });
      if (d && typeof d === 'object') App.disabled = d;
    } catch (e) { /* first run */ }
  }

  function saveSettings() {
    return Host.invoke('storage.set', { key: 'settings', value: App.settings }).catch(function () {});
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
        Host.invoke('storage.set', { key: 'disabled', value: App.disabled }).catch(function () {});
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
    requestCover(item.cover, card.querySelector('img'));
    return card;
  }

  function renderItems(reset) {
    var grid = $('grid');
    if (reset) grid.textContent = '';
    App.items.forEach(function (item, i) { grid.appendChild(makeCard(item, i)); });
    document.documentElement.dataset.hasResults = App.items.length ? 'true' : 'false';
  }

  function appendItems(list) {
    var grid = $('grid');
    var base = App.items.length - list.length;
    list.forEach(function (item, i) { grid.appendChild(makeCard(item, base + i)); });
    if (!base) document.documentElement.dataset.hasResults = 'true';
  }

  function requestCover(url, img) {
    if (!url) return;
    if (App.coverCache.has(url)) {
      img.src = App.coverCache.get(url);
      img.classList.add('is-in');
      return;
    }
    COVER_QUEUE.push({ url: url, img: img });
    pumpCovers();
  }

  function pumpCovers() {
    while (App.coversInFlight < COVER_CONCURRENCY && COVER_QUEUE.length) {
      var job = COVER_QUEUE.shift();
      App.coversInFlight++;
      (async function (j) {
        try {
          var r = await Host.invoke('image.proxy', { url: j.url, maxBytes: 1400000 });
          if (!r || !r.dataUrl) return;
          App.coverCache.set(j.url, r.dataUrl);
          j.img.src = r.dataUrl;
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
      App.results = res;
      renderItems(!append);
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
        row.total = plan.files.length;
        row.done = 0;
        renderQueue();
        await Host.invoke('fs.mkdirs', { path: plan.dir });
        for (var f = 0; f < plan.files.length; f++) {
          var file = plan.files[f];
          await Host.invoke('http.download', {
            url: file.url,
            path: plan.dir + '\\' + file.name,
            headers: { 'User-Agent': E.UA, Referer: row.item.url },
            skipExisting: true,
            timeoutMs: 120000
          });
          row.done = f + 1;
          renderQueue();
        }
        row.state = 'done';
        App.counter += 1;
        await Host.invoke('storage.set', { key: 'counter', value: App.counter });
        await Host.invoke('storage.set', {
          key: 'library.' + App.counter,
          value: { title: row.item.title, source: row.item.source, dir: plan.dir, pages: plan.files.length, at: Date.now() }
        }).catch(function () {});
      } catch (err) {
        row.state = 'failed';
        row.msg = String(err && err.message ? err.message : err).slice(0, 60);
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
  }

  function setView(view) {
    App.view = view === 'settings' ? 'settings' : 'search';
    $('settings').hidden = App.view !== 'settings';
    document.querySelector('.shell').hidden = App.view === 'settings';
    document.querySelector('.sites-wrap').hidden = App.view === 'settings';
    if (App.view === 'settings') fillSettings();
  }

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
    $('fields').addEventListener('submit', async function (e) {
      e.preventDefault();
      var form = e.target;
      App.settings.root = form.root.value.trim();
      App.settings.sauce = form.sauce.value.trim();
      App.settings.width = Math.min(5, Math.max(2, parseInt(form.width.value, 10) || 3));
      App.settings.jmCookie = form.jmCookie.value.trim();
      var start = Math.max(1, parseInt(form.start.value, 10) || 1);
      App.counter = start;
      await saveSettings();
      await Host.invoke('storage.set', { key: 'counter', value: App.counter }).catch(function () {});
      if (App.settings.jmCookie) {
        await Host.invoke('cookie.set', { host: '18comic.vip', cookie: App.settings.jmCookie }).catch(function () {});
        await Host.invoke('cookie.set', { host: '.18comic.vip', cookie: App.settings.jmCookie }).catch(function () {});
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
      renderQueue();
      var view = (await Host.ready).plugin && (await Host.ready).plugin.view;
      setView(view || 'search');
    } catch (e) {
      $('blank').hidden = false;
      $('blank').textContent = '原生引擎未就绪：' + String(e && e.message ? e.message : e);
      $('tally').textContent = '—';
    }
  })();
})();
