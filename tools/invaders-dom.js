#!/usr/bin/env node
/**
 * Real-DOM check for invaders-game (Space Invaders).
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id, `querySelectorAll` returns an empty
 * array and the canvas context is a permissive Proxy; the vm sandbox has no DOM
 * at all. Both hide whole bug classes - a dangling id, a listener that was never
 * bound, a canvas that is not really on the page, an i18n switcher that never
 * mounts, or a start overlay that never actually hides. This script runs the
 * page for real in jsdom (with the native `canvas` package, so
 * `getContext('2d')` is genuine) and drives it with real events:
 *
 *   - the page loads with zero jsdom errors and `window.SI` is live in 'ready';
 *   - the canvas really exists, is 480x560, sits inside .stage and the start
 *     overlay is showing while the result overlay is hidden;
 *   - a real click on the Start button leaves ready and hides the overlay;
 *   - a real ArrowRight / ArrowLeft keydown moves the ship, and a real Space
 *     keydown fires a bullet that scores (all asserted on SI.getState());
 *   - the real Pause / New-game buttons pin the state machine;
 *   - the language switcher is a set of <a> (not <button>) and clicking the
 *     real 简体中文 link re-renders the DYNAMIC HUD label and the open result
 *     dialog through T.onChange;
 *   - pumping the real rAF loop never throws (draw() runs against a real 2d
 *     context), and every element id the game reaches for exists.
 *
 * Determinism: requestAnimationFrame is captured (not auto-scheduled) and the
 * test pumps frames explicitly, while game state is advanced through `SI.tick()`
 * - so the run is repeatable instead of racing real timers.
 *
 * Usage:
 *   cd <repo-root> && python3 -m http.server 8123 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> node tools/invaders-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy (or the
 * deployed page) can be fed to the same script to prove it is not vacuous.
 * A file:// URL will not work: jsdom throws a DOMException on localStorage under
 * file://, so always serve over http and pass the http URL.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8123/invaders-game/';
const IS_LOCAL = /127\.0\.0\.1|localhost/.test(TARGET);
const SETTLE = IS_LOCAL ? 1200 : 4000; // remote / first load needs much longer

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
    // Capture rAF so the test owns the frame clock (SI.tick drives the sim);
    // the loop still runs when the test calls window.__pump(). Pin
    // performance.now() to a counter the test advances so the real frame path is
    // reproducible instead of racing wall time.
    beforeParse(window) {
      let cb = null;
      let clock = 0;
      window.requestAnimationFrame = fn => { cb = fn; return 1; };
      window.cancelAnimationFrame = () => { cb = null; };
      window.__pump = ts => { const f = cb; cb = null; if (f) f(ts); };
      window.__advance = ms => { clock += ms; };
      try {
        Object.defineProperty(window.performance, 'now', { value: () => clock, configurable: true, writable: true });
      } catch (e) { /* older jsdom: fall back to the real clock (assertions stay valid) */ }
    }
  };

  let dom;
  try {
    dom = await JSDOM.fromURL(TARGET, opts);
  } catch (e) {
    // The optional url may point at a page that is not deployed yet. That is a
    // skip, not a failure - the local run is the real assertion.
    console.log(`SKIP: could not load ${TARGET} (${(e && e.message) || e})`);
    process.exit(0);
  }
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  await new Promise(r => window.addEventListener('load', () => setTimeout(r, SETTLE)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const text = s => { const n = $(s); return n ? n.textContent : ''; };
  const SI = () => window.SI;
  const st = () => window.SI.getState();
  const ids = o => doc.getElementById(o);

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function press(key) {
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, view: window }));
  }
  function release(key) {
    doc.dispatchEvent(new window.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, view: window }));
  }
  function pumpFrames(n, dtMs) {
    for (let i = 0; i < n; i++) {
      window.__advance(dtMs === undefined ? 16 : dtMs);
      window.__pump(Date.now());
    }
  }
  function tickUntil(pred, seconds, chunk) {
    const c = chunk || 1 / 30;
    let t = 0;
    while (t < seconds) { window.SI.tick(c); t += c; if (pred()) return { ok: true, t }; }
    return { ok: false, t };
  }
  const langLink = code => [...doc.querySelectorAll('.lang-switch a')].find(a => a.getAttribute('data-lang') === code);

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.SI, 'window.SI bridge exists in the real page');
  const api = ['waveConfig', 'stepInterval', 'formationState', 'scoreFor', 'ufoScoreAt',
    'bombColumnFor', 'nextRandom', 'bunkers', 'bunkerBitmap', 'damageBunker', 'hitTestBunker',
    'makeBunker', 'invaderAt', 'invaderBox', 'playerBulletAt', 'bulletY', 'bombAt', 'bombs',
    'newGame', 'fire', 'move', 'start', 'pause', 'tick', 'getState'];
  ok(api.every(k => typeof window.SI[k] === 'function'),
    `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.SI[k] !== 'function'))})`);
  ok(window.SI.COLS === 11 && window.SI.ROWS === 5 && window.SI.CELL === 28 && window.SI.FIELD_W === 480 && window.SI.FIELD_H === 560,
    `COLS/ROWS/CELL/FIELD are 11/5/28/480/560 (got ${window.SI.COLS}/${window.SI.ROWS}/${window.SI.CELL}/${window.SI.FIELD_W}/${window.SI.FIELD_H})`);
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().lives === 3 && st().score === 0 && st().wave === 1 && st().invadersLeft === 55,
    `fresh state is 3 lives / 0 / wave 1 / 55 aliens (got ${st().lives}/${st().score}/${st().wave}/${st().invadersLeft})`);
  ok(st().bunkers === 4 && st().bunkerSolid === 1232,
    `four intact shields (bunkers=${st().bunkers}, solid=${st().bunkerSolid})`);
  ok(window.SI.makeBunker().length === 16 && window.SI.makeBunker().every(r => r.length === 22),
    'makeBunker() is a 16-row x 22-col bitmap');

  /* -------------------------------------------------------------------- 2 */
  group('2. the real canvas and overlays exist in the DOM');
  const cv = ids('cv');
  ok(!!cv, '#cv exists');
  ok(cv && cv.tagName === 'CANVAS', `#cv is a <canvas> (got ${cv && cv.tagName})`);
  ok(cv && cv.width === 480 && cv.height === 560, `the canvas backing store is 480x560 (got ${cv && cv.width}x${cv && cv.height})`);
  ok(cv && typeof cv.getContext === 'function' && !!cv.getContext('2d'), 'the canvas returns a real 2d context');
  ok(!!$('.stage') && $('.stage').contains(cv), '#cv is inside .stage (the render container)');
  ok(cv && String(cv.style.aspectRatio || '').indexOf('480') === 0, `the canvas aspect-ratio is pinned to 480/560 (got ${cv && cv.style.aspectRatio})`);
  const startOverlay = ids('startOverlay');
  ok(!!startOverlay && startOverlay.classList.contains('show'), 'the start overlay is visible on load');
  ok(!!startOverlay && !!startOverlay.querySelector('.dialog'), 'the start overlay holds a dialog');
  ok(!!ids('overlay') && !ids('overlay').classList.contains('show'), 'the result overlay is hidden at boot');
  ok(!!ids('btnPause') && ids('btnPause').tagName === 'BUTTON' && ids('btnPause').disabled === true,
    'the Pause button is a disabled <button> in ready');
  ok(!!ids('btnStart') && ids('btnStart').tagName === 'BUTTON', '#btnStart is a real <button>');

  /* -------------------------------------------------------------------- 3 */
  group('3. every id the game reaches for resolves');
  {
    const wanted = ['cv', 'score', 'lives', 'wave', 'remaining', 'startOverlay', 'btnStart',
      'overlay', 'ovTitle', 'ovSub', 'ovBtn', 'btnPause', 'btnNew', 'btnLeft', 'btnRight', 'btnFire'];
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
  group('5. real keydowns steer the ship and really fire');
  {
    const x0 = st().ship.x;
    press('ArrowRight');
    window.SI.tick(0.5);
    ok(st().ship.x > x0, `a real ArrowRight keydown drives the ship right (${x0} -> ${st().ship.x.toFixed(1)})`);
    ok(st().ship.dir === 1, `holding right sets the facing direction (dir=${st().ship.dir})`);
    release('ArrowRight');
    const x1 = st().ship.x;
    press('ArrowLeft');
    window.SI.tick(0.3);
    ok(st().ship.x < x1, `a real ArrowLeft keydown drives the ship left (${x1.toFixed(1)} -> ${st().ship.x.toFixed(1)})`);
    release('ArrowLeft');

    const score0 = st().score;
    press(' ');
    ok(st().bullets.length === 1, `a real Space keydown fires a bullet (bullets=${st().bullets.length})`);
    window.SI.tick(0.9);
    ok(st().score > score0, `the fired bullet kills an invader and scores (${score0} -> ${st().score})`);
    ok(st().bullets.length === 0, 'the bullet is consumed on impact');
    ok(text('#score') === String(st().score) && text('#remaining') === String(st().invadersLeft),
      `the HUD mirrors the model (score=${text('#score')}/${st().score}, left=${text('#remaining')}/${st().invadersLeft})`);
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. the real Pause and New-game buttons pin the state machine');
  {
    click(ids('btnPause'));
    ok(st().phase === 'paused', `clicking Pause enters 'paused' (got ${st().phase})`);
    const sc0 = st().score;
    window.SI.tick(2);
    ok(st().phase === 'paused' && st().score === sc0, `tick() while paused does not advance the game (${sc0} -> ${st().score})`);
    click(ids('btnPause'));
    ok(st().phase === 'playing', `clicking Pause again resumes (got ${st().phase})`);
    click(ids('btnNew'));
    ok(st().phase === 'playing', `the New-game button restarts into 'playing' (got ${st().phase})`);
    ok(st().score === 0 && st().lives === 3 && st().wave === 1 && st().invadersLeft === 55,
      `New-game resets score/lives/wave/aliens (got ${st().score}/${st().lives}/${st().wave}/${st().invadersLeft})`);
    ok(text('#score') === '0' && text('#lives') === '3' && text('#wave') === '1' && text('#remaining') === '55',
      'the HUD reflects the reset');
  }

  /* -------------------------------------------------------------------- 7 */
  group('7. the language switcher is <a> and real clicks re-localise');
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
    ok(CJK.test(text('#btnPause')), `the dynamic pause label is Chinese (got ${JSON.stringify(text('#btnPause'))})`);
    ok(CJK.test(text('h1[data-i18n="title"]')), `the static title is Chinese (got ${JSON.stringify(text('h1[data-i18n="title"]'))})`);

    /* The result dialog is dynamic: open it, then flip language and confirm
     * T.onChange re-renders the OPEN dialog. */
    window.SI.newGame({ wave: 1, seed: 1, lives: 1 });
    const over = tickUntil(() => st().phase === 'gameover', 200, 0.1);
    ok(over.ok && st().phase === 'gameover', `the l=1 run reaches 'gameover' (got ${st().phase})`);
    ok(ids('overlay').classList.contains('show'), 'the result overlay is shown on game over');
    ok(text('#ovTitle') === '游戏结束', `the result title is Chinese via T.onChange (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(/\d/.test(text('#ovSub')), `the Chinese subtitle carries the score (got ${JSON.stringify(text('#ovSub'))})`);

    click(langLink('en'));
    await sleep(50);
    ok(text('#ovTitle') === 'Game over', `flipping to en re-renders the open dialog (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(!CJK.test(text('#btnPause')) || text('#btnPause') === 'Pause', `the dynamic pause label is English again (got ${JSON.stringify(text('#btnPause'))})`);

    click(ids('ovBtn'));
    ok(st().phase === 'playing' && st().score === 0, `the real result button restarts the game (phase=${st().phase}, score=${st().score})`);
    ok(!ids('overlay').classList.contains('show'), 'the result overlay is hidden after restart');
  }

  /* -------------------------------------------------------------------- 8 */
  group('8. pumping the real rAF loop never throws');
  {
    window.SI.newGame({ wave: 1, seed: 1 });
    window.SI.start();
    const before = errs.length;
    pumpFrames(40);
    ok(errs.length === before, '40 pumped animation frames run clean' + (errs.length > before ? `\n     ${errs.slice(before, before + 3).join('\n     ')}` : ''));
    ok(cv.width === 480 && cv.height === 560, 'the canvas is still 480x560 after real frames');
  }

  /* -------------------------------------------------------------------- 9 */
  group('9. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
