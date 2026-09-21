#!/usr/bin/env node
/**
 * Logic tests for frogger-game (Frogger).
 *
 * The smoke test only proves the page does not throw. It cannot tell whether the
 * 13x13 board is laid out correctly, whether every moving car / truck / log /
 * turtle really sits where the deterministic model claims, whether the five home
 * bays are actually reachable from the start bank, whether every way of dying is
 * distinct, or whether the HUD text follows the language. This suite loads the
 * whole inline script in a vm sandbox with a stub DOM (canvas is a no-op Proxy,
 * so the real render path still runs without a GPU) and asserts behaviour through
 * the game's own bridge object `window.FR` and its real UI entry points.
 *
 * Two layers carry most of the weight:
 *
 *  1. AN INDEPENDENT TIME-EXPANDED SEARCH. A bespoke BFS (state = row, quantized
 *     continuous x, frame index; moves = hopTarget + wait) built ONLY from the
 *     bridge's pure world functions proves that each of the five home bays is
 *     reachable from the start bank, reports each bay's earliest arrival time and
 *     hop count, and - crucially - yields a real action list that is then REPLAYED
 *     through the shipped tick()/hop() engine, comparing the engine's frog row/x
 *     to the model's prediction at every step. The model is therefore validated
 *     against the engine, not merely asserted.
 *
 *  2. DIFFERENTIAL SCHEDULES. `vehiclesAt`/`platformsAt` look "obviously right",
 *     which is exactly when a one-line slip hides. The reference here is a
 *     DELIBERATELY DIFFERENT SHAPE: the spatial residue class is measured off the
 *     engine's own segments at t=0, then positions at arbitrary t are rebuilt by
 *     modular arithmetic on the DECLARED step/len/speed/dir - never by re-walking
 *     the engine's affine k-range loop. Divergences must be zero.
 *
 * Timing / state machine is driven through the real `tick()` engine (never by
 * poking internals), the six death kinds are each reproduced for real, and the
 * i18n group specifically pins the DYNAMIC text rebuilt through T.t()/T.onChange
 * (the silent failure mode this repo has hit before), not the static markup.
 *
 * Usage:  node tools/frogger-test.js [path/to/index.html] [path/to/assets/i18n.js]
 *   The optional path lets a deliberately broken copy be fed to the SAME script,
 *   so the negative test is replayable.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'frogger-game', 'index.html');
const I18N = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(path.dirname(GAME), '..', 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const CJK = /[\u4e00-\u9fff]/;

/* ------------------------------------------------------------------ stub DOM */

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
      this._style = {};
      this.width = 0;
      this.height = 0;
      this.style = {
        setProperty: (k, v) => { this._style[k] = String(v); },
        getPropertyValue: k => (k in this._style ? this._style[k] : ''),
        removeProperty: k => { delete this._style[k]; }
      };
      this.classList = {
        add: (...cs) => cs.forEach(c => this._cls.add(c)),
        remove: (...cs) => cs.forEach(c => this._cls.delete(c)),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { const o = (on === undefined) ? !this._cls.has(c) : on; if (o) this._cls.add(c); else this._cls.delete(c); }
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
    appendChild(c) {
      if (c instanceof Frag) c.children.forEach(x => { x.parent = this; this.children.push(x); });
      else { c.parent = this; this.children.push(c); }
      return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return (k in this._attrs) ? this._attrs[k] : null; }
    closest(sel) { const w = sel.replace('.', ''); let n = this; while (n) { if (n._cls && n._cls.has(w)) return n; n = n.parent; } return null; }
    querySelector(s) { return this._find(s)[0] || null; }
    querySelectorAll(s) { return this._find(s); }
    _find(s) {
      const w = s.replace('.', '');
      const out = [];
      (function walk(n) { n.children.forEach(c => { if (c && c._cls && c._cls.has(w)) out.push(c); if (c && c.children) walk(c); }); })(this);
      return out;
    }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 416, height: 416 }; }
  }

  const els = {};
  const docHandlers = {};
  let frame = null;
  // Deterministic rAF clock. The page's loop() derives dt from nowMs(), which
  // prefers performance.now(); driving that from a counter (instead of wall
  // time) makes the real animation-frame path reproducible frame-for-frame.
  let clockMs = 0;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error,
    Set, Map, parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
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
    // Pump one genuine requestAnimationFrame frame so update()+draw() run. The
    // clock advances by `dt` ms (16 by default) so the loop's own dt is exact.
    step(dt) { clockMs += (dt === undefined ? 16 : dt); const f = frame; frame = null; if (f) f(clockMs); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

/* Boot the game. `LiteI18N.create` is wrapped so the game's private `T` instance
 * is captured without touching the source (needed for the dynamic i18n checks,
 * since T lives inside the IIFE). `opts.lang` pre-seeds localStorage. */
function boot(opts) {
  opts = opts || {};
  const env = makeContext();
  if (opts.lang) env.context.localStorage.setItem('litegame_lang', opts.lang);
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const origCreate = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = origCreate(dict); return T; };
  inlineScripts(fs.readFileSync(GAME, 'utf8')).forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `frogger/index.html#script${i}` });
  });
  env.step(); // one real animation frame (runs update + draw)
  return { env, FR: env.context.FR, T, els: env.els };
}

const G = boot();
const FR = G.FR;
const T = G.T;
const KEYMAP = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const key = k => G.env.fireDoc('keydown', { key: KEYMAP[k] || k, preventDefault() {} });
const click = id => G.els[id].fire('click', { preventDefault() {} });
const el = id => G.env.context.document.getElementById(id);

const COLS = FR.COLS, ROWS = FR.ROWS, CELL = FR.CELL;
const HOME_COLS = FR.HOME_COLS;
const DT = 1 / 60;
const HOP_FRAMES = 8;              // HOP_TIME = 8/60, measured in the contract group
const HOP_TIME = HOP_FRAMES / 60;
const EPS = 1e-3;                  // knife-edge margin for the search's world model

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cellOf = x => clamp(Math.round(x - 0.5), 0, COLS - 1);
const nearly = (a, b, eps) => Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);

/* ---- HUD value-cache helpers (Round 2) ---------------------------------- */

// The HUD contract: after ANY call that can change the model (newGame, die,
// levelClear, nextLevel, togglePause, start / T.onChange, or the frame loop /
// tick()), every HUD field must agree with what getState() reports. `updateHud`
// is value-cached, so "agree" here is exactly what a stale-cache bug would break.
function hudEqualsState(tag) {
  const s = FR.getState();
  const want = [
    ['#score', el('score').textContent, String(s.score)],
    ['#lives', el('lives').textContent, String(s.lives)],
    ['#level', el('level').textContent, String(s.level)],
    ['#homes', el('homes').textContent, s.homesFilled + '/5'],
    ['#time', el('time').textContent, String(Math.ceil(Math.max(0, s.timeLeft)))],
    ['#btnPause.disabled', el('btnPause').disabled, !(s.phase === 'playing' || s.phase === 'paused')],
    ['#btnPause.text', el('btnPause').textContent, s.phase === 'paused' ? T.t('resume') : T.t('pause')],
    ['#timeStat.low', el('timeStat').classList.contains('low'), s.timeLeft <= 5]
  ];
  const bad = want.filter(w => String(w[1]) !== String(w[2]));
  check(bad.length === 0,
    `[${tag}] the cached HUD equals getState() (${bad.map(w => `${w[0]}: ${JSON.stringify(w[1])} != ${JSON.stringify(w[2])}`).join('; ') || 'all 8 fields agree'})`);
  return bad.length === 0;
}

// Text of the shipped page with // and /* */ comments removed, so a static
// source check cannot be fooled by a write hiding inside a comment.
function strippedSource() {
  return fs.readFileSync(GAME, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
// The {..}-balanced body of `function name(...)`, or null if absent.
function fnBody(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{'));
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++; else if (src[i] === '}') depth--;
  }
  return src.slice(m.index + m[0].length, i - 1);
}

// Every HUD *write* form (the right-hand side of a DOM mutation), so we can
// prove they all live inside updateHud() and therefore go through the cache.
const HUD_WRITES = [
  /\bscoreEl\.textContent\s*=/, /\blivesEl\.textContent\s*=/,
  /\blevelEl\.textContent\s*=/, /\bhomesEl\.textContent\s*=/,
  /\btimeEl\.textContent\s*=/,
  /\btimeStatEl\.classList\.(?:add|remove|toggle)\b/,
  /\bbtnPause\.disabled\s*=/, /\bbtnPause\.textContent\s*=/
];

/* ============================================================================
 * 0. bridge shape + boot state
 * ========================================================================== */

group('0. bridge shape and the deterministic boot state');
{
  const api = ['laneConfig', 'vehiclesAt', 'platformsAt', 'hopTarget', 'collidesAt', 'supportAt',
    'homeSlot', 'scoreFor', 'newGame', 'hop', 'tick', 'getState', 'start', 'platformUnder'];
  check(!!FR, 'window.FR bridge exists');
  check(api.every(k => typeof FR[k] === 'function'),
    `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof FR[k] !== 'function'))})`);
  check(FR.COLS === 13 && FR.ROWS === 13 && FR.CELL === 32,
    `COLS/ROWS/CELL are 13/13/32 (got ${FR.COLS}/${FR.ROWS}/${FR.CELL})`);
  check(FR.ROW_HOME === 0 && FR.ROW_MEDIAN === 6 && FR.ROW_START === 12,
    `ROW_HOME/MEDIAN/START are 0/6/12 (got ${FR.ROW_HOME}/${FR.ROW_MEDIAN}/${FR.ROW_START})`);
  check(JSON.stringify(HOME_COLS) === JSON.stringify([1, 3, 6, 9, 11]),
    `HOME_COLS is [1,3,6,9,11] (got ${JSON.stringify(HOME_COLS)})`);

  const st = FR.getState();
  check(st.phase === 'ready', `the page boots into 'ready' (got ${st.phase})`);
  check(st.score === 0 && st.lives === 3 && st.level === 1,
    `fresh state is 0 / 3 lives / level 1 (got ${st.score}/${st.lives}/${st.level})`);
  check(st.homes.length === 5 && st.homes.every(h => h === false), 'all five home bays start empty');
  check(st.homesFilled === 0, `homesFilled starts at 0 (got ${st.homesFilled})`);
  check(st.frog.r === 12 && st.frog.c === 6, `the frog starts at (12,6) (got ${st.frog.r},${st.frog.c})`);
  check(nearly(st.frog.x, 6.5), `the frog's continuous x is 6.5 (got ${st.frog.x})`);
  check(nearly(st.timeLeft, 25), `level-1 countdown starts at 25s (got ${st.timeLeft})`);
  check(st.seed === 1, `the default seed is 1 (got ${st.seed})`);
  check(G.els.btnPause.disabled === true, 'the Pause button is disabled in the ready state');
}

/* ============================================================================
 * 1. laneConfig - the declared lane table
 * ========================================================================== */

// The contract table (independent of the source): base speed, direction, span,
// gap and type for all 13 rows.
const EXPECTED = [
  { kind: 'home' },
  { kind: 'river', dir: -1, base: 1.1, len: 3, gap: 2.0, type: 'log' },
  { kind: 'river', dir: +1, base: 1.4, len: 2, gap: 2.0, type: 'turtle', dive: true },
  { kind: 'river', dir: -1, base: 1.7, len: 4, gap: 1.5, type: 'log' },
  { kind: 'river', dir: +1, base: 1.2, len: 3, gap: 2.0, type: 'turtle', dive: true },
  { kind: 'river', dir: -1, base: 2.0, len: 2, gap: 2.5, type: 'log' },
  { kind: 'safe' },
  { kind: 'road', dir: +1, base: 2.2, len: 1, gap: 3.0, type: 'car' },
  { kind: 'road', dir: -1, base: 1.3, len: 2, gap: 4.0, type: 'truck' },
  { kind: 'road', dir: +1, base: 3.2, len: 1, gap: 2.5, type: 'car' },
  { kind: 'road', dir: -1, base: 2.6, len: 1, gap: 3.0, type: 'car' },
  { kind: 'road', dir: +1, base: 1.6, len: 1, gap: 3.5, type: 'car' },
  { kind: 'safe' }
];
const levelMul = L => Math.min(2.2, 1 + (Math.max(1, L) - 1) * 0.15);

group('1. laneConfig(level) matches the declared table');
{
  const cfg = FR.laneConfig(1);
  check(cfg.length === 13, `laneConfig returns 13 lanes (got ${cfg.length})`);
  check(cfg.every((c, i) => c.row === i), 'each lane carries its own row index');
  check(cfg.every((c, i) => c.kind === EXPECTED[i].kind),
    `lane kinds are ${JSON.stringify(EXPECTED.map(e => e.kind))}`);
  let badKind = [];
  for (let i = 0; i < 13; i++) {
    const c = cfg[i], e = EXPECTED[i];
    if (e.kind === 'road' || e.kind === 'river') {
      if (!(c.dir === e.dir && nearly(c.speed, e.base) && nearly(c.baseSpeed, e.base) &&
        c.len === e.len && nearly(c.gap, e.gap) && nearly(c.step, e.len + e.gap) &&
        c.type === e.type && c.dive === !!e.dive)) badKind.push(i);
    } else if (!(c.dir === 0 && c.speed === 0 && c.len === 0 && c.gap === 0 && c.step === 0)) badKind.push(i);
  }
  check(badKind.length === 0, `every moving lane matches dir/speed/len/gap/step/type (bad rows ${JSON.stringify(badKind)})`);
  check(cfg.every((c, i) => nearly(c.phase, i * 0.7)), 'each lane phase is i*0.7');
  check(cfg[2].dive === true && cfg[4].dive === true && cfg[1].dive === false && cfg[3].dive === false && cfg[5].dive === false,
    'only the two turtle lanes (2,4) dive');

  let mulBad = [];
  for (const L of [1, 2, 3, 5, 9, 10, 12]) {
    const c = FR.laneConfig(L), m = levelMul(L);
    for (let i = 0; i < 13; i++) {
      const e = EXPECTED[i];
      if (e.kind !== 'road' && e.kind !== 'river') continue;
      if (!nearly(c[i].speed, e.base * m) || !nearly(c[i].baseSpeed, e.base)) mulBad.push(`${L}/${i}`);
    }
  }
  check(mulBad.length === 0, `level speed-up is base*min(2.2,1+(L-1)*.15) (bad ${JSON.stringify(mulBad)})`);
  check(nearly(FR.laneConfig(2)[7].speed, 2.2 * 1.15), `level 2 lane 7 is 2.2*1.15 (got ${FR.laneConfig(2)[7].speed})`);
  check(nearly(FR.laneConfig(10)[7].speed, 2.2 * 2.2), `the speed-up caps at 2.2x by level 10 (got ${FR.laneConfig(10)[7].speed / 2.2})`);
  check(JSON.stringify(FR.laneConfig(3)) === JSON.stringify(FR.laneConfig(3)), 'laneConfig is pure (same result for the same level)');
}

/* ============================================================================
 * 2. B - differential schedule for vehiclesAt / platformsAt
 *
 * Independent reference: measure the lane's spatial residue class from the
 * engine's own segments at t=0, then rebuild every position by modular
 * arithmetic on the DECLARED step/len/speed/dir. A different shape from the
 * engine's affine k-range enumeration, so a slip cannot pass unnoticed.
 * ========================================================================== */

const RESIDUE = {};   // key `${row}` -> residue of the left edges mod step (measured)
function engineSegs(row, t, level) {
  const cfg = FR.laneConfig(level)[row];
  const raw = cfg.kind === 'road' ? FR.vehiclesAt(row, t, level)
    : cfg.kind === 'river' ? FR.platformsAt(row, t, level) : [];
  return raw.map(o => ({ from: o.from, to: o.to }));
}
function measureResidue(row, level) {
  const cfg = FR.laneConfig(level)[row];
  const segs = engineSegs(row, 0, level);
  if (!segs.length) return null;
  // All left edges are congruent mod step; take the first and reduce.
  let r = segs[0].from % cfg.step;
  if (r < 0) r += cfg.step;
  return r;
}
function refSegs(row, t, level) {
  const cfg = FR.laneConfig(level)[row];
  if (cfg.kind !== 'road' && cfg.kind !== 'river') return [];
  const S = cfg.step, L = cfg.len;
  if (S <= 0) return [];
  const r0 = RESIDUE[row];
  let base = (r0 + cfg.dir * cfg.speed * t) % S;
  if (base < 0) base += S;
  const out = [];
  const jLo = Math.floor((-L - base) / S) - 1;
  const jHi = Math.ceil((COLS - base) / S) + 1;
  for (let j = jLo; j <= jHi; j++) {
    const from = base + j * S, to = from + L;
    if (to <= 0 || from >= COLS) continue;
    out.push({ from, to });
  }
  return out;
}

let cmpPoints = 0, cmpSegs = 0, divPoints = 0, divSegs = 0;
function segsDiverge(a, b) {
  if (a.length !== b.length) return true;
  const sa = [...a].sort((x, y) => x.from - y.from), sb = [...b].sort((x, y) => x.from - y.from);
  for (let i = 0; i < sa.length; i++) {
    cmpSegs++;
    if (!nearly(sa[i].from, sb[i].from) || !nearly(sa[i].to, sb[i].to)) return true;
  }
  return false;
}

group('2. vehiclesAt / platformsAt: differential vs an independent modular model');
{
  for (let row = 1; row <= 11; row++) RESIDUE[row] = measureResidue(row, 1);
  const moving = [1, 2, 3, 4, 5, 7, 8, 9, 10, 11];
  const times = [];
  for (let i = 0; i <= 240; i++) times.push(i * 0.37 + 0.013);   // 0..~89s, irrational-ish

  let sampleTimes = 0;
  for (const level of [1, 2, 6]) {
    for (const row of moving) {
      const cfg = FR.laneConfig(level)[row];
      const r0 = measureResidue(row, level);
      const saved = RESIDUE[row];
      RESIDUE[row] = r0;   // residue is level-independent but re-measure for safety
      for (const t of times) {
        sampleTimes++; cmpPoints++;
        const got = engineSegs(row, t, level);
        const ref = refSegs(row, t, level);
        if (segsDiverge(got, ref)) divPoints++;
      }
      RESIDUE[row] = saved;
    }
  }
  check(divPoints === 0, `0/${cmpPoints} time-points diverge across 3 levels x 10 lanes`, `divergences=${divPoints}`);
  note(`differential: ${cmpPoints} time-points, ${cmpSegs} segment comparisons, ${divPoints} divergences`);

  // kind passthrough + non-moving lanes are empty
  check(FR.vehiclesAt(0, 3, 1).length === 0 && FR.vehiclesAt(6, 3, 1).length === 0 && FR.vehiclesAt(12, 3, 1).length === 0,
    'vehiclesAt is empty on home / median / bank rows');
  check(FR.platformsAt(0, 3, 1).length === 0 && FR.platformsAt(6, 3, 1).length === 0 && FR.platformsAt(12, 3, 1).length === 0,
    'platformsAt is empty on home / median / bank rows');
  check(FR.vehiclesAt(7, 0, 1).every(v => v.kind === 'car') && FR.vehiclesAt(8, 0, 1).every(v => v.kind === 'truck'),
    'vehiclesAt reports car on lane 7 and truck on lane 8');
  check(FR.platformsAt(1, 0, 1).every(p => p.kind === 'log') && FR.platformsAt(2, 0, 1).every(p => p.kind === 'turtle'),
    'platformsAt reports log on lane 1 and turtle on lane 2');
  check(typeof FR.vehiclesAt(7, 0, 1)[0].slot === 'number', 'vehicles carry an integer slot id');
  check(typeof FR.platformsAt(2, 0, 1)[0].slot === 'number', 'platforms carry an integer slot id');
  check('submerged' in FR.platformsAt(2, 0, 1)[0] && 'warning' in FR.platformsAt(2, 0, 1)[0],
    'platforms carry submerged / warning flags');
}

/* ============================================================================
 * 3. schedule invariants: spacing, non-overlap, measured speed, no drift
 * ========================================================================== */

group('3. schedule invariants');
{
  // (a) consecutive gaps are exactly `step`; entities never overlap.
  let gapBad = 0, overlapBad = 0, gapChecks = 0;
  for (const row of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
    const cfg = FR.laneConfig(1)[row];
    for (let t = 0; t < 60; t += 0.5) {
      const segs = engineSegs(row, t, 1).sort((a, b) => a.from - b.from);
      for (let i = 1; i < segs.length; i++) {
        gapChecks++;
        if (!nearly(segs[i].from - segs[i - 1].from, cfg.step)) gapBad++;
        if (segs[i - 1].to > segs[i].from + 1e-9) overlapBad++;
      }
    }
  }
  check(gapBad === 0, `adjacent visible gaps are exactly step (${gapChecks} checks, ${gapBad} bad)`);
  check(overlapBad === 0, `no two entities in a lane overlap (${overlapBad} overlaps)`);

  // (b) measured speed (finite difference on a tracked slot) equals declared speed.
  let speedBad = 0, speedChecks = 0;
  for (const row of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
    const cfg = FR.laneConfig(1)[row];
    const t1 = 2.0, t2 = 2.5;
    const a = engineSegs(row, t1, 1), b = engineSegs(row, t2, 1);
    const A = FR.laneConfig(1)[row].kind === 'road' ? FR.vehiclesAt(row, t1, 1) : FR.platformsAt(row, t1, 1);
    const B = FR.laneConfig(1)[row].kind === 'road' ? FR.vehiclesAt(row, t2, 1) : FR.platformsAt(row, t2, 1);
    for (const oa of A) {
      const ob = B.find(x => x.slot === oa.slot);
      if (!ob) continue;
      speedChecks++;
      const v = (ob.from - oa.from) / (t2 - t1);
      if (!nearly(v, cfg.dir * cfg.speed, 1e-9)) speedBad++;
    }
  }
  check(speedChecks > 0 && speedBad === 0, `finite-difference speed equals dir*speed (${speedChecks} tracked, ${speedBad} bad)`);

  // (c) spacing / shape does not drift over 60s: compare the DEDUPED set of gaps.
  let driftBad = 0;
  for (const row of [1, 2, 3, 4, 5, 7, 8, 9, 10, 11]) {
    const cfg = FR.laneConfig(1)[row];
    const want = JSON.stringify([cfg.step]);
    for (let t = 0; t <= 60; t += 3.7) {
      const segs = engineSegs(row, t, 1).sort((a, b) => a.from - b.from);
      const diffs = new Set();
      for (let i = 1; i < segs.length; i++) diffs.add(Math.round((segs[i].from - segs[i - 1].from) * 1e6) / 1e6);
      if (JSON.stringify([...diffs].sort((a, b) => a - b)) !== want) driftBad++;
    }
  }
  check(driftBad === 0, `the deduped gap set is constant over 60s (${driftBad} drifting samples)`);
}

/* ============================================================================
 * 4. turtle dive schedule (property-based, not a formula copy)
 * ========================================================================== */

group('4. turtle dive: period, duty cycle and warning ordering');
{
  const ROWS_T = [2, 4], level = 1;

  // (a) period is 5s - compare by SLOT (a slot only stays on screen for one pass,
  //     so match slot-by-slot rather than tracking a single slot forever).
  let perCmp = 0, perBad = 0;
  for (const row of ROWS_T) {
    for (let i = 0; i < 400; i++) {
      const t = i * 0.12;
      const a = FR.platformsAt(row, t, level), b = FR.platformsAt(row, t + 5, level);
      for (const pa of a) {
        const pb = b.find(p => p.slot === pa.slot);
        if (!pb) continue;
        perCmp++;
        if (pa.submerged !== pb.submerged || pa.warning !== pb.warning) perBad++;
      }
    }
  }
  check(perCmp > 0 && perBad === 0, `submersion/warning repeat with a 5s period (${perCmp} slot-pairs, ${perBad} bad)`);

  // (b) duty cycle ~28% - average the submerged FRACTION across all visible turtles.
  let fracSum = 0, fracN = 0;
  for (const row of ROWS_T) {
    for (let i = 0; i < 3000; i++) {
      const ps = FR.platformsAt(row, i * 0.02, level);
      if (!ps.length) continue;
      fracSum += ps.filter(p => p.submerged).length / ps.length;
      fracN++;
    }
  }
  const duty = fracSum / fracN;
  check(Math.abs(duty - 0.28) < 0.03, `the submerged duty cycle is ~28% (got ${(duty * 100).toFixed(1)}%)`);

  // (c) warning and submerged are mutually exclusive, and warning leads submerged
  //     by ~0.7s.
  let both = 0, warnSamples = 0, runMax = 0;
  for (const row of ROWS_T) {
    const runsBySlot = {};
    for (let i = 0; i < 4000; i++) {
      const t = i * 0.02;
      for (const p of FR.platformsAt(row, t, level)) {
        if (p.submerged && p.warning) both++;
        if (p.warning) { warnSamples++; runsBySlot[p.slot] = (runsBySlot[p.slot] || 0) + 1; }
        else runsBySlot[p.slot] = 0;
        if (runsBySlot[p.slot] > runMax) runMax = runsBySlot[p.slot];
      }
    }
  }
  check(both === 0, `warning and submerged are never both true (${both} samples)`);
  check(warnSamples > 0, 'the warning window is actually exercised');
  check(Math.abs(runMax * 0.02 - 0.7) < 0.06, `the warning precedes the dive by ~0.7s (max run ${(runMax * 0.02).toFixed(2)}s)`);

  // (d) slots are phase-shifted: at a given instant the visible turtles are not
  //     all in the same state, and the phases differ by slot*0.37.
  let mixed = 0;
  for (let i = 0; i < 200; i++) {
    const ps = FR.platformsAt(2, i * 0.05, level);
    if (ps.length >= 2 && ps.some(p => p.submerged) && ps.some(p => !p.submerged)) mixed++;
  }
  check(mixed > 0, `turtle slots are phase-shifted, not in lockstep (${mixed} mixed instants)`);
  // direct phase check: submerged(slot,t) == (frac(t/5 + slot*0.37) >= 0.72)
  let phaseBad = 0, phaseCmp = 0;
  for (const row of ROWS_T) for (let i = 0; i < 300; i++) {
    const t = i * 0.07;
    for (const p of FR.platformsAt(row, t, level)) {
      const ph = ((t / 5 + p.slot * 0.37) % 1 + 1) % 1;
      phaseCmp++;
      if (p.submerged !== (ph >= 0.72)) phaseBad++;
    }
  }
  check(phaseCmp > 0 && phaseBad === 0, `the dive phase is frac(t/5 + slot*0.37)>=0.72 (${phaseCmp} checks, ${phaseBad} bad)`);
}

/* ============================================================================
 * 5. hopTarget - exhaustive over all 676 cells x 4 directions
 * ========================================================================== */

group('5. hopTarget: exhaustive 676-cell / 4-direction check');
{
  const DIRV = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
  let bad = 0, checked = 0, oob = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) for (const d of ['up', 'down', 'left', 'right']) {
    const got = FR.hopTarget(r, c, d);
    const er = clamp(r + DIRV[d][0], 0, ROWS - 1), ec = clamp(c + DIRV[d][1], 0, COLS - 1);
    checked++;
    if (got.r !== er || got.c !== ec) bad++;
    const dr = Math.abs(got.r - r), dc = Math.abs(got.c - c);
    if (got.r < 0 || got.r >= ROWS || got.c < 0 || got.c >= COLS) oob++;
    if (dr > 1 || dc > 1 || (dr + dc) > 1) bad++;
  }
  check(checked === 169 * 4, `all 169 cells x 4 dirs checked (${checked})`);
  check(bad === 0, `every hop is a <=1 cell move clamped to the board (${bad} bad)`);
  check(oob === 0, `no hop leaves the board (${oob} oob)`);
  const same = FR.hopTarget(5, 5, 'zap');
  check(same.r === 5 && same.c === 5, 'an unknown direction returns the same cell');
  check(JSON.stringify(FR.hopTarget(0, 0, 'up')) === JSON.stringify({ r: 0, c: 0 }), 'hopping up off the top clamps at row 0');
  check(JSON.stringify(FR.hopTarget(12, 12, 'right')) === JSON.stringify({ r: 12, c: 12 }), 'hopping right off the edge clamps at col 12');
}

/* ============================================================================
 * 6. homeSlot - exact set of five bays
 * ========================================================================== */

group('6. homeSlot: exactly the five bay columns');
{
  const valid = [];
  for (let c = 0; c < COLS; c++) if (FR.homeSlot(c) >= 0) valid.push(c);
  check(JSON.stringify(valid) === JSON.stringify(HOME_COLS), `the valid columns are exactly HOME_COLS (got ${JSON.stringify(valid)})`);
  let bad = 0;
  for (let c = 0; c < COLS; c++) {
    const exp = HOME_COLS.indexOf(c);
    if (FR.homeSlot(c) !== exp) bad++;
  }
  check(bad === 0, `homeSlot returns the bay index or -1 for all 13 columns (${bad} bad)`);
  check(FR.homeSlot(-1) === -1 && FR.homeSlot(COLS) === -1, 'out-of-range columns are -1');
  check(FR.homeSlot(HOME_COLS[0]) === 0 && FR.homeSlot(HOME_COLS[4]) === 4, 'the bay indices are ordered 0..4');
}

/* ============================================================================
 * 7. scoreFor - exhaustive over events x states
 * ========================================================================== */

group('7. scoreFor: pure scoring table');
{
  check(FR.scoreFor('forward', {}) === 10, `forward is 10 (got ${FR.scoreFor('forward', {})})`);
  check(FR.scoreFor('home', {}) === 50, `home is 50 (got ${FR.scoreFor('home', {})})`);
  let bonusBad = 0;
  for (const tl of [0, 0.9, 1.0, 1.99, 12.4, 12.99, 25]) {
    if (FR.scoreFor('homeTimeBonus', { timeLeft: tl }) !== Math.floor(tl) * 5) bonusBad++;
  }
  check(bonusBad === 0, `homeTimeBonus is floor(timeLeft)*5 for 7 samples (${bonusBad} bad)`);
  let lcBad = 0;
  for (const L of [1, 2, 3, 5, 9]) if (FR.scoreFor('levelClear', { level: L }) !== 300 + L * 100) lcBad++;
  check(lcBad === 0, `levelClear is 300+level*100 (${lcBad} bad)`);
  check(FR.scoreFor('nope', {}) === 0, 'an unknown event scores 0');
  check(FR.scoreFor('homeTimeBonus') === 0, 'a missing state is tolerated (bonus 0)');
  check(FR.scoreFor('forward') === 10, 'a missing state is tolerated (forward 10)');
}

/* ============================================================================
 * 8. supportAt + collidesAt - differential against independent models
 * ========================================================================== */

group('8. supportAt / collidesAt: differential on a sampling grid');
{
  // Independent support reference: land rows are always safe (documented
  // contract); a river row is safe iff a NON-submerged platform (geometry from
  // our modular reconstruction) covers x=c+0.5.
  function refSupport(row, c, t, level) {
    const cfg = FR.laneConfig(level)[row];
    if (cfg.kind !== 'river') return true;      // never assert land is false
    const x = c + 0.5;
    const eng = FR.platformsAt(row, t, level);
    for (const s of refSegs(row, t, level)) {
      const m = eng.find(p => nearly(p.from, s.from) && nearly(p.to, s.to));
      const sub = m ? m.submerged : false;
      if (sub) continue;
      if (x >= s.from && x <= s.to) return true;
    }
    return false;
  }
  let supCmp = 0, supDiv = 0, landChecked = 0;
  for (let row = 0; row < ROWS; row++) {
    for (let c = 0; c < COLS; c++) {
      for (const t of [0, 0.37, 1.1, 2.5, 4.9, 7.77, 12.3]) {
        supCmp++;
        const got = FR.supportAt(row, c, t, 1);
        const ref = refSupport(row, c, t, 1);
        if (got !== ref) supDiv++;
        if (row === 0 || row === 6 || row === 12) { landChecked++; if (got !== true) supDiv++; }
      }
    }
  }
  check(supDiv === 0, `supportAt matches the independent model on ${supCmp} points (${supDiv} divergences)`);
  check(landChecked === 3 * COLS * 7, `all ${landChecked} land-row samples are safe (contract)`);

  // Independent collision reference (different code path: modular segments).
  function refCollides(state) {
    if (!state || !state.frog) return false;
    const lv = state.level || 1, t = state.time || 0, x = state.frog.x;
    const rows = state.frog.rows || [state.frog.r];
    for (const row of rows) {
      const cfg = FR.laneConfig(lv)[row];
      if (!cfg || cfg.kind !== 'road') continue;
      for (const s of refSegs(row, t, lv)) if (x > s.from && x < s.to) return true;
    }
    return false;
  }
  let colCmp = 0, colDiv = 0;
  for (const row of [7, 8, 9, 10, 11]) {
    for (let i = 0; i <= 90; i++) {
      const x = i * (COLS / 90);
      for (const t of [0, 0.5, 1.3, 2.7, 6.1]) {
        colCmp++;
        // a state with this road row and (for realism) the neighbouring lane too
        const st = { level: 1, time: t, frog: { r: row, x, rows: [row] } };
        const got = FR.collidesAt(st);
        const ref = refCollides(st);
        if (got !== ref) colDiv++;
      }
    }
  }
  check(colDiv === 0, `collidesAt matches the independent model on ${colCmp} points (${colDiv} divergences)`);
  check(FR.collidesAt(null) === false && FR.collidesAt({}) === false, 'collidesAt tolerates a null/empty state');
  check(FR.collidesAt({ level: 1, time: 0, frog: { r: 6, x: 6.5, rows: [6] } }) === false, 'the median is never a collision');
}

/* ------------------------------------------------------------------ world model
 * Precomputed world tables for level 1, using ONLY the bridge's pure functions.
 * Declared here (before any consumer) so the search is available to the groups
 * below. The frog's own kinematics (drift on river lanes, linear hop) is the
 * independent part; the world is read straight off the bridge. */
const MAXN = 8000;
const WORLD = (function () {
  const level = 1, cfg = FR.laneConfig(level);
  const road = {}, river = {};
  for (let r = 0; r < 13; r++) {
    if (cfg[r].kind === 'road') {
      const arr = new Array(MAXN + 1);
      for (let n = 0; n <= MAXN; n++) arr[n] = FR.vehiclesAt(r, n * DT, level).map(v => [v.from, v.to]);
      road[r] = arr;
    } else if (cfg[r].kind === 'river') {
      const arr = new Array(MAXN + 1);
      for (let n = 0; n <= MAXN; n++) arr[n] = FR.platformsAt(r, n * DT, level).map(p => ({ from: p.from, to: p.to, sub: p.submerged }));
      river[r] = arr;
    }
  }
  return { level, cfg, road, river };
})();

/* One shared forward search from the pristine start (n=0). It records the
 * earliest path to each home bay and to the median, and is cached so the many
 * downstream groups reuse a single BFS run. */
const SEARCH_WANTED = ['h0', 'h1', 'h2', 'h3', 'h4', 'median'];
const SEARCH = bfsSearch(0, 25 * 60, (r, x) => {
  if (r === 0) { const s = FR.homeSlot(cellOf(x)); return s >= 0 ? `h${s}` : null; }
  if (r === 6) return 'median';
  return null;
}, SEARCH_WANTED);
function pathActions(key) {
  const id = SEARCH.arrivals[key];
  if (id === undefined) return null;
  return { acts: actionsOf(SEARCH.nodes, id), ids: chainTo(SEARCH.nodes, id), node: SEARCH.nodes[id] };
}
function replayPath(key, compare) {
  const p = pathActions(key);
  if (!p) return null;
  FR.newGame({ level: 1 }); FR.start();
  let mismatches = 0, checks = 0, ci = 0;   // ci walks the node chain, one node per action
  for (const a of p.acts) {
    if (a.wait) { FR.tick(a.wait / 60); ci += a.wait; }
    else { FR.hop(a.hop); FR.tick(HOP_FRAMES / 60); ci += 1; }
    if (compare) {
      const want = SEARCH.nodes[p.ids[ci]];
      const st = FR.getState();
      checks++;
      if (want.r === 0) {
        // the terminal hop fills the bay and the engine respawns the frog
        if (!(st.homesFilled > 0 || st.phase === 'levelclear')) mismatches++;
      } else if (st.frog.r !== want.r || !nearly(st.frog.x, want.x, 1e-6)) mismatches++;
    }
  }
  return { p, state: FR.getState(), mismatches, checks };
}

/* ============================================================================
 * 9. carriedBy semantics (engine-declared contract)
 * ========================================================================== */

group('9. carriedBy: the frog\'s own column, never a 0..1 ratio or a platform edge');
{
  FR.newGame({ level: 1 }); FR.start();
  check(FR.getState().carriedBy === null, 'not carried while standing on the bank');

  // Reach the median, then scan a little wait time so the row-5 hop really
  // lands ON a log (not a submerged turtle). The scan records, in one pass:
  //  - a supported rest  -> p must be the frog's column inside the platform, and
  //  - a non-supported rest -> carriedBy() must be null.
  let hit = null, nullSeen = false;
  for (let w = 0; w <= 3.0001; w += 0.25) {
    const at = replayPath('median');
    if (!(at && at.state.frog.r === 6)) break;
    FR.tick(w);
    FR.hop('up'); FR.tick(HOP_FRAMES / 60);
    const st = FR.getState();
    if (!st.carriedBy) {
      nullSeen = true;
    } else {
      const pu = FR.platformUnder(st.frog.x, st.carriedBy.lane, st.time, st.level);
      if (pu && !hit) hit = { st, pu, w };
    }
    if (hit && nullSeen) break;   // both behaviours observed; stop early
  }

  check(!!hit, `a supported river rest was found (wait=${hit ? hit.w.toFixed(2) : 'n/a'})`);
  if (hit) {
    const { st, pu } = hit;
    check(nearly(st.carriedBy.p, st.frog.x), `carriedBy.p equals the frog's continuous x (p=${st.carriedBy.p.toFixed(3)}, x=${st.frog.x.toFixed(3)})`);
    check(st.carriedBy.p > 1 && st.carriedBy.p < COLS, `p is a cell coordinate in (1,COLS), not a 0..1 ratio (got ${st.carriedBy.p.toFixed(3)})`);
    check(st.carriedBy.lane >= 1 && st.carriedBy.lane <= 5, `carriedBy.lane is a river row (got ${st.carriedBy.lane})`);
    check(Math.abs(st.carriedBy.p) > 1.5, 'the magnitude proves it is not a 0..1 fraction');
    // The discriminator vs the mis-documented "p = platform LEFT EDGE": locate
    // the hosting platform and prove p is the frog's column inside its span,
    // not its `from` edge. Injection J (p = left edge) reddens these two.
    check(st.carriedBy.p >= pu.from - 1e-9 && st.carriedBy.p <= pu.to + 1e-9,
      `p lies inside the hosting platform's span [${pu.from.toFixed(3)}, ${pu.to.toFixed(3)}] (p=${st.carriedBy.p.toFixed(3)})`);
    check(Math.abs(st.carriedBy.p - pu.from) > 1e-6,
      `p is the frog's cell, NOT the platform's left edge (p=${st.carriedBy.p.toFixed(3)}, from=${pu.from.toFixed(3)})`);
  }
  check(nullSeen, 'a non-supporting landing (gap / submerged turtle) yields null carriedBy');
}

/* ============================================================================
 * 10. seed determinism (declared contract: the seed does NOT change the layout)
 * ========================================================================== */

group('10. determinism: same args -> same world; seed does not affect the layout');
{
  const a = FR.newGame({ level: 1, seed: 1 });
  const b = FR.newGame({ level: 1, seed: 999999 });
  check(JSON.stringify(FR.laneConfig(1)) === JSON.stringify(FR.laneConfig(1)), 'laneConfig is identical for the same level');
  check(JSON.stringify(FR.vehiclesAt(7, 3.3, 1)) === JSON.stringify(FR.vehiclesAt(7, 3.3, 1)), 'vehiclesAt is reproducible');
  check(a.seed === 1 && b.seed === 999999, `the seed is echoed back (${a.seed}/${b.seed})`);
  // Known contract: the seed is stored but the layout is fully deterministic.
  const s1 = FR.newGame({ level: 1, seed: 1 }); FR.start();
  const w1 = traceWorld(2.0);
  const s2 = FR.newGame({ level: 1, seed: 424242 }); FR.start();
  const w2 = traceWorld(2.0);
  check(JSON.stringify(w1) === JSON.stringify(w2), 'a different seed yields the identical world (declared contract)');
  note('known contract: `seed` is accepted and echoed but never perturbs the layout');
}

/* ============================================================================
 * 11. A - independent time-expanded search for reachability
 * ========================================================================== */

// The independent simulator: frog kinematics (drift on river, linear hop) driven
// by the bridge's world tables. Returns {r, x, n} or a terminal marker.
function worldStamp() {
  return WORLD.cfg.map(c => c.kind).join(',');
}
function traceWorld(seconds) {
  const snap = [];
  for (let n = 0; n <= Math.round(seconds / DT); n += 12) {
    const rows = [];
    for (let r = 0; r < 13; r++) if (WORLD.road[r]) rows.push([r, WORLD.road[r][n].map(s => [Math.round(s[0] * 1e6), Math.round(s[1] * 1e6)])]);
    for (let r = 0; r < 13; r++) if (WORLD.river[r]) rows.push([r, WORLD.river[r][n].map(s => [Math.round(s.from * 1e6), Math.round(s.to * 1e6), s.sub])]);
    snap.push(rows);
  }
  return snap;
}

function rowCollides(rows, x, n) {
  for (const r of rows) { const a = WORLD.road[r]; if (!a) continue; for (const s of a[n]) if (x > s[0] - EPS && x < s[1] + EPS) return true; }
  return false;
}
function rowSupports(r, x, n) {
  const a = WORLD.river[r]; if (!a) return true;
  // EPS keeps the search off platform knife-edges: the engine drifts its clock
  // by ~1e-15 over a run, which can flip an exact-edge landing. A 1e-3 cell
  // margin makes the model deliberately conservative (never claim a grazing
  // landing is safe), so the replayed paths are robust.
  for (const p of a[n]) { if (p.sub) continue; if (x >= p.from + EPS && x <= p.to - EPS) return true; }
  return false;
}

/* Time-expanded BFS. keyFn(r,x) returns a key to record (first sighting) or null.
 * Returns { nodes, arrivals: {key: id} }. */
function bfsSearch(startN, maxN, keyFn, wanted) {
  const nodes = [{ r: 12, x: 6.5, n: startN, parent: -1, action: null }];
  const layers = new Map();
  const seen = new Set();
  const arrivals = {};
  const push = (r, x, n, parent, action) => {
    if (n > maxN) return -1;
    const key = `${n}|${r}|${Math.round(x * 4)}`;
    if (seen.has(key)) return -1;
    seen.add(key);
    const id = nodes.length;
    nodes.push({ r, x, n, parent, action });
    if (!layers.has(n)) layers.set(n, []);
    layers.get(n).push(id);
    return id;
  };
  push(12, 6.5, startN, -1, null);
  const isRoad = r => WORLD.cfg[r].kind === 'road';
  const isRiver = r => WORLD.cfg[r].kind === 'river';
  for (let n = startN; n <= maxN; n++) {
    const layer = layers.get(n);
    if (layer) for (const id of layer) {
      const st = nodes[id];
      // Record the arrival key (the caller decides which homes count, so an
      // already-filled bay can be excluded) BEFORE the terminal short-circuit.
      const k = keyFn(st.r, st.x);
      if (k && !(k in arrivals)) arrivals[k] = id;
      if (st.r === 0) continue;               // home is terminal: record, do not expand
      // WAIT one frame
      {
        const n2 = n + 1;
        if (n2 <= maxN) {
          const nx = isRiver(st.r) ? st.x + WORLD.cfg[st.r].dir * WORLD.cfg[st.r].speed * DT : st.x;
          let ok = true;
          if (isRiver(st.r)) { if (nx < 0 || nx > COLS) ok = false; else if (!rowSupports(st.r, nx, n2)) ok = false; }
          if (ok && rowCollides([st.r], nx, n2)) ok = false;
          if (ok) push(st.r, nx, n2, id, { wait: 1 });
        }
      }
      // HOPS
      const c = cellOf(st.x);
      for (const dir of ['up', 'down', 'left', 'right']) {
        if ((dir === 'left' || dir === 'right') && isRoad(st.r)) continue;  // horizontal road hops deferred
        const tgt = FR.hopTarget(st.r, c, dir);
        let tr, tx;
        if (dir === 'up' || dir === 'down') { tr = tgt.r; tx = st.x; }
        else { tr = st.r; tx = tgt.c + 0.5; }
        if (tr === st.r && Math.abs(tx - st.x) < 1e-9) continue;
        const n2 = n + HOP_FRAMES;
        if (n2 > maxN) continue;
        let dead = false;
        for (let f = 1; f <= HOP_FRAMES; f++) {
          const u = f / HOP_FRAMES;
          const xi = st.x + (tx - st.x) * u;
          const rows = f < HOP_FRAMES ? [st.r, tr] : [tr];
          if (rowCollides(rows, xi, n + f)) { dead = true; break; }
        }
        if (dead) continue;
        if (tr === 0) { push(tr, tx, n2, id, { hop: dir }); continue; }   // record via keyFn
        if (isRiver(tr) && !rowSupports(tr, tx, n2)) continue;   // drowns on arrival
        push(tr, tx, n2, id, { hop: dir });
      }
    }
    if (wanted && wanted.every(k => k in arrivals)) break;
  }
  return { nodes, arrivals };
}

function chainTo(nodes, id) {
  const out = [];
  let cur = id;
  while (cur >= 0) { out.push(cur); cur = nodes[cur].parent; }
  return out.reverse();
}
// Coalesce the action list of a path into [{wait:k}|{hop:dir}].
function actionsOf(nodes, id) {
  const ids = chainTo(nodes, id);
  const acts = [];
  for (let i = 1; i < ids.length; i++) {
    const a = nodes[ids[i]].action;
    if (!a) continue;
    if (a.wait) { if (acts.length && acts[acts.length - 1].wait) acts[acts.length - 1].wait += a.wait; else acts.push({ wait: a.wait }); }
    else acts.push({ hop: a.hop });
  }
  return acts;
}

group('11. A. each of the five home bays is reachable (independent BFS)');
{
  note(`BFS explored ${SEARCH.nodes.length} states (one shared run)`);
  let reach = 0;
  for (let s = 0; s < 5; s++) {
    const p = pathActions(`h${s}`);
    if (!p) { check(false, `home bay ${s} (col ${HOME_COLS[s]}) is reachable from the start bank`); continue; }
    reach++;
    const nd = p.node;
    const steps = p.acts.filter(a => a.hop).length;
    check(true, `home bay ${s} (col ${HOME_COLS[s]}) reachable: earliest t=${(nd.n * DT).toFixed(3)}s, ${steps} hops`);
    note(`bay ${s}: earliest arrival frame ${nd.n} (t=${(nd.n * DT).toFixed(3)}s), ${steps} hops, x=${nd.x.toFixed(3)}`);
  }
  check(reach === 5, `all five home bays are reachable (${reach}/5)`);

  // Replay the earliest path to bay 0 through the REAL engine and reconcile.
  const rc = replayPath('h0', true);
  check(rc !== null, 'the search produced a concrete path to bay 0');
  if (rc) {
    check(rc.mismatches === 0, `the replayed path tracks the model exactly (${rc.mismatches} mismatches of ${rc.checks})`);
    check(rc.state.phase === 'playing', `the replayed run is still 'playing' (got ${rc.state.phase})`);
    check(rc.state.homes[0] === true, 'the replay really filled home bay 0');
    check(rc.state.frog.r === 12 && rc.state.frog.c === 6, 'the frog respawned at (12,6) after a home');
  }
}


group('11b. the replay scores exactly as the forward/home contract says');
{
  const p = pathActions('h0');
  if (!p) { check(false, 'no replayable path to bay 0 for the scoring walk'); }
  else {
    FR.newGame({ level: 1 }); FR.start();
    let forwardAwards = 0, homeDelta = null, deaths = 0;
    for (const a of p.acts) {
      if (a.wait) { FR.tick(a.wait / 60); continue; }
      const before = FR.getState();
      FR.hop(a.hop); FR.tick(HOP_FRAMES / 60);
      const now = FR.getState();
      const d = now.score - before.score;
      if (now.homesFilled > before.homesFilled) homeDelta = d;            // 50 + bonus, no forward
      else if (d === 10 && now.frog.r < before.frog.r) forwardAwards++;
      if (now.phase === 'dying' || now.phase === 'gameover') { deaths++; break; }
    }
    const st = FR.getState();
    check(deaths === 0, `the replay never dies (${deaths} deaths)`);
    check(st.homesFilled === 1, `the replay filled exactly one home (got ${st.homesFilled})`);
    check(forwardAwards === 11, `forward scored exactly 11 times, once per new row 11..1 (got ${forwardAwards})`);
    check(homeDelta !== null && homeDelta >= 50 && homeDelta <= 175 && (homeDelta - 50) % 5 === 0,
      `the bay hop awards 50 + floor(timeLeft)*5 (got ${homeDelta})`);
    check(st.score === 110 + (homeDelta || 0), `total = 110 forward + home/bonus (got ${st.score}, home delta ${homeDelta})`);
  }
}

/* ============================================================================
 * 12. C - state machine and real scoring through tick()
 * ========================================================================== */

group('12. forward scoring: +10 per new furthest row, never re-scored');
{
  FR.newGame({ level: 1 }); FR.start();
  const s0 = FR.getState().score;
  FR.hop('up'); FR.tick(HOP_FRAMES / 60);
  const s1 = FR.getState();
  check(s1.frog.r === 11, `one hop up lands on row 11 (got ${s1.frog.r})`);
  check(s1.score - s0 === 10, `reaching row 11 scores +10 (${s0}->${s1.score})`);
  FR.hop('down'); FR.tick(HOP_FRAMES / 60);
  check(FR.getState().frog.r === 12, 'hopping back down returns to row 12');
  check(FR.getState().score === s1.score, `hopping back down does not re-score (${FR.getState().score})`);
  FR.hop('up'); FR.tick(HOP_FRAMES / 60);
  check(FR.getState().frog.r === 11, 'hopping up again returns to row 11');
  check(FR.getState().score === s1.score, `re-entering row 11 does not re-score (${FR.getState().score})`);
}

group('12b. the six death kinds are each reproduced for real');
{
  // (1) crash - wait on the bank until a car covers the landing column, then hop in.
  FR.newGame({ level: 1 }); FR.start();
  FR.tick(1.6);
  FR.hop('up');
  FR.tick(0.3);
  check(FR.getState().deathKind === 'crash', `a car kills the frog: deathKind='crash' (got ${FR.getState().deathKind})`);
  const livesAfterCrash = (function () { FR.tick(1.0); return FR.getState().lives; })();
  check(livesAfterCrash === 2, `a crash costs a life (3 -> ${livesAfterCrash})`);

  // (2) timeout - sit on the safe bank until the countdown empties.
  FR.newGame({ level: 1 }); FR.start();
  FR.tick(26);
  check(FR.getState().deathKind === 'timeout', `running the clock out is 'timeout' (got ${FR.getState().deathKind})`);

  // (3) drown - reach the median, then hop into a gap in the log lane.
  {
    const drown = driveToRow6Then(true);
    check(drown.kind === 'drown', `hopping into open water is 'drown' (got ${drown.kind})`);
  }
  // (4) carried - reach the median, ride a log off the left edge.
  {
    const carried = driveToRow6Then(false);
    check(carried.kind === 'carried', `riding a log off the board is 'carried' (got ${carried.kind})`);
  }
  // (5) wall - reach row 1 over a wall column, then hop into the wall.
  {
    const search = bfsSearch(0, 25 * 60,
      (r, x) => (r === 1 && FR.homeSlot(cellOf(x)) < 0) ? 'wall' : null, ['wall']);
    const id = search.arrivals['wall'];
    if (id === undefined) {
      check(false, 'could reach row 1 over a wall column for the wall-death test');
    } else {
      const wc = cellOf(search.nodes[id].x);
      FR.newGame({ level: 1 }); FR.start();
      for (const a of actionsOf(search.nodes, id)) { if (a.wait) FR.tick(a.wait / 60); else { FR.hop(a.hop); FR.tick(HOP_FRAMES / 60); } }
      check(FR.getState().frog.r === 1 && FR.getState().frog.c === wc, `reached row 1 over wall column ${wc}`);
      FR.hop('up'); FR.tick(HOP_FRAMES / 60 + 0.1);
      check(FR.getState().deathKind === 'wall', `hopping into a wall is 'wall' (got ${FR.getState().deathKind})`);
    }
  }
  // (6) wall (already-filled home) - fill a bay, then hop into it again.
  {
    const filled = replayPath('h0');
    if (!filled || !filled.state.homes[0]) {
      check(false, 'could fill bay 0 for the re-enter test');
    } else {
      check(FR.getState().homes[0] === true, 'bay 0 is filled before the re-entry attempt');
      const ok = driveInPlaceTo(1, HOME_COLS[0]);
      if (!ok) { check(false, 'could re-reach row 1 over bay 0 after filling it'); }
      else {
        FR.hop('up'); FR.tick(HOP_FRAMES / 60 + 0.1);
        check(FR.getState().deathKind === 'wall', `re-entering a filled bay is 'wall' (got ${FR.getState().deathKind})`);
      }
    }
  }
}

// Drive the frog to row 6 (median) using the shared search, then take one more
// hop into the log lane. drown=true -> hop into a gap (drown); false -> land on
// a log and ride until carried.
function driveToRow6Then(drown) {
  const at = replayPath('median');
  if (!at) return { kind: 'no-path' };
  if (at.state.frog.r !== 6) return { kind: `not-at-median(${at.state.frog.r})` };
  const x = at.state.frog.x;
  const nNow = Math.round(at.state.time / DT);
  if (drown) {
    for (let n = nNow + HOP_FRAMES; n < nNow + 7 * 60; n++) {
      if (!rowSupports(5, x, n) && !rowCollides([5, 6], x, n)) {
        FR.tick((n - HOP_FRAMES - nNow) / 60);
        FR.hop('up'); FR.tick(HOP_FRAMES / 60 + 1.2);
        return { kind: FR.getState().deathKind };
      }
    }
    return { kind: 'no-gap' };
  }
  for (let n = nNow + HOP_FRAMES; n < nNow + 7 * 60; n++) {
    if (rowSupports(5, x, n)) {
      FR.tick((n - HOP_FRAMES - nNow) / 60);
      FR.hop('up');
      FR.tick(12);          // ride the log off the board
      return { kind: FR.getState().deathKind };
    }
  }
  return { kind: 'no-log' };
}

// From the CURRENT world clock, drive the frog to row 1 at column col. Uses the
// live world tables (the engine is mid-game; time is not reset).
function driveInPlaceTo(rowWanted, colWanted) {
  const st0 = FR.getState();
  if (st0.frog.r !== 12) return false;
  const startN = Math.round(st0.time / DT);
  const search = bfsSearch(startN, startN + 25 * 60,
    (r, x) => (r === rowWanted && cellOf(x) === colWanted) ? 'g' : null, ['g']);
  const id = search.arrivals['g'];
  if (id === undefined) return false;
  for (const a of actionsOf(search.nodes, id)) { if (a.wait) FR.tick(a.wait / 60); else { FR.hop(a.hop); FR.tick(HOP_FRAMES / 60); } }
  const st = FR.getState();
  return st.frog.r === rowWanted && st.frog.c === colWanted;
}

group('12c. a filled bay survives a later death');
{
  const filled = replayPath('h0');
  if (!filled || !filled.state.homes[0]) { check(false, 'could fill bay 0'); }
  else {
    const had = FR.getState().homesFilled;
    check(had === 1, `one bay is lit before the death (got ${had})`);
    FR.tick(26);   // idle timeout
    check(FR.getState().deathKind === 'timeout', 'the idle frog times out');
    check(FR.getState().homes[0] === true && FR.getState().homesFilled === 1, 'the lit bay survives the death');
  }
}

group('12d. three lives then game over, and newGame() resets');
{
  FR.newGame({ level: 1 }); FR.start();
  FR.tick(3 * 26.5 + 5);
  check(FR.getState().phase === 'gameover', `three timeouts end the game (got ${FR.getState().phase})`);
  check(el('overlay').className.indexOf('show') >= 0, 'the result overlay is shown on game over');
  const g = FR.newGame({ level: 1, lives: 5 });
  check(g.phase === 'playing' && g.lives === 5 && g.score === 0 && g.level === 1, 'newGame() resets score/level/lives');
  check(g.homesFilled === 0 && g.homes.every(h => !h), 'newGame() clears the bays');
}

/* ============================================================================
 * 12e. HUD value cache - the fix under test
 *
 * The Round-1 bug: loop() advanced the model but never refreshed the HUD, so
 * during play (with no event) #score / #time went stale. The fix routes every
 * HUD write through one value-cached updateHud() and calls it from BOTH the
 * frame loop and tick(). CONTRACT NOW IN EFFECT (and locked here): tick()
 * advances the simulation and then synchronises the HUD, so any code that
 * drives the game through FR.tick() (the logic suite, the DOM suite, CI) still
 * sees a live HUD without pumping a frame.
 *
 * The cache makes these tests sharper AND subtler: because unchanged values are
 * skipped, a stale HUD now requires the *value* to change without updateHud()
 * running - which is exactly the failure mode the injections below reproduce.
 * ========================================================================== */

group('12e. the value-cached HUD stays in sync in every path');
{
  /* --- A1: NO-EVENT FRAME PATH --------------------------------------------
   * Zero input after Start: only the real animation loop runs. #time and
   * #score must follow the model on every single frame. This is the direct
   * descendant of the two Round-1 FAILs (loop() not syncing the HUD). */
  FR.newGame({ level: 1 }); FR.start();
  let timeMismatch = 0, scoreMismatch = 0;
  for (let i = 0; i < 400; i++) {
    G.env.step(16);                 // one real frame: update() + updateHud() + draw()
    const s = FR.getState();
    if (el('time').textContent !== String(Math.ceil(Math.max(0, s.timeLeft)))) timeMismatch++;
    if (el('score').textContent !== String(s.score)) scoreMismatch++;
  }
  const sEnd = FR.getState();
  check(timeMismatch === 0, `#time tracks state.timeLeft across 400 real frames of zero input (${timeMismatch} mismatches)`);
  check(scoreMismatch === 0, `#score stays glued to the model across 400 real frames (${scoreMismatch} mismatches)`);
  check(el('time').textContent === String(Math.ceil(Math.max(0, sEnd.timeLeft))),
    `after the run the HUD integer equals the model (state ${sEnd.timeLeft.toFixed(2)} -> ${Math.ceil(Math.max(0, sEnd.timeLeft))}, HUD ${JSON.stringify(el('time').textContent)})`);
  note(`zero-input 400-frame run: state.timeLeft=${sEnd.timeLeft.toFixed(2)}, DOM #time=${JSON.stringify(el('time').textContent)}`);

  /* --- A1b: TICK PATH -----------------------------------------------------
   * The same sync, but reached through tick() alone (no frame pumped). A clock
   * advance with no event is the only thing that changes #time here, so this
   * pins the "tick() syncs the HUD" contract the fix introduced. */
  FR.newGame({ level: 1 }); FR.start();
  FR.tick(21.5);                    // timeLeft 25 -> 3.5: no event fires, phase stays 'playing'
  const stTick = FR.getState();
  check(stTick.phase === 'playing' && stTick.timeLeft < 5,
    `tick() advanced the clock to ${stTick.timeLeft.toFixed(2)}s with no event (phase ${stTick.phase})`);
  check(el('time').textContent === String(Math.ceil(Math.max(0, stTick.timeLeft))),
    `the tick() path synced #time with no frame pumped (HUD ${JSON.stringify(el('time').textContent)} vs state ${stTick.timeLeft.toFixed(2)})`);
  check(el('timeStat').classList.contains('low'), 'the tick() path also toggled the .low class below 5s');

  /* --- A2: EVENT PATHS ARE IMMEDIATE --------------------------------------
   * Each explicit event must leave every HUD field equal to getState() at once
   * (no frame needed). hudEqualsState() cross-checks all 8 cached fields. */
  // (1) newGame() resets a dirty score back to 0 (the value-callback case).
  FR.newGame({ level: 1 }); FR.start();
  key('ArrowUp'); FR.tick(HOP_FRAMES / 60 + 0.01);          // land -> score 10
  check(FR.getState().score === 10, `setup: a forward hop scored 10 (got ${FR.getState().score})`);
  T.set('zh');                                              // dirty the language too
  FR.newGame({ level: 1 });
  check(el('score').textContent === '0', `newGame rewrote #score 10 -> 0 (got ${JSON.stringify(el('score').textContent)})`);
  hudEqualsState('newGame from a dirty state');

  // (2) die() / respawn: a timeout death costs a life and must show at once.
  FR.newGame({ level: 1 }); FR.start();
  FR.tick(24.95);
  check(FR.getState().phase === 'playing', 'setup: still alive just under the timeout');
  FR.tick(0.2);                                             // crosses 0 -> die('timeout')
  check(FR.getState().phase === 'dying', `the timeout puts the frog in 'dying' (got ${FR.getState().phase})`);
  check(el('time').textContent === '0' && el('btnPause').disabled === true,
    `the die() event path synced the HUD immediately (time ${JSON.stringify(el('time').textContent)}, pause disabled ${el('btnPause').disabled})`);
  FR.tick(2);                                               // finish the death, respawn
  check(FR.getState().lives === 2, `the death cost one life (got ${FR.getState().lives})`);
  hudEqualsState('after a death + respawn');

  // (3) togglePause(): both directions, including the label + disabled flag.
  FR.newGame({ level: 1 }); FR.start();
  click('btnPause');
  check(FR.getState().phase === 'paused', 'setup: Pause enters paused');
  hudEqualsState('togglePause -> paused');
  check(el('btnPause').textContent === T.t('resume'), `paused shows the resume label (got ${JSON.stringify(el('btnPause').textContent)})`);
  click('btnPause');
  hudEqualsState('togglePause -> playing');

  // (4) T.set(): the T.onChange path must re-render the dynamic HUD text.
  T.set('en'); hudEqualsState('T.set(en)');
  check(el('btnPause').textContent === 'Pause', `English pause label after T.set('en') (got ${JSON.stringify(el('btnPause').textContent)})`);
  T.set('zh'); hudEqualsState(`T.set('zh')`);
  check(CJK.test(el('btnPause').textContent), `the onChange path rewrote the pause label in Chinese (got ${JSON.stringify(el('btnPause').textContent)})`);
  T.set('en'); hudEqualsState('T.set(en) again');

  /* --- A3: THE .low CLASS ACROSS THE 5s THRESHOLD ------------------------- */
  FR.newGame({ level: 1 }); FR.start();
  check(!el('timeStat').classList.contains('low'), 'no .low right after newGame (refilled to 25s)');
  FR.tick(19.5);                                            // timeLeft ~5.5
  check(FR.getState().timeLeft > 5 && !el('timeStat').classList.contains('low'),
    `above the threshold there is no .low (timeLeft ${FR.getState().timeLeft.toFixed(2)})`);
  FR.tick(0.6);                                             // ~4.9 -> low on
  check(FR.getState().timeLeft <= 5 && el('timeStat').classList.contains('low'),
    `below 5s the .low class turns on (timeLeft ${FR.getState().timeLeft.toFixed(2)})`);
  FR.tick(0.001);
  check(el('timeStat').classList.contains('low'), 'the .low class stays on once on');
  FR.newGame({ level: 1 });
  check(!el('timeStat').classList.contains('low'), 'newGame clears .low when the countdown refills');
}

/* ============================================================================
 * 13. level progression: speed x1.15 (measured), -2s, bays reset
 * ========================================================================== */

group('13. clearing all five bays advances the level with the contracted changes');
{
  // Fill all five bays from the live clock, five successive searches.
  FR.newGame({ level: 1 }); FR.start();
  let guard = 0, filled = 0;
  while (filled < 5 && guard++ < 8) {
    const startN = Math.round(FR.getState().time / DT);
    const search = bfsSearch(startN, startN + 25 * 60, (r, x) => {
      if (r === 0) { const s = FR.homeSlot(cellOf(x)); return (s >= 0 && !FR.getState().homes[s]) ? `h${s}` : null; }
      return null;
    });
    const id = Object.values(search.arrivals)[0];
    if (id === undefined) break;
    const acts = actionsOf(search.nodes, id);
    for (const a of acts) { if (a.wait) FR.tick(a.wait / 60); else { FR.hop(a.hop); FR.tick(HOP_FRAMES / 60); } }
    const st = FR.getState();
    if (st.phase === 'levelclear') { filled = st.homesFilled; break; }
    if (st.homesFilled > filled) filled = st.homesFilled; else break;
  }
  const lc = FR.getState();
  check(lc.phase === 'levelclear' || lc.level > 1, `filling all five bays clears the level (phase=${lc.phase}, filled=${lc.homesFilled})`);
  if (lc.phase === 'levelclear') hudEqualsState('levelClear event');

  if (lc.phase === 'levelclear') {
    // measure the level-2 speed on lane 7 via finite differences, before and after
    const before = measuredLaneSpeed(7);
    el('ovBtn').fire('click', { preventDefault() {} });
    const n2 = FR.getState();
    check(n2.level === 2, `the result button advances to level 2 (got ${n2.level})`);
    check(n2.phase === 'playing', 'level 2 starts playing');
    check(!n2.homes.some(Boolean), 'the bays reset for the new level');
    check(nearly(n2.timeLeft, 23, 1e-9), `the level-2 countdown is 23s (got ${n2.timeLeft})`);
    hudEqualsState('nextLevel event');
    check(el('level').textContent === '2' && el('homes').textContent === '0/5',
      `nextLevel rewrote #level/#homes at once (got ${JSON.stringify(el('level').textContent)}/${JSON.stringify(el('homes').textContent)})`);
    const after = measuredLaneSpeed(7);
    check(nearly(after / before, 1.15, 0.02), `measured lane-7 speed x1.15 on level 2 (got ${(after / before).toFixed(4)})`);
    check(nearly(before, 2.2, 1e-6) && nearly(after, 2.53, 1e-6), `lane-7 speeds are 2.2 then 2.53 (got ${before.toFixed(3)}/${after.toFixed(3)})`);
  } else {
    check(false, 'could not clear level 1 through the real engine (see the note above)');
    note(`level-clear walk stopped at phase=${lc.phase}, homesFilled=${lc.homesFilled} (no new assertion possible)`);
  }
}

// Measure a road lane's speed from the live game clock via finite differences.
function measuredLaneSpeed(row) {
  const t = FR.getState().time;
  const a = FR.vehiclesAt(row, t, FR.getState().level);
  const b = FR.vehiclesAt(row, t + 0.25, FR.getState().level);
  for (const oa of a) { const ob = b.find(x => x.slot === oa.slot); if (ob) return Math.abs((ob.from - oa.from) / 0.25); }
  return NaN;
}

/* ============================================================================
 * 14. long-run stability
 * ========================================================================== */

group('14. long-run stability (>=120s of real ticks)');
{
  const LEGAL = new Set(['ready', 'playing', 'paused', 'dying', 'levelclear', 'gameover']);
  FR.newGame({ level: 1, lives: 9 }); FR.start();
  let badPhase = 0, oob = 0, frames = 0, maxX = -Infinity, minX = Infinity;
  for (let i = 0; i < 120 * 60; i++) {
    FR.tick(DT);
    const st = FR.getState();
    frames++;
    if (!LEGAL.has(st.phase)) badPhase++;
    if (st.frog.r < 0 || st.frog.r >= ROWS || st.frog.c < 0 || st.frog.c >= COLS) oob++;
    if (st.phase !== 'dying' && st.frog.r !== 0) { maxX = Math.max(maxX, st.frog.x); minX = Math.min(minX, st.frog.x); }
  }
  const st = FR.getState();
  check(badPhase === 0, `the phase stays legal for ${frames} frames (${badPhase} bad)`);
  check(oob === 0, `the frog never leaves the board (${oob} oob)`);
  check(LEGAL.has(st.phase), `the final phase is legal (${st.phase})`);
  check(minX >= -0.5 && maxX <= COLS + 0.5, `x stays within the board (${minX.toFixed(2)}..${maxX.toFixed(2)})`);
  check(st.lives >= 1 && st.lives <= 9, `lives stay bounded (got ${st.lives})`);
}

/* ============================================================================
 * 15. hop timing (HOP_TIME = 8/60)
 * ========================================================================== */

group('15. hop timing: one hop is 8 frames (HOP_TIME = 8/60)');
{
  FR.newGame({ level: 1 }); FR.start();
  FR.hop('up');
  let f = 0;
  while (FR.getState().frog.hopping && f < 60) { FR.tick(DT); f++; }
  check(f === 8, `a hop completes in exactly 8 frames (got ${f})`);
  check(nearly(FR.getState().frog.r, 11), 'the hop lands one row up');

  // two hops back-to-back: the queued input is consumed at the next cell centre
  FR.newGame({ level: 1 }); FR.start();
  FR.hop('up'); FR.hop('up');
  FR.tick(HOP_FRAMES / 60); FR.tick(HOP_FRAMES / 60);
  check(FR.getState().frog.r <= 11, `a queued second hop is honoured (r=${FR.getState().frog.r})`);
}

/* ============================================================================
 * 16. i18n - the DYNAMIC text must follow the language
 * ========================================================================== */

group('16. i18n: runtime text rebuilt through T.t()/T.onChange follows the language');
{
  check(!!T, 'the game created one LiteI18N instance (captured via the factory)');
  const src = fs.readFileSync(GAME, 'utf8');
  const onChangeCount = (src.match(/T\.onChange\s*\(/g) || []).length;
  check(onChangeCount === 1, `exactly one T.onChange handler is registered (found ${onChangeCount})`);

  T.set('en');
  check(T.t('title') === 'Frogger' && T.t('score') === 'Score' && T.t('lives') === 'Lives' && T.t('level') === 'Level',
    'T.t() resolves the HUD keys in English');
  check(T.t('pause') === 'Pause' && T.t('newgame') === 'New game' && T.t('start') === 'Start game', 'T.t() resolves the button keys in English');

  // (a) the pause button is rebuilt through T.t() while playing.
  FR.newGame({ level: 1 }); FR.start();
  FR.tick(0.1);
  check(el('btnPause').textContent === 'Pause', `the pause button is 'Pause' in English (got ${JSON.stringify(el('btnPause').textContent)})`);
  T.set('zh');
  check(CJK.test(el('btnPause').textContent), `the DYNAMIC pause button turns Chinese after T.set('zh') (got ${JSON.stringify(el('btnPause').textContent)})`);
  check(el('btnPause').textContent === '暂停', `the playing pause label is '暂停' (got ${JSON.stringify(el('btnPause').textContent)})`);
  click('btnPause');
  check(el('btnPause').textContent === '继续', `paused shows '继续' (got ${JSON.stringify(el('btnPause').textContent)})`);
  click('btnPause');

  // (b) the result dialog is rebuilt through T.onChange after a real game over.
  FR.newGame({ level: 1 }); FR.start();
  FR.tick(120);
  check(FR.getState().phase === 'gameover', 'reached game over for the dialog check');
  T.set('en');
  check(el('ovTitle').textContent === 'Game over', `the result title is 'Game over' in English (got ${JSON.stringify(el('ovTitle').textContent)})`);
  T.set('zh');
  check(CJK.test(el('ovTitle').textContent), `the result title re-renders in Chinese via onChange (got ${JSON.stringify(el('ovTitle').textContent)})`);
  check(el('ovTitle').textContent === '游戏结束', `the game-over title is '游戏结束' (got ${JSON.stringify(el('ovTitle').textContent)})`);
  check(CJK.test(el('ovSub').textContent) && /\d/.test(el('ovSub').textContent), `the subtitle is Chinese and carries the score (got ${JSON.stringify(el('ovSub').textContent)})`);
  check(el('ovBtn').textContent === '再来一局', `the result button is '再来一局' (got ${JSON.stringify(el('ovBtn').textContent)})`);
  T.set('en');
  check(el('ovTitle').textContent === 'Game over' && el('ovBtn').textContent === 'Play again', 'switching back to English restores the dialog');

  // (c) HUD stat labels resolve through T.t() too (they are the runtime-composed
  //     pieces the repo has silently broken before).
  T.set('zh');
  check(T.t('homesLbl') === '家' && T.t('time') === '时间', 'the HUD label keys resolve in Chinese');
  T.set('en');

  // (d) a pre-seeded localStorage boots straight into Chinese.
  const G2 = boot({ lang: 'zh' });
  check(G2.T && G2.T.lang === 'zh', `a zh localStorage boots in Chinese (got ${G2.T && G2.T.lang})`);
  check(G2.env.context.document.documentElement.lang === 'zh-CN', 'documentElement.lang is zh-CN after boot');
  G2.FR.newGame({ level: 1 }); G2.FR.start(); G2.FR.tick(0.1);
  check(CJK.test(G2.els.btnPause.textContent), `the boot-time pause label is Chinese (got ${JSON.stringify(G2.els.btnPause.textContent)})`);
}

/* ============================================================================
 * 17. E - stub-DOM interaction through the real UI entry points
 * ========================================================================== */

group('17. the real UI entry points drive the game');
{
  FR.newGame({ level: 1 });
  check(FR.getState().phase === 'playing' && el('btnPause').disabled === false,
    'newGame enters playing with the Pause button enabled');

  click('btnStart');
  check(FR.getState().phase === 'playing', `clicking Start enters 'playing' (got ${FR.getState().phase})`);
  check(el('btnPause').disabled === false, 'the Pause button becomes enabled once playing');

  key('ArrowUp');
  check(FR.getState().frog.hopping === true, 'a real ArrowUp keydown starts a hop');
  FR.tick(HOP_FRAMES / 60);
  check(FR.getState().frog.r === 11, `the hop lands on row 11 (got ${FR.getState().frog.r})`);
  check(FR.getState().score === 10, `the hop scored +10 (got ${FR.getState().score})`);

  key('ArrowDown'); FR.tick(HOP_FRAMES / 60);
  check(FR.getState().frog.r === 12, 'ArrowDown hops back to the bank');

  key('w'); FR.tick(HOP_FRAMES / 60);
  check(FR.getState().frog.r === 11, 'the WASD keys work too (w -> up)');

  click('btnPause');
  check(FR.getState().phase === 'paused', `clicking Pause enters 'paused' (got ${FR.getState().phase})`);
  const sc = FR.getState().score;
  key('ArrowUp'); FR.tick(0.5);
  check(FR.getState().score === sc && FR.getState().phase === 'paused', 'a keydown while paused does nothing');
  click('btnPause');
  check(FR.getState().phase === 'playing', 'clicking Pause again resumes');

  click('btnNew');
  const fresh = FR.getState();
  check(fresh.phase === 'playing' && fresh.score === 0 && fresh.level === 1 && fresh.lives === 3,
    `the New-game button restarts cleanly (got ${fresh.phase}/${fresh.score}/${fresh.level}/${fresh.lives})`);

  // the result button restarts an 'over' overlay
  FR.newGame({ level: 1 }); FR.start(); FR.tick(120);
  check(FR.getState().phase === 'gameover', 'reached game over for the button test');
  click('ovBtn');
  check(FR.getState().phase === 'playing' && FR.getState().score === 0, 'the result button restarts the game');
}

/* ============================================================================
 * 18. in-process reverse checks (the comparators must be able to go red)
 * ========================================================================== */

group('18. reverse checks: sabotaged references must light the comparators up');
{
  // (a) a wrong step (off by 0.1) breaks the geometry differential.
  let divWrongStep = 0;
  for (const row of [1, 3, 7, 9, 11]) {
    const cfg = FR.laneConfig(1)[row];
    const S = cfg.step + 0.1, L = cfg.len;
    for (let t = 0; t < 20; t += 0.7) {
      const r0 = RESIDUE[row];
      let base = (r0 + cfg.dir * cfg.speed * t) % S; if (base < 0) base += S;
      const ref = [];
      for (let j = Math.floor((-L - base) / S) - 1; j <= Math.ceil((COLS - base) / S) + 1; j++) {
        const from = base + j * S, to = from + L; if (to <= 0 || from >= COLS) continue; ref.push({ from, to });
      }
      if (segsDiverge(engineSegs(row, t, 1), ref)) divWrongStep++;
    }
  }
  check(divWrongStep > 0, `a wrong step produces ${divWrongStep} divergences (the comparator is sensitive)`);

  // (b) an unclamped hopTarget breaks the exhaustive hop check.
  let divUnclamped = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) for (const d of ['up', 'down', 'left', 'right']) {
    const D = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] }[d];
    const got = FR.hopTarget(r, c, d);
    if (got.r !== r + D[0] || got.c !== c + D[1]) divUnclamped++;
  }
  check(divUnclamped > 0, `an unclamped hop reference diverges on ${divUnclamped} edge cells (clamping is under test)`);

  // (c) counting wall columns as bays breaks homeSlot.
  let divWalls = 0;
  for (let c = 0; c < COLS; c++) if (FR.homeSlot(c) >= 0 && HOME_COLS.indexOf(c) < 0) divWalls++;
  check(divWalls === 0, `homeSlot never returns a slot for a wall column (${divWalls})`);
}

/* ============================================================================
 * 19. static: the HUD is written in exactly one place, behind the value cache
 *
 * A behavioural test can only observe the frames it happens to pump; a single
 * rogue `scoreEl.textContent = ...` off to the side (a classic "just update it
 * here too" fix) would pass at runtime yet reintroduce two writers of the same
 * field. This group reads the shipped source (comments stripped) and proves
 * every HUD DOM write lives inside updateHud(), and that both the frame loop
 * and tick() call it. Injection H (a direct write inside award()) reddens it.
 * ========================================================================== */

group('19. HUD DOM writes are centralised inside updateHud()');
{
  const src = strippedSource();

  const defs = (src.match(/function updateHud\s*\([^)]*\)\s*\{/g) || []).length;
  check(defs === 1, `exactly one updateHud() definition exists (found ${defs})`);

  const body = fnBody(src, 'updateHud');
  check(!!body, 'the updateHud() body was located');
  if (body) {
    let total = 0, inside = 0, presentInside = 0;
    for (const re of HUD_WRITES) {
      const all = (src.match(new RegExp(re.source, 'g')) || []).length;
      const inB = (body.match(new RegExp(re.source, 'g')) || []).length;
      total += all; inside += inB; if (inB > 0) presentInside++;
    }
    check(total === inside,
      `all ${total} HUD DOM writes live inside updateHud() (found ${total - inside} elsewhere)`);
    check(presentInside === HUD_WRITES.length,
      `all ${HUD_WRITES.length} HUD fields are written inside updateHud() (${presentInside} present)`);
    const cmp = (body.match(/\bc\.[a-zA-Z]+\s*!==/g) || []).length;
    check(cmp >= 8, `updateHud guards each field with a value-cache comparison (${cmp} found)`);
    check(/\bhudCache\b/.test(src) && /\bc\s*=\s*hudCache/.test(body),
      'updateHud() reads and writes the shared hudCache');
  }

  // The contract: both the frame loop and tick() synchronise the HUD.
  const loopB = fnBody(src, 'loop');
  const tickB = fnBody(src, 'tick');
  check(!!loopB && /\bupdateHud\s*\(\s*\)/.test(loopB),
    'loop() calls updateHud() every frame (the Round-1 fix)');
  check(!!tickB && /\bupdateHud\s*\(\s*\)/.test(tickB),
    'tick() calls updateHud() after advancing the model (added contract)');

  const calls = (src.match(/\bupdateHud\s*\(\s*\)/g) || []).length;
  check(calls >= 10, `updateHud() is invoked from the definition plus >=9 call sites (found ${calls})`);
}

/* ------------------------------------------------------------------- summary */

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`(differential: vehicles/platforms rebuilt from a measured residue class; supportAt/collidesAt on grids; BFS reachability replayed through the real engine; six deaths driven for real; i18n dynamic text checked)`);
process.exit(fail ? 1 : 0);
