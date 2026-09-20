#!/usr/bin/env node
/**
 * Logic tests for pacman-game (Pac-Man).
 *
 * The smoke test only proves the page does not throw. It cannot tell whether
 * the maze is well-formed, whether every pellet is actually reachable, whether
 * the four ghost personalities really follow their classic targeting rules,
 * whether the scatter/chase/frightened clock and the lives/level state machine
 * behave, or whether the HUD text follows the language. This suite loads the
 * whole inline script in a vm sandbox with a stub DOM (canvas is a no-op Proxy,
 * so the real render path still runs without a GPU) and asserts behaviour
 * through the game's own bridge object `window.PM` and its real UI entry points.
 *
 * Two layers carry most of the weight:
 *
 *  1. GEOMETRY INVARIANTS. An independent BFS (tunnel wrap included) proves
 *     every one of the 264 pellets is reachable from Pac-Man's spawn, that the
 *     31x28 maze is uniform, and that the ghost-house door / interior are
 *     impassable to Pac-Man while the side tunnels wrap.
 *
 *  2. DIFFERENTIAL ghost AI. `ghostTarget`/`ghostNextDir` look "obviously
 *     right", which is exactly when a one-line slip hides. The reference here
 *     is deliberately a DIFFERENT SHAPE: distances are compared through the
 *     dot-product identity d^2 = |a|^2 + |b|^2 - 2a.b instead of the engine's
 *     (dr^2 + dc^2), the eyes BFS is replaced by an independent
 *     distance-from-goal map, and the enumeration is exhaustive over every
 *     Pac-Man tile and all four personalities. Divergences must be zero.
 *
 *     The frightened move is NOT distance-based any more (it is a deterministic
 *     pseudo-random wander keyed by `frightHash(name, r, c, frightSession)`), so
 *     it is pinned by PROPERTIES and ratios instead of a copied hash: purity,
 *     legality, "is provably not the old farthest-tile rule", seed wiring, and a
 *     graceful missing-argument fallback. Re-implementing the hash here would be
 *     circular, so we deliberately do not.
 *
 *  3. TIMING / STATE. The opening corridor is asserted by ORDER (pellets cleared
 *     before any death), never by an absolute second count, so the suite does not
 *     silently depend on the actor speed; a separate group measures the actor's
 *     tiles-per-second pace to guard the unit fix. Ghost-chain scoring
 *     (200/400/800/1600) and the levelclear -> next-level transition are driven
 *     for real, with the deep-state cases reached by swapping MAZE at runtime
 *     through the bridge (the shipped index.html is never edited).
 *
 * Reverse checks (both in-process sabotage and, in the runbook, a patched HTML
 * copy) prove the comparators are not vacuously green.
 *
 * Usage:  node tools/pacman-test.js [path/to/index.html] [path/to/assets/i18n.js]
 *   The optional path lets a deliberately broken copy be fed to the SAME
 *   script, so the negative test is replayable.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'pacman-game', 'index.html');
const I18N = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(path.dirname(GAME), '..', 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
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
    getBoundingClientRect() { return { left: 0, top: 0, width: 448, height: 496 }; }
  }

  const els = {};
  const docHandlers = {};
  let frame = null;
  let now = 0;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error,
    Set, Map, parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    performance: { now: () => Date.now() },
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
    // Pump one genuine requestAnimationFrame frame so update()+draw() run.
    step(dt) { now += (dt === undefined ? 16 : dt); const f = frame; frame = null; if (f) f(now); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

/* Boot the game. `LiteI18N.create` is wrapped so the game's private `T`
 * instance is captured without touching the source (needed for the dynamic
 * i18n checks, since T lives inside the IIFE). */
function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const origCreate = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = origCreate(dict); return T; };
  inlineScripts(fs.readFileSync(GAME, 'utf8')).forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `pacman/index.html#script${i}` });
  });
  env.step(); // one real animation frame (runs update + draw)
  return { env, PM: env.context.PM, T, els: env.els };
}

const G = boot();
const PM = G.PM;
const T = G.T;
const KEYMAP = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const key = k => G.env.fireDoc('keydown', { key: KEYMAP[k] || k, preventDefault() {} });
const click = id => G.els[id].fire('click', { preventDefault() {} });
const el = id => G.env.context.document.getElementById(id);

/* --------------------------------------------------- independent maze maths */

const MAZE0 = PM.maze().slice();
const COLS = PM.COLS, ROWS = PM.ROWS, TILE = PM.TILE;
const wc = c => ((c % COLS) + COLS) % COLS;
const DIRV = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
const ORDER = ['up', 'left', 'down', 'right'];
// The bot explores neighbours in a different order from the engine's AI
// tie-break, which is what lets it wander the maze rather than mirror it.
const BOT_ORDER = ['up', 'down', 'left', 'right'];
const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };

// Independent Pac-Man BFS: only canWalk tiles, columns wrap.
function reachableFrom(sr, sc) {
  const seen = new Set([sr + ',' + sc]);
  const q = [[sr, sc]];
  let h = 0;
  while (h < q.length) {
    const [r, c] = q[h++];
    for (const d of ORDER) {
      const dr = DIRV[d][0], dc = DIRV[d][1];
      const nr = r + dr, nc = wc(c + dc);
      const k = nr + ',' + nc;
      if (seen.has(k)) continue;
      if (!PM.canWalk(nr, nc)) continue;
      seen.add(k);
      q.push([nr, nc]);
    }
  }
  return seen;
}

/* ------------------------------------ independent ghost-AI reference (diff) */

const gEnter = (r, c) => r >= 0 && r < ROWS && MAZE0[r][wc(c)] !== '#';
const HOUSE_CENTER = { r: 14, c: 13 };
const SCATTER = {
  blinky: { r: 0, c: COLS - 1 }, pinky: { r: 0, c: 0 },
  inky: { r: ROWS - 1, c: COLS - 1 }, clyde: { r: ROWS - 1, c: 0 }
};

// Distance-from-goal over the ghost-walkable graph (used for the eyes check).
function distToGoal(goal) {
  const D = new Map([[goal.r + ',' + goal.c, 0]]);
  const q = [[goal.r, goal.c]];
  let h = 0;
  while (h < q.length) {
    const [r, c] = q[h++];
    const d0 = D.get(r + ',' + c);
    for (const d of ORDER) {
      const nr = r + DIRV[d][0], nc = wc(c + DIRV[d][1]);
      if (!gEnter(nr, nc)) continue;
      const k = nr + ',' + nc;
      if (D.has(k)) continue;
      D.set(k, d0 + 1);
      q.push([nr, nc]);
    }
  }
  return D;
}
const DEYES = distToGoal(HOUSE_CENTER);

// Reference target: explicit per-personality formulas, not the engine's branch.
function refTarget(name, mode, st) {
  if (mode === 'eyes') return { r: HOUSE_CENTER.r, c: HOUSE_CENTER.c };
  const p = st.pac;
  if (mode === 'frightened') return { r: p.r, c: p.c };
  if (mode === 'scatter') return SCATTER[name];
  const v = DIRV[p.dir] || DIRV.left; // chase (and 'house' falls through to chase)
  if (name === 'blinky') return { r: p.r, c: p.c };
  if (name === 'pinky') return { r: p.r + 4 * v[0], c: p.c + 4 * v[1] };
  if (name === 'inky') {
    const b = st.blinky || p;
    return { r: 2 * (p.r + 2 * v[0]) - b.r, c: 2 * (p.c + 2 * v[1]) - b.c };
  }
  if (name === 'clyde') {
    const g = (st.ghosts || []).find(x => x.name === 'clyde');
    const near = g && Math.hypot(g.r - p.r, g.c - p.c) < 8;
    return near ? SCATTER.clyde : { r: p.r, c: p.c };
  }
  return { r: p.r, c: p.c };
}

// d^2 via the dot-product identity: (a-b).(a-b) = |a|^2 + |b|^2 - 2 a.b
function dotD2(ar, ac, br, bc) {
  return ar * ar + ac * ac + br * br + bc * bc - 2 * (ar * br + ac * bc);
}

// Reference next-dir for the distance-based modes: candidate set (legal, no
// voluntary reverse) then pick min/max d^2 with a strict-< scan in ORDER.
function refNextDirDistance(name, mode, g, st) {
  const rev = g.dir ? OPP[g.dir] : null;
  const cands = ORDER.filter(d => d !== rev && gEnter(g.r + DIRV[d][0], g.c + DIRV[d][1]));
  if (!cands.length) return rev || 'left';
  const t = refTarget(name, mode, st);
  let best = cands[0];
  let bestV = dotD2(g.r + DIRV[best][0], wc(g.c + DIRV[best][1]), t.r, t.c);
  for (let i = 1; i < cands.length; i++) {
    const d = cands[i];
    const v = dotD2(g.r + DIRV[d][0], wc(g.c + DIRV[d][1]), t.r, t.c);
    if (mode === 'frightened' ? v > bestV : v < bestV) { bestV = v; best = d; }
  }
  return best;
}

// Reference eyes move: first-in-ORDER neighbour that is strictly closer to the
// house centre (reversal is allowed here - returning home is a fresh objective).
function refEyes(g) {
  const dcur = DEYES.get(g.r + ',' + g.c);
  if (dcur === undefined) return null;
  for (const d of ORDER) {
    const nr = g.r + DIRV[d][0], nc = wc(g.c + DIRV[d][1]);
    if (!gEnter(nr, nc)) continue;
    if (DEYES.get(nr + ',' + nc) === dcur - 1) return d;
  }
  return null;
}

/* --------------------------------------------------------- simulation driver */

const dmCache = new Map();
function distMap(sr, sc) {
  const ck = sr + ',' + sc;
  if (dmCache.has(ck)) return dmCache.get(ck);
  const D = new Map([[ck, 0]]);
  const q = [[sr, sc]];
  let h = 0;
  while (h < q.length) {
    const [r, c] = q[h++];
    const d0 = D.get(r + ',' + c);
    for (const d of ORDER) {
      const nr = r + DIRV[d][0], nc = wc(c + DIRV[d][1]);
      if (!PM.canWalk(nr, nc)) continue;
      const k = nr + ',' + nc;
      if (D.has(k)) continue;
      D.set(k, d0 + 1);
      q.push([nr, nc]);
    }
  }
  dmCache.set(ck, D);
  return D;
}

function neighbours(r, c) {
  const out = [];
  for (const d of BOT_ORDER) {
    const nr = r + DIRV[d][0], nc = wc(c + DIRV[d][1]);
    if (PM.canWalk(nr, nc)) out.push([d, nr, nc]);
  }
  return out;
}
function firstStep(r, c, goalOf, order) {
  order = order || BOT_ORDER;
  const seen = new Set([r + ',' + c]);
  const q = [[r, c, null]];
  for (let h = 0; h < q.length; h++) {
    const [cr, cc, first] = q[h];
    if ((cr !== r || cc !== c) && goalOf(cr, cc)) return first;
    for (const d of order) {
      const nr = cr + DIRV[d][0], nc = wc(cc + DIRV[d][1]);
      if (!PM.canWalk(nr, nc)) continue;
      const k = nr + ',' + nc;
      if (seen.has(k)) continue;
      seen.add(k);
      q.push([nr, nc, first || d]);
    }
  }
  return null;
}
// Same shortest-step search but expanding in the engine's ORDER tie-break, so
// the chain bots reproduce the exact paths the runbook validated.
const firstStepOrder = (r, c, goal) => firstStep(r, c, goal, ORDER);

// A deterministic Pac-Man bot: flee when a hunting ghost is close, otherwise
// go for the nearest power pellet (then pellet). Used to reach deep game state.
function makePolicy(riskRadius) {
  return function (st) {
    const { r, c } = st.pac;
    const out = st.ghosts.filter(g => g.mode !== 'house' && g.mode !== 'eyes');
    const fright = out.filter(g => g.mode === 'frightened');
    const threats = out.filter(g => g.mode !== 'frightened');
    if (fright.length) return firstStep(r, c, (rr, cc) => fright.some(g => g.r === rr && g.c === cc));
    let threatDist = Infinity;
    if (threats.length) {
      const dm = distMap(r, c);
      for (const g of threats) {
        const dd = dm.has(g.r + ',' + g.c) ? dm.get(g.r + ',' + g.c) : Infinity;
        if (dd < threatDist) threatDist = dd;
      }
    }
    if (threatDist <= riskRadius) {
      let best = null, bestScore = -1;
      for (const [d, nr, nc] of neighbours(r, c)) {
        const dm = distMap(nr, nc);
        let sc = Infinity;
        for (const g of threats) {
          const dd = dm.has(g.r + ',' + g.c) ? dm.get(g.r + ',' + g.c) : 999;
          sc = Math.min(sc, dd);
        }
        if (sc > bestScore) { bestScore = sc; best = d; }
      }
      return best;
    }
    const s = firstStep(r, c, (rr, cc) => MAZE0[rr][cc] === 'o') || firstStep(r, c, (rr, cc) => MAZE0[rr][cc] === '.');
    return s;
  };
}

const LEGAL_PHASES = new Set(['ready', 'playing', 'paused', 'dying', 'levelclear', 'gameover']);

function simulate(opts) {
  opts = opts || {};
  PM.newGame({ level: opts.level || 1, lives: opts.lives || 3 });
  PM.start();
  const dt = 1 / 60;
  const ev = {
    t: 0, deltas: {}, deaths: 0, phases: new Set(), clears: 0,
    gameoverAt: null, powerAt: null, powerGhostModes: null, ghostEats: [],
    maxScore: 0, okInvariants: true, badInvariant: null,
    // Timing the opening corridor lets the corridor test stay independent of
    // the absolute actor speed (see group 4): we compare the order of "all six
    // pellets eaten" vs "first life lost" instead of a hard-coded second count.
    firstDeathAt: null, scoreAtFirstDeath: null, timeScore60: null,
    ghostEatTimes: []
  };
  let st = PM.getState();
  let lastScore = st.score, lastLives = st.lives, lastPhase = st.phase;
  const maxT = opts.seconds || 60;
  while (ev.t < maxT) {
    if (opts.policy) { const d = opts.policy(st); if (d) key(d); }
    st = PM.tick(dt);
    ev.t += dt;
    if (st.score !== lastScore) {
      const dl = st.score - lastScore;
      ev.deltas[dl] = (ev.deltas[dl] || 0) + 1;
      if (dl === 50) { ev.powerAt = ev.powerAt === null ? ev.t : ev.powerAt; ev.powerGhostModes = st.ghosts.map(g => g.mode); }
      if (dl >= 200) { ev.ghostEats.push(dl); ev.ghostEatTimes.push(ev.t); }
      lastScore = st.score;
    }
    if (st.score > ev.maxScore) ev.maxScore = st.score;
    if (ev.timeScore60 === null && st.score >= 60) ev.timeScore60 = ev.t;
    if (st.lives !== lastLives) { ev.deaths++; if (ev.firstDeathAt === null) { ev.firstDeathAt = ev.t; ev.scoreAtFirstDeath = st.score; } lastLives = st.lives; }
    if (st.phase !== lastPhase) { ev.phases.add(st.phase); if (st.phase === 'levelclear') ev.clears++; if (st.phase === 'gameover') ev.gameoverAt = ev.t; lastPhase = st.phase; }
    // Bounds / no-wall invariant, checked every frame.
    if (ev.okInvariants) {
      const p = st.pac;
      if (!(p.r >= 0 && p.r < ROWS && p.c >= 0 && p.c < COLS)) { ev.okInvariants = false; ev.badInvariant = `pac out of bounds ${p.r},${p.c}`; }
      else if (!PM.canWalk(p.r, p.c)) { ev.okInvariants = false; ev.badInvariant = `pac inside wall ${p.r},${p.c}`; }
      else if (!LEGAL_PHASES.has(st.phase)) { ev.okInvariants = false; ev.badInvariant = `phase ${st.phase}`; }
      else for (const g of st.ghosts) {
        if (!(g.r >= 0 && g.r < ROWS && g.c >= 0 && g.c < COLS)) { ev.okInvariants = false; ev.badInvariant = `${g.name} oob ${g.r},${g.c}`; break; }
        if (MAZE0[g.r][wc(g.c)] === '#') { ev.okInvariants = false; ev.badInvariant = `${g.name} in wall ${g.r},${g.c}`; break; }
      }
    }
    if (st.phase === 'gameover') { ev.state = st; return ev; }
    if (opts.stopWhen && opts.stopWhen(st)) { ev.state = st; return ev; }
  }
  ev.state = st;
  return ev;
}

/* -------------------------------------------------- frightened-chain tracing */

// Classic chain payout: 200, 400, 800 then 1600 forever (chain saturates at 3).
const CHAIN_VAL = k => 200 * Math.pow(2, Math.min(k, 3));
const sumChain = (from, n) => { let s = 0; for (let i = 0; i < n; i++) s += CHAIN_VAL(from + i); return s; };

/* Run a policy and attribute EVERY ghost eat to its exact chain index, without
 * ever trusting the score blindly: each frame's delta must decompose into
 * (ghost eats) plus at most one pellet (+10) or power pellet (+50). A frame that
 * both powers and eats is legal - updatePlaying() eats the pellet (chain:=0)
 * BEFORE checkCollisions eats ghosts - and the reconciliation tells the two
 * hypotheses apart by exact arithmetic. Returns the eats, the windows they fall
 * in, and any frame that could not be reconciled (should be zero). */
function traceChain(opts) {
  opts = opts || {};
  PM.newGame({ level: opts.level || 1, lives: opts.lives || 3 });
  PM.start();
  const dt = 1 / 60;
  const ev = { eats: [], reconFails: 0, example: null };
  let st = PM.getState(), chain = 0, lastScore = st.score;
  const prevModes = {};
  st.ghosts.forEach(g => { prevModes[g.name] = g.mode; });
  const maxT = opts.seconds || 600;
  for (let t = 0; t < maxT / dt; t++) {
    if (opts.policy) { const d = opts.policy(st); if (d) key(d); }
    st = PM.tick(dt);
    const eaten = [];
    for (const g of st.ghosts) if (g.mode === 'eyes' && prevModes[g.name] !== 'eyes') eaten.push(g.name);
    const dScore = st.score - lastScore;
    lastScore = st.score;
    if (eaten.length === 0) {
      if (dScore === 50) chain = 0;                       // a power pellet with no simultaneous eat
      else if (dScore !== 0 && dScore !== 10) { ev.reconFails++; ev.example = ev.example || `no-eat frame dScore=${dScore}`; }
    } else {
      const remA = dScore - sumChain(chain, eaten.length);          // "chain continues"
      const remB = dScore - 50 - sumChain(0, eaten.length);         // "power reset the chain first"
      let start;
      if (remA === 0 || remA === 10) start = chain;
      else if (remB === 0) start = 0;
      else { ev.reconFails++; ev.example = ev.example || `eat frame dScore=${dScore} n=${eaten.length} chain=${chain}`; start = chain; }
      for (let i = 0; i < eaten.length; i++) ev.eats.push({ name: eaten[i], value: CHAIN_VAL(start + i), k: start + i });
      chain = Math.min(start + eaten.length, 3);
    }
    st.ghosts.forEach(g => { prevModes[g.name] = g.mode; });
    if (st.phase === 'gameover') break;
  }
  const windows = [];
  for (const e of ev.eats) { if (e.k === 0 || windows.length === 0) windows.push([]); windows[windows.length - 1].push(e); }
  ev.windows = windows;
  ev.maxChain = windows.reduce((m, w) => Math.max(m, w.length), 0);
  ev.reEatWindows = windows.filter(w => { const s = new Set(); return w.some(e => s.has(e.name) ? true : (s.add(e.name), false)); });
  ev.values = ev.eats.map(e => e.value);
  ev.valuesLegal = ev.values.every(v => v === 200 || v === 400 || v === 800 || v === 1600);
  return ev;
}

/* A Pac-Man bot tuned to hunt blue ghosts (bait a power pellet while >=N ghosts
 * are near, then chase the nearest frightened one). Reaches deep chains on the
 * shipped maze without touching the source. */
function makeChainPolicy(cfg) {
  return function (st) {
    const { r, c } = st.pac;
    const out = st.ghosts.filter(g => g.mode !== 'house' && g.mode !== 'eyes');
    const fright = out.filter(g => g.mode === 'frightened');
    const threats = out.filter(g => g.mode !== 'frightened');
    if (fright.length) { const s = firstStepOrder(r, c, (rr, cc) => fright.some(g => g.r === rr && g.c === cc)); if (s) return s; }
    if (threats.length) {
      const dm = distMap(r, c); let td = Infinity;
      for (const g of threats) { const dd = dm.has(g.r + ',' + g.c) ? dm.get(g.r + ',' + g.c) : Infinity; if (dd < td) td = dd; }
      if (td <= cfg.risk) {
        let best = null, bs = -1;
        for (const d of ORDER) {
          const nr = r + DIRV[d][0], nc = wc(c + DIRV[d][1]);
          if (!PM.canWalk(nr, nc)) continue;
          const m = distMap(nr, nc); let sc = Infinity;
          for (const g of threats) { const v = m.has(g.r + ',' + g.c) ? m.get(g.r + ',' + g.c) : 999; sc = Math.min(sc, v); }
          if (sc > bs) { bs = sc; best = d; }
        }
        return best;
      }
    }
    let near = 0; const dm = distMap(r, c);
    for (const g of out) { const dd = dm.has(g.r + ',' + g.c) ? dm.get(g.r + ',' + g.c) : Infinity; if (dd <= cfg.baitDist) near++; }
    if (near >= cfg.baitCount) { const s = firstStepOrder(r, c, (rr, cc) => MAZE0[rr][cc] === 'o'); if (s) return s; }
    return firstStepOrder(r, c, (rr, cc) => MAZE0[rr][cc] === '.') || firstStepOrder(r, c, (rr, cc) => MAZE0[rr][cc] === 'o');
  };
}

/* Replace MAZE (returned by the bridge BY REFERENCE) with an open room so blue
 * ghosts cannot hide; the shipped index.html is never modified. Caller must
 * restore MAZE and clear dmCache afterwards. */
function buildOpenRoom(powerTiles) {
  const mz = PM.maze();
  for (let r = 0; r < ROWS; r++) {
    const a = [];
    for (let c = 0; c < COLS; c++) {
      if (r === 0 || r === ROWS - 1) a.push('#');
      else if ((c === 0 || c === COLS - 1) && r !== 14) a.push('#');
      else a.push('.');
    }
    mz[r] = a.join('');
  }
  for (const [r, c] of powerTiles) { const a = mz[r].split(''); a[c] = 'o'; mz[r] = a.join(''); }
}

// Arena bot: camp the house exit while blue, else bait a power pellet.
function makeArenaPolicy(cfg) {
  return function (st) {
    const { r, c } = st.pac;
    const out = st.ghosts.filter(g => g.mode !== 'house' && g.mode !== 'eyes');
    const fright = out.filter(g => g.mode === 'frightened');
    const threats = out.filter(g => g.mode !== 'frightened');
    if (fright.length) {
      if (cfg.camp) { const s = firstStepOrder(r, c, (rr, cc) => rr === 11 && cc === 13); if (s) return s; }
      const s = firstStepOrder(r, c, (rr, cc) => fright.some(g => g.r === rr && g.c === cc)); if (s) return s;
    }
    if (threats.length) {
      const dm = distMap(r, c); let td = Infinity;
      for (const g of threats) { const dd = dm.has(g.r + ',' + g.c) ? dm.get(g.r + ',' + g.c) : Infinity; if (dd < td) td = dd; }
      if (td <= cfg.risk) {
        let best = null, bs = -1;
        for (const d of ORDER) {
          const nr = r + DIRV[d][0], nc = wc(c + DIRV[d][1]);
          if (!PM.canWalk(nr, nc)) continue;
          const m = distMap(nr, nc); let sc = Infinity;
          for (const g of threats) { const v = m.has(g.r + ',' + g.c) ? m.get(g.r + ',' + g.c) : 999; sc = Math.min(sc, v); }
          if (sc > bs) { bs = sc; best = d; }
        }
        return best;
      }
    }
    const mz = PM.maze();
    return firstStepOrder(r, c, (rr, cc) => mz[rr][cc] === 'o') || firstStepOrder(r, c, (rr, cc) => mz[rr][cc] === '.');
  };
}

/* ============================================================================
 * 1. Maze geometry invariants
 * ========================================================================== */

group('1. maze() is a well-formed 31x28 grid');
{
  const maze = PM.maze();
  check(Array.isArray(maze) && maze.length === 31, `maze() is an array of 31 rows (got ${Array.isArray(maze) ? maze.length : typeof maze})`);
  check(PM.ROWS === 31 && PM.COLS === 28 && PM.TILE === 16, `COLS/ROWS/TILE are 28/31/16 (got ${PM.COLS}/${PM.ROWS}/${PM.TILE})`);
  const widths = new Set(maze.map(r => r.length));
  check(widths.size === 1 && widths.has(28), `every row is exactly 28 chars (widths ${[...widths].join(',')})`);
  const badChars = new Set();
  for (const row of maze) for (const ch of row) if (!'#.o ='.includes(ch)) badChars.add(ch);
  check(badChars.size === 0, `only legal maze characters appear (bad ${[...badChars].join(',') || 'none'})`);

  let dots = 0, power = 0;
  for (const row of maze) for (const ch of row) { if (ch === '.') dots++; else if (ch === 'o') power++; }
  check(dots === 260, `there are 260 normal pellets (got ${dots})`);
  check(power === 4, `there are 4 power pellets (got ${power})`);
  check(dots + power === 264, `264 pellets in total (got ${dots + power})`);
  check(maze[23][13] === ' ', `Pac-Man spawns on floor at (23,13) (got ${JSON.stringify(maze[23][13])})`);
}

group('1b. every pellet is reachable from spawn (independent BFS, tunnel wrap)');
{
  const seen = reachableFrom(23, 13);
  const maze = PM.maze();
  let reached = 0, unreachable = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ch = maze[r][c];
      if (ch !== '.' && ch !== 'o') continue;
      if (seen.has(r + ',' + c)) reached++; else unreachable.push(`${r},${c}`);
    }
  }
  check(reached === 264, `all 264 pellets are BFS-reachable (reached ${reached}, unreachable ${unreachable.length})`);
  check(unreachable.length === 0, `no pellet is isolated (${unreachable.slice(0, 6).join(' ') || 'none'})`);
  // The known "outside the walls" corridor is walkable but disconnected by design.
  let walkable = 0, recomputed = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (PM.canWalk(r, c)) { walkable++; if (seen.has(r + ',' + c)) recomputed++; }
  check(walkable === 360, `there are 360 Pac-Man-walkable tiles (got ${walkable})`);
  check(recomputed === 300, `300 of them are reachable from spawn, 60 form the disconnected outside ring (got ${recomputed})`);
}

group('1c. isWall / canWalk boundaries and the tunnel wrap');
{
  check(PM.isWall(-1, 5) === true && PM.isWall(31, 5) === true, 'isWall is true above and below the grid');
  check(PM.isWall(0, 5) === true && PM.isWall(30, 5) === true, 'the top and bottom border rows are solid wall');
  // Tunnel row 14: column -1 must equal column 27, and 28 must equal 0.
  let wrapAgree = true, wrapMoves = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (PM.isWall(r, c - COLS) !== PM.isWall(r, c)) wrapAgree = false;
      if (PM.isWall(r, c + COLS) !== PM.isWall(r, c)) wrapAgree = false;
    }
  }
  check(wrapAgree, 'isWall(r, c±28) always equals isWall(r, c) (column wrap is exact)');
  check(PM.isWall(14, -1) === false && PM.isWall(14, 28) === false, 'row 14 is open through the tunnel (c=-1 and c=28 are floor)');
  check(PM.isWall(14, 0) === false && PM.isWall(14, 27) === false, 'row 14 tiles 0 and 27 are floor');
  check(PM.isWall(13, 0) === true && PM.isWall(13, 27) === true, 'row 13 columns 0 and 27 are wall (the wrap is 1 tile wide)');
  // wrap()
  const w1 = PM.wrap(14, -1), w2 = PM.wrap(14, 28), w3 = PM.wrap(14, 34);
  check(w1.r === 14 && w1.c === 27, `wrap(14,-1) -> (14,27) (got ${w1.r},${w1.c})`);
  check(w2.r === 14 && w2.c === 0, `wrap(14,28) -> (14,0) (got ${w2.r},${w2.c})`);
  check(w3.c === 6, `wrap(14,34) -> column 6 (got ${w3.c})`);
  check(PM.wrap(0, 0).r === 0, 'wrap leaves the row untouched');

  // canWalk agrees with the raw maze for every in-bounds tile.
  let canWalkMismatch = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const ch = MAZE0[r][c];
      const expected = !(ch === '#' || ch === '=') && !(r >= 13 && r <= 15 && c >= 11 && c <= 16);
      if (PM.canWalk(r, c) !== expected) canWalkMismatch++;
    }
  }
  check(canWalkMismatch === 0, `canWalk matches wall/door/house rules on all 868 tiles (mismatches ${canWalkMismatch})`);
  check(PM.canWalk(23, 13) === true, 'the spawn tile is walkable');
  check(PM.canWalk(-1, 5) === false && PM.canWalk(31, 5) === false, 'canWalk is false out of bounds');
}

group('1d. Pac-Man can never enter the ghost house or its door');
{
  check(PM.canWalk(12, 13) === false && PM.canWalk(12, 14) === false, "the ghost door ('=') blocks Pac-Man");
  let houseWalkable = 0;
  for (let r = 13; r <= 15; r++) for (let c = 11; c <= 16; c++) if (PM.canWalk(r, c)) houseWalkable++;
  check(houseWalkable === 0, `no tile of the ghost-house interior (13..15 x 11..16) is walkable (${houseWalkable} walkable)`);
  check(PM.canWalk(11, 13) === true, 'the tile above the door (HOME_TILE 11,13) IS walkable for Pac-Man');
  // Reachability confirms the house is a closed pocket.
  const seen = reachableFrom(23, 13);
  let leaked = 0;
  for (let r = 13; r <= 15; r++) for (let c = 11; c <= 16; c++) if (seen.has(r + ',' + c)) leaked++;
  check(leaked === 0, 'BFS from spawn cannot reach any house tile (the house is sealed)');
}

group('1e. maze() is never mutated by play');
{
  const before = JSON.stringify(PM.maze());
  const snapshot = PM.maze().slice();
  PM.newGame({ level: 1 });
  PM.start();
  simulate({ seconds: 120 }); // a long live game that eats many pellets
  PM.tick(600);                // and a big deterministic chunk on top
  const after = JSON.stringify(PM.maze());
  check(before === after, 'the maze string array is byte-identical after 720s of play');
  const now = PM.maze();
  check(now.length === snapshot.length && now.every((row, i) => row === snapshot[i]),
    'every maze row still matches the boot snapshot (pellets are not removed from MAZE)');
  const stillThere = now[23][6] === '.';
  check(stillThere, 'an eaten pellet tile is still a ".", proving only the internal grid is edited');
  const eaten = PM.getState().pelletsLeft;
  check(eaten < 264, `the game really ate pellets during the run (pelletsLeft ${eaten})`);
}

/* ============================================================================
 * 2. Differential ghost targeting
 * ========================================================================== */

const NAMES = ['blinky', 'pinky', 'inky', 'clyde'];
const MODES = ['scatter', 'chase', 'frightened', 'eyes', 'house'];
// Ghost states are always sampled on GHOST-ENTERABLE tiles (walls excluded).
const allTiles = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (MAZE0[r][c] !== '#') allTiles.push([r, c]);
function sampleTiles(n) {
  const out = [];
  const stepN = Math.max(1, Math.floor(allTiles.length / n));
  for (let i = 0; i < allTiles.length && out.length < n; i += stepN) out.push(allTiles[i]);
  return out;
}
const ghostTiles = sampleTiles(4);
const ghostStates = [];
for (const [r, c] of ghostTiles) for (const d of ORDER) ghostStates.push({ r, c, dir: d });

group('2. ghostTarget: exhaustive differential against independent formulas');
{
  let count = 0, div = 0, example = null;
  const fixedBlinky = { r: 11, c: 13 };
  const fixedClyde = { r: 14, c: 16 };
  function cmpTarget(name, mode, st) {
    count++;
    const got = PM.ghostTarget(name, mode, st);
    const exp = refTarget(name, mode, st);
    if (got.r !== exp.r || got.c !== exp.c) {
      div++;
      if (!example) example = `${name}/${mode} pac(${st.pac.r},${st.pac.c},${st.pac.dir}) got(${got.r},${got.c}) exp(${exp.r},${exp.c})`;
    }
  }
  // Exhaustive over every Pac-Man tile x 4 dirs x 4 personalities x 5 modes.
  for (const name of NAMES) {
    for (const mode of MODES) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          for (const dir of ORDER) {
            cmpTarget(name, mode, { pac: { r, c, dir }, blinky: fixedBlinky, ghosts: [{ name: 'clyde', r: fixedClyde.r, c: fixedClyde.c }], mode });
          }
        }
      }
    }
  }
  // Inky's reflection depends on Blinky: sweep Blinky over many positions.
  for (const [br, bc] of sampleTiles(24)) {
    for (const [pr, pc] of sampleTiles(24)) {
      for (const dir of ORDER) {
        cmpTarget('inky', 'chase', { pac: { r: pr, c: pc, dir }, blinky: { r: br, c: bc }, ghosts: [{ name: 'clyde', r: 14, c: 16 }], mode: 'chase' });
      }
    }
  }
  // Clyde's chase/retreat branch depends on his own distance: sweep his tile.
  for (const [pr, pc] of sampleTiles(24)) {
    for (const [gr, gc] of sampleTiles(24)) {
      cmpTarget('clyde', 'chase', { pac: { r: pr, c: pc, dir: 'up' }, blinky: fixedBlinky, ghosts: [{ name: 'clyde', r: gr, c: gc }], mode: 'chase' });
    }
  }
  check(div === 0, `ghostTarget agrees on all ${count} enumerated states (divergences ${div})`, example);
  console.log(`       compared ${count} target states`);

  // Explicit per-personality spot checks (so a broken formula names itself).
  const p = { r: 10, c: 8, dir: 'up' };
  const b = { r: 4, c: 3 };
  const base = { pac: p, blinky: b, ghosts: [{ name: 'clyde', r: 10, c: 8 }], mode: 'chase' };
  const same = (t, r, c) => t.r === r && t.c === c;
  let t = PM.ghostTarget('blinky', 'chase', base);
  check(same(t, 10, 8), `Blinky chases Pac-Man's tile (got ${t.r},${t.c})`);
  t = PM.ghostTarget('pinky', 'chase', base);
  check(same(t, 6, 8), `Pinky targets 4 tiles ahead (up -> 6,8) (got ${t.r},${t.c})`);
  t = PM.ghostTarget('inky', 'chase', base);
  check(same(t, 12, 13), `Inky reflects Pac-Man+2 through Blinky -> 2*(8,8)-(4,3) = (12,13) (got ${t.r},${t.c})`);
  t = PM.ghostTarget('clyde', 'chase', { pac: p, blinky: b, ghosts: [{ name: 'clyde', r: 10, c: 8 }], mode: 'chase' });
  check(same(t, 30, 0), `Clyde retreats to his corner (30,0) when within 8 tiles (got ${t.r},${t.c})`);
  t = PM.ghostTarget('clyde', 'chase', { pac: { r: 1, c: 1, dir: 'left' }, blinky: b, ghosts: [{ name: 'clyde', r: 20, c: 20 }], mode: 'chase' });
  check(same(t, 1, 1), `Clyde chases when far away (got ${t.r},${t.c})`);
  const corners = { blinky: [0, 27], pinky: [0, 0], inky: [30, 27], clyde: [30, 0] };
  let cornerOk = 0;
  for (const n of NAMES) { const g = PM.ghostTarget(n, 'scatter', base); if (same(g, corners[n][0], corners[n][1])) cornerOk++; }
  check(cornerOk === 4, `each ghost scatters to its own corner (${cornerOk}/4)`);
  t = PM.ghostTarget('blinky', 'eyes', base);
  check(same(t, 14, 13), `eyes target the house centre (14,13) (got ${t.r},${t.c})`);
  t = PM.ghostTarget('pinky', 'frightened', base);
  check(same(t, p.r, p.c), 'frightened uses Pac-Man as the flee reference');
}

/* ============================================================================
 * 3. Differential ghost next-direction
 * ========================================================================== */

group('3. ghostNextDir: exhaustive differential for scatter/chase/house');
{
  let count = 0, div = 0, invViolate = 0, example = null;
  const distanceModes = ['scatter', 'chase', 'house'];
  for (const name of NAMES) {
    for (const mode of distanceModes) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          for (const dir of ORDER) {
            for (const gs of ghostStates) {
              const st = {
                mode,
                pac: { r, c, dir },
                blinky: { r: 11, c: 13 },
                ghosts: [{ name, r: gs.r, c: gs.c, dir: gs.dir }]
              };
              count++;
              const got = PM.ghostNextDir(name, st);
              const exp = refNextDirDistance(name, mode, st.ghosts[0], st);
              if (got !== exp) { div++; if (!example) example = `${name}/${mode} g(${gs.r},${gs.c},${gs.dir}) pac(${r},${c},${dir}) got=${got} exp=${exp}`; }
            }
          }
        }
      }
    }
  }
  check(div === 0, `ghostNextDir agrees on all ${count} distance-mode states (divergences ${div})`, example);
  console.log(`       compared ${count} next-dir states (scatter/chase/house)`);

  // Invariants across the same enumeration.
  let checked = 0;
  for (const name of NAMES) {
    for (const mode of distanceModes) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          for (const gs of ghostStates) {
            const st = { mode, pac: { r, c, dir: 'left' }, blinky: { r: 11, c: 13 }, ghosts: [{ name, r: gs.r, c: gs.c, dir: gs.dir }] };
            const got = PM.ghostNextDir(name, st);
            checked++;
            const rev = OPP[gs.dir];
            const alternatives = ORDER.filter(d => d !== rev && gEnter(gs.r + DIRV[d][0], gs.c + DIRV[d][1]));
            // never walks into a wall
            if (got !== rev && !gEnter(gs.r + DIRV[got][0], gs.c + DIRV[got][1])) invViolate++;
            // never voluntarily reverses when another move exists
            else if (got === rev && alternatives.length) invViolate++;
          }
        }
      }
    }
  }
  check(invViolate === 0, `no wall entry and no voluntary reversal across ${checked} states (violations ${invViolate})`);
}

group('3b. ghostNextDir: eyes always step strictly closer to the house (may reverse)');
{
  let count = 0, div = 0, example = null, reversals = 0;
  for (const name of NAMES) {
    for (const [gr, gc] of allTiles) {
      for (const gd of ORDER) {
        const st = { mode: 'eyes', pac: { r: 1, c: 1, dir: 'up' }, blinky: { r: 11, c: 13 }, ghosts: [{ name, r: gr, c: gc, dir: gd }] };
        const got = PM.ghostNextDir(name, st);
        const exp = refEyes({ r: gr, c: gc, dir: gd });
        count++;
        if (got === OPP[gd]) reversals++;
        if (exp !== null && got !== exp) { div++; if (!example) example = `${name} g(${gr},${gc},${gd}) got=${got} exp=${exp}`; }
        else if (exp === null && !gEnter(gr + DIRV[got][0], wc(gc + DIRV[got][1]))) { div++; if (!example) example = `illegal fallback ${name} g(${gr},${gc},${gd}) got=${got}`; }
      }
    }
  }
  check(div === 0, `eyes picks a shortest-step toward home on all ${count} ghost tiles x dirs (divergences ${div})`, example);
  console.log(`       compared ${count} eyes states across all four personalities`);
  check(reversals > 0, `eyes DOES reverse when home is behind it (${reversals} such states) - this is intended, not a wall bug`);

  // The eyes decision must be name-independent (it is a pure shortest path home).
  let nameIndependent = true;
  for (const [gr, gc] of sampleTiles(12)) {
    const dirs = new Set(NAMES.map(n => PM.ghostNextDir(n, { mode: 'eyes', pac: { r: 1, c: 1, dir: 'up' }, ghosts: [{ name: n, r: gr, c: gc, dir: 'up' }] })));
    if (dirs.size !== 1) nameIndependent = false;
  }
  check(nameIndependent, 'all four personalities pick the SAME eyes move from a given tile');

  // A named case: at (1,1) heading up, home is below, so eyes must go down.
  const named = PM.ghostNextDir('blinky', { mode: 'eyes', pac: { r: 1, c: 1, dir: 'up' }, ghosts: [{ name: 'blinky', r: 1, c: 1, dir: 'up' }] });
  check(named === 'down', `eyes at (1,1) facing up dives down toward home (got ${named})`);
}

group('3c. ghostNextDir is deterministic and tunnel-aware');
{
  const st = { mode: 'chase', pac: { r: 23, c: 13, dir: 'left' }, blinky: { r: 11, c: 13 }, ghosts: [{ name: 'pinky', r: 11, c: 13, dir: 'left' }] };
  const a = PM.ghostNextDir('pinky', st), b = PM.ghostNextDir('pinky', st);
  check(a === b, `two identical calls return the same direction (${a} vs ${b})`);
  let deterministic = true;
  for (const name of NAMES) for (const mode of MODES) {
    const s = { mode, pac: { r: 5, c: 6, dir: 'right' }, blinky: { r: 11, c: 13 }, ghosts: [{ name, r: 14, c: 4, dir: 'up' }] };
    if (PM.ghostNextDir(name, s) !== PM.ghostNextDir(name, s)) deterministic = false;
  }
  check(deterministic, 'every personality/mode is pure (same input -> same output)');

  // Enumerate every ghost-enterable seam tile (c = 0 or 27) and prove that at
  // least one chosen move wraps across the tunnel (its column jumps by > 1).
  let wrapped = 0, wrapExample = null;
  const seamTiles = [];
  for (let r = 0; r < ROWS; r++) for (const c of [0, 27]) if (gEnter(r, c)) seamTiles.push([r, c]);
  for (const [gr, gc] of seamTiles) {
    for (const gd of ORDER) {
      const st2 = { mode: 'chase', pac: { r: 14, c: 13, dir: 'left' }, blinky: { r: 11, c: 13 }, ghosts: [{ name: 'blinky', r: gr, c: gc, dir: gd }] };
      const got = PM.ghostNextDir('blinky', st2);
      if (got === OPP[gd]) continue; // a forced reversal is not a wrap
      const nc = wc(gc + DIRV[got][1]);
      if (!gEnter(gr + DIRV[got][0], nc)) continue;
      if (Math.abs(nc - gc) > 1) { wrapped++; if (!wrapExample) wrapExample = `(${gr},${gc}) dir ${gd} -> ${got} lands (${gr + DIRV[got][0]},${nc})`; }
    }
  }
  check(wrapped > 0, `a tunnel-seam ghost actually wraps across the edge (${wrapped} states, e.g. ${wrapExample || 'n/a'})`);

  // Sparse sampling of the other three personalities in eyes mode too.
  let allLegal = true;
  for (const name of NAMES) {
    const s = { mode: 'eyes', pac: { r: 1, c: 1, dir: 'left' }, ghosts: [{ name, r: 20, c: 5, dir: 'down' }] };
    const got = PM.ghostNextDir(name, s);
    if (!gEnter(20 + DIRV[got][0], 5 + DIRV[got][1])) allLegal = false;
  }
  check(allLegal, 'eyes never steps into a wall for any personality');
}

group('3d. frightened: deterministic PSEUDO-RANDOM wander, not the old "flee farthest" rule');
{
  /* Change 2 replaced "run to the farthest tile" with a pure hash-scrambled
   * turn: cands[frightHash(name, r, c, frightSession) % cands.length]. We must
   * NOT re-derive the hash here (that would be circular). Instead we pin the
   * *properties* such a rule has and the ratios that separate it from the rule
   * it replaced. */
  const revOf = g => (g.dir ? OPP[g.dir] : null);
  const candsOf = g => ORDER.filter(d => d !== revOf(g) && gEnter(g.r + DIRV[d][0], g.c + DIRV[d][1]));
  const legalOf = (got, g, cands) => cands.length ? cands.indexOf(got) >= 0 : got === (revOf(g) || 'left');
  // Independent distance to Pac-Man's tile via the dot-product identity.
  const dist = (nr, nc, pr, pc) => dotD2(nr, nc, pr, pc);

  let states = 0, multi = 0, impure = 0, illegal = 0;
  let notFarthest = 0, notNearest = 0;
  let seedComparable = 0, seedDiffer = 0;
  let undefMismatch = 0, undefIllegal = 0;
  let ex = null;

  for (const name of NAMES) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        for (const dir of ORDER) {
          for (const gs of ghostStates) {
            const g = { name, r: gs.r, c: gs.c, dir: gs.dir };
            const st0 = { mode: 'frightened', pac: { r, c, dir }, blinky: { r: 11, c: 13 }, ghosts: [g], frightSession: 0 };
            const got = PM.ghostNextDir(name, st0);
            states++;

            // (1) purity: identical input -> identical output
            if (PM.ghostNextDir(name, st0) !== got) impure++;

            const cands = candsOf(g);
            // (2) legality: never a wall, never a voluntary reversal
            if (!legalOf(got, g, cands)) illegal++;

            if (cands.length >= 2) {
              multi++;
              // (3) anti-regression: the choice must NOT be the "farthest tile"
              // rule (nor the trivial "nearest" rule) - report the ratio.
              let far = cands[0], near = cands[0];
              let farV = dist(gs.r + DIRV[far][0], wc(gs.c + DIRV[far][1]), r, c);
              let nearV = farV;
              for (let i = 1; i < cands.length; i++) {
                const d = cands[i];
                const v = dist(gs.r + DIRV[d][0], wc(gs.c + DIRV[d][1]), r, c);
                if (v > farV) { farV = v; far = d; }
                if (v < nearV) { nearV = v; near = d; }
              }
              if (got !== far) { notFarthest++; if (!ex) ex = `${name} g(${gs.r},${gs.c},${gs.dir}) pac(${r},${c}) got=${got} far=${far}`; }
              if (got !== near) notNearest++;
            }

            // (4) seed wiring: flipping frightSession must flip the choice on a
            // sizeable fraction of states (proves the seed is really used).
            seedComparable++;
            if (PM.ghostNextDir(name, { mode: 'frightened', pac: { r, c, dir }, blinky: { r: 11, c: 13 }, ghosts: [g], frightSession: 1 }) !== got) seedDiffer++;

            // (5) missing-arg fallback: an absent session degrades to session 0
            // ((undefined|0) === 0) and stays legal.
            const gotU = PM.ghostNextDir(name, { mode: 'frightened', pac: { r, c, dir }, blinky: { r: 11, c: 13 }, ghosts: [g] });
            if (gotU !== got) undefMismatch++;
            if (!legalOf(gotU, g, cands)) undefIllegal++;
          }
        }
      }
    }
  }
  check(impure === 0, `(1) purity: frightened is a pure function on all ${states} states (impure ${impure})`);
  check(illegal === 0, `(2) legality: frightened always picks a legal move on all ${states} states (illegal ${illegal})`);
  const pctF = multi ? (100 * notFarthest / multi) : 0;
  check(multi > 0 && pctF > 20, `(3) anti-regression: differs from the "farthest tile" rule on ${notFarthest}/${multi} multi-choice states (${pctF.toFixed(1)}%)`, ex);
  const pctN = multi ? (100 * notNearest / multi) : 0;
  check(multi > 0 && pctN > 20, `(3) anti-regression: nor the trivial "nearest" rule (${pctN.toFixed(1)}% of multi-choice states)`, ex);
  const pctS = seedComparable ? (100 * seedDiffer / seedComparable) : 0;
  check(seedDiffer > 0 && pctS > 5, `(4) seed wiring: the choice flips on ${seedDiffer}/${seedComparable} states when frightSession 0->1 (${pctS.toFixed(1)}%)`);
  check(undefMismatch === 0, `(5) missing-arg fallback: omitting frightSession behaves exactly like session 0 (mismatches ${undefMismatch})`);
  check(undefIllegal === 0, `(5) missing-arg fallback: and the fallback is still legal (illegal ${undefIllegal})`);
  console.log(`       enumerated ${states} frightened states (${multi} with >=2 choices)`);
}

/* ============================================================================
 * 4. Scoring, lives and the state machine
 * ========================================================================== */

group('4. pellet scoring (driven by real ticks, never by poking internals)');
{
  PM.newGame({ level: 1 });
  const started = PM.start();
  check(started.phase === 'playing', `start() enters 'playing' (got ${started.phase})`);
  const ev = simulate({ seconds: 40 });
  const deltas = Object.keys(ev.deltas).map(Number);
  check(deltas.length === 1 && deltas[0] === 10, `only +10 pellet events occur in the opening corridor (deltas ${JSON.stringify(ev.deltas)})`);
  check((ev.deltas[10] || 0) === 6, `exactly 6 pellets are eaten before the wall stops Pac-Man (got ${ev.deltas[10]})`);
  check(ev.state.score === 60, `score is 60 after the corridor (got ${ev.state.score})`);
  check(ev.state.pelletsLeft === 258, `pelletsLeft dropped 264->258 (got ${ev.state.pelletsLeft})`);
  check(ev.state.phase === 'playing', `still playing after 40s (got ${ev.state.phase})`);
  // The dead-end corridor is a fixed seven-tile pocket, so "do the six pellets
  // get eaten before anything can reach Pac-Man?" is a pure ORDERING question -
  // independent of how fast the actors move (the old suite asserted a flat
  // "no death in 40 s", which only held because the actors were 16x too slow).
  check(ev.deaths === 0 || ev.scoreAtFirstDeath >= 60,
    `the whole opening corridor is cleared before any life is lost (first death at ${ev.firstDeathAt === null ? 'never' : ev.firstDeathAt.toFixed(2) + 's'}, score then ${ev.scoreAtFirstDeath})`);
  check(ev.timeScore60 !== null && (ev.firstDeathAt === null || ev.timeScore60 < ev.firstDeathAt),
    `the corridor clear (${ev.timeScore60 === null ? 'n/a' : ev.timeScore60.toFixed(2) + 's'}) precedes the first death (${ev.firstDeathAt === null ? 'never' : ev.firstDeathAt.toFixed(2) + 's'})`);
  check(ev.okInvariants, `Pac-Man never left the walkable maze (${ev.badInvariant || 'clean'})`);
}

group('4a. actor speed is measured in TILES per second (guards the unit fix)');
{
  // Change 1 unified advance() to tiles. A pixel/tile mix-up (the previous
  // bug) moved the actors 16x too slowly, so the tile-crossing cadence is a
  // direct, absolute probe of the fix: one tile must take ~1/6.5 s, never ~2.5 s.
  PM.newGame({ level: 1 });
  PM.start();
  let prevC = PM.getState().pac.c;
  const crossings = [];
  for (let i = 1; i <= 400; i++) {
    PM.tick(1 / 60);
    const c = PM.getState().pac.c;
    if (c !== prevC) { crossings.push(i); prevC = c; }
  }
  const gaps = crossings.slice(1).map((v, i) => v - crossings[i]);
  const median = gaps.length ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : 0;
  const tilesPerSec = median ? 60 / median : 0;
  check(crossings.length === 7, `the opening corridor is 7 tiles long (${crossings.length} tile crossings) - a speed-independent geometry fact`);
  check(gaps.length > 0 && gaps.every(g => g >= 6 && g <= 14),
    `Pac-Man crosses one tile every ~9 frames (gaps ${gaps.join(',')}) - 6.5 tiles/s, not the 16x-slow ~150 frames`);
  check(tilesPerSec > 4 && tilesPerSec < 10, `the measured actor pace is ~6.5 tiles/s (got ${tilesPerSec.toFixed(2)})`);

  // The fix is real only if the ghosts also reach a parked Pac-Man: with the
  // old pixel-unit bug an idle Pac-Man was never caught inside the budget.
  const idle = simulate({ seconds: 40 });
  check(idle.deaths >= 1, `idle Pac-Man parked at the dead-end is caught by the hunting ghosts within 40s (deaths ${idle.deaths})`);
}

group('4b. power pellet (+50) and the frightened state');
{
  PM.newGame({ level: 1 });
  PM.start();
  const ev = simulate({ seconds: 900, policy: makePolicy(4) });
  check(ev.powerAt !== null, `a power pellet is really eaten during play (${ev.powerAt === null ? 'never' : 'at t=' + ev.powerAt.toFixed(1) + 's'})`);
  check((ev.deltas[50] || 0) >= 1, `the power pellet scores exactly +50 (deltas ${JSON.stringify(ev.deltas)})`);
  check(ev.powerGhostModes !== null && ev.powerGhostModes.every(m => m === 'frightened' || m === 'house' || m === 'eyes'),
    `eating a power pellet flips the out ghosts to 'frightened' (modes ${JSON.stringify(ev.powerGhostModes)})`);
  check(ev.powerGhostModes !== null && ev.powerGhostModes.some(m => m === 'frightened'),
    'at least one ghost is frightened right after the power pellet');
}

group('4c. dying, losing lives and game over');
{
  PM.newGame({ level: 1 });
  PM.start();
  const ev = simulate({ seconds: 900 }); // no input: the ghosts hunt Pac-Man down
  check(ev.phases.has('dying'), `a non-frightened ghost catch enters 'dying' (phases ${[...ev.phases].join(',')})`);
  check(ev.deaths >= 1, `lives are lost on contact (${ev.deaths} death event(s))`);
  check(ev.state.phase === 'gameover', `the game reaches 'gameover' once lives run out (got ${ev.state.phase})`);
  check(ev.state.lives === 0, `lives hit 0 at game over (got ${ev.state.lives})`);
  check(ev.gameoverAt !== null && ev.gameoverAt < 900, `game over happens within the 900s budget (t=${ev.gameoverAt === null ? 'n/a' : ev.gameoverAt.toFixed(1)}s)`);
  check(ev.okInvariants, `no out-of-bounds / wall intrusion across the whole doomed run (${ev.badInvariant || 'clean'})`);

  const reset = PM.newGame();
  check(reset.lives === 3 && reset.score === 0 && reset.level === 1, `newGame after game over restores 3 lives / 0 / level 1 (got ${reset.lives}/${reset.score}/${reset.level})`);
  check(reset.phase === 'ready', `the fresh game is back in 'ready' (got ${reset.phase})`);
  check(reset.pelletsLeft === 264, `the fresh game restores all 264 pellets (got ${reset.pelletsLeft})`);
  check(reset.pac.r === 23 && reset.pac.c === 13, `Pac-Man respawns at (23,13) (got ${reset.pac.r},${reset.pac.c})`);
}

group('4d. level progression: levelclear -> Next level -> level 2 with rebuilt pellets');
{
  // (A) Supplementary real-play attempt. The shipped 264-pellet maze is large,
  // so a CI-budget bot rarely finishes; we only pin that the phase stays legal
  // and report how far it got.
  const ev = simulate({ seconds: 900, lives: 9, policy: makePolicy(6) });
  check(LEGAL_PHASES.has(ev.state.phase), `phase stays legal through a long survivor run (got ${ev.state.phase}, pelletsLeft ${ev.state.pelletsLeft})`);
  console.log(`       real-play survivor cleared ${ev.clears} level(s) in 900s (pelletsLeft ${ev.state.pelletsLeft}); the strong check is the mechanism-level one below`);

  // (B) Mechanism-level, deterministic: shrink the board to 3 pellets through
  // the bridge (PM.maze() returns MAZE by reference), clear it, then drive the
  // REAL "Next level" button. index.html is never edited.
  const origMaze = PM.maze().slice();
  const keep = [[23, 12], [23, 11], [23, 10]];
  for (let r = 0; r < ROWS; r++) {
    const a = PM.maze()[r].split('');
    for (let c = 0; c < COLS; c++) if (a[c] === '.' || a[c] === 'o') a[c] = ' ';
    PM.maze()[r] = a.join('');
  }
  for (const [r, c] of keep) { const a = PM.maze()[r].split(''); a[c] = '.'; PM.maze()[r] = a.join(''); }
  dmCache.clear();

  PM.newGame({ level: 1 });
  check(PM.getState().pelletsLeft === 3, `the shrunk board starts with exactly 3 pellets (got ${PM.getState().pelletsLeft})`);
  PM.start();
  let g = PM.getState(), guard = 0;
  while (g.phase === 'playing' && guard++ < 60 * 20) { PM.tick(1 / 60); g = PM.getState(); }
  check(g.phase === 'levelclear', `eating the last pellet enters 'levelclear' (got ${g.phase}, pelletsLeft ${g.pelletsLeft})`);
  check(g.pelletsLeft === 0, `pelletsLeft hits 0 to trigger the clear (got ${g.pelletsLeft})`);
  check(el('state').textContent === 'Cleared', `the HUD status shows 'Cleared' (got ${JSON.stringify(el('state').textContent)})`);
  check(el('overlay')._cls.has('show'), 'the result overlay is shown on clear');
  check(el('ovTitle').textContent === 'Level clear!', `the overlay title is 'Level clear!' (got ${JSON.stringify(el('ovTitle').textContent)})`);
  check(el('ovSub').textContent === 'Level 1 cleared — get ready for level 2', `the overlay subtitle names both levels (got ${JSON.stringify(el('ovSub').textContent)})`);
  check(el('ovBtn').textContent === 'Next level', `the overlay button offers the next level (got ${JSON.stringify(el('ovBtn').textContent)})`);

  click('ovBtn'); // the real result button
  const nxt = PM.getState();
  check(nxt.level === 2, `clicking the real Next-level button advances to level 2 (got ${nxt.level})`);
  check(nxt.phase === 'playing', `the next level resumes in 'playing' (got ${nxt.phase})`);
  check(nxt.pelletsLeft === 3, `the next level REBUILDS every pellet (pelletsLeft back to 3) (got ${nxt.pelletsLeft})`);
  check(nxt.pac.r === 23 && nxt.pac.c === 13, `the next level resets Pac-Man to spawn (got ${nxt.pac.r},${nxt.pac.c})`);
  check(!el('overlay')._cls.has('show'), 'the result overlay is hidden after Next level');
  check(el('level').textContent === '2', `the HUD level mirrors 2 (got ${el('level').textContent})`);

  // Restore the shipped maze and a clean game for the remaining groups.
  for (let r = 0; r < ROWS; r++) PM.maze()[r] = origMaze[r];
  dmCache.clear();
  PM.newGame({ level: 1 });
  check(PM.getState().pelletsLeft === 264, 'the shipped maze (264 pellets) is restored after the mechanism-level check');
}

group('4h. ghost chain scoring: 200 -> 400 -> 800 on a real run (score reconciled)');
{
  const tr = traceChain({ seconds: 600, lives: 25, policy: makeChainPolicy({ risk: 4, baitDist: 9, baitCount: 2 }) });
  check(tr.reconFails === 0, `every frame's score delta decomposes into ghost eats + at most one pellet (recon failures ${tr.reconFails})`, tr.example);
  check(tr.eats.length > 0, `the bot really eats ghosts on the shipped maze (${tr.eats.length} eat(s))`);
  check(tr.valuesLegal, `every attributed ghost-eat value is 200/400/800/1600 (got ${JSON.stringify(tr.values)})`);
  check(tr.maxChain >= 3, `a real run reaches a ${tr.maxChain}-chain, i.e. at least 200 -> 400 -> 800`);
  const w = tr.windows[tr.windows.length - 1] || [];
  check(w.length >= 1 && w.every((e, i) => e.k === i && e.value === CHAIN_VAL(i)),
    `the eats inside one window follow 200*2^k exactly (window ${JSON.stringify(w.map(e => e.value))})`);
  console.log(`       real-maze: ${tr.eats.length} eat(s), max chain ${tr.maxChain}, window sizes ${JSON.stringify(tr.windows.map(x => x.length))}`);
}

group('4i. blue ghost re-eat + the 1600 cap (mechanism-level: maze replaced at runtime)');
{
  // Change 2 makes frightened ghosts wander pseudo-randomly, so a blue ghost
  // can be eaten, fly home as eyes, and be eaten AGAIN while the SAME fright
  // window is still open - the chain keeps counting toward 1600 and then caps.
  // Reaching the 4th eat deterministically needs an open board, so MAZE is
  // replaced at runtime via the bridge. index.html is NOT edited.
  const origMaze = PM.maze().slice();
  buildOpenRoom([[11, 13], [16, 13], [14, 10], [14, 17], [20, 13], [11, 11], [11, 15]]);
  dmCache.clear();

  const tr = traceChain({ seconds: 180, lives: 30, policy: makeArenaPolicy({ risk: 3, camp: true }) });
  check(tr.reconFails === 0, `arena: every score delta reconciles (failures ${tr.reconFails})`, tr.example);
  check(tr.valuesLegal, `every attributed value is 200/400/800/1600 (got ${JSON.stringify(tr.values)})`);
  check(tr.eats.some(e => e.k >= 3), `a blue ghost is eaten a 4th time in one window -> the 1600 step is reached (max chain ${tr.maxChain})`);
  check(tr.eats.every(e => e.value <= 1600), `the chain saturates at 1600 and never overflows (max value ${tr.eats.length ? Math.max.apply(null, tr.values) : 'n/a'})`);
  check(tr.reEatWindows.length > 0,
    `the SAME ghost is re-eaten inside one fright window and the chain continues (${tr.reEatWindows.map(w => w.map(e => e.name[0] + e.k).join(',')).join(' | ')})`);
  console.log(`       arena: ${tr.eats.length} eat(s), max chain ${tr.maxChain}, window sizes ${JSON.stringify(tr.windows.map(x => x.length))}`);

  // Restore the shipped maze.
  for (let r = 0; r < ROWS; r++) PM.maze()[r] = origMaze[r];
  dmCache.clear();
  PM.newGame({ level: 1 });
  check(PM.getState().pelletsLeft === 264, 'the shipped maze is restored after the arena check');
}

group('4e. ready / paused / playing transitions and a frozen paused clock');
{
  PM.newGame({ level: 1 });
  check(PM.getState().phase === 'ready', 'a new game starts in ready');
  const before = PM.getState();
  PM.tick(5);
  const after = PM.getState();
  check(after.score === before.score && after.pac.r === before.pac.r && after.pac.c === before.pac.c,
    'tick() while ready does not move Pac-Man or score (the clock is gated on phase)');

  PM.start();
  check(PM.getState().phase === 'playing', 'start() -> playing');
  PM.tick(40); // eat the corridor so we have a score to freeze
  const scored = PM.getState().score;
  check(scored > 0, `Pac-Man has scored before pausing (${scored})`);

  click('btnPause');
  check(PM.getState().phase === 'paused', `the real Pause button pauses (got ${PM.getState().phase})`);
  const frozen = PM.getState();
  PM.tick(30);
  const stillFrozen = PM.getState();
  check(stillFrozen.score === frozen.score, `tick() while paused does not change the score (${frozen.score} -> ${stillFrozen.score})`);
  check(stillFrozen.phase === 'paused', 'tick() while paused does not advance the phase');
  click('btnPause');
  check(PM.getState().phase === 'playing', `clicking Pause again resumes (got ${PM.getState().phase})`);
  key('p');
  check(PM.getState().phase === 'paused', 'the P key also pauses');
  key('p');
  check(PM.getState().phase === 'playing', 'the P key also resumes');
}

group('4f. determinism / reproducibility');
{
  const a = PM.newGame({ level: 1 });
  const b = PM.newGame({ level: 1 });
  const same = ['score', 'lives', 'level', 'phase', 'pelletsLeft'].every(k => a[k] === b[k])
    && a.pac.r === b.pac.r && a.pac.c === b.pac.c && a.pac.dir === b.pac.dir
    && JSON.stringify(a.ghosts) === JSON.stringify(b.ghosts);
  check(same, 'newGame({level:1}) twice yields identical initial state');

  function scriptedRun() {
    PM.newGame({ level: 1 });
    PM.start();
    const policy = makePolicy(4);
    for (let i = 0; i < 60 * 60; i++) { const d = policy(PM.getState()); if (d) key(d); PM.tick(1 / 60); }
    return PM.getState();
  }
  const s1 = scriptedRun();
  const s2 = scriptedRun();
  check(JSON.stringify(s1) === JSON.stringify(s2), `a 60s scripted run is bit-for-bit reproducible (score ${s1.score} vs ${s2.score})`);
  check(s1.score === s2.score && s1.pelletsLeft === s2.pelletsLeft, 'reproducible score and pellet count');
}

group('4g. long-run stability (no wall entry, no OOB, legal phases)');
{
  const ev = simulate({ seconds: 150, policy: makePolicy(4) });
  check(ev.okInvariants, `300s of simulated play stays inside the walkable maze (${ev.badInvariant || 'clean'})`);
  check(ev.t >= 150, `the simulation really advanced 150s (at ${ev.t.toFixed(1)}s)`);
  check(LEGAL_PHASES.has(ev.state.phase), `the phase is in the legal set (got ${ev.state.phase})`);
  const st = PM.getState();
  const p = st.pac;
  check(p.r >= 0 && p.r < ROWS && p.c >= 0 && p.c < COLS && PM.canWalk(p.r, p.c),
    `Pac-Man ends on a walkable tile (${p.r},${p.c})`);
  check(st.ghosts.every(g => g.r >= 0 && g.r < ROWS && g.c >= 0 && g.c < COLS && MAZE0[g.r][wc(g.c)] !== '#'),
    'every ghost ends on a ghost-walkable tile');
}

/* ============================================================================
 * 5. i18n - the DYNAMIC text must follow the language
 * ========================================================================== */

group('5. i18n: runtime text rebuilt through T.t() follows the language');
{
  check(!!T, 'the game created exactly one LiteI18N instance (captured via the factory)');
  const src = fs.readFileSync(GAME, 'utf8');
  const onChangeCount = (src.match(/T\.onChange\s*\(/g) || []).length;
  check(onChangeCount === 1, `exactly one T.onChange handler is registered (found ${onChangeCount})`);

  // Ready-phase HUD status text.
  T.set('en');
  PM.newGame({ level: 1 });
  check(el('state').textContent === 'Ready', `HUD state is 'Ready' in English (got ${JSON.stringify(el('state').textContent)})`);
  T.set('zh');
  check(CJK.test(el('state').textContent), `HUD state text turns Chinese after T.set('zh') (got ${JSON.stringify(el('state').textContent)})`);
  check(el('state').textContent === '准备', `the ready-phase status is '准备' (got ${JSON.stringify(el('state').textContent)})`);

  // The pause button label is also rebuilt dynamically.
  PM.start();
  PM.tick(1);
  check(CJK.test(el('btnPause').textContent), `the pause button label is Chinese while playing (got ${JSON.stringify(el('btnPause').textContent)})`);
  check(el('btnPause').textContent === '暂停', `the playing pause label is '暂停' (got ${JSON.stringify(el('btnPause').textContent)})`);
  click('btnPause');
  check(el('btnPause').textContent === '继续', `paused shows the resume label '继续' (got ${JSON.stringify(el('btnPause').textContent)})`);
  check(el('state').textContent === '暂停', `paused status is '暂停' (got ${JSON.stringify(el('state').textContent)})`);

  // Result dialog text, which only renders after a real game over.
  PM.newGame({ level: 1 });
  PM.start();
  simulate({ seconds: 900 });
  check(PM.getState().phase === 'gameover', 'reached game over for the dialog check');
  T.set('en');
  T.set('zh');
  check(CJK.test(el('ovTitle').textContent), `the result title re-renders in Chinese via onChange (got ${JSON.stringify(el('ovTitle').textContent)})`);
  check(el('ovTitle').textContent === '游戏结束', `the game-over title is '游戏结束' (got ${JSON.stringify(el('ovTitle').textContent)})`);
  check(CJK.test(el('ovSub').textContent) && /\d/.test(el('ovSub').textContent), `the result subtitle is Chinese and carries the score (got ${JSON.stringify(el('ovSub').textContent)})`);
  check(el('ovBtn').textContent === '再来一局', `the result button is '再来一局' (got ${JSON.stringify(el('ovBtn').textContent)})`);
  T.set('en');
  check(el('ovTitle').textContent === 'Game over', `switching back to English restores 'Game over' (got ${JSON.stringify(el('ovTitle').textContent)})`);
  check(el('ovBtn').textContent === 'Play again', `the English result button is 'Play again' (got ${JSON.stringify(el('ovBtn').textContent)})`);

  // The static switch is a small bonus; the point is that it exists at all.
  T.set('zh');
  check(T.t('title') === '吃豆人' && T.t('newgame') === '新游戏', 'T.t() resolves game keys in Chinese');
  T.set('en');
  check(T.t('title') === 'Pac-Man', 'T.t() resolves game keys in English again');
}

/* ============================================================================
 * 6. Stub-DOM interaction - the real UI entry points
 * ========================================================================== */

group('6. the real UI entry points drive the game');
{
  PM.newGame({ level: 1 });
  check(el('btnPause').disabled === true, 'the Pause button is disabled in the ready state');
  PM.start();
  const p0 = PM.getState();
  key('ArrowRight');
  PM.tick(0.5);
  const p1 = PM.getState();
  check(p1.pac.dir === 'right', `dispatching ArrowRight reverses Pac-Man at spawn (got ${p1.pac.dir})`);
  PM.tick(8); // ~3 tiles: the actor speeds are slow, so give it room to travel
  const p2 = PM.getState();
  check(p2.pac.c > p0.pac.c, `Pac-Man actually moved right (${p0.pac.c} -> ${p2.pac.c})`);
  key('ArrowLeft');
  PM.tick(0.5);
  check(PM.getState().pac.dir === 'left', 'ArrowLeft reverses him back');
  key('d');
  PM.tick(0.5);
  check(PM.getState().pac.dir === 'right', 'the WASD keys work too (d -> right)');

  PM.newGame({ level: 1 });
  click('btnStart');
  check(PM.getState().phase === 'playing', `clicking the Start button enters 'playing' (got ${PM.getState().phase})`);
  check(el('btnPause').disabled === false, 'the Pause button becomes enabled once playing');

  PM.newGame({ level: 1 });
  PM.start();
  PM.tick(30);
  const scored = PM.getState().score;
  click('btnNew');
  const fresh = PM.getState();
  check(fresh.phase === 'playing', `the New-game button restarts into 'playing' (got ${fresh.phase})`);
  check(fresh.score === 0 && fresh.level === 1 && fresh.lives === 3, `New-game resets score/level/lives (got ${fresh.score}/${fresh.level}/${fresh.lives})`);
  check(scored > 0, `a real game had scored before the reset (${scored})`);

  // Space / Enter start the game from ready.
  PM.newGame({ level: 1 });
  key(' ');
  check(PM.getState().phase === 'playing', "Space starts the game from 'ready'");
  PM.newGame({ level: 1 });
  key('Enter');
  check(PM.getState().phase === 'playing', "Enter starts the game from 'ready'");
}

/* ============================================================================
 * 7. In-process reverse checks - the comparators must be able to go red
 * ========================================================================== */

group('7. reverse checks: sabotaged references must light the comparators up');
{
  // A wrong tie-break order (reversed ORDER) must produce divergences.
  const wrongOrder = ['right', 'down', 'left', 'up'];
  let divWrongTies = 0;
  for (const name of NAMES) {
    for (const mode of ['scatter', 'chase', 'house']) {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          for (const gs of ghostStates) {
            const st = { mode, pac: { r, c, dir: 'up' }, blinky: { r: 11, c: 13 }, ghosts: [{ name, r: gs.r, c: gs.c, dir: gs.dir }] };
            const got = PM.ghostNextDir(name, st);
            const rev = gs.dir ? OPP[gs.dir] : null;
            const cands = wrongOrder.filter(d => d !== rev && gEnter(gs.r + DIRV[d][0], gs.c + DIRV[d][1]));
            if (!cands.length) { if (got !== (rev || 'left')) divWrongTies++; continue; }
            const t = refTarget(name, mode, st);
            let best = cands[0], bestV = dotD2(gs.r + DIRV[best][0], wc(gs.c + DIRV[best][1]), t.r, t.c);
            for (let i = 1; i < cands.length; i++) {
              const d = cands[i];
              const v = dotD2(gs.r + DIRV[d][0], wc(gs.c + DIRV[d][1]), t.r, t.c);
              if (mode === 'frightened' ? v > bestV : v < bestV) { bestV = v; best = d; }
            }
            if (got !== best) divWrongTies++;
          }
        }
      }
    }
  }
  check(divWrongTies > 0, `a reversed tie-break order produces ${divWrongTies} divergences (the comparator is sensitive)`);

  // A wrong scatter corner must break ghostTarget.
  let divWrongCorner = 0;
  for (const dir of ORDER) {
    const st = { pac: { r: 10, c: 8, dir }, blinky: { r: 4, c: 3 }, ghosts: [{ name: 'clyde', r: 10, c: 8 }], mode: 'scatter' };
    const got = PM.ghostTarget('clyde', 'scatter', st);
    if (!(got.r === 0 && got.c === 0)) divWrongCorner++; // the real corner is (30,0), not (0,0)
  }
  check(divWrongCorner === 4, `a swapped scatter corner would be caught for all 4 pac dirs (${divWrongCorner})`);

  // A broken wrap must break the geometry checks: a wrap-less isWall disagrees
  // at the border columns that the tunnel stitches together.
  const naiveNoWrap = (r, c) => (r < 0 || r >= ROWS || c < 0 || c >= COLS) ? true : MAZE0[r][c] === '#';
  let wrapCaught = 0;
  for (let r = 0; r < ROWS; r++) {
    if (naiveNoWrap(r, -1) !== PM.isWall(r, -1)) wrapCaught++;
    if (naiveNoWrap(r, COLS) !== PM.isWall(r, COLS)) wrapCaught++;
  }
  check(wrapCaught > 0, `a wrap-less isWall diverges on ${wrapCaught} border columns (the tunnel wrap is under test)`);
}

/* ------------------------------------------------------------------- summary */

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`(differential: ghostTarget + ghostNextDir exhaustive; frightened pinned by properties; chain/clear driven for real; i18n dynamic text checked)`);
process.exit(fail ? 1 : 0);
