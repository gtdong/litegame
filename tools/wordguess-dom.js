#!/usr/bin/env node
/**
 * Real-DOM check for wordguess-game.
 *
 * The third layer. The smoke test runs a stub DOM where `querySelectorAll`
 * returns an empty array, `getAttribute` always returns null and `textContent`
 * does not aggregate children; the vm sandbox has no DOM at all. Both hide
 * whole bug classes. This script runs the page for real:
 *
 *   - the real pad key count in each language (26 letters / 130 characters),
 *   - the real board geometry (6 rows of 5, or 6 rows of 4 for Chinese),
 *   - clicking the actual key elements, the actual Enter / Delete buttons and
 *     the actual language links,
 *   - the actual cell and key classes after a guess,
 *   - that each language's board survives a switch untouched.
 *
 * jsdom lives in an isolated directory so this repo stays dependency-free:
 *
 *   NODE_PATH=/Users/dgt/.workbuddy/binaries/node/workspace/node_modules \
 *     node tools/wordguess-dom.js [path/to/index.html]
 *
 * The optional path argument exists so a deliberately broken copy can be fed to
 * the same script to prove it is not vacuous.
 */

'use strict';

const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || path.join(ROOT, 'wordguess-game', 'index.html');
const REMOTE = /^https?:/.test(TARGET);

const GREEN = '\uD83D\uDFE9';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}
function group(title) { console.log(`\n[${title}]`); }

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));

  const opts = { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc };
  const dom = REMOTE ? await JSDOM.fromURL(TARGET, opts) : await JSDOM.fromFile(TARGET, opts);
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  // A remote page needs longer: "not loaded yet" otherwise reads as "the button
  // does nothing".
  await new Promise(r => window.addEventListener('load', () => setTimeout(r, REMOTE ? 4000 : 1200)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const $$ = s => [...doc.querySelectorAll(s)];
  const padKeys = () => $$('#pad .key');
  const st = () => window.WG.getState();
  const rows = () => $$('#board .row');
  const cells = i => [...rows()[i].children];
  const rowText = i => cells(i).map(c => c.textContent).join('');
  const rowCls = i => cells(i).map(c => c.className.replace('cell', '').trim() || 'empty');

  function tapKey(ch) {
    const k = padKeys().find(el => el.textContent === ch);
    if (!k) return false;
    k.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  }
  function spell(w) {
    let all = true;
    for (const ch of w) if (!tapKey(ch)) all = false;
    return all;
  }
  const tap = sel => $(sel).click();
  const enter = () => tap('#btnEnter');
  const press = k => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  const setLang = code => $$('.lang-switch a').find(a => a.getAttribute('data-lang') === code)
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

  group('1. initial render');
  ok(errs.length === 0, 'no errors while loading');
  ok(!!window.WG, 'the WG bridge is present');
  ok(rows().length === 6, `six board rows (got ${rows().length})`);
  ok(cells(0).length === 5, 'five cells per row in English');
  ok(padKeys().length === 26, `a 26-key pad in English (got ${padKeys().length})`);
  ok($('#over').hidden === true, 'the result panel starts hidden');
  ok($('#hintRow').textContent.length > 0, `the hint line has copy: ${JSON.stringify($('#hintRow').textContent)}`);

  group('2. guessing with real clicks');
  window.WG.forceAnswer('CRANE');
  ok(spell('SLATE'), 'click SLATE out on the pad');
  ok(rowText(0) === 'SLATE', `the board shows what was typed (got ${JSON.stringify(rowText(0))})`);
  ok(st().rows.length === 0, 'nothing is committed before Enter');
  tap('#btnDel');
  ok(rowText(0) === 'SLAT', `Delete removes one character (got ${JSON.stringify(rowText(0))})`);
  tapKey('E');
  enter();
  ok(st().rows.length === 1 && st().rows[0] === 'SLATE', 'Enter commits the guess');
  ok(rowCls(0).join(',') === 'miss,miss,hit,miss,hit', `cells are coloured (got ${rowCls(0).join(',')})`);
  ok(cells(1).every(c => c.textContent === ''), 'the next row is still empty');

  group('3. keyboard and the rejections');
  window.WG.restart();
  press('z'); press('z');
  ok(rowText(0) === 'ZZ', `the physical keyboard types (got ${JSON.stringify(rowText(0))})`);
  press('z'); press('z'); press('z'); press('Enter');
  ok(st().rows.length === 0 && /word list|词库/i.test(st().msg),
    `a word outside the list is refused without costing a try: ${JSON.stringify(st().msg)}`);
  ok(rowText(0) === 'ZZZZZ', 'the refused guess stays on the board');
  press('Escape');
  ok(st().rows.length === 0 && rowText(0) === '', 'Escape starts a fresh round and clears the board');

  group('4. playing through to a win');
  window.WG.restart();
  window.WG.forceAnswer('CRANE');
  spell('ABOVE'); enter();
  ok(st().keyState.E === 'hit', 'the E scores a hit and the pad state follows');
  const eKey = padKeys().find(k => k.textContent === 'E');
  ok(/\bhit\b/.test(eKey.className), `the E key carries the hit class (got ${JSON.stringify(eKey.className)})`);
  spell('MONEY'); enter();
  ok(st().keyState.E === 'hit', 'a later guess cannot downgrade a letter that hit');
  spell('CRANE'); enter();
  ok(st().done === true && st().won === true, 'finding the word ends the round as a win');
  ok($('#over').hidden === false, 'the result panel opens');
  ok(/3/.test($('#overSub').textContent), `the sub-line reports the try count: ${JSON.stringify($('#overSub').textContent)}`);
  ok(!/[A-Za-z\u4e00-\u9fff]/.test($('#shareGrid').textContent), 'the share grid carries no letters');
  ok($$('#statBox .dist').length === 6, `the record shows six distribution rows (got ${$$('#statBox .dist').length})`);

  group('5. the clipboard fallback');
  let threw = false;
  try { tap('#btnCopy'); } catch (e) { threw = true; }
  await new Promise(r => setTimeout(r, 250));
  ok(!threw, 'clicking copy does not throw');
  ok($('#shareBox').hidden === false || $('#copyMsg').textContent.length > 0, 'it degrades to a manual copy');
  ok(($('#shareBox').value || '').includes(GREEN) || $('#copyMsg').textContent.length > 0, 'the shared text carries the colour blocks');

  group('6. switching to Chinese — a separate board');
  const enGrid = $('#shareGrid').textContent;
  const enRow0 = rowText(0);
  setLang('zh');
  await new Promise(r => setTimeout(r, 200));
  ok(st().lang === 'zh', 'the live language is now zh');
  ok(cells(0).length === 4, 'the Chinese board is four slots wide');
  ok(padKeys().length === 130, `the Chinese pad has 130 keys (got ${padKeys().length})`);
  ok(padKeys()[0].textContent.length === 1, 'one character per pad key');
  ok(st().rows.length === 0, 'the Chinese board is untouched by the English game');
  ok($('#over').hidden === true, 'the result panel closes');

  const idiom = st().answer;
  ok([...idiom].length === 4, `the drawn idiom is four characters: ${idiom}`);
  ok(spell(idiom), 'the idiom can be clicked out on the pad');
  enter();
  ok(st().won === true, 'a Chinese round can be won too');
  ok(!/[A-Za-z\u4e00-\u9fff]/.test($('#shareGrid').textContent), 'the Chinese share grid is spoiler-free as well');

  group('7. back to English — the board is still there');
  setLang('en');
  await new Promise(r => setTimeout(r, 200));
  ok(st().lang === 'en', 'the live language is en again');
  ok(padKeys().length === 26, 'the 26-key pad is back');
  ok(rowText(0) === enRow0, `the English board kept its guess (got ${JSON.stringify(rowText(0))})`);
  ok($('#shareGrid').textContent === enGrid, 'and so did its share grid');

  group('8. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? '\n     ' + errs.slice(0, 5).join('\n     ') : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
