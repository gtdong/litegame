#!/usr/bin/env node
/**
 * Real-DOM check for pool-game (a single-table 8-ball game, pure DOM + CSS).
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById` lazily
 * invents an element for ANY id, `querySelectorAll` returns [] and nothing is
 * asserted at all; the vm suite has no layout, no events and no CSS. Both hide
 * whole bug classes that only exist once a real document parses the markup:
 *
 *   - a dangling id, an overlay that never really hides, a language switcher
 *     that mounts nothing, a start button that is not actually wired;
 *   - the pointer -> table mapping, which lives entirely in
 *     `getBoundingClientRect()` arithmetic and CANNOT be reached from the vm
 *     sandbox (its rect is 0x0, so the game's `rw > 0` scale branch is never
 *     taken there);
 *   - the HUD, which is repainted by updateHud() out of the rAF loop. Several
 *     state transitions ALSO paint the HUD themselves, so removing the loop's
 *     paint is invisible to a logic test - it only shows up while the balls are
 *     rolling and something has already changed (a pot). This suite therefore
 *     drives every step with real frames only (never `PL.tick`), and proves the
 *     live numbers arrive DURING the roll, before the settle repaint;
 *   - the painted ball nodes (`style.transform = translate(Xpx, Ypx)`), which
 *     must track `getState().balls` to the pixel and disappear when potted;
 *   - the real 简体中文 / English switch, which re-localises the DYNAMIC status
 *     and message text synchronously (via T.onChange), not just the static
 *     `data-i18n` markup.
 *
 * Determinism: requestAnimationFrame is CAPTURED (never self-scheduled) and the
 * test owns a virtual clock - `performance.now()` and the frame timestamp both
 * come from `window.__advance(ms)` - so a run is reproducible instead of racing
 * wall time.
 *
 * Failure-path discipline: a LOCAL target (the default, a relative path, a
 * 127.0.0.1 URL, or any bare path argument) prints a labelled
 * `HARNESS ERROR ...` and exits 1 when it cannot load - a dead server must never
 * masquerade as a passing run. Only an explicitly passed non-local http(s) URL
 * may SKIP with exit 0.
 *
 * ⚠️ The harness always starts its OWN http server on an ephemeral port
 * (`listen(0)`), never a fixed one, so it can never pick up a stale server left
 * by an earlier session - and it always kills it on exit.
 *
 * Usage:
 *   NODE_PATH=<isolated-node-modules> node tools/pool-dom.js
 *   NODE_PATH=<isolated-node-modules> node tools/pool-dom.js <repo-root>/pool-game/index.html
 *   NODE_PATH=<isolated-node-modules> node tools/pool-dom.js http://127.0.0.1:<port>/pool-game/
 *   NODE_PATH=<isolated-node-modules> node tools/pool-dom.js --selftest
 *
 * `--selftest` reverse-validates THIS layer: eleven deliberate rendering /
 * wiring defects are spliced into an in-memory copy of the page (nothing on
 * disk is touched), served to jsdom, driven through the same scenario, and each
 * one must turn its own DOM-derived guard RED while the shipped page stays
 * green.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.error('HARNESS ERROR: jsdom is not installed; run with NODE_PATH=<isolated-node-modules>');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_GAME = path.join(ROOT, 'pool-game', 'index.html');
const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
const ARG = argv.find(a => !a.startsWith('--'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CJK = /[\u4e00-\u9fff]/;

/* ==========================================================================
 * Serving. `listen(0)` asks the OS for a free port, so this harness can never
 * collide with (or accidentally reuse) a server from an earlier session.
 * ======================================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

/** start a static server over `root` on an ephemeral port */
async function startServer(root) {
  const srv = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); res.end(''); return; }
    const file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); res.end(''); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  return { srv, port, close: () => new Promise(r => srv.close(r)) };
}

/** serve one page from memory, with its sibling assets/i18n.js on the side */
async function startMemoryServer(html, i18nJs) {
  const srv = http.createServer((req, res) => {
    const key = req.url.split('?')[0];
    const files = { '/pool-game/index.html': html, '/assets/i18n.js': i18nJs };
    if (Object.prototype.hasOwnProperty.call(files, key)) {
      res.writeHead(200, { 'content-type': MIME[path.extname(key)] || 'text/plain' });
      res.end(files[key]);
    } else { res.writeHead(404); res.end(''); }
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  return {
    url: `http://127.0.0.1:${port}/pool-game/index.html`,
    close: () => new Promise(r => srv.close(r))
  };
}

/* A URL target has no file on disk, so the INITIAL markup - the thing several
 * assertions compare the live HUD against - has to be read back over the wire.
 * Redirects are followed (at most 5 hops) and the whole exchange is capped at
 * 15 s; a source that cannot be fetched is a harness error, never an empty
 * string (an empty string makes `markupText` return null and silently disarms
 * four comparisons instead of failing them). */
function fetchSource(url, hops) {
  hops = hops || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { timeout: 15000 }, res => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hops >= 5) { reject(new Error(`more than 5 redirects, stopped at ${url}`)); return; }
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (e) { reject(e); return; }
        fetchSource(next, hops + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error(`HTTP ${code} from ${url}`)); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error(`timed out after 15 s at ${url}`)); });
    req.on('error', reject);
  });
}

/* ==========================================================================
 * jsdom options. The page uses NO canvas, but a real `getContext` would return
 * null on this box (no `canvas` package) and crash the page with a MISLEADING,
 * unrelated jsdom error - so the stub stays as a fallback and also counts the calls
 * (the count is asserted to be zero: the game is pure DOM+CSS).
 * ======================================================================== */

function makeOpts(errs) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));
  return {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.__ctxCalls = 0;
      window.HTMLCanvasElement.prototype.getContext = function () {
        window.__ctxCalls++;
        const el = this;
        const stub = new Proxy(function () {}, {
          apply: () => stub,
          get: (t, k) => (k === 'canvas' ? el : (k === 'then' ? undefined : stub))
        });
        return stub;
      };
      /* Capture rAF and pin the clock: the test owns the frame timeline. */
      let cb = null, clock = 0;
      window.requestAnimationFrame = fn => { cb = fn; return 1; };
      window.cancelAnimationFrame = () => { cb = null; };
      window.__advance = ms => { clock += (ms === undefined ? 16 : ms); };
      window.__pump = ts => { const f = cb; cb = null; if (f) f(ts === undefined ? clock : ts); };
      window.__now = () => clock;
      try {
        Object.defineProperty(window.performance, 'now', { value: () => clock, configurable: true, writable: true });
      } catch (e) { /* older jsdom: the frame timestamp still drives dt */ }
    }
  };
}

async function boot(url) {
  const errs = [];
  const dom = await JSDOM.fromURL(url, makeOpts(errs));
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));
  await new Promise(r => window.addEventListener('load', () => setTimeout(r, 300)));
  return { dom, window, errs };
}

/* ==========================================================================
 * The scenario. Every number below is DOM-derived; nothing is read from the
 * bridge to check the bridge, except where the model IS the oracle (ball
 * coordinates vs painted transforms).
 *
 * `htmlSource` is only used to recover the INITIAL MARKUP values of the HUD
 * (the page ships `0` and `15`), so "the HUD really moved" can be stated
 * against what the HTML said, not against a number this test made up.
 * ======================================================================== */

function markupText(html, id) {
  const m = html.match(new RegExp('id="' + id + '"[^>]*>([^<]*)<'));
  return m ? m[1].trim() : null;
}

async function measure(window, htmlSource) {
  const doc = window.document;
  const PL = window.PL;
  const byId = id => doc.getElementById(id);
  const txt = id => { const n = byId(id); return n ? n.textContent : null; };
  const m = {
    errs: 0, links: 0, phaseBoot: null, pauseReady: null, readyShootDisabled: null, readyNewDisabled: null,
    phaseAfterStart: null, overlayHidden: null, pauseAfterFrame: null,
    hoverAimBefore: null, hoverAimAfter: null, hoverAimWant: null, hoverAimOk: null,
    overPauseDisabled: null, overShootDisabled: null, overNewDisabled: null, overOvBtnDisabled: null,
    aimProbes: [], aimBad: 0,
    markupShots: markupText(htmlSource, 'shots'), markupRemain: markupText(htmlSource, 'remain'),
    shotsAfterClick: null, hudShotsBad: 0, hudStatusBad: 0,
    potFrames: 0, rollingWithPot: false, remainDuringRoll: null, msgDuringRoll: null,
    phaseDuringRoll: null, statusDuringRoll: null, framesToSettle: 0,
    finalShots: null, finalRemain: null, finalStatus: null, finalMsg: null, finalPhase: null,
    ballCount: 0, ballPosBad: 0, pottedNodes: 0, pottedHiddenBad: 0, transformSamples: 0,
    zhStatus: null, zhMsg: null, zhLang: null, enStatus: null, enMsg: null,
    ctxCalls: 0, canvasEls: 0, startOverlayShown: null,
    bestBeforeClear: null, clearShots: null, clearPhase: null, clearFouls: null, clearScore: null,
    clearOverlayShown: null, clearOvTitle: null, clearOvSub: null, clearBest: null,
    clearRemain: null, clearPottedText: null, clearStatus: null, clearStore: null,
    clearHiddenNodes: null, clearVisibleNodes: null, clearMsgs: 0,
    restartPhase: null, restartOverlayShown: null, restartShotsText: null, restartBestText: null
  };

  if (!PL) return m;

  const click = (node, x, y) => node.dispatchEvent(new window.MouseEvent('click', {
    clientX: x === undefined ? 0 : x, clientY: y === undefined ? 0 : y,
    bubbles: true, cancelable: true, view: window
  }));
  const pump = (n, ms) => {
    for (let i = 0; i < (n || 1); i++) { window.__advance(ms === undefined ? 16 : ms); window.__pump(); }
  };

  m.canvasEls = doc.querySelectorAll('canvas').length;
  m.ctxCalls = window.__ctxCalls;
  m.links = doc.querySelectorAll('[data-lang-switch] a').length;
  m.phaseBoot = PL.getState().phase;
  m.pauseReady = byId('btnPause').disabled;
  m.readyShootDisabled = byId('btnShoot').disabled;
  m.readyNewDisabled = byId('btnNew').disabled;
  m.startOverlayShown = byId('startOverlay').classList.contains('show');

  /* --- start: a REAL click, then one REAL frame -------------------------- */
  click(byId('btnStart'));
  pump(1);
  m.phaseAfterStart = PL.getState().phase;
  m.overlayHidden = !byId('startOverlay').classList.contains('show');
  m.pauseAfterFrame = byId('btnPause').disabled;

  /* --- pointer -> table mapping -----------------------------------------
   * The game converts client coordinates with getBoundingClientRect(), so the
   * rect is pinned to a known box with a 2:1 ratio to the logical table. Every
   * aim below is the closed form atan2(y - 200, x - 200) on the LOGICAL point. */
  const RECT = { left: 120, top: 60, width: 400, height: 200, right: 520, bottom: 260, x: 120, y: 60 };
  byId('table').getBoundingClientRect = () => RECT;
  const cue = PL.getState().balls.find(b => b.id === 0);
  const probes = [
    { label: 'straight right of the cue', cx: 320, cy: 160, lx: 400, ly: 200 },
    { label: 'top-left corner (the boundary)', cx: 120, cy: 60, lx: 0, ly: 0 },
    { label: 'down and right', cx: 320, cy: 260, lx: 400, ly: 400 },
    { label: 'straight left of the cue', cx: 120, cy: 160, lx: 0, ly: 200 },
    { label: 'outside the table (clamped to 800x0)', cx: 900, cy: -300, lx: 800, ly: 0 }
  ];
  for (const p of probes) {
    const want = Math.atan2(p.ly - cue.y, p.lx - cue.x);
    click(byId('table'), p.cx, p.cy);
    const got = PL.getState().aim;
    let d = Math.abs(got - want);
    while (d > Math.PI) d = Math.abs(d - 2 * Math.PI);
    const good = d < 1e-9;
    m.aimProbes.push({ label: p.label, want, got, ok: good });
    if (!good) m.aimBad++;
  }

  /* Hover. The README promises "move over the table -> aim at the pointer", so a
   * pointermove with NO button held must move the aim too. Nothing is pressed
   * and no key is sent: this is a bare mouse move at 400 x 400 on the logical
   * table, i.e. +pi/4 from the cue ball. */
  m.hoverAimBefore = PL.getState().aim;
  m.hoverAimWant = Math.atan2(400 - cue.y, 400 - cue.x);
  byId('table').dispatchEvent(new window.MouseEvent('pointermove', {
    clientX: 320, clientY: 260, buttons: 0, bubbles: true, cancelable: true, view: window
  }));
  m.hoverAimAfter = PL.getState().aim;
  m.hoverAimOk = Math.abs(m.hoverAimAfter - m.hoverAimWant) < 1e-9 && m.hoverAimAfter !== m.hoverAimBefore;

  /* --- the HUD must be repainted by the FRAME LOOP ----------------------
   * No PL.tick() here: the shot below is aimed/powered through the bridge (that
   * is input, not time) and fired with a real click on #btnShoot, then the clock
   * is advanced only by frames. */
  PL.aimAt(562.9519877781263, 176.1690778524696);   // a ghost-point aim that pots a ball early in the roll
  PL.setPower(1400);
  click(byId('btnShoot'));
  m.shotsAfterClick = txt('shots');

  let st = PL.getState();
  for (let i = 0; i < 600; i++) {
    pump(1);
    st = PL.getState();
    m.framesToSettle++;
    if (txt('shots') !== String(st.shots)) m.hudShotsBad++;
    if (st.phase === 'rolling' && txt('status') !== 'Balls rolling…') m.hudStatusBad++;
    /* The discriminator: handleEvents() does NOT repaint the HUD, so a pot that
     * lands mid-roll can only become visible through the loop's updateHud(). */
    if (st.phase === 'rolling' && st.potted.length > 0 && !m.rollingWithPot) {
      m.rollingWithPot = true;
      m.potFrames = i + 1;
      m.remainDuringRoll = txt('remain');
      m.msgDuringRoll = txt('msg');
      m.statusDuringRoll = txt('status');
      m.phaseDuringRoll = st.phase;
      m.remainModelDuringRoll = String(st.remain);
      m.potIdsDuringRoll = st.potted.slice();
    }
    if (st.phase === 'rolling') {
      /* painted positions must track the model while moving, too */
      const nodes = [...doc.querySelectorAll('#ballLayer .ball')];
      const byBallId = {};
      for (const b of st.balls) byBallId[b.id] = b;
      let bad = 0;
      for (const node of nodes) {
        const id = parseInt(node.getAttribute('data-ball'), 10);
        const b = byBallId[id];
        if (!b) continue;
        const mm = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(node.style.transform || '');
        m.transformSamples++;
        if (!mm) { bad++; continue; }
        if (Math.abs(parseFloat(mm[1]) - (b.x - 10)) > 1 || Math.abs(parseFloat(mm[2]) - (b.y - 10)) > 1) bad++;
      }
      if (bad) m.ballPosBad++;
    }
    if (st.phase !== 'rolling') break;
  }

  m.finalPottedIds = st.potted.slice();
  m.finalPhase = st.phase;
  m.finalShots = txt('shots');
  m.finalRemain = txt('remain');
  m.finalStatus = txt('status');
  m.finalMsg = txt('msg');
  m.stateShots = String(st.shots);
  m.stateRemain = String(st.remain);
  m.statePotted = String(st.potted.length);
  m.pottedText = txt('potted');
  m.foulsText = txt('fouls');
  m.stateFouls = String(st.fouls);
  m.scoreText = txt('score');
  m.stateScore = String(st.score);
  m.bestText = txt('best');

  /* --- painted ball nodes at rest --------------------------------------- */
  const nodes = [...doc.querySelectorAll('#ballLayer .ball')];
  m.ballCount = nodes.length;
  const byBallId = {};
  for (const b of st.balls) byBallId[b.id] = b;
  for (const node of nodes) {
    const id = parseInt(node.getAttribute('data-ball'), 10);
    const b = byBallId[id];
    const hidden = node.style.display === 'none' || node.classList.contains('potted');
    if (!b) {
      m.pottedNodes++;
      if (!hidden) m.pottedHiddenBad++;
      continue;
    }
    if (hidden) m.pottedHiddenBad++;          // a live ball must be visible
    const mm = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(node.style.transform || '');
    if (!mm) { m.ballPosBad++; continue; }
    if (Math.abs(parseFloat(mm[1]) - (b.x - 10)) > 1 || Math.abs(parseFloat(mm[2]) - (b.y - 10)) > 1) m.ballPosBad++;
  }
  m.pocketNodes = doc.querySelectorAll('#pocketLayer .pocket').length;
  m.aimLines = doc.querySelectorAll('#aimLayer .aim-line').length;

  /* --- i18n: a REAL click on the switcher link, read synchronously --------
   * No frame is pumped between the click and the read, so this also proves
   * T.onChange repaints the HUD itself instead of leaving it one frame stale. */
  const zh = [...doc.querySelectorAll('[data-lang-switch] a')].find(a => a.getAttribute('data-lang') === 'zh');
  const en = [...doc.querySelectorAll('[data-lang-switch] a')].find(a => a.getAttribute('data-lang') === 'en');
  if (zh) {
    click(zh);
    m.zhStatus = txt('status');
    m.zhMsg = txt('msg');
    m.zhLang = doc.documentElement.lang;
  }
  if (en) {
    click(en);
    m.enStatus = txt('status');
    m.enMsg = txt('msg');
  }

  /* --- 7. clear the table with REAL #btnShoot clicks and REAL frames -----
   * The shot sequence is the published deterministic playbook: aim at the
   * centre of the nearest non-8 object ball, full power, until only the 8 is
   * left (a server-side replay of this rule clears seed 1 in 45 shots). The
   * clock is advanced ONLY by frames, and each frame is 250 ms so that dt hits
   * the MAX_CHUNK clamp exactly (0.25 s = 60 cells of PHYS_H, no remainder
   * cell) - that is what keeps this frame-driven run identical to the
   * tick(8)-driven replay. Only `elapsed` differs, because the settle is
   * detected at a 0.25 s grain; it is deliberately not asserted here. */
  m.bestBeforeClear = txt('best');
  PL.newGame({ seed: 1 });
  PL.start();
  let shots = 0, frames = 0;
  while (PL.getState().phase === 'aiming' && shots < 60 && frames < 6000) {
    const s0 = PL.getState();
    const cueBall = s0.balls.find(b => b.id === 0);
    const rest = s0.balls.filter(b => b.id !== 0 && b.id !== 8);
    const pool = rest.length ? rest : s0.balls.filter(b => b.id !== 0);
    pool.sort((a, b) => Math.hypot(a.x - cueBall.x, a.y - cueBall.y) - Math.hypot(b.x - cueBall.x, b.y - cueBall.y));
    PL.aimAt(pool[0].x, pool[0].y);
    PL.setPower(1400);
    click(byId('btnShoot'));
    shots++;
    let f = 0;
    while (PL.getState().phase === 'rolling' && f < 80) { pump(1, 250); f++; frames++; }
  }
  const done = PL.getState();
  m.clearShots = done.shots;
  m.clearPhase = done.phase;
  m.clearFouls = done.fouls;
  m.clearScore = done.score;
  m.clearOverlayShown = byId('overlay').classList.contains('show');
  m.clearOvTitle = txt('ovTitle');
  m.clearOvSub = txt('ovSub');
  m.clearBest = txt('best');
  m.clearRemain = txt('remain');
  m.clearPottedText = txt('potted');
  m.clearStatus = txt('status');
  m.clearMsgs = done.potted.length;
  try { m.clearStore = window.localStorage.getItem('litegame_pool_best'); } catch (e) { m.clearStore = '<threw>'; }
  const clearNodes = [...doc.querySelectorAll('#ballLayer .ball')];
  m.clearHiddenNodes = clearNodes.filter(n => n.style.display === 'none' || n.classList.contains('potted')).length;
  m.clearVisibleNodes = clearNodes.length - m.clearHiddenNodes;

  /* The over screen must not offer controls that cannot act: Pause and Shoot
   * are dead there, while New game and Play again must stay usable. */
  m.overPauseDisabled = byId('btnPause').disabled;
  m.overShootDisabled = byId('btnShoot').disabled;
  m.overNewDisabled = byId('btnNew').disabled;
  m.overOvBtnDisabled = byId('ovBtn').disabled;

  /* --- 8. the over overlay's Play again restarts -------------------------- */
  click(byId('ovBtn'));
  m.restartPhase = PL.getState().phase;
  m.restartOverlayShown = byId('overlay').classList.contains('show');
  m.restartShotsText = txt('shots');
  m.restartBestText = txt('best');

  return m;
}

/* ==========================================================================
 * Assertions over the measurements. Shared by the real run and --selftest, so
 * the thing that goes red is provably the same thing that goes green.
 * ======================================================================== */

function assertions(m) {
  const out = [];
  let sec = '';
  const t = (cond, label, extra) => out.push({ ok: !!cond, label, extra, sec });
  const S = name => { sec = name; };

  S('1. loads clean, the bridge is live, the page uses no canvas');
  t(m.errs === 0, `no jsdom error while loading or running (${m.errs})`, m.errText);
  t(!!m.phaseBoot, 'window.PL is live in the real page');
  t(m.phaseBoot === 'ready', `the page boots into 'ready' (${m.phaseBoot})`);
  t(m.links === 2, `the language switcher mounted 2 links (${m.links})`);
  t(m.canvasEls === 0 && m.ctxCalls === 0,
    `the page is pure DOM+CSS: 0 <canvas>, 0 getContext calls (${m.canvasEls}/${m.ctxCalls})`);
  t(m.startOverlayShown === true, 'the start overlay is visible before the first click');

  S('2. a real Start click leaves ready and the overlay');
  /* 2. start */
  t(m.phaseAfterStart === 'aiming', `a real click on #btnStart leaves ready (${m.phaseAfterStart})`);
  t(m.overlayHidden === true, '#startOverlay lost the "show" class');
  t(m.pauseReady === true, '#btnPause is disabled while ready');
  /* The published contract: neither Pause nor Shoot can act before the break,
   * while New game always can, so the screen never dead-ends. */
  t(m.readyShootDisabled === true && m.readyNewDisabled === false,
    `#btnShoot is disabled while ready and #btnNew stays live (shoot ${m.readyShootDisabled}, new ${m.readyNewDisabled})`);
  t(m.pauseAfterFrame === false, '#btnPause is live one frame after the start (disabled = ' + m.pauseAfterFrame + ')');

  S('3. pointer -> table mapping (only reachable in a real DOM)');
  /* 3. pointer mapping */
  for (const p of m.aimProbes) {
    t(p.ok, `a click at ${p.label} aims at ${p.want.toFixed(6)} rad (got ${p.got.toFixed(6)})`, p.got);
  }
  t(m.aimProbes.length >= 4 && m.aimBad === 0, `all ${m.aimProbes.length} pointer probes map onto the logical table`);
  t(m.hoverAimOk === true,
    `a bare pointermove (buttons: 0, no key pressed) aims at ${Number(m.hoverAimWant).toFixed(6)} rad as the README promises (aim ${Number(m.hoverAimAfter).toFixed(6)}, was ${Number(m.hoverAimBefore).toFixed(6)})`,
    `after=${m.hoverAimAfter} want=${m.hoverAimWant} before=${m.hoverAimBefore}`);

  S('4. the HUD is repainted by the frame loop, mid-roll');
  /* 4. the HUD is repainted by the loop */
  t(m.markupShots !== null && m.markupRemain !== null,
    `the markup ships #shots=${JSON.stringify(m.markupShots)} and #remain=${JSON.stringify(m.markupRemain)}`);
  t(m.shotsAfterClick === String(Number(m.markupShots) + 1),
    `clicking #btnShoot charges exactly one shot in the HUD (${JSON.stringify(m.shotsAfterClick)})`);
  t(m.rollingWithPot === true,
    'the shot really potted a ball while the balls were still rolling',
    `frames ${m.framesToSettle}, potted ${m.statePotted}`);
  t(m.phaseDuringRoll === 'rolling',
    `the pot landed at frame ${m.potFrames} with the phase still 'rolling' (${m.phaseDuringRoll})`);
  t(m.remainDuringRoll === m.remainModelDuringRoll,
    `#remain drops to ${m.remainModelDuringRoll} DURING the roll, before the settle repaint (got ${JSON.stringify(m.remainDuringRoll)})`,
    m.remainDuringRoll);
  t(m.remainDuringRoll !== m.markupRemain,
    `#remain during the roll is not the initial markup ${JSON.stringify(m.markupRemain)}`);
  const rollMsg = /^Ball (\d+) potted\.$/.exec(m.msgDuringRoll || '');
  t(!!rollMsg && (m.potIdsDuringRoll || []).includes(parseInt(rollMsg[1], 10)),
    `#msg announces the ball that was just potted during the roll (${JSON.stringify(m.msgDuringRoll)} against ${JSON.stringify(m.potIdsDuringRoll)})`);
  t(m.statusDuringRoll === 'Balls rolling…', `#status reads the rolling line during the roll (${JSON.stringify(m.statusDuringRoll)})`);
  t(m.hudShotsBad === 0, `#shots matches getState().shots on every frame (${m.hudShotsBad} mismatches)`);
  t(m.hudStatusBad === 0, `#status reads "Balls rolling…" on every rolling frame (${m.hudStatusBad} mismatches)`);
  t(m.finalPhase === 'aiming', `the roll settles back to aiming (${m.finalPhase}) after ${m.framesToSettle} frames`);
  t(m.finalShots === m.stateShots && m.finalShots !== m.markupShots,
    `#shots settled at ${m.stateShots}, which is NOT the markup value`);
  t(m.finalRemain === m.stateRemain, `#remain settled at ${m.stateRemain} (got ${JSON.stringify(m.finalRemain)})`);
  t(m.pottedText === m.statePotted && m.foulsText === m.stateFouls && m.scoreText === m.stateScore,
    `#potted/#fouls/#score all agree with getState() (${m.pottedText}/${m.foulsText}/${m.scoreText})`);
  t(/^Aiming -?\d+\.\d° · power \d+ px\/s$/.test(m.finalStatus || ''),
    `#status is the aiming line once the roll ends (${JSON.stringify(m.finalStatus)})`);
  const finalMsg = /^Ball (\d+) potted\.$/.exec(m.finalMsg || '');
  t(!!finalMsg && (m.finalPottedIds || []).includes(parseInt(finalMsg[1], 10)),
    `#msg keeps the pot message after the settle (${JSON.stringify(m.finalMsg)} against ${JSON.stringify(m.finalPottedIds)})`);

  S('5. the painted ball layer tracks getState()');
  /* 6. the painted ball layer */
  t(m.ballCount === 16, `#ballLayer holds 16 .ball nodes (${m.ballCount})`);
  t(m.pocketNodes === 6, `#pocketLayer holds the 6 .pocket mouths (${m.pocketNodes})`);
  t(m.aimLines === 1, `#aimLayer holds the single .aim-line (${m.aimLines})`);
  t(m.transformSamples > 0, `ball transforms were sampled on ${m.transformSamples} node-frames while rolling`);
  t(m.ballPosBad === 0, `every painted ball sits within 1 px of getState().balls (${m.ballPosBad} bad)`);
  t(m.pottedNodes >= 1, `the potted ball's node is gone from the live set (${m.pottedNodes})`);
  t(m.pottedHiddenBad === 0, `potted nodes are hidden and live nodes are visible (${m.pottedHiddenBad} bad)`);

  S('6. the language switch re-localises the DYNAMIC text');
  /* 5. i18n */
  t(CJK.test(m.zhStatus || ''), `clicking 简体中文 re-localises #status synchronously (${JSON.stringify(m.zhStatus)})`);
  t(CJK.test(m.zhMsg || ''), `and #msg (${JSON.stringify(m.zhMsg)})`);
  t(m.zhLang === 'zh-CN', `and flips <html lang> to zh-CN (${m.zhLang})`);
  t(/^Aiming /.test(m.enStatus || '') && !CJK.test(m.enStatus || ''),
    `clicking English restores the English status (${JSON.stringify(m.enStatus)})`);
  t(!CJK.test(m.enMsg || ''), `and the English message (${JSON.stringify(m.enMsg)})`);

  /* 7. a full clear, driven by real clicks and real frames */
  S('7. a full clear: 45 shots, the over overlay, and the record');
  t(m.bestBeforeClear === '—', `#best starts empty as an em dash (${JSON.stringify(m.bestBeforeClear)})`);
  t(m.clearPhase === 'over', `45 real #btnShoot clicks clear the table (phase ${m.clearPhase}, shots ${m.clearShots})`);
  t(m.clearShots === 45, `the published playbook still takes exactly 45 shots (${m.clearShots})`);
  t(m.clearFouls === 1 && m.clearScore === 775,
    `the run ends 1 foul / 775 points, matching the replay (${m.clearFouls} / ${m.clearScore})`);
  t(m.clearMsgs === 15 && m.clearRemain === '0' && m.clearPottedText === '15',
    `#remain reads 0 and #potted reads 15 (${m.clearRemain} / ${m.clearPottedText})`);
  t(m.clearStatus === 'Cleared in 45 shots.', `#status announces the clear (${JSON.stringify(m.clearStatus)})`);
  t(m.clearOverlayShown === true, '#overlay is visible after the clear');
  t(m.clearOvTitle === 'Table cleared!', `#ovTitle is the over title (${JSON.stringify(m.clearOvTitle)})`);
  t(/^45 shots · 1 foul · score 775 · best 45$/.test(m.clearOvSub || ''),
    `#ovSub summarises the run (${JSON.stringify(m.clearOvSub)})`);
  t(m.clearBest === '45', `#best shows the new record (${JSON.stringify(m.clearBest)})`);
  t(m.clearStore === '45', `localStorage['litegame_pool_best'] holds 45 (${JSON.stringify(m.clearStore)})`);
  t(m.clearHiddenNodes === 15 && m.clearVisibleNodes === 1,
    `the painted layer keeps only the cue ball (hidden ${m.clearHiddenNodes}, visible ${m.clearVisibleNodes})`);

  /* 8. Play again */
  t(m.overPauseDisabled === true, `#btnPause is disabled on the over screen (${m.overPauseDisabled})`);
  t(m.overShootDisabled === true, `#btnShoot is disabled on the over screen (${m.overShootDisabled})`);
  t(m.overNewDisabled === false && m.overOvBtnDisabled === false,
    `#btnNew and #ovBtn stay usable on the over screen (${m.overNewDisabled}/${m.overOvBtnDisabled})`);

  t(m.restartPhase === 'aiming', `#ovBtn restarts into aiming (${m.restartPhase})`);
  t(m.restartOverlayShown === false, '#overlay hides again on Play again');
  t(m.restartShotsText === '0', `the shot counter resets (${JSON.stringify(m.restartShotsText)})`);
  t(m.restartBestText === '45', `the record survives the restart (${JSON.stringify(m.restartBestText)})`);

  return out;
}

/* ==========================================================================
 * --selftest
 * ======================================================================== */

const MUTATIONS = [
  {
    name: 'updateHud() is removed from the rAF loop (the HUD goes stale between settle points)',
    from: '    simulate(dt);\n    updateFx(dt);\n    updateHud();\n    render();',
    to: '    simulate(dt);\n    updateFx(dt);\n    render();',
    red: m => m.remainDuringRoll !== m.remainModelDuringRoll,
    why: 'a pot that lands mid-roll can only reach #remain through the loop'
  },
  {
    name: 'pointermove goes back to requiring a held button (hover stops aiming)',
    from: "  tableEl.addEventListener('pointermove', function (ev) {\n    onPointerAim(ev);\n  });",
    to: "  tableEl.addEventListener('pointermove', function (ev) {\n    if (ev && ev.buttons) onPointerAim(ev);\n  });",
    red: m => m.hoverAimOk !== true,
    why: 'a bare hover must move the aim; the README says so'
  },
  {
    name: 'only ready disables the controls, so the over screen keeps them enabled',
    from: "    var off = (phase === 'ready' || phase === 'over');",
    to: "    var off = (phase === 'ready');",
    red: m => m.overPauseDisabled === false || m.overShootDisabled === false,
    why: 'Pause and Shoot cannot act once the table is clear'
  },
  {
    name: 'ready leaves the controls live, so a shot can be taken before the break',
    from: "    var off = (phase === 'ready' || phase === 'over');",
    to: "    var off = (phase === 'over');",
    red: m => m.readyShootDisabled !== true || m.pauseReady !== true,
    why: 'nothing can be shot or paused before the break'
  },
  {
    name: 'the #table click listener is never bound',
    from: "  tableEl.addEventListener('click', function (ev) {\n    if (ev && ev.preventDefault) ev.preventDefault();\n    onPointerAim(ev);\n  });",
    to: '  void 0;',
    red: m => m.aimBad > 0,
    why: 'a real click on the table must set the aim'
  },
  {
    name: 'toTable() drops the getBoundingClientRect scale (raw client pixels used as table pixels)',
    from: 'if (rw > 0) x = (num(clientX) - left) * (TABLE_W / rw);',
    to: 'if (rw > 0) x = num(clientX) - left;',
    red: m => m.aimBad > 0,
    why: 'the pinned rect is 400 px wide for an 800 px table, so the ratio is 2'
  },
  {
    name: 'render() never writes a ball transform (positions are never painted)',
    from: "      node.el.style.transform = 'translate(' + round2(b.x - BALL_R) + 'px,' +\n        round2(b.y - BALL_R) + 'px)';",
    to: '      void 0;',
    red: m => m.ballPosBad > 0,
    why: 'the painted transform must track getState().balls'
  },
  {
    name: 'start() no longer hides the start overlay',
    from: "    startOverlayEl.classList.remove('show');",
    to: '    void 0;',
    red: m => m.overlayHidden === false,
    why: 'a click on Start must really leave the overlay'
  },
  {
    name: 'T.onChange no longer repaints the HUD (the language switch leaves stale text)',
    from: '  T.onChange(function () {\n    resetHudCache();\n    updateHud();\n    renderOverlay();\n  });',
    to: '  T.onChange(function () {\n    resetHudCache();\n    renderOverlay();\n  });',
    red: m => !CJK.test(m.zhStatus || ''),
    why: 'the status must be Chinese immediately after the click, without a frame'
  },
  {
    name: 'finishGame() updates the record in memory but never persists it',
    from: "    if (best === null || shots < best) {\n      best = shots;\n      saveBest(best);\n    }",
    to: "    if (best === null || shots < best) {\n      best = shots;\n    }",
    red: m => m.clearStore !== '45',
    why: '#best would still read 45, but localStorage must hold it too'
  },
  {
    name: 'a potted ball node keeps both of its hide signals (class + display)',
    from: "          node.el.classList.add('potted');\n          node.el.style.display = 'none';",
    to: '          void 0;',
    red: m => m.pottedHiddenBad > 0,
    why: 'a potted ball must disappear from the painted layer (either signal, but one is required)'
  }
];

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function runMemory(html, i18nJs) {
  const srv = await startMemoryServer(html, i18nJs);
  try {
    const { window, errs } = await boot(srv.url);
    const m = await measure(window, html);
    m.errs = errs.length;
    m.errText = errs.slice(0, 2).join(' | ');
    try { window.close(); } catch (e) {}
    return m;
  } finally {
    await srv.close();
  }
}

async function selfTest() {
  const html = fs.readFileSync(DEFAULT_GAME, 'utf8');
  const i18nJs = fs.readFileSync(path.join(ROOT, 'assets', 'i18n.js'), 'utf8');
  const frozenSha = sha256(fs.readFileSync(DEFAULT_GAME));

  console.log('\n[selftest] baseline: the UNMODIFIED page must be green on every measurement');
  console.log(`  ·    the page on disk is a FROZEN COPY: sha256 ${frozenSha.slice(0, 16)} (every defect is spliced in memory)`);
  const base = await runMemory(html, i18nJs);
  const baseChecks = assertions(base);
  const baseBad = baseChecks.filter(r => !r.ok);
  console.log(`  ${baseBad.length === 0 ? 'ok  ' : 'FAIL'} unmodified page is green (${baseChecks.length - baseBad.length}/${baseChecks.length} checks)`);
  baseBad.slice(0, 4).forEach(r => console.log(`       FAIL ${r.label} [${r.extra}]`));

  let caught = 0, missed = 0;
  console.log(`\n[selftest] ${MUTATIONS.length} injected rendering/wiring defects, each must turn its own guard RED`);
  for (const mu of MUTATIONS) {
    const patched = html.split(mu.from).join(mu.to);
    if (patched === html) {
      missed++;
      console.log(`  FAIL ${mu.name}\n       the splice target was not found: ${JSON.stringify(mu.from).slice(0, 110)}`);
      continue;
    }
    let m;
    try {
      m = await runMemory(patched, i18nJs);
    } catch (e) {
      missed++;
      console.log(`  FAIL ${mu.name}\n       the patched page could not even be measured: ${(e && e.message) || e}`);
      continue;
    }
    const red = !!mu.red(m);
    if (red) caught++; else missed++;
    console.log(`  ${red ? 'ok  ' : 'FAIL'} ${mu.name} -> ${red ? 'RED as required' : 'stayed GREEN'}  [${mu.why}]`);
    if (!red) console.log(`       measurements: remainDuringRoll=${JSON.stringify(m.remainDuringRoll)} aimBad=${m.aimBad} ballPosBad=${m.ballPosBad} overlayHidden=${m.overlayHidden} zhStatus=${JSON.stringify(m.zhStatus)} pottedHiddenBad=${m.pottedHiddenBad}`);
  }

  const afterSha = sha256(fs.readFileSync(DEFAULT_GAME));
  const untouched = afterSha === frozenSha;
  console.log(`\n  ${untouched ? 'ok  ' : 'FAIL'} the page on disk is byte-identical after the run (sha256 ${afterSha.slice(0, 16)})`);

  const passN = (baseBad.length === 0 ? 1 : 0) + caught + (untouched ? 1 : 0);
  const failN = (baseBad.length === 0 ? 0 : 1) + missed + (untouched ? 0 : 1);
  console.log(`\n[selftest] ${passN} passed, ${failN} failed  (${caught}/${MUTATIONS.length} injected defects caught)`);
  return failN;
}

/* ==========================================================================
 * main
 * ======================================================================== */

(async () => {
  if (SELFTEST) { process.exit(await selfTest() ? 1 : 0); }

  /* Decide up front whether a failure is a SKIP or an ERROR. Anything that is
   * not an explicitly passed non-local http(s) URL is LOCAL and must exit 1. */
  const isHttp = !!ARG && /^https?:\/\//i.test(ARG);
  const looksLocal = !ARG || !isHttp || /127\.0\.0\.1|localhost|\[::1\]/i.test(ARG);
  const explicitlyRemote = isHttp && !looksLocal;

  let owned = null, TARGET = ARG, htmlForMarkup = null;
  const cleanup = async () => { if (owned) await owned.close(); };

  if (!ARG) {
    const file = DEFAULT_GAME;
    const buf = fs.readFileSync(file);
    console.log(`pool-dom: ${path.relative(ROOT, file)}`);
    console.log(`  bytes ${buf.length}  sha256 ${sha256(buf).slice(0, 16)}`);
    htmlForMarkup = buf.toString('utf8');
    /* Serve the repository root so the page's ../assets/i18n.js resolves. */
    owned = await startServer(ROOT);
    TARGET = `http://127.0.0.1:${owned.port}/pool-game/index.html`;
    note(`private server on 127.0.0.1:${owned.port} (ephemeral port, killed on exit)`);
  } else if (!isHttp) {
    /* A filesystem path: serve its parent-of-parent so ../assets/ still works,
     * falling back to the file's own directory if there is no sibling assets. */
    const file = path.resolve(ARG);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      console.log(`HARNESS ERROR: no page file at ${ARG}`);
      process.exit(1);
    }
    const dir = path.dirname(file);
    const up = path.resolve(dir, '..');
    const root = fs.existsSync(path.join(up, 'assets')) ? up : dir;
    const buf = fs.readFileSync(file);
    console.log(`pool-dom: ${file}`);
    console.log(`  bytes ${buf.length}  sha256 ${sha256(buf).slice(0, 16)}`);
    htmlForMarkup = buf.toString('utf8');
    owned = await startServer(root);
    const rel = '/' + path.relative(root, file).split(path.sep).join('/');
    TARGET = `http://127.0.0.1:${owned.port}${rel}`;
    note(`private server on 127.0.0.1:${owned.port} rooted at ${root === ROOT ? '<repo-root>' : root}`);
  }

  const isLocalTarget = /127\.0\.0\.1|localhost|\[::1\]/i.test(TARGET || '');
  if (!explicitlyRemote && !isLocalTarget) {
    console.log(`HARNESS ERROR: target is not a local page or an http(s) URL: ${ARG}`);
    await cleanup();
    process.exit(1);
  }

  process.on('exit', () => { if (owned && owned.srv) { try { owned.srv.close(); } catch (e) {} } });

  let errs = [], window = null;
  try {
    const b = await boot(TARGET);
    window = b.window;
    errs = b.errs;
  } catch (e) {
    const msg = String((e && e.message) || e).split(ROOT).join('<repo-root>');
    await cleanup();
    if (explicitlyRemote) {
      console.log(`SKIP: could not load the remote target ${TARGET} (${msg})`);
      process.exit(0);
    }
    console.log(`HARNESS ERROR: could not load ${TARGET} (${msg})`);
    process.exit(1);
  }

  /* A URL target: the page loaded, but there is no local file to read the
   * original markup from. Without it `markupText` returns null, which makes the
   * "the HUD left its initial value" checks pass for the wrong reason. */
  if (isHttp && !htmlForMarkup) {
    try {
      htmlForMarkup = await fetchSource(TARGET);
    } catch (e) {
      const msg = String((e && e.message) || e).split(ROOT).join('<repo-root>');
      console.log(`HARNESS ERROR: the page at ${TARGET} loaded, but its source could not be read back (${msg})`);
      try { window.close(); } catch (e2) {}
      await cleanup();
      process.exit(1);
    }
    note(`initial markup read back from the wire (${Buffer.byteLength(htmlForMarkup)} B)`);
  }

  const m = await measure(window, htmlForMarkup || '');
  m.errs = errs.length;
  m.errText = errs.slice(0, 2).join(' | ');

  const checks = assertions(m);
  let current = null;
  for (const c of checks) {
    if (c.sec !== current) { current = c.sec; group(current); }
    console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.label}${c.extra !== undefined && !c.ok ? `  [${c.extra}]` : ''}`);
    if (c.ok) pass++; else fail++;
  }
  note(`frames to settle: ${m.framesToSettle}, pot observed at frame ${m.potFrames}`);

  try { window.close(); } catch (e) {}
  await cleanup();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async e => {
  console.log(`HARNESS ERROR: ${(e && e.stack) || e}`);
  process.exit(1);
});
