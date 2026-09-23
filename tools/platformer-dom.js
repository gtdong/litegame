#!/usr/bin/env node
/**
 * Real-DOM check for platformer-game.
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id, `querySelectorAll` returns an empty
 * array and the canvas context is a permissive Proxy; the vm sandbox has no DOM
 * at all. Both hide whole bug classes - a dangling id, a listener that was never
 * bound, a canvas that is not really on the page, a language switcher that never
 * mounts, or a start overlay that never actually hides. This script runs the
 * page for real in jsdom (with the native `canvas` package, so
 * `getContext('2d')` is genuine) and drives it with real events:
 *
 *   - the page loads with zero jsdom errors and `window.PF` is live in 'ready';
 *   - the canvas really exists, is 512x288, sits inside .stage and the start
 *     overlay is showing while the result overlay is hidden;
 *   - a real click on Start leaves ready and hides the overlay;
 *   - a real ArrowRight / ArrowLeft keydown moves the box2d player, a real Space
 *     keydown starts a jump, and the HUD mirrors PF.getState();
 *   - the real Pause / New-game buttons pin the state machine;
 *   - the language switcher is a set of <a> (not <button>) and clicking the real
 *     简体中文 link re-renders the DYNAMIC pause label / result dialog through
 *     T.onChange, as well as the STATIC <h1 data-i18n> and start-overlay title;
 *   - pumping the real rAF loop never throws (draw() runs against a real 2d
 *     context), and the value-cached HUD tracks the model across real frames.
 *
 * Determinism: requestAnimationFrame is captured (not auto-scheduled) and the
 * test pumps frames explicitly, while game state is advanced through `PF.tick()`
 * - so the run is repeatable instead of racing real timers. The page's loop()
 * derives dt from performance.now(), so that is pinned to a counter the test
 * advances too.
 *
 * Usage:
 *   cd <repo-root> && python3 -m http.server 8123 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> node tools/platformer-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy (or the
 * deployed page) can be fed to the same script to prove it is not vacuous.
 * A file:// URL will not work: jsdom throws a DOMException on localStorage under
 * file://, so always serve over http and pass the http URL.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8123/platformer-game/';
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
    // Capture rAF so the test owns the frame clock (PF.tick drives the sim);
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
    // An explicitly-passed REMOTE url may point at a page that is not deployed
    // yet; that is a skip, not a failure. But a LOCAL target - including the
    // default - must never exit 0 on a failed load: a typo in the argument, a
    // dead http server or a page that throws on boot would otherwise masquerade
    // as a passing run. A bare path is not a remote url either.
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
  const st = () => window.PF.getState();
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
    const c = chunk || 1 / 120;
    let t = 0;
    while (t < seconds) { window.PF.tick(c, c); t += c; if (pred()) return { ok: true, t }; }
    return { ok: false, t };
  }
  const langLink = code => [...doc.querySelectorAll('.lang-switch a')].find(a => a.getAttribute('data-lang') === code);

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.PF, 'window.PF bridge exists in the real page');
  const api = ['levels', 'levelAt', 'legend', 'tileAt', 'isSolid', 'isOneWay', 'isHazard', 'standTiles',
    'simulateJump', 'playerState', 'enemies', 'enemyAt', 'collectedCoins', 'hudCache',
    'newGame', 'start', 'pause', 'move', 'jump', 'restartLevel', 'loadLevel', 'tick', 'getState',
    'rngHash', 'nextRandom'];
  ok(api.every(k => typeof window.PF[k] === 'function'),
    `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.PF[k] !== 'function'))})`);
  ok(window.PF.TILE === 16 && window.PF.COLS === 32 && window.PF.ROWS === 18 && window.PF.WIDTH === 512 && window.PF.HEIGHT === 288,
    `TILE/COLS/ROWS/WIDTH/HEIGHT are 16/32/18/512/288 (got ${window.PF.TILE}/${window.PF.COLS}/${window.PF.ROWS}/${window.PF.WIDTH}/${window.PF.HEIGHT})`);
  ok(window.PF.GRAVITY === 1800 && window.PF.JUMP_V === -520 && window.PF.MAX_FALL === 900 && window.PF.WALK === 175 && window.PF.RUN === 265,
    `the physics constants are 1800/-520/900/175/265 (got ${window.PF.GRAVITY}/${window.PF.JUMP_V}/${window.PF.MAX_FALL}/${window.PF.WALK}/${window.PF.RUN})`);
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().lives === 3 && st().score === 0 && st().level === 1, `fresh state is 3 lives / 0 / level 1 (got ${st().lives}/${st().score}/${st().level})`);
  ok(st().coinsTotal === window.PF.levelAt(1).coins.length && st().coins === 0,
    `level 1 starts with 0 earned of ${st().coinsTotal} coins (got ${st().coins})`);
  ok(Math.abs(st().timeLeft - 120) < 1e-9, `the level countdown starts at 120s (got ${st().timeLeft})`);
  ok(window.PF.levels().length === 10, 'levels() returns all ten levels');

  /* -------------------------------------------------------------------- 2 */
  group('2. the real canvas and overlays exist in the DOM');
  const cv = ids('cv');
  const dpr = window.devicePixelRatio || 1;
  ok(!!cv, '#cv exists');
  ok(cv && cv.tagName === 'CANVAS', `#cv is a <canvas> (got ${cv && cv.tagName})`);
  ok(cv && cv.width === 512 * dpr && cv.height === 288 * dpr,
    `the canvas backing store is 512x288 (dpr ${dpr}) (got ${cv && cv.width}x${cv && cv.height})`);
  ok(cv && typeof cv.getContext === 'function' && !!cv.getContext('2d'), 'the canvas returns a real 2d context');
  ok(!!$('.stage') && $('.stage').contains(cv), '#cv is inside .stage (the render container)');
  ok(cv && String(cv.style.aspectRatio || '').indexOf('512') === 0, `the canvas aspect-ratio is pinned to 512/288 (got ${cv && cv.style.aspectRatio})`);
  const startOverlay = ids('startOverlay');
  ok(!!startOverlay && startOverlay.classList.contains('show'), 'the start overlay is visible on load');
  ok(!!startOverlay && !!startOverlay.querySelector('.dialog'), 'the start overlay holds a dialog');
  ok(!!ids('overlay') && !ids('overlay').classList.contains('show'), 'the result overlay is hidden at boot');
  ok(!!ids('btnPause') && ids('btnPause').tagName === 'BUTTON' && ids('btnPause').disabled === true,
    'the Pause button is a disabled <button> in ready');
  ok(!!ids('btnStart') && ids('btnStart').tagName === 'BUTTON', '#btnStart is a real <button>');
  ok(!!ids('btnJump') && ids('btnJump').tagName === 'BUTTON', '#btnJump is a real <button>');

  /* -------------------------------------------------------------------- 3 */
  group('3. every id the game reaches for resolves');
  {
    const wanted = ['cv', 'score', 'lives', 'level', 'coins', 'time', 'timeStat', 'best',
      'btnPause', 'btnNew', 'btnLeft', 'btnRight', 'btnJump',
      'startOverlay', 'btnStart', 'overlay', 'ovTitle', 'ovSub', 'ovBtn'];
    const missing = wanted.filter(id => ids(id) === null);
    ok(missing.length === 0, `all ${wanted.length} game ids exist (missing ${JSON.stringify(missing)})`);
    ok(doc.querySelectorAll('.lang-switch').length >= 1, 'a language-switch host is present');
    ok(!!$('h1[data-i18n="title"]'), 'the title carries a data-i18n hook');
    ok(text('#score') === String(st().score) && text('#lives') === String(st().lives) && text('#level') === String(st().level),
      'the HUD mirrors the fresh state');
    ok(text('#coins') === st().coins + '/' + st().coinsTotal, `the HUD shows ${st().coins}/${st().coinsTotal} coins (got ${JSON.stringify(text('#coins'))})`);
  }

  /* -------------------------------------------------------------------- 4 */
  group('4. a real click on Start leaves ready and hides the overlay');
  click(ids('btnStart'));
  ok(st().phase === 'playing', `clicking Start enters 'playing' (got ${st().phase})`);
  ok(!ids('startOverlay').classList.contains('show'), 'the start overlay is really hidden after Start');
  ok(ids('btnPause').disabled === false, 'the Pause button becomes enabled once playing');

  /* -------------------------------------------------------------------- 5 */
  group('5. real keydowns steer the player and really jump');
  {
    const x0 = st().player.x;
    press('ArrowRight');
    window.PF.tick(0.4, 1 / 120);
    ok(st().player.x > x0, `a real ArrowRight keydown drives the player right (${x0.toFixed(1)} -> ${st().player.x.toFixed(1)})`);
    ok(st().player.facing === 1, `moving right sets the facing direction (facing=${st().player.facing})`);
    release('ArrowRight');
    const x1 = st().player.x;
    press('ArrowLeft');
    window.PF.tick(0.2, 1 / 120);
    ok(st().player.x < x1, `a real ArrowLeft keydown drives the player left (${x1.toFixed(1)} -> ${st().player.x.toFixed(1)})`);
    release('ArrowLeft');

    press(' ');
    window.PF.tick(1 / 120, 1 / 120);
    ok(st().player.vy < 0 || !st().player.onGround, `a real Space keydown launches a jump (vy=${st().player.vy.toFixed(1)}, onGround=${st().player.onGround})`);
    release(' ');
    pumpFrames(20);
    ok(text('#score') === String(st().score) && text('#level') === String(st().level),
      `the HUD mirrors the model after real frames (score=${text('#score')}/${st().score})`);
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. the real Pause and New-game buttons pin the state machine');
  {
    click(ids('btnPause'));
    ok(st().phase === 'paused', `clicking Pause enters 'paused' (got ${st().phase})`);
    const fr = st();
    window.PF.tick(3, 1 / 120);
    ok(st().phase === 'paused' && st().timeLeft === fr.timeLeft, `tick() while paused does not advance the level (${fr.timeLeft.toFixed(2)} -> ${st().timeLeft.toFixed(2)})`);
    ok(text('#btnPause') === 'Resume', `paused shows the Resume label (got ${JSON.stringify(text('#btnPause'))})`);
    click(ids('btnPause'));
    ok(st().phase === 'playing', `clicking Pause again resumes (got ${st().phase})`);
    ok(text('#btnPause') === 'Pause', 'resuming restores the Pause label');

    window.PF.tick(1, 1 / 120);
    click(ids('btnNew'));
    ok(st().phase === 'playing', `the New-game button restarts into 'playing' (got ${st().phase})`);
    ok(st().score === 0 && st().lives === 3 && st().level === 1 && st().coins === 0,
      `New-game resets score/lives/level/coins (got ${st().score}/${st().lives}/${st().level}/${st().coins})`);
    ok(text('#score') === '0' && text('#lives') === '3' && text('#level') === '1', 'the HUD reflects the reset');
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
    ok(CJK.test(text('h1[data-i18n="title"]')), `the STATIC title is Chinese (got ${JSON.stringify(text('h1[data-i18n="title"]'))})`);
    ok(text('#btnPause') === '暂停', `the DYNAMIC pause label is 暂停 via T.onChange (got ${JSON.stringify(text('#btnPause'))})`);
    ok(CJK.test(text('#startOverlay h2')), `the start-overlay title is Chinese (got ${JSON.stringify(text('#startOverlay h2'))})`);
    ok(CJK.test(text('[data-i18n="coins"]')), 'the static Coins label is Chinese');

    click(langLink('en'));
    await sleep(50);
    ok(doc.documentElement.lang === 'en', 'document lang is back to en');
    ok(text('#btnPause') === 'Pause', `the pause label is English again (got ${JSON.stringify(text('#btnPause'))})`);
    ok(!CJK.test(text('h1[data-i18n="title"]')), 'the static title is English again');
  }

  /* -------------------------------------------------------------------- 8 */
  group('8. the result dialog re-renders through T.onChange');
  {
    // Walk off the ledge three times to reach game over on the real page.
    window.PF.newGame({ seed: 1, level: 1 });
    for (let d = 0; d < 6 && st().phase !== 'gameover'; d++) {
      window.PF.move(1);
      tickUntil(() => st().phase === 'dying', 10, 1 / 120);
      tickUntil(() => st().phase !== 'dying', 5, 1 / 120);
    }
    window.PF.move(0);
    ok(st().phase === 'gameover', `driving no input into the ledge reaches 'gameover' (got ${st().phase})`);
    ok(ids('overlay').classList.contains('show'), 'the result overlay is shown on game over');
    ok(text('#ovTitle') === 'Game over', `the result title is the English 'Game over' (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(/\d/.test(text('#ovSub')), `the result subtitle carries the score (got ${JSON.stringify(text('#ovSub'))})`);

    click(langLink('zh'));
    await sleep(50);
    ok(text('#ovTitle') === '游戏结束', `the OPEN dialog re-renders in Chinese via T.onChange (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(/\d/.test(text('#ovSub')), `the Chinese subtitle still carries the score (got ${JSON.stringify(text('#ovSub'))})`);
    ok(CJK.test(text('#ovBtn')), `the result button is Chinese (got ${JSON.stringify(text('#ovBtn'))})`);

    click(ids('ovBtn'));
    ok(st().phase === 'playing' && st().score === 0 && st().level === 1, `the real result button restarts the game (phase ${st().phase}, score ${st().score})`);
    ok(!ids('overlay').classList.contains('show'), 'the result overlay is hidden after restart');

    click(langLink('en'));
    await sleep(50);
  }

  /* -------------------------------------------------------------------- 9 */
  group('9. pumping the real rAF loop never throws');
  {
    window.PF.newGame({ seed: 1, level: 1 });
    window.PF.start();
    const before = errs.length;
    pumpFrames(40);
    ok(errs.length === before, '40 pumped animation frames run clean' + (errs.length > before ? `\n     ${errs.slice(before, before + 3).join('\n     ')}` : ''));
    ok(cv.width === 512 * dpr && cv.height === 288 * dpr, 'the canvas is still 512x288 after real frames');
    window.PF.tick(2, 1 / 120);
    ok(st().phase === 'playing', 'the game is still live after real frames');
  }

  /* ------------------------------------------------------------------- 9b */
  group('9b. the value-cached HUD tracks the model across real frames');
  {
    window.PF.newGame({ seed: 1, level: 1 });
    window.PF.start();
    let tm = 0, sm = 0, cm = 0;
    for (let i = 0; i < 300; i++) {
      pumpFrames(1, 16);                 // one real frame: update() + updateHud() + draw()
      const s = st();
      if (text('#time') !== String(Math.ceil(Math.max(0, s.timeLeft)))) tm++;
      if (text('#score') !== String(s.score)) sm++;
      if (text('#level') !== String(s.level)) cm++;
    }
    ok(tm === 0, `#time tracks state.timeLeft across 300 real frames of zero input (${tm} mismatches)`);
    ok(sm === 0, `#score tracks the model across 300 real frames (${sm} mismatches)`);
    ok(cm === 0, `#level tracks the model across 300 real frames (${cm} mismatches)`);
    ok(text('#coins') === st().coins + '/' + st().coinsTotal, 'the coin HUD is in sync after real frames');

    // Event path: a real jump + tick shows through the DOM immediately.
    window.PF.newGame({ seed: 1, level: 1 });
    window.PF.start();
    press('ArrowRight');
    window.PF.tick(1.0, 1 / 120);
    release('ArrowRight');
    ok(text('#score') === String(st().score) && text('#coins') === st().coins + '/' + st().coinsTotal,
      `the event path rewrote the HUD (score ${JSON.stringify(text('#score'))}, coins ${JSON.stringify(text('#coins'))})`);
  }

  /* ------------------------------------------------------------------- 10 */
  group('10. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
