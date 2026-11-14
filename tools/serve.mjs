/* Static server for the preview pages: node tools/serve.mjs [port]
 * Serves the project root on 127.0.0.1 so ui/preview*.html can reach
 * ../test/fixtures and ../shots/covers. Dev only. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 5399);
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.woff2': 'font/woff2'};

http.createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, url === '/' ? 'ui/preview.html' : url);
  if (!file.startsWith(root)) { res.writeHead(403); res.end('no'); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store'});
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port + '/ui/preview.html'));
