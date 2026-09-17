#!/usr/bin/env node
/**
 * Logic tests for match3-game.
 *
 * The smoke test only proves the page does not throw. It cannot tell whether
 * findMatches de-duplicates a cross, whether gravity preserves column order,
 * whether a fresh board is really free of runs and still playable, whether a
 * cascade scores each cleared gem exactly once, or whether the dynamic HUD text
 * actually follows the language. This suite loads the whole inline script in a
 * vm sandbox (top-level `var`/`function` declarations land on the context
 * global, so internal state is readable) and asserts the rules through the
 * game's own bridge object `window.M3` and its real UI entry points.
 *
 * The centrepiece is DIFFERENTIAL testing (see
 * .workbuddy/skills/puzzle-solver-audit/SKILL.md): the game's `findMatches` and
 * `hasMove` are cross-checked against an independently written reference whose
 * SHAPE differs (per-cell expansion versus the game's single-pass segment
 * scan). Small boards over tiny alphabets are enumerated EXHAUSTIVELY, so every
 * duplicate / cross / boundary layout is hit. Any disagreement is a real bug.
 *
 * Reverse checks then deliberately break internal functions and confirm the
 * matching assertions go red, proving the suite is not vacuously green.
 *
 * Usage:  node tools/match3-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'match3-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

const CJK = /[\u4e00-\u9fff]/;
const json = x => JSON.stringify(x);

/* ----------------------------------------------------------------- fake DOM
 * The game is DOM-rendered, so it needs a small but FAITHFUL stub: lazy
 * getElementById, real child lists, addEventListener/fire, a style object that
 * actually stores setProperty values, a rAF hook that records the callback so
 * frames can be pumped by hand, and a getItem/setItem-only localStorage. */
function makeContext() {
  class Frag {
    constructor() { this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
  }

  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.handlers = {};
      this.parent = null;
      this.dataset = {};
      this.disabled = false;
      this.value = '';
      this.checked = false;
      this.title = '';
      this.placeholder = '';
      this.href = '';
      this._attrs = {};
      this._text = '';
      this._html = '';
      this._cls = new Set();
      this._style = {};
      this.style = {
        _p: this._style,
        setProperty: (k, v) => { this._style[k] = String(v); },
        getPropertyValue: k => (k in this._style ? this._style[k] : ''),
        removeProperty: k => { delete this._style[k]; }
      };
      this.classList = {
        add: (...cs) => cs.forEach(c => this._cls.add(c)),
        remove: (...cs) => cs.forEach(c => this._cls.delete(c)),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { const on2 = (on === undefined) ? !this._cls.has(c) : on; on2 ? this._cls.add(c) : this._cls.delete(c); }
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
    closest(sel) {
      const want = sel.replace('.', '');
      let n = this;
      while (n) { if (n._cls && n._cls.has(want)) return n; n = n.parent; }
      return null;
    }
    querySelector(s) { return this._find(s)[0] || null; }
    querySelectorAll(s) { return this._find(s); }
    _find(s) {
      const want = s.replace('.', '');
      const out = [];
      (function walk(n) {
        n.children.forEach(c => {
          if (c && c._cls && c._cls.has(want)) out.push(c);
          if (c && c.children) walk(c);
        });
      })(this);
      return out;
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
  }

  const els = {};
  const docHandlers = {};
  const winHandlers = {};
  let frame = null;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    localStorage: (() => {
      const store = {};
      return {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); }
      };
    })(),
    document: {
      documentElement: new El('html'),
      head: new El('head'),
      body: new El('body'),
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
  context.addEventListener = (t, f) => { (winHandlers[t] = winHandlers[t] || []).push(f); };
  context.removeEventListener = () => {};

  vm.createContext(context);

  return {
    context,
    els,
    fireWin(t, ev) { (winHandlers[t] || []).forEach(f => f(ev || {})); },
    step() { const f = frame; frame = null; if (f) f(); },
    steps(n) { for (let i = 0; i < n; i++) this.step(); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const html = fs.readFileSync(GAME, 'utf8');
  env.html = html;
  inlineScripts(html).forEach((s, i) =>
    vm.runInContext(s, env.context, { filename: `match3#${i}` }));
  return env;
}

const env = boot();
const C = env.context;
const M3 = C.M3;
const el = id => env.context.document.getElementById(id);

/* ------------------------------------------------------------- test helpers */
function mkGrid(rows, cols, fill) {
  const g = [];
  for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(fill === undefined ? null : fill); g.push(row); }
  return g;
}
function rowOf3() { return [0, 0, 0]; }
function has(list, r, c) { for (let i = 0; i < list.length; i++) if (list[i][0] === r && list[i][1] === c) return true; return false; }
function cellSet(list) { return new Set(list.map(p => p[0] + ':' + p[1])); }
function clickCell(r, c) { env.els.board.fire('click', { target: C.cellEls[r][c] }); }

/* A single-pass segment scanner, the SAME shape as the game's findMatches.
 * Used only by the reverse checks, never as the reference. */
function brokenFindMin4(g) {
  const h = g.length;
  let w = 0;
  for (let r = 0; r < h; r++) if (g[r] && g[r].length > w) w = g[r].length;
  const at = (r, c) => (r < 0 || r >= h || !g[r] || c < 0 || c >= g[r].length) ? null
    : (g[r][c] === null || g[r][c] === undefined || g[r][c] < 0 ? null : g[r][c]);
  const out = [];
  for (let r = 0; r < h; r++) {
    let start = 0;
    for (let c = 1; c <= w; c++) {
      const cont = c < w && at(r, c) !== null && at(r, c - 1) !== null && at(r, c) === at(r, c - 1);
      if (!cont) { if (c - start >= 4 && at(r, start) !== null) for (let k = start; k < c; k++) out.push([r, k]); start = c; }
    }
  }
  for (let c = 0; c < w; c++) {
    let top = 0;
    for (let r = 1; r <= h; r++) {
      const cont = r < h && at(r, c) !== null && at(r - 1, c) !== null && at(r, c) === at(r - 1, c);
      if (!cont) { if (r - top >= 4 && at(top, c) !== null) for (let k = top; k < r; k++) out.push([k, c]); top = r; }
    }
  }
  return out;
}

/* ============================================================ reference impl
 * INDEPENDENT of the game: shares no code, and uses a DIFFERENT shape — for
 * every cell it expands a run outwards in both directions, instead of scanning
 * maximal segments in one pass. Semantics (max-width for ragged rows, null for
 * empty / out-of-range) mirror the documented contract. */

function refAt(g, r, c) {
  const h = (g && g.length) ? g.length : 0;
  if (r < 0 || r >= h) return null;
  const row = g[r];
  if (!row || c < 0 || c >= row.length) return null;
  const v = row[c];
  return (v === null || v === undefined || v < 0) ? null : v;
}

function refFindMatches(g) {
  const h = (g && g.length) ? g.length : 0;
  let w = 0;
  for (let r = 0; r < h; r++) if (g[r] && g[r].length > w) w = g[r].length;
  const set = new Set();
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = refAt(g, r, c);
      if (v === null) continue;
      // horizontal run through (r,c)
      let l = c; while (refAt(g, r, l - 1) === v) l--;
      let rr = c; while (refAt(g, r, rr + 1) === v) rr++;
      if (rr - l + 1 >= 3) { for (let x = l; x <= rr; x++) set.add(r + ':' + x); }
      // vertical run through (r,c)
      let t = r; while (refAt(g, t - 1, c) === v) t--;
      let b = r; while (refAt(g, b + 1, c) === v) b++;
      if (b - t + 1 >= 3) { for (let y = t; y <= b; y++) set.add(y + ':' + c); }
    }
  }
  return [...set].map(k => k.split(':').map(Number));
}

function refSwapMakesMatch(g, r1, c1, r2, c2) {
  const t = g.map(row => row.slice());
  const tmp = t[r1][c1]; t[r1][c1] = t[r2][c2]; t[r2][c2] = tmp;
  return refFindMatches(t).length > 0;
}

function refHasMove(g) {
  const h = (g && g.length) ? g.length : 0;
  let w = 0;
  for (let r = 0; r < h; r++) if (g[r] && g[r].length > w) w = g[r].length;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (c + 1 < w && refSwapMakesMatch(g, r, c, r, c + 1)) return true;
      if (r + 1 < h && refSwapMakesMatch(g, r, c, r + 1, c)) return true;
    }
  }
  return false;
}

/* ====================================================== the bridge / palette */
group('bridge object and palette');
check('M3 is exposed', !!M3 && typeof M3 === 'object');
check('M3.rows is 8', M3.rows === 8, M3.rows);
check('M3.cols is 8', M3.cols === 8, M3.cols);
check('M3.colors has 7 entries', Array.isArray(M3.colors) && M3.colors.length === 7, M3.colors && M3.colors.length);
check('M3.findMatches is a function', typeof M3.findMatches === 'function');
check('M3.applyGravity is a function', typeof M3.applyGravity === 'function');
check('M3.hasMove is a function', typeof M3.hasMove === 'function');
check('M3.refill is a function', typeof M3.refill === 'function');
check('M3.newGame is a function', typeof M3.newGame === 'function');
const s0 = M3.getState();
check('getState() shape is complete',
  s0 && s0.status && Array.isArray(s0.grid) && typeof s0.score === 'number' &&
  typeof s0.moves === 'number' && typeof s0.target === 'number' && typeof s0.combo === 'number' &&
  'selected' in s0 && typeof s0.lang === 'string', json(Object.keys(s0)));
check('getState().grid is an 8x8 deep copy', s0.grid.length === 8 && s0.grid.every(r => r.length === 8));
check('getState() grid is a COPY (mutating it does not touch the game)',
  (() => { const before = json(C.grid); s0.grid[0][0] = 99; const ok = json(C.grid) === before; s0.grid[0][0] = C.grid[0][0]; return ok; })());

/* ================================================== findMatches correctness */
group('findMatches — horizontal / vertical runs, cross de-dup, null handling');
{
  const m = { h3: mkGrid(3, 3), h4: mkGrid(3, 4), h5: mkGrid(3, 5), v3: mkGrid(3, 1), v4: mkGrid(4, 1), v5: mkGrid(5, 1) };
  [m.h3, m.v3].forEach(g => { /* row 1 */ });
  for (let c = 0; c < 3; c++) m.h3[1][c] = 0;
  for (let c = 0; c < 4; c++) m.h4[1][c] = 1;
  for (let c = 0; c < 5; c++) m.h5[1][c] = 2;
  for (let r = 0; r < 3; r++) m.v3[r][0] = 3;
  for (let r = 0; r < 4; r++) m.v4[r][0] = 4;
  for (let r = 0; r < 5; r++) m.v5[r][0] = 5;

  const r3 = M3.findMatches(m.h3);
  check('horizontal 3 -> exactly 3 cells', r3.length === 3 && has(r3, 1, 0) && has(r3, 1, 1) && has(r3, 1, 2), json(r3));
  const r4 = M3.findMatches(m.h4);
  check('horizontal 4 -> exactly 4 cells', r4.length === 4, r4.length);
  const r5 = M3.findMatches(m.h5);
  check('horizontal 5 -> exactly 5 cells', r5.length === 5, r5.length);
  check('vertical 3 -> exactly 3 cells', M3.findMatches(m.v3).length === 3);
  check('vertical 4 -> exactly 4 cells', M3.findMatches(m.v4).length === 4);
  check('vertical 5 -> exactly 5 cells', M3.findMatches(m.v5).length === 5);

  // A cross: row 1 (0,1)(1,1)(2,1) and column 1 (1,0)(1,1)(1,2) share (1,1).
  const g = mkGrid(3, 3);
  for (let c = 0; c < 3; c++) g[1][c] = 0;
  for (let r = 0; r < 3; r++) g[r][1] = 0;
  const cross = M3.findMatches(g);
  check('cross: the shared cell is de-duplicated (5 unique cells)', cross.length === 5, json(cross));
  check('cross: cell set is exactly the plus sign',
    cellSet(cross).size === 5 && has(cross, 1, 1) && has(cross, 0, 1) && has(cross, 2, 1) && has(cross, 1, 0) && has(cross, 1, 2), json(cross));

  // An L: row 0 has 3 and column 0 has 3, sharing (0,0).
  const gl = mkGrid(3, 3);
  for (let c = 0; c < 3; c++) gl[0][c] = 1;
  for (let r = 0; r < 3; r++) gl[r][0] = 1;
  const L = M3.findMatches(gl);
  check('L-shape: 5 unique cells, corner counted once', L.length === 5, json(L));

  // null truncates a run: A A null A A is NOT a match.
  const gn = mkGrid(1, 5);
  gn[0][0] = 0; gn[0][1] = 0; gn[0][3] = 0; gn[0][4] = 0;
  check('A A null A A does not match (null breaks the run)', M3.findMatches(gn).length === 0, json(M3.findMatches(gn)));

  // A A A null A A A -> two separate runs of 3 (6 cells).
  const gn2 = mkGrid(1, 7);
  [0, 1, 2, 4, 5, 6].forEach(c => { gn2[0][c] = 2; });
  const rn2 = M3.findMatches(gn2);
  check('A A A null A A A -> 6 cells (two runs of 3)', rn2.length === 6, json(rn2));
  check('the null cell is never reported', !has(rn2, 0, 3));

  // Two distinct runs in one row.
  const gt = mkGrid(1, 8);
  [0, 1, 2].forEach(c => { gt[0][c] = 3; });
  [5, 6, 7].forEach(c => { gt[0][c] = 4; });
  check('two separate runs -> 6 cells', M3.findMatches(gt).length === 6, M3.findMatches(gt).length);

  // Only 2 in a line is not a match.
  const g2 = mkGrid(2, 2);
  g2[0][0] = 1; g2[0][1] = 1;
  check('two in a line is not a match', M3.findMatches(g2).length === 0, json(M3.findMatches(g2)));

  // Tolerance: non-8x8, ragged rows, empty.
  check('non-8x8 board finds every run (2 rows x 3 = 6 cells)',
    M3.findMatches([[0, 0, 0], [1, 1, 1]]).length === 6, M3.findMatches([[0, 0, 0], [1, 1, 1]]).length);
  check('non-8x8 board with no run -> no matches',
    M3.findMatches([[0, 0, 1], [1, 1, 0]]).length === 0, json(M3.findMatches([[0, 0, 1], [1, 1, 0]])));
  check('ragged rows do not throw', (() => { try { M3.findMatches([[0, 0, 0], [0, 0], [0]]); return true; } catch (e) { return false; } })());
  check('empty grid -> no matches', M3.findMatches([]).length === 0);
  check('all-null row -> no matches', M3.findMatches([[null, null, null]]).length === 0);
  check('a full null column -> no matches', M3.findMatches([[null], [null], [null]]).length === 0);
}

/* ============================================= DIFFERENTIAL (the important bit) */
group('differential — game findMatches/hasMove vs an independent reference');
{
  function* boards(h, w, alphabet) {
    const n = h * w, base = alphabet.length;
    const total = Math.pow(base, n);
    for (let i = 0; i < total; i++) {
      const g = []; let x = i;
      for (let r = 0; r < h; r++) {
        const row = [];
        for (let c = 0; c < w; c++) { row.push(alphabet[x % base]); x = Math.floor(x / base); }
        g.push(row);
      }
      yield g;
    }
  }

  function diffuse(name, h, w, alphabet) {
    const s = new Set(alphabet.map(v => v + ':'));
    const found = new Set(alphabet.map(v => v + ':'));
    found.clear();
    let n = 0, badM = 0, badH = 0, exM = null, exH = null;
    for (const g of boards(h, w, alphabet)) {
      n++;
      const gm = M3.findMatches(g);
      const rm = refFindMatches(g);
      if (!(gm.length === rm.length && gm.every(p => cellSet(rm).has(p[0] + ':' + p[1])))) {
        badM++; if (!exM) exM = json(g) + ' game=' + json(gm) + ' ref=' + json(rm);
      }
      const gh = M3.hasMove(g);
      const rh = refHasMove(g);
      if (gh !== rh) { badH++; if (!exH) exH = json(g) + ' game=' + gh + ' ref=' + rh; }
    }
    return { name, n, badM, badH, exM, exH };
  }

  // Small boards over tiny alphabets: exhaustive, so every duplicate / cross /
  // boundary layout is covered. `null` is included to exercise empty cells.
  const sets = [
    diffuse('3x3 {0,1}', 3, 3, [0, 1]),
    diffuse('3x3 {0,1,2}', 3, 3, [0, 1, 2]),
    diffuse('3x3 {null,0,1}', 3, 3, [null, 0, 1]),
    diffuse('3x4 {0,1}', 3, 4, [0, 1]),
    diffuse('4x4 {0,1}', 4, 4, [0, 1]),
    diffuse('2x4 {null,0,1}', 2, 4, [null, 0, 1]),
    diffuse('2x4 {null,0,1,2}', 2, 4, [null, 0, 1, 2]),
    diffuse('2x3 {0,1,2}', 2, 3, [0, 1, 2])
  ];

  let totalBoards = 0, totalBadM = 0, totalBadH = 0;
  sets.forEach(s => {
    totalBoards += s.n; totalBadM += s.badM; totalBadH += s.badH;
    check(`findMatches agrees on all ${s.n} boards — ${s.name}`, s.badM === 0, s.exM || `${s.badM} disagree`);
    check(`hasMove agrees on all ${s.n} boards — ${s.name}`, s.badH === 0, s.exH || `${s.badH} disagree`);
  });
  check('TOTAL: 0 findMatches disagreements across all boards', totalBadM === 0, `${totalBadM}`);
  check('TOTAL: 0 hasMove disagreements across all boards', totalBadH === 0, `${totalBadH}`);
  check('exhaustive corpus is non-trivial (>= 150k boards)', totalBoards >= 150000, totalBoards);
  check('reference is not trivially empty (finds a known cross)',
    refFindMatches([[0, 0, 0], [0, 1, 1], [0, 1, 1]].map((row, r) => row.map((v, c) => (r === 1 && c === 0 ? 0 : v)))).length >= 1);
  console.log(`  ...  compared ${totalBoards} boards; findMatches mismatch=${totalBadM}, hasMove mismatch=${totalBadH}`);
}

/* =========================================================== applyGravity */
group('applyGravity — column order, null conservation, purity');
{
  const g = [[1, null, 5], [null, 2, null], [3, null, null]];
  const before = json(g);
  const out = M3.applyGravity(g);
  check('gravity does not mutate its argument', json(g) === before, before);
  check('gravity returns a new array', out !== g);
  check('column 0 falls to the bottom in order (1 above 3)',
    out[0][0] === null && out[1][0] === 1 && out[2][0] === 3, json(out.map(r => r[0])));
  check('column 1 has the single gem at the bottom', out[2][1] === 2 && out[0][1] === null && out[1][1] === null, json(out.map(r => r[1])));
  check('column 2 keeps its lone gem at the bottom', out[2][2] === 5, json(out.map(r => r[2])));

  const countNulls = x => x.flat().filter(v => v === null).length;
  check('null count is conserved', countNulls(g) === countNulls(out), `${countNulls(g)} -> ${countNulls(out)}`);

  // Relative order within a column: 5,3,7 keeps 5 before 3 before 7.
  const col = [[5], [null], [null], [3], [7]];
  const oc = M3.applyGravity(col);
  const seq = oc.map(r => r[0]).filter(v => v !== null);
  check('non-empty gems keep their relative order', json(seq) === json([5, 3, 7]), json(seq));
  check('all gems end at the bottom', oc[4][0] === 7 && oc[3][0] === 3 && oc[2][0] === 5, json(oc.map(r => r[0])));

  const empty = M3.applyGravity(mkGrid(3, 3));
  check('a fully empty grid stays empty', empty.flat().every(v => v === null));
  check('a full grid is unchanged by gravity',
    json(M3.applyGravity([[1, 2], [3, 4]])) === json([[1, 2], [3, 4]]));
}

/* ================================================================== refill */
group('refill — fills empties, preserves values, stays in range, pure');
{
  const g = [[1, null, 2], [null, null, 3], [4, 5, null]];
  const before = json(g);
  const out = M3.refill(g, 4);
  check('refill does not mutate its argument', json(g) === before, before);
  check('refill returns a new array', out !== g);
  check('no empty cells remain after refill', out.flat().every(v => v !== null && v !== undefined), json(out));
  check('existing values are preserved',
    out[0][0] === 1 && out[0][2] === 2 && out[1][2] === 3 && out[2][0] === 4 && out[2][1] === 5, json(out));
  // Only the cells that were EMPTY get a new value; check those are in range.
  const newCells = [];
  for (let r = 0; r < g.length; r++) for (let c = 0; c < g[r].length; c++) if (g[r][c] === null) newCells.push(out[r][c]);
  check('every newly filled value is inside [0, colorCount)',
    newCells.length > 0 && newCells.every(v => Number.isInteger(v) && v >= 0 && v < 4), json(newCells));

  // Range stress across many draws.
  let oob = 0;
  for (let i = 0; i < 200; i++) {
    const r = M3.refill(mkGrid(2, 2), 3);
    if (r.flat().some(v => v < 0 || v >= 3)) oob++;
  }
  check('range holds over 200 refills with colorCount 3', oob === 0, oob);

  const one = M3.refill(mkGrid(2, 2), 1);
  check('colorCount 1 fills with the only colour', one.flat().every(v => v === 0), json(one));
  const none = M3.refill(mkGrid(1, 1), 0);
  check('an invalid colorCount degrades safely to 1 colour', none[0][0] === 0, json(none));
}

/* =============================================== purity of all four helpers */
group('pure helpers never mutate their argument');
{
  const g = [[0, 0, 0], [null, 1, 2], [3, 3, null]];
  const before = json(g);
  M3.findMatches(g); M3.applyGravity(g); M3.hasMove(g); M3.refill(g, 3);
  check('findMatches/applyGravity/hasMove/refill leave the input grid untouched', json(g) === before, json(g));
}

/* ============================================= newGame / board generation */
group('newGame — 500 seeded boards: no initial match AND a move exists');
{
  const diffs = ['easy', 'normal', 'hard'];
  const expectColors = { easy: 5, normal: 6, hard: 7 };
  const expectMoves = { easy: 30, normal: 25, hard: 20 };
  const expectTarget = { easy: 1000, normal: 1500, hard: 2000 };
  let withMatch = 0, withoutMove = 0, badDims = 0, badVal = 0, badCfg = 0;
  for (let i = 0; i < 500; i++) {
    const d = diffs[i % 3];
    const snap = M3.newGame({ difficulty: d, seed: i + 1 });
    const g = snap.grid;
    if (g.length !== 8 || !g.every(r => r.length === 8)) badDims++;
    if (g.flat().some(v => !(Number.isInteger(v) && v >= 0 && v < expectColors[d]))) badVal++;
    if (M3.findMatches(g).length > 0) withMatch++;
    if (!M3.hasMove(g)) withoutMove++;
    if (snap.moves !== expectMoves[d] || snap.target !== expectTarget[d] || snap.status !== 'playing') badCfg++;
  }
  check('all 500 boards are 8x8', badDims === 0, badDims);
  check('all 500 boards use only colours valid for their difficulty', badVal === 0, badVal);
  check('no board of 500 has a pre-existing match', withMatch === 0, withMatch);
  check('every board of 500 has at least one legal move', withoutMove === 0, withoutMove);
  check('moves / target / status match the difficulty table', badCfg === 0, badCfg);

  // Seed reproducibility.
  let nondet = 0, distinctDifferent = 0;
  let prevBoard = null;
  for (let i = 0; i < 30; i++) {
    const a = M3.newGame({ difficulty: diffs[i % 3], seed: 9000 + i });
    const b = M3.newGame({ difficulty: diffs[i % 3], seed: 9000 + i });
    if (json(a.grid) !== json(b.grid)) nondet++;
    if (prevBoard === null || json(prevBoard) !== json(a.grid)) distinctDifferent++;
    prevBoard = a.grid;
  }
  check('the same seed produces an identical board (30 seeds)', nondet === 0, nondet);
  check('different seeds generally differ (sanity)', distinctDifferent > 20, distinctDifferent);

  // newGame ends in a playable, idle, freshly-scored state.
  const snap = M3.newGame({ difficulty: 'normal', seed: 5 });
  check('newGame resets score to 0', snap.score === 0, snap.score);
  check('newGame clears any selection', snap.selected === null);
  check('newGame reports playing status', snap.status === 'playing', snap.status);
}

/* ========================================= scoring & moves via the real UI */
group('scoring & moves through the real click path');
{
  // Legal swap: exactly one move spent, score follows the formula.
  M3.newGame({ difficulty: 'normal', seed: 7 });
  const mv = C.findHintMove(C.grid);
  check('a hint swap exists on the seeded board', !!mv, json(mv));
  const movesBefore = C.moves, scoreBefore = C.score;
  clickCell(mv[0], mv[1]);
  clickCell(mv[2], mv[3]);
  check('a legal swap decrements moves by exactly 1', C.moves === movesBefore - 1, `${movesBefore} -> ${C.moves}`);
  check('a legal swap enters the swapping phase', C.phase === 'swapping', C.phase);
  check('combo is reset to 0 when the move begins', C.combo === 0, C.combo);
  let f = 0;
  while (f < 40 && C.phase !== 'clearing') { env.step(); f++; }
  const cells = C.pendingClear ? C.pendingClear.length : 0;
  check('the clear round holds the matched cells', cells >= 3, cells);
  check('round-1 score is cells * 10 * 1', C.score === scoreBefore + cells * 10, `${scoreBefore} + ${cells}*10 vs ${C.score}`);
  check('combo is 1 on the first cascade round', C.combo === 1, C.combo);

  // Illegal swap: nothing changes and the board is visually restored.
  M3.newGame({ difficulty: 'normal', seed: 11 });
  let pair = null;
  for (let r = 0; r < 8 && !pair; r++) {
    for (let c = 0; c < 8 && !pair; c++) {
      if (c + 1 < 8 && !C.swapMakesMatch(C.grid, r, c, r, c + 1)) pair = [r, c, r, c + 1];
      else if (r + 1 < 8 && !C.swapMakesMatch(C.grid, r, c, r + 1, c)) pair = [r, c, r + 1, c];
    }
  }
  check('found an adjacent pair whose swap scores nothing', !!pair, json(pair));
  const gridBefore = json(C.grid), sc = C.score, mvs = C.moves;
  clickCell(pair[0], pair[1]);
  clickCell(pair[2], pair[3]);
  check('an illegal swap enters the reverting phase', C.phase === 'reverting', C.phase);
  check('an illegal swap does not spend a move', C.moves === mvs, `${mvs} -> ${C.moves}`);
  check('an illegal swap does not score', C.score === sc, `${sc} -> ${C.score}`);
  check('an illegal swap restores the grid exactly', json(C.grid) === gridBefore);
  const noticeIllegal = C.noticeKey;
  check('the notice explains the illegal swap', noticeIllegal === 'noMatch', noticeIllegal);
  env.steps(40);
  check('after reverting the board settles back to idle', C.phase === 'idle', C.phase);
  check('the board is still exactly as before the illegal swap', json(C.grid) === gridBefore);
  check('moves / score remain unchanged after revert', C.moves === mvs && C.score === sc);
}

/* ============================================ cascade scoring (item 7) */
group('cascade scoring — each gem counted once, combo +1 per round');
{
  function playOneMove() {
    // settle first if a previous move left the machine mid-phase
    let guard = 0;
    while (guard < 5000 && !(C.phase === 'idle' && C.status === 'playing')) {
      if (C.status !== 'playing') break;
      env.step(); guard++;
    }
    let mv = C.findHintMove(C.grid);
    if (!mv) { C.startShuffle(); env.steps(600); mv = C.findHintMove(C.grid); }
    if (!mv) return null;
    const comboBefore = C.combo, scoreBefore = C.score, movesBefore = C.moves;
    clickCell(mv[0], mv[1]);
    clickCell(mv[2], mv[3]);
    const res = { mv, comboBefore, scoreBefore, movesBefore, comboAfterClick: C.combo, phaseAfterClick: C.phase, rounds: [], frames: 0 };
    let prev = C.phase;
    while (res.frames < 5000) {
      env.step(); res.frames++;
      if (C.phase === 'clearing' && prev !== 'clearing' && C.pendingClear) {
        res.rounds.push({ combo: C.combo, cells: C.pendingClear.length, score: C.score });
      }
      prev = C.phase;
      if (res.rounds.length > 0 && C.phase === 'idle') break;
      if (C.status !== 'playing') break;
    }
    res.score = C.score;
    res.status = C.status;
    return res;
  }

  // Find a deterministic seed whose first move cascades at least twice.
  let chosen = null, chosenSeed = 0;
  for (let s = 1; s <= 400 && !chosen; s++) {
    M3.newGame({ difficulty: 'easy', seed: s });
    const r = playOneMove();
    if (r && r.rounds.length >= 2) { chosen = r; chosenSeed = s; }
  }
  check('found a seed producing a >= 2-round cascade', !!chosen, `seed ${chosenSeed}`);

  if (chosen) {
    const rounds = chosen.rounds;
    check('a legal move enters the swapping phase', chosen.phaseAfterClick === 'swapping');
    check('combo resets to 0 at the start of the move', chosen.comboAfterClick === 0, chosen.comboAfterClick);
    check('exactly one move was spent', C.moves <= chosen.movesBefore - 1, `${chosen.movesBefore} -> ${C.moves}`);
    check('combo increments by 1 per round (1,2,...)',
      rounds.every((r, i) => r.combo === i + 1), json(rounds.map(r => r.combo)));
    let okDeltas = true, totalCells = 0;
    for (let i = 0; i < rounds.length; i++) {
      const prevScore = (i === 0) ? chosen.scoreBefore : rounds[i - 1].score;
      const delta = rounds[i].score - prevScore;
      if (delta !== rounds[i].cells * 10 * rounds[i].combo) okDeltas = false;
      totalCells += rounds[i].cells;
    }
    check('every round scores exactly cells*10*combo (no double counting)', okDeltas,
      json(rounds.map(r => r.cells * 10 * r.combo)));
    check('total score equals the sum of the per-round awards',
      chosen.score === chosen.scoreBefore + totalCells * 10 + rounds.reduce((a, r) => a + r.cells * 10 * (r.combo - 1), 0),
      chosen.score);
    check('the cascade really produced > 1 round', rounds.length >= 2, rounds.length);
  }

  // A SECOND move in the SAME game must reset combo to 1 on its first round.
  M3.newGame({ difficulty: 'easy', seed: chosenSeed });
  const first = playOneMove();
  const leftoverCombo = C.combo;
  const second = playOneMove();
  if (second) {
    check('combo carries a value >= 1 at the end of a move (the cascade multiplier)',
      leftoverCombo >= 1, leftoverCombo);
    check('combo resets to 0 at the start of the NEXT move', second.comboAfterClick === 0, second.comboAfterClick);
    check('the next move\'s first round is combo 1 again',
      second.rounds.length > 0 && second.rounds[0].combo === 1, json(second.rounds.map(r => r.combo)));
  } else {
    check('a second move was available', false, 'no hint');
  }
  void first;
}

/* ================================================= dead board -> reshuffle */
group('dead board triggers a reshuffle that stays playable (no lock-up)');
{
  // (r + c) % 3 over 3 colours: no straight run of 3, and no single swap makes
  // one either — a genuine dead board.
  const dead = mkGrid(8, 8);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) dead[r][c] = (r + c) % 3;
  check('the injected board has no initial match', M3.findMatches(dead).length === 0, M3.findMatches(dead).length);
  check('the injected board is genuinely dead (hasMove false)', M3.hasMove(dead) === false);

  C.grid = dead;
  C.status = 'playing';
  C.moves = 10; C.score = 0; C.target = 1000; C.combo = 0; C.phase = 'idle';
  C.rng = C.makeRng(42);
  C.updateHud(); C.render();

  C.finishMove();
  check('finishing a move on a dead board enters the shuffling phase', C.phase === 'shuffling', C.phase);
  let f = 0;
  while (f < 600 && C.phase !== 'idle') { env.step(); f++; }
  check('the reshuffle completes within the frame cap (no lock-up)', C.phase === 'idle', `frames=${f}`);
  check('the reshuffled board has no initial match', M3.findMatches(C.grid).length === 0, M3.findMatches(C.grid).length);
  check('the reshuffled board has a legal move', M3.hasMove(C.grid) === true);
  check('the notice reports the reshuffle', C.noticeKey === 'reshuffled', C.noticeKey);

  // shuffleBoard preserves the colour multiset when the board is full.
  const full = M3.newGame({ difficulty: 'normal', seed: 3 }).grid;
  C.grid = full;
  C.rng = C.makeRng(12345);
  const shuffled = C.shuffleBoard(6);
  const ms = g => g.flat().slice().sort((a, b) => a - b).join(',');
  check('shuffleBoard preserves the colour multiset', ms(full) === ms(shuffled), `${ms(full)} vs ${ms(shuffled)}`);
  check('shuffleBoard result has no initial match', M3.findMatches(shuffled).length === 0);
  check('shuffleBoard result has a move', M3.hasMove(shuffled) === true);
}

/* ================================== i18n dynamic text through T.onChange */
group('i18n — dynamic text really follows the language (T.onChange path)');
{
  // The stub exposes no static data-i18n nodes, so any change in the dynamic
  // HUD text can ONLY come from the T.onChange listener -> updateHud(). This
  // makes the assertion test the callback path, not the stub's laziness.
  check('the stub document exposes no static i18n nodes',
    C.document.querySelectorAll('[data-i18n]').length === 0);
  check('source registers T.onChange exactly once',
    (env.html.match(/T\.onChange\s*\(/g) || []).length === 1,
    (env.html.match(/T\.onChange\s*\(/g) || []).length);

  // Ready state.
  C.setupBoard();
  C.T.set('en');
  const enNotice = el('notice').textContent;
  C.T.set('zh');
  check('ready notice becomes Chinese after T.set(zh)', CJK.test(el('notice').textContent), el('notice').textContent);
  check('difficulty label becomes Chinese (普通)', el('levelLabel').textContent === '普通', el('levelLabel').textContent);
  C.T.set('en');
  check('ready notice returns to English after T.set(en)',
    !CJK.test(el('notice').textContent) && el('notice').textContent === enNotice, el('notice').textContent);

  // In-game status line.
  M3.newGame({ difficulty: 'normal', seed: 1 });
  C.T.set('zh');
  check('in-game notice is Chinese after T.set(zh)', CJK.test(el('notice').textContent), el('notice').textContent);
  C.T.set('en');
  check('in-game notice is English after T.set(en)', !CJK.test(el('notice').textContent), el('notice').textContent);

  // Result dialog.
  C.endGame(true);
  C.T.set('zh');
  check('result title becomes Chinese after T.set(zh)', CJK.test(el('dlgTitle').textContent), el('dlgTitle').textContent);
  check('result subtitle becomes Chinese after T.set(zh)', CJK.test(el('dlgSub').textContent), el('dlgSub').textContent);
  C.T.set('en');
  check('result title returns to English after T.set(en)', !CJK.test(el('dlgTitle').textContent), el('dlgTitle').textContent);
  check('the live language getter tracks T.set()', C.T.lang === 'en', C.T.lang);

  // Reverse: neuter updateHud and the dynamic text must STOP following the
  // language — proof the assertion rides the onChange callback.
  C.T.set('en');
  const origHud = C.updateHud;
  C.updateHud = function () {};
  const frozen = el('notice').textContent;
  C.T.set('zh');
  check('reverse: with updateHud neutered the dynamic text does NOT change',
    el('notice').textContent === frozen && !CJK.test(el('notice').textContent), el('notice').textContent);
  C.updateHud = origHud;
  C.T.set('en');
  C.T.set('zh');
  check('restoring updateHud lets the dynamic text follow the language again',
    CJK.test(el('notice').textContent), el('notice').textContent);
  C.T.set('en');
}

/* ==================================================================
 * Animation / decoration layer — the 2026-09 enhancement.
 *
 * The fx design routes every transient tile animation through the `fxAt`
 * table, which render() folds into the tile's className, and retires it when
 * the phase ends. These groups assert the three things a player actually
 * depends on:
 *   1. a swap slides the right tile the right way over exactly one cell,
 *   2. a falling gem starts EXACTLY `d` rows above its landing square, where
 *      `d` is the true number of rows it fell (the core new logic),
 *   3. decorations are bounded, recycled, and never leak — and the board still
 *      plays with the decoration layer entirely absent.
 * ================================================================== */

/* A board with no run of three (the (r+c)%3 diagonal stripe) — a clean slate
 * onto which a single intended match can be planted without side effects. */
function plainBoard() {
  var g = [];
  for (var r = 0; r < 8; r++) { var row = []; for (var c = 0; c < 8; c++) row.push((r + c) % 3); g.push(row); }
  return g;
}

/* ① a stacked vertical run in one column: the two gems above fall 3 rows, the
 *    bottom three never move. */
var GRID_A = plainBoard();
GRID_A[2][0] = 4; GRID_A[3][0] = 4; GRID_A[4][0] = 4;
/* ② two runs in rows 1 and 5: every affected column gets TWO separated middle
 *    holes, so the gems between them fall different, non-obvious distances. */
var GRID_B = plainBoard();
[2, 3, 4].forEach(function (c) { GRID_B[1][c] = 5; GRID_B[5][c] = 4; });
/* ③ a 5-deep run cleared from the TOP of column 0 (no in-board fall there) plus
 *    a shallow run in column 3 — proves refill gems travel farther than any gem
 *    that fell inside the board. */
var GRID_C = plainBoard();
for (var _cr = 0; _cr < 5; _cr++) GRID_C[_cr][0] = 6;
[2, 3, 4].forEach(function (r) { GRID_C[r][3] = 5; });

/* Reset the whole machine onto `g`. keepNodes lets a stress loop accumulate the
 * decoration list instead of wiping it between rounds. */
function injectBoard(g, opts) {
  opts = opts || {};
  C.grid = g.map(function (row) { return row.slice(); });
  C.rows = 8; C.cols = 8;
  C.status = 'playing'; C.phase = 'idle'; C.phaseElapsed = 0; C.phaseDuration = 0;
  C.combo = (opts.combo === undefined) ? 0 : opts.combo;
  C.score = (opts.score === undefined) ? 0 : opts.score;
  C.moves = (opts.moves === undefined) ? 20 : opts.moves;
  C.target = (opts.target === undefined) ? 100000 : opts.target;
  C.pendingClear = null; C.swapCells = null; C.revertCells = null;
  C.hintCells = null; C.hintTimer = 0; C.selected = null;
  C.cascadeDepth = 0; C.dragFrom = null; C.suppressClick = false;
  C.config = { colors: 6, moves: 25, target: 100000 };
  C.rng = C.makeRng(opts.seed === undefined ? 12345 : opts.seed);
  if (!opts.keepNodes) C.clearFxNodes();
  C.clearFx();
  C.boardShakeTtl = 0;
  if (C.boardEl && C.boardEl.classList) C.boardEl.classList.remove('shake');
  C.render();
}

function fxEntry(r, c) { var row = C.fxAt[r]; return (row && row[c]) ? row[c] : null; }
function cellCls(r, c) { return C.cellEls[r][c] ? C.cellEls[r][c].className : ''; }
function cellVar(r, c, k) { return C.cellEls[r][c].style.getPropertyValue(k); }
function fxClassSet() {
  var set = {};
  for (var r = 0; r < 8; r++) { var row = C.fxAt[r]; if (!row) continue;
    for (var c = 0; c < 8; c++) { var e = row[c]; if (e) set[e.cls] = (set[e.cls] || 0) + 1; } }
  return set;
}
function countCellsWithClass(cls) {
  var n = 0;
  for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) if (C.cellEls[r][c] && C.cellEls[r][c]._cls.has(cls)) n++;
  return n;
}
function anyCellHasClass(cls) { return countCellsWithClass(cls) > 0; }
function collectFxDesc(cls) {
  var out = [];
  function walk(n) { if (!n) return; if (n._cls && n._cls.has(cls)) out.push(n); (n.children || []).forEach(walk); }
  for (var i = 0; i < C.fxNodes.length; i++) walk(C.fxNodes[i].el);
  return out;
}

/* Independent reference for the fall distance. Given the grid AFTER the cleared
 * cells were removed, a column's surviving gems keep their relative order and
 * settle onto its bottom `m` rows, so the i-th survivor (top to bottom) lands on
 * row (8 - m + i) and falls (8 - m + i) - srcRow rows. A gem already sitting on
 * its landing row falls 0 and must not animate. */
function refFalls(cleared) {
  var out = {};
  for (var c = 0; c < 8; c++) {
    var src = [];
    for (var r = 0; r < 8; r++) { var v = cleared[r][c]; if (v !== null && v !== undefined) src.push(r); }
    var m = src.length;
    for (var i = 0; i < m; i++) { var dst = 8 - m + i; var fell = dst - src[i]; if (fell > 0) out[dst + ':' + c] = fell; }
  }
  return out;
}

/* Drive the real pipeline (beginClear -> onClearDone) and read the resulting
 * per-tile fall offsets out of BOTH the fxAt table and the rendered DOM vars. */
function fallScenario(grid) {
  injectBoard(grid, { combo: 0 });
  C.beginClear();
  var matched = C.pendingClear.map(function (p) { return [p[0], p[1]]; });
  var cleared = C.grid.map(function (row) { return row.slice(); });
  for (var i = 0; i < C.pendingClear.length; i++) cleared[C.pendingClear[i][0]][C.pendingClear[i][1]] = null;
  C.onClearDone();
  var expected = refFalls(cleared);
  var observed = {}, varsMismatch = [];
  for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
    var e = fxEntry(r, c);
    if (e && e.cls === 'fall') {
      var ny = Number(e.vars['--fx-ny']);
      observed[r + ':' + c] = -ny;
      if (cellVar(r, c, '--fx-ny') !== String(ny)) varsMismatch.push(r + ':' + c);
    }
  }
  return { phase: C.phase, matched: matched, expected: expected, observed: observed,
           varsMismatch: varsMismatch, cellsWithFallClass: countCellsWithClass('fall') };
}

function fallOk(sc) {
  if (sc.phase !== 'falling') return { ok: false, why: 'phase=' + sc.phase };
  var ek = Object.keys(sc.expected), ok2 = Object.keys(sc.observed);
  if (ek.length !== ok2.length) return { ok: false, why: ok2.length + ' animated vs ' + ek.length + ' expected' };
  for (var i = 0; i < ek.length; i++) {
    var k = ek[i];
    if (sc.observed[k] === undefined) return { ok: false, why: 'no fall on ' + k };
    if (sc.observed[k] !== sc.expected[k]) return { ok: false, why: k + ' fell ' + sc.observed[k] + ' rows, expected ' + sc.expected[k] };
  }
  return { ok: true };
}

/* Observe the previous phase's deepest in-board fall and the refill offsets. */
function refillScenario(grid) {
  injectBoard(grid, { combo: 0 });
  C.beginClear();
  C.onClearDone();
  var fallMax = 0;
  for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) { var e = fxEntry(r, c); if (e && e.cls === 'fall') fallMax = Math.max(fallMax, -Number(e.vars['--fx-ny'])); }
  C.onFallDone();
  var drops = [];
  for (var r2 = 0; r2 < 8; r2++) for (var c2 = 0; c2 < 8; c2++) { var e2 = fxEntry(r2, c2); if (e2 && e2.cls === 'drop') drops.push({ r: r2, c: c2, ny: -Number(e2.vars['--fx-ny']) }); }
  return { phase: C.phase, fallMax: fallMax, drops: drops };
}

/* Fire `n` clear rounds back to back WITHOUT ageing anything out and report the
 * peak number of live decoration nodes. */
function nodeStress(n) {
  injectBoard(GRID_A, { combo: 0 });
  C.clearFxNodes();
  var maxSeen = 0;
  for (var i = 0; i < n; i++) {
    C.grid = GRID_A.map(function (row) { return row.slice(); });
    C.status = 'playing'; C.phase = 'idle'; C.combo = 0; C.cascadeDepth = 0;
    C.phaseElapsed = 0; C.phaseDuration = 0; C.pendingClear = null;
    C.config = { colors: 6, moves: 25, target: 100000 };
    C.rng = C.makeRng(i + 1);
    C.beginClear();
    if (C.fxNodes.length > maxSeen) maxSeen = C.fxNodes.length;
  }
  return maxSeen;
}

/* Let the frame clock run until every decoration has expired. */
function drainNodes(limit) {
  C.phase = 'idle';
  var guard = 0;
  while (C.fxNodes.length > 0 && guard < (limit || 800)) { env.step(); guard++; }
  return { left: C.fxNodes.length, frames: guard, layerKids: C.fxLayerEl.children.length };
}

/* -------------------------------------------------- swap slide offsets */
group('animation — the swap slides each tile home from the partner square');
{
  M3.newGame({ difficulty: 'normal', seed: 7 });
  var mv = C.findHintMove(C.grid);
  check('a legal swap exists on the seeded board', !!mv, json(mv));
  var r1 = mv[0], c1 = mv[1], r2 = mv[2], c2 = mv[3];
  clickCell(r1, c1); clickCell(r2, c2);
  check('the swap enters the swapping phase', C.phase === 'swapping', C.phase);
  var ea = fxEntry(r1, c1), eb = fxEntry(r2, c2);
  check('both swapped tiles carry the swap class', !!ea && ea.cls === 'swap' && !!eb && eb.cls === 'swap', json(fxClassSet()));
  check('the rendered cells carry the swap class too',
    /\bswap\b/.test(cellCls(r1, c1)) && /\bswap\b/.test(cellCls(r2, c2)), cellCls(r1, c1) + ' | ' + cellCls(r2, c2));
  var ax = Number(ea.vars['--fx-nx']), ay = Number(ea.vars['--fx-ny']);
  var bx = Number(eb.vars['--fx-nx']), by = Number(eb.vars['--fx-ny']);
  check('the two offsets are exact opposites', ax === -bx && ay === -by, json([ax, ay, bx, by]));
  check('each offset spans exactly one cell', Math.abs(ax) + Math.abs(ay) === 1 && Math.abs(bx) + Math.abs(by) === 1, json([ax, ay]));
  check('the tile now at A starts on B — the square the gem it shows came from (data layer already swapped)',
    ax === (c2 - c1) && ay === (r2 - r1), json([ax, ay, c2 - c1, r2 - r1]));
  check('the tile now at B starts on A', bx === (c1 - c2) && by === (r1 - r2), json([bx, by]));
  check('the slide reads its duration from --fx-ms', cellVar(r1, c1, '--fx-ms') === '190ms', cellVar(r1, c1, '--fx-ms'));
}

/* ------------------------------------- fall distance === rows fallen */
group('animation — fall offsets equal the true number of rows fallen');
{
  var sa = fallScenario(GRID_A), sb = fallScenario(GRID_B), sc = fallScenario(GRID_C);

  check('① the matches are the intended stacked run', json(sa.matched) === json([[2, 0], [3, 0], [4, 0]]), json(sa.matched));
  var oka = fallOk(sa);
  check('① every fall offset equals the reference distance', oka.ok, oka.why || json({ e: sa.expected, o: sa.observed }));
  check('① the two gems above the run fall exactly 3', sa.observed['3:0'] === 3 && sa.observed['4:0'] === 3, json(sa.observed));
  check('① the bottom of the column does not move', !sa.observed['5:0'] && !sa.observed['6:0'] && !sa.observed['7:0']);
  check('① untouched columns never animate', Object.keys(sa.observed).every(function (k) { return /:0$/.test(k); }), json(Object.keys(sa.observed)));
  check('① only moved tiles render the fall class', sa.cellsWithFallClass === Object.keys(sa.observed).length, sa.cellsWithFallClass + ' vs ' + Object.keys(sa.observed).length);
  check('① the render mirrors the table into --fx-ny', sa.varsMismatch.length === 0, json(sa.varsMismatch));

  check('② the matches are two separated middle runs',
    json(sb.matched) === json([[1, 2], [1, 3], [1, 4], [5, 2], [5, 3], [5, 4]]), json(sb.matched));
  var okb = fallOk(sb);
  check('② every fall offset equals the reference distance', okb.ok, okb.why || json({ e: sb.expected, o: sb.observed }));
  check('② a gem above two holes falls 2', sb.observed['2:2'] === 2 && sb.observed['2:3'] === 2 && sb.observed['2:4'] === 2, json(sb.observed));
  check('② gems between the two holes fall 1', sb.observed['3:3'] === 1 && sb.observed['4:3'] === 1 && sb.observed['5:3'] === 1, json(sb.observed));
  check('② the gems below the lower hole stay put', !sb.observed['6:3'] && !sb.observed['7:3']);
  check('② the render mirrors the table into --fx-ny', sb.varsMismatch.length === 0, json(sb.varsMismatch));

  var okc = fallOk(sc);
  check('③ every fall offset equals the reference distance', okc.ok, okc.why || json({ e: sc.expected, o: sc.observed }));
  check('③ clearing the top 5 of a column leaves nothing to fall in it',
    Object.keys(sc.observed).every(function (k) { return /:3$/.test(k); }), json(sc.observed));
  check('③ the shallow run still drops by 3, twice', sc.observed['3:3'] === 3 && sc.observed['4:3'] === 3, json(sc.observed));
}

/* ------------------------------------------------ refill drop distance */
group('animation — refill gems enter from above the board');
{
  var ra = refillScenario(GRID_A), rc = refillScenario(GRID_C);
  check('the refill phase is reached', ra.phase === 'refilling' && rc.phase === 'refilling', ra.phase + ',' + rc.phase);
  check('new gems exist after a clear', ra.drops.length > 0 && rc.drops.length > 0, ra.drops.length + ',' + rc.drops.length);
  // `ny` is the travel distance (positive); the tile is parked `ny` rows ABOVE
  // its landing row, i.e. it starts at row (landingRow - ny), which must be < 0
  // (above the top of the board).
  check('every refill gem starts ABOVE the board top (landing - offset < 0)',
    ra.drops.concat(rc.drops).every(function (d) { return (d.r - d.ny) < 0; }),
    json(ra.drops.concat(rc.drops).slice(0, 4)));
  var maxDrop = Math.max.apply(null, rc.drops.map(function (d) { return d.ny; }));
  check('the refill travel beats the deepest in-board fall (5 > 3)', maxDrop > rc.fallMax,
    'refill ' + maxDrop + ' vs fall ' + rc.fallMax);
  check('the refill reads its duration from --fx-ms',
    rc.drops.every(function (d) { return cellVar(d.r, d.c, '--fx-ms') === '220ms'; }));
}

/* ------------------------------------------------- lifecycle / cleanup */
group('animation — every effect is retired when its phase ends');
{
  function cls(k) { return fxClassSet()[k] || 0; }
  M3.newGame({ difficulty: 'normal', seed: 7 });
  var mv = C.findHintMove(C.grid);
  clickCell(mv[0], mv[1]); clickCell(mv[2], mv[3]);
  C.onSwapDone();
  check('after onSwapDone no swap class survives', cls('swap') === 0 && !anyCellHasClass('swap'), json(fxClassSet()));
  check('after onSwapDone the cleared tiles are in the clear state', cls('clear') >= 3, json(fxClassSet()));

  C.onClearDone();
  check('after onClearDone the clear class is gone from the table', cls('clear') === 0, json(fxClassSet()));
  check('after onClearDone NO tile is still visually clear (which would hide the gem)', !anyCellHasClass('clear'));

  C.onFallDone();
  check('after onFallDone no fall class survives', cls('fall') === 0 && !anyCellHasClass('fall'), json(fxClassSet()));
  check('after onFallDone the new gems are in the drop state', cls('drop') >= 1, json(fxClassSet()));

  var endedFrom = C.phase;
  C.onRefillDone();
  if (C.phase === 'clearing') {
    check('cascade: onRefillDone retires the drop class before the next round',
      cls('drop') === 0 && !anyCellHasClass('drop'), json(fxClassSet()));
  } else {
    check('move end: onRefillDone leaves NO residual animation class (fxAt cleared)',
      C.fxAt.length === 0 && !anyCellHasClass('drop') && !anyCellHasClass('fall') && !anyCellHasClass('clear'),
      'phase=' + C.phase + ' (arrived from ' + endedFrom + ') fx=' + json(fxClassSet()));
  }

  // illegal-swap path retires cleanly too
  M3.newGame({ difficulty: 'normal', seed: 11 });
  var pair = null;
  for (var r = 0; r < 8 && !pair; r++) for (var c = 0; c < 8 && !pair; c++) {
    if (c + 1 < 8 && !C.swapMakesMatch(C.grid, r, c, r, c + 1)) pair = [r, c, r, c + 1];
    else if (r + 1 < 8 && !C.swapMakesMatch(C.grid, r, c, r + 1, c)) pair = [r, c, r + 1, c];
  }
  clickCell(pair[0], pair[1]); clickCell(pair[2], pair[3]);
  check('the illegal swap enters the reverting phase', C.phase === 'reverting', C.phase);
  C.onRevertDone();
  check('after onRevertDone the board is idle with an empty fx table',
    C.phase === 'idle' && C.fxAt.length === 0 && !anyCellHasClass('bad'));
}

/* real pipeline: a clear class must never outlive its own round */
group('animation — across a real cascade no gem is stranded in the clear state');
{
  var moves = 0, fallingFrames = 0, clearLeaks = 0;
  for (var s = 1; s <= 400 && moves < 6; s++) {
    M3.newGame({ difficulty: 'easy', seed: s });
    var mv = C.findHintMove(C.grid);
    if (!mv) continue;
    clickCell(mv[0], mv[1]); clickCell(mv[2], mv[3]);
    var guard = 0;
    while (guard < 4000 && C.phase !== 'idle') {
      env.step(); guard++;
      if (C.phase === 'falling' || C.phase === 'refilling') {
        fallingFrames++;
        if (countCellsWithClass('clear') > 0) clearLeaks++;
      }
      if (C.status !== 'playing') break;
    }
    if (guard < 4000) moves++;
  }
  check('several moves really ran through falling/refilling', fallingFrames > 0 && moves >= 3, moves + ' moves, ' + fallingFrames + ' frames');
  check('no tile ever keeps the clear class while falling/refilling', clearLeaks === 0, clearLeaks);
}

/* ----------------------------------------------- node cap + recycling */
group('animation — decoration nodes are capped and fully recycled');
{
  var maxSeen = nodeStress(40);
  check('fxNodes never exceeds FX_MAX_NODES under stress', maxSeen <= C.FX_MAX_NODES, maxSeen + ' vs ' + C.FX_MAX_NODES);
  check('the cap actually trims the list', maxSeen === C.FX_MAX_NODES, maxSeen);
  var d = drainNodes(800);
  check('after enough frames every decoration is recycled (fxNodes -> 0)', d.left === 0, json(d));
  check('the decoration layer has no orphan children', d.layerKids === 0, d.layerKids);
}

/* ---------------------------------------------- combo + floating texts */
group('animation — combo threshold and the floating numbers');
{
  injectBoard(GRID_A, { combo: 0 });
  C.beginClear();
  var c1 = C.combo, cells1 = C.pendingClear.length;
  check('combo 1 spawns no combo pop', c1 === 1 && collectFxDesc('fx-combo').length === 0, 'combo=' + c1);
  var fl1 = collectFxDesc('fx-float');
  check('combo 1 spawns exactly one score float', fl1.length === 1, fl1.length);
  check('the score float is +cells*10*combo',
    fl1.length === 1 && fl1[0].textContent === '+' + (cells1 * 10 * c1), fl1[0] && fl1[0].textContent);

  injectBoard(GRID_A, { combo: 1 });
  C.beginClear();
  var c2 = C.combo, cells2 = C.pendingClear.length;
  var pop = collectFxDesc('fx-combo');
  check('combo 2 spawns exactly one combo pop', c2 === 2 && pop.length === 1, 'combo=' + c2 + ' pops=' + pop.length);
  check('the combo pop text encodes the combo number', pop.length === 1 && pop[0].textContent === '\u00d7' + c2, pop[0] && pop[0].textContent);
  var fl2 = collectFxDesc('fx-float');
  check('combo 2 doubles the award displayed',
    fl2.length === 1 && fl2[0].textContent === '+' + (cells2 * 10 * c2), fl2[0] && fl2[0].textContent);
}

/* -------------------------------------------------------- board shake */
group('animation — the board only shakes on a chain, then settles');
{
  injectBoard(GRID_A, { combo: 0 });
  C.beginClear();
  check('no shake on the first clear round', C.boardShakeTtl === 0 && !C.boardEl._cls.has('shake'), C.boardShakeTtl);

  injectBoard(GRID_A, { combo: 1 });
  C.beginClear();
  check('the board shakes from the second round on', C.boardEl._cls.has('shake') && C.boardShakeTtl > 0, C.boardShakeTtl);
  check('the rendered #board carries the shake class', /(^|\s)shake(\s|$)/.test(C.boardEl.className), C.boardEl.className);
  drainNodes(400);
  check('the shake timer decays to 0', C.boardShakeTtl === 0, C.boardShakeTtl);
  check('the shake class is removed when the timer expires', !C.boardEl._cls.has('shake'), C.boardEl.className);
}

/* ------------------------------------------ plays without an fx layer */
group('animation — the game still plays with NO decoration layer');
{
  var saved = C.fxLayerEl;
  var threw = null;
  C.fxLayerEl = null;
  try {
    M3.newGame({ difficulty: 'normal', seed: 7 });
    var mv = C.findHintMove(C.grid);
    var sc0 = C.score, mv0 = C.moves;
    clickCell(mv[0], mv[1]); clickCell(mv[2], mv[3]);
    var guard = 0;
    while (guard < 3000 && C.phase !== 'idle') { env.step(); guard++; }
    check('a full move still resolves to idle without the fx layer', C.phase === 'idle', C.phase);
    check('the move still scored', C.score > sc0, C.score);
    check('exactly one move was spent', C.moves === mv0 - 1, C.moves);
    check('nothing could be attached (fxNodes stays empty)', C.fxNodes.length === 0, C.fxNodes.length);
  } catch (e) { threw = e; }
  check('no exception is thrown when the fx layer is absent', threw === null, threw && threw.message);
  C.fxLayerEl = saved;
  M3.newGame({ difficulty: 'normal', seed: 1 });
}

/* ============================= reverse checks (prove assertions are live) */
group('reverse checks (in-process) — the suite catches broken rules');
{
  // 1) findMatches cut to >= 4 must break the basic 3-match assertions AND the
  //    differential comparison.
  const origFind = C.findMatches;
  C.findMatches = brokenFindMin4;
  let gm = C.findMatches([[0, 0, 0]]);
  check('reverse: findMatches(>=4) drops a plain horizontal 3', gm.length === 0, json(gm));
  let disagree = 0;
  for (const g of [[[0, 0, 0], [1, 1, 1], [2, 2, 2]], [[0, 1, 0], [0, 1, 0], [0, 1, 0]], [[0, 0, 1], [0, 1, 0], [1, 0, 0]]]) {
    if (C.findMatches(g).length !== refFindMatches(g).length) disagree++;
  }
  check('reverse: broken findMatches disagrees with the reference', disagree > 0, disagree);
  C.findMatches = origFind;
  check('restored findMatches matches the reference again',
    json(cellSetNodes(C.findMatches([[0, 0, 0]]))) === json(cellSetNodes(refFindMatches([[0, 0, 0]]))));
  function cellSetNodes(a) { return a.map(p => p[0] + ':' + p[1]).sort(); }

  // 2) applyGravity that forgets the middle gem must break the order assertion.
  const origGrav = C.applyGravity;
  C.applyGravity = function (g) {
    const h = g.length, w = g[0].length;
    const out = g.map(row => row.map(() => null));
    for (let c = 0; c < w; c++) {
      const vals = [];
      for (let r = 0; r < h; r++) { const v = g[r][c]; if (v !== null && v !== undefined) vals.push(v); }
      // BROKEN: fills from the bottom using the column read top-to-bottom,
      // which reverses the gems' relative order.
      let write = h - 1;
      for (let i = 0; i < vals.length; i++) { out[write][c] = vals[i]; write--; }
    }
    return out;
  };
  const bg = C.applyGravity([[5], [null], [null], [3], [7]]);
  const bseq = bg.map(r => r[0]).filter(v => v !== null);
  check('reverse: gravity that drops a middle gem loses the order', json(bseq) !== json([5, 3, 7]), json(bseq));
  C.applyGravity = origGrav;
  const rg = C.applyGravity([[5], [null], [null], [3], [7]]);
  check('restored gravity keeps the order', json(rg.map(r => r[0]).filter(v => v !== null)) === json([5, 3, 7]));

  // 3) A findMatches that double-counts the cross would break the de-dup test.
  const origFind2 = C.findMatches;
  C.findMatches = function (g) {
    const h = g.length; let w = 0; for (let r = 0; r < h; r++) if (g[r] && g[r].length > w) w = g[r].length;
    const at = (r, c) => (r < 0 || r >= h || !g[r] || c < 0 || c >= g[r].length) ? null : g[r][c];
    const out = [];
    for (let r = 0; r < h; r++) for (let c = 0; c + 2 < w; c++) if (at(r, c) !== null && at(r, c) === at(r, c + 1) && at(r, c) === at(r, c + 2)) { out.push([r, c], [r, c + 1], [r, c + 2]); }
    for (let c = 0; c < w; c++) for (let r = 0; r + 2 < h; r++) if (at(r, c) !== null && at(r, c) === at(r + 1, c) && at(r, c) === at(r + 2, c)) { out.push([r, c], [r + 1, c], [r + 2, c]); }
    return out;
  };
  const cross = [[0, 1, 1], [0, 0, 0], [0, 1, 1]].map((row, r) => row.map((v, c) => ((r === 1 || c === 0) ? 0 : v)));
  const dbl = C.findMatches(cross);
  check('reverse: a non-de-duplicating cross matcher reports duplicates', dbl.length !== cellSet(dbl).size, `${dbl.length} vs ${cellSet(dbl).size}`);
  C.findMatches = origFind2;
  const rcross = C.findMatches(cross);
  check('restored findMatches de-duplicates the cross', rcross.length === cellSet(rcross).size && rcross.length === 5, `${rcross.length}`);
}

/* ======= reverse checks (in-process) — the ANIMATION assertions are live ===
 * Each one deliberately breaks a piece of the new animation contract and shows
 * the matching assertion above would go red, then restores it. The external
 * (file-level) break/restore proof lives in the QA report. */
group('reverse checks — the animation assertions catch broken offsets / cleanup / caps');
{
  // 1) a hard-wired fall offset must be caught by the fall-distance assertion.
  const origFall = C.applyFallFx;
  C.applyFallFx = function (before) {
    for (var r = 0; r < 8; r++) for (var c = 0; c < 8; c++) {
      if (C.cellVal(before, r, c) !== null) C.setFx(r, c, 'fall', { '--fx-ny': -1, '--fx-ms': '300ms' });
    }
  };
  const brokenFall = fallScenario(GRID_A);
  check('reverse: a hard-wired -1 fall offset disagrees with the reference', !fallOk(brokenFall).ok, json(brokenFall.observed));
  C.applyFallFx = origFall;
  check('restored applyFallFx agrees with the reference again', fallOk(fallScenario(GRID_A)).ok);

  // 2) dropping clearFx() from onClearDone must leave the invisible clear class.
  const origClearDone = C.onClearDone;
  C.onClearDone = function () {
    var i;
    for (i = 0; i < C.pendingClear.length; i++) C.grid[C.pendingClear[i][0]][C.pendingClear[i][1]] = null;
    C.pendingClear = null;
    C.grid = C.applyGravity(C.grid);            // BUG: clearFx() deliberately omitted
    C.phase = 'falling'; C.phaseElapsed = 0; C.phaseDuration = 300; C.render();
  };
  injectBoard(GRID_A, { combo: 0 }); C.beginClear(); C.onClearDone();
  check('reverse: a missing clearFx leaves the invisible clear class on the board', countCellsWithClass('clear') > 0, countCellsWithClass('clear'));
  C.onClearDone = origClearDone;
  injectBoard(GRID_A, { combo: 0 }); C.beginClear(); C.onClearDone();
  check('restored onClearDone retires the clear class', countCellsWithClass('clear') === 0);

  // 3) an unbounded budget must let the decoration list blow past the cap.
  const origCap = C.FX_MAX_NODES;
  C.FX_MAX_NODES = 100000;
  const unbounded = nodeStress(40);
  C.FX_MAX_NODES = origCap;
  check('reverse: without a cap the node list grows well past 90', unbounded > 90, unbounded);
  check('restored cap trims the list to <= 90 again', nodeStress(40) <= 90);

  // 4) a neutered ageFxNodes must leak (nothing is ever recycled).
  const origAge = C.ageFxNodes;
  C.ageFxNodes = function () {};
  injectBoard(GRID_A, { combo: 0 }); C.beginClear();
  const leaked = drainNodes(200);
  check('reverse: with aging disabled the nodes never get recycled', leaked.left > 0, json(leaked));
  C.ageFxNodes = origAge;
  injectBoard(GRID_A, { combo: 0 }); C.beginClear();
  check('restored aging recycles every node', drainNodes(800).left === 0);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
