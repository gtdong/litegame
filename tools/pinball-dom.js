#!/usr/bin/env node
/**
 * Real-DOM check for pinball-game (a canvas-2D portrait pinball table).
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id, `querySelectorAll` returns an empty
 * array and the 2D context is a permissive Proxy; the vm suite has no DOM at
 * all. Both hide whole bug classes - a dangling id, a listener that was never
 * bound, a start overlay that never really hides, a plunger button that never
 * charges, a result dialog that never paints, or a language switcher that
 * mounts nothing. This script runs the page for real in jsdom and drives it
 * with real events:
 *
 *   - the page loads with zero jsdom errors and `window.PB` is live in 'ready';
 *   - the canvas really exists at 480x720, sits inside .stage, and the page
 *     reaches for its 2D context exactly through the stub (never a native one -
 *     this box has no `canvas` package, so a real getContext would return null
 *     and crash the game with a MISLEADING unrelated assertion failure);
 *   - a real click on Start leaves ready, hides the start overlay, enables the
 *     flipper and launch buttons, and the HUD (#score/#best/#ball) mirrors the
 *     bridge model;
 *   - real pointerdown/pointerup on the flipper and launch buttons and real
 *     keydown/keyup for a/d/arrows/space/Enter drive the same state machine,
 *     and the plunger really charges then fires;
 *   - a whole game is driven to the result overlay (via PB.tick + one paint),
 *     the buttons are disabled in the wrong phases, and the real Play-again
 *     button restarts;
 *   - clicking the real 简体中文 link inside [data-lang-switch] re-localises the
 *     DYNAMIC HUD and the open overlay and flips document.documentElement.lang.
 *
 * Determinism: requestAnimationFrame is captured (not auto-scheduled) and the
 * test owns a VIRTUAL clock - `performance.now()` and the frame timestamp both
 * come from `window.__advance(ms)` - so the run is reproducible instead of
 * racing wall time. The game reads the frame timestamp to compute dt, so the
 * virtual clock is what makes a headless run repeatable.
 *
 * Failure-path discipline: a LOCAL target (the default, a relative path,
 * 127.0.0.1, or anything that is not an explicit remote http(s) URL) prints a
 * labelled `HARNESS ERROR ...` and exits 1 when it cannot load - a dead server
 * must never masquerade as a passing run. Only an explicitly passed non-local
 * http(s) URL may skip with exit 0.
 *
 * Usage:
 *   cd <repo-root> && python3 -m http.server 8123 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> node tools/pinball-dom.js [url]
 */

'use strict';

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('HARNESS ERROR: jsdom is not installed; run with NODE_PATH=<isolated-node-modules>');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8123;
const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}/pinball-game/`;
const FORCED = !!process.argv[2];

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CJK = /[\u4e00-\u9fff]/;

function probe(url, ms) {
  return new Promise(res => {
    let done = false;
    const fin = v => { if (!done) { done = true; res(v); } };
    const req = http.get(url, r => { r.resume(); fin(r.statusCode); });
    req.on('error', () => fin(0));
    req.setTimeout(ms || 800, () => { req.destroy(); fin(0); });
  });
}

async function resolveTarget(argv) {
  if (argv) return { url: argv, owned: null };
  if (await probe(DEFAULT_URL) === 200) {
    note(`using the server already listening on :${DEFAULT_PORT}`);
    return { url: DEFAULT_URL, owned: null };
  }
  for (let port = 8137; port < 8200; port++) {
    if (await probe(`http://127.0.0.1:${port}/`) !== 0) continue;   // something is there
    const url = `http://127.0.0.1:${port}/pinball-game/`;
    const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
      { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      if (await probe(url) === 200) { note(`started a private server on :${port}`); return { url, owned: child }; }
    }
    child.kill();
  }
  return { url: DEFAULT_URL, owned: null };   // will fail to load -> exit 1
}

(async () => {
  const resolved = await resolveTarget(FORCED ? process.argv[2] : null);
  const TARGET = resolved.url;
  const owned = resolved.owned;
  const killOwned = () => { if (owned && !owned.killed) owned.kill(); };
  process.on('exit', killOwned);

  const isHttp = /^https?:\/\//i.test(TARGET);
  const isLocalTarget = !isHttp || /127\.0\.0\.1|localhost/i.test(TARGET);
  const explicitlyRemote = FORCED && isHttp && !isLocalTarget;
  const SETTLE = isLocalTarget ? 1200 : 4000;   // first paint / remote needs longer

  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));

  const opts = {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      /* jsdom ships no 2D canvas without the optional native `canvas` package.
       * The game treats the canvas as write-only (geometry is owned by constants
       * and never read back), so a chainable callable Proxy keeps this harness
       * running AND exercises the game's real draw path. Count the calls so the
       * suite can prove the real context was never needed. */
      window.__ctxCalls = 0;
      window.HTMLCanvasElement.prototype.getContext = function () {
        window.__ctxCalls++;
        const el = this;
        const noop = new Proxy(function () {}, {
          apply: () => noop,
          get: (t, k) => (k === 'canvas' ? el : (k === 'then' ? undefined : noop))
        });
        return noop;
      };
      /* jsdom returns an all-zero rect; give the canvas a real one. */
      window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
        return { left: 0, top: 0, right: 480, bottom: 720, width: 480, height: 720, x: 0, y: 0 };
      };
      /* Capture rAF and pin the clock so the test owns the frame timeline. The
       * frame timestamp AND performance.now() both come from __advance(ms). */
      let cb = null, clock = 0;
      window.requestAnimationFrame = fn => { cb = fn; return 1; };
      window.cancelAnimationFrame = () => { cb = null; };
      window.__advance = ms => { clock += (ms === undefined ? 16 : ms); };
      window.__pump = ts => { const f = cb; cb = null; if (f) f(ts === undefined ? clock : ts); };
      window.__now = () => clock;
      try {
        Object.defineProperty(window.performance, 'now', { value: () => clock, configurable: true, writable: true });
      } catch (e) { /* older jsdom: assertions stay valid */ }
    }
  };

  let dom;
  try {
    dom = await JSDOM.fromURL(TARGET, opts);
  } catch (e) {
    /* Only an explicitly-passed REMOTE http(s) URL may skip: it may point at a
     * page that is not deployed yet. A LOCAL target - the default, a bare path,
     * 127.0.0.1 - must exit 1, or "the server is down" would look like a pass. */
    const msg = (e && e.message) || e;
    if (explicitlyRemote) {
      console.log(`SKIP: could not load ${TARGET} (${msg})`);
      killOwned();
      process.exit(0);
    }
    console.log(`HARNESS ERROR: could not load ${TARGET} (${msg})`);
    killOwned();
    process.exit(1);
  }
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  await new Promise(r => window.addEventListener('load', () => setTimeout(r, SETTLE)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const byId = id => doc.getElementById(id);
  const txt = id => { const n = byId(id); return n ? n.textContent : ''; };
  const cls = id => { const n = byId(id); return n ? n.classList : null; };
  const PB = () => window.PB;
  const st = () => window.PB.getState();

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function pd(node, type) {   // pointer event (MouseEvent carries the right type)
    node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  function key(type, k) {
    doc.dispatchEvent(new window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, view: window }));
  }
  function pump(n, ms) {
    for (let i = 0; i < (n || 1); i++) { window.__advance(ms === undefined ? 16 : ms); window.__pump(); }
  }
  /* Bounded frame pump: the loop only runs the frames the test hands it. */
  function framesUntil(pred, maxFrames) {
    let i = 0;
    while (i++ < maxFrames) { if (pred()) return true; pump(1); }
    return pred();
  }
  const langLink = code => [...doc.querySelectorAll('[data-lang-switch] a')].find(a => a.getAttribute('data-lang') === code);

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean, the bridge is live and the real canvas is wired');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.PB, 'window.PB bridge exists in the real page');
  const api = ['world', 'mulberry32', 'nextRandom', 'segmentClosestPoint', 'circleVsSegment',
    'circleVsCircle', 'circleVsAabb', 'reflect', 'flipperAngle', 'launchVelocity', 'bumperScore',
    'stepBall', 'maxStepDisplacement', 'thinnestCollider', 'energyCeiling', 'toLogical',
    'getState', 'hudCache', 'log', 'newGame', 'start', 'pause', 'resume', 'togglePause',
    'setFlipper', 'chargePlunger', 'launch', 'nudge', 'tick'];
  ok(api.every(k => typeof window.PB[k] === 'function'),
    `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.PB[k] !== 'function'))})`);
  ok(window.PB.constants && window.PB.constants.W === 480 && window.PB.constants.H === 720,
    `the constants are live (W=${window.PB.constants && window.PB.constants.W}, H=${window.PB.constants && window.PB.constants.H})`);
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().ballsLeft === 3 && st().score === 0 && st().ballNo === 1 && st().awaitingLaunch === true,
    `a fresh game is 3 balls, score 0, ball 1, plunger armed (got ${st().ballsLeft}/${st().score}/${st().ballNo}/${st().awaitingLaunch})`);

  const cv = byId('cv');
  ok(!!cv && cv.tagName === 'CANVAS', `#cv is a real <canvas> (got ${cv && cv.tagName})`);
  ok(cv && cv.width === 480 && cv.height === 720, `the canvas backing store is 480x720 (got ${cv && cv.width}x${cv && cv.height})`);
  ok(!!$('.stage') && $('.stage').contains(cv), '#cv is inside .stage (the render container)');
  ok(errs.length === 0 && window.__ctxCalls >= 1,
    `the page booted with the stub 2D context and no canvas crash (getContext calls ${window.__ctxCalls})`);
  const ctx = cv.getContext('2d');
  ok(!!ctx && typeof ctx.beginPath === 'function', 'the canvas hands back a usable (stubbed) 2D context');

  const wanted = ['cv', 'score', 'best', 'ball', 'streak', 'charge', 'msg', 'btnLeft', 'btnLaunch',
    'btnRight', 'btnNew', 'startOverlay', 'btnStart', 'overlay', 'ovTitle', 'ovSub', 'ovBtn'];
  const missing = wanted.filter(id => byId(id) === null);
  ok(missing.length === 0, `all ${wanted.length} game ids resolve in the real DOM (missing ${JSON.stringify(missing)})`);
  ok(!!cls('startOverlay') && cls('startOverlay').contains('show'), 'the start overlay is visible on load');
  ok(!!cls('overlay') && !cls('overlay').contains('show'), 'the result overlay is hidden at boot');
  ok(doc.querySelectorAll('[data-lang-switch]').length === 1, 'a single language-switch host is present');
  ok(doc.querySelectorAll('[data-lang-switch] a').length === 2, 'the switcher mounted two links');

  /* -------------------------------------------------------------------- 2 */
  group('2. buttons are disabled in the wrong phases and a real Start click works');
  ok(byId('btnLaunch').disabled === true, 'Launch is disabled in ready');
  ok(byId('btnLeft').disabled === true && byId('btnRight').disabled === true, 'the flipper buttons are disabled in ready');
  ok(byId('btnStart') && byId('btnStart').tagName === 'BUTTON', '#btnStart is a real <button>');

  click(byId('btnStart'));
  pump(1);
  ok(st().phase === 'playing', `clicking Start enters 'playing' (got ${st().phase})`);
  ok(!cls('startOverlay').contains('show'), 'the start overlay is really hidden after Start');
  ok(byId('btnLaunch').disabled === false, 'Launch is enabled once playing and armed');
  ok(byId('btnLeft').disabled === false && byId('btnRight').disabled === false, 'the flipper buttons are enabled once playing');
  ok(txt('score') === String(st().score) && txt('best') === String(st().best),
    `the HUD mirrors the model (score ${txt('score')}/${st().score}, best ${txt('best')}/${st().best})`);
  ok(/^\d+ \/ \d+$/.test(txt('ball')), `#ball reads "n / t" (got ${JSON.stringify(txt('ball'))})`);

  /* -------------------------------------------------------------------- 3 */
  group('3. real pointer + key input drives the flippers and the plunger');
  pd(byId('btnLeft'), 'pointerdown');
  ok(st().flippers.left.pressed === true, 'a real pointerdown on Left presses the left flipper');
  pd(byId('btnLeft'), 'pointerup');
  ok(st().flippers.left.pressed === false, 'a real pointerup releases it');

  key('keydown', 'a');
  ok(st().flippers.left.pressed === true, "a real 'a' keydown presses the left flipper");
  key('keyup', 'a');
  ok(st().flippers.left.pressed === false, "a real 'a' keyup releases it");
  key('keydown', 'ArrowRight');
  ok(st().flippers.right.pressed === true, "a real ArrowRight keydown presses the right flipper");
  key('keyup', 'ArrowRight');
  ok(st().flippers.right.pressed === false, 'and its keyup releases it');

  /* Hold the plunger, watch it charge, then release and fire. */
  pd(byId('btnLaunch'), 'pointerdown');
  pump(20);                                   // ~0.33 s of charging
  const chargeMid = st().charge;
  ok(chargeMid > 0 && chargeMid < 1, `holding Launch really charges the plunger (charge ${chargeMid.toFixed(3)})`);
  ok(txt('charge') === Math.round(chargeMid * 100) + '%', `#charge reflects the charge (${txt('charge')})`);
  pd(byId('btnLaunch'), 'pointerup');
  ok(st().awaitingLaunch === false, 'releasing Launch fires the ball into play');
  pump(1);
  ok(byId('btnLaunch').disabled === true, 'Launch is disabled once the ball is in flight');
  ok(st().log.some(e => e.type === 'launch'), 'a launch event was logged');

  /* A real Space key charges then fires on a fresh game. */
  click(byId('btnNew'));
  pump(1);
  ok(st().phase === 'playing' && st().awaitingLaunch === true, 'the New-game button restarts into an armed game');
  key('keydown', ' ');
  pump(10);
  ok(st().charge > 0, `a real Space keydown charges the plunger (charge ${st().charge.toFixed(3)})`);
  key('keyup', ' ');
  ok(st().awaitingLaunch === false, 'a real Space keyup fires the ball');

  /* -------------------------------------------------------------------- 4 */
  group('4. a whole game reaches the result overlay; Play-again restarts');
  let guard = 0;
  while (st().phase !== 'over' && guard++ < 200) { window.PB.tick(1 / 3, 1 / 60); }
  pump(1);                                    // one paint so the overlay class settles
  ok(st().phase === 'over' && st().over === true, `the game reaches 'over' (got ${st().phase})`);
  ok(cls('overlay').contains('show'), 'the result overlay is shown (has the show class)');
  ok(!cls('startOverlay').contains('show'), 'the start overlay is hidden at the end');
  ok(txt('ovTitle').trim().length > 0, `the result title is painted (got ${JSON.stringify(txt('ovTitle'))})`);
  ok(/\d/.test(txt('ovSub')), `the result body carries the score (got ${JSON.stringify(txt('ovSub'))})`);
  ok(byId('btnLeft').disabled === true && byId('btnRight').disabled === true, 'the flipper buttons are disabled in over');
  ok(byId('btnLaunch').disabled === true, 'Launch is disabled in over');

  click(byId('ovBtn'));
  pump(1);
  ok(st().phase === 'playing' && st().score === 0, `the real Play-again button restarts a fresh game (phase ${st().phase}, score ${st().score})`);
  ok(!cls('overlay').contains('show'), 'the result overlay is hidden after the restart');

  /* A real Enter key also restarts: drive to over again, then press Enter. */
  guard = 0;
  while (st().phase !== 'over' && guard++ < 200) { window.PB.tick(1 / 3, 1 / 60); }
  pump(1);
  ok(st().phase === 'over', 'the second run also reaches over');
  key('keydown', 'Enter');
  pump(1);
  ok(st().phase === 'playing', `a real Enter keydown starts a new game (got ${st().phase})`);

  /* -------------------------------------------------------------------- 4b */
  group('4b. the real HUD is REPAINTED from the model, not just the initial markup');
  {
    /* The trap this guards: comparing hudCache to getState (or #score to the
     * model while it is still '0') passes without updateHud() ever writing the
     * DOM node - the markup already says "0". So assert the REAL DOM TEXT vs a
     * NON-ZERO model value, and require the text to CHANGE as the model moves. */
    const CS = window.PB.constants;
    click(byId('btnNew'));
    pump(1);
    ok(txt('ball') === '1 / 3', `#ball starts "1 / 3" on a fresh game (got ${JSON.stringify(txt('ball'))})`);
    const scoreSeen = new Set([txt('score')]), ballSeen = new Set([txt('ball')]);
    let hudBad = 0, g = 0;
    while (st().phase !== 'over' && g++ < 240) {
      window.PB.tick(1 / 3, 1 / 60);
      const s = st();
      if (txt('score') !== String(s.score)) hudBad++;
      if (txt('best') !== String(s.best)) hudBad++;
      if (txt('charge') !== Math.round(s.charge * 100) + '%') hudBad++;
      const bm = txt('ball').match(/^(\d+) \/ (\d+)$/);
      if (!bm || Number(bm[1]) !== s.ballNo || Number(bm[2]) !== CS.BALLS) hudBad++;
      const mult = Math.round(Math.min(1 + CS.STREAK_STEP * s.streak, CS.STREAK_MAX_MULT) * 100) / 100;
      if (txt('streak') !== '\u00d7' + mult) hudBad++;
      scoreSeen.add(txt('score'));
      ballSeen.add(txt('ball'));
    }
    pump(1);
    const overScore = st().score;
    ok(hudBad === 0, `#score/#best/#charge/#ball/#streak mirror the model on every sample (${hudBad} bad)`);
    ok(overScore > 0, `the driven game ended with a non-zero score (${overScore})`);
    ok(txt('score') === String(overScore) && txt('score') !== '0',
      `#score is REPAINTED from the model at over (DOM ${JSON.stringify(txt('score'))} == model ${overScore})`);
    ok(txt('best') === String(st().best) && Number(txt('best')) > 0,
      `#best is repainted from the model at over (DOM ${JSON.stringify(txt('best'))} == model ${st().best})`);
    const distinct = [...scoreSeen];
    ok(scoreSeen.size >= 2 && distinct[distinct.length - 1] === String(overScore),
      `#score text really CHANGED as the model score rose (samples ${JSON.stringify(distinct)})`);
    ok(ballSeen.has('2 / 3') && ballSeen.has('3 / 3'),
      `#ball text really advanced as balls were lost (saw ${JSON.stringify([...ballSeen])})`);
  }

  /* -------------------------------------------------------------------- 5 */
  group('5. real language click re-localises the dynamic HUD and the open overlay');
  {
    const zhLink = langLink('zh');
    const enLink = langLink('en');
    ok(!!zhLink && !!enLink, 'there are en and zh links');
    ok(!!zhLink && zhLink.tagName === 'A' && zhLink.textContent === '简体中文',
      `the zh link is an <a> labelled 简体中文 (got ${zhLink && zhLink.tagName}/${zhLink && JSON.stringify(zhLink.textContent)})`);

    const enMsg = txt('msg'), enNew = txt('btnNew');
    ok(enMsg.length > 0 && !CJK.test(enMsg), `#msg starts English (got ${JSON.stringify(enMsg)})`);
    ok(enNew.length > 0 && !CJK.test(enNew), `#btnNew starts English (got ${JSON.stringify(enNew)})`);

    click(zhLink);
    await sleep(60);
    ok(doc.documentElement.lang === 'zh-CN', `document lang is zh-CN after the click (got ${doc.documentElement.lang})`);
    ok(window.localStorage.getItem('litegame_lang') === 'zh', 'the choice is persisted to localStorage');
    ok(CJK.test(txt('msg')) && txt('msg') !== enMsg, `the DYNAMIC #msg is Chinese via T.onChange (got ${JSON.stringify(txt('msg'))})`);
    ok(CJK.test(txt('btnNew')) && txt('btnNew') !== enNew, `the DYNAMIC #btnNew is Chinese (got ${JSON.stringify(txt('btnNew'))})`);

    /* Open the result dialog, then flip language and confirm it re-renders. */
    guard = 0;
    while (st().phase !== 'over' && guard++ < 200) { window.PB.tick(1 / 3, 1 / 60); }
    pump(1);
    ok(cls('overlay').contains('show') && CJK.test(txt('ovTitle')),
      `the OPEN overlay is Chinese (title ${JSON.stringify(txt('ovTitle'))})`);
    const zhTitle = txt('ovTitle');
    click(enLink);
    await sleep(60);
    ok(doc.documentElement.lang === 'en', 'document lang is back to en');
    ok(!CJK.test(txt('ovTitle')) && txt('ovTitle') !== zhTitle,
      `flipping to en re-renders the open overlay (got ${JSON.stringify(txt('ovTitle'))})`);
    click(zhLink);
    await sleep(60);
    ok(CJK.test(txt('msg')), 'the HUD re-localises again after the second flip');
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. the virtual-clock rAF loop advances the model reproducibly');
  {
    click(byId('btnNew'));
    pump(1);
    const c0 = st().clock, s0 = st().score;
    let monotone = true, nan = 0, prev = c0;
    for (let i = 0; i < 120; i++) {
      pump(1, 16);
      const s = st();
      if (s.clock < prev) monotone = false;
      prev = s.clock;
      if (!isFinite(s.ball.x) || !isFinite(s.ball.y) || !isFinite(s.ball.vx) || !isFinite(s.ball.vy)) nan++;
    }
    ok(st().clock > c0, `pumping 120 frames advanced the model clock (${c0.toFixed(2)} -> ${st().clock.toFixed(2)} s)`);
    ok(monotone, 'the model clock is monotonic across pumped frames');
    ok(st().score >= s0, `the score never decreases across frames (${s0} -> ${st().score})`);
    ok(nan === 0, 'no NaN appears in the ball state across 120 real frames');
    ok(errs.length === 0, 'no jsdom errors while pumping real frames');
  }

  /* -------------------------------------------------------------------- 7 */
  group('7. runtime errors and the canvas stub');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));
  ok(window.__ctxCalls >= 1, `the page only ever used the stubbed 2D context (${window.__ctxCalls} getContext calls)`);
  ok(cv.width === 480 && cv.height === 720, 'the canvas stayed 480x720 after real frames');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('(real jsdom; canvas stub + virtual clock from tools/invaders-dom.js; '
    + 'real clicks/pointer/key events; the dynamic i18n switch driven through the real link)');
  killOwned();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
