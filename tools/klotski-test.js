#!/usr/bin/env node
/**
 * Logic tests for klotski-game.
 *
 * The smoke test only proves the page does not throw. It cannot tell whether a
 * piece can illegally overlap another, whether undo really rewinds a slide, or —
 * the expensive one — whether every bundled layout is even solvable.
 *
 * This script does four things:
 *   1. sanity-checks the level data (one Cao Cao, five generals, four soldiers,
 *      exactly two empty cells, rectangular grids)
 *   2. breadth-first searches every layout to prove Cao Cao can reach the exit
 *   3. loads the real page in a fake DOM and *replays those solutions through
 *      genuine click + keydown events*, so the win path is reached the way a
 *      player reaches it (callable entry points are not the same as reachable ones)
 *   4. reverse-validates the suite by injecting two bugs and showing the normal
 *      assertions would catch them.
 *
 * Usage:  node tools/klotski-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'klotski-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

/* ------------------------------------------- pull the level data out */

// The game wraps everything in an IIFE, so `var LEVELS` never lands on the
// context. Slice the array literal (and PIECE_NAMES object) out and evaluate.
function sliceLiteral(src, marker, openCh, closeCh) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(marker + ' not found in source');
  const open = src.indexOf(openCh, i);
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    if (src[j] === openCh) depth++;
    else if (src[j] === closeCh) { depth--; if (!depth) break; }
  }
  return src.slice(open, j + 1);
}

const SRC = fs.readFileSync(GAME, 'utf8');
const LEVELS = new Function('return ' + sliceLiteral(SRC, 'var LEVELS =', '[', ']') + ';')();
// PIECE_NAMES is only needed by the game; the solver derives kinds from bboxes.

/* ------------------------------------------------------- board utilities */

const ROWS = 5, COLS = 4;
const DIRKEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
// up, down, left, right  (indices line up with the game's DIRS order)
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function parseLevel(grid) {
  const cells = {};
  for (let r = 0; r < grid.length; r++) {
    const line = grid[r];
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === '.' || ch === ' ') continue;
      (cells[ch] = cells[ch] || []).push([r, c]);
    }
  }
  const pieces = [];
  Object.keys(cells).forEach(ch => {
    const list = cells[ch];
    let minR = 99, minC = 99, maxR = -1, maxC = -1;
    list.forEach(p => {
      if (p[0] < minR) minR = p[0];
      if (p[1] < minC) minC = p[1];
      if (p[0] > maxR) maxR = p[0];
      if (p[1] > maxC) maxC = p[1];
    });
    const w = maxC - minC + 1, h = maxR - minR + 1;
    const kind = (w === 2 && h === 2) ? 'caocao'
               : (w === 2 && h === 1) ? 'hgen'
               : (w === 1 && h === 2) ? 'vgen' : 'soldier';
    pieces.push({ id: ch, kind, w, h, r: minR, c: minC });
  });
  return pieces;
}

function occSet(pieces) {
  const s = {};
  pieces.forEach(p => {
    for (let i = 0; i < p.h; i++)
      for (let j = 0; j < p.w; j++) s[(p.r + i) + ',' + (p.c + j)] = true;
  });
  return s;
}

// Must match the game's canMove exactly: slide one cell into empty in-bounds
// cells, no overlap, no diagonals.
function canMoveP(pieces, p, dir) {
  const dr = DIRS[dir][0], dc = DIRS[dir][1];
  const nr = p.r + dr, nc = p.c + dc;
  const occ = occSet(pieces);
  for (let i = 0; i < p.h; i++) {
    for (let j = 0; j < p.w; j++) {
      const rr = nr + i, cc = nc + j;
      if (rr < 0 || cc < 0 || rr >= ROWS || cc >= COLS) return false;
      const insideOwn = rr >= p.r && rr < p.r + p.h && cc >= p.c && cc < p.c + p.w;
      if (occ[rr + ',' + cc] && !insideOwn) return false;
    }
  }
  return true;
}

// Canonical key: a 2x2 Cao Cao is unique, but the four vertical generals and
// the four soldiers are interchangeable, so sort their positions. This collapses
// symmetric boards so the visited set stays small (and the replay still uses the
// concrete piece ids stored on each canonical node, so it stays correct).
function keyOf(pieces) {
  const cao = pieces.filter(p => p.kind === 'caocao')[0];
  const vgen = pieces.filter(p => p.kind === 'vgen').map(p => p.r + ',' + p.c).sort();
  const hgen = pieces.filter(p => p.kind === 'hgen').map(p => p.r + ',' + p.c);
  const sol = pieces.filter(p => p.kind === 'soldier').map(p => p.r + ',' + p.c).sort();
  return cao.r + ',' + cao.c + '|' + vgen.join(';') + '|' + hgen.join(';') + '|' + sol.join(';');
}

/**
 * BFS over board states. Each successor applies one real slide (piece id, dir)
 * to the concrete piece list, so reconstruction yields a replayable move list.
 * Returns an array of { id, dir } or null when unsolvable.
 */
function solve(grid) {
  const start = parseLevel(grid);
  const caoId = start.filter(p => p.kind === 'caocao')[0].id;
  const isGoal = ps => { const c = ps.filter(p => p.id === caoId)[0]; return c.r === 3 && c.c === 1; };
  if (isGoal(start)) return [];

  const cameFrom = new Map();
  cameFrom.set(keyOf(start), null);
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    for (let pi = 0; pi < cur.length; pi++) {
      const p = cur[pi];
      for (let d = 0; d < 4; d++) {
        if (!canMoveP(cur, p, d)) continue;
        const np = cur.map(q =>
          q === p ? { id: q.id, kind: q.kind, w: q.w, h: q.h, r: q.r + DIRS[d][0], c: q.c + DIRS[d][1] } : q);
        const nk = keyOf(np);
        if (cameFrom.has(nk)) continue;
        cameFrom.set(nk, { prev: keyOf(cur), id: p.id, dir: d });
        if (isGoal(np)) {
          const seq = [];
          let k = nk;
          while (cameFrom.get(k)) { const e = cameFrom.get(k); seq.push({ id: e.id, dir: e.dir }); k = e.prev; }
          seq.reverse();
          return seq;
        }
        queue.push(np);
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
    setAttribute() {}
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
        setItem: (k, v) => { store[k] = String(v); }
        // NOTE: deliberately no removeItem — the game must not use it.
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

function bootSource(html) {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => vm.runInContext(s, env.context, { filename: `klotski#${i}` }));

  const key = k => (env.winHandlers.keydown || []).forEach(f => f({ key: k, preventDefault() {} }));
  const clickEl = (el, ev) => { if (el) el.fire('click', ev || { target: el, button: 0, preventDefault() {} }); };
  const pieceEl = id => env.els.actors.children.filter(c => c && c._pid === id)[0];
  const caocaoEl = () => pieceEl('C');

  return {
    env, key, clickEl, pieceEl, caocaoEl,
    start: () => clickEl(env.els.btnStart),
    next: () => clickEl(env.els.btnNext),
    prev: () => clickEl(env.els.btnPrev),
    clickPiece: id => { const el = pieceEl(id); if (el) clickEl(el); },
    sendDir: dir => key(DIRKEYS[dir]),
    label: id => env.els[id].textContent,
    disabled: id => !!env.els[id].disabled,
    winShown: () => env.els.winOverlay._cls.has('show'),
    startShown: () => env.els.startOverlay._cls.has('show'),
    caoPos: () => { const e = caocaoEl(); return { r: Number(e._vars['--r']), c: Number(e._vars['--c']) }; },
    piecePos: id => { const e = pieceEl(id); return { r: Number(e._vars['--r']), c: Number(e._vars['--c']) }; }
  };
}

const boot = () => bootSource(SRC);

/* ------------------------------------------------------------------ tests */

group('level data');
check('six layouts are bundled', LEVELS.length === 6, `got ${LEVELS.length}`);
LEVELS.forEach((L, i) => {
  const g = parseLevel(L.grid);
  const emptyCount = L.grid.join('').split('').filter(ch => ch === '.').length;
  const cao = g.filter(p => p.kind === 'caocao').length;
  const hgen = g.filter(p => p.kind === 'hgen').length;
  const vgen = g.filter(p => p.kind === 'vgen').length;
  const sol = g.filter(p => p.kind === 'soldier').length;
  const rect = L.grid.length === ROWS && L.grid.every(s => s.length === COLS);
  check(`level ${i + 1} (${L.nameEn}): exactly one Cao Cao`, cao === 1, `got ${cao}`);
  check(`level ${i + 1}: one horizontal + four vertical generals`, hgen === 1 && vgen === 4, `h=${hgen} v=${vgen}`);
  check(`level ${i + 1}: four soldiers`, sol === 4, `got ${sol}`);
  check(`level ${i + 1}: exactly two empty cells`, emptyCount === 2, `got ${emptyCount}`);
  check(`level ${i + 1}: rectangular 5x4 grid`, rect);
});

group('solvability (BFS)');
const solutions = LEVELS.map((L, i) => {
  const t0 = Date.now();
  const sol = solve(L.grid);
  const ms = Date.now() - t0;
  check(`level ${i + 1} (${L.nameEn}) is solvable`, !!sol,
    sol ? `${sol.length} slides in ${ms}ms` : `no solution (${ms}ms)`);
  return sol;
});

group('parsing');
{
  const g = parseLevel(LEVELS[0].grid);
  check('level 1 Cao Cao is 2x2 at (0,1)',
    g.filter(p => p.kind === 'caocao')[0].r === 0 && g.filter(p => p.kind === 'caocao')[0].c === 1);
  check('level 1 has 10 pieces total', g.length === 10, `got ${g.length}`);
  check('level 1 soldier s starts at (3,1)',
    (g.filter(p => p.id === 's')[0] || {}).r === 3 && (g.filter(p => p.id === 's')[0] || {}).c === 1);
}

group('ready state (before Start)');
{
  const B = boot();
  check('start overlay is visible on load', B.startShown());
  check('movement pad is disabled before Start', B.disabled('btnUp') && B.disabled('btnDown'));
  check('undo is disabled before Start', B.disabled('btnUndo'));
  B.clickPiece('C');
  B.sendDir(1);                                  // try to move before starting
  check('no move is counted before Start', B.label('moves') === '0', B.label('moves'));
  check('clicking Start hides the overlay', (B.start(), !B.startShown()));
  check('controls become enabled after Start', !B.disabled('btnUp'));
}

group('movement rules (level 1, real click + keydown)');
{
  const B = boot();
  B.start();
  // Cao Cao at (0,1) is boxed in: up = wall, down = Guan Yu, left/right = generals.
  ['C', 0, 'C', 1, 'C', 2, 'C', 3].forEach(() => {});
  [0, 1, 2, 3].forEach(dir => { B.clickPiece('C'); B.sendDir(dir); });
  check('Cao Cao cannot move in any direction initially',
    B.caoPos().r === 0 && B.caoPos().c === 1, JSON.stringify(B.caoPos()));
  check('four blocked attempts score zero moves', B.label('moves') === '0', B.label('moves'));

  // Soldier s at (3,1) can only slide down into the empty (4,1).
  B.clickPiece('s');
  B.sendDir(1);
  check('soldier s slides down into the empty cell',
    B.piecePos('s').r === 4 && B.piecePos('s').c === 1, JSON.stringify(B.piecePos('s')));
  check('a legal slide scores one move', B.label('moves') === '1', B.label('moves'));

  // Soldier u at (4,0): down and left are out of bounds, right is empty.
  B.clickPiece('u');
  B.sendDir(1);                                  // down -> off board
  check('out-of-bounds slide is rejected', B.piecePos('u').r === 4 && B.piecePos('u').c === 0, JSON.stringify(B.piecePos('u')));
  check('rejected slide does not score', B.label('moves') === '1', B.label('moves'));

  // Overlap: push s (now at (4,1)) left is blocked by u at (4,0).
  B.clickPiece('s');
  B.sendDir(2);                                  // left into u
  check('sliding into another piece is rejected (no overlap)',
    B.piecePos('s').r === 4 && B.piecePos('s').c === 1, JSON.stringify(B.piecePos('s')));
}

group('undo rewinds slides precisely (level 1)');
{
  const B = boot();
  B.start();
  const before = JSON.stringify(B.piecePos('s'));
  B.clickPiece('s');
  B.sendDir(1);
  check('s moved before undo', B.piecePos('s').r === 4);
  B.key('u');
  check('undo restores the soldier', JSON.stringify(B.piecePos('s')) === before, JSON.stringify(B.piecePos('s')));
  check('undo restores the move count', B.label('moves') === '0', B.label('moves'));
  B.key('u');                                    // empty history -> no-op
  check('undo on empty history is safe', B.label('moves') === '0');
}

group('every level clears through the real UI (BFS replay)');
solutions.forEach((sol, i) => {
  if (!sol) { check(`level ${i + 1} replay`, false, 'no solution to replay'); return; }
  const B = boot();
  B.start();
  for (let n = 0; n < i; n++) B.next();          // switch to level i (started stays true)
  sol.forEach(step => { B.clickPiece(step.id); B.sendDir(step.dir); });
  check(`level ${i + 1} clears in ${sol.length} slides`, B.winShown(), B.label('moves'));
  check(`level ${i + 1}: Cao Cao is on the exit`, B.caoPos().r === 3 && B.caoPos().c === 1, JSON.stringify(B.caoPos()));
  check(`level ${i + 1}: move counter equals solution length`,
    B.label('moves') === String(sol.length), B.label('moves'));

  if (i === 0) {
    check('win dialog reports the move count',
      B.env.els.dlgSub.textContent.indexOf(String(sol.length)) >= 0, B.env.els.dlgSub.textContent);
    check('cleared level recorded in localStorage',
      JSON.parse(B.env.context.localStorage.getItem('klotski_cleared') || '[]').indexOf(0) >= 0);
    const best = JSON.parse(B.env.context.localStorage.getItem('klotski_best') || '[]');
    check('best step count saved for level 1', best[0] === sol.length, JSON.stringify(best));
  }
});

group('win dialog and level navigation');
{
  const B = boot();
  B.start();
  for (let n = 0; n < 1; n++) B.next();          // go to level 2 first
  B.prev();                                       // back to level 1
  check('prev returns to level 1', B.label('lvLabel').indexOf('1') >= 0, B.label('lvLabel'));
  check('prev is disabled on the first level', B.disabled('btnPrev') === true);

  // Last level: next should be disabled.
  for (let n = 0; n < LEVELS.length - 1; n++) B.next();
  check('next is disabled on the last level', B.disabled('btnNext') === true);

  B.prev();                                       // back one
  const sol = solutions[LEVELS.length - 2];
  if (sol) {
    sol.forEach(step => { B.clickPiece(step.id); B.sendDir(step.dir); });
    check('advancing from the win dialog loads the next level', (B.env.els.dlgNext.fire('click'), B.startShown() === false));
  }
}

group('touch pad buttons drive the same slides');
{
  const B = boot();
  B.start();
  B.clickPiece('s');
  B.clickEl(B.env.els.btnDown);
  check('pad down slides the selected soldier', B.piecePos('s').r === 4, JSON.stringify(B.piecePos('s')));
  B.clickEl(B.env.els.btnUndo);
  check('pad undo rewinds', B.piecePos('s').r === 3);
}

group('reverse validation (proves the suite is not vacuous)');
{
  // Bug A: the win test is neutered so Cao Cao never reaches the exit condition.
  const buggyWin = SRC.replace(
    'function isAtExit(p) { return p.r === 3 && p.c === 1; } /*__WIN__*/',
    'function isAtExit(p) { return false; } /*__WIN__*/');
  const Ba = bootSource(buggyWin);
  Ba.start();
  (solutions[0] || []).forEach(step => { Ba.clickPiece(step.id); Ba.sendDir(step.dir); });
  check('REVERSE A: with win detection removed, the level does NOT register a win', !Ba.winShown());
  // ^ If the real "level clears" assertion above were run against this build it
  //   would FAIL — so that assertion is genuinely testing the win condition.

  // Bug B: the move legality guard is removed, so pieces may overlap.
  const buggyGuard = SRC.replace(
    'if (!canMove(p, dr, dc)) return false; /*__GUARD__*/',
    '/*__GUARD_REMOVED__*/');
  const Bb = bootSource(buggyGuard);
  Bb.start();
  Bb.clickPiece('C');
  Bb.sendDir(1);                                  // Cao Cao would overlap Guan Yu below
  const illegal = Bb.caoPos().r === 1;            // it slid despite the blocker
  check('REVERSE B: with the move guard removed, an overlapping slide is permitted', illegal);
  // ^ The "no overlap" assertion above would FAIL against this build, confirming
  //   it actually exercises the legality rule.
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
