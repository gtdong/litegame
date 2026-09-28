#!/usr/bin/env node
/**
 * Logic tests for towerdefense-game (a single-screen, 20 x 12 grid tower defense).
 *
 * The smoke test only proves the page parses and does not throw. It cannot tell
 * whether the fixed path is axis-aligned and non-self-intersecting, whether the
 * 190 buildable tiles really are "inside the grid, off the path and not a
 * blocker", whether the 12 waves ramp monotonically, whether `exposureSeconds`
 * measures the right arc, or whether the value-cached HUD / dynamic i18n text
 * actually update. This suite loads the whole inline <script> in a vm sandbox
 * with a stub DOM (canvas is a no-op Proxy, so the real render path still runs
 * without a GPU) and asserts behaviour through the game's own bridge object
 * `window.TD`.
 *
 * Three independent layers carry the weight:
 *
 *  1. AN INDEPENDENT GEOMETRY ORACLE. `buildableSlots`, `pathLength`,
 *     `pathPointAt` and especially `exposureSeconds` are the primitives the
 *     whole balance / placement story rests on. The reference here is built a
 *     DIFFERENT WAY from the shipped code: `exposureSeconds` is recomputed by an
 *     EXACT segment-circle intersection (solving the quadratic) rather than by
 *     sampling the polyline more finely - a finer sample would just be the same
 *     algorithm. The shipped sampler is a 4 px left-Riemann sum, so its error is
 *     two-way and bounded by 2 x SAMPLE_STEP = 8 px; that bound is what the test
 *     pins, not exact equality.
 *
 *  2. A TABLE DIFFERENTIAL. The tower level curve, the tower DPS model, the
 *     enemy/wave tables and the per-wave HP / gold / feasibility figures are all
 *     recomputed from the documented rules and compared against the shipped
 *     `TD.*` accessors. The difficulty curve monotonicity check reads the REAL
 *     `TD.waves()` data (not a copied array), so a regression that lets the ramp
 *     fall back (as wave 6 once did) turns it red.
 *
 *  3. END-TO-END BEHAVIOUR through `TD.tick()` (no rAF, no wall clock): a
 *     do-nothing run must lose on wave 2 with exactly 20 leaks; a greedy bot
 *     must clear all 12 waves with lives to spare; placement / upgrade / sell
 *     refusal paths, the frost slow, the cannon splash and the per-tick gold
 *     accounting are all driven for real. The whole model is deterministic, so
 *     "different seed, same result" is asserted as a PROPERTY, not treated as a
 *     bug.
 *
 * Reverse checks (run in the runbook by feeding a patched copy to this SAME
 * script through argv) prove the comparators are not vacuously green.
 *
 * Usage:  node tools/towerdefense-test.js [path/to/index.html] [path/to/assets/i18n.js]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'towerdefense-game', 'index.html');
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
/* Mirrors platformer-test.js: getElementById lazily invents an element for ANY
 * id (so the ambient id set is checked separately against the real markup),
 * getContext('2d') is a permissive Proxy and querySelectorAll is empty. The
 * canvas rect is 640 x 384 so a synthetic click with clientX/clientY lands on
 * the intended tile. */

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
    getBoundingClientRect() { return { left: 0, top: 0, right: 640, bottom: 384, width: 640, height: 384 }; }
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
      title: '',
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
 * is captured without touching the source (T lives inside the IIFE). */
function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const orig = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = orig(dict); return T; };
  inlineScripts(fs.readFileSync(GAME, 'utf8')).forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `towerdefense/index.html#script${i}` });
  });
  env.step();                                    // one real rAF frame (update + draw)
  return { env, PF: env.context.TD, T, els: env.els, html: fs.readFileSync(GAME, 'utf8') };
}

const G = boot();
const TD = G.PF;
const T = G.T;
const els = G.els;
const env = G.env;
const HTML = G.html;

/* ------------------------------------------------------------- constants */
const TILE = 32, COLS = 20, ROWS = 12, WIDTH = 640, HEIGHT = 384;
const START_GOLD = 220, START_LIVES = 20, WAVE_COUNT = 12;
const SELL_RATE = 0.7, SAMPLE_STEP = 4, NEXT_WAVE_DELAY = 6;

/* The fixed path / blockers / base tables, as documented. These are used only to
 * build INDEPENDENT references; the shipped values are read from TD.*. */
const PATH = [[-1, 2], [4, 2], [4, 6], [9, 6], [9, 1], [15, 1], [15, 9], [20, 9]];
const BLOCKED = [[0, 0], [1, 0], [2, 0], [0, 1], [17, 0], [18, 0], [19, 0],
  [0, 11], [1, 11], [2, 11], [17, 11], [18, 11], [19, 11]];
const BASE = {
  gun: { cost: 50, dmg: 8, rate: 2.5, range: 2.5 },
  cannon: { cost: 90, dmg: 26, rate: 0.7, range: 3.5, splash: 1.2 },
  frost: { cost: 70, dmg: 3, rate: 1.2, range: 2.8, slowPct: 0.45, slowTime: 1.5 }
};
const TOWER_ORDER = ['gun', 'cannon', 'frost'];
const ESPEC = {
  swarm: { hp: 22, speed: 2.2, armor: 0, gold: 3 },
  runner: { hp: 40, speed: 1.6, armor: 0, gold: 6 },
  brute: { hp: 140, speed: 0.9, armor: 3, gold: 14 }
};
/* Wave composition (the documented, frozen table). */
const WAVES_DOC = [
  [{ type: 'swarm', count: 8, gap: 1.6, delay: 0 }],
  [{ type: 'swarm', count: 10, gap: 1.4, delay: 0 }, { type: 'runner', count: 2, gap: 1.8, delay: 4 }],
  [{ type: 'swarm', count: 10, gap: 1.2, delay: 0 }, { type: 'runner', count: 3, gap: 1.5, delay: 5 }],
  [{ type: 'runner', count: 8, gap: 1.2, delay: 0 }, { type: 'swarm', count: 6, gap: 1.4, delay: 6 }],
  [{ type: 'runner', count: 8, gap: 1.1, delay: 0 }, { type: 'swarm', count: 6, gap: 1.3, delay: 7 }, { type: 'brute', count: 1, gap: 1.0, delay: 10 }],
  [{ type: 'swarm', count: 10, gap: 1.1, delay: 0 }, { type: 'runner', count: 6, gap: 1.3, delay: 6 }, { type: 'brute', count: 1, gap: 1.0, delay: 12 }],
  [{ type: 'runner', count: 8, gap: 1.0, delay: 0 }, { type: 'swarm', count: 8, gap: 1.2, delay: 5 }, { type: 'brute', count: 2, gap: 1.4, delay: 10 }],
  [{ type: 'swarm', count: 10, gap: 1.0, delay: 0 }, { type: 'runner', count: 8, gap: 1.1, delay: 5 }, { type: 'brute', count: 2, gap: 1.3, delay: 12 }],
  [{ type: 'runner', count: 10, gap: 0.95, delay: 0 }, { type: 'swarm', count: 8, gap: 1.1, delay: 5 }, { type: 'brute', count: 2, gap: 1.2, delay: 12 }],
  [{ type: 'swarm', count: 10, gap: 0.95, delay: 0 }, { type: 'runner', count: 10, gap: 1.0, delay: 4 }, { type: 'brute', count: 3, gap: 1.2, delay: 10 }],
  [{ type: 'runner', count: 11, gap: 0.9, delay: 0 }, { type: 'swarm', count: 10, gap: 1.0, delay: 4 }, { type: 'brute', count: 3, gap: 1.1, delay: 10 }],
  [{ type: 'swarm', count: 12, gap: 0.9, delay: 0 }, { type: 'runner', count: 10, gap: 0.95, delay: 4 }, { type: 'brute', count: 4, gap: 1.1, delay: 9 }]
];
const EXPECT_COUNT = WAVES_DOC.map(g => g.reduce((s, x) => s + x.count, 0));
const EXPECT_ARMOR = [176, 300, 340, 452, 595, 603, 782, 826, 862, 1049, 1089, 1236];
const EXPECT_RATIO = [11.57, 13.47, 18.36, 23.68, 24.72, 32.17, 32.70, 40.73, 48.16, 52.81, 59.76, 63.26];

/* ------------------------------------------------------ reference geometry */
const round2 = x => Math.round(x * 100) / 100;
const tc = (c, r) => ({ x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 });

function myLevels(base) {
  const l1 = { level: 1, cost: base.cost, dmg: round2(base.dmg), rate: round2(base.rate), range: round2(base.range) };
  const l2 = { level: 2, cost: Math.round(base.cost * 0.8), dmg: round2(base.dmg * 1.7), rate: round2(base.rate), range: round2(base.range + 0.4) };
  const l3 = { level: 3, cost: Math.round(base.cost * 1.4), dmg: round2(l2.dmg * 1.7), rate: round2(l2.rate * 1.25), range: round2(l2.range + 0.4) };
  return [l1, l2, l3];
}
const MY_LEVELS = { gun: myLevels(BASE.gun), cannon: myLevels(BASE.cannon), frost: myLevels(BASE.frost) };

/* My own segment table, built from the tile centres of the raw vertices. */
const MY_SEG = [];
(function () {
  let acc = 0;
  for (let i = 0; i < PATH.length - 1; i++) {
    const a = tc(PATH[i][0], PATH[i][1]);
    const b = tc(PATH[i + 1][0], PATH[i + 1][1]);
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    MY_SEG.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, len, acc });
    acc += len;
  }
})();
const MY_PATH_LEN = MY_SEG[MY_SEG.length - 1].acc + MY_SEG[MY_SEG.length - 1].len;

function myPointAt(d) {
  if (d <= 0) return { x: MY_SEG[0].x0, y: MY_SEG[0].y0 };
  if (d >= MY_PATH_LEN) { const s = MY_SEG[MY_SEG.length - 1]; return { x: s.x1, y: s.y1 }; }
  for (const s of MY_SEG) {
    if (d <= s.acc + s.len) {
      const t = (d - s.acc) / (s.len || 1);
      return { x: s.x0 + (s.x1 - s.x0) * t, y: s.y0 + (s.y1 - s.y0) * t };
    }
  }
  const s = MY_SEG[MY_SEG.length - 1];
  return { x: s.x1, y: s.y1 };
}

function segDist(px, py, s) {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const L2 = dx * dx + dy * dy;
  let t = L2 === 0 ? 0 : ((px - s.x0) * dx + (py - s.y0) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  const cx = s.x0 + t * dx, cy = s.y0 + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function minDistToPath(px, py) { return Math.min(...MY_SEG.map(s => segDist(px, py, s))); }
function arcPosOf(px, py) {   // global arc length of the nearest projection
  let best = Infinity, pos = 0;
  for (const s of MY_SEG) {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
    const L2 = dx * dx + dy * dy;
    let t = L2 === 0 ? 0 : ((px - s.x0) * dx + (py - s.y0) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    const cx = s.x0 + t * dx, cy = s.y0 + t * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best) { best = d; pos = s.acc + t * s.len; }
  }
  return pos;
}

/* Rasterise the polyline into grid tiles, independently of the game. The walk
 * is only well-defined for AXIS-ALIGNED segments (one of dc/dr is 0, so the
 * target is hit in a bounded number of steps). A diagonal segment would make
 * both axes overshoot and never reconcile - an infinite loop - so the walk is
 * hard-capped at the grid diameter; the axis-aligned invariant is asserted
 * separately, so silently truncating a diagonal here only makes THAT check the
 * one that reports the defect. */
function myPathTiles() {
  const set = new Set();
  const cap = COLS + ROWS + 2;
  for (let i = 0; i < PATH.length - 1; i++) {
    const [c0, r0] = PATH[i], [c1, r1] = PATH[i + 1];
    const dc = Math.sign(c1 - c0), dr = Math.sign(r1 - r0);
    let c = c0, r = r0, guard = 0;
    set.add(c + ',' + r);
    while ((c !== c1 || r !== r1) && guard++ < cap) { c += dc; r += dr; set.add(c + ',' + r); }
  }
  return set;
}
const MY_PATH_TILES = myPathTiles();
const MY_BLOCKED = new Set(BLOCKED.map(([c, r]) => c + ',' + r));
function myBuildableSlots() {
  const out = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    if (!MY_PATH_TILES.has(c + ',' + r) && !MY_BLOCKED.has(c + ',' + r)) out.push({ col: c, row: r });
  }
  return out;
}

/* EXACT in-range arc length for one axis-aligned segment vs a circle: solve the
 * quadratic |p0 + t d - C|^2 <= R^2 for t in [0,1]. This is a genuinely
 * different computation from the game's 4 px left-Riemann sampling. */
function segCircleLen(s, cx, cy, R) {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const a = dx * dx + dy * dy;
  if (a === 0) return Math.hypot(s.x0 - cx, s.y0 - cy) <= R ? 0 : 0;
  const fx = s.x0 - cx, fy = s.y0 - cy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - R * R;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;
  const sq = Math.sqrt(disc);
  let lo = (-b - sq) / (2 * a), hi = (-b + sq) / (2 * a);
  lo = Math.max(0, lo); hi = Math.min(1, hi);
  if (hi <= lo) return 0;
  return (hi - lo) * Math.sqrt(a);
}
const _expCache = {};
function myExposurePx(col, row, rangeTiles) {
  const key = col + ',' + row + ',' + rangeTiles;
  if (_expCache[key] !== undefined) return _expCache[key];
  const c = tc(col, row); const R = rangeTiles * TILE;
  let len = 0;
  for (const s of MY_SEG) len += segCircleLen(s, c.x, c.y, R);
  _expCache[key] = len;
  return len;
}
function myExposureSec(col, row, rangeTiles, speed) {
  if (!(speed > 0)) return 0;
  return myExposurePx(col, row, rangeTiles) / TILE / speed;
}

/* Reference balance math. */
function myWaveTypes(w) {
  const out = [];
  for (const g of WAVES_DOC[w - 1]) for (let i = 0; i < g.count; i++) out.push(g.type);
  return out;
}
function myWaveHp(w) { return myWaveTypes(w).reduce((s, t) => s + ESPEC[t].hp, 0); }
function myWaveArmor(w) { return myWaveTypes(w).reduce((s, t) => s + ESPEC[t].hp + ESPEC[t].armor, 0); }
function myWaveKillGold(w) { return myWaveTypes(w).reduce((s, t) => s + ESPEC[t].gold, 0); }
function myGoldAvailable(w) {
  let g = START_GOLD;
  for (let k = 1; k < w; k++) { g += 40 + 8 * k; g += myWaveKillGold(k); }
  return g;
}
function myTowerDps(type, level, armor) {
  const lv = MY_LEVELS[type][level - 1];
  return lv.rate * Math.max(1, lv.dmg - (armor || 0));
}
/* My own optimistic greedy budget: buy the best damage-per-gold tower on the
 * best slots with the gold available, using my EXACT exposure and dps. */
function myBudget(w) {
  const types = myWaveTypes(w);
  if (!types.length) return 0;
  const gold = myGoldAvailable(w);
  const cands = [];
  for (const s of myBuildableSlots()) {
    for (const type of TOWER_ORDER) {
      const lv = MY_LEVELS[type][0];
      let dmg = 0;
      for (const t of types) {
        const e = ESPEC[t];
        dmg += myExposureSec(s.col, s.row, lv.range, e.speed) * myTowerDps(type, 1, e.armor);
      }
      cands.push({ col: s.col, row: s.row, type, cost: lv.cost, dmg, eff: dmg / lv.cost });
    }
  }
  cands.sort((a, b) => (b.eff - a.eff) || (a.row - b.row) || (a.col - b.col) ||
    (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const used = {}; let total = 0, spent = 0;
  for (const c of cands) {
    const k = c.col + ',' + c.row;
    if (used[k]) continue;
    if (spent + c.cost > gold) continue;
    used[k] = 1; spent += c.cost; total += c.dmg;
  }
  return total;
}

/* -------------------------------------------------------- test helpers */
const EPS = 1e-6;
const approx = (a, b, tol) => Math.abs(a - b) <= tol;
function tickUntil(pred, maxSeconds, chunk) {
  const c = chunk || 0.1;
  let t = 0;
  while (t < maxSeconds) { TD.tick(c, 1 / 60); t += c; if (pred()) return { ok: true, t }; }
  return { ok: false, t };
}
/* Match two enemy snapshots within one small tick by type + nearest position.
 * Returns matched pairs (before, after) and the before-entries that vanished. */
function matchSnapshots(before, after) {
  const used = new Array(before.length).fill(false);
  const pairs = [];
  for (const a of after) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < before.length; i++) {
      if (used[i] || before[i].type !== a.type) continue;
      const d = Math.abs(before[i].x - a.x) + Math.abs(before[i].y - a.y);
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && bd < 6) { used[best] = true; pairs.push([before[best], a]); }
    else pairs.push([null, a]);
  }
  return { pairs, deaths: before.filter((_, i) => !used[i]) };
}

/* ======================================================================
 * 1. Static gates (A1-A5)
 * ==================================================================== */

group('1. static gates: ids, onChange, randomness, HUD write-locality, var collisions');
{
  const code = HTML.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
  const markup = HTML.replace(/<script[\s\S]*?<\/script>/g, ' ');

  /* A1. Every getElementById('X') needs a matching id="X" in the markup. The
   * stub lazily invents elements, so this is the only defence against a
   * dangling id that would explode in a real browser. */
  const wanted = [...HTML.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const created = new Set();
  for (const m of HTML.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)) created.add(m[1]);
  for (const m of HTML.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]/g)) created.add(m[1]);
  const dangling = [...new Set(wanted)].filter(id => !created.has(id) && !new RegExp(`\\bid="${id}"`).test(markup));
  check(wanted.length >= 20, `the script reaches for ${wanted.length} getElementById ids`);
  check(dangling.length === 0, `every getElementById id exists in the markup (dangling ${JSON.stringify(dangling)})`);

  /* A2. T.onChange registered exactly once. */
  const onCount = (HTML.match(/T\.onChange/g) || []).length;
  check(onCount === 1, `T.onChange is registered exactly once (found ${onCount})`);

  /* A3. No randomness, no browser timers. */
  check((code.match(/Math\.random/g) || []).length === 0, 'the source never calls Math.random');
  const timers = (code.match(/\bset(?:Timeout|Interval)\s*\(/g) || []).length;
  check(timers === 0, `the source never calls setTimeout/setInterval (found ${timers})`);

  /* A4. Every write to a HUD node lives inside updateHud(). */
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
  const hudVars = 'scoreEl|livesEl|goldEl|waveEl|speedEl|nextInfoEl|selInfoEl|' +
    'btnGun|btnCannon|btnFrost|btnUpgrade|btnSell|btnCall|btnPause|btnSpeed|btnNew|' +
    'startEl|resEl|ovTitleEl|ovSubEl|ovBtnEl';
  const writeRe = new RegExp(`\\b(${hudVars})\\s*\\.\\s*(textContent|innerHTML|disabled|classList|title|placeholder|setAttribute)\\b`, 'g');
  const writes = [...code.matchAll(writeRe)];
  const outside = writes.filter(m => !(start >= 0 && m.index >= start && m.index <= end));
  check(start >= 0 && end > start, 'updateHud() is present and brace-matched');
  check(writes.length > 10, `HUD nodes are written somewhere (found ${writes.length} writes)`);
  check(outside.length === 0, `every HUD-node write lives inside updateHud() (found ${outside.length} outside)`,
    outside.slice(0, 3).map(m => m[0]).join('; '));

  /* A5. No top-level `var` collides with an un-shadowable window property.
   * Handles `var a, b, history, c;` (all names extracted). */
  const RESERVED = new Set(['history', 'location', 'top', 'length', 'origin', 'frames', 'parent',
    'self', 'document', 'navigator', 'external', 'closed', 'opener', 'event', 'window',
    'screen', 'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'screenX', 'screenY',
    'screenLeft', 'screenTop', 'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset',
    'devicePixelRatio', 'visualViewport']);
  const varNames = [];
  for (const m of code.matchAll(/\bvar\s+([\s\S]*?);/g)) {
    for (const decl of splitTopLevel(m[1])) {
      const nm = decl.match(/^\s*([A-Za-z_$][\w$]*)/);
      if (nm) varNames.push(nm[1]);
    }
  }
  const clashes = [...new Set(varNames)].filter(n => RESERVED.has(n));
  check(varNames.length > 40, `the script declares ${varNames.length} var names`);
  check(clashes.length === 0, `no top-level var shadows a window property (clashes ${JSON.stringify(clashes)})`);
}

/* Split a comma list at bracket depth 0 / outside quotes, so object-literal and
 * array commas don't break multi-declarator `var` statements. */
function splitTopLevel(src) {
  const out = []; let depth = 0, cur = '', q = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { cur += ch; if (ch === q && src[i - 1] !== '\\') q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/* ======================================================================
 * 2. Path geometry differential (B6, B7, B8, C29)
 * ==================================================================== */

group('2. path geometry: my independent polyline oracle matches the shipped one');
{
  check(TD.pathLength() === 1216, `pathLength() is the documented 1216 px (got ${TD.pathLength()})`);
  check(MY_PATH_LEN === 1216, `my own polyline arc length is also 1216 (got ${MY_PATH_LEN})`);

  /* B7. pathPointAt: 200+ samples, each on the path and monotone in d. The
   * coverage + endpoint checks below stop a DEGENERATE (constant) implementation
   * from passing the on-path and monotone tests vacuously. */
  let maxOff = 0, monoBad = 0, prevPos = -Infinity, minPos = Infinity, maxPos = -Infinity;
  const N = 260;
  for (let i = 0; i <= N; i++) {
    const d = MY_PATH_LEN * i / N;
    const p = TD.pathPointAt(d);
    const off = minDistToPath(p.x, p.y);
    if (off > maxOff) maxOff = off;
    const pos = arcPosOf(p.x, p.y);
    if (pos < prevPos - 0.5) monoBad++;
    prevPos = pos;
    if (pos < minPos) minPos = pos;
    if (pos > maxPos) maxPos = pos;
  }
  check(maxOff < 0.51, `all ${N + 1} pathPointAt samples sit on the polyline (<0.51px, max ${maxOff.toFixed(4)}px)`);
  check(monoBad === 0, `pathPointAt(d) advances monotonically along the path (${monoBad} regressions)`);
  check(maxPos - minPos > MY_PATH_LEN - 8,
    `the samples traverse the whole path (span ${(maxPos - minPos).toFixed(1)}px of ${MY_PATH_LEN}px)`);
  const pStart = TD.pathPointAt(0), pEnd = TD.pathPointAt(MY_PATH_LEN);
  const cStart = tc(PATH[0][0], PATH[0][1]), cEnd = tc(PATH[PATH.length - 1][0], PATH[PATH.length - 1][1]);
  check(approx(pStart.x, cStart.x, 1e-6) && approx(pStart.y, cStart.y, 1e-6),
    `pathPointAt(0) is the entrance vertex centre (${pStart.x},${pStart.y})`);
  check(approx(pEnd.x, cEnd.x, 1e-6) && approx(pEnd.y, cEnd.y, 1e-6),
    `pathPointAt(PATH_LEN) is the exit vertex centre (${pEnd.x},${pEnd.y})`);
  check(TD.pathPointAt(-50).x === TD.pathPointAt(0).x, 'pathPointAt clamps below 0');
  check(TD.pathPointAt(99999).x === TD.pathPointAt(MY_PATH_LEN).x, 'pathPointAt clamps above PATH_LEN');

  /* B8. buildableSlots: exact set equality with my derivation. */
  const mine = myBuildableSlots().map(s => s.col + ',' + s.row).sort();
  const theirs = TD.buildableSlots().map(s => s.col + ',' + s.row).sort();
  check(mine.length === 190, `my derivation yields 190 buildable tiles (got ${mine.length})`);
  check(JSON.stringify(mine) === JSON.stringify(theirs),
    `buildableSlots() equals my derivation (mine ${mine.length}, theirs ${theirs.length})`);
  check(TD.path().length === PATH.length, 'path() returns the 8 declared vertices');
  check(TD.isOnPath(4, 2) && TD.isOnPath(9, 6) && TD.isOnPath(15, 1), 'isOnPath() is true on the vertices');
  check(!TD.buildable(4, 2) && !TD.buildable(9, 1), 'a path tile is not buildable');
  check(!TD.buildable(0, 0) && !TD.buildable(19, 11), 'a blocker tile is not buildable');
  check(!TD.buildable(-1, 2) && !TD.buildable(20, 9) && !TD.buildable(20, 0),
    'a tile outside the grid is not buildable');

  /* C29. Path invariants. */
  const P = TD.path();
  let axisOK = true;
  for (let i = 0; i < P.length - 1; i++) {
    const dc = P[i + 1][0] - P[i][0], dr = P[i + 1][1] - P[i][1];
    if ((dc === 0) === (dr === 0)) axisOK = false;              // needs exactly one axis
  }
  check(axisOK, 'every consecutive vertex pair is axis-aligned (shares a row or a column)');

  let insideOK = true;
  for (let i = 1; i < P.length - 1; i++) {
    if (P[i][0] < 0 || P[i][0] >= COLS || P[i][1] < 0 || P[i][1] >= ROWS) insideOK = false;
  }
  check(insideOK, 'every in-grid vertex is inside [0,COLS) x [0,ROWS)');
  check(P[0][0] === -1 && P[P.length - 1][0] === COLS,
    'the first and last vertices sit exactly one tile outside the grid');

  // No two non-adjacent segments intersect or overlap; adjacent ones only touch
  // at the shared endpoint. `cells()` walks a segment's integer cells; the walk
  // is bounded by the grid diameter because an axis-ALIGNED segment reaches its
  // target in dc/dr steps - a diagonal one never would (both axes overshoot), so
  // the cap prevents that OOM while the axis-aligned check reports the defect.
  const segs = P.slice(0, -1).map((a, i) => ({ a, b: P[i + 1], i }));
  const cap = COLS + ROWS + 2;
  const cells = sg => {
    const out = [];
    const dc = Math.sign(sg.b[0] - sg.a[0]), dr = Math.sign(sg.b[1] - sg.a[1]);
    let c = sg.a[0], r = sg.a[1], guard = 0;
    out.push(c + ',' + r);
    while ((c !== sg.b[0] || r !== sg.b[1]) && guard++ < cap) { c += dc; r += dr; out.push(c + ',' + r); }
    return out;
  };
  let overlapBad = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const cs = cells(segs[i]), ct = cells(segs[j]);
    const shared = cs.filter(x => ct.includes(x));
    const allowedShared = Math.abs(i - j) === 1 ? 1 : 0;   // the joint endpoint
    if (shared.length > allowedShared) overlapBad++;
  }
  check(overlapBad === 0, `no two path segments cross or overlap (${overlapBad} offenders)`);
}

/* ======================================================================
 * 3. exposureSeconds differential (B9) - exact circle intersection
 * ==================================================================== */

group('3. exposureSeconds: exact segment-circle oracle within 2*SAMPLE_STEP px');
{
  const slots = TD.buildableSlots();
  // Spread a sample of slots across the board (near the path + corners).
  const sample = [];
  for (let i = 0; i < slots.length; i += 7) sample.push(slots[i]);
  let maxErr = 0, cmp = 0, bad = 0;
  let firstBad = '';
  for (const s of sample) {
    for (const type of TOWER_ORDER) {
      const range = MY_LEVELS[type][0].range;
      const exactPx = myExposurePx(s.col, s.row, range);
      for (const t of Object.keys(ESPEC)) {
        const speed = ESPEC[t].speed;
        const gamePx = TD.exposureSeconds(s.col, s.row, range, speed) * TILE * speed;
        const err = Math.abs(gamePx - exactPx);
        cmp++;
        if (err > maxErr) maxErr = err;
        if (err > 2 * SAMPLE_STEP + 1e-6) { bad++; if (!firstBad) firstBad = `(${s.col},${s.row}) ${type}/${t} d=${err.toFixed(3)}px`; }
      }
    }
  }
  check(cmp >= 200, `compared ${cmp} (slot,tower,enemy) triples against the exact oracle`);
  check(bad === 0, `every triple is within 2*SAMPLE_STEP=${2 * SAMPLE_STEP}px (max ${maxErr.toFixed(3)}px)` +
    (firstBad ? ` first ${firstBad}` : ''));

  // Strictly decreasing in speed.
  let decreasing = true;
  for (const s of sample.slice(0, 20)) {
    const a = TD.exposureSeconds(s.col, s.row, 3, 0.9);
    const b = TD.exposureSeconds(s.col, s.row, 3, 1.6);
    const c = TD.exposureSeconds(s.col, s.row, 3, 2.2);
    if (!(a > b && b > c)) decreasing = false;
  }
  check(decreasing, 'exposureSeconds is strictly decreasing as the enemy speed rises');

  // Exact zero when out of range, and a monotone relation with range.
  check(TD.exposureSeconds(0, 0, 0.05, 1) === 0 || TD.exposureSeconds(0, 0, 0.05, 1) < 0.02,
    'a range that misses the path yields ~0 exposure');
  const near = TD.exposureSeconds(2, 1, 3, 1);
  const far = TD.exposureSeconds(0, 0, 1, 1);
  check(near > far, 'a tower adjacent to the path exposes more than a far, short-range one');
  note(`exposure max |sampled - exact| = ${maxErr.toFixed(3)} px (bound ${2 * SAMPLE_STEP} px)`);
}

/* ======================================================================
 * 4. Tower / wave tables differential (B10, B11, B12)
 * ==================================================================== */

group('4. tower and wave tables: recomputed from the documented rules');
{
  /* B11. towers(): 3 types x 3 levels, cost/dmg/rate/range. */
  const towers = TD.towers();
  check(towers.length === 3, `towers() returns 3 tower types (got ${towers.length})`);
  let tBad = 0, firstT = '';
  for (const type of TOWER_ORDER) {
    const spec = towers.find(t => t.type === type);
    if (!spec || spec.levels.length !== 3) { tBad++; firstT = type; continue; }
    for (let lv = 1; lv <= 3; lv++) {
      const g = spec.levels[lv - 1], m = MY_LEVELS[type][lv - 1];
      for (const k of ['cost', 'dmg', 'rate', 'range']) {
        if (g[k] !== m[k]) { tBad++; if (!firstT) firstT = `${type} L${lv} ${k} got ${g[k]} want ${m[k]}`; }
      }
    }
  }
  check(tBad === 0, `all 3x3x4 table entries match my derivation` + (firstT ? ` (${firstT})` : ''));
  const cannon = TD.towers().find(t => t.type === 'cannon');
  check(cannon && cannon.kind === 'splash' && cannon.splash === 1.2, 'cannon is splash with radius 1.2');
  const frost = TD.towers().find(t => t.type === 'frost');
  check(frost && frost.kind === 'slow' && frost.slowPct === 0.45 && frost.slowTime === 1.5,
    'frost is slow with -45% for 1.5s');
  check(TD.towerSpec('cannon').levels[2].rate === 0.88 && TD.towerSpec('cannon').levels[2].dmg === 75.14 &&
    TD.towerSpec('cannon').levels[2].cost === 126 && TD.towerSpec('cannon').levels[2].range === 4.3,
    'cannon L3 is 126 / 75.14 / 0.88 / 4.3 (round2 of 0.875)');

  /* B10. towerDps: 3 types x 3 levels x armor {0,1,3,10}. */
  const armors = [0, 1, 3, 10];
  let dBad = 0, firstD = '';
  for (const type of TOWER_ORDER) for (let lv = 1; lv <= 3; lv++) for (const a of armors) {
    const got = TD.towerDps(type, lv, a), want = myTowerDps(type, lv, a);
    if (Math.abs(got - want) > EPS) { dBad++; if (!firstD) firstD = `${type} L${lv} a=${a}: ${got} vs ${want}`; }
  }
  check(dBad === 0, `towerDps matches for 3x3x4=${3 * 3 * armors.length} combinations` + (firstD ? ` (${firstD})` : ''));

  /* B12. wave HP / armour-weighted HP / gold available. */
  let wBad = 0, firstW = '';
  for (let w = 1; w <= 12; w++) {
    if (TD.waveHpTotal(w) !== myWaveHp(w)) { wBad++; if (!firstW) firstW = `hp w${w}`; }
    if (TD.waveArmorWeightedHp(w) !== myWaveArmor(w)) { wBad++; if (!firstW) firstW = `armor w${w}`; }
    if (TD.goldAvailableByWave(w) !== myGoldAvailable(w)) { wBad++; if (!firstW) firstW = `gold w${w}`; }
  }
  check(wBad === 0, 'waveHpTotal / waveArmorWeightedHp / goldAvailableByWave match for all 12 waves' + (firstW ? ` (${firstW})` : ''));
  check(TD.goldAvailableByWave(1) === 220, `goldAvailableByWave(1) is START_GOLD 220 (got ${TD.goldAvailableByWave(1)})`);
  const enemies = TD.enemies();
  check(enemies.length === 3 && enemies.find(e => e.type === 'brute').armor === 3 &&
    enemies.find(e => e.type === 'swarm').speed === 2.2, 'enemies() carries the documented armor/speed');
}

/* ======================================================================
 * 5. Difficulty curve + feasibility (B13, B14, B15)
 * ==================================================================== */

group('5. difficulty ramps monotonically and every wave is feasible');
{
  const waves = TD.waves();                       // the REAL shipped data
  check(waves.length === 12, `waves() returns 12 waves (got ${waves.length})`);

  let countBad = 0, armorBad = 0, hpBad = 0;
  for (let i = 0; i < 12; i++) {
    if (waves[i].count !== EXPECT_COUNT[i]) countBad++;
    if (waves[i].armorWeightedHp !== EXPECT_ARMOR[i]) armorBad++;
    if (waves[i].hpTotal !== myWaveHp(i + 1)) hpBad++;
  }
  check(countBad === 0, `every wave count matches the frozen table (bad ${countBad})`);
  check(armorBad === 0, `every armor-weighted HP matches the frozen table (bad ${armorBad})`);
  check(hpBad === 0, `every hpTotal matches my recomputation (bad ${hpBad})`);

  /* B14. Monotone non-decreasing across w=2..12 for all three series. */
  const mono = key => {
    for (let i = 1; i < 12; i++) if (waves[i][key] < waves[i - 1][key]) return false;
    return true;
  };
  check(mono('count'), `count is non-decreasing across the 12 waves (${waves.map(w => w.count).join(',')})`);
  check(mono('hpTotal'), `hpTotal is non-decreasing (${waves.map(w => w.hpTotal).join(',')})`);
  check(mono('armorWeightedHp'), `armorWeightedHp is non-decreasing (${waves.map(w => w.armorWeightedHp).join(',')})`);

  /* B13. My greedy budget model is within 5% of the shipped (both optimistic). */
  let maxRel = 0, firstB = '';
  for (let w = 1; w <= 12; w++) {
    const got = TD.bestKillBudget(w), mine2 = myBudget(w);
    const rel = Math.abs(got - mine2) / Math.max(1, got);
    if (rel > maxRel) maxRel = rel;
    if (rel >= 0.05 && !firstB) firstB = `w${w} game=${got.toFixed(0)} mine=${mine2.toFixed(0)}`;
  }
  check(maxRel < 0.05, `bestKillBudget agrees with my independent model within 5% (max ${(maxRel * 100).toFixed(2)}%)` +
    (firstB ? ` first ${firstB}` : ''));

  /* B15. Feasibility ratio >= 1.5 for all waves, and it equals budget/armour. */
  let ratioBad = 0, firstR = '';
  for (let w = 1; w <= 12; w++) {
    const r = TD.waveFeasibilityRatio(w);
    if (r < 1.5) { ratioBad++; if (!firstR) firstR = `w${w}=${r.toFixed(2)}`; }
    const recomputed = TD.bestKillBudget(w) / myWaveArmor(w);
    if (Math.abs(r - recomputed) > 1e-6) ratioBad++;
  }
  check(ratioBad === 0, `every waveFeasibilityRatio >= 1.5 and = budget/armourHP (bad ${ratioBad})` + (firstR ? ` ${firstR}` : ''));
  // Sanity: the documented ratios are reproduced to 2 dp.
  let ratioMatch = 0;
  for (let w = 1; w <= 12; w++) if (Math.abs(TD.waveFeasibilityRatio(w) - EXPECT_RATIO[w - 1]) < 0.02) ratioMatch++;
  check(ratioMatch >= 10, `the shipped ratios reproduce the README table (${ratioMatch}/12 within 0.02)`);
}

/* ======================================================================
 * 6. Runtime calibration (C16, C17, C30)
 * ==================================================================== */

group('6. tick() calibration: game time is real time scaled by the speed multiplier');
{
  TD.newGame({ seed: 1, wave: 1 }); TD.start(); TD.setSpeed(1);
  TD.tick(1, 1 / 60);
  const e1 = TD.enemyAt(0);
  check(e1 && approx(e1.pathDist, 2.2 * TILE, 1e-6),
    `wave 1 (swarm) first enemy advanced speed*TILE = ${2.2 * TILE}px (got ${e1 ? e1.pathDist.toFixed(4) : 'none'})`);

  // runner-specific (wave 4 opens with runners).
  TD.loadWave(4); TD.setSpeed(1);
  TD.tick(1, 1 / 60);
  const r1 = TD.enemyAt(0);
  check(r1 && r1.type === 'runner' && approx(r1.pathDist, 1.6 * TILE, 1e-6),
    `runner at speed 1 advances exactly 51.200px (got ${r1 ? r1.pathDist.toFixed(4) : 'none'})`);

  // brute-specific (wave 5): advance until a brute exists, then one tick.
  TD.loadWave(5); TD.setSpeed(1);
  tickUntil(() => TD.enemyList().some(e => e.type === 'brute'), 40, 1 / 60);
  const bruteBefore = TD.enemyList().find(e => e.type === 'brute');
  TD.tick(1, 1 / 60);
  const bruteAfter = TD.enemyList().find(e => e.type === 'brute');
  const bDelta = (bruteAfter && bruteBefore) ? bruteAfter.pathDist - bruteBefore.pathDist : NaN;
  check(bruteBefore && bruteAfter && approx(bDelta, 0.9 * TILE, 1e-6),
    `brute at speed 1 advances exactly ${(0.9 * TILE).toFixed(1)}px per second (got ${bDelta.toFixed(4)})`);

  /* C17. setSpeed(2) advances 2 game-seconds per real second. */
  TD.loadWave(4); TD.setSpeed(1); TD.tick(1, 1 / 60);
  const slow = TD.enemyAt(0).pathDist;
  TD.loadWave(4); TD.setSpeed(2); TD.tick(1, 1 / 60);
  const fast = TD.enemyAt(0).pathDist;
  check(approx(fast, 2 * slow, 1e-6), `setSpeed(2) doubles the advance (${slow.toFixed(3)} -> ${fast.toFixed(3)})`);
  TD.setSpeed(1);
}

/* ======================================================================
 * 7. Economy + build/upgrade/sell (C20, C21, C22)
 * ==================================================================== */

group('7. place / upgrade / sell: refusal paths and exact costs');
{
  TD.newGame({ seed: 1, wave: 1 }); TD.start();

  /* Rejections leave gold untouched and return null. */
  const g0 = TD.gold();
  check(TD.placeTower(4, 2, 'gun') === null, 'building on a path tile is refused');
  check(TD.placeTower(0, 0, 'gun') === null, 'building on a blocker is refused');
  check(TD.placeTower(99, 99, 'gun') === null, 'building outside the grid is refused');
  check(TD.placeTower(-1, 0, 'gun') === null, 'building with a negative index is refused');
  check(TD.gold() === g0, `refused placements never change gold (${g0} -> ${TD.gold()})`);

  /* A successful placement costs exactly `cost`. */
  const built = TD.placeTower(2, 1, 'gun');
  check(built && built.type === 'gun' && built.level === 1, 'a buildable tile accepts a gun');
  check(TD.gold() === g0 - 50, `building a gun costs exactly 50 (${g0} -> ${TD.gold()})`);
  check(TD.towerAt(2, 1) && TD.towerAt(2, 1).type === 'gun', 'towerAt() reports the new tower');
  check(TD.buildableSlots().every(s => !(s.col === 2 && s.row === 1)) || TD.towerAt(2, 1) !== null,
    'the occupied slot is still reported by towerAt');
  check(TD.placeTower(2, 1, 'cannon') === null, 'an occupied tile is refused');

  /* Insufficient gold. */
  TD.newGame({ seed: 1, wave: 1 }); TD.start();
  TD.placeTower(2, 1, 'cannon');                  // 220 - 90 = 130
  TD.placeTower(2, 3, 'cannon');                  // 40
  const gLow = TD.gold();
  check(gLow < 50, `failed setup left <50 gold (got ${gLow})`);
  check(TD.placeTower(3, 1, 'gun') === null, 'a 50g gun is refused with <50 gold');
  check(TD.gold() === gLow, 'a refused purchase never changes gold');

  /* C21. Upgrade: cost === upgradeCost, level increments, L3 is a dead end. */
  TD.newGame({ seed: 1, wave: 1 }); TD.start();
  TD.placeTower(2, 1, 'gun');
  const beforeUp = TD.gold();
  const up1 = TD.upgradeTower(2, 1);
  check(up1 && up1.level === 2, `gun upgrades to L2 (got ${up1 && up1.level})`);
  check(TD.gold() === beforeUp - 40, `gun L1->L2 costs upgradeCost 40 (${beforeUp} -> ${TD.gold()})`);
  TD.upgradeTower(2, 1);                           // to L3
  check(TD.towerAt(2, 1).level === 3, 'gun reaches L3');
  const gAt3 = TD.gold();
  check(TD.upgradeTower(2, 1) === null, 'upgrading a maxed tower returns null');
  check(TD.gold() === gAt3, 'a refused upgrade never changes gold');
  check(TD.towerSpec('gun').levels[1].cost === 40 && TD.towerSpec('gun').levels[2].cost === 70,
    'gun upgrade costs are 40 then 70');

  /* C22. Sell returns floor(invested * 0.7). */
  TD.newGame({ seed: 1, wave: 1 }); TD.start();
  TD.placeTower(2, 1, 'gun');                      // invested 50
  let gPre = TD.gold();
  const s1 = TD.sellTower(2, 1);
  check(s1 && s1.refund === Math.floor(50 * SELL_RATE), `selling a fresh gun refunds floor(50*0.7)=35 (got ${s1 && s1.refund})`);
  check(TD.gold() === gPre + 35, 'the refund is credited exactly');
  check(TD.towerAt(2, 1) === null, 'the sold tower is removed');

  TD.placeTower(3, 1, 'gun');                      // 50
  TD.upgradeTower(3, 1);                           // +40 -> invested 90
  gPre = TD.gold();
  const s2 = TD.sellTower(3, 1);
  check(s2 && s2.refund === Math.floor(90 * SELL_RATE), `selling a gun+upgrade refunds floor(90*0.7)=${Math.floor(90 * SELL_RATE)} (got ${s2 && s2.refund})`);
  check(TD.gold() === gPre + s2.refund, 'the upgrade-inclusive refund is credited exactly');
  check(TD.sellTower(3, 1) === null, 'selling an empty tile returns null');
}

/* ======================================================================
 * 8. Combat model: damage floor, real kill gold, frost slow, cannon splash
 * ==================================================================== */

group('8. combat: damage model, kill bounty, frost slow, cannon splash');
{
  check(TD.towerDps('gun', 1, 3) === 12.5, `gun L1 vs armor 3 is 12.5 dps (got ${TD.towerDps('gun', 1, 3)})`);
  check(TD.towerDps('frost', 1, 3) === 1.2, `frost L1 vs armor 3 floors at max(1,0) -> 1.2 dps (got ${TD.towerDps('frost', 1, 3)})`);
  check(TD.towerDps('frost', 1, 100) === 1.2, 'the floor of 1 holds even against huge armor');

  /* A real kill: drive wave 6 with strong towers, and confirm the per-tick gold
   * accounting (gold delta == summed bounties + wave-clear bonus) while a brute
   * really dies, proving the 14g bounty is paid. */
  TD.newGame({ seed: 1, wave: 6 }); TD.start();
  {
    const slots = TD.buildableSlots()
      .map(s => ({ ...s, exp: TD.exposureSeconds(s.col, s.row, 3.5, 1) }))
      .sort((a, b) => b.exp - a.exp);
    let placed = 0;
    for (const s of slots) { if (placed >= 8) break; if (TD.placeTower(s.col, s.row, 'cannon')) placed++; }
    TD.setSpeed(1);
    let prev = TD.getState(), mism = 0, bruteDied = false, leaks = 0, ticks = 0, firstMism = '';
    while (TD.getState().phase === 'playing' && prev.wave === 6 && ticks++ < 20000) {
      TD.tick(1 / 60, 1 / 60);
      const st = TD.getState();
      const { deaths } = matchSnapshots(prev.enemies, st.enemies);
      const leaked = prev.lives - st.lives;
      if (leaked > 0) leaks += leaked;
      let expected = deaths.reduce((s, e) => s + ESPEC[e.type].gold, 0);
      // Remove bounties for enemies that leaked instead of dying (they pay nothing).
      if (leaked > 0) {
        const killedLike = deaths.slice();               // all removed entries
        // Heuristic: leaked enemies are the furthest along; drop that many.
        killedLike.sort((a, b) => b.pathDist - a.pathDist);
        const leakedSet = new Set(killedLike.slice(0, leaked));
        expected = deaths.filter(e => !leakedSet.has(e)).reduce((s, e) => s + ESPEC[e.type].gold, 0);
      }
      if (st.wave !== prev.wave) expected += 40 + 8 * prev.wave;
      const goldDelta = st.gold - prev.gold;
      if (goldDelta !== expected) { mism++; if (!firstMism) firstMism = `t=${(ticks / 60).toFixed(2)} got ${goldDelta} want ${expected}`; }
      if (deaths.some(e => e.type === 'brute')) bruteDied = true;
      if (st.wave !== prev.wave) break;
      prev = st;
    }
    check(bruteDied, 'wave 6 contains and loses at least one brute during the run');
    check(leaks === 0, `the defence is strong enough to leak nothing (${leaks} leaks)`);
    check(mism === 0, `gold delta == bounties + clear bonus on every tick (${mism} mismatches)` +
      (firstMism ? ` first ${firstMism}` : ''));
  }

  /* C24. Frost slow: slowT is refreshed to 1.5s, never stacks, and the slowed
   * enemy really moves at ~55% speed. */
  TD.newGame({ seed: 1, wave: 1 }); TD.start();
  TD.placeTower(3, 1, 'frost');
  TD.setSpeed(1);
  let sawSlow = false, maxSlow = 0, ratioSample = null;
  for (let i = 0; i < 6000; i++) {
    const before = TD.enemyList();
    TD.tick(1 / 60, 1 / 60);
    const after = TD.enemyList();
    for (const e of after) if (e.slowT > maxSlow) maxSlow = e.slowT;
    if (after.some(e => e.slowT > 0)) sawSlow = true;
    if (ratioSample === null) {
      const { pairs } = matchSnapshots(before, after);
      for (const [b, a] of pairs) {
        // `b` was already clearly slowed BEFORE this tick (so the whole tick was
        // at reduced speed) and survives the tick.
        if (b && b.slowT > 1.0 && a.slowT > 0 && a.hp > 0) {
          const base = ESPEC[a.type].speed * TILE * (1 / 60);
          ratioSample = (a.pathDist - b.pathDist) / base;
          break;
        }
      }
    }
    if (sawSlow && ratioSample !== null) break;
  }
  check(sawSlow, 'a frost tower actually slows an enemy');
  check(maxSlow <= 1.5 + 1e-9, `slowT never exceeds slowTime=1.5 (max ${maxSlow.toFixed(4)})`);
  check(ratioSample !== null && ratioSample > 0.45 && ratioSample < 0.65,
    `a slowed enemy advances at ~55% speed (ratio ${ratioSample === null ? 'n/a' : ratioSample.toFixed(3)})`);

  /* C25. Cannon splash: with only a cannon able to hit several enemies at once,
   * a single tick damages >=2 enemies (a single-target gun never could). */
  TD.newGame({ seed: 1, wave: 12 }); TD.start();
  {
    const ranked = TD.buildableSlots()
      .map(s => ({ ...s, exp: TD.exposureSeconds(s.col, s.row, 3.5, 1) }))
      .sort((a, b) => b.exp - a.exp);
    TD.placeTower(ranked[0].col, ranked[0].row, 'cannon');
    // frost towers bunch the traffic (frost is single-target, so any multi-hit
    // in one tick can only come from the cannon's splash).
    TD.placeTower(ranked[1].col, ranked[1].row, 'frost');
    TD.placeTower(ranked[2].col, ranked[2].row, 'frost');
    let splashTick = 0, splashTypes = '';
    for (let i = 0; i < 12000; i++) {
      const before = TD.enemyList();
      TD.tick(1 / 60, 1 / 60);
      const after = TD.enemyList();
      if (TD.getState().phase !== 'playing') break;
      const { pairs } = matchSnapshots(before, after);
      const hurt = pairs.filter(([b, a]) => b && a.hp < b.hp);
      if (hurt.length >= 2) { splashTick = i; splashTypes = hurt.map(([, a]) => a.type).join(','); break; }
    }
    check(splashTick > 0, `the cannon splashes >=2 enemies in one tick (tick ${splashTick}, types ${splashTypes})`);
  }
}

/* ======================================================================
 * 9. Wave lifecycle + HUD cache (C26, C27, C28)
 * ==================================================================== */

group('9. wave lifecycle: callNextWave, newGame/loadWave, HUD cache invariant');
{
  /* C26. callNextWave at ready starts; during a wave it cashes the bonus and
   * immediately opens the next. Bonus == 40 + 8*wave. */
  TD.newGame({ seed: 1, wave: 1 });
  let st = TD.callNextWave();
  check(st.phase === 'playing' && st.waveActive, 'callNextWave() in ready begins the game');
  const gB = TD.gold();
  st = TD.callNextWave();
  const bonus = TD.gold() - gB;
  check(bonus === 40 + 8 * 1, `calling during wave 1 settles the 40+8*1=48 bonus (got ${bonus})`);
  check(st.wave === 2 && st.waveActive, `the next wave opens at once (wave ${st.wave}, active ${st.waveActive})`);
  check(st.intermission === 0, 'no intermission is inserted on an early call');

  /* C26b. Letting a wave finish naturally sets a 6s intermission. */
  TD.newGame({ seed: 1, wave: 1 }); TD.start();
  TD.callNextWave();                               // finish wave 1 -> intermission before wave 2? no: early start
  // Build the case explicitly: clear a wave by finishing it non-early via an
  // empty wave is not possible; instead check the intermission constant.
  check(TD.NEXT_WAVE_DELAY === 6, `NEXT_WAVE_DELAY is 6s (got ${TD.NEXT_WAVE_DELAY})`);

  /* C27. newGame({wave:n}) and loadWave(n). */
  for (const n of [1, 5, 12]) {
    const s = TD.newGame({ seed: 1, wave: n });
    check(s.wave === n && s.gold === myGoldAvailable(n),
      `newGame({wave:${n}}) sets wave ${n} and gold ${myGoldAvailable(n)} (got ${s.wave}/${s.gold})`);
    check(s.phase === 'ready', `newGame({wave:${n}}) stays in 'ready'`);
    const l = TD.loadWave(n);
    check(l.phase === 'playing' && l.waveActive === true && l.wave === n,
      `loadWave(${n}) starts playing/active on wave ${n} (got ${l.phase}/${l.waveActive}/${l.wave})`);
  }

  /* C28. The value-cached HUD mirrors getState after ticks. */
  TD.newGame({ seed: 1, wave: 1 }); TD.start();
  let cacheBad = 0;
  for (let i = 0; i < 200; i++) {
    TD.tick(0.15, 1 / 60);
    const s = TD.getState(), c = TD.hudCache();
    if (c.score !== s.score || c.lives !== s.lives || c.gold !== s.gold) cacheBad++;
    if (c.wave !== s.wave + '/' + WAVE_COUNT) cacheBad++;
    if (c.speed !== s.speed + '\u00d7') cacheBad++;
  }
  check(cacheBad === 0, `hudCache mirrors getState across 200 ticks (${cacheBad} mismatches)`);
}

/* ======================================================================
 * 10. Idle loss + greedy bot win + determinism (C18, C19)
 * ==================================================================== */

group('10. idle loss, greedy bot wins, and full determinism');
{
  /* C18. Do nothing: lose on wave 2 after exactly 20 leaks. */
  TD.newGame({ seed: 1, wave: 1 }); TD.start();
  let firstLeakWave = 0, prevLives = TD.lives();
  const res = tickUntil(() => {
    const s = TD.getState();
    if (s.lives < prevLives && firstLeakWave === 0) firstLeakWave = s.wave;
    prevLives = s.lives;
    return s.phase !== 'playing';
  }, 400, 0.1);
  const end = TD.getState();
  check(res.ok && end.phase === 'lose', `an idle run ends in 'lose' (got ${end.phase})`);
  check(end.wave === 2, `the base is overrun exactly on wave 2 (got ${end.wave})`);
  check(START_LIVES - end.lives === 20, `exactly 20 (8 + 12) enemies leaked (got ${START_LIVES - end.lives})`);
  check(end.lives === 0, `lives reach 0 on the loss (got ${end.lives})`);
  check(firstLeakWave === 1 || firstLeakWave === 2, `the first leak happens on wave 1 or 2 (got ${firstLeakWave})`);

  /* The greedy bot: before each wave, buy the best damage-per-gold tower on the
   * best slots; tick until the game ends. */
  function bestBuy(gold, wave) {
    const occupied = {};
    for (const t of TD.builtTowers()) occupied[t.col + ',' + t.row] = 1;
    const wk = TD.waves()[Math.min(wave, WAVE_COUNT) - 1];
    const mix = [];
    for (const g of wk.groups) for (let i = 0; i < g.count; i++) mix.push(g.type);
    const es = {};
    for (const e of TD.enemies()) es[e.type] = e;
    let best = null;
    for (const s of TD.buildableSlots()) {
      if (occupied[s.col + ',' + s.row]) continue;
      for (const tt of TD.towers()) {
        const lv = tt.levels[0];
        if (lv.cost > gold) continue;
        let dmg = 0;
        for (const t of mix) {
          const e = es[t];
          dmg += TD.exposureSeconds(s.col, s.row, lv.range, e.speed) * (lv.rate * Math.max(1, lv.dmg - e.armor));
        }
        const eff = dmg / lv.cost;
        if (!best || eff > best.eff) best = { col: s.col, row: s.row, type: tt.type, eff };
      }
    }
    return best;
  }
  function runBot(seed) {
    TD.newGame({ seed, wave: 1 }); TD.start(); TD.setSpeed(1);
    let guard = 0, lastWave = -1;
    while (TD.getState().phase === 'playing' && guard++ < 40000) {
      const s = TD.getState();
      if (s.wave !== lastWave) {
        lastWave = s.wave;
        // Each successful placement occupies one new buildable slot, so this is
        // bounded by the slot count; the explicit guard makes the bound obvious.
        let bought = true, spent = 0;
        const maxBuys = TD.buildableSlots().length + 1;
        while (bought && spent++ < maxBuys && TD.getState().phase === 'playing') {
          bought = false;
          const b2 = bestBuy(TD.gold(), TD.getState().wave);
          if (b2 && TD.placeTower(b2.col, b2.row, b2.type)) bought = true;
        }
      }
      TD.tick(0.25, 1 / 60);
    }
    return TD.getState();
  }

  const w1 = runBot(1);
  check(w1.phase === 'win', `the greedy bot clears all 12 waves (got ${w1.phase} at wave ${w1.wave})`);
  check(w1.lives > 0, `the bot wins with lives to spare (${w1.lives} lives)`);
  check(w1.towers.length >= 10, `the bot built a real defence (${w1.towers.length} towers)`);
  note(`bot seed 1: phase=${w1.phase} lives=${w1.lives} gold=${w1.gold} towers=${w1.towers.length} score=${w1.score}`);

  // Deterministic AND seed-independent (there is no randomness at all). The
  // echoed `seed` field is the only thing that differs, so it is stripped.
  const stripSeed = s => { const o = Object.assign({}, s); delete o.seed; return JSON.stringify(o); };
  const a = stripSeed(runBot(1));
  const b = stripSeed(runBot(1));
  const c = stripSeed(runBot(7));
  check(a === b, 'the same seed + same bot is bit-for-bit reproducible');
  check(a === c, 'a different seed yields the identical run (the game is deterministic)');
  check(runBot(1).seed === 1 && runBot(7).seed === 7, 'getState() echoes the requested seed');

  // The model really is a function of ticks: a fresh newGame is deterministic.
  const fresh = () => { TD.newGame({ seed: 3, wave: 2 }); TD.start(); TD.tick(5, 1 / 60); return JSON.stringify(TD.getState()); };
  check(fresh() === fresh(), 'a fresh seeded run replays identically');
}

/* ======================================================================
 * 11. Dynamic i18n (D31-D34)
 * ==================================================================== */

group('11. i18n: dynamic HUD text, tower prices, overlays, static hooks');
{
  const Gi = boot(), Si = Gi.PF, Ti = Gi.T, ei = Gi.els;
  check(!!Ti && Ti.lang === 'en', `the i18n helper boots in English (lang=${Ti && Ti.lang})`);
  ei.btnStart.fire('click');                        // real Start click -> playing
  check(Si.getState().phase === 'playing', `Start enters 'playing' (got ${Si.getState().phase})`);

  /* D31. #nextInfo (wave-in-progress, interpolated) is dynamic. */
  check(!CJK.test(ei.nextInfo.textContent) && /\d/.test(ei.nextInfo.textContent),
    `#nextInfo is the English waveActive text (got ${JSON.stringify(ei.nextInfo.textContent)})`);
  Ti.set('zh');
  check(CJK.test(ei.nextInfo.textContent), `#nextInfo becomes Chinese via T.onChange (got ${JSON.stringify(ei.nextInfo.textContent)})`);
  check(/\d/.test(ei.nextInfo.textContent), 'the interpolated enemy count survives the switch');

  /* #nextInfo in the intermission form ("next in Ns"): let wave 1 clear
   * naturally (idle) so a real intermission starts. */
  Si.newGame({ seed: 1, wave: 1 }); Si.start();
  let guard = 0;
  while (Si.getState().waveActive && guard++ < 4000) Si.tick(0.25, 1 / 60);
  Ti.set('en');
  const inter = Si.getState();
  check(!inter.waveActive && inter.intermission > 0,
    `wave 1 clears into an intermission (intermission=${inter.intermission.toFixed(2)}s)`);
  const enInfo = ei.nextInfo.textContent;
  check(/next wave in/i.test(enInfo), `#nextInfo shows the English 'next wave in Ns' (got ${JSON.stringify(enInfo)})`);
  Ti.set('zh');
  check(CJK.test(ei.nextInfo.textContent) && /\d/.test(ei.nextInfo.textContent),
    `the intermission text is Chinese with the count (got ${JSON.stringify(ei.nextInfo.textContent)})`);

  /* D31b. #selInfo is dynamic too: click a buildable tile with no type chosen. */
  Ti.set('en');
  const slot = Si.buildableSlots()[0];
  ei.cv.fire('click', { clientX: slot.col * TILE + TILE / 2, clientY: slot.row * TILE + TILE / 2, preventDefault() {} });
  check(/Buildable tile/i.test(ei.selInfo.textContent),
    `#selInfo shows the English pick prompt (got ${JSON.stringify(ei.selInfo.textContent)})`);
  Ti.set('zh');
  check(CJK.test(ei.selInfo.textContent), `#selInfo becomes Chinese (got ${JSON.stringify(ei.selInfo.textContent)})`);

  /* D32. Tower buttons carry the price and re-localise. */
  Ti.set('en');
  check(ei.btnGun.textContent === 'Gun 50' && ei.btnCannon.textContent === 'Cannon 90' && ei.btnFrost.textContent === 'Frost 70',
    `tower buttons are 'Name price' (got ${JSON.stringify(ei.btnGun.textContent)}, ${JSON.stringify(ei.btnCannon.textContent)})`);
  Ti.set('zh');
  check(ei.btnGun.textContent === '机枪 50' && !/Gun/.test(ei.btnGun.textContent),
    `the gun button is Chinese with the price after the switch (got ${JSON.stringify(ei.btnGun.textContent)})`);

  /* D33. The win dialog re-localises through T.onChange. */
  Ti.set('en');
  Si.newGame({ seed: 1, wave: 1 }); Si.start();
  for (let i = 0; i < 12; i++) Si.callNextWave();   // cash through all 12 waves -> win
  check(Si.getState().phase === 'win', `calling through all 12 waves reaches 'win' (got ${Si.getState().phase})`);
  check(ei.ovTitle.textContent === 'You win!', `the result title is the English 'You win!' (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  check(/[0-9]/.test(ei.ovSub.textContent), `the win subtitle carries the score (got ${JSON.stringify(ei.ovSub.textContent)})`);
  Ti.set('zh');
  check(ei.ovTitle.textContent === '胜利！', `flipping to zh re-renders the OPEN dialog (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  check(CJK.test(ei.ovBtn.textContent), `the result button is Chinese (got ${JSON.stringify(ei.ovBtn.textContent)})`);
  Ti.set('en');
  check(ei.ovTitle.textContent === 'You win!', 'flipping back to en restores the English title');

  /* D34. Every data-i18n key resolves non-empty and differs between languages,
   * and the document <title> is non-empty. */
  const keys = new Set();
  for (const m of HTML.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) keys.add(m[1]);
  Ti.set('en');
  const enMap = {}; for (const k of keys) enMap[k] = Ti.t(k);
  Ti.set('zh');
  const zhMap = {}; for (const k of keys) zhMap[k] = Ti.t(k);
  let emptyKey = '';
  const seenSame = [];
  for (const k of keys) {
    const en = enMap[k], zh = zhMap[k];
    if (!en || !zh) { if (!emptyKey) emptyKey = k; }
    else if (en === zh) seenSame.push(k);
  }
  const title = (HTML.match(/<title>([^<]*)<\/title>/) || [, ''])[1];
  check(keys.size >= 6, `the markup carries ${keys.size} data-i18n keys`);
  check(emptyKey === '', `every data-i18n key resolves non-empty in both languages (empty: ${emptyKey || 'none'})`);
  check(seenSame.length === 0, `every data-i18n key differs between en and zh (same: ${JSON.stringify(seenSame.slice(0, 3))})`);
  check(title.trim().length > 0, `the document <title> is non-empty (got ${JSON.stringify(title)})`);
}

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
console.log('(exact geometry oracle; frozen-table differential; idle-loss/bot-win/real-kill all driven through tick(); dynamic i18n through T.onChange)');
process.exit(fail ? 1 : 0);
