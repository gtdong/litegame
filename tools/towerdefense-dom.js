#!/usr/bin/env node
/**
 * Real-DOM check for towerdefense-game.
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id, `querySelectorAll` returns an empty
 * array and the canvas context is a permissive Proxy; the vm sandbox has no DOM
 * at all. Both hide whole bug classes - a dangling id, a listener that was never
 * bound, a canvas click that maps to the wrong tile, an overlay that never
 * hides, or a language switcher that never mounts. This script runs the page for
 * real in jsdom and drives it with real events:
 *
 *   - the page loads with zero jsdom errors and `window.TD` is live in 'ready';
 *   - a real click on Start leaves ready and hides the start overlay;
 *   - a real click on the Gun button then a real click on a buildable tile
 *     (clientX/clientY -> `evToCanvas`) actually builds; the tower is on the
 *     board, gold dropped by 50 and the HUD follows;
 *   - a real click on that tower selects it, and the real Upgrade / Sell buttons
 *     change its level and refund floor(invested*0.7);
 *   - the HUD text (#gold/#lives/#wave/#speed) always mirrors TD.getState();
 *   - real keydowns (Space, 1/2/3, p, Escape) drive the same transitions;
 *   - the language switcher is a set of <a> and clicking the real 简体中文 link
 *     re-renders the DYNAMIC #nextInfo through T.onChange;
 *   - a bridge-driven run reaches 'win', shows the result overlay and the real
 *     result button restarts into 'playing'.
 *
 * jsdom NOTE: jsdom ships no 2D canvas unless the optional native `canvas`
 * package is present, and its `getBoundingClientRect()` returns zeros with no
 * `offsetX`. Both are stubbed below, because the game's `evToCanvas()` relies on
 * them to map a click to a tile (640 x 384 logical == CSS size, so a tile centre
 * is `col*32+16, row*32+16`).
 *
 * Usage:
 *   cd <repo-root> && python3 -m http.server 8123 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> node tools/towerdefense-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy (or the
 * deployed page) can be fed to the same script to prove it is not vacuous.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8123/towerdefense-game/';
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
    beforeParse(window) {
      // 1. jsdom has no 2D context without the optional native `canvas` package.
      // The game treats the canvas as write-only, so a self-referential callable
      // Proxy keeps the real render path running (createLinearGradient-style
      // chaining still works because every get returns the Proxy again).
      window.HTMLCanvasElement.prototype.getContext = function () {
        const el = this;
        const noop = new Proxy(function () {}, {
          apply: () => noop,
          get: (t, k) => (k === 'canvas' ? el : (k === 'then' ? undefined : noop))
        });
        return noop;
      };
      // 2. jsdom returns a 0x0 rect for every element and implements no offsetX;
      // evToCanvas() needs a real rect to map clientX/clientY onto the 640x384
      // logical canvas, so pin it for every element (the canvas is the only one
      // the game reads back).
      window.HTMLElement.prototype.getBoundingClientRect = function () {
        return { left: 0, top: 0, right: 640, bottom: 384, width: 640, height: 384 };
      };
      // Capture rAF so the test owns the frame clock (TD.tick drives the sim);
      // the loop still runs when the test calls window.__pump().
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
  const st = () => window.TD.getState();
  const ids = o => doc.getElementById(o);

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function clickAt(node, x, y) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
  }
  function press(key) {
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, view: window }));
  }
  function tileClick(col, row) { clickAt(ids('cv'), col * 32 + 16, row * 32 + 16); }
  const langLink = code => [...doc.querySelectorAll('.lang-switch a')].find(a => a.getAttribute('data-lang') === code);
  function tickUntil(pred, seconds, chunk) {
    const c = chunk || 0.1;
    let t = 0;
    while (t < seconds) { window.TD.tick(c, 1 / 60); t += c; if (pred()) return true; }
    return false;
  }

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.TD, 'window.TD bridge exists in the real page');
  const api = ['towers', 'towerSpec', 'enemies', 'waves', 'path', 'blocked',
    'buildable', 'buildableSlots', 'isOnPath', 'pathLength', 'pathPointAt', 'tileAtPoint', 'pointOnPath',
    'exposureSeconds', 'towerDps', 'goldAvailableByWave', 'waveHpTotal', 'waveArmorWeightedHp', 'bestKillBudget', 'waveFeasibilityRatio',
    'towerAt', 'builtTowers', 'towerList', 'enemyAt', 'enemyList', 'waveState', 'gold', 'lives', 'hudCache',
    'newGame', 'start', 'pause', 'setSpeed', 'selectTowerType', 'placeTower', 'upgradeTower', 'sellTower', 'callNextWave', 'tick', 'getState', 'loadWave'];
  ok(api.every(k => typeof window.TD[k] === 'function'),
    `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.TD[k] !== 'function'))})`);
  ok(window.TD.TILE === 32 && window.TD.COLS === 20 && window.TD.ROWS === 12 && window.TD.WIDTH === 640 && window.TD.HEIGHT === 384,
    `TILE/COLS/ROWS/WIDTH/HEIGHT are 32/20/12/640/384 (got ${window.TD.TILE}/${window.TD.COLS}/${window.TD.ROWS}/${window.TD.WIDTH}/${window.TD.HEIGHT})`);
  ok(window.TD.START_GOLD === 220 && window.TD.START_LIVES === 20 && window.TD.WAVE_COUNT === 12 &&
    window.TD.SELL_RATE === 0.7 && window.TD.SAMPLE_STEP === 4 && window.TD.NEXT_WAVE_DELAY === 6,
    'the economy / sampling constants are the documented values');
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().lives === 20 && st().gold === 220 && st().wave === 1, `fresh state is 20 lives / 220 gold / wave 1 (got ${st().lives}/${st().gold}/${st().wave})`);
  ok(window.TD.pathLength() === 1216 && window.TD.buildableSlots().length === 190,
    'pathLength() is 1216 and there are 190 buildable tiles');

  /* -------------------------------------------------------------------- 2 */
  group('2. the real canvas and overlays exist in the DOM');
  const cv = ids('cv');
  ok(!!cv && cv.tagName === 'CANVAS', `#cv is a real <canvas> (got ${cv && cv.tagName})`);
  ok(cv && cv.width === 640 && cv.height === 384, `the canvas backing store is 640x384 (got ${cv && cv.width}x${cv && cv.height})`);
  ok(cv && typeof cv.getContext === 'function' && !!cv.getContext('2d'), 'the canvas returns a 2d context');
  ok(!!$('.stage') && $('.stage').contains(cv), '#cv sits inside .stage');
  const startOverlay = ids('startOverlay');
  ok(!!startOverlay && startOverlay.classList.contains('show'), 'the start overlay is visible on load');
  ok(!!ids('overlay') && !ids('overlay').classList.contains('show'), 'the result overlay is hidden at boot');

  const wanted = ['cv', 'score', 'lives', 'gold', 'wave', 'speed', 'nextInfo', 'selInfo',
    'btnGun', 'btnCannon', 'btnFrost', 'btnUpgrade', 'btnSell', 'btnCall', 'btnPause', 'btnSpeed', 'btnNew',
    'startOverlay', 'btnStart', 'overlay', 'ovTitle', 'ovSub', 'ovBtn'];
  const missing = wanted.filter(id => ids(id) === null);
  ok(missing.length === 0, `all ${wanted.length} game ids resolve in the real DOM (missing ${JSON.stringify(missing)})`);
  ok(doc.querySelectorAll('.lang-switch').length >= 1, 'a language-switch host is present');
  ok(!!$('h1[data-i18n="title"]'), 'the title carries a data-i18n hook');
  ok(text('#wave') === '1/12' && text('#speed') === '1\u00d7', `the HUD boots as 1/12 and 1× (got ${JSON.stringify(text('#wave'))}/${JSON.stringify(text('#speed'))})`);

  /* -------------------------------------------------------------------- 3 */
  group('3. a real click on Start leaves ready and hides the overlay');
  click(ids('btnStart'));
  ok(st().phase === 'playing', `clicking Start enters 'playing' (got ${st().phase})`);
  ok(!ids('startOverlay').classList.contains('show'), 'the start overlay is really hidden after Start');
  ok(ids('btnPause').disabled === false, 'the Pause button becomes enabled once playing');

  /* -------------------------------------------------------------------- 4 */
  group('4. real canvas clicks build, select, upgrade and sell');
  click(ids('btnGun'));
  ok(st().selectedType === 'gun', `clicking #btnGun selects the gun (got ${st().selectedType})`);

  // Pick a slot the game itself calls buildable, then click its centre.
  const slot = window.TD.buildableSlots().find(s => !window.TD.towerAt(s.col, s.row));
  const goldBefore = st().gold;
  tileClick(slot.col, slot.row);
  ok(window.TD.towerAt(slot.col, slot.row) !== null,
    `a real canvas click on buildable (${slot.col},${slot.row}) builds a tower (got ${JSON.stringify(window.TD.towerAt(slot.col, slot.row))})`);
  ok(st().gold === goldBefore - 50, `building the gun costs 50 (${goldBefore} -> ${st().gold})`);
  ok(text('#gold') === String(st().gold), `#gold follows the build (got ${JSON.stringify(text('#gold'))})`);

  // Select the tower, upgrade it, then sell it.
  tileClick(slot.col, slot.row);
  ok(st().selected && st().selected.col === slot.col && st().selected.row === slot.row,
    `clicking the tower selects its tile (got ${JSON.stringify(st().selected)})`);
  const goldPreUp = st().gold;
  click(ids('btnUpgrade'));
  ok(window.TD.towerAt(slot.col, slot.row).level === 2, `the Upgrade button raises the tower to L2 (got ${window.TD.towerAt(slot.col, slot.row).level})`);
  ok(st().gold === goldPreUp - window.TD.towerSpec('gun').levels[1].cost,
    `upgrading costs upgradeCost ${window.TD.towerSpec('gun').levels[1].cost} (${goldPreUp} -> ${st().gold})`);
  const goldPreSell = st().gold;
  const invested = 50 + window.TD.towerSpec('gun').levels[1].cost;
  click(ids('btnSell'));
  ok(window.TD.towerAt(slot.col, slot.row) === null, 'the Sell button removes the tower');
  ok(st().gold === goldPreSell + Math.floor(invested * 0.7),
    `selling refunds floor(${invested}*0.7)=${Math.floor(invested * 0.7)} (got ${st().gold - goldPreSell})`);

  /* -------------------------------------------------------------------- 5 */
  group('5. the HUD text always mirrors getState()');
  {
    window.TD.newGame({ seed: 1, wave: 1 }); window.TD.start();
    let bad = 0;
    for (let i = 0; i < 60; i++) {
      window.TD.tick(0.25, 1 / 60);
      const s = st();
      if (text('#gold') !== String(s.gold)) bad++;
      if (text('#lives') !== String(s.lives)) bad++;
      if (text('#wave') !== s.wave + '/12') bad++;
      if (text('#speed') !== s.speed + '\u00d7') bad++;
    }
    ok(bad === 0, `#gold/#lives/#wave/#speed track getState across 60 ticks (${bad} mismatches)`);
    ok(text('#wave') === st().wave + '/12' && text('#speed') === st().speed + '\u00d7',
      `the wave/speed HUD is well-formed (${JSON.stringify(text('#wave'))}, ${JSON.stringify(text('#speed'))})`);
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. real keyboard input drives the same state machine');
  {
    window.TD.newGame({ seed: 1, wave: 1 });
    ok(st().phase === 'ready', 'a fresh game is back in ready');
    press(' ');                                       // Space starts from ready
    ok(st().phase === 'playing', `Space starts the game from ready (got ${st().phase})`);

    press('2');
    ok(st().selectedType === 'cannon', `key "2" selects the cannon (got ${st().selectedType})`);
    press('3');
    ok(st().selectedType === 'frost', `key "3" selects the frost (got ${st().selectedType})`);
    press('1');
    ok(st().selectedType === 'gun', `key "1" selects the gun (got ${st().selectedType})`);

    press('Escape');
    ok(st().selectedType === null, `Escape clears the selection (got ${st().selectedType})`);

    press('p');
    ok(st().phase === 'paused', `key "p" pauses (got ${st().phase})`);
    ok(text('#btnPause') === 'Resume', `paused shows the Resume label (got ${JSON.stringify(text('#btnPause'))})`);
    press('p');
    ok(st().phase === 'playing', `key "p" resumes (got ${st().phase})`);
    ok(text('#btnPause') === 'Pause', 'resuming restores the Pause label');

    // Space during a wave calls the next wave early (settles the bonus).
    const g0 = st().gold;
    press(' ');
    ok(st().gold > g0, `Space during a wave cashes the clear bonus (${g0} -> ${st().gold})`);
  }

  /* -------------------------------------------------------------------- 7 */
  group('7. the real button bar works');
  {
    window.TD.newGame({ seed: 1, wave: 1 }); window.TD.start();
    click(ids('btnSpeed'));
    ok(st().speed === 2 && text('#speed') === '2\u00d7', `#btnSpeed toggles to 2× (got ${st().speed}, ${JSON.stringify(text('#speed'))})`);
    click(ids('btnSpeed'));
    ok(st().speed === 1 && text('#speed') === '1\u00d7', '#btnSpeed toggles back to 1×');

    click(ids('btnPause'));
    ok(st().phase === 'paused', `#btnPause pauses (got ${st().phase})`);
    click(ids('btnPause'));
    ok(st().phase === 'playing', '#btnPause resumes');

    window.TD.tick(1, 1 / 60);
    click(ids('btnNew'));
    ok(st().phase === 'playing' && st().score === 0 && st().lives === 20 && st().wave === 1,
      `#btnNew resets to playing/0/20/wave1 (got ${st().phase}/${st().score}/${st().lives}/${st().wave})`);
    ok(text('#score') === '0' && text('#lives') === '20' && text('#wave') === '1/12', 'the HUD reflects the reset');
  }

  /* -------------------------------------------------------------------- 8 */
  group('8. a bridge-driven run reaches win and the real result button restarts');
  {
    window.TD.newGame({ seed: 1, wave: 12 }); window.TD.start();
    // Build one tower for flavour, then cash through the last wave.
    const s0 = window.TD.buildableSlots()[0];
    window.TD.placeTower(s0.col, s0.row, 'cannon');
    let guard = 0;
    while (st().phase === 'playing' && guard++ < 30) window.TD.callNextWave();
    ok(st().phase === 'win', `driving wave 12 to completion reaches 'win' (got ${st().phase})`);
    ok(ids('overlay').classList.contains('show'), 'the result overlay is shown on a win');
    ok(text('#ovTitle').length > 0, `the result title is non-empty (got ${JSON.stringify(text('#ovTitle'))})`);
    ok(!ids('startOverlay').classList.contains('show'), 'the start overlay stays hidden at the result');

    click(ids('ovBtn'));
    ok(st().phase === 'playing' && st().score === 0 && st().wave === 1,
      `the real result button restarts into 'playing' (phase ${st().phase}, wave ${st().wave})`);
    ok(!ids('overlay').classList.contains('show'), 'the result overlay is hidden after restart');
  }

  /* -------------------------------------------------------------------- 9 */
  group('9. the language switcher is <a> and real clicks re-localise');
  {
    const links = [...doc.querySelectorAll('.lang-switch a')];
    ok(links.length === 2, `the switcher rendered two links (got ${links.length})`);
    ok(links.length === 2 && links.every(a => a.tagName === 'A'), 'both switcher entries are <a>, not <button>');
    ok(!!langLink('zh') && !!langLink('en'), 'there are en and zh links');

    window.TD.newGame({ seed: 1, wave: 1 }); window.TD.start();
    const enInfo = text('#nextInfo');
    ok(!CJK.test(enInfo) && enInfo.length > 0, `#nextInfo starts English (got ${JSON.stringify(enInfo)})`);

    click(langLink('zh'));
    await sleep(50);
    ok(doc.documentElement.lang === 'zh-CN', `document lang is zh-CN after the click (got ${doc.documentElement.lang})`);
    ok(window.localStorage.getItem('litegame_lang') === 'zh', 'the choice is persisted to localStorage');
    ok(CJK.test(text('#nextInfo')), `the DYNAMIC #nextInfo is Chinese via T.onChange (got ${JSON.stringify(text('#nextInfo'))})`);
    ok(CJK.test(text('h1[data-i18n="title"]')), `the STATIC title is Chinese (got ${JSON.stringify(text('h1[data-i18n="title"]'))})`);
    ok(CJK.test(text('#btnGun')) && /\d/.test(text('#btnGun')), `the tower button is Chinese with its price (got ${JSON.stringify(text('#btnGun'))})`);

    click(langLink('en'));
    await sleep(50);
    ok(doc.documentElement.lang === 'en', 'document lang is back to en');
    ok(!CJK.test(text('#nextInfo')), `#nextInfo is English again (got ${JSON.stringify(text('#nextInfo'))})`);
  }

  /* ------------------------------------------------------------------- 10 */
  group('10. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
