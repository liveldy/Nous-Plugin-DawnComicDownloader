/* Design-preview host for DawnComicDownloader. Stands in for the Nous bridge and the native engine so
 * ui/preview.html can be shot in a plain browser. It answers from the captured
 * fixtures in test/fixtures and the covers in shots/covers — the real parsers
 * run, only the transport is local. Never packed into the plugin. */
(function () {
  'use strict';

  var COVERS = [
    '../shots/covers/c01.jpg', '../shots/covers/c05.avif', '../shots/covers/c08.jpg',
    '../shots/covers/c11.jpg', '../shots/covers/c02.jpg', '../shots/covers/c06.avif',
    '../shots/covers/c09.jpg', '../shots/covers/c12.jpg', '../shots/covers/c03.jpg',
    '../shots/covers/c07.avif', '../shots/covers/c10.jpg', '../shots/covers/c13.jpg'
  ];
  var assigned = new Map();
  var next = 0;

  function coverFor(url) {
    if (!url) return COVERS[0];
    if (assigned.has(url)) return assigned.get(url);
    if (/favicon/.test(url)) return '';
    var pick = COVERS[next++ % COVERS.length];
    assigned.set(url, pick);
    return pick;
  }

  var FIX = {
    'niacg-search': '../test/fixtures/niacg-list.html',
    'niacg-list': '../test/fixtures/niacg-list.html',
    'niacg-reader': '../test/fixtures/niacg-reader.html',
    'ahri-list': '../test/fixtures/ahri-list.html',
    'ahri-reader': '../test/fixtures/ahri-reader.html',
    'rule34-list': '../test/fixtures/rule34us-list.html',
    'rule34-post': '../test/fixtures/rule34us-post.html',
    'r34video-list': '../test/fixtures/r34video-list.html',
    'r34video-video': '../test/fixtures/r34video-video.html',
    'hentaileague': '../test/fixtures/hentaileague-posts.json'
  };
  var cache = {};

  /* design review pages keep a few items per source so the page fits a screen */
  var DEV_LIMIT = location.pathname.indexOf('preview-grid') >= 0 ? 5 : 0;
  var MARKER = {
    'niacg-list': 'class="thumb-overlay-albums"',
    'ahri-list': 'class="image gallery-group',
    'rule34-list': '<a id="',
    'r34video-list': 'class="item thumb'
  };

  function trim(html, fix) {
    var marker = MARKER[fix];
    if (!marker) return html;
    var parts = html.split(marker);
    if (parts.length <= DEV_LIMIT + 1) return html;
    var head = parts[0];
    var body = '';
    for (var i = 1; i <= DEV_LIMIT; i++) body += marker + parts[i];
    return head + body + '</div></div></body></html>';
  }

  async function fixture(name) {
    if (cache[name]) return cache[name];
    var r = await fetch(FIX[name]);
    cache[name] = await r.text();
    return cache[name];
  }

  function route(url, method) {
    if (url.indexOf('18comic') >= 0) return {status: 403, body: '<title>Just a moment...</title>'};
    if (url.indexOf('niacg.com/e/search') >= 0) return {fix: 'niacg-search', status: 200};
    if (url.indexOf('niacg.com/listinfo') >= 0) return {fix: 'niacg-list', status: 200};
    if (url.indexOf('niacg.com/moeupup') >= 0) return {fix: 'niacg-reader', status: 200};
    if (url.indexOf('niacg.com') >= 0) return {fix: 'niacg-list', status: 200};
    if (url.indexOf('ahri-gallery.com/index.php?route=comic/reader') >= 0) return {fix: 'ahri-reader', status: 200};
    if (url.indexOf('ahri-gallery.com/index.php?route=comic/article') >= 0) {
      return {fix: 'ahri-list', status: 200, injectReader: true};
    }
    if (url.indexOf('ahri-gallery.com') >= 0) return {fix: 'ahri-list', status: 200};
    if (url.indexOf('rule34.us/index.php?r=posts/view') >= 0) return {fix: 'rule34-post', status: 200};
    if (url.indexOf('rule34.us') >= 0) return {fix: 'rule34-list', status: 200};
    if (url.indexOf('rule34video.com/video/') >= 0) return {fix: 'r34video-video', status: 200};
    if (url.indexOf('rule34video.com') >= 0) return {fix: 'r34video-list', status: 200};
    if (url.indexOf('hentaileague.com/wp-json') >= 0) return {fix: 'hentaileague', status: 200};
    return {status: 200, body: ''};
  }

  window.__DAWN_DEMO__ = {
    theme: (new URLSearchParams(location.search).get('theme') || 'light'),
    invoke: async function (method, params) {
      params = params || {};
      if (method === 'image.proxy') return {dataUrl: coverFor(params.url), bytes: 1, mime: 'image/jpeg'};
      if (method === 'http.request') {
        var r = route(params.url || '', params.method || 'GET');
        var body = r.body || '';
        if (r.fix) body = await fixture(r.fix);
        if (DEV_LIMIT && r.fix) body = trim(body, r.fix);
        if (r.injectReader) {
          // the article page carries the reader credential; the demo supplies one
          body = body.replace('class="image gallery-group', 'data-demo="1" class="image gallery-group') +
            '<a href="./index.php?route=comic/reader&amp;gk_id=DEMO&amp;c_id=832e42a5a5224ad9a6bbaaae5b37a918">Read</a>';
        }
        return {status: r.status, body: body, url: params.url, headers: {'content-type': 'text/html'}};
      }
      if (method === 'storage.get') {
        if (params.key === 'counter') return 7;
        if (params.key === 'settings') return {root: 'D:\\Manga', width: 3, start: 1, sauce: '', jmCookie: ''};
        return null;
      }
      if (method === 'storage.set') return {ok: true};
      if (method === 'fs.allowRoot' || method === 'fs.mkdirs') return {path: params.path, created: false};
      if (method === 'http.download') return {path: params.path, bytes: 1024, sha256: '', status: 200, skipped: false};
      if (method === 'system.openFolder') return {opened: true};
      if (method === 'cookie.set') return {ok: true};
      return {ok: true};
    }
  };
})();
