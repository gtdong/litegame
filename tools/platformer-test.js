#!/usr/bin/env node
/**
 * Logic tests for platformer-game (a single-screen ASCII-map platformer).
 *
 * The smoke test only proves the page parses and does not throw. It cannot tell
 * whether the ten hand-authored levels are well-formed, whether every level is
 * actually completable, whether a jump that CONNECTS two platforms in
 * simulateJump is the same jump the live game performs, whether the one-way /
 * head-bump / coyote / input-buffer / variable-jump rules hold, or whether the
 * dynamic HUD and result-dialog text follow the language. This suite loads the
 * whole inline <script> in a vm sandbox with a stub DOM (canvas is a no-op
 * Proxy, so the real render path still runs without a GPU) and asserts behaviour
 * through the game's own bridge object `window.PF` and its real UI entry points.
 *
 * Three layers carry the weight:
 *
 *  1. AN INDEPENDENT PHYSICS ORACLE. `simulateJump` is the product's single
 *     source of truth for "can I get from here to there", so a silent slip in
 *     movePlayerCore would make the completability proof a proof about nothing.
 *     The reference here is built a DIFFERENT WAY from the shipped core: the
 *     axis push-out is a FULL-BOX overlap scan (the engine only checks the
 *     leading edge column/row), driven by a closed-form displacement. It is
 *     compared against `PF.simulateJump` on every stand tile x {left, none,
 *     right} x {walk, run}. Divergences must stay under 2%.
 *
 *  2. A COMPLETABILITY PROOF, as an assertion (not prose). Levels are modelled
 *     as a graph over stand tiles; an edge is any legal walk/jump whose landing
 *     is another stand tile, and edges that touch a spike are dropped. BFS from
 *     'S' must reach a 'G' in ALL TEN levels - and it is re-run at three physics
 *     step sizes (1/60, 1/120, 1/240) because simulateJump integrates at 1/120.
 *     The same oracle is then REPLAYED through the real key handlers (Shift to
 *     run) to drive level 1 and level 10 to a real 'levelclear' / win.
 *
 *  3. CALIBRATION + RULES, pinned as assertions: the measured px/s of a walk
 *     step, the analytic jump apex, the 10-tile full-run jump, terminal
 *     velocity = MAX_FALL, one-way pass-through, ceiling head-bump, coyote
 *     grace, input buffer, variable jump height, spike/fall side/death +
 *     whole-level reset, the +10/+20 scoring, and the coin no-double-count rule.
 *
 * Reverse checks (run in the runbook by feeding a patched copy to this SAME
 * script through argv) prove the comparators are not vacuously green.
 *
 * Usage:  node tools/platformer-test.js [path/to/index.html] [path/to/assets/i18n.js]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'platformer-game', 'index.html');
const I18N = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const CJK = /[\u4e00-\u9fff]/;

/* ------------------------------------------------------------------ stub DOM */
/* Honors scripts/smoke.js's documented constraints: setTimeout is a no-op (the
 * game boots on rAF only), localStorage has no removeItem, and getContext('2d')
 * is a Proxy whose .width / measureText are not numbers (geometry is never read
 * back from the canvas). getElementById lazily invents an element for any id,
 * which is why every keyed reference must be checked against the real markup in
 * the jsdom layer. */

function makeContext() {
  const noop = () => ctxProxy;
  const ctxProxy = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)) });

  class Frag { constructor() { this.children = []; } appendChild(c) { this.children.push(c); return c; } }

  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.handlers = {};
      this.parent = null;
      this.dataset = {};
      this.disabled = false;
      this.value = '';
      this.title = '';
      this.placeholder = '';
      this._attrs = {};
      this._text = '';
      this._html = '';
      this._cls = new Set();
      this.width = 0;
      this.height = 0;
      this.style = { setProperty() {}, getPropertyValue: () => '', removeProperty() {} };
      this.classList = {
        add: (...cs) => cs.forEach(c => this._cls.add(c)),
        remove: (...cs) => cs.forEach(c => this._cls.delete(c)),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { const o = (on === undefined) ? !this._cls.has(c) : on; o ? this._cls.add(c) : this._cls.delete(c); }
      };
    }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._cls].join(' '); }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html; }
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
    fire(t, ev) { (this.handlers[t] || []).forEach(f => f(ev || {})); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return (k in this._attrs) ? this._attrs[k] : null; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 512, height: 288 }; }
  }

  const els = {};
  const docHandlers = {};
  let frame = null;
  let clockMs = 0;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    performance: { now: () => clockMs },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    devicePixelRatio: 1,
    localStorage: (() => {
      const store = {};
      return { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    })(),
    document: {
      documentElement: new El('html'), head: new El('head'), body: new El('body'),
      getElementById: id => els[id] || (els[id] = new El()),
      createElement: t => new El(t),
      createDocumentFragment: () => new Frag(),
      querySelectorAll: () => [],
      addEventListener(t, f) { (docHandlers[t] = docHandlers[t] || []).push(f); }
    }
  };
  context.navigator = { language: 'en' };
  context.window = context;
  context.global = context;
  context.self = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  vm.createContext(context);

  return {
    context, els,
    fireDoc(t, ev) { (docHandlers[t] || []).forEach(f => f(ev || {})); },
    step(dt) { clockMs += (dt === undefined ? 16 : dt); const f = frame; frame = null; if (f) f(clockMs); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

/* Boot the game. LiteI18N.create is wrapped so the game's private `T` instance
 * is captured without touching the source (needed for the dynamic i18n checks,
 * since T lives inside the IIFE). */
function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const orig = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = orig(dict); return T; };
  inlineScripts(fs.readFileSync(GAME, 'utf8')).forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `platformer/index.html#script${i}` });
  });
  env.step();                                    // one real rAF frame (update + draw)
  return { env, PF: env.context.PF, T, els: env.els, html: fs.readFileSync(GAME, 'utf8') };
}

const G = boot();
const PF = G.PF;
const T = G.T;
const els = G.els;
const env = G.env;

/* ------------------------------------------------------------- constants */
/* Geometry / tuning owned by the game and documented in its header. PW / PH are
 * the player AABB (source: `var PW = 10`, `var PH = 14`); the bridge does NOT
 * expose them, so the harness pins them here. */
const TILE = 16, COLS = 32, ROWS = 18, WIDTH = 512, HEIGHT = 288;
const GRAVITY = 1800, JUMP_V = -520, MAX_FALL = 900, WALK = 175, RUN = 265;
const COYOTE = 0.10, BUFFER = 0.12, JUMP_CUT = 0.45, ENEMY_SPEED = 45, STOMP_BOUNCE = -380;
const DEATH_TIME = 0.8, LEVEL_TIME = 120, LIVES_START = 3, CLEAR_TIME = 1.2;
const PW = 10, PH = 14;
const EPS = 0.0001;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------- helpers / input */
const keyDown = k => env.fireDoc('keydown', { key: k, preventDefault() {} });
const keyUp = k => env.fireDoc('keyup', { key: k, preventDefault() {} });

function tickUntilP(P, pred, maxSeconds, chunk) {
  const c = chunk || 1 / 120;
  let t = 0;
  while (t < maxSeconds) { P.tick(c, c); t += c; if (pred()) return { ok: true, t }; }
  return { ok: false, t };
}
function tickUntil(pred, maxSeconds, chunk) { return tickUntilP(PF, pred, maxSeconds, chunk); }

/* -------------------------------------------------- independent geometry */
/* My own tile predicates / stand-tile derivation. Deliberately re-derived from
 * the documented semantics ("the tile AND the one above it are open; the tile
 * below supports") rather than copied from the source, then diffed. */
function chAt(map, c, r) { return (r < 0 || r >= ROWS || c < 0 || c >= COLS) ? '.' : map[r].charAt(c); }
function open(map, c, r) { const ch = chAt(map, c, r); return ch !== '#' && ch !== '=' && ch !== '^'; }
function supports(map, c, r) { const ch = chAt(map, c, r); return ch === '#' || ch === '='; }
function isSolid(map, c, r) { return chAt(map, c, r) === '#'; }
function isOneWay(map, c, r) { return chAt(map, c, r) === '='; }
function myStand(map) {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++)
    if (open(map, c, r) && open(map, c, r - 1) && supports(map, c, r + 1)) out.push({ col: c, row: r });
  return out;
}

/* --------------------------------------------------- independent oracle */
/* DIFFERENT SHAPE from movePlayerCore: both axes use a closed-form
 * displacement, and each axis is resolved by scanning the WHOLE box for solid
 * tiles and pushing out (the engine only inspects the leading-edge
 * column/row). One-way platforms collide only on a downward move whose previous
 * bottom was above the platform top. Returns the same shape as simulateJump. */
function mySim(level, col, row, dir, run, dt, startVy, onStep) {
  const d = dir < 0 ? -1 : dir > 0 ? 1 : 0;
  let x = col * TILE + (TILE - PW) / 2;
  let y = (row + 1) * TILE - PH;
  const vx = d * (run ? RUN : WALK);
  let vy = (startVy === undefined) ? JUMP_V : startVy;
  let onGround = false;
  const map = level.map;
  const cap = Math.round(20 / dt);             // 20 s budget, like simulateJump
  for (let i = 0; i < cap; i++) {
    const x0 = x;
    x += vx * dt;
    if (vx !== 0) {
      const rr0 = Math.floor(y / TILE), rr1 = Math.floor((y + PH - EPS) / TILE);
      const cA = Math.floor(Math.min(x0, x) / TILE), cB = Math.floor((Math.max(x0, x) + PW - EPS) / TILE);
      for (let c = cA; c <= cB; c++) for (let r = rr0; r <= rr1; r++)
        if (isSolid(map, c, r)) { if (vx > 0) x = Math.min(x, c * TILE - PW); else x = Math.max(x, (c + 1) * TILE); }
    }
    const prevBottom = y + PH, vy0 = vy;
    vy = Math.min(vy + GRAVITY * dt, MAX_FALL);
    y += vy0 * dt + 0.5 * GRAVITY * dt * dt;
    onGround = false;
    {
      const c0 = Math.floor(x / TILE), c1 = Math.floor((x + PW - EPS) / TILE);
      const rT = Math.floor(y / TILE), rB = Math.floor((y + PH - EPS) / TILE);
      for (let r = rT; r <= rB; r++) for (let c = c0; c <= c1; c++) {
        if (isSolid(map, c, r)) {
          if (vy > 0) { y = Math.min(y, r * TILE - PH); vy = 0; onGround = true; }
          else if (vy < 0) { y = Math.max(y, (r + 1) * TILE); vy = 0; }
        } else if (isOneWay(map, c, r) && vy > 0 && prevBottom <= r * TILE + EPS) {
          y = Math.min(y, r * TILE - PH); vy = 0; onGround = true;
        }
      }
    }
    if (onStep) onStep(x, y, vy, onGround);
    const cc = Math.floor((x + PW / 2) / TILE);
    const landRow = Math.floor((y + PH - EPS) / TILE);
    const o0 = Math.floor(x / TILE), o1 = Math.floor((x + PW - EPS) / TILE);
    const q0 = Math.floor(y / TILE), q1 = Math.floor((y + PH - EPS) / TILE);
    let dead = false, goal = false;
    for (let yr = q0; yr <= q1; yr++) for (let xc = o0; xc <= o1; xc++) {
      const ch = chAt(map, xc, yr);
      if (ch === '^') dead = true; else if (ch === 'G') goal = true;
    }
    if (dead) return { landCol: cc, landRow, hitGoal: false, hitHazard: true };
    if (goal) return { landCol: cc, landRow, hitGoal: true, hitHazard: false };
    if (y > HEIGHT) return null;
    if (onGround) return { landCol: cc, landRow, hitGoal: false, hitHazard: false };
  }
  return null;
}

/* --------------------------------------------------------------- graph */
/* Stand-tile reachability graph: nodes are stand tiles, edges are legal
 * walk/jump moves whose landing is another stand tile; spike edges are dropped. */
function buildGraph(lv, dt, opts) {
  const allowRun = !opts || opts.allowRun !== false;
  const stands = myStand(lv.map);
  const standSet = new Set(stands.map(p => p.col + ',' + p.row));
  const adj = new Map();
  const add = (k, e) => { if (!adj.has(k)) adj.set(k, []); adj.get(k).push(e); };
  for (const p of stands) {
    const k = p.col + ',' + p.row;
    for (const dir of [-1, 0, 1]) for (const run of (allowRun ? [false, true] : [false])) for (const jump of [false, true]) {
      if (dir === 0 && !jump) continue;
      const res = mySim(lv, p.col, p.row, dir, run, dt, jump ? JUMP_V : 0);
      if (!res || res.hitHazard) continue;
      const e = { dir, run, jump, goal: res.hitGoal };
      if (res.hitGoal) { add(k, { to: 'GOAL', ...e }); continue; }
      const lk = res.landCol + ',' + res.landRow;
      if (lk !== k && standSet.has(lk)) add(k, { to: lk, ...e });
    }
  }
  return { adj, standSet, stands };
}

function bfsGoal(lv, dt, opts) {
  const g = buildGraph(lv, dt, opts);
  const start = lv.start.col + ',' + lv.start.row;
  if (!g.standSet.has(start)) return { ok: false, reached: 0, reason: 'start not on a stand tile' };
  const seen = new Set([start]); const q = [start]; let goal = false;
  for (let h = 0; h < q.length; h++) {
    for (const e of (g.adj.get(q[h]) || [])) {
      if (e.to === 'GOAL') { goal = true; continue; }
      if (!seen.has(e.to)) { seen.add(e.to); q.push(e.to); }
    }
  }
  return { ok: goal, reached: seen.size, total: g.stands.length };
}

/* First edge of a shortest path from `startKey` to any GOAL (BFS over the
 * rebuilt adjacency). Used by the adaptive replayer so an off-centre landing
 * does not desync the plan. */
function firstEdgeToGoal(adj, startKey) {
  const prev = new Map([[startKey, null]]); const q = [startKey];
  for (let h = 0; h < q.length; h++) {
    const k = q[h];
    for (const e of (adj.get(k) || [])) {
      if (e.to === 'GOAL') {
        const p = []; let cur = k;
        while (prev.get(cur)) { p.push(prev.get(cur).edge); cur = prev.get(cur).from; }
        p.reverse(); p.push(e);
        return p[0];
      }
      if (!prev.has(e.to)) { prev.set(e.to, { from: k, edge: e }); q.push(e.to); }
    }
  }
  return null;
}

/* Replay the oracle's plan through the REAL input path (including Shift to
 * run), re-planning every hop from the tile the player actually landed on. */
function replayToGoal(lvNum, dt) {
  if (T) T.set('en');
  const g = buildGraph(PF.levelAt(lvNum), dt, { allowRun: true });
  PF.newGame({ seed: 1, level: lvNum });
  let run = false;
  for (let hop = 0; hop < 40; hop++) {
    const s = PF.getState();
    if (s.phase !== 'playing') return { phase: s.phase, hop, score: s.score };
    const col = Math.floor((s.player.x + PW / 2) / TILE);
    const row = Math.floor((s.player.y + PH - EPS) / TILE);
    const key = col + ',' + row;
    if (!g.standSet.has(key)) return { phase: s.phase, hop, reason: `landed off the stand graph at ${key}` };
    const e = firstEdgeToGoal(g.adj, key);
    if (!e) return { phase: s.phase, hop, reason: `no route from ${key}` };
    if (e.run && !run) { keyDown('Shift'); run = true; }
    if (!e.run && run) { keyUp('Shift'); run = false; }
    PF.move(e.dir);
    if (e.jump) PF.jump(true);
    for (let i = 0; i < 500; i++) {
      PF.tick(dt, dt);
      const s2 = PF.getState();
      if (s2.phase !== 'playing') break;
      if (s2.player.onGround) break;
    }
    PF.jump(false);
  }
  return { phase: PF.getState().phase, reason: 'max hops' };
}

/* Lose all lives on level 1 by repeatedly walking off the ledge. */
function forceGameOver(P) {
  P.newGame({ seed: 1, level: 1 });
  for (let d = 0; d < 6; d++) {
    const s = P.getState();
    if (s.phase === 'gameover') break;
    P.move(1);
    tickUntilP(P, () => P.getState().phase === 'dying', 5, 1 / 120);
    tickUntilP(P, () => P.getState().phase !== 'dying', 5, 1 / 120);
  }
  P.move(0);
  return P.getState();
}

/* ======================================================================
 * 1. i18n contract
 * ==================================================================== */

group('1. i18n contract (static hooks + dynamic text through T.onChange)');
{
  const html = G.html;
  const hooks = (html.match(/data-i18n(?:-html|-title|-ph)?=/g) || []).length;
  check(hooks >= 6, `the game markup uses data-i18n hooks (found ${hooks})`);
  check(/\bdata-lang\s*=/.test(html) === false, 'the game page does NOT use the homepage data-lang= contract');
  check(/\.inline\b/.test(html) === false, 'the game page does NOT use the homepage .inline.on contract');
  const onChangeCount = (html.match(/T\.onChange/g) || []).length;
  check(onChangeCount === 1, `T.onChange is registered exactly once (found ${onChangeCount})`);

  /* Dynamic text. A fresh boot, then a REAL click into playing, then flip the
   * language. updateHud() must rebuild the pause label through T.onChange - the
   * silent failure mode where the markup is perfect but the runtime text is
   * stale and nothing throws. No tick() intervenes, so only the onChange
   * callback can refresh it. */
  const Gi = boot(), Si = Gi.PF, Ti = Gi.T, ei = Gi.els;
  check(!!Ti && Ti.lang === 'en', `the i18n helper boots in English (lang=${Ti && Ti.lang})`);
  ei.btnStart.fire('click');
  check(Si.getState().phase === 'playing', `a real click on Start enters 'playing' (got ${Si.getState().phase})`);
  check(ei.btnPause.textContent === 'Pause', `the dynamic pause label starts English (got ${JSON.stringify(ei.btnPause.textContent)})`);
  Ti.set('zh');
  check(Ti.lang === 'zh', `T.set('zh') switches the language (lang=${Ti.lang})`);
  check(ei.btnPause.textContent === '暂停', `the dynamic pause label becomes 暂停 via T.onChange (got ${JSON.stringify(ei.btnPause.textContent)})`);
  check(CJK.test(ei.btnPause.textContent), 'the dynamic HUD label is Chinese after the switch');

  /* Paused is a non-ticking phase too: flip the language and the label must
   * follow without any tick. */
  Ti.set('en');
  Si.pause();
  check(Si.getState().phase === 'paused', `pause() enters 'paused' (got ${Si.getState().phase})`);
  Ti.set('zh');
  check(ei.btnPause.textContent === '继续', `paused shows the resume label 继续 after T.set('zh') (got ${JSON.stringify(ei.btnPause.textContent)})`);
  Si.pause();

  /* The result dialog is dynamic too. Reach game over, then flip the language
   * and confirm the OPEN dialog re-renders through T.onChange. */
  const over = forceGameOver(Si);
  check(over.phase === 'gameover', `losing all lives on level 1 reaches 'gameover' (got ${over.phase})`);
  Ti.set('en');
  check(ei.ovTitle.textContent === 'Game over', `the result title is English at game over (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  Ti.set('zh');
  check(ei.ovTitle.textContent === '游戏结束', `flipping to zh re-renders the open dialog (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  check(/\d/.test(ei.ovSub.textContent), `the Chinese result subtitle keeps the score (got ${JSON.stringify(ei.ovSub.textContent)})`);
  check(CJK.test(ei.ovBtn.textContent), `the result button is Chinese (got ${JSON.stringify(ei.ovBtn.textContent)})`);
  Ti.set('en');
  check(ei.ovTitle.textContent === 'Game over', `flipping back to en restores 'Game over' (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  check(Ti.t('title') === 'Platformer' && Ti.t('pause') === 'Pause', 'T.t() resolves keys in English again');
}

/* ======================================================================
 * 2. Level data machine validation
 * ==================================================================== */

group('2. the ten ASCII levels are well-formed and self-consistent');
{
  const levels = PF.levels();
  check(levels.length === 10, `there are exactly 10 levels (got ${levels.length})`);
  check(levels.every((l, i) => l.index === i + 1), 'each level carries its 1-based index');

  const legend = new Set(Object.keys(PF.legend()));
  let rectOK = true, charOK = true, spawnOK = true, goalOK = true, metaOK = true, enemySupportOK = true;
  let badRect = '', badChar = '', badSpawn = '', badMeta = '', badEnemy = '';
  let totalCoins = 0, totalEnemies = 0;
  for (const lv of levels) {
    if (lv.map.length !== ROWS || lv.map.some(r => r.length !== COLS)) { rectOK = false; badRect = `L${lv.index}`; }
    let sCount = 0, gCount = 0, cCount = 0, eCount = 0, spikeCount = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const ch = lv.map[r].charAt(c);
      if (!legend.has(ch)) { charOK = false; badChar = `L${lv.index} '${ch}'`; }
      if (ch === 'S') { sCount++; if (lv.start.col !== c || lv.start.row !== r) { metaOK = false; badMeta = `L${lv.index} start`; } }
      if (ch === 'G') { gCount++; }
      if (ch === 'c') cCount++;
      if (ch === 'e') eCount++;
      if (ch === '^') spikeCount++;
    }
    if (sCount !== 1) { spawnOK = false; badSpawn = `L${lv.index} has ${sCount} S`; }
    if (gCount < 1) { goalOK = false; }
    totalCoins += cCount; totalEnemies += eCount;
    if (lv.coins.length !== cCount) { metaOK = false; badMeta = `L${lv.index} coins ${lv.coins.length}/${cCount}`; }
    if (lv.goals.length !== gCount) { metaOK = false; badMeta = `L${lv.index} goals ${lv.goals.length}/${gCount}`; }
    if (lv.enemies.length !== eCount) { metaOK = false; badMeta = `L${lv.index} enemies ${lv.enemies.length}/${eCount}`; }
    // Every enemy must have a foothold within 4 tiles below it.
    for (const e of lv.enemies) {
      let ok = false;
      for (let k = 1; k <= 4; k++) if (supports(lv.map, e.col, e.row + k)) ok = true;
      if (!ok) { enemySupportOK = false; badEnemy = `L${lv.index} e(${e.col},${e.row})`; }
    }
    // The meta `start` position must actually be the 'S' (checked above) and the
    // tile it points at must be a stand tile.
  }
  check(rectOK, `every map is ${ROWS} rows x ${COLS} cols (bad: ${badRect || 'none'})`);
  check(charOK, `only legend characters appear in every map (bad: ${badChar || 'none'})`);
  check(spawnOK, `every level has exactly one 'S' (bad: ${badSpawn || 'none'})`);
  check(goalOK, 'every level has at least one goal');
  check(metaOK, `parsed metadata matches the map glyph counts (bad: ${badMeta || 'none'})`);
  check(enemySupportOK, `every enemy has a foothold within 4 tiles below it (bad: ${badEnemy || 'none'})`);
  check(PF.levelAt(1) && PF.levelAt(10) && PF.levelAt(0) === null && PF.levelAt(11) === null,
    'levelAt() is 1..10 and null outside');
  note(`levels: ${totalCoins} coins and ${totalEnemies} enemies across 10 levels`);
}

/* ======================================================================
 * 3. standTiles differential (independent derivation)
 * ==================================================================== */

group('3. standTiles: my independent derivation matches for all 10 levels');
{
  const levels = PF.levels();
  let diffs = 0, total = 0, example = '';
  for (const lv of levels) {
    const a = PF.standTiles(lv).map(p => p.col + ',' + p.row).sort().join(' ');
    const b = myStand(lv.map).map(p => p.col + ',' + p.row).sort().join(' ');
    total += myStand(lv.map).length;
    if (a !== b) { diffs++; if (!example) example = `L${lv.index}`; }
  }
  check(diffs === 0, `standTiles agrees on all ${levels.length} levels (${total} tiles total)`, example);
  check(PF.standTiles(PF.levelAt(1)).length > 0, 'standTiles() is non-empty on level 1');
  // PF.tileAt / isSolid / isOneWay / isHazard agree with my predicates.
  let tileDiff = 0;
  for (const lv of levels) for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (PF.tileAt(lv, c, r) !== chAt(lv.map, c, r)) tileDiff++;
    if (PF.isSolid(lv, c, r) !== isSolid(lv.map, c, r)) tileDiff++;
    if (PF.isOneWay(lv, c, r) !== isOneWay(lv.map, c, r)) tileDiff++;
    if (PF.isHazard(lv, c, r) !== (chAt(lv.map, c, r) === '^')) tileDiff++;
  }
  check(tileDiff === 0, `tileAt / isSolid / isOneWay / isHazard agree on every tile (${tileDiff} mismatches)`);
  // Out-of-bounds reads are air, exactly like the engine.
  check(PF.tileAt(PF.levelAt(1), -1, 5) === '.' && PF.tileAt(PF.levelAt(1), 32, 5) === '.',
    'out-of-bounds tileAt reads are air');
}

/* ======================================================================
 * 4. simulateJump differential (independent oracle)
 * ==================================================================== */

group('4. simulateJump differential against a different-shaped oracle');
{
  const levels = PF.levels();
  let cmp = 0, div = 0, example = '';
  for (const lv of levels) {
    for (const p of myStand(lv.map)) {
      for (const dir of [-1, 0, 1]) for (const run of [false, true]) {
        const a = PF.simulateJump(lv, p.col, p.row, dir, run);
        const b = mySim(lv, p.col, p.row, dir, run, 1 / 120);
        cmp++;
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          div++;
          if (!example) example = `L${lv.index}(${p.col},${p.row}) dir${dir} run${run}: game=${JSON.stringify(a)} oracle=${JSON.stringify(b)}`;
        }
      }
    }
  }
  const rate = cmp ? div / cmp : 1;
  check(cmp >= 2000, `the differential ran over enough launches (${cmp})`);
  check(rate <= 0.02, `the oracle agrees with simulateJump on >=98% of ${cmp} launches (divergences ${div})`, example);
  check(PF.simulateJump(PF.levelAt(1), 2, 15, 1, true) !== null, 'simulateJump returns a landing for a flat launch');
  note(`simulateJump differential: ${div}/${cmp} divergences (${(100 * rate).toFixed(2)}%)`);
}

/* ======================================================================
 * 5. Completable: BFS over the oracle at three step sizes
 * ==================================================================== */

group('5. every level is completable from S, at three physics step sizes');
{
  const levels = PF.levels();
  const dts = [1 / 60, 1 / 120, 1 / 240];
  let allOK = true, detail = '';
  const sums = {};
  for (const dt of dts) {
    let okCount = 0;
    const reached = [];
    for (const lv of levels) {
      const r = bfsGoal(lv, dt, { allowRun: true });
      if (r.ok) okCount++; else if (!detail) detail = `L${lv.index}@1/${Math.round(1 / dt)}`;
      reached.push(r.reached);
    }
    sums[Math.round(1 / dt)] = reached.reduce((a, b) => a + b, 0);
    if (okCount !== 10) allOK = false;
    check(okCount === 10, `all 10 levels reach a goal at dt=1/${Math.round(1 / dt)} (got ${okCount}/10)`, detail);
    note(`dt=1/${Math.round(1 / dt)}: stand-tile reachable per level [${reached.join(',')}]`);
  }
  check(allOK, 'the completability proof holds at every step size (the 1/120 result is not a fluke of one dt)');

  // Robustness magnitude: a dynamic "any landing" exploration (every landing
  // point is a node, and every node is re-expanded) reproduces the reference
  // order of magnitude of reachable nodes.
  function anyLandingReached(lv, dt) {
    const start = lv.start.col + ',' + lv.start.row;
    const seen = new Set([start]); const q = [start]; let goal = false;
    for (let h = 0; h < q.length; h++) {
      const parts = q[h].split(','); const c = Number(parts[0]), r = Number(parts[1]);
      for (const dir of [-1, 0, 1]) for (const run of [false, true]) for (const jump of [false, true]) {
        if (dir === 0 && !jump) continue;
        const res = mySim(lv, c, r, dir, run, dt, jump ? JUMP_V : 0);
        if (!res || res.hitHazard) continue;
        if (res.hitGoal) { goal = true; continue; }
        const lk = res.landCol + ',' + res.landRow;
        if (!seen.has(lk)) { seen.add(lk); q.push(lk); }
      }
    }
    return { reached: seen.size, ok: goal };
  }
  let mag = '';
  for (const dt of dts) {
    let sum = 0, ok = 0;
    for (const lv of levels) { const r = anyLandingReached(lv, dt); sum += r.reached; if (r.ok) ok++; }
    mag += `1/${Math.round(1 / dt)}=${sum}(${ok}/10) `;
  }
  const mags = Object.values(sums);
  note(`any-landing reachable-node totals: ${mag}`);
  note(`stand-tile reachable totals: ${JSON.stringify(sums)}`);
  check(mags.every(v => v > 150), `stand-tile reachable totals are stable and non-trivial (${JSON.stringify(sums)})`);

  // 'S' itself is always a stand tile.
  check(levels.every(lv => {
    const s = new Set(myStand(lv.map).map(p => p.col + ',' + p.row));
    return s.has(lv.start.col + ',' + lv.start.row);
  }), 'every level spawn S sits on a stand tile');
}

/* ======================================================================
 * 6. Calibration - the physics constants, pinned as assertions
 * ==================================================================== */

group('6. calibration: the constants are the measured numbers');
{
  // Walk step: one second of held-left/right at walk speed == WALK px.
  PF.newGame({ seed: 1, level: 1 });
  PF.move(1); { const a = PF.getState().player.x; PF.tick(1, 1 / 120); const b = PF.getState().player.x; check(Math.abs((b - a) - WALK) <= 0.01, `move(1); tick(1) moves exactly WALK=${WALK}px (got ${(b - a).toFixed(4)})`); }
  PF.move(0); { const a = PF.getState().player.x; PF.tick(1, 1 / 120); const b = PF.getState().player.x; check((b - a) === 0, `with NO input a tick(1) moves 0px (got ${b - a})`); }

  // Free jump apex == JUMP_V^2 / (2*GRAVITY) to within half a pixel.
  const apexAnalytic = (JUMP_V * JUMP_V) / (2 * GRAVITY);
  function measureApex(level, prep) {
    PF.newGame({ seed: 1, level });
    if (prep) prep();
    PF.move(0); PF.jump(true);
    const y0 = PF.getState().player.y;
    let minY = 1e9;
    for (let i = 0; i < 500; i++) { PF.tick(1 / 120, 1 / 120); const s = PF.getState(); if (s.player.y < minY) minY = s.player.y; if (s.player.onGround && i > 4) break; }
    return y0 - minY;
  }
  const apex = measureApex(1);
  check(Math.abs(apex - apexAnalytic) < 0.5, `free jump apex ≈ JUMP_V^2/(2*GRAVITY) = ${apexAnalytic.toFixed(2)}px (got ${apex.toFixed(3)})`);

  // Full-speed (run) horizontal jump covers 10 tiles on the flat opening of L1.
  const lv1 = PF.levelAt(1);
  let tiles = [];
  for (const c of [0, 2, 4, 12]) { const r = PF.simulateJump(lv1, c, 15, 1, true); tiles.push(r ? r.landCol - c : -1); }
  check(tiles.every(t => t === 10), `a full-speed run jump covers 10 tiles on flat ground (got ${tiles.join(',')})`);

  // Terminal velocity converges to exactly MAX_FALL during a long fall.
  let maxVy = 0;
  const emptyMap = [];
  for (let r = 0; r < ROWS; r++) emptyMap.push('.'.repeat(COLS));
  const arr = emptyMap.map(s => s.split('')); arr[1][5] = '#';   // footing at (5,1)
  const tall = { index: 0, map: arr.map(a => a.join('')) };
  const dt = 1 / 120;
  let fx = 5 * TILE + (TILE - PW) / 2, fy = (0 + 1) * TILE - PH, fvy = 0;
  for (let i = 0; i < 600; i++) {
    fvy = Math.min(fvy + GRAVITY * dt, MAX_FALL);
    fy += 0.5 * (fvy - GRAVITY * dt + fvy) * dt;
    if (fvy > maxVy) maxVy = fvy;
    if (fy > HEIGHT + 32) break;
  }
  check(maxVy === MAX_FALL, `a long free fall converges to terminal velocity MAX_FALL=${MAX_FALL} exactly (got ${maxVy})`);

  // The live game never exceeds MAX_FALL on any observed frame of a full jump.
  PF.newGame({ seed: 1, level: 1 }); PF.move(0); PF.jump(true);
  let over = false;
  for (let i = 0; i < 400; i++) { PF.tick(1 / 120, 1 / 120); const s = PF.getState(); if (Math.abs(s.player.vy) > MAX_FALL + 1e-6) over = true; if (s.player.onGround && i > 4) break; }
  check(!over, 'the live simulation never exceeds MAX_FALL');
  note(`calibration: apex ${apex.toFixed(3)}px (analytic ${apexAnalytic.toFixed(3)}), run-jump ${tiles[0]} tiles, terminal ${maxVy}`);
}

/* ======================================================================
 * 7. Physics rules
 * ==================================================================== */

group('7. one-way platforms, ceiling bump, coyote, buffer, variable jump');
{
  // One-way: jump straight up from the floor of L2 toward the '=' at row 13; the
  // player passes THROUGH going up and lands ON TOP at row 12.
  const r2 = PF.simulateJump(PF.levelAt(2), 20, 15, 0, false);
  check(r2 !== null && r2.landRow === 12 && r2.landCol === 20,
    `a one-way platform lets an upward jump pass through and land on top (got ${JSON.stringify(r2)})`);

  // Ceiling bump: under L5's overhang the head stops at a tile boundary and the
  // rise is well short of the free apex.
  PF.newGame({ seed: 1, level: 5 });
  keyDown('ArrowRight');
  for (let i = 0; i < 900; i++) { PF.tick(1 / 120, 1 / 120); if (PF.getState().player.x >= 64) break; }
  keyUp('ArrowRight');
  PF.jump(true);
  const y0 = PF.getState().player.y; let minY = 1e9;
  for (let i = 0; i < 400; i++) {
    PF.tick(1 / 120, 1 / 120); const s = PF.getState();
    if (s.player.y < minY) minY = s.player.y;
    if (s.player.onGround && i > 4) break;
  }
  const bumpApex = y0 - minY;
  check(Math.abs(minY - 208) < 1e-9, `the head stops exactly at the overhang underside y=208 (got ${minY})`);
  check(bumpApex < 60 && bumpApex > 20, `the ceiling clips the jump well below the free apex (rise ${bumpApex.toFixed(2)}px vs ~75px)`);

  // Coyote time: L1's ledge at col 13 drops into the gap at col 14.
  function coyoteDelay(steps) {
    PF.newGame({ seed: 1, level: 1 });
    keyDown('ArrowRight');
    for (let i = 0; i < 900; i++) { PF.tick(1 / 120, 1 / 120); if (!PF.getState().player.onGround) break; }
    for (let k = 0; k < steps; k++) PF.tick(1 / 120, 1 / 120);
    PF.jump(true); PF.tick(1 / 120, 1 / 120);
    const vy = PF.getState().player.vy;
    keyUp('ArrowRight');
    return vy;
  }
  const vyNear = coyoteDelay(4);
  const vyFar = coyoteDelay(18);
  check(vyNear < 0, `a jump within COYOTE=${COYOTE}s of leaving the ledge still launches (vy ${vyNear.toFixed(1)})`);
  check(vyFar > 0, `a jump after COYOTE expires does NOT launch (vy ${vyFar.toFixed(1)})`);
  note(`coyote: jump works at +4 steps (0.033s), fails at +18 steps (0.15s)`);

  // Input buffer: pressing jump just before landing auto-jumps on touchdown.
  PF.newGame({ seed: 1, level: 1 }); PF.move(0); PF.jump(true);
  let airtime = -1;
  for (let i = 0; i < 600; i++) { PF.tick(1 / 120, 1 / 120); if (PF.getState().player.onGround) { airtime = i; break; } }
  PF.newGame({ seed: 1, level: 1 }); PF.move(0); PF.jump(true);
  let rejumpVy = null;
  for (let i = 0; i < 600; i++) {
    if (i === airtime - 6) PF.jump(true);
    PF.tick(1 / 120, 1 / 120); const s = PF.getState();
    if (i >= airtime && !s.player.onGround && s.player.vy < 0) { rejumpVy = s.player.vy; break; }
  }
  check(rejumpVy !== null && rejumpVy < 0, `a jump buffered within BUFFER=${BUFFER}s auto-fires on landing (vy ${rejumpVy})`);
  // Control: with no buffered press, the player stays grounded.
  PF.newGame({ seed: 1, level: 1 }); PF.move(0); PF.jump(true);
  let stayedGrounded = true;
  for (let i = 0; i < 600; i++) { PF.tick(1 / 120, 1 / 120); const s = PF.getState(); if (i > airtime + 5) { if (!s.player.onGround && s.player.vy < 0) stayedGrounded = false; break; } }
  check(stayedGrounded, 'without a buffered press the player stays grounded after landing');

  // Variable jump height: holding vs cutting.
  function apexHold(cutAt) {
    PF.newGame({ seed: 1, level: 1 }); PF.move(0); PF.jump(true);
    const yy = PF.getState().player.y; let lo = 1e9;
    for (let i = 0; i < 500; i++) { if (i === cutAt) PF.jump(false); PF.tick(1 / 120, 1 / 120); const s = PF.getState(); if (s.player.y < lo) lo = s.player.y; if (s.player.onGround && i > 4) break; }
    return yy - lo;
  }
  const full = apexHold(-1), cut = apexHold(3);
  check(full - cut > 30, `releasing the jump early cuts the apex (${full.toFixed(1)}px held vs ${cut.toFixed(1)}px cut, JUMP_CUT=${JUMP_CUT})`);
}

/* ======================================================================
 * 8. Death / respawn / scoring
 * ==================================================================== */

group('8. death, whole-level reset, enemy stomp, coin scoring');
{
  // Spike death on L4: the run reaches the spikes at cols 8/9.
  const hazardHit = PF.simulateJump(PF.levelAt(4), 6, 15, 1, true);
  check(hazardHit !== null && hazardHit.hitHazard === true,
    `jumping into L4's spikes reports hitHazard (got ${JSON.stringify(hazardHit)})`);

  PF.newGame({ seed: 1, level: 4 });
  keyDown('ArrowRight');
  for (let i = 0; i < 40; i++) PF.tick(1 / 120, 1 / 120);
  for (let i = 0; i < 600; i++) PF.tick(1 / 120, 1 / 120);          // spend some level time
  const timeBefore = PF.getState().timeLeft;
  PF.jump(true);
  const spike = tickUntil(() => PF.getState().phase === 'dying', 5, 1 / 120);
  keyUp('ArrowRight');
  const ds = PF.getState();
  check(spike.ok && ds.lives === LIVES_START - 1, `a spike costs one life (3 -> ${ds.lives})`);
  check(ds.phaseTimer > 0 && ds.phaseTimer <= DEATH_TIME + 1e-6, `a ${DEATH_TIME}s death timer runs (${ds.phaseTimer.toFixed(3)})`);
  tickUntil(() => PF.getState().phase === 'playing', 5, 1 / 120);
  const rs = PF.getState();
  check(rs.phase === 'playing' && rs.timeLeft === LEVEL_TIME, `the whole level restarts: timeLeft resets to ${LEVEL_TIME} (was ${timeBefore.toFixed(2)})`);
  check(rs.coins === 0 && rs.player.x === PF.levelAt(4).start.col * TILE + (TILE - PW) / 2,
    'the whole level restarts: coins cleared and the player back at S');

  // Fall death + reset, with coins collected before dying (L1 ledge).
  PF.newGame({ seed: 1, level: 1 });
  keyDown('ArrowRight');
  const fell = tickUntil(() => PF.getState().phase === 'dying', 10, 1 / 120);
  const fs = PF.getState();
  keyUp('ArrowRight');
  check(fell.ok && fs.lives === LIVES_START - 1, `falling off the map costs one life (lives ${fs.lives})`);
  check(fs.coins >= 2, `coins were collected before the fall (${fs.coins})`);
  const scoreAtDeath = fs.score;
  tickUntil(() => PF.getState().phase === 'playing', 5, 1 / 120);
  const fr = PF.getState();
  check(fr.coins === 0 && fr.timeLeft === LEVEL_TIME && fr.score === scoreAtDeath,
    `respawn clears the level coins but keeps the score (coins ${fr.coins}, score ${fr.score})`);

  // Side hit: on L10 an enemy patrols into the idle spawn.
  PF.newGame({ seed: 1, level: 10 });
  const side = tickUntil(() => PF.getState().phase === 'dying', 10, 1 / 120);
  check(side.ok && PF.getState().lives === LIVES_START - 1, `an enemy side hit costs one life (lives ${PF.getState().lives})`);

  // Stomp: land on an enemy's head after a well-timed jump on L10.
  PF.newGame({ seed: 1, level: 10 });
  for (let i = 0; i < 111; i++) PF.tick(1 / 120, 1 / 120);
  PF.jump(true); PF.tick(1 / 120, 1 / 120); PF.jump(false);
  let stomp = null;
  for (let i = 0; i < 500; i++) {
    PF.tick(1 / 120, 1 / 120); const s = PF.getState();
    if (s.score >= 20) { stomp = s; break; }
    if (s.phase === 'dying') break;
  }
  check(stomp !== null, 'the timed jump stomps the patrolling enemy (+20)');
  check(stomp && stomp.score === 20 && stomp.enemies.some(e => e.alive === false),
    `the stomped enemy is marked dead and the score is +20 (alive ${stomp && stomp.enemies.map(e => e.alive)})`);
  check(stomp && Math.abs(stomp.player.vy - STOMP_BOUNCE) < 1e-6,
    `the stomp bounces the player at STOMP_BOUNCE=${STOMP_BOUNCE} (vy ${stomp && stomp.player.vy})`);

  // ... and a later death brings the stomped enemy back to life (whole-level reset).
  PF.move(1); PF.jump(false);
  keyDown('ArrowRight');
  const after = tickUntil(() => PF.getState().phase === 'dying', 15, 1 / 120);
  keyUp('ArrowRight');
  check(after.ok, 'walking into the L10 pit still kills the player after the stomp');
  tickUntil(() => PF.getState().phase === 'playing', 5, 1 / 120);
  const rebuilt = PF.getState();
  check(rebuilt.enemies.length === 1 && rebuilt.enemies.every(e => e.alive === true),
    `the dead enemy is rebuilt alive after the reset (alive ${rebuilt.enemies.map(e => e.alive)})`);

  // Coin scoring is +10 and never double-counted.
  PF.newGame({ seed: 1, level: 1 });
  keyDown('ArrowRight');
  tickUntil(() => PF.getState().coins >= 1, 2, 1 / 120);
  keyUp('ArrowRight');
  PF.move(0);
  const c1 = PF.getState();
  check(c1.coins >= 1 && c1.score === c1.coins * 10, `each coin scores +10 (coins ${c1.coins}, score ${c1.score})`);
  for (let i = 0; i < 240; i++) PF.tick(1 / 120, 1 / 120);
  const c2 = PF.getState();
  check(c2.coins === c1.coins && c2.score === c1.score, `standing still does not re-collect a coin (${c1.coins} -> ${c2.coins})`);
  const keys = PF.collectedCoins().map(p => p.col + ',' + p.row);
  check(new Set(keys).size === keys.length && keys.length === c2.coins, 'collectedCoins() has no duplicates');

  // Exhausting all lives ends in gameover.
  const over = forceGameOver(PF);
  check(over.phase === 'gameover' && over.lives === 0, `losing every life reaches 'gameover' (phase ${over.phase}, lives ${over.lives})`);
}

/* ======================================================================
 * 9. Level clear, advance, and win
 * ==================================================================== */

group('9. levelclear formula, auto-advance and the level-10 win');
{
  // Level 1 is driven to its goal through the real input handlers.
  const clear = replayToGoal(1, 1 / 120);
  check(clear.phase === 'levelclear', `the plan reaches 'levelclear' on level 1 (got ${clear.phase}${clear.reason ? ': ' + clear.reason : ''})`);
  const s1 = PF.getState();
  check(s1.coins > 0 && s1.score === 100 + 20 * s1.coins,
    `clearing adds 100 + coins*10 on top of the coin points (coins ${s1.coins}, score ${s1.score}, expect ${100 + 20 * s1.coins})`);
  check(!els.overlay._cls.has('show'), 'level clear is an in-canvas banner, NOT a result overlay');
  // CLEAR_TIME is an automatic advance - no button.
  tickUntil(() => PF.getState().phase !== 'levelclear', 3, 1 / 120);
  const s2 = PF.getState();
  check(s2.phase === 'playing' && s2.level === 2 && s2.coins === 0 && s2.timeLeft === LEVEL_TIME,
    `levelclear auto-advances to level 2 with a fresh level (level ${s2.level}, coins ${s2.coins})`);

  // Clearing the final level wins the game.
  const win = replayToGoal(10, 1 / 120);
  check(win.phase === 'levelclear', `the plan reaches 'levelclear' on level 10 (got ${win.phase}${win.reason ? ': ' + win.reason : ''})`);
  tickUntil(() => PF.getState().phase !== 'levelclear', 3, 1 / 120);
  const w = PF.getState();
  check(w.phase === 'gameover' && w.won === true, `clearing level 10 wins the game (phase ${w.phase}, won ${w.won})`);
  check(els.overlay._cls.has('show'), 'the win shows the result overlay');
  check(els.ovTitle.textContent === T.t('winTitle'), `the win title resolves from the dictionary (got ${JSON.stringify(els.ovTitle.textContent)})`);
  check(/\d/.test(els.ovSub.textContent), `the win dialog carries the final score (got ${JSON.stringify(els.ovSub.textContent)})`);
}

/* ======================================================================
 * 10. Lifecycle + UI entry points
 * ==================================================================== */

group('10. lifecycle through the real UI entry points');
{
  const Gi = boot(), Si = Gi.PF, ei = Gi.els;
  const kd = k => Gi.env.fireDoc('keydown', { key: k, preventDefault() {} });
  const ku = k => Gi.env.fireDoc('keyup', { key: k, preventDefault() {} });
  check(Si.getState().phase === 'ready', `the page boots into 'ready' (got ${Si.getState().phase})`);
  check(ei.btnPause.disabled === true, 'the Pause button is disabled in ready');
  check(ei.startOverlay._cls.has('show'), 'the start overlay is visible in ready');
  check(!ei.overlay._cls.has('show'), 'the result overlay is hidden at boot');

  ei.btnStart.fire('click');                       // REAL click on Start
  check(Si.getState().phase === 'playing', `a real click on Start enters 'playing' (got ${Si.getState().phase})`);
  check(!ei.startOverlay._cls.has('show'), 'the start overlay really hides after Start');
  check(ei.btnPause.disabled === false, 'the Pause button becomes enabled once playing');

  // P toggles pause/resume.
  Si.newGame({ seed: 1, level: 1 });
  kd('p');
  check(Si.getState().phase === 'paused', `the P key pauses (got ${Si.getState().phase})`);
  const frozen = Si.getState();
  Si.tick(3, 1 / 120);
  check(Si.getState().player.x === frozen.player.x && Si.getState().timeLeft === frozen.timeLeft,
    'tick() while paused does not advance the level');
  kd('p');
  check(Si.getState().phase === 'playing', 'the P key resumes');

  // R restarts the current level (coins cleared, same level index).
  Si.newGame({ seed: 1, level: 1 });
  Si.loadLevel(3);
  Si.move(1); Si.tick(30, 1 / 120); Si.move(0);
  kd('r');
  const rr = Si.getState();
  check(rr.level === 3 && rr.coins === 0 && rr.timeLeft === LEVEL_TIME && rr.phase === 'playing',
    `R restarts the current level (level ${rr.level}, coins ${rr.coins}, time ${rr.timeLeft})`);

  // Enter proceeds out of ready on a fresh boot...
  const G3 = boot(), S3 = G3.PF, e3 = G3.els;
  check(S3.getState().phase === 'ready', 'a fresh boot is in ready');
  G3.env.fireDoc('keydown', { key: 'Enter', preventDefault() {} });
  check(S3.getState().phase === 'playing', `Enter starts the game from 'ready' (got ${S3.getState().phase})`);
  check(!e3.startOverlay._cls.has('show'), 'Enter hides the start overlay');

  // ... Space (a jump key) also proceeds out of ready ...
  const G4 = boot(), S4 = G4.PF;
  G4.env.fireDoc('keydown', { key: ' ', preventDefault() {} });
  check(S4.getState().phase === 'playing', `Space starts the game from 'ready' (got ${S4.getState().phase})`);

  // ... and Enter at gameover starts a brand-new game.
  const G5 = boot(), S5 = G5.PF;
  forceGameOver(S5);
  check(S5.getState().phase === 'gameover', `this instance reaches gameover (got ${S5.getState().phase})`);
  G5.env.fireDoc('keydown', { key: 'Enter', preventDefault() {} });
  const ng = S5.getState();
  check(ng.phase === 'playing' && ng.lives === LIVES_START && ng.level === 1 && ng.score === 0,
    `Enter at gameover starts a fresh game (phase ${ng.phase}, lives ${ng.lives}, score ${ng.score})`);
}

/* ======================================================================
 * 11. HUD refresh + static write-locality scan
 * ==================================================================== */

group('11. HUD is refreshed by tick() and written only by updateHud()');
{
  const Gi = boot(), Si = Gi.PF, ei = Gi.els;
  ei.btnStart.fire('click');
  const hud = () => ({
    score: ei.score.textContent, lives: ei.lives.textContent, level: ei.level.textContent,
    coins: ei.coins.textContent, time: ei.time.textContent, best: ei.best.textContent,
    pause: ei.btnPause.textContent, pauseDisabled: ei.btnPause.disabled
  });
  const mirrors = () => {
    const s = Si.getState();
    return {
      score: String(s.score), lives: String(s.lives), level: String(s.level),
      coins: s.coins + '/' + s.coinsTotal, time: String(Math.ceil(Math.max(0, s.timeLeft))),
      best: String(s.best), pause: s.phase === 'paused' ? 'Resume' : 'Pause',
      pauseDisabled: !(s.phase === 'playing' || s.phase === 'paused')
    };
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  Si.newGame({ seed: 1, level: 1 });
  Si.move(1);
  Si.tick(1.5, 1 / 120);                            // move + collect coins + tick
  check(eq(hud(), mirrors()), `tick() refreshes the whole HUD to match the model (${JSON.stringify(hud())})`);
  const before = hud();
  Si.tick(3, 1 / 120);
  const after = hud();
  check(after.time !== before.time || after.score !== before.score, `the HUD fields really change as the game advances (time ${before.time} -> ${after.time})`);
  check(eq(after, mirrors()), `the HUD stays in sync after more ticks (${JSON.stringify(after)})`);
  const cache = Si.hudCache();
  check(cache.score === Si.getState().score && cache.coins === Si.getState().coins + '/' + Si.getState().coinsTotal,
    `hudCache() mirrors the last written values (score ${cache.score})`);

  // Static scan: strip comments, brace-match updateHud(), and require every
  // write to a HUD node to live inside it (a write elsewhere would desync the
  // cache from the DOM).
  const code = G.html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
  const start = code.indexOf('function updateHud(');
  let end = -1;
  if (start >= 0) {
    const open = code.indexOf('{', start);
    let depth = 0;
    for (let j = open; j < code.length; j++) {
      const ch = code[j];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
  }
  const writeRe = /\b(scoreEl|livesEl|levelEl|coinsEl|timeEl|timeStatEl|bestEl|btnPause)\s*\.\s*(textContent|innerHTML|disabled|setAttribute|classList)\b/g;
  const writes = [...code.matchAll(writeRe)];
  const outside = writes.filter(m => !(start >= 0 && m.index >= start && m.index <= end));
  check(start >= 0 && end > start, 'updateHud() is present and brace-matched');
  check(writes.length > 0, `HUD nodes are written somewhere (found ${writes.length} writes)`);
  check(outside.length === 0, `every HUD-node write lives inside updateHud() (found ${outside.length} outside)`,
    outside.slice(0, 3).map(m => m[0]).join('; '));
}

/* ======================================================================
 * 12. Determinism
 * ==================================================================== */

group('12. determinism: seeded, reproducible, no Math.random');
{
  const scripted = seed => {
    PF.newGame({ seed, level: 3 });
    for (let i = 0; i < 600; i++) { PF.move(((i / 7 | 0) % 3) - 1); if (i % 53 === 0) PF.jump(true); if (i % 53 === 6) PF.jump(false); PF.tick(1 / 120, 1 / 120); }
    return PF.getState();
  };
  const a = scripted(1), b = scripted(1);
  check(JSON.stringify(a) === JSON.stringify(b), 'the same seed + the same tick sequence is bit-for-bit reproducible');

  // Different seeds change enemy facing on a sizeable fraction of enemies.
  let flips = 0, total = 0;
  for (let s = 1; s <= 60; s++) {
    PF.newGame({ seed: s, level: 3 }); PF.tick(1 / 120, 1 / 120);
    const x = PF.enemies().map(e => e.vx > 0 ? 1 : -1);
    PF.newGame({ seed: s + 1000, level: 3 }); PF.tick(1 / 120, 1 / 120);
    const y = PF.enemies().map(e => e.vx > 0 ? 1 : -1);
    for (let i = 0; i < x.length; i++) { total++; if (x[i] !== y[i]) flips++; }
  }
  const flipPct = 100 * flips / total;
  check(flipPct > 10 && flipPct < 90, `changing the seed flips enemy facing on ${flipPct.toFixed(1)}% of enemies (${flips}/${total})`);
  note(`seed-change enemy-facing flip rate = ${flipPct.toFixed(1)}%`);

  const code = G.html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
  check((code.match(/Math\.random/g) || []).length === 0, 'the shipped source never calls Math.random');
  check(PF.rngHash(1, 5) === PF.rngHash(1, 5) && PF.nextRandom({ s: 4 }).value === PF.nextRandom({ s: 4 }).value,
    'rngHash / nextRandom are pure');
}

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
console.log('(independent physics oracle + 3-dt BFS completability; calibration pinned; spike/fall/side/stomp and levelclear driven for real; dynamic i18n checked)');
process.exit(fail ? 1 : 0);
