#!/usr/bin/env node
/**
 * Rule / logic tests for pool-game (a single-table 8-ball clear-the-table game).
 *
 * Why this layer exists. `tools/smoke.js` only proves the page parses and does
 * not throw: its stub DOM invents an element for ANY id, `querySelectorAll`
 * returns [], and nothing is ever asserted about a value. It cannot tell whether
 * the fixed physics grid is really fixed, whether the collision really keeps the
 * tangential component, whether a potted ball really leaves the array, whether
 * the 8-ball rule really refuses to credit the 8 early, or whether the closed
 * forms in the README are the shipped ones. This suite loads the whole inline
 * <script> in a vm sandbox behind the same stub DOM and asserts behaviour
 * THROUGH the game's own bridge `window.PL` - the IIFE keeps every `var` private,
 * so the bridge is the only channel, exactly as the README documents.
 *
 * The model under test (spec, not implementation):
 *
 *   - A fixed physics grid PHYS_H = 1/240 s. `advance(balls, h)` cuts the
 *     submitted slice into round(h/PHYS_H) cells of PHYS_H plus, only when h is
 *     not a multiple, one remainder cell. It must NEVER re-divide h by the cell
 *     count. Consequence (P2): every h that is an integer multiple of PHYS_H is
 *     bit-comparable to the equivalent sequence of smaller calls at the same
 *     absolute time. Group 4 is the oracle for that claim: it never trusts a
 *     single call in isolation, it always compares two DIFFERENT decompositions
 *     of the SAME total time.
 *
 *   - One cell is: travel -> pocket test (centre inside the mouth circle) ->
 *     cushion (clamp + flip the outgoing normal times WALL_RESTITUTION) ->
 *     ball-ball (equal mass, half the impulse each, de-overlap) -> Coulomb
 *     friction (|v| -= FRICTION*dt, parked at or below STOP_SPEED) -> positional
 *     clamp.
 *
 *   - Equal-mass collision: with n the line of centres and vn the relative
 *     normal speed, the normal velocities swap scaled by e, so a moving ball
 *     striking a resting one leaves (1-e)/2 * v on the striker and (1+e)/2 * v
 *     on the struck ball, while the tangential components are untouched. Group 5
 *     proves this twice: once against a REFERENCE IMPLEMENTATION OF A DIFFERENT
 *     SHAPE (centre-of-mass frame + half the relative velocity, which never
 *     writes the impulse formula), and once against the closed-form splits.
 *
 *   - Closed forms (derived from the spec numbers, never read back from the
 *     game): full power rolls 1400^2/(2*260) = 3769.2308 px in 5.3846 s; the
 *     softest cue 76.9231 px in 0.7692 s; one cell carries 5.8333 px; a ball-ball
 *     bounce keeps e^2 = 0.9216 of the normal energy, a cushion 0.7396.
 *
 *   - Rules: 15 object balls; the 8 must be last. A cue-ball pot is a foul and
 *     is re-spotted (never counted as potted); an early 8 is a foul and the ball
 *     goes back (never counted as potted). `best` is the FEWEST shots, stored in
 *     localStorage['litegame_pool_best'].
 *
 * Static gates (group 1) live one level above the stub: a stub that invents an
 * element for any id hides a dangling id, so every getElementById target is
 * resolved against the real markup, and the HUD nodes are mapped id -> variable
 * first and then proved to be written `.textContent` in updateHud() ONLY.
 *
 * `--selftest` reverse-validates the whole file: each of eight deliberate
 * defects is spliced into an in-memory copy of the page, the guard that is
 * supposed to catch it is re-run, and the run fails unless that guard turns red
 * while the unmodified page stays green.
 *
 * Usage:
 *   node tools/pool-test.js [--selftest] [path/to/index.html]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');
const gameArg = argv.find(a => !a.startsWith('--'));
const GAME = gameArg ? path.resolve(gameArg) : path.join(ROOT, 'pool-game', 'index.html');
const SIBLING_I18N = path.join(path.dirname(GAME), '..', 'assets', 'i18n.js');
const I18N = fs.existsSync(SIBLING_I18N) ? SIBLING_I18N : path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const absClose = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

/* ==========================================================================
 * THE SPEC. These literals are the contract; PL.constants is compared to THEM,
 * and every closed form below is computed from THEM. Nothing here is read back
 * from the page, so an edit to the shipped numbers shows up as a diff.
 * ======================================================================== */

const SPEC = {
  TABLE_W: 800, TABLE_H: 400,
  BALL_R: 10, POCKET_R: 20, BALL_COUNT: 16,
  PHYS_H: 1 / 240, MAX_CHUNK: 0.25,
  MAX_SPEED: 1400, MIN_SPEED: 200,
  FRICTION: 260, STOP_SPEED: 6,
  WALL_RESTITUTION: 0.86, BALL_RESTITUTION: 0.96,
  CUE_START_X: 200, CUE_START_Y: 200,
  RACK_APEX_X: 560, RACK_APEX_Y: 200,
  RACK_GAP: 20.2, RACK_DX: 20.2 * Math.sqrt(3) / 2,
  AIM_STEP: 0.02, POWER_STEP: 40,
  BALL_POINTS: 100, SHOT_PENALTY: 15, FOUL_PENALTY: 50, LOG_SIZE: 64
};

const CLOSED = {
  stopDistMax: SPEC.MAX_SPEED * SPEC.MAX_SPEED / (2 * SPEC.FRICTION),   // 3769.2308
  stopTimeMax: SPEC.MAX_SPEED / SPEC.FRICTION,                          // 5.3846
  stopDistMin: SPEC.MIN_SPEED * SPEC.MIN_SPEED / (2 * SPEC.FRICTION),   // 76.9231
  stopTimeMin: SPEC.MIN_SPEED / SPEC.FRICTION,                          // 0.7692
  cellTravel: SPEC.MAX_SPEED * SPEC.PHYS_H,                             // 5.8333
  ballEnergy: SPEC.BALL_RESTITUTION * SPEC.BALL_RESTITUTION,            // 0.9216
  wallEnergy: SPEC.WALL_RESTITUTION * SPEC.WALL_RESTITUTION             // 0.7396
};

/* ==========================================================================
 * Stub DOM. Mirrors tools/smoke.js - the HARD runtime boundary the game is
 * written against:
 *   - setTimeout/setInterval are recorded (the game must not use either);
 *   - document.querySelectorAll() returns [] (so every element must be fetched
 *     by id - a querySelector-only page would silently do nothing here);
 *   - getAttribute() returns null and setAttribute() is remembered but never
 *     read back by the game;
 *   - localStorage has no removeItem and may throw;
 *   - el.style is a plain object, so a direct property write persists;
 *   - there is no canvas at all: a getContext call would be a hard error.
 * ======================================================================== */

function makeDom() {
  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.parent = null;
      this.dataset = {};
      this.disabled = false;
      this.value = '';
      this.title = '';
      this.clientWidth = 0;            // headless: no layout
      this.clientHeight = 0;
      this._attrs = {};
      this._text = '';
      this._cls = new Set();
      this.handlers = {};
      this.style = { setProperty() {}, getPropertyValue: () => '', removeProperty() {} };
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
    set innerHTML(v) { if (v === '') this.children = []; }
    get innerHTML() { return ''; }
    get parentNode() { return this.parent; }
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getContext() { throw new Error('the pool page must not use canvas'); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  }
  const els = {};
  const store = {};
  const stats = { raf: 0, timers: 0, docHandlers: {}, winHandlers: {} };
  let frame = null;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map, WeakMap,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, RegExp,
    performance: { now: () => 0 },
    setTimeout: () => { stats.timers++; return 0; },
    clearTimeout: () => {},
    setInterval: () => { stats.timers++; return 0; },
    clearInterval: () => {},
    requestAnimationFrame: fn => { stats.raf++; frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    devicePixelRatio: 1,
    localStorage: {
      getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
      /* deliberately no removeItem, exactly like smoke.js */
    },
    document: {
      documentElement: new El('html'),
      head: new El('head'),
      body: new El('body'),
      title: '',
      getElementById: id => els[id] || (els[id] = new El('div')),
      createElement: t => new El(t),
      createDocumentFragment: () => new El('fragment'),
      querySelectorAll: () => [],
      addEventListener(t, f) { (stats.docHandlers[t] = stats.docHandlers[t] || []).push(f); }
    }
  };
  context.navigator = { language: 'en' };
  context.window = context;
  context.global = context;
  context.self = context;
  context.addEventListener = (t, f) => { (stats.winHandlers[t] = stats.winHandlers[t] || []).push(f); };
  context.removeEventListener = () => {};
  vm.createContext(context);
  return { context, els, store, stats, frameNow: () => frame };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

const I18N_SOURCE = fs.readFileSync(I18N, 'utf8');

/** Boot a page source in a fresh sandbox. `T` is captured by wrapping
 * LiteI18N.create, which is how the onChange listener count is proved without
 * touching the source (T lives inside the IIFE). */
function boot(html) {
  const dom = makeDom();
  vm.runInContext(I18N_SOURCE, dom.context, { filename: 'assets/i18n.js' });
  let T = null, onChangeCalls = 0, created = 0;
  const orig = dom.context.LiteI18N.create;
  dom.context.LiteI18N.create = function (dict) {
    created++;
    const inst = orig(dict);
    const real = inst.onChange;
    inst.onChange = function (fn) { onChangeCalls++; return real(fn); };
    T = inst;
    return inst;
  };
  const bodies = inlineScripts(html);
  bodies.forEach((s, i) => vm.runInContext(s, dom.context, { filename: `index.html#inline${i}` }));
  return { PL: dom.context.PL, els: dom.els, store: dom.store, stats: dom.stats, T, onChangeCalls, created, bodies };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/* ==========================================================================
 * Source-level helpers
 * ======================================================================== */

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
/* The {..}-balanced body of `function name(...)`, or null. */
function fnBody(src, name) {
  const m = src.match(new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{'));
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(m.index + m[0].length, i - 1);
}

/* ==========================================================================
 * Guards. Each returns a list of {ok, label, extra} so the SAME code can be
 * printed by the suite and re-run by --selftest against a patched page.
 * ======================================================================== */

/* ---- 1. static gates ------------------------------------------------ */
function guardStatic(html, booted) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const script = booted.bodies.join('\n');
  const code = stripComments(script);

  t(booted.created === 1, `LiteI18N.create() runs exactly once (${booted.created})`);
  t(booted.onChangeCalls === 1, `T.onChange registers exactly one listener (${booted.onChangeCalls})`);
  t(!/\bsetTimeout\s*\(/.test(code), 'the inline script calls no setTimeout');
  t(!/\bsetInterval\s*\(/.test(code), 'the inline script calls no setInterval');
  t(booted.stats.timers === 0, `no timer was armed at boot (${booted.stats.timers})`);
  t(booted.stats.raf === 1, `exactly one rAF is scheduled at boot - the loop is the only clock (${booted.stats.raf})`);
  t(!/Math\.random/.test(code), 'the inline script never calls Math.random');
  t(!/getContext|createElement\(\s*['"]canvas|'2d'|"2d"/.test(code), 'the page never asks for a canvas context');
  t(!/<canvas\b/i.test(html), 'the markup contains no <canvas>');

  /* Every getElementById target must exist as id="..." in the markup: the stub
   * invents an element for any id, so a dangling id is invisible here but
   * throws in a real browser. */
  const used = [...script.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const created = new Set([...script.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)].map(m => m[1]));
  const dangling = [...new Set(used)].filter(id => !defined.has(id) && !created.has(id));
  t(used.length >= 20, `the page reaches for ${new Set(used).size} distinct ids through getElementById`);
  t(dangling.length === 0, 'every getElementById target exists in the markup', JSON.stringify(dangling));

  /* HUD gate. Map id -> node variable FIRST (the game caches nodes in vars), then
   * prove every `.textContent =` write on those variables lives inside
   * updateHud(). A write anywhere else can desync the value cache from the DOM. */
  const map = {};
  for (const m of script.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    map[m[2]] = m[1];
  }
  const HUD = ['score', 'best', 'shots', 'potted', 'fouls', 'remain', 'msg', 'status'];
  const unmapped = HUD.filter(id => !map[id]);
  t(unmapped.length === 0, 'all eight HUD ids are cached in a variable', JSON.stringify(unmapped));

  const body = fnBody(script, 'updateHud');
  t(!!body, 'updateHud() is defined');
  const b = body || '';
  const stray = [];
  const missingWrite = [];
  for (const id of HUD) {
    const v = map[id];
    if (!v) continue;
    const re = new RegExp('\\b' + v + '\\.textContent\\s*=', 'g');
    const total = (script.match(re) || []).length;
    const inside = (b.match(re) || []).length;
    if (inside === 0) missingWrite.push(id);
    if (total !== inside) stray.push(`${id}(${v}): ${total - inside} outside`);
  }
  t(missingWrite.length === 0, 'updateHud() writes every HUD node', JSON.stringify(missingWrite));
  t(stray.length === 0, 'no HUD node is written .textContent outside updateHud()', JSON.stringify(stray));
  const direct = (script.match(/getElementById\s*\(\s*['"][^'"]+['"]\s*\)\s*\.textContent\s*=/g) || []).length;
  t(direct === 0, 'no HUD node is written through a bare getElementById().textContent =', direct);

  return out;
}

/* ---- 2. constants contract ----------------------------------------- */
function guardConstants(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const C = PL.constants || {};
  const names = Object.keys(SPEC);
  t(names.length === 25, 'the spec table carries the 25 frozen constants');
  const bad = [];
  for (const k of names) {
    const want = SPEC[k];
    const got = C[k];
    const tol = (k === 'PHYS_H') ? 1e-12 : (k === 'RACK_DX' ? 1e-3 : 0);
    if (typeof got !== 'number' || !(Math.abs(got - want) <= tol)) bad.push(`${k}: ${got} != ${want}`);
  }
  t(bad.length === 0, `PL.constants matches all ${names.length} spec values`, JSON.stringify(bad).slice(0, 300));

  t(absClose(PL.substepTravel(), CLOSED.cellTravel, 1e-12),
    `substepTravel() = MAX_SPEED/240 = ${CLOSED.cellTravel.toFixed(4)}`, PL.substepTravel());

  const sd = [[SPEC.MAX_SPEED, CLOSED.stopDistMax], [SPEC.MIN_SPEED, CLOSED.stopDistMin], [0, 0]];
  const sdBad = sd.filter(([v, want]) => !absClose(PL.stopDistance(v), want, 1e-9));
  t(sdBad.length === 0, `stopDistance(v) = v^2/(2*FRICTION): ${CLOSED.stopDistMax.toFixed(4)} at full power, ${CLOSED.stopDistMin.toFixed(4)} at the softest`,
    JSON.stringify(sd.map(([v]) => PL.stopDistance(v))));

  const st = [[SPEC.MAX_SPEED, CLOSED.stopTimeMax], [SPEC.MIN_SPEED, CLOSED.stopTimeMin]];
  const stBad = st.filter(([v, want]) => !absClose(PL.stopTime(v), want, 1e-12));
  t(stBad.length === 0, `stopTime(v) = v/FRICTION: ${CLOSED.stopTimeMax.toFixed(4)} s at full power, ${CLOSED.stopTimeMin.toFixed(4)} s at the softest`,
    JSON.stringify(st.map(([v]) => PL.stopTime(v))));

  t(absClose(PL.energyRatio(SPEC.BALL_RESTITUTION), CLOSED.ballEnergy, 1e-12),
    `energyRatio(0.96) = ${CLOSED.ballEnergy.toFixed(4)} (a ball-ball bounce keeps 92.16% of the normal energy)`);
  t(absClose(PL.energyRatio(SPEC.WALL_RESTITUTION), CLOSED.wallEnergy, 1e-12),
    `energyRatio(0.86) = ${CLOSED.wallEnergy.toFixed(4)} (a cushion keeps 73.96%)`);

  /* scoreOf: potted*100 - shots*15 - fouls*50, floored at 0. */
  const sc = [
    [{ potted: 3, shots: 4, fouls: 1 }, 300 - 60 - 50],
    [{ potted: [1, 2, 3], shots: 0, fouls: 0 }, 300],
    [{ potted: 0, shots: 100, fouls: 10 }, 0],
    [{ potted: 15, shots: 40, fouls: 7 }, 1500 - 600 - 350],
    [{}, 0]
  ];
  const scBad = sc.filter(([a, want]) => PL.scoreOf(a) !== want).map(([a]) => JSON.stringify(a) + '->' + PL.scoreOf(a));
  t(scBad.length === 0, 'scoreOf({potted,shots,fouls}) = potted*100 - shots*15 - fouls*50, floored at 0', JSON.stringify(scBad));

  const pk = PL.pockets();
  const wantPk = [[0, 0], [0, 400], [400, 0], [400, 400], [800, 0], [800, 400]];
  const pkOk = pk.length === 6 && wantPk.every(([x, y]) => pk.some(p => p.x === x && p.y === y && p.r === SPEC.POCKET_R));
  t(pkOk, 'pockets() returns the six mouths (0,0) (400,0) (800,0) (0,400) (400,400) (800,400)', JSON.stringify(pk));

  /* setPower clamps into [MIN_SPEED, MAX_SPEED]. */
  PL.newGame({ seed: 1 }); PL.setPower(-1e6);
  const lo = PL.getState().power;
  PL.setPower(1e6);
  const hi = PL.getState().power;
  t(lo === SPEC.MIN_SPEED && hi === SPEC.MAX_SPEED, `setPower clamps into [${SPEC.MIN_SPEED}, ${SPEC.MAX_SPEED}] (got ${lo}/${hi})`);
  PL.setPower(700);

  return out;
}

/* ---- 3. advance purity --------------------------------------------- */
function guardPurity(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });

  const balls = PL.rack(11);
  balls[0].vx = 900; balls[0].vy = -350;
  const before = JSON.stringify(balls);
  const res = PL.advance(balls, 0.25);
  t(JSON.stringify(balls) === before, 'advance() leaves its input array bit-identical');

  const again = PL.advance(balls, 0.25);   // same input once more
  t(JSON.stringify(res.balls) === JSON.stringify(again.balls) && JSON.stringify(res.events) === JSON.stringify(again.events),
    'advance() is deterministic: same input -> same balls and same events');

  const empty = PL.advance([], 0.5);
  t(Array.isArray(empty.balls) && empty.balls.length === 0 && Array.isArray(empty.events),
    'advance([]) returns an empty result instead of throwing');
  const zero = PL.advance(PL.rack(1), 0);
  t(zero.balls.length === 16 && zero.events.length === 0, 'advance(balls, 0) is a no-op');

  const spotArg = PL.rack(3);
  const spotBefore = JSON.stringify(spotArg);
  const spot = PL.respotSpot(spotArg);
  t(JSON.stringify(spotArg) === spotBefore, 'respotSpot() leaves its input untouched');
  t(typeof spot.x === 'number' && typeof spot.y === 'number' && isFinite(spot.x) && isFinite(spot.y),
    `respotSpot() returns finite coordinates (${spot.x}, ${spot.y})`);

  return out;
}

/* ---- 4. step invariance (the core claim) --------------------------- */
function byId(list) { const m = {}; for (const b of list) m[b.id] = b; return m; }
function maxStateDiff(X, Y) {
  const mx = byId(X), my = byId(Y);
  const kx = Object.keys(mx), ky = Object.keys(my);
  if (kx.length !== ky.length) return { err: `ball count ${kx.length} vs ${ky.length}` };
  let worst = 0, at = '';
  for (const k of kx) {
    const p = mx[k], q = my[k];
    if (!q) return { err: `ball ${k} missing` };
    for (const f of ['x', 'y', 'vx', 'vy']) {
      const d = Math.abs(p[f] - q[f]);
      if (!(d <= worst)) { if (Number.isNaN(d)) return { err: `NaN at ball ${k}.${f}` }; worst = d; at = `ball${k}.${f}`; }
    }
  }
  return { worst, at };
}
function runPitch(PL, seed, h, calls) {
  let list = PL.rack(seed);
  list[0].vx = 1200; list[0].vy = -450;
  /* a second live ball, so a mid-horizon collision is part of the comparison */
  list[5].vx = -260; list[5].vy = 180;
  for (let i = 0; i < calls; i++) list = PL.advance(list, h).balls;
  return list;
}

function guardStep(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const H = SPEC.PHYS_H;
  const cases = [
    ['1/30 in one call', 1 / 30, 30],
    ['1/60 in one call', 1 / 60, 30 * 2],
    ['1/120 in one call', 1 / 120, 30 * 4],
    ['0.25 in one call', 0.25, 4],
    ['1/240 in one call', H, 30 * 8]
  ];
  let worstAll = 0;
  for (const seed of [1, 7, 13, 29]) {
    const ref = runPitch(PL, seed, H, 240);          // 1.0 s at the base grid
    for (const [label, h, calls] of cases) {
      const got = runPitch(PL, seed, h, calls);
      const d = maxStateDiff(got, ref);
      if (d.err) { t(false, `seed ${seed}: ${label} matches 240 cells of 1/240`, d.err); continue; }
      worstAll = Math.max(worstAll, d.worst);
      t(d.worst < 1e-9, `seed ${seed}: ${label} == 240 x 1/240 over 1.0 s (max |d| ${d.worst.toExponential(2)})`, d.at);
    }
  }
  note(`worst |delta| across all pitch/seed pairs: ${worstAll.toExponential(3)}`);

  /* The one-call vs many-call form at a SHORT horizon, which is the case a
   * "divide h by the cell count" bug breaks most visibly. */
  for (const seed of [1, 7]) {
    const one = runPitch(PL, seed, 1 / 30, 1);
    for (const [label, h, calls] of [['8 x 1/240', H, 8], ['2 x 1/60', 1 / 60, 2], ['4 x 1/120', 1 / 120, 4]]) {
      const got = runPitch(PL, seed, h, calls);
      const d = maxStateDiff(got, one);
      t(!d.err && d.worst < 1e-9, `seed ${seed}: 1/30 in one call == ${label} at the same absolute time`, d.err || d.at);
    }
  }

  /* Composition, which is where an "equal division of the slice" bug actually
   * shows: for ANY h, one call must equal (k cells of PHYS_H) followed by the
   * remainder in a second call. The power-of-two pitches above cannot see that
   * bug because h/full lands exactly on PHYS_H there - these can. */
  const odd = [['0.02 s', 0.02], ['1/45 s', 1 / 45], ['0.03 s', 0.03], ['0.1 s', 0.1]];
  for (const [label, h] of odd) {
    const q = h / H;
    const k = (Math.abs(h - Math.round(q) * H) > 1e-9) ? Math.floor(q) : Math.round(q);
    const rest = h - k * H;
    for (const seed of [1, 7]) {
      const one = runPitch(PL, seed, h, 1);
      let split = runPitch(PL, seed, H, k);
      split = PL.advance(split, rest).balls;
      const d = maxStateDiff(one, split);
      t(!d.err && d.worst < 1e-9,
        `seed ${seed}: ${label} in one call == ${k} cells + the ${rest.toFixed(6)} s remainder`,
        d.err || d.at + ' ' + d.worst);
    }
  }

  return out;
}

/* ---- 5a. collision: differential against a different shape ---------- */
function mkBall(id, x, y, vx, vy) {
  return { id, x, y, vx, vy, r: SPEC.BALL_R, kind: id === 8 ? 'eight' : (id === 0 ? 'cue' : 'solid'), value: id };
}

/* Reference implementation, deliberately of a DIFFERENT SHAPE from the game:
 * no impulse formula at all. The pair is split into the centre-of-mass velocity
 * plus half the relative velocity; only the normal part of the relative
 * velocity is reversed (and scaled by e); then the two are recombined. */
function refCell(list, dt) {
  const L = list.map(o => ({ id: o.id, x: o.x, y: o.y, vx: o.vx, vy: o.vy, r: o.r, kind: o.kind, value: o.value }));
  for (const o of L) { o.x += o.vx * dt; o.y += o.vy * dt; }

  const mouths = [];
  for (let i = 0; i < 3; i++) { mouths.push([i * SPEC.TABLE_W / 2, 0], [i * SPEC.TABLE_W / 2, SPEC.TABLE_H]); }
  const alive = L.filter(o => !mouths.some(([px, py]) => Math.hypot(o.x - px, o.y - py) < SPEC.POCKET_R));
  L.length = 0; alive.forEach(o => L.push(o));

  for (const o of L) {
    if (o.x < o.r) { o.x = o.r; if (o.vx < 0) o.vx = -o.vx * SPEC.WALL_RESTITUTION; }
    else if (o.x > SPEC.TABLE_W - o.r) { o.x = SPEC.TABLE_W - o.r; if (o.vx > 0) o.vx = -o.vx * SPEC.WALL_RESTITUTION; }
    if (o.y < o.r) { o.y = o.r; if (o.vy < 0) o.vy = -o.vy * SPEC.WALL_RESTITUTION; }
    else if (o.y > SPEC.TABLE_H - o.r) { o.y = SPEC.TABLE_H - o.r; if (o.vy > 0) o.vy = -o.vy * SPEC.WALL_RESTITUTION; }
  }

  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      const A = L[i], B = L[j];
      let nx = B.x - A.x, ny = B.y - A.y;
      const dist = Math.hypot(nx, ny), contact = A.r + B.r;
      if (!(dist < contact)) continue;
      if (dist > 0) { nx /= dist; ny /= dist; } else { nx = 1; ny = 0; }
      const ux = A.vx - B.vx, uy = A.vy - B.vy;
      const un = ux * nx + uy * ny;
      if (un <= 0) continue;                       // already separating
      const cx = (A.vx + B.vx) / 2, cy = (A.vy + B.vy) / 2;
      const rx = ux - (1 + SPEC.BALL_RESTITUTION) * un * nx;
      const ry = uy - (1 + SPEC.BALL_RESTITUTION) * un * ny;
      A.vx = cx + rx / 2; A.vy = cy + ry / 2;
      B.vx = cx - rx / 2; B.vy = cy - ry / 2;
      const push = (contact - dist) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
    }
  }

  for (const o of L) {
    const speed = Math.hypot(o.vx, o.vy);
    if (speed > 0) {
      const next = speed - SPEC.FRICTION * dt;
      if (!(next > SPEC.STOP_SPEED)) { o.vx = 0; o.vy = 0; }
      else { o.vx *= next / speed; o.vy *= next / speed; }
    }
    o.x = Math.min(Math.max(o.x, o.r), SPEC.TABLE_W - o.r);
    o.y = Math.min(Math.max(o.y, o.r), SPEC.TABLE_H - o.r);
  }
  return L;
}

function guardCollision(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const H = SPEC.PHYS_H;

  const scenes = [
    ['head-on at rest', [mkBall(1, 300, 200, 900, 0), mkBall(2, 319, 200, 0, 0)]],
    ['60-degree cut', [mkBall(1, 300, 200, 700, 300), mkBall(2, 319.2, 202.5, 0, 0)]],
    ['both moving', [mkBall(1, 300, 200, 600, 0), mkBall(2, 319.4, 200.6, -300, 40)]],
    ['already separating', [mkBall(1, 300, 200, -400, 0), mkBall(2, 319.4, 200, 100, 0)]],
    ['three-ball pile', [mkBall(1, 300, 200, 800, 0), mkBall(2, 319.2, 200, 0, 0), mkBall(3, 309.6, 217.1, -100, -200)]]
  ];
  let worst = 0;
  for (const [name, balls] of scenes) {
    const got = PL.advance(balls, H).balls;
    const want = refCell(balls, H);
    const d = maxStateDiff(got, want);
    if (d.err) { t(false, `${name}: the engine matches the centre-of-mass reference`, d.err); continue; }
    worst = Math.max(worst, d.worst);
    t(d.worst < 1e-9, `${name}: the engine matches the centre-of-mass reference (max |d| ${d.worst.toExponential(2)})`, d.at);
  }
  note(`worst |delta| against the reference over one cell: ${worst.toExponential(3)}`);

  /* A long multi-body horizon: 240 cells of a whole agitated rack. Both sides
   * take exactly the same number of cells, otherwise this compares two different
   * instants (which is how a 0.5 px "failure" is born). */
  {
    const balls = PL.rack(3);
    balls.forEach((o, i) => { o.vx = (i * 137 % 900) - 450; o.vy = (i * 251 % 800) - 400; });
    let got = balls, want = balls.map(o => ({ ...o }));
    for (let i = 0; i < 240; i++) { got = PL.advance(got, H).balls; want = refCell(want, H); }
    const d = maxStateDiff(got, want);
    t(!d.err && d.worst < 1e-9, `a whole agitated rack tracks the reference for 1 s (240 cells, max |d| ${d.err || d.worst.toExponential(2)})`, d.at);
    t(got.length === want.length, `both sides also agree on how many balls are left (${got.length})`);
  }

  /* Closed forms, derived from the actual line of centres rather than assuming
   * the hit is axial. For a resting struck ball the pre-friction velocities are
   *   v_struck = (1+e)/2 * (v1.n) n          v_striker = v1 - (1+e)/2 * (v1.n) n
   * and the cell then removes FRICTION*dt from each SPEED (a uniform scale, so
   * the direction survives). This never writes the impulse formula. */
  const e = SPEC.BALL_RESTITUTION;
  function closedForm(v1, p1, p2) {
    let nx = p2.x - p1.x, ny = p2.y - p1.y;
    const d = Math.hypot(nx, ny) || 1;
    nx /= d; ny /= d;
    const vn = v1.vx * nx + v1.vy * ny;
    const half = (1 + e) / 2 * vn;
    return {
      n: { x: nx, y: ny }, vn,
      striker: { vx: v1.vx - half * nx, vy: v1.vy - half * ny },
      struck: { vx: half * nx, vy: half * ny }
    };
  }
  function afterFriction(v) {
    const s = Math.hypot(v.vx, v.vy);
    const ns = s - SPEC.FRICTION * H;
    if (!(ns > SPEC.STOP_SPEED)) return { vx: 0, vy: 0 };
    return { vx: v.vx * ns / s, vy: v.vy * ns / s };
  }
  const near = (a, b) => absClose(a, b, 1e-9);

  const hits = [
    ['head-on', { x: 300, y: 200, vx: 1000, vy: 0 }, { x: 319, y: 200 }],
    ['cut shot', { x: 300, y: 200, vx: 600, vy: 300 }, { x: 319, y: 200 }],
    ['oblique', { x: 300, y: 200, vx: 500, vy: -420 }, { x: 318, y: 204 }]
  ];
  for (const [name, s1, s2] of hits) {
    const balls = [mkBall(1, s1.x, s1.y, s1.vx, s1.vy), mkBall(2, s2.x, s2.y, 0, 0)];
    const after = byId(PL.advance(balls, H).balls);
    const a = after[1], b = after[2];
    if (!a || !b) { t(false, `${name}: both balls survive the cell`); continue; }
    /* The collision happens after the travel step, so the line of centres must be
     * taken from the POST-travel positions. */
    const p1 = { x: s1.x + s1.vx * H, y: s1.y + s1.vy * H };
    const cf = closedForm({ vx: s1.vx, vy: s1.vy }, p1, s2);
    const wantA = afterFriction(cf.striker), wantB = afterFriction(cf.struck);
    t(near(a.vx, wantA.vx) && near(a.vy, wantA.vy),
      `${name}: the striker keeps (1-e)/2 of its normal component (${wantA.vx.toFixed(6)}, ${wantA.vy.toFixed(6)})`,
      `${a.vx}, ${a.vy}`);
    t(near(b.vx, wantB.vx) && near(b.vy, wantB.vy),
      `${name}: the struck ball leaves with (1+e)/2 of the normal component, along the line of centres`,
      `${b.vx}, ${b.vy}`);
    /* The split ratio, stated as a ratio of speeds before friction. */
    const struckPre = Math.hypot(cf.struck.vx, cf.struck.vy);
    if (Math.abs(cf.vn) > 1e-9) {
      t(absClose(struckPre / Math.abs(cf.vn), (1 + e) / 2, 1e-12),
        `${name}: |v_struck| / |v_normal| = (1+e)/2 = ${((1 + e) / 2).toFixed(2)}`, struckPre / Math.abs(cf.vn));
      const strikerN = cf.striker.vx * cf.n.x + cf.striker.vy * cf.n.y;
      t(absClose(strikerN / cf.vn, (1 - e) / 2, 1e-12),
        `${name}: the striker's remaining normal component is (1-e)/2 = ${((1 - e) / 2).toFixed(2)} of vn`, strikerN / cf.vn);
    }
    /* Tangential: the struck ball has NO tangential component at all, and the
     * striker's tangential component is only scaled by friction. */
    const bt = -cf.n.y * b.vx + cf.n.x * b.vy;     // 2D cross with n
    t(Math.abs(bt) < 1e-9, `${name}: the struck ball gains no tangential velocity (no ball-ball friction)`, bt);
    const t1 = -cf.n.y * s1.vx + cf.n.x * s1.vy;
    const ta = -cf.n.y * a.vx + cf.n.x * a.vy;
    const sA = Math.hypot(cf.striker.vx, cf.striker.vy);
    const scale = sA > 0 ? (sA - SPEC.FRICTION * H) / sA : 0;
    t(absClose(ta, t1 * scale, 1e-9),
      `${name}: the striker's tangential component is untouched by the hit (only friction scales it)`, `${ta} vs ${t1 * scale}`);
  }

  /* An object ball dropped straight into a mouth leaves the array, and the event
   * carries the pocket centre. */
  {
    const balls = [mkBall(5, 40, 40, -600, -600)];
    const res = PL.advance(balls, 0.25);
    const pot = res.events.filter(ev => ev.type === 'pot');
    t(res.balls.length === 0, `a ball driven into a mouth is REMOVED from the returned array (${res.balls.length} left)`,
      res.balls.map(o => o.id).join(','));
    t(pot.length === 1 && pot[0].a === 5 && (pot[0].x === 0 && pot[0].y === 0),
      'the pot event names the ball and the pocket centre it fell into', JSON.stringify(pot));
  }

  /* Events are ordered, well formed and never carry an undefined id. */
  {
    const balls = PL.rack(4);
    balls[0].vx = 1400; balls[0].vy = 0;
    const res = PL.advance(balls, 1);
    const kinds = new Set(res.events.map(ev => ev.type));
    let mono = true, prev = -Infinity;
    for (const ev of res.events) { if (!(ev.t >= prev - 1e-12)) mono = false; prev = ev.t; }
    t(mono, 'event times are non-decreasing within one advance() call');
    t([...kinds].every(k => ['ball', 'wall', 'pot', 'stop'].includes(k)),
      `only the four documented event types appear (${[...kinds].join(',')})`);
    t(res.events.every(ev => typeof ev.a === 'number' && (ev.b === null || typeof ev.b === 'number')),
      'every event carries numeric ids (b is null when there is no second ball)');
  }

  return out;
}

/* ---- 5b. cushions --------------------------------------------------- */
function guardWall(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const H = SPEC.PHYS_H, e = SPEC.WALL_RESTITUTION;

  const cases = [
    ['left cushion', mkBall(1, 12, 200, -600, 0), 'x', -600, SPEC.BALL_R],
    ['right cushion', mkBall(1, 788, 200, 600, 0), 'x', 600, SPEC.TABLE_W - SPEC.BALL_R],
    ['top cushion', mkBall(1, 300, 12, 0, -600), 'y', -600, SPEC.BALL_R],
    ['bottom cushion', mkBall(1, 300, 388, 0, 600), 'y', 600, SPEC.TABLE_H - SPEC.BALL_R]
  ];
  for (const [name, ball, axis, v0, limit] of cases) {
    const after = byId(PL.advance([ball], H).balls)[1];
    const want = Math.abs(v0) * e - SPEC.FRICTION * H;
    const got = after['v' + axis];          // the VELOCITY on that axis, not the coordinate
    t(Math.sign(got) === -Math.sign(v0), `${name}: the outgoing normal is REVERSED (${v0} -> ${got.toFixed(4)})`);
    t(absClose(Math.abs(got), want, 1e-9),
      `${name}: the normal speed is multiplied by WALL_RESTITUTION = ${e} (|v| = ${want.toFixed(6)})`, Math.abs(got));
    t(absClose(after[axis === 'x' ? 'y' : 'x'], ball[axis === 'x' ? 'y' : 'x'], 1e-12),
      `${name}: the tangential coordinate is untouched`);
    t(absClose(after[axis], limit, 1e-12), `${name}: the centre is clamped onto the contact line (${limit})`, after[axis]);
    /* Undo the friction of this one cell to recover the pure bounce factor: the
     * squared ratio must be WALL_RESTITUTION^2, i.e. 0.7396 of the energy. */
    const pure = (Math.abs(got) + SPEC.FRICTION * H) / Math.abs(v0);
    t(absClose(pure * pure, CLOSED.wallEnergy, 1e-9),
      `${name}: the bounce keeps WALL_RESTITUTION^2 = ${CLOSED.wallEnergy} of the normal energy (${(pure * pure).toFixed(6)})`);
  }

  /* Clamping a ball that already moves INWARD must not inject energy: the flip
   * fires only when the normal velocity points into the cushion. */
  {
    const inward = mkBall(1, 9.5, 200, 40, 0);      // beyond the line, moving inward
    const after = byId(PL.advance([inward], H).balls)[1];
    t(after.vx > 0 && after.vx <= 40, 'clamping a ball that is already moving inward never flips or amplifies it', after.vx);
  }

  /* A corner mouth must swallow the ball instead of bouncing it: the pocket test
   * runs BEFORE the cushion pass. */
  {
    const ball = mkBall(3, 40, 40, -700, -700);
    const res = PL.advance([ball], 0.25);
    t(res.balls.length === 0 && res.events.some(ev => ev.type === 'pot'),
      'a ball heading into a corner mouth is potted, not bounced off two cushions');
  }

  return out;
}

/* ---- 6. invariants over a real break -------------------------------- */
function guardInvariants(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const R = SPEC.BALL_R;

  let boundsBad = 0, keRise = 0, overlapBad = 0, ticksTotal = 0, worstOverlap = 0, maxOut = 0;
  const seedReport = [];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    PL.newGame({ seed });
    PL.start();
    PL.aimAt(SPEC.RACK_APEX_X, SPEC.RACK_APEX_Y);
    PL.setPower(SPEC.MAX_SPEED);
    if (!PL.shoot()) { t(false, `seed ${seed}: the break shot fires`); continue; }
    let prevKe = null, ticks = 0, st = PL.getState();
    for (let i = 0; i < 300; i++) {
      st = PL.tick(0.05);
      ticks++;
      let ke = 0;
      for (const o of st.balls) {
        const outX = Math.max(R - o.x, o.x - (SPEC.TABLE_W - R), R - o.y, o.y - (SPEC.TABLE_H - R));
        if (outX > 1e-6) { boundsBad++; maxOut = Math.max(maxOut, outX); }
        ke += (o.vx * o.vx + o.vy * o.vy) / 2;
      }
      if (prevKe !== null && ke > prevKe + 1e-9) keRise++;
      prevKe = ke;
      if (st.phase !== 'rolling') break;
    }
    ticksTotal += ticks;
    let overlap = 0;
    for (let i = 0; i < st.balls.length; i++) {
      for (let j = i + 1; j < st.balls.length; j++) {
        const d = Math.hypot(st.balls[i].x - st.balls[j].x, st.balls[i].y - st.balls[j].y);
        if (d < 2 * R - 1e-6) { overlap++; worstOverlap = Math.max(worstOverlap, 2 * R - d); }
      }
    }
    overlapBad += overlap;
    seedReport.push(`${seed}:${ticks}`);
    t(st.phase === 'aiming' || st.phase === 'over',
      `seed ${seed}: the break settles back to aiming (phase ${st.phase} after ${ticks} ticks of 0.05 s)`);
  }
  note(`ticks per seed: ${seedReport.join(' ')} (total ${ticksTotal})`);

  t(boundsBad === 0, `every ball centre stays inside [R, W-R] x [R, H-R] on every tick (violations ${boundsBad})`, maxOut.toExponential(2));
  t(keRise === 0, `kinetic energy never rises between ticks (rises ${keRise})`);
  t(overlapBad === 0, `no two resting balls overlap after a shot (overlaps ${overlapBad})`, worstOverlap.toExponential(2));

  /* Long-run total energy: the whole table can only lose energy. */
  {
    PL.newGame({ seed: 9 });
    PL.start();
    PL.aimAt(SPEC.RACK_APEX_X, SPEC.RACK_APEX_Y);
    PL.setPower(SPEC.MAX_SPEED);
    PL.shoot();
    const first = PL.getState().balls.reduce((s, o) => s + (o.vx * o.vx + o.vy * o.vy) / 2, 0);
    PL.tick(8);
    const last = PL.getState().balls.reduce((s, o) => s + (o.vx * o.vx + o.vy * o.vy) / 2, 0);
    t(last <= first + 1e-9 && last === 0, `a full break comes to rest in under 8 s (energy ${first.toFixed(1)} -> ${last})`);
  }

  return out;
}

/* ---- 7. the rack ---------------------------------------------------- */
function guardRack(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const C = SPEC;

  const a = PL.rack(1), b = PL.rack(1), c = PL.rack(2);
  t(a.length === C.BALL_COUNT, `rack() returns ${C.BALL_COUNT} balls`, a.length);
  t(JSON.stringify(a) === JSON.stringify(b), 'the same seed gives a bit-identical rack');
  t(JSON.stringify(a) !== JSON.stringify(c), 'a different seed gives a different rack');
  t(new Set(a.map(o => o.id)).size === C.BALL_COUNT, 'all sixteen ids are distinct and cover 0..15');

  const kinds = { cue: 0, solid: 0, eight: 0, stripe: 0 };
  a.forEach(o => kinds[o.kind]++);
  t(kinds.cue === 1 && kinds.solid === 7 && kinds.eight === 1 && kinds.stripe === 7,
    `the rack is 1 cue + 7 solids + 1 eight + 7 stripes (${JSON.stringify(kinds)})`);
  t(a.filter(o => o.id >= 1 && o.id <= 7).every(o => o.kind === 'solid'), 'ids 1..7 are solids');
  t(a.filter(o => o.id >= 9 && o.id <= 15).every(o => o.kind === 'stripe'), 'ids 9..15 are stripes');
  t(a.every(o => o.r === C.BALL_R && o.value === o.id), 'every ball carries r = BALL_R and value = its id');

  const cue = a.find(o => o.id === 0);
  t(cue.x === C.CUE_START_X && cue.y === C.CUE_START_Y && cue.vx === 0 && cue.vy === 0,
    `the cue ball sits still on the head spot (${cue.x}, ${cue.y})`);
  t(a[0].id === 0, 'the cue ball is the first entry of the rack');

  const eight = a.find(o => o.id === 8);
  t(absClose(eight.x, C.RACK_APEX_X + 2 * C.RACK_DX, 1e-9) && absClose(eight.y, C.RACK_APEX_Y, 1e-9),
    `the 8-ball is the centre of the third row (${eight.x.toFixed(4)}, ${eight.y})`, `${eight.x},${eight.y}`);

  /* 1/2/3/4/5 per row, all five rows present. */
  const rows = {};
  a.filter(o => o.id !== 0).forEach(o => {
    const k = Math.round((o.x - C.RACK_APEX_X) / C.RACK_DX);
    rows[k] = (rows[k] || 0) + 1;
  });
  t([0, 1, 2, 3, 4].every(k => rows[k] === k + 1), `the triangle is 1/2/3/4/5 rows deep (${JSON.stringify(rows)})`);

  let minPair = Infinity, pair = '';
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const d = Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y);
      if (d < minPair) { minPair = d; pair = `${a[i].id}-${a[j].id}`; }
    }
  }
  t(minPair >= 2 * C.BALL_R && absClose(minPair, C.RACK_GAP, 1e-9),
    `no two balls touch: the closest pair is RACK_GAP = ${C.RACK_GAP} px apart (${minPair.toFixed(9)} at ${pair})`, minPair);

  const outside = a.filter(o => o.x < C.BALL_R || o.x > C.TABLE_W - C.BALL_R || o.y < C.BALL_R || o.y > C.TABLE_H - C.BALL_R);
  t(outside.length === 0, 'every ball of the rack is inside the cushions', outside.map(o => o.id).join(','));

  /* A clear line from the cue to the apex ball: no other centre comes within
   * 2*BALL_R of that segment. */
  const apex = a.filter(o => o.id !== 0).reduce((best, o) => (o.x < best.x ? o : best), a[1]);
  const vx = apex.x - cue.x, vy = apex.y - cue.y, L2 = vx * vx + vy * vy;
  let segMin = Infinity, blocker = '';
  for (const o of a) {
    if (o.id === 0 || o === apex) continue;
    const s = Math.max(0, Math.min(1, ((o.x - cue.x) * vx + (o.y - cue.y) * vy) / L2));
    const d = Math.hypot(o.x - (cue.x + vx * s), o.y - (cue.y + vy * s));
    if (d < segMin) { segMin = d; blocker = String(o.id); }
  }
  t(segMin >= 2 * C.BALL_R, `the cue has an unblocked line to the apex ball (closest centre ${segMin.toFixed(4)} px, ball ${blocker})`, segMin);
  t(absClose(segMin, C.RACK_GAP, 1e-9), `the closest ball is exactly one RACK_GAP off that line (${C.RACK_GAP})`);

  /* Racks for several seeds keep the geometry identical: only the labels move. */
  const geom = list => JSON.stringify(list.filter(o => o.id !== 0).map(o => [Math.round(o.x * 1e9), Math.round(o.y * 1e9)]));
  t(geom(a) === geom(PL.rack(99)), 'the lattice is geometry: two seeds share every spot, only the ids shuffle');

  return out;
}

/* ---- 8. rules, through the real entry points ------------------------ */
function settleShot(PL, maxSeconds) {
  let st = PL.getState();
  let guard = 0;
  while (st.phase === 'rolling' && guard < 200) { st = PL.tick(0.25); guard++; }
  return st;
}

function guardScratch(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });

  PL.newGame({ seed: 1 });
  PL.start();
  PL.aimAt(0, 0);                       // the head-spot corner mouth
  PL.setPower(SPEC.MAX_SPEED);
  t(PL.shoot() === true, 'shoot() fires from the aiming phase');
  const st = PL.tick(14);
  const cue = st.balls.find(o => o.id === 0);
  const log = PL.log();

  t(st.fouls === 1, `a cue-ball pot is exactly one foul (fouls ${st.fouls})`);
  t(st.potted.length === 0 && st.potted.every(id => id !== 0), `the cue ball is NEVER counted as potted (${JSON.stringify(st.potted)})`);
  t(!!cue, 'the cue ball is back on the table');
  t(!!cue && absClose(cue.x, SPEC.CUE_START_X, 1e-9) && absClose(cue.y, SPEC.CUE_START_Y, 1e-9),
    `it is re-spotted on the head spot (${cue ? cue.x + ', ' + cue.y : 'missing'})`);
  t(!!cue && cue.vx === 0 && cue.vy === 0, 'the re-spotted cue ball is at rest');
  t(log.some(ev => ev.type === 'pot' && ev.a === 0), 'the log records the cue-ball pot');
  t(st.shots === 1, `one shot is charged (shots ${st.shots})`);
  t(st.phase === 'aiming', `the table returns to aiming (phase ${st.phase})`);
  t(st.score === PL.scoreOf({ potted: st.potted.length, shots: st.shots, fouls: st.fouls }),
    `score == scoreOf({potted,shots,fouls}) = ${st.score}`);

  /* respotSpot must respect occupancy: an empty table gives the head spot, an
   * occupied head spot does not. */
  const free = PL.respotSpot([]);
  t(free.x === SPEC.CUE_START_X && free.y === SPEC.CUE_START_Y,
    `respotSpot([]) is the head spot (${free.x}, ${free.y})`);
  const occupied = PL.respotSpot([{ id: 3, x: SPEC.CUE_START_X, y: SPEC.CUE_START_Y, r: SPEC.BALL_R }]);
  t(occupied.x !== SPEC.CUE_START_X || occupied.y !== SPEC.CUE_START_Y,
    `an occupied head spot pushes the cue ball aside (${occupied.x}, ${occupied.y})`);
  const clear = Math.hypot(occupied.x - SPEC.CUE_START_X, occupied.y - SPEC.CUE_START_Y) >= 2 * SPEC.BALL_R;
  t(clear, 'the substitute spot is at least one ball diameter from the occupant');
  t(occupied.x >= SPEC.BALL_R && occupied.x <= SPEC.TABLE_W - SPEC.BALL_R &&
    occupied.y >= SPEC.BALL_R && occupied.y <= SPEC.TABLE_H - SPEC.BALL_R,
    'the substitute spot is inside the cushions');
  t(PL.pockets().every(p => Math.hypot(occupied.x - p.x, occupied.y - p.y) > p.r + SPEC.BALL_R),
    'the substitute spot is clear of every pocket mouth');
  t(JSON.stringify(PL.respotSpot([{ id: 3, x: SPEC.CUE_START_X, y: SPEC.CUE_START_Y, r: SPEC.BALL_R }])) === JSON.stringify(occupied),
    'respotSpot is deterministic');

  /* Fouls only, never potted: shoot the cue into a corner twice more. */
  PL.aimAt(0, 0); PL.setPower(SPEC.MAX_SPEED); PL.shoot();
  const st2 = PL.tick(14);
  t(st2.fouls === 2 && st2.potted.length === 0 && st2.shots === 2,
    `a second scratch charges a second foul and no pot (fouls ${st2.fouls}, potted ${st2.potted.length})`);

  return out;
}

/* The early-8 path is not reachable from a single break (a full-power break pots
 * nothing for any seed tried), so the rule is driven the way a player would:
 * break first, then keep taking shots, alternating between aiming straight at
 * the 8 and aiming at the ghost point that sends it to its nearest mouth. */
function nearestPocket(PL, x, y) {
  let best = null, bd = Infinity;
  for (const p of PL.pockets()) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function ghostPoint(target, pocket) {
  const dx = pocket.x - target.x, dy = pocket.y - target.y, d = Math.hypot(dx, dy) || 1;
  return { x: target.x - dx / d * 2 * SPEC.BALL_R, y: target.y - dy / d * 2 * SPEC.BALL_R };
}

function guardEightEarly(PL, seed) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  seed = seed || 1;

  PL.newGame({ seed });
  PL.start();
  PL.aimAt(SPEC.RACK_APEX_X, SPEC.RACK_APEX_Y);
  PL.setPower(SPEC.MAX_SPEED);
  PL.shoot();
  let st = settleShot(PL);
  let shot = 1, hit = -1, hitState = null, hitLog = null;

  while (st.phase !== 'over' && shot < 120) {
    const eight = st.balls.find(o => o.id === 8);
    if (!eight) break;
    if (st.phase !== 'aiming') { st = settleShot(PL); continue; }
    const mouth = nearestPocket(PL, eight.x, eight.y);
    const aimPt = (shot % 2 === 1) ? { x: eight.x, y: eight.y } : ghostPoint(eight, mouth);
    PL.aimAt(aimPt.x, aimPt.y);
    PL.setPower(SPEC.MAX_SPEED);
    if (!PL.shoot()) break;
    shot++;
    st = settleShot(PL);
    const lg = PL.log();
    if (hit < 0 && lg.some(ev => ev.type === 'pot' && ev.a === 8)) { hit = shot; hitState = st; hitLog = lg; }
    if (hit > 0 && st.phase === 'aiming') break;
  }

  t(hit > 0, `the early-8 path is reachable from a real break (8 potted on shot ${hit} of seed ${seed})`, hit);
  if (hit > 0) {
    const s = hitState;
    t(hitLog.some(ev => ev.type === 'pot' && ev.a === 8), 'the log records type "pot" with a === 8');
    t(!s.potted.includes(8), `the 8 is NOT counted as potted (${JSON.stringify(s.potted)})`);
    t(!!s.balls.find(o => o.id === 8), 'the 8-ball is back on the table');
    t(s.fouls >= 1, `the early 8 charges at least one foul (fouls ${s.fouls})`);
    t(s.phase === 'aiming', `play continues with the 8 re-spotted (phase ${s.phase})`);
    const eight = s.balls.find(o => o.id === 8);
    if (eight) {
      const free = !s.balls.some(o => o.id !== 8 && Math.hypot(o.x - eight.x, o.y - eight.y) < 2 * SPEC.BALL_R - 1e-9);
      t(free, 'the re-spotted 8 does not overlap any other ball');
      t(eight.x >= SPEC.BALL_R && eight.x <= SPEC.TABLE_W - SPEC.BALL_R &&
        eight.y >= SPEC.BALL_R && eight.y <= SPEC.TABLE_H - SPEC.BALL_R, 'the re-spotted 8 is inside the cushions');
      t(eight.vx === 0 && eight.vy === 0, 'the re-spotted 8 is at rest');
    }
    t(s.potted.length <= 14, `the table was not otherwise clear when the 8 dropped (potted ${s.potted.length})`);
  }
  note(`early-8 probe used ${shot} shots on seed ${seed}`);
  return out;
}

function guardClear(PL) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });

  /* A deliberately simple bot: every shot aims at the ghost point that sends the
   * object ball with the clearest mouth line down, at full power. It is not
   * clever - it only has to finish. */
  function bestAim(st) {
    const cue = st.balls.find(o => o.id === 0);
    const objs = st.balls.filter(o => o.id !== 0);
    let pick = null, bestScore = -Infinity;
    for (const o of objs) {
      for (const p of PL.pockets()) {
        const g = ghostPoint(o, p);
        if (g.x < SPEC.BALL_R || g.x > SPEC.TABLE_W - SPEC.BALL_R ||
            g.y < SPEC.BALL_R || g.y > SPEC.TABLE_H - SPEC.BALL_R) continue;
        const dist = Math.hypot(p.x - o.x, p.y - o.y);
        let blocked = false;
        const vx = p.x - o.x, vy = p.y - o.y, L = Math.hypot(vx, vy) || 1;
        for (const other of st.balls) {
          if (other.id === o.id || other.id === 0) continue;
          const s = ((other.x - o.x) * vx + (other.y - o.y) * vy) / (L * L);
          if (s > 0.02 && s < 0.98) {
            const px = o.x + vx * s, py = o.y + vy * s;
            if (Math.hypot(other.x - px, other.y - py) < 2 * SPEC.BALL_R) { blocked = true; break; }
          }
        }
        const score = (blocked ? -1000 : 0) - dist;
        if (score > bestScore) { bestScore = score; pick = { o, g, blocked }; }
      }
    }
    if (!pick || !cue) return null;
    let aimPt = pick.g;
    if (Math.hypot(aimPt.x - cue.x, aimPt.y - cue.y) < 3) aimPt = { x: pick.o.x, y: pick.o.y };
    return aimPt;
  }

  PL.newGame({ seed: 1 });
  PL.start();
  PL.aimAt(SPEC.RACK_APEX_X, SPEC.RACK_APEX_Y);
  PL.setPower(SPEC.MAX_SPEED);
  PL.shoot();
  let st = settleShot(PL);
  let eightShot = -1, pottedBeforeEight = -1, shots = 1;

  while (st.phase === 'aiming' && shots < 200) {
    const aimPt = bestAim(st);
    if (!aimPt) break;
    const hadEight = !!st.balls.find(o => o.id === 8);
    const before = st.potted.length;
    PL.aimAt(aimPt.x, aimPt.y);
    PL.setPower(SPEC.MAX_SPEED);
    if (!PL.shoot()) break;
    shots++;
    st = settleShot(PL);
    if (hadEight && !st.balls.find(o => o.id === 8) && eightShot < 0) {
      eightShot = shots;
      pottedBeforeEight = before;
    }
  }

  note(`the bot cleared seed 1 in ${shots} shots (phase ${st.phase}, potted ${st.potted.length}, fouls ${st.fouls}, score ${st.score})`);
  t(st.phase === 'over', `the bot can actually clear the table through the real input path (phase ${st.phase} after ${shots} shots)`, st.phase);
  t(st.potted.length === 15 && st.remain === 0, `all fifteen object balls are credited (potted ${st.potted.length}, remain ${st.remain})`);
  t(!st.balls.find(o => o.id === 8), 'the 8 is off the table at the end');
  t(eightShot > 0 && pottedBeforeEight === 14,
    `the 8 only drops once the other fourteen are down (8 went on shot ${eightShot}, with ${pottedBeforeEight} already potted)`);
  t(st.shots > 0 && st.shots < 200, `the shot count is sane (${st.shots})`);
  t(st.over === true, 'getState().over agrees with phase === "over"');
  t(st.score === PL.scoreOf({ potted: st.potted.length, shots: st.shots, fouls: st.fouls }),
    `the final score is scoreOf(potted=${st.potted.length}, shots=${st.shots}, fouls=${st.fouls}) = ${st.score}`);

  return out;
}

/* `best` persistence needs the sandbox localStorage, so it gets its own guard
 * that takes the booted env (the store is the stub's). */
function guardBest(PL, store) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });
  const KEY = 'litegame_pool_best';

  const st = PL.getState();
  t(st.phase === 'over', `the previous clear left the game over (phase ${st.phase})`);
  t(st.best === st.shots, `best is the number of shots it took (best ${st.best}, shots ${st.shots})`, st.best);
  t(store[KEY] === String(st.shots), `best is written to localStorage['${KEY}'] = ${JSON.stringify(store[KEY])}`);
  const winner = st.shots;

  /* A new game reloads the record from storage instead of forgetting it. */
  PL.newGame({ seed: 2 });
  t(PL.getState().best === winner, `newGame() reloads best from storage (${PL.getState().best})`);

  /* best is the FEWEST shots: seed the record with a number no run of ours can
   * beat, then prove a long, ugly run leaves it alone. */
  store[KEY] = '3';
  PL.newGame({ seed: 3 });
  t(PL.getState().best === 3, `a stored record of 3 is loaded (${PL.getState().best})`);
  PL.start();
  for (let i = 0; i < 6; i++) {
    PL.aimAt(0, 0);                       // dead into the head-spot corner mouth
    PL.setPower(SPEC.MAX_SPEED);
    PL.shoot();
    settleShot(PL);
  }
  const after = PL.getState();
  t(after.shots === 6, `six scratch shots were taken (${after.shots})`);
  t(after.best === 3, `a run that is not better leaves the record alone (best ${after.best})`);
  t(store[KEY] === '3', `storage still holds 3 (${JSON.stringify(store[KEY])})`);
  t(after.phase === 'aiming' && after.fouls === 6, `the scratch loop charged six fouls and never ended the game (${after.fouls})`);

  return out;
}

/* ---- 9. bridge hygiene ---------------------------------------------- */
function guardBridge(PL, store) {
  const out = [];
  const t = (ok, label, extra) => out.push({ ok, label, extra });

  PL.newGame({ seed: 5 });
  const st = PL.getState();
  t(st.phase === 'ready' && st.shots === 0 && st.fouls === 0 && st.potted.length === 0 &&
    st.remain === 15 && st.score === 0, 'newGame() resets every counter');
  t(st.balls.length === 16, `newGame() lays out 16 balls (${st.balls.length})`);
  t(st.aim === 0 && st.power === 700, `newGame() resets aim to 0 and power to 700 (${st.aim}/${st.power})`);
  const storedBest = (store && store['litegame_pool_best']) ? parseInt(store['litegame_pool_best'], 10) : null;
  t(st.best === storedBest, `newGame() shows the best that is in storage (${JSON.stringify(st.best)})`);

  /* getState is a deep copy. */
  st.balls[0].x = -999;
  st.potted.push(99);
  st.balls.length = 0;
  const st2 = PL.getState();
  t(st2.balls.length === 16 && st2.balls[0].x !== -999 && st2.potted.length === 0,
    'getState() hands back a deep copy (mutating it cannot reach the live state)');

  /* hudCache mirrors the DOM strings. */
  const cache = PL.hudCache();
  t(cache && cache.score === '0' && cache.remain === '15' && cache.shots === '0' && cache.fouls === '0' && cache.potted === '0',
    `hudCache() holds the painted strings (${JSON.stringify(cache)})`);

  /* The log is a bounded ring, and it is a copy. */
  PL.start();
  for (let i = 0; i < 30; i++) {
    PL.aimAt(0, 0); PL.setPower(SPEC.MIN_SPEED); PL.shoot(); settleShot(PL);
  }
  const log = PL.log();
  t(log.length <= SPEC.LOG_SIZE, `the event log is capped at LOG_SIZE = ${SPEC.LOG_SIZE} (${log.length})`);
  t(log.every(ev => typeof ev.t === 'number' && typeof ev.type === 'string'), 'every log entry has a time and a type');
  log.length = 0;
  t(PL.log().length > 0, 'log() hands back a copy (clearing it cannot empty the ring)');

  /* Phase machine. */
  PL.newGame({ seed: 1 });
  t(PL.getState().phase === 'ready', 'a new game is in ready');
  t(PL.shoot() === false, 'shoot() is refused while ready');
  PL.start();
  t(PL.getState().phase === 'aiming', 'start() moves ready -> aiming');
  PL.start();
  t(PL.getState().phase === 'aiming', 'a second start() is a no-op');
  PL.pause();
  t(PL.getState().paused === true, 'pause() parks the game');
  t(PL.shoot() === false, 'shoot() is refused while paused');
  PL.resume();
  t(PL.getState().paused === false, 'resume() unpauses');
  PL.togglePause();
  t(PL.getState().paused === true, 'togglePause() flips it');
  PL.togglePause();
  t(PL.getState().paused === false, 'togglePause() flips it back');

  /* rotateAim / aimAt. */
  PL.newGame({ seed: 1 }); PL.start();
  PL.rotateAim(SPEC.AIM_STEP);
  t(absClose(PL.getState().aim, SPEC.AIM_STEP, 1e-12), `rotateAim(+AIM_STEP) adds ${SPEC.AIM_STEP} rad`, PL.getState().aim);
  PL.rotateAim(-SPEC.AIM_STEP);
  t(absClose(PL.getState().aim, 0, 1e-12), 'rotateAim(-AIM_STEP) undoes it');
  const cue = PL.getState().balls.find(o => o.id === 0);
  PL.aimAt(cue.x + 100, cue.y);
  t(absClose(PL.getState().aim, 0, 1e-12), 'aimAt a point straight right gives aim 0');
  PL.aimAt(cue.x, cue.y + 100);
  t(absClose(PL.getState().aim, Math.PI / 2, 1e-12), 'aimAt a point straight down gives aim +pi/2');
  PL.aimAt(cue.x, cue.y);
  t(absClose(PL.getState().aim, Math.PI / 2, 1e-12), 'aimAt the cue ball itself is a no-op');

  /* tick() returns the same shape as getState(). */
  const tickState = PL.tick(0.01);
  t(tickState && typeof tickState.phase === 'string' && Array.isArray(tickState.balls),
    'tick() returns the state object');

  return out;
}

/* ==========================================================================
 * Suite
 * ======================================================================== */

function suite(html, booted) {
  const PL = booted.PL;

  group('1. static gates the stub DOM cannot see');
  guardStatic(html, booted).forEach(r => check(r.ok, r.label, r.extra));

  group('2. constants contract and the closed forms');
  guardConstants(PL).forEach(r => check(r.ok, r.label, r.extra));

  group('3. advance() is a pure function');
  guardPurity(PL).forEach(r => check(r.ok, r.label, r.extra));

  group('4. step invariance: the fixed grid is really fixed');
  guardStep(PL).forEach(r => check(r.ok, r.label, r.extra));

  group('5. collision semantics: differential + closed-form splits');
  guardCollision(PL).forEach(r => check(r.ok, r.label, r.extra));

  group('6. cushions: reverse, scale by 0.86, never add energy');
  guardWall(PL).forEach(r => check(r.ok, r.label, r.extra));

  group('7. invariants over a real break (8 seeds x 300 ticks)');
  guardInvariants(PL).forEach(r => check(r.ok, r.label, r.extra));

  group('8. the rack is a proven lattice, not a random pile');
  guardRack(PL).forEach(r => check(r.ok, r.label, r.extra));

  group('9. rules through the real entry points');
  guardScratch(PL).forEach(r => check(r.ok, r.label, r.extra));
  guardEightEarly(PL, 1).forEach(r => check(r.ok, r.label, r.extra));
  guardClear(PL).forEach(r => check(r.ok, r.label, r.extra));
  guardBest(PL, booted.store).forEach(r => check(r.ok, r.label, r.extra));

  group('10. bridge hygiene: deep copies, the log ring, the phase machine');
  guardBridge(PL, booted.store).forEach(r => check(r.ok, r.label, r.extra));
}

/* ==========================================================================
 * --selftest: every injected defect must turn its guard red
 * ======================================================================== */

const MUTATIONS = [
  {
    name: 'the de-overlap push is removed (overlapping balls are never separated)',
    from: '        var push = (lim - d) / 2;\n        a.x -= nx * push;\n        a.y -= ny * push;\n        c.x += nx * push;\n        c.y += ny * push;',
    to: '        var push = 0;',
    guard: 'collision',
    why: 'the differential reference separates the pair; the engine must stop matching it'
  },
  {
    name: 'the impulse ignores the restitution (a perfectly inelastic hit)',
    from: 'var imp = -(1 + BALL_RESTITUTION) * vn / 2;',
    to: 'var imp = -(1 + 0) * vn / 2;',
    guard: 'collision',
    why: 'the (1+e)/2 : (1-e)/2 split and the reference both demand e = 0.96'
  },
  {
    name: 'the cell length is re-derived from the submitted slice (a variable grid)',
    from: '    for (i = 0; i < full; i++) {\n      t += PHYS_H;\n      substep(list, PHYS_H, t, events);\n    }',
    to: '    var _cell = total / (full || 1);\n    for (i = 0; i < full; i++) {\n      t += _cell;\n      substep(list, _cell, t, events);\n    }',
    guard: 'step',
    why: 'one coarse call must equal the equivalent sequence of 1/240 cells'
  },
  {
    name: 'the left cushion no longer reverses the normal velocity',
    from: '        if (b.vx < 0) {\n          b.vx = -b.vx * WALL_RESTITUTION;',
    to: '        if (b.vx < 0) {\n          b.vx = b.vx * WALL_RESTITUTION;',
    guard: 'wall',
    why: 'the outgoing normal must point away from the cushion'
  },
  {
    name: 'a potted ball stays in the array (the pot event is emitted but the ball is kept)',
    from: '      if (sunk) {\n        events.push({ t: tEnd, type: \'pot\', a: b.id, b: null, x: sunk.x, y: sunk.y });\n      } else {',
    to: '      if (sunk) {\n        events.push({ t: tEnd, type: \'pot\', a: b.id, b: null, x: sunk.x, y: sunk.y });\n        keep.push(b);\n      } else {',
    guard: 'collision',
    why: 'the pot test asserts the returned array no longer holds the ball'
  },
  {
    name: 'the 8-ball falls through to the generic branch and is counted as potted',
    from: '      } else if (ev.a === 8) {\n        eightDown = true;',
    to: '      } else if (false) {\n        eightDown = true;',
    guard: 'eight',
    why: 'an early 8 must be a foul and must never enter pottedIds'
  },
  {
    name: 'a HUD node is written outside updateHud() (the value cache can drift from the DOM)',
    from: '  function refresh() {\n    updateHud();',
    to: '  function refresh() {\n    scoreEl.textContent = scoreNow();\n    updateHud();',
    guard: 'static',
    why: 'every HUD write must go through the cached updateHud()'
  },
  {
    name: 'scoreOf no longer floors the score at zero',
    from: '  return raw > 0 ? raw : 0;',
    to: '  return raw;',
    guard: 'constants',
    why: 'scoreOf({potted:0, shots:100, fouls:10}) must be 0'
  },
  {
    name: 'the rack shuffle is replaced by the identity permutation',
    from: '      var j = Math.floor(rng() * (k + 1));',
    to: '      var j = k;',
    guard: 'rack',
    why: 'a different seed must give a different rack'
  },
  {
    name: 'respotSpot ignores the occupancy test and always returns the head spot',
    from: '          if (spotFree(x, y, list)) return { x: x, y: y };',
    to: '          if (ring >= 0) return { x: x, y: y };',
    guard: 'scratch',
    why: 'the plan says the cue is re-spotted at the first FREE spot of the ring search'
  }
];

const GUARDS = {
  constants: guardConstants,
  purity: guardPurity,
  step: guardStep,
  collision: guardCollision,
  wall: guardWall,
  invariants: guardInvariants,
  rack: guardRack,
  scratch: guardScratch,
  eight: (PL) => guardEightEarly(PL, 1)
};

function selectGuard(PL, name) { return GUARDS[name](PL); }

function selfTest() {
  const html = fs.readFileSync(GAME, 'utf8');
  const frozenSha = sha256(fs.readFileSync(GAME));
  console.log(`\n[selftest] baseline: the UNMODIFIED page must be green`);
  console.log(`  ·    the page on disk is a FROZEN COPY: sha256 ${frozenSha.slice(0, 16)} (every defect is spliced in memory)`);
  const baseBoot = boot(html);
  const baseStatic = guardStatic(html, baseBoot);
  const baseClean = baseStatic.every(r => r.ok);
  console.log(`  ${baseClean ? 'ok  ' : 'FAIL'} the source-level gates are green on the shipped page`);
  if (!baseClean) baseStatic.filter(r => !r.ok).forEach(r => console.log(`       FAIL ${r.label} [${r.extra}]`));

  let caught = 0, missed = 0;
  console.log(`\n[selftest] ${MUTATIONS.length} injected defects, each must turn its own guard RED`);
  for (const mu of MUTATIONS) {
    const patched = html.split(mu.from).join(mu.to);
    if (patched === html) {
      missed++;
      console.log(`  FAIL ${mu.name}\n       the splice target was not found: ${JSON.stringify(mu.from).slice(0, 120)}`);
      continue;
    }
    let result;
    try {
      const b = boot(patched);
      result = (mu.guard === 'static') ? guardStatic(patched, b) : selectGuard(b.PL, mu.guard);
    } catch (e) {
      /* A defect that throws is still caught - record the reason. */
      result = [{ ok: false, label: `the guard threw: ${e && e.message}` }];
    }
    const red = result.filter(r => !r.ok);
    const ok = red.length > 0;
    if (ok) caught++; else missed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${mu.name} -> ${ok ? `RED (${red.length}/${result.length} checks failed first: "${red[0].label}")` : 'STAYED GREEN'}  [${mu.why}]`);
  }

  /* Nothing was ever written, so the page must hash identically after the run. */
  const afterSha = sha256(fs.readFileSync(GAME));
  const untouched = afterSha === frozenSha;
  console.log(`\n  ${untouched ? 'ok  ' : 'FAIL'} the page on disk is byte-identical after the run (sha256 ${afterSha.slice(0, 16)})`);

  const passN = (baseClean ? 1 : 0) + caught + (untouched ? 1 : 0);
  const failN = (baseClean ? 0 : 1) + missed + (untouched ? 0 : 1);
  console.log(`\n[selftest] ${passN} passed, ${failN} failed  (${caught}/${MUTATIONS.length} injected defects caught)`);
  return failN;
}

/* ==========================================================================
 * main
 * ======================================================================== */

(() => {
  if (!fs.existsSync(GAME)) {
    console.log(`HARNESS ERROR: no page at ${GAME}`);
    process.exit(1);
  }
  const html = fs.readFileSync(GAME, 'utf8');
  const buf = fs.readFileSync(GAME);
  console.log(`pool-test: ${path.relative(ROOT, GAME) || GAME}`);
  console.log(`  bytes ${buf.length}  lines ${(html.match(/\n/g) || []).length}  sha256 ${sha256(buf).slice(0, 16)}`);
  note(`assets/i18n.js: ${path.relative(ROOT, I18N)}`);

  if (SELFTEST) { process.exit(selfTest() ? 1 : 0); }

  const booted = boot(html);
  if (!booted.PL) {
    console.log('\nHARNESS ERROR: the page did not expose window.PL');
    process.exit(1);
  }
  suite(html, booted);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
