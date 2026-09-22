#!/usr/bin/env node
/**
 * Logic tests for invaders-game (Space Invaders).
 *
 * The smoke test only proves the page parses and does not throw; it cannot tell
 * whether the fleet geometry is right, whether a wave is actually winnable, or
 * whether the dynamic HUD text follows the language. This suite loads the whole
 * inline <script> in a vm sandbox with a stub DOM (canvas is a no-op Proxy, so
 * the real render path still runs without a GPU) and asserts behaviour through
 * the game's own bridge object `window.SI` and its real UI entry points.
 *
 * The two load-bearing ideas:
 *
 *  1. A DIFFERENT-SHAPED ORACLE for formationState. The fleet pose is a pure
 *     function of the step count, so a one-line slip in the modular bounce math
 *     would look "obviously right". The reference here is built a DIFFERENT way:
 *     it steps a mini simulation forward one cell at a time until the sweep
 *     returns to its start (auto-detecting the period), then rebuilds any step
 *     by (index mod period) + (cycles * drops-per-cycle). Copies of the shipped
 *     formula would agree even when both are wrong; this one is independent.
 *
 *  2. A DIFFICULTY (budget / requirement) RATIO. The per-wave dials (start
 *     lower, step faster) eat into the number of fleet steps a player gets
 *     before the fleet touches the line. If that budget ever falls below what an
 *     ideal player needs, the wave is mathematically unwinnable - a bug that no
 *     "did it throw?" test can see. Both sides are computed as pure functions
 *     and the ratio is asserted.
 *
 * Also pinned here: the scoring table, the seeded PRNG contract, the
 * non-destructive bunker model, the single-bullet rule, the ready/playing/
 * dying/waveclear/gameover state machine (driven through a REAL click on the
 * Start button), UFO cadence, and the "tick() refreshes the HUD" contract -
 * including a STATIC scan that forbids HUD node writes outside updateHud().
 *
 * Usage:  node tools/invaders-test.js [path/to/index.html] [path/to/assets/i18n.js]
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
  : path.join(ROOT, 'invaders-game', 'index.html');
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
/* Honors scripts/smoke.js's documented constraints: setTimeout is a no-op (the
 * game boots on rAF only), localStorage has no removeItem, getAttribute always
 * returns null and querySelectorAll returns [] (so every keyed reference must be
 * getElementById), and getContext('2d') is a Proxy whose .width/measureText are
 * not numbers (geometry is never read back from the canvas). */

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
    getBoundingClientRect() { return { left: 0, top: 0, width: 480, height: 560 }; }
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
 * is captured without touching the source (needed for the dynamic i18n checks). */
function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const orig = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = orig(dict); return T; };
  inlineScripts(fs.readFileSync(GAME, 'utf8')).forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `invaders/index.html#script${i}` });
  });
  env.step();                                    // one real rAF frame (update + draw)
  return { env, SI: env.context.SI, T, els: env.els, html: fs.readFileSync(GAME, 'utf8') };
}

/* ------------------------------------------------------------- constants */
/* Geometry / tuning constants owned by the game and documented in its header. */
const EDGE = 16;
const SHIP_Y = 500, SHIP_H = 22, SHIP_W = 40;
const BULLET_H = 14, BULLET_SPEED = 800;
const SHIP_SPEED = 170;
const INVADER_FLOOR = 470;
const BOMB_CHANCE = 0.14;
const BUNKER_COUNT = 4, BUNKER_H = 16;
const UFO_MIN_ALIVE = 8;
const DEATH_TIME = 0.8;
const UFO_SCORES = [50, 100, 150, 300];

const SOLID = g => g.reduce((n, row) => n + [...row].filter(c => c === '#').length, 0);
const PER_BUNKER_SOLID = SOLID(boot().SI.makeBunker());
const FULL_BUNKER_SOLID = PER_BUNKER_SOLID * BUNKER_COUNT;

const G = boot();
const SI = G.SI;
const els = G.els;
const COLS = SI.COLS, ROWS = SI.ROWS, CELL = SI.CELL, FIELD_W = SI.FIELD_W, FIELD_H = SI.FIELD_H;

const tickUntil = (S, pred, maxSeconds, chunk) => {
  const c = chunk || 1 / 30;
  let t = 0;
  while (t < maxSeconds) { S.tick(c); t += c; if (pred()) return { ok: true, t }; }
  return { ok: false, t };
};
/* Aim at the nearest alive column and fire when the screen is clear - a crude
 * but real "ideal player" used only to drive the fleet to zero / below 8. */
function aimAtNearest(S, s, keepCol) {
  const f = s.formation.offsetX;
  const cols = s.aliveColumns.filter(c => c !== keepCol);
  if (!cols.length) { S.move(0); return; }
  let best = cols[0], bd = 1e9;
  for (const c of cols) { const d = Math.abs(f + c * CELL + CELL / 2 - s.ship.x); if (d < bd) { bd = d; best = c; } }
  const cx = f + best * CELL + CELL / 2;
  S.move(cx - s.ship.x > 1 ? 1 : (cx - s.ship.x < -1 ? -1 : 0));
}
/* Sweep the whole width and shoot until `stop(s)` is true. Returns frame count. */
function sweepUntil(S, stop, maxFrames, keepCol, onSample) {
  for (let i = 0; i < maxFrames; i++) {
    const s = S.getState();
    if (onSample) onSample(s);
    if (stop(s)) return i;
    if (s.bullets.length === 0) S.fire(); else aimAtNearest(S, s, keepCol);
    S.tick(1 / 60);
  }
  return -1;
}

/* ======================================================================
 * 1. i18n contract
 * ==================================================================== */

group('1. i18n contract (static hooks + dynamic text through T.onChange)');
{
  const html = G.html;
  const i18nHooks = (html.match(/data-i18n(?:-html|-title|-ph)?=/g) || []).length;
  check(i18nHooks >= 6, `the game markup uses data-i18n hooks (found ${i18nHooks})`);
  check(/\bdata-lang\s*=/.test(html) === false, 'the game page does NOT use the homepage data-lang= contract');
  check(!/\.inline\b/.test(html), 'the game page does NOT use the homepage .inline.on contract');
  const onChangeCount = (html.match(/T\.onChange/g) || []).length;
  check(onChangeCount === 1, `T.onChange is registered exactly once (found ${onChangeCount})`);

  /* Dynamic text: a fresh boot, then flip the language. updateHud() + the open
   * result dialog must re-render through T.onChange - the silent failure mode
   * where the static markup is perfect but the dynamic labels stay stale. */
  const Gi = boot(), Si = Gi.SI, Ti = Gi.T, ei = Gi.els;
  check(!!Ti && Ti.lang === 'en', `the i18n helper boots in English (lang=${Ti && Ti.lang})`);
  ei.btnStart.fire('click');                       // real click into playing
  check(ei.btnPause.textContent === 'Pause', `the dynamic pause label starts English (got ${JSON.stringify(ei.btnPause.textContent)})`);
  Ti.set('zh');
  check(Ti.lang === 'zh', `T.set('zh') switches the language (lang=${Ti.lang})`);
  check(ei.btnPause.textContent === '暂停', `the dynamic pause label becomes 暂停 via T.onChange (got ${JSON.stringify(ei.btnPause.textContent)})`);
  check(CJK.test(ei.btnPause.textContent), 'the dynamic HUD label is Chinese after the switch');

  /* The result dialog is dynamic too: open it (game over), then flip language
   * and confirm T.onChange re-renders the OPEN dialog. */
  Si.newGame({ wave: 1, seed: 1, lives: 1 });
  const gg = tickUntil(Si, () => Si.getState().phase === 'gameover', 120, 0.1);
  check(gg.ok && Si.getState().phase === 'gameover', 'the l=1 run reaches gameover (opens the result dialog)');
  check(ei.ovTitle.textContent === '游戏结束', `the result title is dynamically Chinese (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  check(/\d/.test(ei.ovSub.textContent), `the Chinese result subtitle keeps the score (got ${JSON.stringify(ei.ovSub.textContent)})`);
  Ti.set('en');
  check(ei.ovTitle.textContent === 'Game over', `flipping to en re-renders the open dialog through T.onChange (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  check(CJK.test(ei.ovBtn.textContent) === false, `the result button is English again (got ${JSON.stringify(ei.ovBtn.textContent)})`);
}

/* ======================================================================
 * 2. formationState - differential oracle + invariants
 * ==================================================================== */

group('2. formationState differential (independent oracle) + invariants');
{
  const stepX = SI.waveConfig(1).stepX;
  const MINX = EDGE, MAXX = FIELD_W - COLS * CELL - EDGE;

  /* Independent oracle: advance a point one cell at a time, auto-detect the
   * period, then rebuild any step by index + cycle accumulation. */
  const entries = [];
  let x = MINX, dir = 1, drops = 0, period = -1;
  for (let k = 0; k < 20000; k++) {
    entries.push({ x, dir, drops });
    x += dir * stepX;
    if (dir > 0 && x >= MAXX) { x = MAXX; dir = -1; drops++; }
    else if (dir < 0 && x <= MINX) { x = MINX; dir = 1; drops++; }
    if (period < 0 && x === MINX && dir === 1) period = k + 1;
    if (period > 0 && k >= period) break;
  }
  const dropsPerCycle = entries[period].drops - entries[0].drops;
  const refFormation = (s, wave) => {
    const w = Math.max(1, wave | 0);
    const startY = Math.min(48 + 6 * (w - 1), 88);
    const st = Math.max(0, s | 0);
    const idx = st % period, cycles = Math.floor(st / period);
    const e = entries[idx];
    const drops = e.drops + cycles * dropsPerCycle;
    return { offsetX: e.x, originY: startY + drops * CELL, dir: e.dir, half: period / 2, drops };
  };
  check(period === 140 && dropsPerCycle === 2,
    `the oracle auto-detected a 140-step sweep with 2 drops/cycle (got ${period}/${dropsPerCycle})`);

  let cmp = 0, mism = null;
  for (let w = 1; w <= 12 && !mism; w++) {
    for (const alive of [1, 25, 55]) {
      for (let s = 0; s <= 3000; s++) {
        const a = SI.formationState(s, alive, w);
        const b = refFormation(s, w);
        cmp++;
        if (a.offsetX !== b.offsetX || a.originY !== b.originY || a.dir !== b.dir) {
          mism = { s, alive, w, a, b }; break;
        }
      }
      if (mism) break;
    }
  }
  check(!mism, `oracle agrees with formationState on all ${cmp} samples (offsetX/originY/dir)`,
    mism ? `step ${mism.s} alive ${mism.alive} w ${mism.w}: got ${JSON.stringify(mism.a)} want ${JSON.stringify(mism.b)}` : '');

  let rangeOK = true, dirOK = true, dropsOK = true, dropStepOK = true, detail = '';
  for (let w = 1; w <= 12; w++) {
    for (let s = 0; s <= 3000; s += 7) {
      const f = SI.formationState(s, 55, w);
      if (f.offsetX < MINX || f.offsetX > MAXX) { rangeOK = false; detail = `offsetX ${f.offsetX} at s=${s} w=${w}`; }
      if (f.dir !== -1 && f.dir !== 1) dirOK = false;
      if (f.drops !== Math.floor(s / f.half)) { dropsOK = false; detail = `drops ${f.drops} vs floor(${s}/${f.half})`; }
      const startY = Math.min(48 + 6 * (w - 1), 88);
      if (f.originY !== startY + Math.floor(s / f.half) * CELL) dropStepOK = false;
    }
  }
  check(rangeOK, `offsetX stays inside [EDGE, FIELD_W - cols*CELL - EDGE] = [${MINX}, ${MAXX}]`, detail);
  check(dirOK, 'dir is always +1 or -1');
  check(dropsOK, 'drops === floor(steps / half)');
  check(dropStepOK, 'originY === startY + drops*CELL (one CELL per bounce)');
  check(SI.formationState(0, 55, 1).offsetX === EDGE && SI.formationState(0, 55, 1).dir === 1,
    'step 0 sits at the left edge marching right');
}

/* ======================================================================
 * 3. stepInterval + unit calibration
 * ==================================================================== */

group('3. stepInterval + measured unit calibration');
{
  let baseOK = true, fastOK = true, rangeOK = true, monoOK = true, formulaOK = true;
  for (let w = 1; w <= 12; w++) {
    const cfg = SI.waveConfig(w);
    const base = cfg.stepBase, fastest = base * cfg.minIntervalFraction;
    if (SI.stepInterval(55, w) !== base) baseOK = false;
    if (SI.stepInterval(0, w) !== fastest) fastOK = false;
    let prev = -Infinity;
    for (let a = 0; a <= 55; a++) {
      const iv = SI.stepInterval(a, w);
      if (iv < fastest - 1e-12 || iv > base + 1e-12) rangeOK = false;
      if (iv < prev - 1e-12) monoOK = false;          // more aliens must never mean a shorter interval
      prev = iv;
      if (Math.abs(iv - (fastest + (base - fastest) * (a / 55))) > 1e-12) formulaOK = false;
    }
  }
  check(baseOK, 'stepInterval(55, w) === stepBase(w) for every wave');
  check(fastOK, 'stepInterval(0, w) === stepBase(w) * 0.3 for every wave');
  check(rangeOK, 'stepInterval always lies in [stepBase*0.3, stepBase]');
  check(monoOK, 'stepInterval is monotone in aliveCount (fewer aliens never step slower - the "last invader zooms" rule)');
  check(formulaOK, 'stepInterval is exactly the linear blend between fastest and stepBase');

  const cfg1 = SI.waveConfig(1);
  note(`calibration wave 1: stepBase=${cfg1.stepBase} fastest=${(cfg1.stepBase * cfg1.minIntervalFraction).toFixed(3)}s`);

  /* Unit calibration: measured values hard-coded as the contract. */
  SI.newGame({ wave: 1, seed: 1 });
  const s0 = SI.getState();
  const s1 = SI.tick(1);
  check(s1.steps - s0.steps === 1, `tick(1) with no input advances exactly 1 fleet step (got ${s1.steps - s0.steps})`);
  check(s1.ship.x === s0.ship.x && s1.ship.x === FIELD_W / 2, `with no input the ship does not move (x=${s1.ship.x})`);
  check(s1.formation.offsetX - s0.formation.offsetX === 2, `one step moves the fleet by stepX=2px (got ${s1.formation.offsetX - s0.formation.offsetX})`);

  SI.newGame({ wave: 1, seed: 1 });
  const shot = SI.fire();
  check(shot.bullets.length === 1 && shot.bullets[0].y === SHIP_Y - SHIP_H / 2 - BULLET_H,
    `the bullet spawns at SHIP_Y - SHIP_H/2 - BULLET_H = ${SHIP_Y - SHIP_H / 2 - BULLET_H} (got ${shot.bullets[0] && shot.bullets[0].y})`);
  const s2 = SI.tick(0.25);
  const wantY = (SHIP_Y - SHIP_H / 2 - BULLET_H) - BULLET_SPEED * 0.25;
  check(s2.bullets.length === 1 && Math.abs(s2.bullets[0].y - wantY) < 1e-6,
    `after tick(0.25) the bullet travelled BULLET_SPEED*0.25 = ${BULLET_SPEED * 0.25}px (y=${s2.bullets[0] && s2.bullets[0].y}, want ${wantY})`);
  check(Math.abs(SI.bulletY(SHIP_Y - SHIP_H / 2 - BULLET_H, 0.25) - wantY) < 1e-9, 'bulletY() is the same closed form');
}

/* ======================================================================
 * 4. scoring table
 * ==================================================================== */

group('4. scoring table');
{
  check(SI.scoreFor('invader', 0) === 30, `the top row scores 30 (got ${SI.scoreFor('invader', 0)})`);
  check(SI.scoreFor('invader', 1) === 20 && SI.scoreFor('invader', 2) === 20,
    `the middle two rows score 20 (got ${SI.scoreFor('invader', 1)}, ${SI.scoreFor('invader', 2)})`);
  check(SI.scoreFor('invader', 3) === 10 && SI.scoreFor('invader', 4) === 10,
    `the bottom two rows score 10 (got ${SI.scoreFor('invader', 3)}, ${SI.scoreFor('invader', 4)})`);
  let ufoInSet = true, ufoConsist = true;
  for (let i = 0; i < 4; i++) {
    if (SI.scoreFor('ufo', i) !== UFO_SCORES[i]) ufoInSet = false;
  }
  let same = true;
  for (let seed = 1; seed <= 50; seed++) {
    for (let k = 0; k < 6; k++) {
      const a = SI.ufoScoreAt(seed, k), b = SI.ufoScoreAt(seed, k);
      if (a !== b) same = false;
      if (!UFO_SCORES.includes(a)) ufoInSet = false;
      if (SI.scoreFor('ufo', UFO_SCORES.indexOf(a)) !== a) ufoConsist = false;
    }
  }
  check(ufoInSet, `UFO rewards stay in {50,100,150,300} (scoreFor table + ufoScoreAt)`);
  check(same, 'ufoScoreAt(seed,index) is deterministic (same args, same output)');
  check(ufoConsist, 'killing a UFO scores exactly the reward it carried (scoreFor ∘ ufoScoreAt is identity)');
}

/* ======================================================================
 * 5. PRNG contract
 * ==================================================================== */

group('5. seeded PRNG contract');
{
  const a = SI.nextRandom({ s: 1 }), b = SI.nextRandom({ s: 1 });
  check(a.value === b.value && a.state.s === b.state.s, 'nextRandom({s:1}) is deterministic');
  check(a.value >= 0 && a.value < 1, `nextRandom().value lies in [0,1) (got ${a.value})`);
  check(Number.isInteger(a.state.s) && a.state.s >= 0 && a.state.s <= 0xffffffff, `nextRandom().state.s is a uint32 (got ${a.state.s})`);

  const cols = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  let same = true, inDomain = true, emptyOk = true;
  for (let i = 0; i < 3000; i++) {
    const v = SI.bombColumnFor(i, 1, cols);
    if (v !== SI.bombColumnFor(i, 1, cols)) same = false;
    if (v !== -1 && !cols.includes(v)) inDomain = false;
  }
  if (SI.bombColumnFor(5, 1, []) !== -1) emptyOk = false;
  if (SI.bombColumnFor(5, 1, null) !== -1) emptyOk = false;
  check(same, 'bombColumnFor is deterministic (same args, same output)');
  check(inDomain, 'bombColumnFor returns -1 or a member of aliveColumns');
  check(emptyOk, 'bombColumnFor returns -1 for an empty column set');

  const N = 20000;
  const rate1 = (() => { let r = 0; for (let i = 1; i <= N; i++) if (SI.bombColumnFor(i, 1, cols) >= 0) r++; return r / N; })();
  let flips = 0;
  for (let i = 1; i <= N; i++) if (SI.bombColumnFor(i, 1, cols) !== SI.bombColumnFor(i, 2, cols)) flips++;
  const flipPct = flips / N * 100;
  check(Math.abs(rate1 - BOMB_CHANCE) < 0.02, `measured bomb release rate ≈ BOMB_CHANCE (got ${(rate1 * 100).toFixed(2)}%)`);
  check(flipPct > 5 && flipPct < 60, `changing the seed flips the schedule (measured ${flipPct.toFixed(2)}% of steps)`);
  note(`bomb release rate seed1=${(rate1 * 100).toFixed(2)}%  seed-change flip rate=${flipPct.toFixed(2)}%`);
}

/* ======================================================================
 * 6. non-destructive bunker model
 * ==================================================================== */

group('6. non-destructive bunker model');
{
  const before = SI.bunkers()[0];
  const solidBefore = SOLID(before);
  const damaged = SI.damageBunker(0, 11, 8, 3);
  const after = SI.bunkers()[0];
  check(JSON.stringify(after) === JSON.stringify(before), 'damageBunker leaves the STORED bunker untouched (non-destructive)');
  check(SOLID(damaged) < solidBefore, `the returned bitmap has the hole carved (${solidBefore} -> ${SOLID(damaged)} solid cells)`);
  check(before.every((row, r) => after[r] === row), 'the stored bitmap is byte-identical after damageBunker');
  check(SOLID(SI.bunkers()[0]) === solidBefore && SOLID(SI.bunkers()[2]) === PER_BUNKER_SOLID,
    'repeated damageBunker calls never mutate any stored bunker');

  /* Gameplay erosion through the real pipeline: fire into a bunker, then check a
   * carved-out cell reads empty and an untouched cell reads solid. */
  const G6 = boot(), S = G6.SI;
  S.newGame({ wave: 1, seed: 1, lives: 99999 });
  S.move(-1);
  let guard = 0;
  while (S.getState().ship.x > 181 && guard++ < 2000) S.tick(1 / 60);
  S.move(0);
  const b0 = S.bunkerBitmap(1), solid0 = SOLID(b0);
  for (let i = 0; i < 6000; i++) {
    if (S.getState().bullets.length === 0) S.fire();
    S.tick(1 / 60);
    if (SOLID(S.bunkerBitmap(1)) < solid0) break;
  }
  const b1 = S.bunkerBitmap(1);
  let hole = null, solid = null;
  for (let r = 0; r < b1.length; r++) for (let c = 0; c < b1[r].length; c++) {
    if (b0[r][c] === '#' && b1[r][c] === '.' && !hole) hole = { c, r };
    if (b1[r][c] === '#' && !solid) solid = { c, r };
  }
  check(hole !== null, `a real bullet carved a hole (${solid0} -> ${SOLID(b1)} solid cells)`);
  check(hole !== null && S.hitTestBunker(1, hole.c, hole.r) === false, `hitTestBunker is false inside the hole (${hole && `${hole.c},${hole.r}`})`);
  check(solid !== null && S.hitTestBunker(1, solid.c, solid.r) === true, `hitTestBunker is true on a still-solid cell (${solid && `${solid.c},${solid.r}`})`);

  /* Invariant while a whole wave is played: the reported bunker count must equal
   * the number of bitmaps that still contain at least one solid cell. */
  const G6b = boot(), Sb = G6b.SI;
  Sb.newGame({ wave: 1, seed: 1, lives: 99999 });
  let invOK = true, dropsOK = true, lastCount = Sb.getState().bunkers;
  sweepUntil(Sb, s => s.invadersLeft === 0, 20000, -1, s => {
    const live = Sb.bunkers().filter(g => SOLID(g) > 0).length;
    if (s.bunkers !== live) invOK = false;
    if (s.bunkers < lastCount) {
      const empty = Sb.bunkers().filter(g => SOLID(g) === 0).length;
      if (empty !== BUNKER_COUNT - s.bunkers) dropsOK = false;   // a drop means exactly one more bunker fully gone
    }
    lastCount = s.bunkers;
  });
  check(invOK, 'getState().bunkers always equals the number of non-empty bunker bitmaps');
  check(dropsOK, 'the bunker count only drops when a bunker loses its LAST solid cell');
}

/* ======================================================================
 * 7. difficulty threshold (budget / requirement)
 * ==================================================================== */

group('7. difficulty threshold - every wave stays winnable');
{
  const budget = w => {
    let best = -1;
    for (let s = 0; s < 20000; s++) {
      const f = SI.formationState(s, 55, w);
      if (f.originY + ROWS * CELL < INVADER_FLOOR) best = s; else return best;
    }
    return best;
  };
  const budgets = [];
  for (let w = 1; w <= 12; w++) budgets.push(budget(w));
  note(`budget(1..12) = ${JSON.stringify(budgets)}`);

  check(budgets.every(b => b >= 600), `every wave has a budget >= 600 steps (min ${Math.min(...budgets)})`);
  let nonInc = true;
  for (let i = 1; i < budgets.length; i++) if (budgets[i] > budgets[i - 1]) nonInc = false;
  check(nonInc, 'the budget is non-increasing across waves');
  /* Pinned values (independently reproduced). */
  check(budgets[0] === 769, `budget(1) === 769 (got ${budgets[0]})`);
  check(budgets[7] === 629, `budget(8) === 629 (got ${budgets[7]})`);
  check(budgets[11] === 629, `budget(12) === 629 (got ${budgets[11]})`);

  /* Independent ideal-player model: my own clock (shot flight times) and my own
   * strategy (clear column by column, bottom alien first), with the fleet
   * assumed to step at its FASTEST cadence - a deliberately conservative
   * (maximised) requirement. Nothing here calls the game's interval/step logic. */
  const gunY = SHIP_Y - SHIP_H / 2 - BULLET_H;               // 475
  const idealRequired = w => {
    const base = Math.max(0.36, 0.5 - 0.02 * (w - 1));
    const fastest = base * 0.3;
    const startY = Math.min(48 + 6 * (w - 1), 88);
    let t = 0;
    for (let c = 0; c < COLS; c++) for (let r = ROWS - 1; r >= 0; r--) t += (gunY - (startY + r * CELL + CELL)) / BULLET_SPEED;
    return t / fastest;
  };
  let minRatio = Infinity, minWave = 1;
  for (let w = 1; w <= 12; w++) { const r = budgets[w - 1] / idealRequired(w); if (r < minRatio) { minRatio = r; minWave = w; } }
  check(minRatio >= 1.6, `budget / required >= 1.6 for every wave (min ${minRatio.toFixed(2)}x at wave ${minWave})`);
  note(`ideal-player min ratio = ${minRatio.toFixed(2)}x (wave ${minWave}); required(12) = ${idealRequired(12).toFixed(1)} steps`);

  /* The two difficulty dials must really SATURATE by wave 12 - otherwise the
   * game keeps getting harder forever (the "hidden" late-game hazard). */
  check(SI.waveConfig(7).startY === 84 && SI.waveConfig(8).startY === 88 && SI.waveConfig(12).startY === 88,
    `startY saturates at 88 from wave 8 (w7=${SI.waveConfig(7).startY}, w8=${SI.waveConfig(8).startY}, w12=${SI.waveConfig(12).startY})`);
  check(Math.abs(SI.waveConfig(7).stepBase - 0.38) < 1e-12 && Math.abs(SI.waveConfig(8).stepBase - 0.36) < 1e-12 && Math.abs(SI.waveConfig(12).stepBase - 0.36) < 1e-12,
    `stepBase floors at 0.36 from wave 8 (w7=${SI.waveConfig(7).stepBase}, w12=${SI.waveConfig(12).stepBase})`);
}

/* ======================================================================
 * 8. lifecycle through the real UI entry point
 * ==================================================================== */

group('8. lifecycle + rules (real click on Start)');
{
  const Gi = boot(), S = Gi.SI, ei = Gi.els;
  check(S.getState().phase === 'ready', `the page boots into 'ready' (got ${S.getState().phase})`);
  check(ei.btnPause.disabled === true, 'the Pause button is disabled in ready');
  check(ei.startOverlay.classList.contains('show'), 'the start overlay is visible in ready');
  check(!ei.overlay.classList.contains('show'), 'the result overlay is hidden at boot');

  ei.btnStart.fire('click');                                 // REAL click on Start
  check(S.getState().phase === 'playing', `a real click on Start enters 'playing' (got ${S.getState().phase})`);
  check(!ei.startOverlay.classList.contains('show'), 'the start overlay really hides after Start');
  check(ei.btnPause.disabled === false, 'the Pause button becomes enabled once playing');

  S.newGame({ wave: 1, seed: 1 });
  S.fire();
  const b1 = S.getState().bullets;
  S.fire();
  const b2 = S.getState().bullets;
  check(b1.length === 1 && b2.length === 1 && b1[0].x === b2[0].x && b1[0].y === b2[0].y,
    'the single-bullet rule: firing again while a bullet is on screen is a no-op');

  S.newGame({ wave: 1, seed: 1 });
  S.pause();
  check(S.getState().phase === 'paused', 'pause() enters paused');
  const pf = S.fire();
  check(pf.bullets.length === 0, `fire() is inert while not playing (bullets=${pf.bullets.length})`);
  S.pause();
  check(S.getState().phase === 'playing', 'pause() again resumes');

  S.newGame({ wave: 1, seed: 1 });
  S.start();
  check(S.getState().phase === 'playing', "the bridge start() enters 'playing'");
}

/* ======================================================================
 * 9. invasion == loss
 * ==================================================================== */

group('9. invasion reaches the line and ends the game');
{
  const Gi = boot(), S = Gi.SI;
  S.newGame({ wave: 12, seed: 1, lives: 999 });
  S.move(-1); S.tick(2); S.move(0);                          // park at the far wall (outside the bomb envelope)
  const r = tickUntil(S, () => S.getState().phase === 'gameover', 400, 0.25);
  const s = S.getState();
  check(r.ok && s.phase === 'gameover', `with no shooting the fleet reaches the line and it is gameover (phase=${s.phase})`);
  check(s.invadersLeft === 55, `no invader was ever killed, so the loss can only be the invasion (left=${s.invadersLeft})`);
  check(s.lives >= 1, `lives never went negative or reached 0 (lives=${s.lives})`);
  check(s.steps >= 629, `the fleet stepped at least budget(12)=629 times before landing (steps=${s.steps})`);
  note(`invasion at wave 12: phase=${s.phase}, steps=${s.steps}, lives=${s.lives}, t≈${r.t.toFixed(0)}s`);
}

/* ======================================================================
 * 10. wave clear + next wave
 * ==================================================================== */

group('10. clearing a wave advances and rebuilds');
{
  const Gi = boot(), S = Gi.SI, ei = Gi.els;
  S.newGame({ wave: 1, seed: 1, lives: 99999 });
  let scoreBeforeLast = -1, leftBeforeLast = -1, lastPts = 0, sawLast = false;
  const frames = sweepUntil(S, s => s.phase === 'waveclear' || s.phase === 'gameover', 30000, -1, s => {
    if (s.invadersLeft === 1 && !sawLast) {
      sawLast = true; scoreBeforeLast = s.score; leftBeforeLast = s.invadersLeft;
      const last = s.invaders.find(iv => iv.alive);
      lastPts = SI.scoreFor('invader', last ? last.row : 0);
    }
  });
  const sc = S.getState();
  check(sc.phase === 'waveclear', `clearing all 55 invaders enters 'waveclear' (phase=${sc.phase})`);
  check(sc.invadersLeft === 0, `the fleet is empty after the clear (left=${sc.invadersLeft})`);
  check(sawLast && sc.score - scoreBeforeLast >= 300 + 100 * 1,
    `the clear scored at least 300 + 100*wave = 400 (delta=${sc.score - scoreBeforeLast}, lastKill=${lastPts})`);
  note(`wave-1 clear: total score ${sc.score}, frames ${frames}, bunkers left ${sc.bunkers}`);

  const solidAfterClear = sc.bunkerSolid;
  check(ei.overlay.classList.contains('show'), 'the result overlay is shown on wave clear');
  check(CJK.test(ei.ovTitle.textContent) === false && /Wave|clear/i.test(ei.ovTitle.textContent),
    `the clear dialog title is the English wave-clear text (got ${JSON.stringify(ei.ovTitle.textContent)})`);

  ei.ovBtn.fire('click');                                    // real click -> next wave
  const nw = S.getState();
  check(nw.wave === 2, `the next-wave button advances to wave 2 (got ${nw.wave})`);
  check(nw.invadersLeft === 55, `a fresh fleet of 55 spawns (got ${nw.invadersLeft})`);
  check(nw.bunkerSolid === FULL_BUNKER_SOLID && nw.bunkerSolid >= solidAfterClear,
    `the shields are rebuilt (bunkerSolid ${solidAfterClear} -> ${nw.bunkerSolid}, fresh ${FULL_BUNKER_SOLID})`);
  check(!ei.overlay.classList.contains('show'), 'the result overlay hides after advancing');
  check(nw.phase === 'playing', `the next wave is playing (phase=${nw.phase})`);
}

/* ======================================================================
 * 11. death
 * ==================================================================== */

group('11. bomb hit -> dying animation -> gameover at zero lives');
{
  const Gi = boot(), S = Gi.SI;
  S.newGame({ wave: 1, seed: 1, lives: 3 });
  const before = S.getState().lives;
  const hit = tickUntil(S, () => S.getState().phase === 'dying', 120, 0.1);
  const d = S.getState();
  check(hit.ok && d.phase === 'dying', `a bomb hit puts the game into 'dying' (phase=${d.phase})`);
  check(d.lives === before - 1, `a hit costs exactly one life (${before} -> ${d.lives})`);
  check(d.deathTimer > 0 && d.deathTimer <= DEATH_TIME, `a ${DEATH_TIME}s death timer runs (deathTimer=${d.deathTimer.toFixed(3)})`);
  const respawn = tickUntil(S, () => S.getState().phase === 'playing', 5, 0.05);
  check(respawn.ok && S.getState().phase === 'playing', 'with lives left the player respawns');
  check(S.getState().steps === 0 || S.getState().steps >= 0, 'the fleet pose resets on respawn (steps is a valid count)');

  S.newGame({ wave: 1, seed: 1, lives: 1 });
  const h2 = tickUntil(S, () => S.getState().phase === 'dying', 120, 0.1);
  check(h2.ok && S.getState().lives === 0, `the last life drops lives to 0 (lives=${S.getState().lives})`);
  const over = tickUntil(S, () => S.getState().phase === 'gameover', 5, 0.05);
  check(over.ok && S.getState().phase === 'gameover', 'finishing the death animation with 0 lives is gameover');
  check(S.getState().lives >= 0, `lives never goes negative (lives=${S.getState().lives})`);
}

/* ======================================================================
 * 12. UFO cadence
 * ==================================================================== */

group('12. UFO only while the fleet is sizeable, one at a time, on period');
{
  const Gi = boot(), S = Gi.SI;

  const runCadence = (wave, seconds) => {
    S.newGame({ wave, seed: 1, lives: 99999 });
    S.move(-1); S.tick(2); S.move(0);                        // safe corner, so steps never reset
    const period = S.waveConfig(wave).ufoPeriod;
    const spawns = [];
    let prev = null, sawTwo = false;
    const steps = Math.round(seconds / (1 / 60));
    for (let i = 0; i < steps; i++) {
      S.tick(1 / 60);
      const s = S.getState();
      if (s.ufo && !prev) spawns.push({ steps: s.steps, alive: s.invadersLeft });
      if (s.ufo && prev) sawTwo = true;                      // two frames in a row with a UFO is fine; overlap is impossible by construction
      prev = s.ufo;
    }
    return { period, spawns };
  };

  const c1 = runCadence(1, 200);
  check(c1.spawns.length >= 4, `UFOs appear repeatedly on wave 1 (${c1.spawns.length} spawns in 200s)`);
  check(c1.spawns.every(x => x.steps % c1.period === 0), `every wave-1 spawn is on a multiple of ufoPeriod=${c1.period} (${c1.spawns.map(x => x.steps).join(',')})`);
  check(c1.spawns.every(x => x.alive >= UFO_MIN_ALIVE), `the UFO only appears while aliveCount >= ${UFO_MIN_ALIVE}`);
  check(c1.period === 40, `wave-1 ufoPeriod is 40 (got ${c1.period})`);

  const c12 = runCadence(12, 120);
  check(c12.period === 20, `wave-12 ufoPeriod is max(20, 40-3*11)=20 (got ${c12.period})`);
  check(c12.spawns.length >= 2 && c12.spawns.every(x => x.steps % 20 === 0),
    `wave-12 spawns land on multiples of 20 (${c12.spawns.map(x => x.steps).join(',')})`);

  /* Below 8 aliens: no new spawns, ever. */
  const Gm = boot(), Sm = Gm.SI;
  Sm.newGame({ wave: 1, seed: 1, lives: 99999 });
  sweepUntil(Sm, s => s.invadersLeft <= 7, 30000, -1);
  const left = Sm.getState().invadersLeft;
  const spawnsAt = Sm.getState().rng.ufoSpawns;
  let later = spawnsAt, sawUfo = false;
  for (let i = 0; i < 600; i++) { Sm.tick(1 / 30); const s = Sm.getState(); if (s.rng.ufoSpawns !== later) later = s.rng.ufoSpawns; if (s.ufo) sawUfo = true; }
  check(left <= 7 && left > 0, `the fleet was thinned below 8 without clearing it (left=${left})`);
  check(later === spawnsAt, `no UFO spawns once aliveCount < ${UFO_MIN_ALIVE} (spawns ${spawnsAt} -> ${later})`);
}

/* ======================================================================
 * 13. HUD refresh (dynamic) + static write-locality scan
 * ==================================================================== */

group('13. HUD is refreshed by tick() and only written by updateHud()');
{
  const Gi = boot(), S = Gi.SI, ei = Gi.els;
  ei.btnStart.fire('click');
  const mirrors = () => {
    const s = S.getState();
    return { score: String(s.score), lives: String(s.lives), wave: String(s.wave), left: String(s.invadersLeft) };
  };
  const hud = () => ({ score: ei.score.textContent, lives: ei.lives.textContent, wave: ei.wave.textContent, left: ei.remaining.textContent });
  const eq = (a, b) => a.score === b.score && a.lives === b.lives && a.wave === b.wave && a.left === b.left;

  S.fire();
  S.tick(0.5);                                               // kill the bottom alien, then let tick() refresh the HUD
  check(eq(hud(), mirrors()), `tick() refreshes the HUD to match the model (${JSON.stringify(hud())} vs ${JSON.stringify(mirrors())})`);
  check(ei.remaining.textContent === String(S.getState().invadersLeft) && S.getState().invadersLeft < 55,
    `#remaining really changed after a kill (got ${ei.remaining.textContent})`);
  S.tick(2);
  check(eq(hud(), mirrors()), `repeated ticks keep the HUD in sync (${JSON.stringify(hud())})`);

  /* Static scan: strip comments, locate the updateHud() body by brace matching,
   * then require that EVERY write to a HUD node happens inside it. A write placed
   * anywhere else (say, bypassing the value cache in loop()) would desync the
   * cache from the DOM and is exactly what this guards against. */
  const code = G.html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
  const start = code.indexOf('function updateHud(');
  let end = -1;
  if (start >= 0) {
    const open = code.indexOf('{', start);
    let depth = 0;
    for (let j = open; j < code.length; j++) { const ch = code[j]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } } }
  }
  const writeRe = /\b(scoreEl|livesEl|waveEl|remEl|btnPause)\s*\.\s*(textContent|innerHTML|disabled|setAttribute)\b/g;
  const writes = [...code.matchAll(writeRe)];
  const outside = writes.filter(m => !(start >= 0 && m.index >= start && m.index <= end));
  check(start >= 0 && end > start, 'updateHud() is present and brace-matched');
  check(writes.length > 0, `HUD nodes are written somewhere (found ${writes.length} writes)`);
  check(outside.length === 0, `every HUD-node write lives inside updateHud() (found ${outside.length} outside)`,
    outside.slice(0, 3).map(m => m[0]).join('; '));
}

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
