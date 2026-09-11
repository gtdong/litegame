#!/usr/bin/env node
/**
 * Logic tests for sokoban-game.
 *
 * The smoke test only proves the page does not throw. It cannot tell whether a
 * crate pushed into a corner is recoverable, whether undo really rewinds a
 * push, or — the expensive one — whether every bundled level is even solvable.
 *
 * This script does three things:
 *   1. sanity-checks the level data (one porter, crates == goals)
 *   2. breadth-first searches every level to prove it can be finished
 *   3. loads the real page in a fake DOM and *replays those solutions through
 *      the keydown handler*, so the win path is exercised the way a player
 *      reaches it (this is the lesson from tetris: a callable entry point is
 *      not the same thing as a reachable one).
 *
 * Usage:  node tools/sokoban-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'sokoban-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

/* ------------------------------------------------ pull the level data out */

// The game wraps everything in an IIFE, so `var LEVELS` never lands on the
// context object. Slice the array literal out of the source and evaluate it.
function levelsFromSource() {
  const src = fs.readFileSync(GAME, 'utf8');
  const marker = src.indexOf('var LEVELS = [');
  if (marker < 0) throw new Error('LEVELS not found in source');
  const open = src.indexOf('[', marker);
  let depth = 0, close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (!depth) { close = i; break; } }
  }
  return new Function(`return ${src.slice(open, close + 1)};`)();
}

const LEVELS = levelsFromSource();

/* ------------------------------------------------------- board utilities */

const DIRS = [
  { dr: -1, dc: 0, key: 'ArrowUp' },
  { dr: 1, dc: 0, key: 'ArrowDown' },
  { dr: 0, dc: -1, key: 'ArrowLeft' },
  { dr: 0, dc: 1, key: 'ArrowRight' }
];

function parse(layout) {
  const rows = layout.length;
  let cols = 0;
  for (const line of layout) cols = Math.max(cols, line.length);
  const wall = [], goal = [];
  const crates = [];
  let player = -1;
  for (let r = 0; r < rows; r++) {
    wall[r] = []; goal[r] = [];
    for (let c = 0; c < cols; c++) {
      const ch = layout[r][c] || ' ';
      wall[r][c] = ch === '#';
      goal[r][c] = ch === '.' || ch === '*' || ch === '+';
      if (ch === '$' || ch === '*') crates.push(r * cols + c);
      if (ch === '@' || ch === '+') player = r * cols + c;
    }
  }
  return { rows, cols, wall, goal, crates: crates.sort((a, b) => a - b), player };
}

// The porter can wander freely as long as he does not push a crate, so a whole
// reachable area is one state. Canonicalising him to the lowest cell index in
// that area collapses the search space by orders of magnitude.
function reachable(player, crateSet, g) {
  const seen = new Set([player]);
  const stack = [player];
  while (stack.length) {
    const cur = stack.pop();
    const r = Math.floor(cur / g.cols), c = cur % g.cols;
    for (let d = 0; d < 4; d++) {
      const nr = r + DIRS[d].dr, nc = c + DIRS[d].dc;
      if (nr < 0 || nc < 0 || nr >= g.rows || nc >= g.cols) continue;
      if (g.wall[nr][nc]) continue;
      const ni = nr * g.cols + nc;
      if (crateSet.has(ni) || seen.has(ni)) continue;
      seen.add(ni);
      stack.push(ni);
    }
  }
  return seen;
}

function regionRoot(player, crateSet, g) {
  let root = player;
  reachable(player, crateSet, g).forEach(i => { if (i < root) root = i; });
  return root;
}

// Shortest walking route between two free cells, avoiding the crates.
function walkPath(from, to, crateSet, g) {
  if (from === to) return [];
  const cameFrom = new Map([[from, null]]);
  const queue = [from];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const r = Math.floor(cur / g.cols), c = cur % g.cols;
    for (let d = 0; d < 4; d++) {
      const nr = r + DIRS[d].dr, nc = c + DIRS[d].dc;
      if (nr < 0 || nc < 0 || nr >= g.rows || nc >= g.cols) continue;
      if (g.wall[nr][nc]) continue;
      const ni = nr * g.cols + nc;
      if (crateSet.has(ni) || cameFrom.has(ni)) continue;
      cameFrom.set(ni, { prev: cur, dir: d });
      if (ni === to) {
        const out = [];
        let k = ni;
        while (cameFrom.get(k)) {
          const s = cameFrom.get(k);
          out.push(s.dir);
          k = s.prev;
        }
        return out.reverse();
      }
      queue.push(ni);
    }
  }
  return null;
}

/**
 * Breadth-first search over (crate layout, porter area) returning the full
 * key sequence that finishes the level, or null when it is unsolvable.
 *
 * The step unit is a PUSH, not a single keypress. That matters: with the porter
 * canonicalised to his area, a plain walk lands on the same state key and gets
 * pruned, so a walk-based search can never reach the tile he pushes from and
 * reports every level unsolvable. Every push moves a crate, so every successor
 * has a genuinely new key. The walking legs are spliced back in afterwards.
 */
function solve(layout) {
  const g = parse(layout);
  const goalSet = new Set();
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) if (g.goal[r][c]) goalSet.add(r * g.cols + c);
  }
  if (goalSet.size !== g.crates.length) return null;

  const keyOf = (crates, player) => `${crates.join(',')}|${regionRoot(player, new Set(crates), g)}`;
  const done = crates => crates.every(i => goalSet.has(i));

  const startKey = keyOf(g.crates, g.player);
  const cameFrom = new Map([[startKey, null]]);
  const queue = [{ crates: g.crates, player: g.player }];
  let head = 0;

  if (done(g.crates)) return [];

  while (head < queue.length) {
    const cur = queue[head++];
    const curKey = keyOf(cur.crates, cur.player);
    const crateSet = new Set(cur.crates);
    const reach = reachable(cur.player, crateSet, g);

    for (let ci = 0; ci < cur.crates.length; ci++) {
      const cIdx = cur.crates[ci];
      const cr = Math.floor(cIdx / g.cols), cc = cIdx % g.cols;

      for (let d = 0; d < 4; d++) {
        const sR = cr - DIRS[d].dr, sC = cc - DIRS[d].dc;   // the porter's stance
        if (sR < 0 || sC < 0 || sR >= g.rows || sC >= g.cols) continue;
        if (g.wall[sR][sC]) continue;
        const sIdx = sR * g.cols + sC;
        if (!reach.has(sIdx)) continue;                    // cannot get behind it

        const dR = cr + DIRS[d].dr, dC = cc + DIRS[d].dc;  // where the crate lands
        if (dR < 0 || dC < 0 || dR >= g.rows || dC >= g.cols) continue;
        if (g.wall[dR][dC]) continue;
        const destIdx = dR * g.cols + dC;
        if (crateSet.has(destIdx)) continue;

        const crates = cur.crates.map(x => (x === cIdx ? destIdx : x)).sort((a, b) => a - b);
        const nKey = keyOf(crates, cIdx);
        if (cameFrom.has(nKey)) continue;
        cameFrom.set(nKey, { prev: curKey, dir: d, stand: sIdx, crate: cIdx, dest: destIdx });

        if (!done(crates)) {
          queue.push({ crates, player: cIdx });
          continue;
        }

        // Solved: walk the parent chain back, then splice in the walking legs.
        const chain = [];
        let k = nKey;
        while (cameFrom.get(k)) {
          chain.push(cameFrom.get(k));
          k = cameFrom.get(k).prev;
        }
        chain.reverse();

        const out = [];
        let pos = g.player;
        let board = g.crates.slice();
        for (const step of chain) {
          const leg = walkPath(pos, step.stand, new Set(board), g);
          if (!leg) return null;                           // should not happen
          out.push(...leg.map(i => DIRS[i].key));           // walking leg
          out.push(DIRS[step.dir].key);                     // the push itself
          board[board.indexOf(step.crate)] = step.dest;
          board.sort((a, b) => a - b);
          pos = step.crate;
        }
        return out;
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------- fake DOM */

function makeContext() {
  const noop = () => ctxProxy;
  const ctxProxy = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)) });

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
      // Record custom properties instead of discarding them: the board's whole
      // geometry lives in --r/--c, so this is how the test reads positions.
      this._vars = {};
      this.style = {
        setProperty: (k, v) => { this._vars[k] = v; },
        removeProperty: k => { delete this._vars[k]; },
        getPropertyValue: k => this._vars[k]
      };
      this._text = '';
      this._cls = new Set();
      this.classList = {
        add: c => this._cls.add(c),
        remove: c => this._cls.delete(c),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); }
      };
    }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._cls].join(' '); }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html || ''; }
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
    fire(t, ev) { (this.handlers[t] || []).forEach(f => f(ev || {})); }
    appendChild(c) {
      if (c instanceof Frag) c.children.forEach(x => { x.parent = this; this.children.push(x); });
      else { c.parent = this; this.children.push(c); }
      return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute(k, v) { this._attrs = this._attrs || {}; this._attrs[k] = v; }
    getAttribute() { return null; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
  }

  const els = {};
  const winHandlers = {};

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => Date.now() },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: (() => {
      const store = {};
      return {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
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
      addEventListener() {}
    },
    navigator: { language: 'en' }
  };
  context.window = context;
  context.global = context;
  context.self = context;
  context.addEventListener = (t, f) => { (winHandlers[t] = winHandlers[t] || []).push(f); };
  context.removeEventListener = () => {};

  vm.createContext(context);
  return { context, els, winHandlers };
}

function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const html = fs.readFileSync(GAME, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => vm.runInContext(s, env.context, { filename: `sokoban#${i}` }));

  const key = k => (env.winHandlers.keydown || []).forEach(f => f({ key: k, preventDefault() {} }));
  const tileAt = el => ({ r: Number(el._vars['--r']), c: Number(el._vars['--c']) });
  const actors = () => env.els.actors.children;          // crates first, porter last
  const porter = () => tileAt(actors()[actors().length - 1]);
  const crates = () => actors().slice(0, -1).map(tileAt);
  const label = id => env.els[id].textContent;
  return { env, key, porter, crates, actors, label, overlayShown: () => env.els.overlay._cls.has('show') };
}

/* ------------------------------------------------------------------ tests */

group('level data');
check('ten levels are bundled', LEVELS.length === 10, `got ${LEVELS.length}`);
LEVELS.forEach((lv, i) => {
  const g = parse(lv);
  check(`level ${i + 1}: exactly one porter`, g.player >= 0);
  check(`level ${i + 1}: crates match goals`, g.crates.length > 0 && g.crates.length === g.goal.flat().filter(Boolean).length,
    `${g.crates.length} crates`);
  check(`level ${i + 1}: rectangular rows`, new Set(lv.map(s => s.length)).size === 1);
});

group('solvability (BFS)');
const solutions = LEVELS.map((lv, i) => {
  const t0 = Date.now();
  const sol = solve(lv);
  const ms = Date.now() - t0;
  check(`level ${i + 1} is solvable`, !!sol, sol ? `${sol.length} moves in ${ms}ms` : 'no solution found');
  return sol;
});

group('parsing');
{
  const g = parse(LEVELS[0]);
  check('level 1 porter parsed at (4,3)', g.player === 4 * g.cols + 3, `got ${g.player}`);
  check('level 1 has one crate', g.crates.length === 1 && g.crates[0] === 2 * g.cols + 3);
  check('level 1 has one goal', g.goal.flat().filter(Boolean).length === 1);
}

group('movement rules (level 1, real key events)');
{
  const B = boot();
  check('starts with crate count 1', B.actors().length === 2, `${B.actors().length} actors`);
  check('porter starts at (4,3)', B.porter().r === 4 && B.porter().c === 3, JSON.stringify(B.porter()));

  B.key('ArrowDown');
  check('walking into a wall does nothing', B.porter().r === 4 && B.porter().c === 3, JSON.stringify(B.porter()));
  check('blocked move does not count', B.label('moves') === '0', B.label('moves'));

  B.key('ArrowUp');
  check('porter steps onto the empty tile below the crate', B.porter().r === 3 && B.porter().c === 3, JSON.stringify(B.porter()));
  check('push not counted for a plain step', B.label('pushes') === '0', B.label('pushes'));

  B.key('ArrowUp');
  check('crate is pushed one tile up, away from the porter', B.crates()[0].r === 1 && B.crates()[0].c === 3, JSON.stringify(B.crates()[0]));
  check('porter follows the crate', B.porter().r === 2 && B.porter().c === 3, JSON.stringify(B.porter()));
  check('push counter incremented', B.label('pushes') === '1', B.label('pushes'));
  check('move counter incremented', B.label('moves') === '2', B.label('moves'));
  check('crate landed on the goal, so the level clears', B.overlayShown());
}

group('undo rewinds moves (level 2)');
{
  const B = boot();
  B.env.els.btnNext.fire('click');                 // level 2
  check('on level 2', B.label('lvLabel').indexOf('2') >= 0, B.label('lvLabel'));
  const start = JSON.stringify(B.porter());

  B.key('ArrowUp');
  B.key('ArrowLeft');
  check('two steps recorded', B.label('moves') === '2', B.label('moves'));

  B.key('u');
  check('porter steps back', B.porter().r === 1 && B.porter().c === 3, JSON.stringify(B.porter()));
  check('move counter decremented', B.label('moves') === '1', B.label('moves'));

  B.key('u');
  check('undoing to the start restores the porter', JSON.stringify(B.porter()) === start, JSON.stringify(B.porter()));
  check('counters bottom out at zero', B.label('moves') === '0' && B.label('pushes') === '0');
  check('undo on an empty history is a no-op', (() => { B.key('u'); return JSON.stringify(B.porter()) === start; })());
}

group('undo also rewinds a push (level 4)');
{
  const B = boot();
  for (let i = 0; i < 3; i++) B.env.els.btnNext.fire('click');   // level 4
  check('on level 4', B.label('lvLabel').indexOf('4') >= 0, B.label('lvLabel'));

  // (4,3) -> (4,2) -> (4,1) -> (3,1), then shove the left crate right.
  ['ArrowLeft', 'ArrowLeft', 'ArrowUp', 'ArrowRight'].forEach(k => B.key(k));
  check('crate moved onto the goal tile', B.crates()[0].r === 3 && B.crates()[0].c === 3, JSON.stringify(B.crates()[0]));
  check('push recorded', B.label('pushes') === '1', B.label('pushes'));
  check('moves recorded', B.label('moves') === '4', B.label('moves'));

  B.key('u');
  check('crate returns to its old tile', B.crates()[0].r === 3 && B.crates()[0].c === 2, JSON.stringify(B.crates()[0]));
  check('porter returns to the stance', B.porter().r === 3 && B.porter().c === 1, JSON.stringify(B.porter()));
  check('push counter decremented', B.label('pushes') === '0', B.label('pushes'));
  check('move counter decremented', B.label('moves') === '3', B.label('moves'));
}

group('a crate that cannot move stays put (level 8)');
{
  const B = boot();
  // Level 8 is index 7; jump there with the Next button.
  for (let i = 0; i < 7; i++) B.env.els.btnNext.fire('click');
  check('next button reached level 8', B.label('lvLabel').indexOf('8') >= 0, B.label('lvLabel'));

  // Walk from (4,4) up to (1,3) — directly above the crate at (2,3), whose
  // landing tile below is a wall at (3,3).
  ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowLeft'].forEach(k => B.key(k));
  check('porter is above the crate', B.porter().r === 1 && B.porter().c === 3, JSON.stringify(B.porter()));

  B.key('ArrowDown');
  check('crate cannot be pushed into a wall', B.crates()[0].r === 2 && B.crates()[0].c === 3, JSON.stringify(B.crates()[0]));
  check('porter did not move either', B.porter().r === 1 && B.porter().c === 3, JSON.stringify(B.porter()));
  check('no push was recorded', B.label('pushes') === '0', B.label('pushes'));
}

group('corner deadlock warning (level 3)');
{
  const B = boot();
  for (let i = 0; i < 2; i++) B.env.els.btnNext.fire('click');   // level 3
  check('on level 3', B.label('lvLabel').indexOf('3') >= 0, B.label('lvLabel'));

  // Shove the crate up to the top wall, then sideways into the corner cell
  // (1,1) — walls above it and to its left, so it can never move again.
  ['ArrowUp', 'ArrowUp', 'ArrowUp', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowLeft']
    .forEach(k => B.key(k));
  check('crate is wedged in the corner', B.crates()[0].r === 1 && B.crates()[0].c === 1, JSON.stringify(B.crates()[0]));
  check('warning is shown', B.label('status').length > 0, JSON.stringify(B.label('status')));

  B.key('u');
  check('undo clears the warning', B.label('status') === '', JSON.stringify(B.label('status')));
}

group('every level can be finished through the keyboard');
solutions.forEach((sol, i) => {
  if (!sol) { check(`level ${i + 1} replay`, false, 'no solution to replay'); return; }
  const B = boot();
  for (let n = 0; n < i; n++) B.env.els.btnNext.fire('click');
  sol.forEach(k => B.key(k));
  check(`level ${i + 1} clears in ${sol.length} moves`, B.overlayShown());

  if (i === 0) {
    check('win dialog reports the move count', B.env.els.dlgSub.textContent.indexOf(String(sol.length)) >= 0,
      B.env.els.dlgSub.textContent);
    check('cleared level lands in localStorage',
      JSON.parse(B.env.context.localStorage.getItem('sokoban_cleared') || '[]').indexOf(0) >= 0);
  }
});

group('dialog and level navigation');
{
  const B = boot();
  B.key('ArrowUp');
  B.key('ArrowUp');                       // clears level 1
  check('dialog opens on a clear', B.overlayShown());
  check('dialog title is the clear message', B.env.els.dlgTitle.textContent.length > 0);
  check('next-level button is wired', /Next/i.test(B.env.els.dlgNext.textContent), B.env.els.dlgNext.textContent);

  B.env.els.dlgNext.fire('click');
  check('advancing loads level 2', B.label('lvLabel').indexOf('2') >= 0, B.label('lvLabel'));
  check('dialog closes on advance', !B.overlayShown());
  check('fresh level resets the counters', B.label('moves') === '0' && B.label('pushes') === '0');
  check('porter is back at the level 2 start', B.porter().r === 2 && B.porter().c === 3, JSON.stringify(B.porter()));

  B.env.els.btnPrev.fire('click');
  check('prev goes back to level 1', B.label('lvLabel').indexOf('1') >= 0, B.label('lvLabel'));
  check('prev is disabled on the first level', B.env.els.btnPrev.disabled === true);
  check('cleared mark shown on level 1', B.label('lvLabel').indexOf('\u2713') >= 0, B.label('lvLabel'));

  B.env.els.btnRestart.fire('click');
  check('restart keeps the level but resets the board', B.porter().r === 4 && B.label('moves') === '0');
}

group('touch pad buttons drive the same moves');
{
  const B = boot();
  B.env.els.btnUp.fire('click');
  check('pad up moves the porter', B.porter().r === 3, JSON.stringify(B.porter()));
  B.env.els.btnUndo.fire('click');
  check('pad undo rewinds', B.porter().r === 4);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
