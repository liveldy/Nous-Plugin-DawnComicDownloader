/* Dev tool: derive the two preview pages from ui/index.html so they never drift.
 *   node tools/make-preview.mjs
 * preview.html      — boots with a demo bridge and runs one search
 * preview-empty.html — boots with the demo bridge, sends nothing
 * Neither file is packed: manifest.resources lists only the shipped UI. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(path.join(root, 'ui/index.html'), 'utf8');

const bridge = '<script src="demo-host.js"></script>\n';
const search = `<script>
  // preview harness: fill the grid from the saved fixtures
  setTimeout(function () {
    document.getElementById('q').value = 'test';
    document.getElementById('find').dispatchEvent(new Event('submit', {cancelable: true}));
  }, 420);
</script>
`;

const withBridge = source.replace('<script src="nous-plugin.js"></script>', bridge + '<script src="nous-plugin.js"></script>');
if (withBridge === source) throw new Error('index.html: script tag not found');

const results = withBridge.replace('</body>', search + '</body>').replace('<title>破晓漫画下载器</title>', '<title>破晓漫画下载器 · preview</title>');
const empty = withBridge.replace('<title>破晓漫画下载器</title>', '<title>破晓漫画下载器 · preview empty</title>');

await fs.writeFile(path.join(root, 'ui/preview.html'), results);
await fs.writeFile(path.join(root, 'ui/preview-empty.html'), empty);
const pick = `<script>
  // design review: put three results in the download queue
  setTimeout(function () {
    var cards = document.querySelectorAll('.card');
    [0, 2, 5].forEach(function (i) { if (cards[i]) cards[i].click(); });
  }, 2400);
</script>
`;
await fs.writeFile(path.join(root, 'ui/preview-grid.html'), empty.replace('</body>', search + pick + '</body>'));

const dark = results
  .replace('<title>破晓漫画下载器 · preview</title>', '<title>破晓漫画下载器 · preview dark</title>')
  .replace('<script src="demo-host.js"></script>', '<script>window.__DAWN_THEME = "dark";</script>\n<script src="demo-host.js"></script>')
  .replace('</body>', pick + '</body>');
await fs.writeFile(path.join(root, 'ui/preview-dark.html'), dark);

const nav = `<script>
  // design review: the host sidebar switches to the settings view
  setTimeout(function () { if (window.__DAWN_NAV__) window.__DAWN_NAV__('settings'); }, 500);
</script>
`;
const settings = empty.replace('</body>', nav + '</body>')
  .replace('<title>破晓漫画下载器 · preview empty</title>', '<title>破晓漫画下载器 · preview settings</title>');
await fs.writeFile(path.join(root, 'ui/preview-settings.html'), settings);
console.log('wrote ui/preview.html, ui/preview-empty.html, ui/preview-grid.html');
