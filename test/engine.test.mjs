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

test('six sources are registered with their capability flags', () => {
  const info = engine.sourceInfo();
  assert.deepEqual(info.map(s => s.id), ['niacg', 'ahri', 'jm', 'hentaileague', 'rule34us', 'r34video']);
  const byId = Object.fromEntries(info.map(s => [s.id, s]));
  assert.equal(byId.niacg.caps.text, true);
  assert.equal(byId.ahri.caps.text, false, 'ahri-gallery has no server-side text search');
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
