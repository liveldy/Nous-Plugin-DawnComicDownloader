/* Live end-to-end check: page engine + built native module + a real site.
 *   node tools/verify-live.mjs [source] [query]
 * Needs the module built (`python build.py windows`) and, on a filtered
 * network, HTTPS_PROXY/HTTP_PROXY in the environment.
 * Downloads two pages of the first hit into the OS temp folder and prints
 * what landed on disk. Nothing here is packed into the plugin. */
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const engine = require('../ui/engine.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const java = path.join(root, 'build/windows-x64/runtime/bin/java.exe');
const jar = path.join(root, 'build/windows-x64/app/plugin.jar');
const source = process.argv[2] || 'rule34us';
const query = process.argv[3] || 'test';

const proc = spawn(java, ['-cp', jar, 'app.dawncomic.PluginMain'], {stdio: ['pipe', 'pipe', 'inherit']});
let buffer = '';
const pending = [];
proc.stdout.setEncoding('utf8');
proc.stdout.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    const waiting = pending.shift();
    if (!waiting) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { waiting.reject(new Error('non-JSON: ' + line.slice(0, 120))); continue; }
    if (msg.error) waiting.reject(new Error(msg.error));
    else waiting.resolve(msg.value);
  }
});

function invoke(method, params) {
  return new Promise((resolve, reject) => {
    pending.push({resolve, reject});
    proc.stdin.write(JSON.stringify({method, params: params || {}}) + '\n');
  });
}

const ctx = {
  get: async (url, opts = {}) => {
    const r = await invoke('http.request', {url, method: 'GET', headers: opts.headers || {}, timeoutMs: opts.timeoutMs || 30000});
    return {status: r.status, body: r.body || '', url: r.url, headers: r.headers || {}};
  },
  post: async (url, body, opts = {}) => {
    const headers = Object.assign({}, opts.headers || {});
    const params = {url, method: 'POST', headers, timeoutMs: opts.timeoutMs || 30000};
    if (opts.bodyBase64) params.bodyBase64 = opts.bodyBase64;
    else { params.body = body || ''; if (opts.contentType) headers['Content-Type'] = opts.contentType; }
    const r = await invoke('http.request', params);
    return {status: r.status, body: r.body || '', url: r.url, headers: r.headers || {}};
  }
};

const log = (...a) => console.log(...a);

try {
  const info = await invoke('engine.info', {});
  log('engine   ', info.name, info.version, 'java', info.java);

  const found = await engine.searchAll(ctx, {query, sources: [source]});
  const res = found.results[0];
  if (res.error) throw new Error('search failed: ' + res.error);
  log('search   ', source, '→', res.items.length, 'items');
  if (!res.items.length) throw new Error('no items parsed');
  res.items.slice(0, 3).forEach(it => log('           ', it.title.slice(0, 56), '|', it.author || '-', '| tags', it.tags.length));

  const item = res.items[0];
  const spec = engine.getSource(source);
  const detail = await spec.detail(ctx, item.raw);
  log('detail   ', detail.pages.length, 'page(s),', detail.pages[0] ? detail.pages[0].url.slice(0, 90) : 'none');

  const dir = path.join(os.tmpdir(), 'dcd-live', String(Date.now()));
  const plan = engine.planExport(item, {root: dir, index: 1, width: 3, pages: detail.pages.slice(0, 2)});
  await invoke('fs.allowRoot', {path: dir});
  await invoke('fs.mkdirs', {path: plan.dir});
  for (const file of plan.files) {
    const got = await invoke('http.download', {
      url: file.url,
      path: plan.dir + '\\' + file.name,
      headers: {'User-Agent': engine.UA, Referer: item.url},
      timeoutMs: 120000
    });
    log('download ', file.name, got.bytes, 'bytes', got.contentType || '', got.skipped ? '(skipped)' : '');
  }
  const listing = await invoke('fs.list', {path: plan.dir});
  log('on disk  ', path.basename(plan.dir));
  listing.entries.forEach(e => log('           ', e.name, e.bytes, 'bytes'));
  log('PASS');
} catch (err) {
  log('FAIL', err.message);
  process.exitCode = 1;
} finally {
  proc.stdin.end();
  proc.kill();
}
