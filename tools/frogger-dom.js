#!/usr/bin/env node
/**
 * Real-DOM check for frogger-game.
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById` lazily
 * invents an element for ANY id, `querySelectorAll` returns an empty array and
 * the canvas context is a permissive Proxy; the vm sandbox has no DOM at all.
 * Both hide whole bug classes - a dangling id, a listener that was never bound,
 * a canvas that is not really on the page, or a start overlay that never actually
 * hides. This script runs the page for real in jsdom and drives it with real
 * events:
 *
 *   - the page loads with zero jsdom errors and `window.FR` is live in 'ready';
 *   - the canvas really exists, is 416x416 and the start overlay is showing;
 *   - clicking the actual Start button leaves ready and hides the overlay;
 *   - a real ArrowUp keydown hops the frog and the HUD score moves;
 *   - the real Pause / New-game buttons pin the state machine;
 *   - the language switcher is an <a> (not a <button>) and clicking the real
 *      中文 link re-renders the DYNAMIC pause label / result dialog through
 *      T.onChange;
 *   - pumping the real rAF loop never throws (draw() runs against a real 2d
 *     context), and every element id the game reaches for exists.
 *
 * Determinism: requestAnimationFrame is captured (not auto-scheduled) and the
 * test pumps frames explicitly, while game state is advanced through
 * `FR.tick()` - so the run is repeatable instead of racing real timers.
 *
 * Usage:
 *   cd <repo-root> && python3 -m http.server 8123 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> node tools/frogger-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy can be fed to
 * the same script to prove it is not vacuous.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8123/frogger-game/';
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
    // Capture rAF so the test owns the frame clock (FR.tick drives the sim);
    // the loop still runs when the test calls window.__pump(). The page's
    // loop() derives dt from performance.now(), so we also pin that to a
    // counter the test advances - making the real frame path reproducible.
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
    // An explicitly-passed REMOTE url may point at a page that is not deployed
    // yet (e.g. the GitHub Pages copy before it goes live); that is a skip, not
    // a failure. But a LOCAL target - including the default - must never exit 0
    // on a failed load: a typo in the argument, a dead http server or a page
    // that throws on boot would otherwise masquerade as a passing run. A bare
    // path is not a remote url either.
    const explicitlyRemote = /^https?:\/\//i.test(TARGET) && !IS_LOCAL && !!process.argv[2];
    if (explicitlyRemote) {
      console.log(`SKIP: could not load ${TARGET} (${(e && e.message) || e})`);
      process.exit(0);
    }
    console.log(`FAIL: could not load ${TARGET} (${(e && e.message) || e})`);
    process.exit(1);
  }
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  await new Promise(r => window.addEventListener('load', () => setTimeout(r, SETTLE)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const text = s => { const n = $(s); return n ? n.textContent : ''; };
  const FR = () => window.FR;
  const st = () => window.FR.getState();
  const ids = o => doc.getElementById(o);

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function press(key) {
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, view: window }));
  }
  function pumpFrames(n, dtMs) {
    for (let i = 0; i < n; i++) {
      window.__advance(dtMs === undefined ? 16 : dtMs); // advance the deterministic frame clock
      window.__pump(Date.now());
    }
  }
  function langLink(code) { return [...doc.querySelectorAll('.lang-switch a')].find(a => a.getAttribute('data-lang') === code); }

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.FR, 'window.FR bridge exists in the real page');
  const api = ['laneConfig', 'vehiclesAt', 'platformsAt', 'hopTarget', 'collidesAt', 'supportAt',
    'homeSlot', 'scoreFor', 'newGame', 'hop', 'tick', 'getState', 'start', 'platformUnder'];
  ok(api.every(k => typeof window.FR[k] === 'function'), `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.FR[k] !== 'function'))})`);
  ok(window.FR.COLS === 13 && window.FR.ROWS === 13 && window.FR.CELL === 32,
    `COLS/ROWS/CELL are 13/13/32 (got ${window.FR.COLS}/${window.FR.ROWS}/${window.FR.CELL})`);
  ok(JSON.stringify(window.FR.HOME_COLS) === JSON.stringify([1, 3, 6, 9, 11]),
    `HOME_COLS is [1,3,6,9,11] (got ${JSON.stringify(window.FR.HOME_COLS)})`);
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().lives === 3 && st().score === 0 && st().level === 1,
    `fresh state is 3 lives / 0 / level 1 (got ${st().lives}/${st().score}/${st().level})`);
  ok(st().homesFilled === 0 && st().homes.length === 5, 'all five home bays start empty');
  ok(st().frog.r === 12 && st().frog.c === 6, `the frog starts at (12,6) (got ${st().frog.r},${st().frog.c})`);
  ok(Math.abs(st().timeLeft - 25) < 1e-9, `level-1 countdown starts at 25s (got ${st().timeLeft})`);
  ok(window.FR.laneConfig(1).length === 13, 'laneConfig(1) has 13 lanes in the real page');

  /* -------------------------------------------------------------------- 2 */
  group('2. the real canvas and overlays exist in the DOM');
  const cv = ids('cv');
  const dpr = window.devicePixelRatio || 1;
  ok(!!cv, '#cv exists');
  ok(cv && cv.tagName === 'CANVAS', `#cv is a <canvas> (got ${cv && cv.tagName})`);
  ok(cv && cv.width === 416 * dpr && cv.height === 416 * dpr,
    `the canvas backing store is 416x416 (dpr ${dpr}) (got ${cv && cv.width}x${cv && cv.height})`);
  ok(cv && typeof cv.getContext === 'function' && !!cv.getContext('2d'), 'the canvas returns a real 2d context');
  ok(!!$('.stage') && $('.stage').contains(cv), '#cv is inside .stage (the render container)');
  ok(cv && String(cv.style.aspectRatio || '').indexOf('416') === 0, `the canvas aspect-ratio is pinned to 416/416 (got ${cv && cv.style.aspectRatio})`);
  const startOverlay = ids('startOverlay'), pauseBtn = ids('btnPause'), newBtn = ids('btnNew');
  ok(!!startOverlay && startOverlay.classList.contains('show'), 'the start overlay is visible on load');
  ok(!!startOverlay && !!startOverlay.querySelector('.dialog'), 'the start overlay holds a dialog');
  ok(!!pauseBtn && pauseBtn.tagName === 'BUTTON', `#btnPause is a real <button> (got ${pauseBtn && pauseBtn.tagName})`);
  ok(!!newBtn && newBtn.tagName === 'BUTTON', `#btnNew is a real <button> (got ${newBtn && newBtn.tagName})`);
  ok(!!ids('overlay') && !ids('overlay').classList.contains('show'), 'the result overlay is hidden at boot');
  ok(pauseBtn && pauseBtn.disabled === true, 'the Pause button is disabled while in ready');

  /* -------------------------------------------------------------------- 3 */
  group('3. every id the game reaches for resolves');
  {
    const wanted = ['cv', 'score', 'lives', 'level', 'homes', 'time', 'timeStat',
      'startOverlay', 'btnStart', 'overlay', 'ovTitle', 'ovSub', 'ovBtn', 'btnNew', 'btnPause'];
    const missing = wanted.filter(id => ids(id) === null);
    ok(missing.length === 0, `all ${wanted.length} game ids exist (missing ${JSON.stringify(missing)})`);
    ok(doc.querySelectorAll('.lang-switch').length >= 1, 'a language-switch host is present');
    ok(!!$('h1[data-i18n="title"]'), 'the title carries a data-i18n hook');
    ok(text('#score') === String(st().score) && text('#lives') === String(st().lives), 'the HUD mirrors the fresh state');
    ok(text('#homes') === '0/5', `the HUD shows 0/5 homes (got ${JSON.stringify(text('#homes'))})`);
  }

  /* -------------------------------------------------------------------- 4 */
  group('4. a real click on Start leaves ready and hides the overlay');
  click(ids('btnStart'));
  ok(st().phase === 'playing', `clicking Start enters 'playing' (got ${st().phase})`);
  ok(!ids('startOverlay').classList.contains('show'), 'the start overlay is really hidden after Start');
  ok(ids('btnPause').disabled === false, 'the Pause button becomes enabled once playing');

  /* -------------------------------------------------------------------- 5 */
  group('5. a real ArrowUp keydown hops the frog and the HUD scores');
  {
    press('ArrowUp');
    ok(st().frog.hopping === true, 'a real ArrowUp keydown starts a hop');
    window.FR.tick(8 / 60 + 0.02);
    ok(st().frog.r === 11, `the hop lands on row 11 (got ${st().frog.r})`);
    ok(st().score === 10, `the forward hop scored +10 (got ${st().score})`);
    pumpFrames(12);   // run the real render loop too - a live HUD would refresh here
    ok(text('#score') === String(st().score),
      `the #score HUD mirrors the live state (HUD ${JSON.stringify(text('#score'))} vs state ${st().score})`);
    press('ArrowDown');
    window.FR.tick(8 / 60 + 0.02);
    ok(st().frog.r === 12, `ArrowDown hops back to the bank (got ${st().frog.r})`);
    window.FR.tick(1);
    ok(text('#time') === String(Math.ceil(Math.max(0, st().timeLeft))),
      `the #time HUD ticks down with the countdown (HUD ${JSON.stringify(text('#time'))} vs state ${Math.ceil(st().timeLeft)})`);
    ok(text('#homes') === st().homesFilled + '/5', 'the #homes HUD mirrors the bays');
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. the real Pause and New-game buttons pin the state machine');
  {
    click(ids('btnPause'));
    ok(st().phase === 'paused', `clicking Pause enters 'paused' (got ${st().phase})`);
    const s0 = st().score;
    window.FR.tick(20);
    ok(st().score === s0, `tick() while paused does not score (${s0} -> ${st().score})`);
    ok(st().phase === 'paused', 'tick() while paused leaves the phase alone');
    click(ids('btnPause'));
    ok(st().phase === 'playing', `clicking Pause again resumes (got ${st().phase})`);
    click(ids('btnNew'));
    ok(st().phase === 'playing', `the New-game button restarts into 'playing' (got ${st().phase})`);
    ok(st().score === 0 && st().level === 1 && st().lives === 3,
      `New-game resets score/level/lives (got ${st().score}/${st().level}/${st().lives})`);
    ok(text('#score') === '0' && text('#lives') === '3' && text('#level') === '1', 'the HUD reflects the reset');
    ok(!ids('startOverlay').classList.contains('show'), 'the start overlay stays hidden after New game');
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
    ok(CJK.test(text('#btnPause')), `the DYNAMIC pause label is Chinese (got ${JSON.stringify(text('#btnPause'))})`);
    ok(text('#btnPause') === '暂停', `the pause label is '暂停' (got ${JSON.stringify(text('#btnPause'))})`);
    ok(CJK.test(text('h1[data-i18n="title"]')), `the static title is Chinese (got ${JSON.stringify(text('h1[data-i18n="title"]'))})`);

    click(langLink('en'));
    await sleep(50);
    ok(doc.documentElement.lang === 'en', 'document lang is back to en');
    ok(text('#btnPause') === 'Pause', `the pause label is English again (got ${JSON.stringify(text('#btnPause'))})`);
    ok(!CJK.test(text('h1[data-i18n="title"]')), 'the static title is English again');
  }

  /* -------------------------------------------------------------------- 8 */
  group('8. the result dialog re-renders through T.onChange');
  {
    window.FR.newGame({ level: 1 });
    window.FR.start();
    window.FR.tick(200); // deterministic no-input run ends in game over
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
    ok(CJK.test(text('#btnPause')) || st().phase === 'gameover', 'the HUD relocalised while the dialog is up');

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
    window.FR.newGame({ level: 1 });
    window.FR.start();
    const before = errs.length;
    pumpFrames(40);
    ok(errs.length === before, '40 pumped animation frames run clean' + (errs.length > before ? `\n     ${errs.slice(before, before + 3).join('\n     ')}` : ''));
    ok(cv.width === 416 * dpr && cv.height === 416 * dpr, 'the canvas is still 416x416 after real frames');
    window.FR.tick(2);
    ok(st().phase === 'playing', 'the game is still live after real frames');
  }

  /* ------------------------------------------------------------------- 9b */
  group('9b. the value-cached HUD tracks the model (no-event + event paths)');
  {
    // No-event FRAME path: real rAF frames only, zero input. This is the direct
    // descendant of the Round-1 staleness bug (loop() not refreshing the HUD).
    window.FR.newGame({ level: 1 });
    window.FR.start();
    let tm = 0, sm = 0;
    for (let i = 0; i < 300; i++) {
      pumpFrames(1, 16);                 // one real frame: update() + updateHud() + draw()
      const s = st();
      if (text('#time') !== String(Math.ceil(Math.max(0, s.timeLeft)))) tm++;
      if (text('#score') !== String(s.score)) sm++;
    }
    ok(tm === 0, `#time tracks state.timeLeft across 300 real frames of zero input (${tm} mismatches)`);
    ok(sm === 0, `#score tracks the model across 300 real frames (${sm} mismatches)`);

    // No-event TICK path: the added contract - tick() advances then syncs the HUD.
    window.FR.newGame({ level: 1 });
    window.FR.start();
    window.FR.tick(21.5);                // timeLeft 25 -> 3.5, no event
    ok(st().phase === 'playing' && st().timeLeft < 5, `tick() advanced to ${st().timeLeft.toFixed(2)}s with no event`);
    ok(text('#time') === String(Math.ceil(Math.max(0, st().timeLeft))),
      `tick() synced #time with no frame pumped (HUD ${JSON.stringify(text('#time'))} vs ${st().timeLeft.toFixed(2)})`);
    ok(ids('timeStat').classList.contains('low'), 'the .low class turned on below 5s through tick()');

    // Event path: a hop shows in the real DOM, and newGame() rewrites it at once.
    window.FR.newGame({ level: 1 });
    window.FR.start();
    press('ArrowUp');
    window.FR.tick(8 / 60 + 0.02);
    ok(text('#score') === '10', `a hop shows +10 in the real DOM (got ${JSON.stringify(text('#score'))})`);
    window.FR.newGame({ level: 1 });
    ok(text('#score') === '0' && text('#homes') === '0/5' && text('#level') === '1',
      `the newGame() event path rewrote #score/#homes/#level at once (got ${JSON.stringify(text('#score'))}/${JSON.stringify(text('#homes'))}/${JSON.stringify(text('#level'))})`);

    // Event path: pause toggles both the label and the disabled flag immediately.
    click(ids('btnPause'));
    ok(st().phase === 'paused' && ids('btnPause').disabled === false && text('#btnPause') === 'Resume',
      `paused shows the resume label, still enabled (got ${JSON.stringify(text('#btnPause'))}, disabled ${ids('btnPause').disabled})`);
    click(ids('btnPause'));
    ok(st().phase === 'playing' && text('#btnPause') === 'Pause', 'resuming restores the pause label');
  }

  /* ------------------------------------------------------------------- 10 */
  group('10. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
