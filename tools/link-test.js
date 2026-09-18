#!/usr/bin/env node
/**
 * Logic tests for link-game (Lianliankan).
 *
 * The smoke test only proves the page does not throw. It cannot tell whether
 * a two-turn path is judged correctly, whether the outer ring is really
 * traversable, whether shuffle preserves the multiset of faces, whether the
 * combo window and the score clamp behave, or whether the HUD text follows
 * the language. This suite loads the whole inline script in a vm sandbox
 * (top-level `var`/`function` declarations land on the context global, so
 * internal state is readable) and asserts the rules through the game's own
 * bridge object `window.LL` and its real UI entry points.
 *
 * The centrepiece is DIFFERENTIAL testing: the game connects tiles with
 * "three-segment enumeration" (0 turns / two 1-turn candidates / shared-row
 * and shared-column 2-turn enumeration). The reference implementation here is
 * an INDEPENDENT BFS over states (position, direction, turns-used) on the
 * same (rows+2)x(cols+2) extended grid — a completely different shape that
 * shares zero code. Small boards are enumerated EXHAUSTIVELY, so every
 * corner / ring / blockade layout is hit; connectivity must agree on every
 * pair. Paths the game does return are additionally validated GEOMETRICALLY
 * (correct extended endpoints, axis-aligned non-redundant waypoints, every
 * intermediate cell empty, at most 4 points).
 *
 * Reverse checks then deliberately break the path rule / the shuffle
 * guarantee / the language callback in-process and confirm the matching
 * assertions would go red, proving the suite is not vacuously green.
 *
 * Usage:  node tools/link-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'link-game', 'index.html');
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
 * Faithful enough for the game: lazy getElementById, real child lists,
 * addEventListener/fire, a style object that actually stores setProperty
 * values (and reads them back), a rAF hook driven by hand with explicit
 * timestamps so the frame clock can be fast-forwarded, getItem/setItem-only
 * localStorage. */
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
  let now = 0;

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
    /* Pump one frame; dt is delivered through the rAF timestamp so the game's
     * clock math (`ts - lastFrameTs`) sees exactly the requested delta. */
    step(dt) { now += (dt === undefined ? 16 : dt); const f = frame; frame = null; if (f) f(now); },
    steps(n, dt) { for (let i = 0; i < n; i++) this.step(dt); }
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
    vm.runInContext(s, env.context, { filename: `link#${i}` }));
  /* One warm-up frame: the first rAF call has no previous timestamp and
   * always uses the nominal 16 ms; afterwards step(dt) is exact. */
  env.step();
  return env;
}

const env = boot();
const C = env.context;
const LL = C.LL;
const el = id => env.context.document.getElementById(id);

/* ------------------------------------------------------------- test helpers */
function mkBoard(rows, cols, fill) {
  const g = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(fill === undefined ? null : fill);
    g.push(row);
  }
  return g;
}

/* A local deterministic rng for generating random test boards (independent of
 * the game's own makeRng on purpose). */
function localRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function () {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function randBoard(h, w, kinds, nullProb, rnd) {
  const g = mkBoard(h, w);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    g[r][c] = (rnd() < nullProb) ? null : Math.floor(rnd() * kinds);
  }
  return g;
}

/* The mixed-pairs board: 8x8, every value appears exactly twice, horizontally
 * adjacent — every pair is 0-turn linkable, deadlocks are impossible. */
function pairsBoard() {
  const g = mkBoard(8, 8);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) g[r][c] = r * 4 + Math.floor(c / 2);
  return g;
}

/* Reset the whole machine onto a crafted board (same idea as the match-3
 * suite): dimensions, clocks, counters and DOM all consistent. */
function injectState(board, opts) {
  opts = opts || {};
  const h = board.length, w = board[0].length;
  C.rows = h; C.cols = w;
  C.config = { rows: h, cols: w, kinds: 12, time: 600 };
  C.grid = board.map(row => row.slice());
  let live = 0;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (board[r][c] != null) live++;
  C.totalPairs = live / 2;
  C.pairsLeft = live / 2;
  C.score = opts.score === undefined ? 0 : opts.score;
  C.best = 0;
  C.comboLevel = 0; C.comboUntil = 0; C.playClock = 0;
  C.timeLeft = (opts.time === undefined ? 600 : opts.time) * 1000;
  C.hintsLeft = opts.hints === undefined ? 3 : opts.hints;
  C.selected = null;
  C.endWin = false; C.endBonus = 0;
  C.phase = 'idle'; C.phaseElapsed = 0; C.phaseDuration = 0;
  C.clearingPair = null; C.denyCells = null; C.denyTimer = 0;
  C.hintCells = null; C.hintTimer = 0;
  C.noticeKey = 'play'; C.noticeVars = null;
  C.diffKey = opts.difficulty || 'normal';
  C.rng = C.makeRng(opts.seed === undefined ? 12345 : opts.seed);
  C.clearFx(); C.clearFxNodes(); C.removeLink();
  C.status = 'playing';
  C.buildDom();
  if (C.startOverlay) C.startOverlay.classList.remove('show');
  if (C.overlay) C.overlay.classList.remove('show');
  C.updateHud();
  C.render();
}

function tap(r, c) { env.els.board.fire('click', { target: C.tileEls[r][c] }); }

/* Collect the text of every node carrying `cls` under any live fx node. */
function fxTexts(cls) {
  const out = [];
  function walk(n) {
    if (!n) return;
    if (n._cls && n._cls.has(cls)) out.push(n.textContent);
    (n.children || []).forEach(walk);
  }
  for (const node of C.fxNodes) walk(node.el);
  return out;
}

/* =====================================================================
 * INDEPENDENT reference implementation — BFS over (position, direction,
 * turns-used) on the extended grid. Shares no code with the game (which
 * enumerates three-segment shapes instead). Semantics:
 *   - tiles live at extended coords (1..h, 1..w); the outer ring
 *     (row/col 0 and h+1/w+1) is always empty;
 *   - a path may not pass through any tile; the two endpoint tiles
 *     themselves are passable as endpoints;
 *   - at most `maxTurns` direction changes (default 2).
 * =================================================================== */
function refCanConnect(board, r1, c1, r2, c2, maxTurns) {
  if (maxTurns === undefined) maxTurns = 2;
  const h = board.length, w = board[0].length;
  const v1 = board[r1][c1], v2 = board[r2][c2];
  if (v1 == null || v2 == null || v1 !== v2) return false;
  if (r1 === r2 && c1 === c2) return false;

  const H = h + 2, W = w + 2;
  const SR = r1 + 1, SC = c1 + 1, TR = r2 + 1, TC = c2 + 1;
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  /* Occupancy of the extended grid: null = empty (ring always, cleared cells),
   * anything else = a tile. Out of bounds is a wall. */
  const occ = (r, c) => {
    if (r < 0 || r >= H || c < 0 || c >= W) return -1;
    if (r === 0 || r === h + 1 || c === 0 || c === w + 1) return null;
    const v = board[r - 1][c - 1];
    return (v == null) ? null : v;
  };

  /* best[(r*W+c)*4+d] = fewest turns seen to be AT (r,c) heading dir d. */
  const best = new Int8Array(H * W * 4).fill(9);
  const queue = [];
  let head = 0;

  /* Pre-expand the start: the first segment in any direction costs 0 turns. */
  for (let d = 0; d < 4; d++) {
    const nr = SR + DIRS[d][0], nc = SC + DIRS[d][1];
    const cell = occ(nr, nc);
    if (cell !== null && !(nr === TR && nc === TC)) continue;   // blocked
    const key = (nr * W + nc) * 4 + d;
    best[key] = 0;
    queue.push(nr, nc, d, 0);
  }

  while (head < queue.length) {
    const r = queue[head++], c = queue[head++], d = queue[head++], t = queue[head++];
    if (t > best[(r * W + c) * 4 + d]) continue;               // stale entry
    if (r === TR && c === TC) return true;                     // never expanded
    for (let d2 = 0; d2 < 4; d2++) {
      const t2 = t + (d2 === d ? 0 : 1);
      if (t2 > maxTurns) continue;
      const nr = r + DIRS[d2][0], nc = c + DIRS[d2][1];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const cell = occ(nr, nc);
      if (cell !== null && !(nr === TR && nc === TC)) continue; // blocked
      const key = (nr * W + nc) * 4 + d2;
      if (t2 < best[key]) {
        best[key] = t2;
        queue.push(nr, nc, d2, t2);
      }
    }
  }
  return false;
}

/* Brute-force "is there any linkable pair on this board" using the reference
 * connectivity only — the cross-check for LL.findPair. */
function refFindAnyPair(board) {
  const h = board.length, w = board[0].length;
  const cells = [];
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (board[r][c] != null) cells.push([r, c]);
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      if (board[a[0]][a[1]] === board[b[0]][b[1]] &&
          refCanConnect(board, a[0], a[1], b[0], b[1])) return [a, b];
    }
  }
  return null;
}

/* Geometric validation of a path returned by the game, in EXTENDED coords:
 * endpoints a+1 / b+1, axis-aligned segments, non-redundant waypoints, every
 * strictly-interior cell empty (the ring is always empty), <= 4 points. */
function extEmpty(board, r, c) {
  const h = board.length, w = board[0].length;
  if (r === 0 || r === h + 1 || c === 0 || c === w + 1) return true;
  const v = board[r - 1][c - 1];
  return v == null;
}

function validatePath(board, a, b, path) {
  const h = board.length, w = board[0].length;
  const bad = why => ({ ok: false, why });
  if (!Array.isArray(path)) return bad('path is not an array');
  if (path.length < 2 || path.length > 4) return bad('point count ' + path.length);
  if (path[0][0] !== a[0] + 1 || path[0][1] !== a[1] + 1) return bad('start point ' + json(path[0]) + ' != a+1');
  const last = path[path.length - 1];
  if (last[0] !== b[0] + 1 || last[1] !== b[1] + 1) return bad('end point ' + json(last) + ' != b+1');
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (p[0] < 0 || p[0] > h + 1 || p[1] < 0 || p[1] > w + 1) return bad('waypoint outside extended grid ' + json(p));
  }
  for (let i = 0; i + 1 < path.length; i++) {
    const p1 = path[i], p2 = path[i + 1];
    if (p1[0] !== p2[0] && p1[1] !== p2[1]) return bad('segment ' + i + ' not axis-aligned');
  }
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1], cur = path[i], nxt = path[i + 1];
    const collinear = (prev[0] === cur[0] && cur[0] === nxt[0]) || (prev[1] === cur[1] && cur[1] === nxt[1]);
    if (collinear) return bad('redundant collinear waypoint ' + json(cur));
    if (!extEmpty(board, cur[0], cur[1])) return bad('waypoint lands on a tile ' + json(cur));
  }
  for (let i = 0; i + 1 < path.length; i++) {
    const s = path[i], e = path[i + 1];
    if (s[0] === e[0]) {
      const lo = Math.min(s[1], e[1]) + 1, hi = Math.max(s[1], e[1]);
      for (let c2 = lo; c2 < hi; c2++) if (!extEmpty(board, s[0], c2)) return bad('segment blocked at [' + s[0] + ',' + c2 + ']');
    } else {
      const lo = Math.min(s[0], e[0]) + 1, hi = Math.max(s[0], e[0]);
      for (let r2 = lo; r2 < hi; r2++) if (!extEmpty(board, r2, s[1])) return bad('segment blocked at [' + r2 + ',' + s[1] + ']');
    }
  }
  return { ok: true };
}

/* ====================================================== the bridge / surface */
group('bridge object and surface');
check('LL is exposed', !!LL && typeof LL === 'object');
check('LL.canConnect / LL.findPath are functions', typeof LL.canConnect === 'function' && typeof LL.findPath === 'function');
check('LL.findPair / LL.shuffle / LL.newGame / LL.getState are functions',
  typeof LL.findPair === 'function' && typeof LL.shuffle === 'function' &&
  typeof LL.newGame === 'function' && typeof LL.getState === 'function');
check('LL.rows / LL.cols are live getters (default normal 8x8)', LL.rows === 8 && LL.cols === 8, `${LL.rows}x${LL.cols}`);
{
  const s0 = LL.getState();
  check('getState() shape is complete',
    s0 && typeof s0.status === 'string' && Array.isArray(s0.board) && typeof s0.score === 'number' &&
    typeof s0.timeLeft === 'number' && typeof s0.pairsLeft === 'number' && typeof s0.combo === 'number' &&
    typeof s0.hintsLeft === 'number' && 'selected' in s0 && typeof s0.lang === 'string' &&
    typeof s0.rows === 'number' && typeof s0.cols === 'number' && typeof s0.phase === 'string',
    json(Object.keys(s0)));
  check('the state machine boots idle', s0.phase === 'idle', s0.phase);
  /* findPath and canConnect are documented to be the same implementation. */
  const a = [0, 0];
  let same = true;
  for (let r = 0; r < 8 && same; r++) for (let c = 0; c < 8 && same; c++) {
    const b = [r, c];
    if (json(LL.findPath(a, b)) !== json(LL.canConnect(a, b))) same = false;
  }
  check('findPath and canConnect return identical results everywhere on the boot board', same);
}

/* ============================================== path rule — hand-built cases */
group('path rule — turn budget, outer ring, and blockades');
{
  /* 0 turns, adjacent. */
  C.grid = [[5, 5]];
  let p = LL.canConnect([0, 0], [0, 1]);
  check('adjacent same-pattern tiles connect (0 turns)', !!p, json(p));
  check('the adjacent path is exactly the two endpoints in extended coords',
    json(p) === json([[1, 1], [1, 2]]), json(p));

  /* 0 turns through empty cells. */
  C.grid = [[7, null, null, 7]];
  check('a clear straight line connects (0 turns through empties)', !!LL.canConnect([0, 0], [0, 3]));

  /* 1 turn around an empty corner. */
  C.grid = [[5, null], [null, 5]];
  p = LL.canConnect([0, 0], [1, 1]);
  check('a one-corner route connects (1 turn)', !!p, json(p));
  check('the 1-turn path is the minimal corner list', p.length === 3, json(p));

  /* 2 turns through an empty interior row. */
  C.grid = [[5, 1, 1, 1], [null, null, null, null], [1, 1, 1, 5]];
  p = LL.canConnect([0, 0], [2, 3]);
  check('a detour through an empty row connects (2 turns)', !!p, json(p));
  check('the 2-turn path has at most 4 points', p.length === 4, json(p));

  /* Same pattern blocked on the straight line but linkable around. */
  C.grid = [[5, 0, 5], [null, null, null]];
  check('same pattern with the direct line blocked still connects around',
    !!LL.canConnect([0, 0], [0, 2]));

  /* Different patterns never connect. */
  C.grid = [[3, 4]];
  check('different patterns never connect', LL.canConnect([0, 0], [0, 1]) === null);

  /* Out-of-range / same-cell guards. */
  C.grid = mkBoard(3, 3, 1);
  check('out-of-range coordinates return null', LL.canConnect([0, 0], [5, 5]) === null);
  check('a tile does not connect to itself', LL.canConnect([1, 1], [1, 1]) === null);
  check('a cleared cell does not connect', (C.grid[1][1] = null, LL.canConnect([1, 0], [1, 1])) === null);

  /* -------------------------------------------------- the outer ring cases */
  /* A FULL 5x5 board: every interior cell is occupied. */
  const full5 = mkBoard(5, 5, 1);

  /* Same-edge pairs hug that edge's ring: always linkable. */
  const edgeCases = [
    ['top edge', [[0, 1], [0, 3]]],
    ['top edge far ends', [[0, 0], [0, 4]]],
    ['bottom edge', [[4, 1], [4, 3]]],
    ['left edge', [[1, 0], [3, 0]]],
    ['left edge far ends', [[0, 0], [4, 0]]],
    ['right edge', [[1, 4], [3, 4]]]
  ];
  let edgesOk = 0;
  for (const [name, [a, b]] of edgeCases) {
    const g = full5.map(row => row.slice());
    g[a[0]][a[1]] = 9; g[b[0]][b[1]] = 9;
    C.grid = g;
    const path = LL.canConnect(a, b);
    const geo = path ? validatePath(g, a, b, path) : { ok: false, why: 'null' };
    if (!!path && geo.ok) edgesOk++;
    else check(`same-edge border pair must link around the ring — ${name}`, false, json({ path, why: geo.why }));
  }
  check(`all ${edgeCases.length} same-edge border pairs link around the outer ring`, edgesOk === edgeCases.length);

  /* Cross-side / diagonal pairs on a FULL board need MORE than two turns:
   * the ring can only be hugged on one side, and leaving it straight into the
   * board is blocked. Both implementations must agree they are NOT linkable,
   * while a higher-turn reference search proves the blockade is exactly the
   * turn limit (3 turns for diagonal corners / adjacent sides, 4 for the
   * middle-row / middle-column span). */
  const threeTurnCases = [
    ['diagonal corners (needs 3 turns)', [[0, 0], [4, 4]], 3],
    ['same middle row, opposite ends (needs 4 turns)', [[2, 0], [2, 4]], 4],
    ['same middle column, opposite ends (needs 4 turns)', [[0, 2], [4, 2]], 4],
    ['adjacent sides (top row + left col, needs 3 turns)', [[0, 3], [2, 0]], 3]
  ];
  let threeOk = 0;
  for (const [name, [a, b], need] of threeTurnCases) {
    const g = full5.map(row => row.slice());
    g[a[0]][a[1]] = 9; g[b[0]][b[1]] = 9;
    C.grid = g;
    const path = LL.canConnect(a, b);
    const refBelow = refCanConnect(g, a[0], a[1], b[0], b[1], need - 1);
    const refAt = refCanConnect(g, a[0], a[1], b[0], b[1], need);
    if (path === null && refBelow === false && refAt === true) threeOk++;
    else check(`multi-turn-only pair must be refused — ${name}`, false,
      json({ path, refBelow, refAt }));
  }
  check(`all ${threeTurnCases.length} multi-turn-only pairs are refused by the game AND the reference (a higher-turn search finds them)`, threeOk === threeTurnCases.length);

  /* An interior tile with all four neighbours occupied can never be linked. */
  const cage = mkBoard(5, 5, 1);
  cage[2][2] = 0; cage[0][0] = 0;           // the pair under test
  cage[1][2] = 2; cage[3][2] = 2; cage[2][1] = 2; cage[2][3] = 2;  // the cage
  C.grid = cage;
  check('an interior tile boxed in on all four sides cannot be linked',
    LL.canConnect([2, 2], [0, 0]) === null);
  check('the reference agrees the boxed-in tile is dead',
    refCanConnect(cage, 2, 2, 0, 0) === false);
}

/* ================================== DIFFERENTIAL (the important bit) ========= */
group('differential — game three-segment enumeration vs an independent BFS');
{
  function* enumBoards(h, w, alphabet) {
    const n = h * w, base = alphabet.length;
    const total = Math.pow(base, n);
    for (let i = 0; i < total; i++) {
      const g = [];
      let x = i;
      for (let r = 0; r < h; r++) {
        const row = [];
        for (let c = 0; c < w; c++) { row.push(alphabet[x % base]); x = Math.floor(x / base); }
        g.push(row);
      }
      yield g;
    }
  }

  let grandPairs = 0, grandMismatch = 0, grandGeo = 0, grandGeoBad = 0, grandSymBad = 0, grandCross = 0;

  function runCorpus(name, boardList) {
    let pairs = 0, mismatch = 0, geoChecked = 0, geoBad = 0, symBad = 0, cross = 0;
    let exDiff = null, exGeo = null, symTotal = 0;
    for (let bi = 0; bi < boardList.length; bi++) {
      const b = boardList[bi];
      const h = b.length, w = b[0].length;
      C.grid = b;                       // canConnect reads the live grid
      const byVal = {};
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
        const v = b[r][c];
        if (v == null) continue;
        (byVal[v] = byVal[v] || []).push([r, c]);
      }
      for (const key of Object.keys(byVal)) {
        const list = byVal[key];
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i], p = list[j];
            pairs++;
            const gp = LL.canConnect(a, p);
            const rp = refCanConnect(b, a[0], a[1], p[0], p[1]);
            if (!!gp !== rp) {
              mismatch++;
              if (!exDiff) exDiff = json(b) + ' pair ' + json(a) + json(p) + ` game=${!!gp} ref=${rp}`;
            }
            if (gp) {
              geoChecked++;
              const geo = validatePath(b, a, p, gp);
              if (!geo.ok) { geoBad++; if (!exGeo) exGeo = geo.why + ' on ' + json(b); }
            }
            if (pairs % 53 === 0) {
              symTotal++;
              const rev = LL.canConnect(p, a);
              if (!!rev !== !!gp) symBad++;
            }
          }
        }
      }
      /* A few different-pattern pairs per board: must be null on both sides. */
      const vals = Object.keys(byVal);
      if (vals.length >= 2) {
        for (let k = 0; k + 1 < vals.length && k < 3; k++) {
          const a = byVal[vals[k]][0], p = byVal[vals[k + 1]][0];
          cross++;
          if (LL.canConnect(a, p) !== null) { mismatch++; if (!exDiff) exDiff = 'cross-value pair connected ' + json([a, p]); }
        }
      }
    }
    grandPairs += pairs; grandMismatch += mismatch; grandGeo += geoChecked;
    grandGeoBad += geoBad; grandSymBad += symBad; grandCross += cross;
    check(`connectivity agrees on all ${pairs} same-pattern pairs — ${name}`, mismatch === 0, exDiff || `${mismatch} disagree`);
    check(`every returned path is geometrically valid — ${name}`, geoBad === 0, exGeo || `${geoBad} bad of ${geoChecked}`);
    check(`connectivity is symmetric (sampled ${symTotal}) — ${name}`, symBad === 0, `${symBad}`);
    void cross;
    console.log(`  ...  ${name}: ${boardList.length} boards, ${pairs} pairs, ${geoChecked} paths geometry-checked`);
  }

  runCorpus('exhaustive 3x3 over {0,1}', [...enumBoards(3, 3, [0, 1])]);
  runCorpus('exhaustive 3x3 over {null,0,1}', [...enumBoards(3, 3, [null, 0, 1])]);
  runCorpus('exhaustive 2x5 over {0,1}', [...enumBoards(2, 5, [0, 1])]);
  runCorpus('exhaustive 3x4 over {0,1}', [...enumBoards(3, 4, [0, 1])]);

  {
    const rnd = localRng(20260401);
    const boards = [];
    for (let i = 0; i < 250; i++) boards.push(randBoard(6, 6, 6, 0.25, rnd));
    runCorpus('random 6x6 (6 kinds, 25% cleared)', boards);
  }
  {
    const rnd = localRng(20260402);
    const boards = [];
    for (let i = 0; i < 150; i++) boards.push(randBoard(8, 8, 10, 0.25, rnd));
    runCorpus('random 8x8 (10 kinds, 25% cleared)', boards);
  }

  check('TOTAL: 0 connectivity disagreements across the whole corpus', grandMismatch === 0, `${grandMismatch}`);
  check('TOTAL: 0 invalid paths across the whole corpus', grandGeoBad === 0, `${grandGeoBad}`);
  check('TOTAL: 0 asymmetries across the whole corpus', grandSymBad === 0, `${grandSymBad}`);
  check('the corpus is non-trivial (>= 20000 single-point comparisons)', grandPairs >= 20000, grandPairs);
  check('the corpus really validated game-returned paths (>= 2000 geometry checks)', grandGeo >= 2000, grandGeo);
  console.log(`  ...  grand total: ${grandPairs} pair comparisons, ${grandGeo} path geometry validations, mismatch=${grandMismatch}, invalid=${grandGeoBad}`);
}

/* ================================= findPair vs brute force (reference only) */
group('findPair — agrees with an exhaustive brute force');
{
  const rnd = localRng(777);
  let n = 0, bad = 0, nulls = 0, ex = null;
  const cases = [];
  /* The classic dead 2x2 checkerboard: no pair is linkable at all. */
  cases.push([[0, 1], [1, 0]]);
  /* No value appears twice -> nothing to link. */
  cases.push([[0, 1, 2], [3, 4, 5]]);
  for (let i = 0; i < 100; i++) cases.push(randBoard(3 + (i % 3), 4 + (i % 2), 4, 0.2, rnd));

  for (const b of cases) {
    n++;
    C.grid = b;                         // LL.canConnect reads the live grid
    const fp = LL.findPair(b);
    const brute = refFindAnyPair(b);
    if (fp === null) {
      nulls++;
      if (brute !== null) { bad++; if (!ex) ex = 'findPair=null but brute found ' + json(brute) + ' on ' + json(b); }
    } else {
      const v1 = b[fp[0][0]][fp[0][1]], v2 = b[fp[1][0]][fp[1][1]];
      const okPair = v1 != null && v1 === v2 &&
        refCanConnect(b, fp[0][0], fp[0][1], fp[1][0], fp[1][1]) &&
        !!LL.canConnect(fp[0], fp[1]);
      if (!okPair || brute === null) { bad++; if (!ex) ex = 'findPair returned ' + json(fp) + ' on ' + json(b); }
    }
  }
  check(`findPair and the brute force agree on all ${n} boards (null iff no pair exists)`, bad === 0, ex || `${bad}`);
  check('some boards in the corpus really were dead (the null branch was exercised)', nulls >= 1, nulls);
  check('the 2x2 checkerboard is dead for the game too', LL.findPair([[0, 1], [1, 0]]) === null);
}

/* ================================================================ shuffle */
group('shuffle — pure, multiset-preserving, and always leaves a live pair');
{
  const sortedVals = b => b.flat().filter(v => v != null).slice().sort((x, y) => x - y).join(',');
  const nullMask = b => b.map(row => row.map(v => v == null ? '.' : 'x').join('')).join('|');

  const dead = [[0, 1], [1, 0]];
  check('the known dead board starts with no linkable pair', LL.findPair(dead) === null);

  let mutated = 0, multisetBad = 0, maskBad = 0, unsolved = 0, trivial = 0;
  for (let s = 1; s <= 25; s++) {
    C.rng = C.makeRng(s * 7919);
    const before = json(dead);
    const out = LL.shuffle(dead);
    if (json(dead) !== before) mutated++;
    if (sortedVals(out) !== sortedVals(dead)) multisetBad++;
    if (nullMask(out) !== nullMask(dead)) maskBad++;
    if (LL.findPair(out) === null) unsolved++;
    else trivial++;
  }
  check('shuffle never mutates its argument (25 runs on the dead board)', mutated === 0, mutated);
  check('shuffle preserves the multiset of faces', multisetBad === 0, multisetBad);
  check('shuffle permutes faces over the same occupied cells', maskBad === 0, maskBad);
  check('every shuffle of the dead board leaves a linkable pair', unsolved === 0, unsolved);

  /* Random boards, including partially cleared ones. */
  const rnd = localRng(4242);
  let rMut = 0, rMs = 0, rMask = 0, rSol = 0, rSame = 0, rN = 0;
  for (let i = 0; i < 60; i++) {
    const b = randBoard(4 + (i % 5), 4 + ((i * 3) % 5), 6, 0.3, rnd);
    if (b.flat().filter(v => v != null).length < 2) continue;
    rN++;
    C.rng = C.makeRng(1000 + i);
    const before = json(b);
    const out = LL.shuffle(b);
    if (json(b) !== before) rMut++;
    if (sortedVals(out) !== sortedVals(b)) rMs++;
    if (nullMask(out) !== nullMask(b)) rMask++;
    if (LL.findPair(out) === null) rSol++;
    if (json(out) === before) rSame++;
  }
  check(`shuffle is pure and multiset-preserving on ${rN} random boards`, rMut === 0 && rMs === 0 && rMask === 0, json({ rMut, rMs, rMask }));
  check('every random shuffle leaves a linkable pair', rSol === 0, rSol);
  check('shuffle really permutes (results differ from the input)', rSame < rN, `${rSame}/${rN} unchanged`);
}

/* ==================================================== newGame / generation */
group('newGame — 500 seeded boards across the three difficulties');
{
  const table = {
    easy: { rows: 6, cols: 6, kinds: 8, time: 360 },
    normal: { rows: 8, cols: 8, kinds: 10, time: 420 },
    hard: { rows: 10, cols: 8, kinds: 12, time: 480 }
  };
  const keys = ['easy', 'normal', 'hard'];
  let noPair = 0, badDims = 0, badVals = 0, oddCounts = 0, badCfg = 0, badBridge = 0;
  for (let i = 0; i < 500; i++) {
    const d = keys[i % 3];
    const snap = LL.newGame({ difficulty: d, seed: i + 1 });
    const g = snap.board;
    const cfg = table[d];
    if (g.length !== cfg.rows || !g.every(r => r.length === cfg.cols)) badDims++;
    if (g.flat().some(v => !(Number.isInteger(v) && v >= 0 && v < cfg.kinds))) badVals++;
    if (LL.findPair(g) === null) noPair++;
    const cnt = {};
    g.flat().forEach(v => { cnt[v] = (cnt[v] || 0) + 1; });
    if (Object.values(cnt).some(c => c % 2 !== 0)) oddCounts++;
    if (snap.status !== 'playing' || snap.score !== 0 || snap.pairsLeft !== (cfg.rows * cfg.cols) / 2 ||
        snap.timeLeft !== cfg.time || snap.hintsLeft !== 3 || snap.combo !== 0 ||
        snap.selected !== null || snap.phase !== 'idle') badCfg++;
    if (LL.rows !== cfg.rows || LL.cols !== cfg.cols) badBridge++;
  }
  check('all 500 boards have the dimensions of their difficulty', badDims === 0, badDims);
  check('all 500 boards only use kinds valid for their difficulty', badVals === 0, badVals);
  check('every kind appears a whole number of times (pairs)', oddCounts === 0, oddCounts);
  check('every board of 500 starts with a linkable pair', noPair === 0, noPair);
  check('score / time / pairs / hints / status match the difficulty table', badCfg === 0, badCfg);
  check('LL.rows / LL.cols track the live difficulty', badBridge === 0, badBridge);

  /* Seed reproducibility. */
  let nondet = 0, distinct = 0, prev = null;
  for (let i = 0; i < 30; i++) {
    const d = keys[i % 3];
    const a = LL.newGame({ difficulty: d, seed: 9000 + i });
    const b = LL.newGame({ difficulty: d, seed: 9000 + i });
    if (json(a.board) !== json(b.board)) nondet++;
    if (prev === null || json(prev) !== json(a.board)) distinct++;
    prev = a.board;
  }
  check('the same seed reproduces the exact board (30 seeds)', nondet === 0, nondet);
  check('different seeds generally differ (sanity)', distinct > 25, distinct);
}

/* ============================== scoring & the state machine (real clicks) */
group('scoring — the real click path with a hand-pumped rAF clock');
{
  const zero8 = mkBoard(8, 8, 0);       // every tile the same: nothing can deadlock
  injectState(zero8, { time: 600 });

  /* First pair: base 10. */
  tap(0, 0);
  check('the first tap selects the tile', json(LL.getState().selected) === json([0, 0]), json(LL.getState().selected));
  check('the selected tile renders the sel class', /\bsel\b/.test(C.tileEls[0][0].className), C.tileEls[0][0].className);
  tap(0, 1);
  check('a matched pair enters the clearing phase', C.phase === 'clearing', C.phase);
  check('the first pair scores 10 (combo level 1)', C.score === 10, C.score);
  check('both tiles carry the clear animation class',
    /\bclear\b/.test(C.tileEls[0][0].className) && /\bclear\b/.test(C.tileEls[0][1].className));
  env.steps(2, 200);                    // 400ms >= CLEAR_MS
  check('the clear resolves back to idle', C.phase === 'idle', C.phase);
  check('pairsLeft decremented by exactly 1', C.pairsLeft === 31, C.pairsLeft);
  check('the cleared tiles are empty again', C.grid[0][0] === null && C.grid[0][1] === null);

  /* Second pair inside the 5s combo window: 10 + 5*(2-1) = 15. */
  tap(0, 2);
  tap(0, 3);
  check('the second pair inside the window scores 15 (combo level 2)', C.score === 25, C.score);
  check('the combo HUD shows x2', el('combo').textContent === 'x2', el('combo').textContent);
  check('the score float reads +15', fxTexts('fx-float').includes('+15'), json(fxTexts('fx-float')));
  env.steps(2, 200);

  /* Fast-forward the rAF clock past the 5s window, then match again. */
  let guard = 0;
  while (C.playClock < C.comboUntil + 1 && guard < 60) { env.step(200); guard++; }
  env.step(200);                          // let update() expire the chain
  check('the combo chain expired after the window', C.comboLevel === 0, C.comboLevel);
  tap(0, 4);
  tap(0, 5);
  check('a pair after the window expires scores 10 again (combo level 1)', C.score === 35, C.score);
  env.steps(2, 200);
  check('the state snapshot agrees (score 35, pairs 29, playing)',
    (() => { const s = LL.getState(); return s.score === 35 && s.pairsLeft === 29 && s.status === 'playing'; })(),
    json(LL.getState()));
}

group('scoring — an unlinkable same-pattern pair is denied, not cleared');
{
  /* The diagonal-corner full board: value 9 at opposite corners cannot be
   * linked with two turns. */
  const g = mkBoard(5, 5, 1);
  g[0][0] = 9; g[4][4] = 9;
  injectState(g, { time: 600 });
  const before = json(C.grid);
  tap(0, 0);
  tap(4, 4);
  check('the unlinkable pair does not clear anything', json(C.grid) === before);
  check('no score is awarded', C.score === 0, C.score);
  check('the machine stays idle (no clearing phase)', C.phase === 'idle', C.phase);
  check('the selection moves to the second tile', json(LL.getState().selected) === json([4, 4]), json(LL.getState().selected));
  check('the first tile shakes (deny class + timer)', /\bbad\b/.test(C.tileEls[0][0].className) && C.denyTimer > 0);
  check('the notice explains the denial', el('notice').textContent.toLowerCase().includes('path'), el('notice').textContent);
  env.steps(2, 200);
  check('the deny highlight retires with its timer', C.denyTimer === 0 && C.denyCells === null);
}

group('scoring — hints cost 20, three per game, then the button is dead');
{
  const board = pairsBoard();
  injectState(board, { time: 600, score: 0 });
  env.els.btnHint.fire('click');
  check('a hint decrements the hint budget', C.hintsLeft === 2, C.hintsLeft);
  check('a hint costs 20 but clamps at 0', C.score === 0, C.score);
  const pair = LL.findPair();
  check('the hint highlights a really linkable pair',
    !!C.hintCells && json(C.hintCells) === json(pair) && !!LL.canConnect(pair[0], pair[1]), json(C.hintCells));
  check('the hinted tiles render the hint class',
    /\bhint\b/.test(C.tileEls[C.hintCells[0][0]][C.hintCells[0][1]].className));

  C.score = 50; C.updateHud();
  env.els.btnHint.fire('click');
  check('the second hint costs 20 from a real balance', C.score === 30 && C.hintsLeft === 1, `${C.score}/${C.hintsLeft}`);
  env.els.btnHint.fire('click');
  check('the third hint spends the last charge', C.score === 10 && C.hintsLeft === 0, `${C.score}/${C.hintsLeft}`);
  check('the hint button is disabled at zero charges', env.els.btnHint.disabled === true);
  const sc = C.score, hl = C.hintsLeft;
  env.els.btnHint.fire('click');
  check('a fourth hint does nothing', C.score === sc && C.hintsLeft === hl);
  env.steps(10, 200);                    // let the highlight expire
  check('the hint highlight retires with its timer', C.hintCells === null && C.hintTimer === 0);
}

group('scoring — manual shuffle costs 30, clamped at 0');
{
  const board = pairsBoard();
  injectState(board, { time: 600, score: 10 });
  const ms = b => b.flat().filter(v => v != null).slice().sort((x, y) => x - y).join(',');
  const before = ms(board);
  env.els.btnShuffle.fire('click');
  check('a manual shuffle with 10 points clamps the cost at 0 (not -20)', C.score === 0, C.score);
  check('the machine enters the shuffling phase', C.phase === 'shuffling', C.phase);
  env.steps(2, 200);                     // 400ms >= SHUFFLE_MS
  check('the shuffled board is dealt again', C.phase === 'dealing', C.phase);
  env.steps(2, 200);                     // 400ms >= DEAL_MS
  check('the machine returns to idle after dealing', C.phase === 'idle', C.phase);
  check('the shuffle preserved the multiset of faces', ms(C.grid) === before);
  check('the shuffled board still has a linkable pair', LL.findPair() !== null);
  check('the shuffle reset the combo chain', C.comboLevel === 0);
}

group('scoring — time out loses, the last pair wins with a time bonus');
{
  /* Timeout. */
  const zero8 = mkBoard(8, 8, 0);
  injectState(zero8, { time: 600 });
  C.timeLeft = 300; C.updateHud();
  check('the clock enters the low-time style below 30s', el('time').classList.contains('low'));
  env.steps(3, 100);
  check('running out of time ends the game as a loss', C.status === 'over' && C.endWin === false, `${C.status}/${C.endWin}`);
  check('the lose dialog title is set', el('dlgTitle').textContent === "Time's Up", el('dlgTitle').textContent);
  const sc = C.score, pl = C.pairsLeft, hl = C.hintsLeft;
  tap(0, 0); tap(0, 1);
  env.els.btnHint.fire('click');
  env.els.btnShuffle.fire('click');
  check('after the game is over, clicks / hints / shuffles are all refused',
    C.score === sc && C.pairsLeft === pl && C.hintsLeft === hl && C.phase === 'idle',
    json({ sc, pl, hl, score: C.score, pairsLeft: C.pairsLeft, hints: C.hintsLeft, phase: C.phase }));

  /* Win: exactly one pair left; the bonus is remaining-seconds x 2. */
  const one = mkBoard(8, 8, null);
  one[3][3] = 0; one[3][4] = 0;
  injectState(one, { time: 600 });
  C.timeLeft = 10000; C.updateHud();     // exactly 10s on the clock
  tap(3, 3); tap(3, 4);
  check('the final pair enters clearing', C.phase === 'clearing', C.phase);
  env.steps(2, 170);                     // 340ms == CLEAR_MS
  check('clearing the last pair wins the game', C.status === 'over' && C.endWin === true, `${C.status}/${C.endWin}`);
  check('pairsLeft reaches 0', C.pairsLeft === 0, C.pairsLeft);
  check('the win bonus is the remaining seconds x 2 (10s -> +20)', C.endBonus === 20, C.endBonus);
  check('the final score is the pair (10) plus the bonus (20)', C.score === 30, C.score);
  check('the win dialog title is set', el('dlgTitle').textContent === 'You Win!', el('dlgTitle').textContent);
  check('the win dialog subtitle interpolates score and bonus',
    el('dlgSub').textContent.includes('20') && el('dlgSub').textContent.includes('+20'), el('dlgSub').textContent);
}

/* ============================================ i18n — dynamic text follows T */
group('i18n — dynamic text really follows the language (T.onChange path)');
{
  check('the stub document exposes no static i18n nodes',
    C.document.querySelectorAll('[data-i18n]').length === 0);
  check('source registers T.onChange exactly once',
    (env.html.match(/T\.onChange\s*\(/g) || []).length === 1,
    (env.html.match(/T\.onChange\s*\(/g) || []).length);

  injectState(pairsBoard(), { time: 600 });
  /* Numeric HUD fields are language-invariant numbers; the word fields flip. */
  C.T.set('zh');
  check('the level label becomes Chinese (普通)', el('levelLabel').textContent === '普通', el('levelLabel').textContent);
  check('the in-game notice becomes Chinese', CJK.test(el('notice').textContent), el('notice').textContent);
  check('tile tooltips become Chinese fruit names (k0 -> 苹果)',
    C.tileEls[0][0].title === '苹果' && C.tileEls[0][2].title === '橙子',
    `${C.tileEls[0][0].title}/${C.tileEls[0][2].title}`);
  check('numeric HUD fields stay numeric under zh',
    /^\d+$/.test(el('score').textContent) && /^\d+$/.test(el('pairs').textContent) &&
    /^\d+$/.test(el('hints').textContent) && /^\d+:[0-5]\d$/.test(el('time').textContent),
    json([el('score').textContent, el('time').textContent]));

  C.T.set('en');
  check('the level label returns to English', el('levelLabel').textContent === 'Normal', el('levelLabel').textContent);
  check('the notice returns to English', !CJK.test(el('notice').textContent), el('notice').textContent);
  check('tile tooltips return to English', C.tileEls[0][0].title === 'Apple', C.tileEls[0][0].title);

  /* Result dialog (driven through endGame -> updateHud). */
  C.endGame(true);
  C.T.set('zh');
  check('the result title becomes Chinese after T.set(zh)', CJK.test(el('dlgTitle').textContent), el('dlgTitle').textContent);
  check('the result subtitle becomes Chinese after T.set(zh)', CJK.test(el('dlgSub').textContent), el('dlgSub').textContent);
  C.T.set('en');
  check('the result title returns to English', el('dlgTitle').textContent === 'You Win!', el('dlgTitle').textContent);
  check('the live language getter tracks T.set()', C.T.lang === 'en', C.T.lang);
}

/* ================================= animation / decoration layer contract */
group('animation — the link line, the floats, and the board stay separated');
{
  injectState(pairsBoard(), { time: 600 });
  tap(0, 0); tap(0, 1);                  // an adjacent pair -> path [[1,1],[1,2]]

  /* The link is drawn on #linkLayer as SVG-ish nodes with the path points. */
  check('a link node is attached to #linkLayer', C.linkLayerEl.children.length === 1, C.linkLayerEl.children.length);
  const g = C.linkLayerEl.children[0];
  const line = g.children.find(n => n.getAttribute('class') === 'link-line');
  check('the link group holds a halo, a line and two dots', g.children.length === 4, g.children.length);
  const pts = line.getAttribute('points').split(' ').map(s => s.split(',').map(Number));
  check('the drawn line runs from tile (0,0) to tile (0,1) in board units',
    json(pts) === json([[0.5, 0.5], [1.5, 0.5]]), json(pts));

  /* The floating score appears on #fxLayer, never inside #board. */
  check('a score float is attached to #fxLayer', C.fxNodes.length >= 1 && C.fxLayerEl.children.length >= 1, C.fxNodes.length);
  check('the score float reads +10', fxTexts('fx-float').includes('+10'), json(fxTexts('fx-float')));
  const boardKids = () => C.boardEl.children;
  check('#board still holds exactly rows*cols tile children after the match',
    boardKids().length === 64 && boardKids().every(n => /\btile\b/.test(n.className)),
    `${boardKids().length}`);
  check('the fx layer is not a child of #board', !boardKids().includes(C.fxLayerEl));
  check('the link layer is not a child of #board', !boardKids().includes(C.linkLayerEl));

  env.steps(2, 200);                     // clear finishes
  check('the link node is removed when the clear finishes', C.linkLayerEl.children.length === 0, C.linkLayerEl.children.length);
  check('the cleared tiles lost the clear class',
    !/\bclear\b/.test(C.tileEls[0][0].className) && !/\bclear\b/.test(C.tileEls[0][1].className));
  env.steps(6, 200);                     // ttl of the float is 900ms
  check('the fx layer recycles every decoration node', C.fxNodes.length === 0 && C.fxLayerEl.children.length === 0,
    `${C.fxNodes.length}/${C.fxLayerEl.children.length}`);

  /* The decoration budget is bounded (cap from the source constant). */
  injectState(pairsBoard(), { time: 600 });
  for (let i = 0; i < 32; i++) {
    const pair = LL.findPair();
    if (!pair) break;                    // board cleared (or dead, auto-shuffled)
    tap(pair[0][0], pair[0][1]); tap(pair[1][0], pair[1][1]);
    env.steps(2, 200);
    if (C.fxNodes.length > C.FX_MAX_NODES) break;
  }
  check('the decoration list never exceeds the node cap under stress',
    C.fxNodes.length <= C.FX_MAX_NODES, `${C.fxNodes.length} vs ${C.FX_MAX_NODES}`);
}

/* ============ reverse checks (in-process) — the suite is not vacuously green */
group('reverse checks — the assertions really bite');
{
  /* 1) Let the path rule accept THREE turns: the differential must disagree
   *    and the three-turn-only constructs must "connect". */
  const origConnectPair = C.connectPair;
  C.connectPair = function (b, r1, c1, r2, c2) {
    return refCanConnect(b, r1, c1, r2, c2, 3) ? [[r1 + 1, c1 + 1], [r2 + 1, c2 + 1]] : null;
  };
  {
    let mismatches = 0, boards = 0;
    for (const b of [...(function* () {
      const alpha = [null, 0, 1];
      for (let i = 0; i < 300; i++) {
        const g = mkBoard(3, 3);
        let x = i * 7919 % 19683;
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { g[r][c] = alpha[x % 3]; x = Math.floor(x / 3); }
        yield g;
      }
    })()]) {
      boards++;
      C.grid = b;
      const cells = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (b[r][c] != null) cells.push([r, c]);
      for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
        if (b[cells[i][0]][cells[i][1]] !== b[cells[j][0]][cells[j][1]]) continue;
        const gp = !!LL.canConnect(cells[i], cells[j]);
        const rp = refCanConnect(b, cells[i][0], cells[i][1], cells[j][0], cells[j][1], 2);
        if (gp !== rp) mismatches++;
      }
    }
    check('reverse: a 3-turn path rule disagrees with the 2-turn reference', mismatches > 0, `${mismatches} over ${boards} boards`);
    const g = mkBoard(5, 5, 1); g[0][0] = 9; g[4][4] = 9; C.grid = g;
    check('reverse: the diagonal-corner refusal goes red under the broken rule',
      LL.canConnect([0, 0], [4, 4]) !== null);
  }
  C.connectPair = origConnectPair;
  {
    const g = mkBoard(5, 5, 1); g[0][0] = 9; g[4][4] = 9; C.grid = g;
    check('restored: the diagonal corner is refused again', LL.canConnect([0, 0], [4, 4]) === null);
  }

  /* 2) Make the outer ring impassable: the same-edge border guarantee dies. */
  const origToExt = C.toExt;
  C.toExt = function (b) {
    const x = origToExt(b);
    const h = x.length - 2, w = x[0].length - 2;
    for (let c = 0; c < w + 2; c++) { x[0][c] = -1; x[h + 1][c] = -1; }
    for (let r = 0; r < h + 2; r++) { x[r][0] = -1; x[r][w + 1] = -1; }
    return x;
  };
  {
    const g = mkBoard(5, 5, 1); g[0][1] = 9; g[0][3] = 9; C.grid = g;
    check('reverse: with the ring sealed the top-edge pair no longer links',
      LL.canConnect([0, 1], [0, 3]) === null);
  }
  C.toExt = origToExt;
  {
    const g = mkBoard(5, 5, 1); g[0][1] = 9; g[0][3] = 9; C.grid = g;
    check('restored: the top-edge pair links around the ring again',
      !!LL.canConnect([0, 1], [0, 3]));
  }

  /* 3) A shuffle that does not retry for solvability leaves dead boards. */
  const origShuffleTiles = C.shuffleTiles;
  C.shuffleTiles = function (b) { return b.map(row => row.slice()); };   // identity "shuffle"
  {
    const dead = [[0, 1], [1, 0]];
    const out = LL.shuffle(dead);
    check('reverse: a shuffle without the solvability retry stays dead', LL.findPair(out) === null);
  }
  C.shuffleTiles = origShuffleTiles;
  check('restored: shuffling the dead board always ends solvable', LL.findPair(LL.shuffle([[0, 1], [1, 0]])) !== null);

  /* 4) Neuter the language re-render: the dynamic text stops following. */
  const origHud = C.updateHud;
  C.updateHud = function () {};
  {
    C.T.set('en');
    const frozen = el('levelLabel').textContent;
    C.T.set('zh');
    check('reverse: with updateHud neutered the level label does NOT switch',
      el('levelLabel').textContent === frozen && !CJK.test(el('levelLabel').textContent), el('levelLabel').textContent);
  }
  C.updateHud = origHud;
  C.T.set('en');
  C.T.set('zh');
  check('restored: the level label follows the language again',
    el('levelLabel').textContent === '普通', el('levelLabel').textContent);
  C.T.set('en');
}

/* Leave the sandbox in a sane state for any harness that reloads it. */
LL.newGame({ difficulty: 'normal', seed: 1 });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
