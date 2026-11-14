/* Parser contract tests. Fixtures are real responses captured from each site
 * (see docs/research.md); no network is used here.
 *   node --test test/
 * MIT. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const engine = require('../ui/engine.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = name => readFile(path.join(here, 'fixtures', name), 'utf8');

test('seven sources are registered with their capability flags', () => {
  const info = engine.sourceInfo();
  assert.deepEqual(info.map(s => s.id), ['niacg', 'ahri', 'jm', 'pixiv', 'hentaileague', 'rule34us', 'r34video']);
  const byId = Object.fromEntries(info.map(s => [s.id, s]));
  assert.equal(byId.niacg.caps.text, true);
  assert.equal(byId.ahri.caps.text, true, 'ahri-gallery searches through search_key');
  assert.equal(byId.jm.challenge, true, '18comic needs a Cloudflare clearance cookie');
  assert.equal(byId.r34video.kind, 'video');
  assert.equal(byId.hentaileague.kind, 'video');
});

test('niacg list yields 60 distinct albums with covers and titles', async () => {
  const html = await fixture('niacg-list.html');
  const items = engine.parsers.niacgCards(html);
  assert.equal(items.length, 60);
  const first = items[0];
  assert.match(first.url, /^https:\/\/www\.niacg\.com\/moehome-\d+-\d+\.html$/);
  assert.match(first.id, /^\d+$/);
  assert.match(first.cover, /^https:\/\//);
  assert.ok(first.title.length > 3);
  assert.equal(new Set(items.map(i => i.id)).size, items.length);
});

test('niacg reader returns pages in reading order', async () => {
  const html = await fixture('niacg-reader.html');
  const pages = engine.parsers.niacgPages(html);
  assert.ok(pages.length >= 12, `expected a 12+ page gallery, got ${pages.length}`);
  const order = pages.map(p => parseInt(/(\d+)_[0-9a-f]+\.\w+$/.exec(p.url)[1], 10));
  assert.deepEqual(order, order.slice().sort((a, b) => a - b));
  assert.ok(pages.every(p => /xunge\.cyou\/hen\//.test(p.url)), 'recommendation tiles must not leak in');
});

test('niacg detail exposes author and works', async () => {
  const html = await fixture('niacg-detail.html');
  const meta = engine.parsers.niacgMeta(html);
  assert.equal(meta.title, '[氏とろん] プールの臨時コーチ');
  assert.equal(meta.author, 'citron');
  assert.ok(meta.tags.includes('原创'));
});

test('ahri list yields 100 album cards with numeric ids', async () => {
  const html = await fixture('ahri-list.html');
  const items = engine.parsers.ahriCards(html);
  assert.equal(items.length, 100, '8 of the 108 slots are promo tiles without an album id');
  assert.match(items[0].url, /route=comic\/article&comic_id=\d+&c_id=[0-9a-f]+$/);
  assert.ok(items[0].title.includes('FANBOX'));
  assert.match(items[0].cover, /^https:\/\/c2\./);
});

test('ahri reader rebuilds page URLs from IMAGE_SERVER + IMAGE_FOLDER + Image_List', async () => {
  const html = await fixture('ahri-reader.html');
  const pages = engine.parsers.ahriPages(html);
  assert.ok(pages.length >= 20, `expected 20+ pages, got ${pages.length}`);
  assert.match(pages[0].url, /^https:\/\/a\d-\d\.imghentai[\w.-]+\/image\/thumbnail\/\d+\/\d+\/1\.avif$/);
  const nums = pages.map(p => parseInt(/(\d+)\.avif$/.exec(p.url)[1], 10));
  assert.deepEqual(nums, nums.slice().sort((a, b) => a - b));
});

test('rule34 list yields posts with tag metadata', async () => {
  const html = await fixture('rule34us-list.html');
  const items = engine.parsers.rule34Cards(html);
  assert.ok(items.length >= 20, `expected 20+ posts, got ${items.length}`);
  const withTags = items.filter(i => i.tags.length >= 3);
  assert.ok(withTags.length > 10);
  assert.match(items[0].cover, /img2\.rule34\.us\/thumbnails\//);
  assert.ok(withTags[0].tags.includes('test'));
});

test('r34video list yields 24 videos with duration', async () => {
  const html = await fixture('r34video-list.html');
  const items = engine.parsers.r34videoCards(html);
  assert.equal(items.length, 24);
  assert.match(items[0].url, /^https:\/\/rule34video\.com\/video\/\d+\//);
  assert.match(items[0].extra.duration, /^\d+:\d{2}$/);
});

test('r34video detail picks the highest declared stream', async () => {
  const html = await fixture('r34video-video.html');
  const get = engine.getSource('r34video');
  const detail = await get.detail({get: async () => ({body: html, status: 200})}, {url: 'x'});
  assert.equal(detail.pages.length, 1);
  assert.match(detail.pages[0].url, /_720p\.mp4|3144627\.mp4/);
  assert.ok(detail.meta.tags.length >= 3);
});

test('hentaileague wp-json maps to a single playable file', async () => {
  const posts = JSON.parse(await fixture('hentaileague-posts.json'));
  const items = engine.parsers.hlPosts(posts);
  assert.equal(items.length, posts.length);
  assert.match(items[0].pages[0].url, /^https:\/\/hentaileague\.com\/wp-content\/uploads\/.*\.mp4$/);
  assert.match(items[0].cover, /thumb1\.jpg$/);
  assert.ok(items[0].tags.includes('Jinx'));
  assert.equal(items[0].author, 'LeagueHentai');
});

test('18comic challenge pages are detected instead of parsed as empty results', () => {
  assert.equal(engine.parsers.jmChallenge('<title>Just a moment...</title>'), true);
  assert.equal(engine.parsers.jmChallenge('<div class="album-title">x</div>'), false);
  const cards = engine.parsers.jmCards(
    '<a href="/album/123456/title-slug/" title="Album A"><div class="list-col"><img data-original="/media/album/1.jpg"></div></a>'
  );
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, '123456');
  assert.equal(cards[0].title, 'Album A');
});

test('failing sources do not take down the fan-out', async () => {
  const ctx = {
    get: async url => {
      if (url.includes('18comic')) return {status: 403, body: '<title>Just a moment...</title>'};
      if (url.includes('rule34video')) throw new Error('E_TIMEOUT: slow');
      return {status: 200, body: '', headers: {}};
    },
    post: async () => ({status: 200, body: ''})
  };
  const res = await engine.searchAll(ctx, {query: 'test', sources: ['jm', 'r34video', 'hentaileague']});
  const byId = Object.fromEntries(res.results.map(r => [r.id, r]));
  assert.equal(byId.jm.items.length, 0);
  assert.match(byId.jm.error, /E_CHALLENGE/);
  assert.match(byId.r34video.error, /E_TIMEOUT/);
  assert.ok(Array.isArray(byId.hentaileague.items));
});

test('export plan numbers folders and pages', () => {
  const plan = engine.planExport(
    {title: 'A/B: 未命名 <doujin>', kind: 'gallery'},
    {root: 'D:\\Manga', index: 7, pages: [{url: 'https://x/a.webp'}, {url: 'https://x/b.png'}]}
  );
  assert.equal(plan.folder, '007 A B 未命名 doujin');
  assert.equal(plan.dir, 'D:\\Manga\\007 A B 未命名 doujin');
  assert.deepEqual(plan.files.map(f => f.name), ['001.webp', '002.png']);
});

test('image matches become ranked text queries', () => {
  const q = engine.queriesFromMatch({title: 'プールの臨時コーチ', author: 'citron', material: 'Fate'});
  assert.deepEqual(q, ['プールの臨時コーチ', 'citron プールの臨時コーチ', 'Fate']);
});

test('multipart body is valid base64 of a well-formed part list', () => {
  const part = engine.multipart({a: '1'}, 'file', 'q.jpg', 'image/jpeg', engine.bytesToBase64(engine.asciiBytes('hello')));
  const raw = Buffer.from(part.base64, 'base64').toString('latin1');
  assert.ok(raw.includes('name="a"\r\n\r\n1\r\n'));
  assert.ok(raw.includes('filename="q.jpg"'));
  assert.ok(raw.includes('Content-Type: image/jpeg\r\n\r\nhello\r\n--'));
  assert.ok(raw.endsWith('--' + part.boundary + '--\r\n'));
});

test('base64 round-trips binary data unchanged', () => {
  const bytes = [0, 1, 2, 253, 254, 255, 128, 64];
  assert.deepEqual(engine.base64ToBytes(engine.bytesToBase64(bytes)), bytes);
});

/* ---- 18comic (HTML client ported from JMComic-Crawler-Python) ---------- */

test('md5 matches RFC 1321 vectors', () => {
  const bytes = s => engine.asciiBytes(s);
  assert.equal(engine.md5Hex(bytes('')), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(engine.md5Hex(bytes('abc')), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(engine.md5Hex(bytes('The quick brown fox jumps over the lazy dog')),
    '9e107d9d372bb6826bd81d3542a419d6');
});

test('scramble band count follows JMComic get_num', () => {
  // reference values computed with hashlib, same formula as JmImageTool.get_num
  assert.equal(engine.jmScrambleNum('', 400000, 'a.jpg'), 0, 'no scramble id means nothing to undo');
  assert.equal(engine.jmScrambleNum(220980, 100000, '00001.jpg'), 0, 'older than the id: served whole');
  assert.equal(engine.jmScrambleNum(220980, 250000, '00001.jpg'), 10);
  assert.equal(engine.jmScrambleNum(220980, 300000, '00001.jpg'), 2);
  assert.equal(engine.jmScrambleNum(220980, 500000, '00001.jpg'), 12);
  assert.equal(engine.jmScrambleNum(220980, 421926, '00002.png'), 6);
  assert.equal(engine.jmScrambleNum(0, 400000, '00001.jpg'), 16);
});

test('scramble plan tiles the page exactly once', () => {
  for (const [num, h] of [[2, 1000], [10, 1001], [12, 2048], [18, 799]]) {
    const plan = engine.jmScramblePlan(num, h);
    assert.equal(plan.length, num);
    assert.equal(plan.reduce((n, p) => n + p.h, 0), h);
    const dsts = plan.map(p => `${p.dst}:${p.h}`).join(',');
    assert.equal(dsts.split(',').length, num);
    const cover = new Array(h).fill(0);
    plan.forEach(p => { for (let y = p.dst; y < p.dst + p.h; y++) cover[y]++; });
    assert.ok(cover.every(v => v === 1), 'every output row drawn once');
    plan.forEach(p => assert.ok(p.src >= 0 && p.src + p.h <= h, 'source band inside the image'));
  }
  assert.deepEqual(engine.jmScramblePlan(0, 10), []);
});

test('18comic album page fields are read from the markup', () => {
  const html = `<h1 id="book-name">テスト本</h1>
    <meta property="og:image" content="https://cdn.example/media/cover.jpg">
    <span itemprop="author" data-type="author"><a href="/search/photos?search_query=art">作者A</a></span>
    <span itemprop="author" data-type="works"><a href="/tags/work">作品B</a></span>
    <span itemprop="genre" data-type="tags"><a href="/tags/tag">标签C</a></span>
    <span class="pagecount">頁數:32</span>
    <script>var scramble_id = 220980;</script>
    <a href="/photo/400001/">第1話</a><a href="/photo/400002/">第2話</a>`;
  const meta = engine.parsers.jmAlbumMeta(html);
  assert.equal(meta.title, 'テスト本');
  assert.deepEqual(meta.authors, ['作者A']);
  assert.deepEqual(meta.works, ['作品B']);
  assert.ok(meta.tags.includes('作品B') && meta.tags.includes('标签C'));
  assert.equal(meta.count, 32);
  assert.equal(meta.scrambleId, '220980');
  assert.deepEqual(meta.chapters, ['400001', '400002']);
});

test('18comic wraps the real markup in base64 and page images are ordered', () => {
  const inner = '<img data-original="https://cdn.example/media/photos/400001/00001.jpg">' +
    '<img data-original="https://cdn.example/media/photos/400001/00002.jpg">' +
    '<img data-original="https://cdn.example/media/albums/blank.gif">';
  const wrapped = `<script>const html = base64DecodeUtf8("${Buffer.from(inner).toString('base64')}");</script>`;
  const url = 'https://18comic.vip/photo/400001/';
  const get = engine.getSource('jm');
  const urls = engine.parsers.jmPageUrls(get.unwrap(wrapped), url);
  assert.deepEqual(urls, [
    'https://cdn.example/media/photos/400001/00001.jpg',
    'https://cdn.example/media/photos/400001/00002.jpg'
  ]);
});
test('scramble key uses the file stem, not the name with its suffix', () => {
  assert.equal(engine.jmStem('https://cdn.example/media/photos/401/00001.jpg?v=2'), '00001');
  assert.equal(engine.jmStem('00012.webp'), '00012');
  assert.equal(engine.jmStem('https://cdn.example/media/photos/401/00003'), '00003');
  assert.notEqual(
    engine.jmScrambleNum(220980, 300000, engine.jmStem('00001.jpg')),
    engine.jmScrambleNum(220980, 300000, '00001.jpg'),
    'hashing the suffix would pick the wrong band count'
  );
  assert.equal(engine.jmScrambleNum(220980, 300000, engine.jmStem('00001.jpg')), 16);
});

test('18comic cards never take a lazy placeholder as the cover', () => {
  const html =
    '<a href="/album/401/x/" title="A"><img src="/media/albums/blank.gif"><div class="album-title">A</div></a>' +
    '<a href="/album/402/y/" title="B"><img data-original="https://cdn.example/media/albums/2.jpg">' +
    '<div class="album-title">B</div></a>';
  const cards = engine.parsers.jmCards(html, 'https://18comic.vip');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].cover, '');
  assert.equal(cards[1].cover, 'https://cdn.example/media/albums/2.jpg');
});
test('ahri search uses the site\'s own search_key parameter', async () => {
  const spec = engine.getSource('ahri');
  let seen = '';
  const card = '<div class="image gallery-group col-2"><a class="apo" href="index.php?route=comic/article&comic_id=1399923&c_id=832e42a5a5224ad9a6bbaaae5b37a918">' +
    '<img src="//c2.example/image/cover/h300/b6/3c/4315208.avif"></a>' +
    '<h5 class="title"><a data-toggle="tooltip" title="[alun]2026年短篇合集"><span class="d">[alun]2026年短篇合集</span></a></h5></div>';
  const ctx = { get: async (url) => { seen = url; return { status: 200, body: card, headers: {} }; } };
  const res = await spec.search(ctx, 'alun', 2);
  assert.match(seen, /route=comic\/list/);
  assert.match(seen, /search_key=alun/);
  assert.match(seen, /page=2/);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].id, '1399923');
  assert.equal(res.items[0].title, '[alun]2026年短篇合集');
});
/* ---- Pixiv ------------------------------------------------------------- */

test('pixiv search maps the json the site returns', async () => {
  const spec = engine.getSource('pixiv');
  const raw = await fixture('pixiv-search.json');
  let seen = '';
  const ctx = { get: async (url) => { seen = url; return {status: 200, body: raw, headers: {}}; } };
  const res = await spec.search(ctx, 'test', 2);
  assert.match(seen, /\/ajax\/search\/artworks\/test/);
  assert.match(seen, /[?&]p=2\b/);
  assert.ok(res.items.length > 0);
  const first = res.items[0];
  assert.match(first.id, /^\d+$/);
  assert.equal(first.url, 'https://www.pixiv.net/artworks/' + first.id);
  assert.ok(first.title.length > 0);
  assert.ok(first.author.length > 0);
  assert.match(first.cover, /^https:\/\/i\.pximg\.net\//);
  assert.equal(res.hasMore, true, 'lastPage 10 and page 2 means more');
});

test('pixiv detail returns original pages and tag list', async () => {
  const spec = engine.getSource('pixiv');
  const detailJson = await fixture('pixiv-illust.json');
  const pagesJson = await fixture('pixiv-pages.json');
  const ctx = {
    get: async (url) => ({
      status: 200,
      body: /\/pages$/.test(url) ? pagesJson : detailJson,
      headers: {}
    })
  };
  const out = await spec.detail(ctx, {id: '152052516', title: 'x'});
  assert.ok(out.pages.length >= 1);
  assert.match(out.pages[0].url, /^https:\/\/i\.pximg\.net\/img-original\//);
  assert.ok(out.meta.title.length > 0);
  assert.ok(out.meta.tags.length > 0);
  assert.equal(out.count, out.pages.length);
});

test('pixiv reports a locked work instead of an empty album', async () => {
  const spec = engine.getSource('pixiv');
  const ctx = { get: async () => ({status: 200, body: '{"error":true,"message":"","body":[]}', headers: {}}) };
  await assert.rejects(spec.detail(ctx, {id: '1', title: 'x'}), /E_AUTH/);
});

test('pixiv drops ugoira items, which are frame archives rather than pages', () => {
  const items = engine.parsers.pixivItems([
    {id: '1', title: 'still', illustType: 0, pageCount: 2, url: 'https://i.pximg.net/a.jpg'},
    {id: '2', title: 'anim', illustType: 2, pageCount: 1, url: 'https://i.pximg.net/b.jpg'}
  ], 'https://www.pixiv.net');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '1');
});

test('image lookup uploads a multipart body through ctx.upload, not a request', async () => {
  let seen = null;
  const ctx = {
    upload: async (url, opts) => {
      seen = { url, bytes: opts.bytes.length, ctype: opts.headers['Content-Type'] };
      return {
        status: 200,
        body: JSON.stringify({ results: [{ header: { similarity: '92.1', index_id: 5 }, data: { title: 'T', author_name: 'A', ext_urls: ['https://x'] } }] })
      };
    }
  };
  const hits = await engine.identifyImage(ctx, { imageBytes: [1, 2, 3, 4, 5], mime: 'image/jpeg', ext: 'jpg', apiKey: 'k' });
  assert.match(seen.url, /saucenao\.com\/search\.php/);
  assert.ok(seen.bytes > 100, 'multipart body should carry the file bytes');
  assert.match(seen.ctype, /multipart\/form-data; boundary=/);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].similarity, 92.1);
  assert.equal(hits[0].author, 'A');
});

test('without a key the fallback says so instead of failing silently', async () => {
  const ctx = { upload: async () => ({ status: 200, body: '<html>no match</html>' }) };
  await assert.rejects(
    engine.identifyImage(ctx, { imageBytes: [1], mime: 'image/jpeg', ext: 'jpg', apiKey: '' }),
    /E_NO_KEY/
  );
});


test('searchAll gives every source its own page cursor', async () => {
  const seen = {};
  const ctx = {
    get: async (url) => {
      if (url.includes('rule34.us')) seen.r34 = url; else seen.ahri = url;
      return { status: 200, body: '', headers: {} };
    },
    post: async () => ({ status: 200, body: '', headers: {} })
  };
  await engine.searchAll(ctx, { query: 'x', sources: ['rule34us', 'ahri'], pages: { rule34us: 2, ahri: 3 } });
  assert.match(seen.r34, /pid=1\b/, 'rule34 page 2 is pid=1');
  assert.match(seen.ahri, /page=3\b/, 'ahri uses its own page number');
});

test('xpicvid search reuses the searchid url for later pages', async () => {
  const spec = engine.getSource('niacg');
  const calls = [];
  const ctx = {
    post: async () => ({ status: 200, url: 'https://www.niacg.com/e/search/result/?searchid=1550668', body: '', headers: {} }),
    get: async (url) => { calls.push(url); return { status: 200, body: '', headers: {} }; }
  };
  await spec.search(ctx, 'soul', 1);
  await spec.search(ctx, 'soul', 2);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /searchid=1550668&page=2/);
});
