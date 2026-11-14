/* Static checks on the page: every handler the code binds must exist, every id
 * it touches must be in index.html, and the settings panel must be reachable.
 * This is the check that would have caught a block edit deleting four functions.
 * MIT. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFile(path.join(here, '..', p), 'utf8');

const app = await read('ui/app.js');
const html = await read('ui/index.html');
const engine = await read('ui/engine.js');

function defined(name) {
  const patterns = [
    new RegExp('(?:^|\\n)\\s*(?:async\\s+)?function\\s+' + name + '\\b'),
    new RegExp('(?:^|\\n)\\s*var\\s+' + name + '\\s*='),
    new RegExp('(?:^|\\n)\\s*(?:[A-Za-z]+\\s*:\\s*(?:async\\s+)?function|' + name + '\\s*:\\s*function)')
  ];
  return patterns.some((re) => re.test(app));
}

test('every named handler the page binds is defined', () => {
  const named = [...app.matchAll(/addEventListener\(\s*'click'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)].map((m) => m[1]);
  const wired = (app.match(/addEventListener\(\s*'click'/g) || []).length;
  assert.ok(wired >= 8, 'expected at least eight click handlers, found ' + wired);
  const unique = [...new Set(named)];
  const missing = unique.filter((n) => !defined(n));
  assert.deepEqual(missing, [], 'handlers referenced but never defined: ' + missing.join(', '));
});

test('every element id the page looks up exists in index.html', () => {
  const ids = [...new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
  const missing = ids.filter((id) => !html.includes('id="' + id + '"'));
  assert.deepEqual(missing, [], 'ids missing from index.html: ' + missing.join(', '));
});

test('the page ships the three scripts it needs, in order', () => {
  const order = ['nous-plugin.js', 'engine.js', 'app.js'].map((f) => html.indexOf('<script src="' + f + '"></script>'));
  assert.ok(order.every((i) => i > 0), 'a script tag is missing');
  assert.deepEqual(order.slice().sort((a, b) => a - b), order, 'scripts are out of order');
  assert.ok(html.indexOf('addEventListener(\'error\'') > 0, 'an early error hook must be present');
});

test('the canvas helpers the descramble path needs are defined once', () => {
  for (const name of ['makeCanvas', 'canvasToBlob', 'writeBytes', 'downloadDescrambled', 'fetchImageBytes']) {
    const hits = (app.match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\b', 'g')) || []).length;
    assert.equal(hits, 1, name + ' should be defined exactly once, found ' + hits);
  }
});

test('settings, picker and download controls are all present', () => {
  for (const id of ['fields', 'rootInput', 'browseRoot', 'jmDomainInput', 'jmCookieInput', 'uaInput', 'jmProbe', 'dlTest', 'jmLogin', 'pixivCookieInput', 'pixivLogin', 'pixivStatus', 'picker', 'pickerPath', 'pickerRoots', 'favs', 'favFolders', 'favGrid', 'favAddFolder', 'favFolderName', 'favRename', 'favDelete', 'favEditName', 'favPop']) {
    assert.ok(html.includes('id="' + id + '"'), 'missing control: ' + id);
  }
});

test('the engine still exposes what the page calls', () => {
  for (const fn of ['sourceInfo', 'getSource', 'searchAll', 'planExport', 'identifyImage', 'queriesFromMatch', 'jmScrambleNum', 'jmScramblePlan', 'bytesToBase64', 'base64ToBytes', 'setUserAgent', 'currentUserAgent']) {
    assert.ok(new RegExp('\\b' + fn + '\\s*:').test(engine), 'engine is missing ' + fn);
  }
});
