#!/usr/bin/env node
/**
 * Logic tests for nonogram-game.
 *
 * The smoke test only proves the page does not throw. This script proves the
 * RULES are correct: clue generation, the unique-solution guarantee (the soul
 * of the game), the interaction cycle, clue auto-strike, error highlighting,
 * the win condition, and a full play-through driven entirely through the real
 * UI (real Start button, real cell clicks, solver-produced answer).
 *
 * It loads the whole inline script in a vm sandbox so it can both call the
 * solver directly and read the live internal state (grid, solution, cellEls).
 *
 * Usage:  node tools/nonogram-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'nonogram-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

/* ----------------------------------------------- fake DOM (mirrors sokoban) */

function makeContext() {
  class Frag { constructor() { this.children = []; } appendChild(c) { this.children.push(c); return c; } }
  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.handlers = {};
      this.parent = null;
      this.dataset = {};
      this._text = '';
      this._html = '';
      this._cls = new Set();
      this.checked = false;
      this.value = '';
      this.disabled = false;
      this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
      this.classList = {
        add: c => this._cls.add(c),
        remove: c => this._cls.delete(c),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); }
      };
    }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._cls].join(' '); }
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
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
  }
  const els = {};
  const winHandlers = {};
  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: (() => { const s = {}; return { getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); } }; })(),
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
  scripts.forEach((s, i) => vm.runInContext(s, env.context, { filename: `nonogram#${i}` }));
  const ctx = env.context;
  const key = k => (env.winHandlers.keydown || []).forEach(f => f({ key: k, preventDefault() {} }));
  return {
    env, ctx, key,
    // convenience accessors into live internal state
    state: () => ctx.NONO.getState(),
    grid: () => ctx.grid,
    solution: () => ctx.solution,
    clues: () => ({ row: ctx.rowClues, col: ctx.colClues }),
    cell: (r, c) => ctx.cellEls[r][c],
    rows: () => ctx.rowClueEls,
    cols: () => ctx.colClueEls,
    clickCell: (r, c) => ctx.cellEls[r][c].fire('click', { target: ctx.cellEls[r][c], button: 0, preventDefault() {} }),
    rightCell: (r, c) => ctx.cellEls[r][c].fire('contextmenu', { target: ctx.cellEls[r][c], preventDefault() {} }),
    startBtn: () => env.els.btnStart,
    overlayShown: () => env.els.overlay._cls.has('show')
  };
}

/* small matrix helpers for tests */
function toGrid(rows) { return rows.map(s => s.split('').map(ch => ch === '#' || ch === '1' ? 1 : 0)); }

/* ============================================================ run tests */

group('clue generation rules');
{
  const B = boot();
  const C = B.ctx.computeClues;
  // Crafted 5x5 with mixed clues.
  const g = toGrid([
    ".....",
    "##.##",
    ".....",
    ".###.",
    "....."
  ]);
  const cl = C(g, 5);
  check('row 0 (empty) clue is []', JSON.stringify(cl.rowClues[0]) === '[]', JSON.stringify(cl.rowClues[0]));
  check('row 1 clue is [2,2]', JSON.stringify(cl.rowClues[1]) === '[2,2]', JSON.stringify(cl.rowClues[1]));
  check('row 3 clue is [3]', JSON.stringify(cl.rowClues[3]) === '[3]', JSON.stringify(cl.rowClues[3]));
  check('col 0 clue is [1]', JSON.stringify(cl.colClues[0]) === '[1]', JSON.stringify(cl.colClues[0]));
  check('col 1 clue is [1,1]', JSON.stringify(cl.colClues[1]) === '[1,1]', JSON.stringify(cl.colClues[1]));
  check('col 4 clue is [1]', JSON.stringify(cl.colClues[4]) === '[1]', JSON.stringify(cl.colClues[4]));

  // fully empty grid -> all clues empty
  const empty = toGrid(["...", "...", "..."]);
  const ec = C(empty, 3);
  check('3x3 fully empty -> all row clues []', ec.rowClues.every(r => r.length === 0));
  check('3x3 fully empty -> all col clues []', ec.colClues.every(c => c.length === 0));

  // full row -> [N]
  const full = toGrid(["111", "..." , "..."]);
  const fc = C(full, 3);
  check('full row clue is [3]', JSON.stringify(fc.rowClues[0]) === '[3]');

  // single cell at corner
  const corner = toGrid(["100", "..." , "..."]);
  const cc = C(corner, 3);
  check('corner cell -> row0 [1]', JSON.stringify(cc.rowClues[0]) === '[1]');
  check('corner cell -> col0 [1]', JSON.stringify(cc.colClues[0]) === '[1]');

  // edge-adjacent segments (touching the border, two separate runs)
  const edge = toGrid(["10001", "....." , "....." , "....." , "....."]);
  const ed = C(edge, 5);
  check('edge-touching two runs -> [1,1]', JSON.stringify(ed.rowClues[0]) === '[1,1]', JSON.stringify(ed.rowClues[0]));

  // multiple runs in the middle
  const mid = toGrid(["01110", "....." , "....." , "....." , "....."]);
  const md = C(mid, 5);
  check('single centered run -> [3]', JSON.stringify(md.rowClues[0]) === '[3]');

  // clue round-trips: rebuilding clues from the solution of a built-in equals stored clues
  const sol5 = B.ctx.patternToGrid(B.ctx.PATTERNS[5][0]);
  const rc = C(sol5, 5);
  check('built-in 5x5 clue recompute matches size', rc.rowClues.length === 5 && rc.colClues.length === 5);
}

group('built-in pattern library');
{
  const B = boot();
  const PAT = B.ctx.PATTERNS;
  check('at least 6 built-ins for 5x5', PAT[5].length >= 6, `got ${PAT[5].length}`);
  check('at least 6 built-ins for 10x10', PAT[10].length >= 6, `got ${PAT[10].length}`);

  function symH(g) { const N = g.length; for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (g[r][c] !== g[r][N - 1 - c]) return false; return true; }
  function symV(g) { const N = g.length; for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (g[r][c] !== g[N - 1 - r][c]) return false; return true; }

  [5, 10].forEach(size => {
    PAT[size].forEach((p, i) => {
      const g = B.ctx.patternToGrid(p);
      const tag = `${size}x${size} #${i + 1} ${p.en}`;
      check(`${tag}: square rows == size`, g.length === size && g.every(r => r.length === size));
      check(`${tag}: only 0/1 values`, g.every(r => r.every(v => v === 0 || v === 1)));
      const cl = B.ctx.computeClues(g, size);
      const cache = B.ctx.buildCache(cl.rowClues, cl.colClues, size);
      const n = B.ctx.countSolutions(cl.rowClues, cl.colClues, size, 2, cache);
      check(`${tag}: solver finds EXACTLY one solution`, n === 1, `count=${n}`);
      // the one solution must equal the picture
      const sol = B.ctx.findSolution(cl.rowClues, cl.colClues, size, cache);
      check(`${tag}: solver solution equals the picture`, JSON.stringify(sol) === JSON.stringify(g));
      if (p.sym === 'h') check(`${tag}: declared horizontal symmetry holds`, symH(g));
      if (p.sym === 'v') check(`${tag}: declared vertical symmetry holds`, symV(g));
      if (p.sym === 'both') check(`${tag}: declared both symmetries hold`, symH(g) && symV(g));
    });
  });
}

group('random generator yields unique puzzles');
{
  const B = boot();
  [5, 10, 15].forEach(size => {
    let allUnique = true, allSized = true, allSolved = true;
    for (let t = 0; t < 12; t++) {
      const puz = B.ctx.generatePuzzle(size);
      if (puz.N !== size) allSized = false;
      if (puz.solution.length !== size || puz.solution[0].length !== size) allSized = false;
      const cache = B.ctx.buildCache(puz.rowClues, puz.colClues, size);
      const n = B.ctx.countSolutions(puz.rowClues, puz.colClues, size, 2, cache);
      if (n !== 1) { allUnique = false; }
      // solver must reproduce the generator's solution
      const sol = B.ctx.findSolution(puz.rowClues, puz.colClues, size, cache);
      if (!sol || JSON.stringify(sol) !== JSON.stringify(puz.solution)) allSolved = false;
    }
    check(`${size}x${size}: every generated puzzle has the correct size`, allSized);
    check(`${size}x${size}: every generated puzzle is UNIQUE (countSolutions==1)`, allUnique);
    check(`${size}x${size}: solver reproduces the generator solution`, allSolved);
  });
}

group('line enumeration is sound (regression: stale-tail arrangement bug)');
{
  const B = boot();
  const P = B.ctx.placements;
  // The clue of a 0/1 arrangement, recomputed independently of the game.
  function clueOf(a) {
    const out = []; let run = 0;
    for (const v of a) { if (v) run++; else if (run) { out.push(run); run = 0; } }
    if (run) out.push(run);
    return out;
  }
  // The enumerator used to clear only [pos, start) before writing a block, so a
  // 1 left behind by an earlier sibling (or a deeper recursion) leaked in and
  // minted arrangements that do NOT match the clue -- e.g. [1,1] produced
  // "01011" (clue [1,2]). That poisoned validPls/forcedLine, which in turn made
  // countSolutions undercount and findSolution return clue-violating grids.
  const sampleClues = [[1, 1], [1, 1, 1], [2, 1], [3], [4], [1, 2], [2, 2], [5], [1, 1, 1, 1]];
  let legal = true, unique = true, total = 0;
  [5, 10, 15].forEach(N => {
    sampleClues.forEach(cl => {
      const list = P(cl, N);
      total += list.length;
      list.forEach(a => { if (JSON.stringify(clueOf(a)) !== JSON.stringify(cl)) legal = false; });
      if (new Set(list.map(a => a.join(''))).size !== list.length) unique = false;
    });
  });
  check(`every enumerated arrangement matches its own clue (${total} checked)`, legal);
  check('enumerated arrangements contain no duplicates', unique);
  check('clue [1,1] on 5 lanes yields exactly 6 arrangements', P([1, 1], 5).length === 6, `got ${P([1, 1], 5).length}`);
  check('clue [1,1] never yields 01011 (the stale-tail bug)', !P([1, 1], 5).some(a => a.join('') === '01011'));
  check('empty clue [] yields exactly one all-empty arrangement',
        JSON.stringify(P([], 5)) === JSON.stringify([[0, 0, 0, 0, 0]]));

  // The three built-ins whose clues used to be genuinely ambiguous are now
  // unique, and the two that exposed the enumeration bug (Cup / Rocket) now
  // round-trip through the solver.
  const p5 = B.ctx.patternToGrid(B.ctx.PATTERNS[5].find(p => p.en === 'Cup'));
  const c5 = B.ctx.computeClues(p5, 5);
  const ca5 = B.ctx.buildCache(c5.rowClues, c5.colClues, 5);
  check('5x5 Cup has exactly one solution', B.ctx.countSolutions(c5.rowClues, c5.colClues, 5, 2, ca5) === 1);
  check('5x5 Cup solver answer matches the picture',
        JSON.stringify(B.ctx.findSolution(c5.rowClues, c5.colClues, 5, ca5)) === JSON.stringify(p5));

  const p10 = B.ctx.patternToGrid(B.ctx.PATTERNS[10].find(p => p.en === 'Rocket'));
  const c10 = B.ctx.computeClues(p10, 10);
  const ca10 = B.ctx.buildCache(c10.rowClues, c10.colClues, 10);
  check('10x10 Rocket has exactly one solution', B.ctx.countSolutions(c10.rowClues, c10.colClues, 10, 2, ca10) === 1);
  check('10x10 Rocket solver answer matches the picture',
        JSON.stringify(B.ctx.findSolution(c10.rowClues, c10.colClues, 10, ca10)) === JSON.stringify(p10));
}

group('interaction: click cycle empty -> filled -> X -> empty');
{
  const B = boot();
  B.startBtn().fire('click');           // start default 5x5
  check('Start button begins the game', B.state().started === true);
  check('default size is 5x5', B.state().N === 5);

  // pick a cell that should stay empty in the solution to avoid accidental win
  const sol = B.solution();
  let r = 0, c = 0;
  for (let i = 0; i < 5 && sol[r][c] !== 0; i++) { c++; if (c === 5) { c = 0; r++; } }
  check('found an empty target cell', sol[r][c] === 0);

  B.clickCell(r, c);
  check('1st click -> filled (1)', B.grid()[r][c] === 1, `state=${B.grid()[r][c]}`);
  B.clickCell(r, c);
  check('2nd click -> marked (2)', B.grid()[r][c] === 2, `state=${B.grid()[r][c]}`);
  B.clickCell(r, c);
  check('3rd click -> empty (0)', B.grid()[r][c] === 0, `state=${B.grid()[r][c]}`);
  check('cycle leaves no win (not all required filled)', B.state().won === false);

  // right-click directly marks X
  B.rightCell(r, c);
  check('right-click -> marked (2)', B.grid()[r][c] === 2);
  B.rightCell(r, c);
  check('right-click again -> empty (0)', B.grid()[r][c] === 0);
}

group('clue auto-strike when a line is satisfied');
{
  const B = boot();
  B.startBtn().fire('click');
  const N = B.state().N, sol = B.solution(), grid = B.grid();
  // satisfy row 0 completely: fill its required cells, mark the rest as X
  const r = 0;
  for (let c = 0; c < N; c++) grid[r][c] = sol[r][c] === 1 ? 1 : 2;
  B.ctx.renderClues();
  const struck = B.rows()[r].every(el => el._cls.has('done'));
  check('row fully decided & correct -> its clues strike through', struck);

  // an unsatisfied (partial) row must not strike
  for (let c = 0; c < N; c++) grid[1][c] = 0;   // wipe row 1
  B.ctx.renderClues();
  const struck2 = B.rows()[1].every(el => el._cls.has('done'));
  check('undecided row -> clues not struck', struck2 === false);
}

group('error highlight: filled-but-wrong is red, X is never red');
{
  const B = boot();
  B.startBtn().fire('click');
  const sol = B.solution(), grid = B.grid();
  // find a cell that must be empty in the solution
  let r = -1, c = -1;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (sol[i][j] === 0) { r = i; c = j; break; }
  grid[r][c] = 1;                 // fill it wrongly
  B.ctx.errorOn = true;
  B.ctx.renderCell(r, c);
  check('wrongly filled cell gets .err', B.cell(r, c)._cls.has('err'));
  grid[r][c] = 2;                 // mark it instead
  B.ctx.renderCell(r, c);
  check('X (mark) is never an error', B.cell(r, c)._cls.has('err') === false);
  B.ctx.errorOn = false;
  grid[r][c] = 1;
  B.ctx.renderCell(r, c);
  check('with error highlight off, no .err even when wrong', B.cell(r, c)._cls.has('err') === false);
  B.ctx.errorOn = true;
}

group('win condition only when all required cells are filled');
{
  const B = boot();
  B.startBtn().fire('click');
  const N = B.state().N, sol = B.solution(), grid = B.grid();

  // fill exactly the required cells, leave the rest empty -> solved
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) grid[r][c] = sol[r][c] === 1 ? 1 : 0;
  B.ctx.renderClues();
  check('all required filled (no X, no extra) -> isSolved true', B.ctx.isSolved() === true);
  B.ctx.checkWin();
  check('checkWin triggers victory', B.state().won === true);
  check('victory overlay is shown', B.overlayShown());

  // fresh game: replace one required fill with an X -> NOT solved
  B.startBtn().fire('click');
  const sol2 = B.solution(), grid2 = B.grid(), N2 = B.state().N;
  let rr = -1, cc = -1;
  for (let r = 0; r < N2; r++) for (let c = 0; c < N2; c++) { grid2[r][c] = sol2[r][c] === 1 ? 1 : 0; if (sol2[r][c] === 1 && rr < 0) { rr = r; cc = c; } }
  grid2[rr][cc] = 2;             // required cell marked X instead of filled
  B.ctx.renderClues();
  check('required cell marked X -> isSolved false', B.ctx.isSolved() === false);
  B.ctx.checkWin();
  check('X does NOT satisfy a required cell (no false win)', B.state().won === false);

  // extra wrong fill -> not solved
  B.startBtn().fire('click');
  const sol3 = B.solution(), grid3 = B.grid(), N3 = B.state().N;
  let er = -1, ec = -1;
  for (let r = 0; r < N3; r++) for (let c = 0; c < N3; c++) { grid3[r][c] = sol3[r][c] === 1 ? 1 : 0; if (sol3[r][c] === 0 && er < 0) { er = r; ec = c; } }
  grid3[er][ec] = 1;             // extra wrong fill
  check('extra wrong fill -> isSolved false', B.ctx.isSolved() === false);
}

group('full play-through via the real UI');
{
  const B = boot();
  B.startBtn().fire('click');                 // real Start button
  const N = B.state().N;
  const row = B.clues().row, col = B.clues().col;
  // produce the answer with the real solver
  const solGrid = B.ctx.findSolution(row, col, N, B.ctx.buildCache(row, col, N));
  check('solver returns a solution for the live puzzle', !!solGrid);
  check('solver solution equals the live solution', JSON.stringify(solGrid) === JSON.stringify(B.solution()));

  // click every required cell through the real click handler
  let clicks = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    if (solGrid[r][c] === 1) { B.clickCell(r, c); clicks++; }
  }
  check('clicked each required cell once (state filled)', B.grid().every((rowArr, r) => rowArr.every((v, c) => (B.solution()[r][c] === 1) === (v === 1))));
  check('filling the solver answer triggers victory', B.state().won === true);
  check('victory overlay shown after UI play', B.overlayShown());

  // Next button starts a fresh puzzle
  B.env.els.dlgNext.fire('click');
  check('Next puzzle resets won flag', B.state().won === false);
  check('Next puzzle keeps the board started', B.state().started === true);
}

group('undo, restart, keyboard');
{
  const B = boot();
  B.startBtn().fire('click');
  const sol = B.solution(), grid = B.grid();
  let r = -1, c = -1;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (sol[i][j] === 0) { r = i; c = j; break; }
  B.clickCell(r, c);             // -> 1
  B.clickCell(r, c);             // -> 2
  check('two clicks reach marked state', grid[r][c] === 2);
  B.key('u');                    // undo -> 1
  check('U key undoes to filled', grid[r][c] === 1);
  B.key('u');                    // undo -> 0
  check('second undo returns to empty', grid[r][c] === 0);
  B.key('u');                    // undo on empty stack is a no-op
  check('undo on empty history is safe', grid[r][c] === 0);

  B.clickCell(r, c);
  B.key('r');                    // restart
  check('R key restarts the board (cell cleared)', grid[r][c] === 0);
  check('restart keeps the game started', B.state().started === true);
}

/* -------------------------------------------------- reverse / bug-catching
 * Each of these proves the assertions above are non-trivial: we inject the
 * kind of bug they guard against and confirm the same check would FAIL. */

group('reverse checks (the suite catches real bugs)');
{
  const B = boot();
  const C = B.ctx.computeClues;

  // 1) A clue generator that drops everything after the first segment must
  //    break uniqueness on a multi-segment puzzle.
  function brokenClues(grid, N) {
    const cl = C(grid, N);
    // keep only the first run of every row/col clue (simulating a bug)
    return {
      rowClues: cl.rowClues.map(a => a.length ? [a[0]] : []),
      colClues: cl.colClues.map(a => a.length ? [a[0]] : [])
    };
  }
  const g = toGrid(["##.##", ".....", ".....", ".....", "....."]); // row0 = [2,2]
  const bad = brokenClues(g, 5);
  const bcache = B.ctx.buildCache(bad.rowClues, bad.colClues, 5);
  const badCount = B.ctx.countSolutions(bad.rowClues, bad.colClues, 5, 2, bcache);
  check('reverse: dropping a clue segment destroys uniqueness (count != 1)',
        badCount !== 1, `count=${badCount}`);
  const good = C(g, 5);
  const gcache = B.ctx.buildCache(good.rowClues, good.colClues, 5);
  check('reverse: correct clues keep it unique (sanity)', B.ctx.countSolutions(good.rowClues, good.colClues, 5, 2, gcache) === 1);

  // 2) A win check that lets X stand in for a fill would wrongly "solve" a
  //    board; our correct isSolved must reject it.
  B.startBtn().fire('click');
  const sol = B.solution(), grid = B.grid(), N = B.state().N;
  let rr = -1, cc = -1;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) { grid[r][c] = sol[r][c] === 1 ? 1 : 0; if (sol[r][c] === 1 && rr < 0) { rr = r; cc = c; } }
  grid[rr][cc] = 2;            // required cell marked X
  const buggyIsSolved = function () {
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      const filled = (grid[r][c] === 1 || grid[r][c] === 2);   // X counts as "filled"
      if ((sol[r][c] === 1) !== filled) return false;
    }
    return true;
  };
  check('reverse: buggy win (X == fill) would wrongly pass', buggyIsSolved() === true);
  check('reverse: correct isSolved rejects the X substitution', B.ctx.isSolved() === false);

  // 3) Error highlight must not fire on a correct fill; injecting the opposite
  //    (flag every fill) would be caught by the "correct fill is not err" check.
  const sol2 = B.solution(), grid2 = B.grid();
  let fr = -1, fc = -1;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (sol2[r][c] === 1) { fr = r; fc = c; break; }
  grid2[fr][fc] = 1;           // correctly filled
  B.ctx.errorOn = true;
  B.ctx.renderCell(fr, fc);
  check('reverse: a CORRECTLY filled cell must not be flagged .err', B.cell(fr, fc)._cls.has('err') === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
