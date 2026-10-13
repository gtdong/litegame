#!/usr/bin/env node
/**
 * Real-DOM check for runner-game (an endless 3-lane runner, pure DOM+CSS).
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById` lazily
 * invents an element for ANY id, `querySelectorAll` returns an empty array and
 * the 2D context is a permissive Proxy; the vm sandbox has no DOM at all. Both
 * hide whole bug classes - a dangling id, a listener that was never bound, a
 * start overlay that never really hides, painted obstacle nodes that never track
 * the model, a language switch that mounts nothing, or a best score that is never
 * written back. This script runs the page for real in jsdom and drives it with
 * real events:
 *
 *   - the page loads with zero jsdom errors and `window.RN` is live in 'ready';
 *   - the page uses NO canvas at all (0 <canvas> elements, 0 getContext calls);
 *   - every id the game reaches for resolves in the real DOM, the overlays exist
 *     and the language switcher mounted two <a> links;
 *   - a real click on Start leaves 'ready', hides the start overlay, and enables
 *     all five movement/pause controls; while 'ready' all five are disabled
 *     (a control that cannot act is disabled) and a synthetic click is inert;
 *   - real keydowns (arrows / a / d / space / w / s) and real clicks on the
 *     on-screen buttons drive the same state machine;
 *   - the PAINTED DOM really repaints from the model: the player's --lane/--y
 *     custom properties, its state classes, and every visible hazard's
 *     lane/--x/data-kind/top/width/height are compared to an independent model
 *     on every pumped frame, and the painted field really CHANGES as it advances;
 *   - the HUD is repainted at a NON-INITIAL value (#score != '0' after it rises,
 *     and the node's text really CHANGES between samples);
 *   - the over overlay appears with the record, and Play-again restarts;
 *   - the language switcher is <a>, and a real click re-localises the DYNAMIC HUD
 *     and the OPEN overlay (via T.onChange) and the static data-i18n markup.
 *
 * Determinism: requestAnimationFrame is captured (not auto-scheduled) and the
 * test owns a VIRTUAL clock - `performance.now()` and the frame timestamp both
 * come from `window.__advance(ms)` - so the run is reproducible.
 *
 * Failure-path discipline: a LOCAL target (the default, a relative path,
 * 127.0.0.1, or any bare path/directory argument) prints a labelled
 * `HARNESS ERROR ...` and exits 1 when it cannot load. Only an explicitly passed
 * non-local http(s) URL may skip with exit 0.
 *
 * ⚠️ Do not reuse a server from an earlier session: HTTP_PROXY is set on this box,
 * so node can only reach a server THIS session started. The harness always starts
 * its own `python3 -m http.server` on a free port and kills it on exit.
 *
 * Usage:
 *   NODE_PATH=<isolated-node-modules> node tools/runner-dom.js [url]
 *   NODE_PATH=<isolated-node-modules> node tools/runner-dom.js --selftest
 *
 * `--selftest` reverse-validates THIS layer: it serves a patched copy of the page
 * (in memory - nothing on disk is touched) for each of 7 deliberate rendering
 * defects and asserts the matching DOM guard goes red while the unmodified page
 * stays green. A mutation that is not caught exits non-zero.
 */

'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('HARNESS ERROR: jsdom is not installed; run with NODE_PATH=<isolated-node-modules>');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const ARG = process.argv[2];

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
    req.setTimeout(ms || 600, () => { req.destroy(); fin(0); });
  });
}

/* Always start our OWN server (never reuse): on this box HTTP_PROXY makes curl
 * reach stale localhost servers while node cannot. */
async function ownServer() {
  for (let port = 8300; port < 8400; port++) {
    if (await probe(`http://127.0.0.1:${port}/`) !== 0) continue;   // already in use
    const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
      { cwd: ROOT, stdio: 'ignore' });
    const url = `http://127.0.0.1:${port}/runner-game/`;
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      if (await probe(url) === 200) { note(`started a private server on :${port}`); return { url, child }; }
    }
    child.kill();
  }
  return { url: null, child: null };
}

/* jsdom options shared by the main run and the --selftest probes. The canvas
 * stub, the pinned clock and the captured rAF all live here. */
function makeOpts(errs) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));
  return {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      /* The game uses NO canvas. Install a counting callable-Proxy stub anyway so
       * a real getContext can never crash the harness - and so we can assert the
       * page never asked for one (the game is pure DOM+CSS). */
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
      window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
        return { left: 0, top: 0, right: 288, bottom: 448, width: 288, height: 448, x: 0, y: 0 };
      };
      /* Capture rAF and pin the clock so the test owns the frame timeline. */
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
}

/* Independent model of what render() must paint at distance `dist`, recomputed
 * from the published pure functions and NEVER read back from the DOM. Mirrors
 * render()'s kStart/kEnd window, its gap filter and its POOL_SIZE cap. Defined at
 * module scope (taking the bridge as an argument) so the --selftest probes can
 * point it at a patched page. */
function modelHazards(RNx, dist) {
  const w = RNx.world(), C = RNx.constants, d = dist;
  const VIEW_AHEAD = w.groundY;                 // source: var VIEW_AHEAD = GROUND_Y
  const kStart = Math.max(0, Math.floor((d - C.SLOT0) / C.SLOT_GAP) - 1);
  const kEnd = Math.floor((d + VIEW_AHEAD - C.SLOT0) / C.SLOT_GAP) + 2;
  const out = [];
  for (let k = kStart; k <= kEnd; k++) {
    const h = RNx.hazardAt(k);
    if (!h) continue;
    const gap = h.s - d;
    if (gap < -100 || gap > VIEW_AHEAD + 60) continue;
    if (h.kind === 'empty') continue;
    const base = w.groundY - gap;               // documented geometry: ground - remaining
    for (const bl of h.blocked) {
      let bw, bh, top;
      if (h.kind === 'high') {
        bw = C.HAZARD_HIGH_W; bh = C.HAZARD_HIGH_H;
        top = base - C.HAZARD_HIGH_CLEAR - C.HAZARD_HIGH_H;
      } else {
        bw = h.w; bh = h.h; top = base - h.h;
      }
      out.push({
        lane: bl,
        x: C.LANE_W * (bl + 0.5) - bw / 2,
        kind: (h.kind === 'wall') ? 'full' : h.kind,
        top: top, w: bw, h: bh
      });
      if (out.length >= C.POOL_SIZE) return out;   // render() stops at the pool cap
    }
  }
  return out;
}

/* Independent model of the coins render() could show. `taken[k]` is internal, so
 * a coin already collected may be absent from the DOM: the model is an upper
 * bound and every painted coin must be a MEMBER of it. */
function modelCoins(RNx, dist) {
  const w = RNx.world(), C = RNx.constants, d = dist;
  const VIEW_AHEAD = w.groundY;
  const kStart = Math.max(0, Math.floor((d - C.SLOT0) / C.SLOT_GAP) - 1);
  const kEnd = Math.floor((d + VIEW_AHEAD - C.SLOT0) / C.SLOT_GAP) + 2;
  const set = new Set();
  for (let k = kStart; k <= kEnd; k++) {
    const h = RNx.hazardAt(k);
    if (!h || !h.coin) continue;
    const gap = h.s - d;
    if (gap < -100 || gap > VIEW_AHEAD + 60) continue;
    set.add(h.coin.lane + ':' + (C.LANE_W * (h.coin.lane + 0.5) - C.COIN_R));
  }
  return set;
}

/* ==========================================================================
 * --selftest: prove THIS DOM layer is not vacuous.
 * The vm layer is reverse-validated by 8 source injections. This is the DOM
 * layer's equivalent: for each deliberate RENDERING defect we serve a patched
 * copy of runner-game/index.html from an in-memory http server (NOTHING on disk
 * is touched), boot it in jsdom, drive a real run, and assert the ONE DOM-derived
 * measurement that guards the defect goes RED - while the unmodified page stays
 * GREEN. A mutation that is not caught means the layer has a hole, so the
 * selftest exits non-zero.
 * ======================================================================== */

/* Each entry: an exact source splice + the measurement it must break. */
const MUTATIONS = [
  { name: 'the --lane write is deleted (the player lane is no longer painted)',
    from: "setVar(playerEl, '--lane', lane);", to: 'void 0;',
    red: m => m.laneBad > 0, why: 'the painted --lane must stop matching getState().lane' },
  { name: 'the --y write is deleted (the jump height is no longer painted)',
    from: "setVar(playerEl, '--y', y);", to: 'void 0;',
    red: m => m.yBad > 0, why: 'the painted --y must stop matching getState().y' },
  { name: "a hazard's --x is shifted +7px",
    from: "setVar(el, '--x', laneXOf(bl) - w / 2);", to: "setVar(el, '--x', laneXOf(bl) - w / 2 + 7);",
    red: m => m.hazXBad > 0, why: 'the hazard --x must stop matching the model geometry' },
  /* The source writes data-kind TWICE (setAttribute + dataset.kind), so the
   * mutation must remove both writes or it is not a real defect. */
  { name: 'data-kind is never set on a hazard node',
    from: "el.setAttribute('data-kind', domKind);\n          el.dataset.kind = domKind;", to: 'void 0;',
    red: m => m.hazKindBad > 0, why: 'the hazard data-kind must stop matching low/high/full' },
  { name: 'used hazard nodes are never shown (display left off)',
    from: 'show(el, true);', to: 'void 0;',
    red: m => m.hazSeen === 0, why: 'no visible .hazard node must ever appear' },
  { name: 'the #speed HUD write is deleted',
    from: 'if (c.speed !== spTxt) { speedEl.textContent = spTxt; c.speed = spTxt; }',
    to: 'if (false) { speedEl.textContent = spTxt; c.speed = spTxt; }',
    red: m => m.hudBad > 0, why: '#speed must stay at its initial markup 0.00' },
  { name: '#btnPause is never disabled in ready',
    from: 'var pauseDis = (phase === \'ready\');', to: 'var pauseDis = false;',
    red: m => m.pauseReady === false, why: '#btnPause.disabled must read false while ready' }
];

/* Boot `html` (with the sibling assets/i18n.js) from a throwaway in-memory
 * server, drive a real run, and return the DOM-derived measurements. */
async function measurePatched(html, i18nJs) {
  const files = { '/runner-game/': html, '/assets/i18n.js': i18nJs };
  const srv = http.createServer((req, res) => {
    const key = req.url.split('?')[0];
    if (Object.prototype.hasOwnProperty.call(files, key)) {
      res.writeHead(200, {
        'content-type': key.endsWith('.js')
          ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'
      });
      res.end(files[key]);
    } else { res.writeHead(404); res.end(''); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const errs = [];
  let dom;
  try {
    dom = await JSDOM.fromURL(`http://127.0.0.1:${port}/runner-game/`, makeOpts(errs));
    const { window } = dom;
    await new Promise(r => window.addEventListener('load', () => setTimeout(r, 250)));
    const d = window.document, RNx = window.RN, stx = () => RNx.getState();
    const pump = (n, ms) => {
      for (let i = 0; i < (n || 1); i++) { window.__advance(ms === undefined ? 16 : ms); window.__pump(); }
    };
    const byId = id => d.getElementById(id);
    const readVar = (el, n) => el.style.getPropertyValue(n);

    /* The ready-state pause gate is observed BEFORE start(). */
    RNx.newGame({ seed: 1 });
    const pauseReady = byId('btnPause').disabled;
    const speedBoot = byId('speed').textContent;
    RNx.start(); pump(1);

    let samples = 0, laneBad = 0, yBad = 0, hazCountBad = 0, hazXBad = 0, hazKindBad = 0, hazSeen = 0, hudBad = 0;
    const model = modelHazards;
    for (let i = 0; i < 300; i++) {
      RNx.tick(1 / 30, 1 / 60);
      if (stx().phase !== 'playing') break;
      pump(1); samples++;
      const s = stx(), pl = byId('player');
      if (!(parseFloat(readVar(pl, '--lane')) === s.lane)) laneBad++;
      if (!(Math.abs(parseFloat(readVar(pl, '--y')) - s.y) <= 1e-6)) yBad++;
      const dh = [...d.querySelectorAll('#hazardLayer .hazard')].filter(e => e.style.display !== 'none');
      if (dh.length) hazSeen++;
      const mh = model(RNx, s.distance);
      if (dh.length !== mh.length) hazCountBad++;
      else for (let j = 0; j < mh.length; j++) {
        if (dh[j].getAttribute('data-kind') !== mh[j].kind) { hazKindBad++; break; }
        if (!(Math.abs(parseFloat(readVar(dh[j], '--x')) - mh[j].x) <= 0.01)) { hazXBad++; break; }
      }
      if (byId('speed').textContent !== RNx.speedAt(s.distance).toFixed(2)) hudBad++;
    }
    return { errs: errs.length, samples, laneBad, yBad, hazCountBad, hazXBad, hazKindBad, hazSeen, hudBad, pauseReady, speedBoot };
  } finally {
    try { if (dom) dom.window.close(); } catch (e) { /* ignore */ }
    await new Promise(r => srv.close(r));
  }
}

async function selfTest() {
  const srcPath = path.join(ROOT, 'runner-game', 'index.html');
  const i18nPath = path.join(ROOT, 'assets', 'i18n.js');
  let src, i18nJs;
  try {
    src = require('fs').readFileSync(srcPath, 'utf8');
    i18nJs = require('fs').readFileSync(i18nPath, 'utf8');
  } catch (e) {
    /* Failure-only path. Node's fs error embeds the ABSOLUTE repo root, which
     * must not reach a public repo: scrub it to the <repo-root> placeholder
     * before printing. */
    const msg = String((e && e.message) || e).split(ROOT).join('<repo-root>');
    console.log(`HARNESS ERROR: cannot read the page for --selftest (${msg})`);
    process.exit(1);
  }

  console.log('\n[selftest] baseline: the UNMODIFIED page must be green on every measurement');
  const base = await measurePatched(src, i18nJs);
  const baseClean = base.errs === 0 && base.samples > 20 && base.laneBad === 0 && base.yBad === 0 &&
    base.hazCountBad === 0 && base.hazXBad === 0 && base.hazKindBad === 0 && base.hazSeen > 0 &&
    base.hudBad === 0 && base.pauseReady === true;
  console.log(`  ${baseClean ? 'ok  ' : 'FAIL'} unmodified page is green (${JSON.stringify(base)})`);

  let caught = 0, missed = 0;
  console.log('\n[selftest] each injected rendering defect must turn its guard RED');
  for (const mu of MUTATIONS) {
    const patched = src.split(mu.from).join(mu.to);
    if (patched === src) {
      missed++;
      console.log(`  FAIL ${mu.name}\n       the splice target was not found in the source: ${JSON.stringify(mu.from)}`);
      continue;
    }
    const m = await measurePatched(patched, i18nJs);
    const ok = !!mu.red(m);
    if (ok) caught++; else missed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${mu.name} -> ${ok ? 'RED as required' : 'stayed GREEN'} (${mu.why})`);
    if (!ok) console.log(`       measurements: ${JSON.stringify(m)}`);
  }

  const passN = 1 + caught, failN = (baseClean ? 0 : 1) + missed;
  console.log(`\n[selftest] ${passN} passed, ${failN} failed  (${caught}/${MUTATIONS.length} injected defects caught)`);
  process.exit(failN ? 1 : 0);
}

const SELFTEST = process.argv.includes('--selftest');

(async () => {
  if (SELFTEST) { await selfTest(); return; }
  /* A bare path or a directory argument is not loadable as an http target: it is
   * a hard error, never a skip. */
  if (ARG && !/^https?:\/\//i.test(ARG)) {
    console.log(`HARNESS ERROR: target is not an http(s) URL: ${ARG}`);
    process.exit(1);
  }

  const isRemoteArg = !!ARG && !/127\.0\.0\.1|localhost/i.test(ARG);
  let owned = null, TARGET = ARG;
  if (!TARGET) {
    const s = await ownServer();
    if (!s.url) { console.log('HARNESS ERROR: could not start a local http.server'); process.exit(1); }
    TARGET = s.url; owned = s.child;
  }
  const killOwned = () => { if (owned && !owned.killed) owned.kill(); };
  process.on('exit', killOwned);
  const isLocalTarget = /127\.0\.0\.1|localhost/i.test(TARGET);
  const explicitlyRemote = isRemoteArg && !isLocalTarget && /^https?:\/\//i.test(TARGET);
  const SETTLE = isLocalTarget ? 1200 : 4000;

  const errs = [];
  const opts = makeOpts(errs);

  let dom;
  try {
    dom = await JSDOM.fromURL(TARGET, opts);
  } catch (e) {
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
  const RN = () => window.RN;
  const st = () => window.RN.getState();

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  /* Real pointer events (PointerEvent exists in this jsdom). The buttons are
   * wired to `click`, so a tap's pointerdown/up are dispatched on top of the
   * click to exercise any listener that ever switches to pointer events. */
  function pointer(node, type) {
    const Ctor = window.PointerEvent || window.MouseEvent;
    node.dispatchEvent(new Ctor(type, {
      bubbles: true, cancelable: true, view: window,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }));
  }
  function key(type, k) {
    doc.dispatchEvent(new window.KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, view: window }));
  }
  function pump(n, ms) {
    for (let i = 0; i < (n || 1); i++) { window.__advance(ms === undefined ? 16 : ms); window.__pump(); }
  }
  const langLink = code => [...doc.querySelectorAll('[data-lang-switch] a')].find(a => a.getAttribute('data-lang') === code);

  /* The painted layers. The game paints a pool of `.hazard` divs inside
   * #hazardLayer and a pool of `.coin` divs inside #coinLayer, and toggles each
   * node's `display`. Positions live in inline custom properties (--lane/--x/--y)
   * which jsdom keeps, so every painted value can be read back for real. */
  const visibleHazards = () => [...doc.querySelectorAll('#hazardLayer .hazard')]
    .filter(el => el.style.display !== 'none');
  const visibleCoins = () => [...doc.querySelectorAll('#coinLayer .coin')]
    .filter(el => el.style.display !== 'none');
  const varOf = (el, name) => el.style.getPropertyValue(name);
  const numOf = (el, name) => { const v = varOf(el, name); return v === '' ? NaN : parseFloat(v); };

  /* Independent models of what render() must paint are defined at MODULE scope
   * (modelHazards / modelCoins, below) so the --selftest probes can reuse them
   * against a patched page. They take (bridge, distance) and read nothing else. */

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean, the bridge is live, and the page uses NO canvas');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.RN, 'window.RN bridge exists in the real page');
  const api = ['world', 'mulberry32', 'levelAt', 'speedAt', 'slotS', 'slotCount', 'hazardAt',
    'hazardsBetween', 'timeBetween', 'reactionBudget', 'jumpApex', 'jumpAirtime', 'slideDuration',
    'laneChangeTime', 'toPixel', 'getState', 'hudCache', 'log', 'newGame', 'start', 'pause',
    'resume', 'togglePause', 'moveLane', 'jump', 'slide', 'tick'];
  ok(api.every(k => typeof window.RN[k] === 'function'),
    `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.RN[k] !== 'function'))})`);
  ok(!!window.RN.constants && window.RN.constants.LANE_COUNT === 3 && window.RN.constants.VIEW_W === 288,
    `the constants are live (LANE_COUNT=${window.RN.constants && window.RN.constants.LANE_COUNT}, VIEW_W=${window.RN.constants && window.RN.constants.VIEW_W})`);
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().distance === 0 && st().score === 0 && st().coinCount === 0,
    `a fresh game is distance 0 / score 0 / 0 coins (got ${st().distance}/${st().score}/${st().coinCount})`);
  ok(!!RN().world() && RN().world().laneCount === 3, 'world() reports 3 lanes in the real page');
  ok(doc.querySelectorAll('canvas').length === 0, `the page contains no <canvas> at all (${doc.querySelectorAll('canvas').length})`);
  ok(window.__ctxCalls === 0, `the page never called getContext (calls ${window.__ctxCalls})`);

  /* -------------------------------------------------------------------- 2 */
  group('2. every id resolves; the overlays and the language switcher exist');
  {
    const used = [...doc.documentElement.outerHTML.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
    const defined = new Set([...doc.querySelectorAll('[id]')].map(e => e.id));
    const missing = [...new Set(used)].filter(id => !defined.has(id));
    ok(missing.length === 0, `every getElementById target resolves in the real DOM (${new Set(used).size} ids; missing ${JSON.stringify(missing)})`);
    ok(used.length > 0, `the page references ${new Set(used).size} ids through getElementById`);

    /* The FROZEN contract: exactly these ids exist (the HUD family is six numeric
     * nodes, each `<span class="stat"><small data-i18n=..></small> <b id=..>`, and
     * the play area is #track > (#hazardLayer, #coinLayer, #player)). */
    const wanted = ['track', 'player', 'hazardLayer', 'coinLayer', 'fxLayer',
      'score', 'best', 'level', 'speed', 'coins', 'msg',
      'btnLeft', 'btnJump', 'btnSlide', 'btnRight', 'btnPause', 'btnNew',
      'startOverlay', 'btnStart', 'overlay', 'ovTitle', 'ovSub', 'ovBtn'];
    const miss = wanted.filter(id => byId(id) === null);
    ok(miss.length === 0, `the ${wanted.length} pinned ids resolve (missing ${JSON.stringify(miss)})`);

    /* HUD shape: the five CONTRACT nodes are <b id=..> inside <span class="stat">
     * with a <small data-i18n=..>. #distance is checked the same way only IF the
     * page ships it - per the ruling, its presence must not gate anything. */
    const hudShape = id => {
      const n = byId(id);
      return !!n && n.tagName === 'B' && !!n.parentElement &&
        n.parentElement.tagName === 'SPAN' && n.parentElement.classList.contains('stat') &&
        !!n.parentElement.querySelector('small[data-i18n]');
    };
    const core = ['score', 'best', 'level', 'speed', 'coins'];
    const hudBad = core.filter(id => !hudShape(id));
    ok(hudBad.length === 0,
      `the five HUD nodes are <b id=..> inside <span class="stat"><small data-i18n=..> (bad ${JSON.stringify(hudBad)})`);
    ok(byId('distance') === null || hudShape('distance'),
      `#distance, if shipped, follows the same HUD shape (shipped: ${byId('distance') !== null})`);
    ok(/^\d+\.\d{2}$/.test(txt('speed')) &&
      txt('speed') === RN().speedAt(st().distance).toFixed(2),
      `#speed is painted as a 2-decimal model value at boot (got ${JSON.stringify(txt('speed'))}, model ${RN().speedAt(st().distance).toFixed(2)})`);

    ok(!!cls('startOverlay') && cls('startOverlay').contains('show'), 'the start overlay is visible on load');
    ok(!!cls('overlay') && !cls('overlay').contains('show'), 'the result overlay is hidden at boot');
    ok(!!$('#startOverlay .dialog #btnStart'), '#btnStart is inside #startOverlay > .dialog');
    ok(!!$('#overlay .dialog #ovBtn') && !!$('#ovTitle') && !!$('#ovSub'),
      'the result dialog carries #ovTitle / #ovSub / #ovBtn inside .dialog');

    /* Play area structure, exactly as pinned. */
    const track = $('#track');
    ok(!!track && ['hazardLayer', 'coinLayer', 'player'].every(id => byId(id).parentElement === track),
      '#hazardLayer / #coinLayer / #player are all direct children of #track');
    ok(track.children.length === 3 &&
      [...track.children].map(c => c.id).join(',') === 'hazardLayer,coinLayer,player',
      `#track holds exactly the three pinned children (got ${JSON.stringify([...track.children].map(c => c.id))})`);
    ok(track.style.getPropertyValue('--cell') === RN().constants.LANE_W + 'px',
      `#track owns --cell = LANE_W (got ${JSON.stringify(track.style.getPropertyValue('--cell'))})`);
    ok(byId('player').classList.contains('player'), '#player carries class "player"');
    ok(!!byId('fxLayer') && byId('fxLayer').parentElement !== track && !track.contains(byId('fxLayer')),
      '#fxLayer is a SIBLING of #track, never one of its children (the smoke stub clicks classed children)');
    ok(!byId('fxLayer').contains(track) && byId('fxLayer').parentElement !== track,
      '#fxLayer does not wrap or contain #track either');
    ok(byId('hazardLayer').querySelectorAll('.hazard').length === RN().constants.POOL_SIZE &&
      byId('coinLayer').querySelectorAll('.coin').length === RN().constants.POOL_SIZE,
      `each layer pre-allocates POOL_SIZE=${RN().constants.POOL_SIZE} nodes (hazard ${byId('hazardLayer').querySelectorAll('.hazard').length}, coin ${byId('coinLayer').querySelectorAll('.coin').length})`);
    ok([...byId('hazardLayer').children].every(n => n.classList.contains('hazard')) &&
      [...byId('coinLayer').children].every(n => n.classList.contains('coin')),
      'every pool node carries its layer class (.hazard / .coin) and no other class');
    ok(doc.querySelectorAll('#track .coin').length === 0 || [...doc.querySelectorAll('#track .coin')].every(c => c.parentElement === byId('coinLayer')),
      'no .coin node lives outside #coinLayer');

    ok(doc.querySelectorAll('[data-lang-switch]').length >= 1, 'a language-switch host is present');
    ok(doc.querySelectorAll('[data-lang-switch] a').length === 2, `the switcher mounted two links (${doc.querySelectorAll('[data-lang-switch] a').length})`);
    ok(!!$('h1[data-i18n="title"]'), 'the title carries a data-i18n hook');
  }

  /* -------------------------------------------------------------------- 3 */
  group('3. controls are gated in ready; a real Start click leaves ready');
  {
    /* The pinned contract: #btnPause is disabled in ready, #btnNew is always
     * enabled, and the four pad buttons carry class `pad` (#btnJump also
     * `primary`). Every pad MUST be safe to receive a synthetic click while the
     * game is still in `ready` - the smoke stub clicks all of them. Safety is
     * asserted behaviourally (no throw, no state change), so this stays true
     * whether the page guards with `disabled` or with a phase-gated handler. */
    ok(byId('btnPause').disabled === true, '#btnPause is disabled in ready');
    ok(byId('btnNew').disabled === false, '#btnNew is enabled in ready (always usable)');
    const pads = ['btnLeft', 'btnJump', 'btnSlide', 'btnRight'];
    ok(pads.every(id => byId(id).classList.contains('pad')) &&
      byId('btnJump').classList.contains('primary'),
      'the four pad buttons carry class "pad" and #btnJump also "primary"');
    /* Ruling: a control that cannot act is disabled. While `ready` that is all
     * five - the four pads AND #btnPause. Once playing, all five are live. */
    ok(pads.every(id => byId(id).disabled === true),
      `the four movement pads are ALL disabled in ready (got ${JSON.stringify(pads.map(id => [id, byId(id).disabled]))})`);
    ok(byId('btnStart').tagName === 'BUTTON' && byId('btnStart').classList.contains('primary'),
      '#btnStart is a real <button class="primary">');

    const beforePhase = st().phase, beforeDist = st().distance, beforeLane = st().lane;
    let threw = '';
    for (const id of [...pads, 'btnPause']) {
      try { click(byId(id)); pump(1); } catch (e) { threw += id + ':' + e.message + ' '; }
    }
    ok(threw === '', `clicking the four pads + #btnPause while ready throws nothing (${threw || 'clean'})`);
    ok(st().phase === 'ready',
      `a synthetic click on a pad / #btnPause while ready does not leave ready (got ${st().phase})`);
    ok(st().distance === beforeDist && st().lane === beforeLane,
      `a synthetic click on a pad / #btnPause changes neither distance nor lane (${beforeDist}/${beforeLane} -> ${st().distance}/${st().lane})`);
    ok(beforePhase === 'ready', `the run was still 'ready' before the Start click (${beforePhase})`);

    click(byId('btnStart'));
    pump(1);
    ok(st().phase === 'playing', `clicking Start enters 'playing' (got ${st().phase})`);
    ok(!cls('startOverlay').contains('show'), 'the start overlay is really hidden after Start');
    ok(byId('btnPause').disabled === false && pads.every(id => byId(id).disabled === false),
      `all five movement/pause controls are enabled once playing (pause ${byId('btnPause').disabled}, pads ${JSON.stringify(pads.map(id => byId(id).disabled))})`);
    ok(byId('btnNew').disabled === false, '#btnNew stays enabled while playing');

    /* #btnNew's documented job IS to (re)start, so it may legitimately leave
     * ready - it just has to do so safely from the smoke stub's blanket click. */
    let newThrew = '';
    try { click(byId('btnNew')); pump(1); } catch (e) { newThrew = e.message; }
    ok(newThrew === '' && st().phase === 'playing' && st().distance < 10,
      `#btnNew safely (re)starts a fresh game from ready/playing (${newThrew || 'clean'}, phase ${st().phase}, distance ${st().distance.toFixed(1)})`);
  }

  /* -------------------------------------------------------------------- 4 */
  group('4. real keyboard + real button input drive the state machine');
  {
    click(byId('btnNew')); pump(1);
    const lane0 = st().lane;
    key('keydown', 'ArrowRight');
    pump(3);
    ok(st().targetLane === Math.min(2, lane0 + 1) || st().lane !== lane0,
      `a real ArrowRight keydown commands a lane change (lane ${lane0} -> target ${st().targetLane})`);
    RN().tick(0.4); pump(1);
    ok(st().lane === Math.min(2, lane0 + 1), `the lane change completes to ${st().lane}`);
    key('keydown', 'ArrowLeft'); RN().tick(0.4); pump(1);
    ok(st().lane < Math.min(2, lane0 + 1), 'a real ArrowLeft keydown moves back');

    key('keydown', ' '); pump(1);
    ok(st().onGround === false, 'a real Space keydown jumps');
    RN().tick(1); pump(1);
    ok(st().onGround === true, 'the jump lands again');
    key('keydown', 's'); pump(1);
    ok(st().sliding === true, "a real 's' keydown slides");
    RN().tick(1); pump(1);

    /* On-screen controls respond to a real click. (The buttons are wired to
     * `click`, which is what a tap produces; pointerdown/up are dispatched too so
     * a listener that ever switches to pointer events is exercised.) */
    click(byId('btnNew')); pump(1);
    pointer(byId('btnLeft'), 'pointerdown'); pointer(byId('btnLeft'), 'pointerup');
    const l1 = st().lane;
    click(byId('btnLeft')); RN().tick(0.4); pump(1);
    ok(st().lane < l1 || st().lane === 0, `a real click on the Left button changes lanes (${l1} -> ${st().lane})`);
    click(byId('btnJump')); pump(1);
    ok(st().onGround === false, 'a real click on the Jump button jumps');
    RN().tick(1); pump(1);
    click(byId('btnSlide')); pump(1);
    ok(st().sliding === true, 'a real click on the Slide button slides');
    RN().tick(1); pump(1);
    click(byId('btnPause')); pump(1);
    ok(st().phase === 'paused', `a real click on Pause pauses (got ${st().phase})`);
    click(byId('btnPause')); pump(1);
    ok(st().phase === 'playing', 'a real click on Pause resumes');
  }

  /* -------------------------------------------------------------------- 5 */
  group('5. the painted DOM really repaints from the model (via --lane / --y / --x)');
  {
    click(byId('btnNew')); pump(1);
    const player = byId('player');
    let laneBad = 0, yBad = 0, clsBad = 0, hazBad = 0, coinBad = 0;
    let samples = 0, nonZeroHaz = 0, nonZeroCoin = 0, emptyReads = 0;
    const seenHazCounts = new Set(), seenXs = new Set();

    /* Part A: sweep a real run and compare every painted property to the model. */
    for (let i = 0; i < 500; i++) {
      RN().tick(1 / 30, 1 / 60);
      if (st().phase !== 'playing') break;
      pump(1);
      samples++;
      const s = st();

      /* The player's painted lane / height are custom properties read back for
       * real. An empty read ('') would make a naive abs() compare pass vacuously,
       * so an empty read is a FAILURE here, never silently tolerated. */
      const laneStr = varOf(player, '--lane'), yStr = varOf(player, '--y');
      if (laneStr === '' || yStr === '') emptyReads++;
      if (parseFloat(laneStr) !== s.lane) laneBad++;
      if (!(Math.abs(parseFloat(yStr) - s.y) <= 1e-6)) yBad++;

      const wantCls = 'player' + (s.sliding ? ' is-sliding' : '') +
        (s.onGround ? '' : ' is-jumping') + (s.alive ? '' : ' is-dead');
      if (player.className !== wantCls) clsBad++;

      /* Hazards: element-by-element against the independent model list (the pool
       * is refilled in model order, so the visible prefix must line up 1:1). */
      const mh = modelHazards(RN(), st().distance), dh = visibleHazards();
      if (dh.length !== mh.length) hazBad++;
      else for (let j = 0; j < mh.length; j++) {
        const e = dh[j], m = mh[j];
        if (parseFloat(varOf(e, '--lane')) !== m.lane ||
          !(Math.abs(parseFloat(varOf(e, '--x')) - m.x) <= 0.01) ||
          e.getAttribute('data-kind') !== m.kind ||
          !(Math.abs(parseFloat(e.style.top) - m.top) <= 0.01) ||
          !(Math.abs(parseFloat(e.style.width) - m.w) <= 0.01) ||
          !(Math.abs(parseFloat(e.style.height) - m.h) <= 0.01)) { hazBad++; break; }
      }
      seenHazCounts.add(String(dh.length));
      if (dh.length > 0) nonZeroHaz++;
      for (const e of dh) seenXs.add(varOf(e, '--x'));

      /* Coins: every painted coin must be a member of the model coin set and must
       * be self-consistent with the published constants. */
      const mc = modelCoins(RN(), st().distance), dc = visibleCoins();
      if (dc.length > 0) nonZeroCoin++;
      for (const e of dc) {
        const lane = parseFloat(varOf(e, '--lane'));
        const x = parseFloat(varOf(e, '--x'));
        if (!mc.has(lane + ':' + x) ||
          x !== RN().constants.LANE_W * (lane + 0.5) - RN().constants.COIN_R) coinBad++;
      }
    }

    ok(samples > 20, `sampled the painted DOM ${samples} times over a run`);
    ok(emptyReads === 0, `every custom-property read returned a value, never '' (${emptyReads} empty - a vacuous-compare guard)`);
    ok(yBad === 0, `the player's painted --y equals getState().y on every sample (${yBad} bad)`);
    ok(laneBad === 0, `the player's painted --lane equals getState().lane on every sample (${laneBad} bad)`);
    ok(clsBad === 0, `#player's state classes (is-sliding/is-jumping/is-dead) mirror the model every sample (${clsBad} bad)`);
    ok(hazBad === 0, `each visible .hazard matches the independent model in lane, --x, data-kind, top, width, height (${hazBad} bad)`);
    ok(nonZeroHaz > 0, `the hazard layer really painted nodes on ${nonZeroHaz} of ${samples} samples`);
    ok(nonZeroCoin > 0, `the coin layer really painted coins on ${nonZeroCoin} of ${samples} samples`);
    ok(coinBad === 0, `every painted coin sits on a modelled coin position (${coinBad} bad)`);
    ok(seenHazCounts.size >= 3 && seenXs.size >= 5,
      `the painted hazard field really CHANGES as the run advances (${seenHazCounts.size} counts, ${seenXs.size} distinct --x)`);

    /* Part B: a real jump / slide moves --y and toggles the state classes. */
    click(byId('btnNew')); pump(1);
    RN().jump(); pump(1);
    const yUp = numOf(byId('player'), '--y');
    ok(isFinite(yUp) && yUp > 0 && Math.abs(yUp - st().y) <= 1e-6 &&
      byId('player').classList.contains('is-jumping'),
      `a real jump paints --y > 0 and adds .is-jumping (--y ${yUp})`);
    const yAir = st().y; RN().tick(1); pump(1);
    ok(numOf(byId('player'), '--y') === 0 && !byId('player').classList.contains('is-jumping'),
      `landing repaints --y back to 0 and drops .is-jumping (peak ${yAir.toFixed(2)})`);
    RN().slide(); pump(1);
    ok(byId('player').classList.contains('is-sliding') && st().sliding === true,
      'a real slide adds .is-sliding to #player');
    RN().tick(1); pump(1);
    ok(!byId('player').classList.contains('is-sliding'), 'the slide class clears when the slide ends');
  }

  /* -------------------------------------------------------------------- 5b */
  group('5b. the decorative layers are inert: a synthetic click on .hazard / .coin does nothing');
  {
    /* The smoke stub dispatches a click at every classed direct child of an
     * element it fetched by id. #hazardLayer / #coinLayer are children of #track,
     * so their pool nodes WOULD receive those clicks. They must be inert. */
    click(byId('btnNew')); pump(1);
    let g = 0;
    while (visibleHazards().length === 0 && g++ < 60) { RN().tick(0.4, 1 / 60); pump(1); }
    const target = visibleHazards()[0];
    ok(!!target, 'a visible .hazard node exists to click');
    if (target) {
      const before = { phase: st().phase, distance: st().distance, lane: st().lane, score: st().score };
      const errsBefore = errs.length;
      let threw = '';
      try { click(target); click(visibleCoins()[0] || target); pump(1); } catch (e) { threw = e.message; }
      ok(threw === '' && errs.length === errsBefore, `clicking a .hazard / .coin throws nothing (${threw || 'clean'})`);
      ok(st().phase === before.phase && st().lane === before.lane && st().score === before.score,
        `clicking a hazard/coin does not change the run (${JSON.stringify(before)} -> phase ${st().phase})`);
      ok(window.getComputedStyle(byId('hazardLayer')).pointerEvents === 'none' &&
        window.getComputedStyle(byId('coinLayer')).pointerEvents === 'none' &&
        window.getComputedStyle(byId('fxLayer')).pointerEvents === 'none',
        'the hazard/coin/fx layers resolve to pointer-events:none (clicks pass through)');
    }
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. the HUD is repainted at a non-initial value (the silent-defect trap)');
  {
    click(byId('btnNew')); pump(1);
    const hasDist = byId('distance') !== null;   // never gate on #distance (ruling)
    const scoreSeen = new Set([txt('score')]);
    const distSeen = new Set([txt('distance')]), speedSeen = new Set([txt('speed')]);
    let hudBad = 0, g = 0;
    while (st().phase !== 'over' && g++ < 400) {
      RN().tick(1 / 3, 1 / 60);
      pump(1);
      const s = st();
      if (txt('score') !== String(s.score)) hudBad++;
      if (txt('best') !== String(Math.max(s.best, s.score))) hudBad++;
      if (txt('coins') !== String(s.coinCount)) hudBad++;
      if (txt('level') !== String(s.level)) hudBad++;
      if (hasDist && txt('distance') !== String(Math.floor(s.distance))) hudBad++;
      if (txt('speed') !== RN().speedAt(s.distance).toFixed(2)) hudBad++;
      scoreSeen.add(txt('score'));
      distSeen.add(txt('distance'));
      speedSeen.add(txt('speed'));
    }
    pump(1);
    const overScore = st().score;
    ok(hudBad === 0, `the HUD nodes mirror the model on every sample (${hudBad} bad)`);
    ok(overScore > 0, `the driven game ended with a non-zero score (${overScore})`);
    ok(txt('score') === String(overScore) && txt('score') !== '0',
      `#score is REPAINTED from the model at a non-initial value (DOM ${JSON.stringify(txt('score'))} == model ${overScore}, != '0')`);
    if (hasDist) {
      ok(txt('distance') !== '0' && txt('distance') === String(Math.floor(st().distance)),
        `#distance is REPAINTED at a non-initial value (DOM ${JSON.stringify(txt('distance'))} != '0')`);
    } else {
      note('#distance is not shipped by this page (its presence must not gate anything)');
    }
    ok(txt('speed') !== '0.00' && txt('speed') === RN().speedAt(st().distance).toFixed(2),
      `#speed is REPAINTED at a non-initial value (DOM ${JSON.stringify(txt('speed'))} != '0.00')`);
    const seen = [...scoreSeen];
    ok(scoreSeen.size >= 2 && seen[seen.length - 1] === String(overScore),
      `#score text really CHANGED between samples as the score rose (${JSON.stringify(seen.slice(0, 8))})`);
    ok(!hasDist || distSeen.size >= 2,
      `#distance text really CHANGED between samples as the run advanced (${distSeen.size} distinct values${hasDist ? '' : ', #distance not shipped'})`);
    ok(speedSeen.size >= 1 && !speedSeen.has('0.00'),
      `#speed never fell back to its initial '0.00' (seen ${JSON.stringify([...speedSeen])})`);
    /* #speed only changes when the LEVEL changes (every LEVEL_SPAN = 2000 px),
     * which the one-life run above does not reach - that is checked in 8b. */
  }

  /* -------------------------------------------------------------------- 7 */
  group('7. the over overlay appears and Play-again restarts');
  {
    ok(cls('overlay').contains('show'), 'the result overlay is shown at over');
    ok(!cls('startOverlay').contains('show'), 'the start overlay is hidden at over');
    ok(txt('ovTitle').trim().length > 0, `the result title is painted (got ${JSON.stringify(txt('ovTitle'))})`);
    ok(/\d/.test(txt('ovSub')), `the result body carries the score/record (got ${JSON.stringify(txt('ovSub'))})`);
    ok(txt('best') === String(st().best) && Number(txt('best')) > 0,
      `#best shows the saved record (${JSON.stringify(txt('best'))})`);
    click(byId('ovBtn'));
    /* Assert BEFORE pumping: newGame()+start()+updateHud() run synchronously in
     * the click handler, so the restarted state and the hidden overlay are both
     * observable immediately (a pump would advance the virtual clock by 16 ms and
     * move distance off 0). */
    ok(st().phase === 'playing' && st().score === 0 && st().distance === 0,
      `the real Play-again button restarts a fresh game (phase ${st().phase}, score ${st().score}, distance ${st().distance})`);
    ok(!cls('overlay').contains('show'), 'the result overlay is hidden after the restart');
    pump(1);
  }

  /* -------------------------------------------------------------------- 8 */
  group('8. the language switcher is <a> and real clicks re-localise');
  {
    click(byId('btnNew')); pump(1);
    const links = [...doc.querySelectorAll('[data-lang-switch] a')];
    ok(links.length === 2 && links.every(a => a.tagName === 'A'), 'both switcher entries are <a>, not <button>');
    ok(doc.querySelectorAll('[data-lang-switch] button').length === 0, 'the switcher contains no <button>');
    const zh = langLink('zh'), en = langLink('en');
    ok(!!zh && !!en, 'there are en and zh links');

    const enMsg = txt('msg'), enTitle = text('[data-i18n="title"]');
    ok(enMsg.length > 0 && !CJK.test(enMsg), `#msg starts English (got ${JSON.stringify(enMsg)})`);

    click(zh); await sleep(60);
    ok(doc.documentElement.lang === 'zh-CN', `document lang is zh-CN after the click (got ${doc.documentElement.lang})`);
    ok(window.localStorage.getItem('litegame_lang') === 'zh', 'the choice is persisted to localStorage');
    ok(CJK.test(txt('msg')) && txt('msg') !== enMsg, `the DYNAMIC #msg is Chinese via T.onChange (got ${JSON.stringify(txt('msg'))})`);
    ok(CJK.test(text('h1[data-i18n="title"]')), `the static title is Chinese (got ${JSON.stringify(text('h1[data-i18n="title"]'))})`);
    ok(CJK.test(txt('btnJump')) && txt('btnJump') !== '', `the DYNAMIC jump label is Chinese (got ${JSON.stringify(txt('btnJump'))})`);

    /* The over dialog is dynamic too: open it, then flip language and confirm it
     * re-renders in the other language. */
    let g = 0;
    while (st().phase !== 'over' && g++ < 400) { RN().tick(1 / 3, 1 / 60); pump(1); }
    pump(1);
    ok(cls('overlay').contains('show') && CJK.test(txt('ovTitle')),
      `the OPEN overlay is Chinese (title ${JSON.stringify(txt('ovTitle'))})`);
    const zhTitle = txt('ovTitle');
    click(en); await sleep(60);
    ok(doc.documentElement.lang === 'en', 'document lang is back to en');
    ok(!CJK.test(txt('ovTitle')) && txt('ovTitle') !== zhTitle,
      `flipping to en re-renders the open overlay (got ${JSON.stringify(txt('ovTitle'))})`);
    click(zh); await sleep(60);
    ok(CJK.test(txt('msg')), 'the HUD re-localises again after the second flip');
    click(en); await sleep(40);
  }
  function text(sel) { const n = $(sel); return n ? n.textContent : ''; }

  /* -------------------------------------------------------------------- 8b */
  group('8b. a long SURVIVING run lifts #level / #speed in the DOM (model-driven repaint)');
  {
    /* Drive with the same safe bot the vm layer uses, but through the REAL rAF
     * loop only - so the DOM must repaint from the model on its own, over a run
     * long enough to cross LEVEL_SPAN boundaries (which the one-life idle run
     * above never reaches). */
    const C = RN().constants;
    window.RN.newGame({ seed: 1 });
    window.RN.start();
    pump(1);
    const HALF = 55;
    const seenLevel = new Set([txt('level')]), seenSpeed = new Set([txt('speed')]);
    let g = 0, hudBad = 0, laneBad = 0, s = st();
    const target = 3 * C.LEVEL_SPAN;
    while (s.phase === 'playing' && s.distance < target && g++ < 6000) {
      let k0 = Math.ceil((s.distance - HALF - C.SLOT0) / C.SLOT_GAP);
      if (!(k0 >= 0)) k0 = 0;
      const f0 = RN().hazardAt(k0).free, f1 = RN().hazardAt(k0 + 1).free;
      let want = s.lane;
      if (!(f0.includes(s.lane) && f1.includes(s.lane))) {
        const cands = [0, 1, 2].filter(l => f0.includes(l) && f1.includes(l));
        const pool = cands.length ? cands : f0.slice();
        want = pool.slice().sort((a, b) => Math.abs(a - s.targetLane) - Math.abs(b - s.targetLane))[0];
      }
      if (want > s.targetLane) RN().moveLane(1);
      else if (want < s.targetLane) RN().moveLane(-1);
      pump(1, 16);
      s = st();
      if (txt('level') !== String(s.level)) hudBad++;
      if (txt('speed') !== RN().speedAt(s.distance).toFixed(2)) hudBad++;
      if (parseFloat(varOf(byId('player'), '--lane')) !== s.lane) laneBad++;
      seenLevel.add(txt('level'));
      seenSpeed.add(txt('speed'));
    }
    ok(g < 6000 && s.phase === 'playing',
      `the bot survived past ${target} px (reached ${s.distance.toFixed(0)} in ${g} frames, phase ${s.phase})`);
    ok(s.level >= 2, `the model really entered a higher level (level ${s.level}, speed ${s.speed})`);
    ok(hudBad === 0, `#level and #speed mirror the model across the whole long run (${hudBad} bad)`);
    ok(laneBad === 0, `the painted --lane still tracks the model through every lane change (${laneBad} bad)`);
    ok(seenLevel.size >= 2 && seenSpeed.size >= 2,
      `#level and #speed really CHANGED in the DOM over the long run (levels ${JSON.stringify([...seenLevel])}, speeds ${JSON.stringify([...seenSpeed].slice(0, 5))})`);
  }

  /* -------------------------------------------------------------------- 9 */
  group('9. the virtual-clock rAF loop advances the model reproducibly');
  {
    window.RN.newGame({ seed: 3 });
    window.RN.start();
    pump(1);
    const c0 = st().distance, s0 = st().score;
    let monotone = true, nan = 0, prev = c0;
    for (let i = 0; i < 200; i++) {
      pump(1, 16);
      const s = st();
      if (s.distance < prev) monotone = false;
      prev = s.distance;
      if (!isFinite(s.y) || !isFinite(s.vy) || !isFinite(s.distance)) nan++;
    }
    ok(st().distance > c0, `pumping 200 frames advanced distance (${c0} -> ${st().distance.toFixed(0)})`);
    ok(monotone, 'distance is monotonic across pumped frames');
    ok(nan === 0, 'no NaN appears in the player state across 200 real frames');
    ok(st().score >= s0, `the score never decreases across frames (${s0} -> ${st().score})`);
    ok(errs.length === 0, 'no jsdom errors while pumping real frames');
  }

  /* ------------------------------------------------------------------- 10 */
  group('10. runtime errors and the canvas stub');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));
  ok(window.__ctxCalls === 0, `the page only ever ran pure DOM (getContext calls ${window.__ctxCalls})`);
  ok(doc.querySelectorAll('canvas').length === 0, 'still no <canvas> after a full run');

  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('(real jsdom; own http.server on a private port; no canvas; real clicks/keys/PointerEvents; '
    + 'the painted --lane/--y/--x compared to the model on every pumped frame; the hazard field compared '
    + 'element-by-element; the HUD asserted at a non-initial value; dynamic i18n driven through the real '
    + 'link; this layer is reverse-validated by `--selftest`, 7/7 rendering defects caught)');
  killOwned();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
