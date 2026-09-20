#!/usr/bin/env node
/**
 * Real-DOM check for pacman-game.
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id, `querySelectorAll` returns an empty
 * array and the canvas context is a permissive Proxy; the vm sandbox has no
 * DOM at all. Both hide whole bug classes - a dangling id, a listener that was
 * never bound, a canvas that is not really on the page, or a start overlay
 * that never actually hides. This script runs the page for real in jsdom
 * (with the native `canvas` package, so `getContext('2d')` is genuine) and
 * drives it with real events:
 *
 *   - the page loads with zero jsdom errors and `window.PM` is live in 'ready';
 *   - the canvas really exists, is 448x496 and the start overlay is showing;
 *   - clicking the actual Start button leaves ready and hides the overlay;
 *   - a real ArrowRight keydown reverses Pac-Man and he then travels right;
 *   - the real Pause / New-game buttons pin the state machine;
 *   - the language switcher is an <a> (not a <button>) and clicking the real
 *     中文 link re-renders the DYNAMIC HUD / result text through T.onChange;
 *   - pumping the real rAF loop never throws (draw() runs against a real 2d
 *     context), and every element id the game reaches for exists.
 *
 * Determinism: requestAnimationFrame is captured (not auto-scheduled) and the
 * test pumps frames explicitly, while game state is advanced through
 * `PM.tick()` - so the run is repeatable instead of racing real timers.
 *
 * Usage:
 *   cd <repo-root> && python3 -m http.server 8123 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> node tools/pacman-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy can be fed to
 * the same script to prove it is not vacuous.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8123/pacman-game/';
const IS_LOCAL = /127\.0\.0\.1|localhost/.test(TARGET);
const SETTLE = IS_LOCAL ? 1200 : 4000; // remote/first load needs much longer

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CJK = /[\u4e00-\u9fff]/;

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));

  const opts = {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    // Capture rAF so the test owns the frame clock (PM.tick drives the sim);
    // the loop still runs when the test calls window.__pump().
    beforeParse(window) {
      let cb = null;
      window.requestAnimationFrame = fn => { cb = fn; return 1; };
      window.cancelAnimationFrame = () => { cb = null; };
      window.__pump = ts => { const f = cb; cb = null; if (f) f(ts); };
    }
  };

  const dom = await JSDOM.fromURL(TARGET, opts);
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  await new Promise(r => window.addEventListener('load', () => setTimeout(r, SETTLE)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const text = s => { const n = $(s); return n ? n.textContent : ''; };
  const PM = () => window.PM;
  const st = () => window.PM.getState();
  const ids = o => doc.getElementById(o);

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function press(key) {
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, view: window }));
  }
  function pumpFrames(n) {
    for (let i = 0; i < n; i++) window.__pump(Date.now() + i * 16);
  }
  function langLink(code) { return [...doc.querySelectorAll('.lang-switch a')].find(a => a.getAttribute('data-lang') === code); }

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.PM, 'window.PM bridge exists in the real page');
  const api = ['maze', 'isWall', 'canWalk', 'wrap', 'ghostTarget', 'ghostNextDir', 'newGame', 'getState', 'start', 'tick'];
  ok(api.every(k => typeof window.PM[k] === 'function'), `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.PM[k] !== 'function'))})`);
  ok(window.PM.COLS === 28 && window.PM.ROWS === 31 && window.PM.TILE === 16,
    `COLS/ROWS/TILE are 28/31/16 (got ${window.PM.COLS}/${window.PM.ROWS}/${window.PM.TILE})`);
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().lives === 3 && st().score === 0 && st().level === 1 && st().pelletsLeft === 264,
    `fresh state is 3 lives / 0 / level 1 / 264 pellets (got ${st().lives}/${st().score}/${st().level}/${st().pelletsLeft})`);
  ok(st().pac.r === 23 && st().pac.c === 13, `Pac-Man starts at (23,13) (got ${st().pac.r},${st().pac.c})`);
  ok(window.PM.maze().length === 31 && window.PM.maze().every(r => r.length === 28),
    'maze() is 31 rows of 28 columns in the real page');

  /* -------------------------------------------------------------------- 2 */
  group('2. the real canvas and overlays exist in the DOM');
  const cv = ids('cv');
  ok(!!cv, '#cv exists');
  ok(cv && cv.tagName === 'CANVAS', `#cv is a <canvas> (got ${cv && cv.tagName})`);
  ok(cv && cv.width === 448 && cv.height === 496, `the canvas backing store is 448x496 (got ${cv && cv.width}x${cv && cv.height})`);
  ok(cv && typeof cv.getContext === 'function' && !!cv.getContext('2d'), 'the canvas returns a real 2d context');
  ok(!!$('.stage') && $('.stage').contains(cv), '#cv is inside .stage (the render container)');
  ok(cv && String(cv.style.aspectRatio || '').indexOf('448') === 0, `the canvas aspect-ratio is pinned to 448/496 (got ${cv && cv.style.aspectRatio})`);
  const startOverlay = ids('startOverlay'), pauseBtn = ids('btnPause'), newBtn = ids('btnNew');
  ok(!!startOverlay && startOverlay.classList.contains('show'), 'the start overlay is visible on load');
  ok(!!startOverlay && !!startOverlay.querySelector('.dialog'), 'the start overlay holds a dialog');
  ok(!!pauseBtn && pauseBtn.tagName === 'BUTTON', `#btnPause is a real <button> (got ${pauseBtn && pauseBtn.tagName})`);
  ok(!!newBtn && newBtn.tagName === 'BUTTON', `#btnNew is a real <button> (got ${newBtn && newBtn.tagName})`);
  ok(!!ids('overlay') && !ids('overlay').classList.contains('show'), 'the result overlay is hidden at boot');

  /* -------------------------------------------------------------------- 3 */
  group('3. every id the game reaches for resolves');
  {
    const wanted = ['cv', 'score', 'lives', 'level', 'state', 'startOverlay', 'btnStart',
      'overlay', 'ovTitle', 'ovSub', 'ovBtn', 'btnNew', 'btnPause'];
    const missing = wanted.filter(id => ids(id) === null);
    ok(missing.length === 0, `all ${wanted.length} game ids exist (missing ${JSON.stringify(missing)})`);
    ok(doc.querySelectorAll('.lang-switch').length >= 1, 'a language-switch host is present');
    ok(!!$('h1[data-i18n="title"]'), 'the title carries a data-i18n hook');
  }

  /* -------------------------------------------------------------------- 4 */
  group('4. a real click on Start leaves ready and hides the overlay');
  click(ids('btnStart'));
  ok(st().phase === 'playing', `clicking Start enters 'playing' (got ${st().phase})`);
  ok(!ids('startOverlay').classList.contains('show'), 'the start overlay is really hidden after Start');
  ok(ids('btnPause').disabled === false, 'the Pause button becomes enabled once playing');

  /* -------------------------------------------------------------------- 5 */
  group('5. real keydowns steer Pac-Man and pellets really score');
  {
    press('ArrowRight');
    window.PM.tick(0.5);
    ok(st().pac.dir === 'right', `a real ArrowRight keydown reverses Pac-Man (got ${st().pac.dir})`);
    const c0 = st().pac.c;
    window.PM.tick(10);
    ok(st().pac.c > c0, `Pac-Man travels right over real frames (${c0} -> ${st().pac.c})`);
    const score0 = st().score, pellets0 = st().pelletsLeft;
    window.PM.tick(20);
    ok(st().score > score0, `pellet scoring moves the score (${score0} -> ${st().score})`);
    ok(st().pelletsLeft < pellets0, `pelletsLeft falls as pellets are eaten (${pellets0} -> ${st().pelletsLeft})`);
    ok(text('#score') === String(st().score), `the #score HUD mirrors the state (${text('#score')} vs ${st().score})`);
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. the real Pause and New-game buttons pin the state machine');
  {
    click(ids('btnPause'));
    ok(st().phase === 'paused', `clicking Pause enters 'paused' (got ${st().phase})`);
    const s0 = st().score;
    window.PM.tick(20);
    ok(st().score === s0, `tick() while paused does not score (${s0} -> ${st().score})`);
    ok(st().phase === 'paused', 'tick() while paused leaves the phase alone');
    click(ids('btnPause'));
    ok(st().phase === 'playing', `clicking Pause again resumes (got ${st().phase})`);
    click(ids('btnNew'));
    ok(st().phase === 'playing', `the New-game button restarts into 'playing' (got ${st().phase})`);
    ok(st().score === 0 && st().level === 1 && st().lives === 3,
      `New-game resets score/level/lives (got ${st().score}/${st().level}/${st().lives})`);
    ok(text('#score') === '0' && text('#lives') === '3' && text('#level') === '1', 'the HUD reflects the reset');
  }

  /* -------------------------------------------------------------------- 7 */
  group('7. the language switcher is an <a> and real clicks re-localise');
  {
    const links = [...doc.querySelectorAll('.lang-switch a')];
    ok(links.length === 2, `the switcher rendered two links (got ${links.length})`);
    ok(links.length === 2 && links.every(a => a.tagName === 'A'), 'both switcher entries are <a>, not <button>');
    ok(!!langLink('zh') && !!langLink('en'), 'there are en and zh links');
    ok(doc.querySelectorAll('.lang-switch button').length === 0, 'the switcher contains no <button>');

    click(langLink('zh'));
    await sleep(50);
    ok(doc.documentElement.lang === 'zh-CN', `document lang is zh-CN after the click (got ${doc.documentElement.lang})`);
    ok(window.localStorage.getItem('litegame_lang') === 'zh', 'the choice is persisted to localStorage');
    ok(CJK.test(text('#state')), `the dynamic HUD status is Chinese (got ${JSON.stringify(text('#state'))})`);
    ok(CJK.test(text('#btnPause')) || CJK.test(text('#btnNew')), `a dynamic button label is Chinese (pause=${JSON.stringify(text('#btnPause'))}, new=${JSON.stringify(text('#btnNew'))})`);
    ok(CJK.test(text('h1[data-i18n="title"]')), `the static title is Chinese (got ${JSON.stringify(text('h1[data-i18n="title"]'))})`);

    click(langLink('en'));
    await sleep(50);
    ok(doc.documentElement.lang === 'en', 'document lang is back to en');
    ok(!CJK.test(text('#state')), `the dynamic HUD status is English again (got ${JSON.stringify(text('#state'))})`);
  }

  /* -------------------------------------------------------------------- 8 */
  group('8. the result dialog re-renders through T.onChange');
  {
    window.PM.newGame({ level: 1 });
    window.PM.start();
    window.PM.tick(300); // deterministic no-input run ends in game over
    ok(st().phase === 'gameover', `driving with no input reaches 'gameover' (got ${st().phase})`);
    ok(ids('overlay').classList.contains('show'), 'the result overlay is shown on game over');
    ok(text('#ovTitle') === 'Game over', `the result title is the English 'Game over' (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(/\d/.test(text('#ovSub')), `the result subtitle carries the score (got ${JSON.stringify(text('#ovSub'))})`);

    click(langLink('zh'));
    await sleep(50);
    ok(CJK.test(text('#ovTitle')), `the result title re-renders in Chinese via T.onChange (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(text('#ovTitle') === '游戏结束', `the localised title is 游戏结束 (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(/\d/.test(text('#ovSub')), `the Chinese subtitle still carries the score (got ${JSON.stringify(text('#ovSub'))})`);
    ok(CJK.test(text('#ovBtn')), `the result button is Chinese (got ${JSON.stringify(text('#ovBtn'))})`);

    click(ids('ovBtn'));
    ok(st().phase === 'playing', `the real result button restarts the game (got ${st().phase})`);
    ok(st().score === 0 && st().level === 1, `restart resets score/level (got ${st().score}/${st().level})`);
    ok(!ids('overlay').classList.contains('show'), 'the result overlay is hidden after restart');

    click(langLink('en'));
    await sleep(50);
  }

  /* -------------------------------------------------------------------- 9 */
  group('9. pumping the real rAF loop never throws');
  {
    window.PM.newGame({ level: 1 });
    window.PM.start();
    const before = errs.length;
    pumpFrames(40);
    ok(errs.length === before, '40 pumped animation frames run clean' + (errs.length > before ? `\n     ${errs.slice(before, before + 3).join('\n     ')}` : ''));
    ok(cv.width === 448 && cv.height === 496, 'the canvas is still 448x496 after real frames');
  }

  /* ------------------------------------------------------------------- 10 */
  group('10. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
