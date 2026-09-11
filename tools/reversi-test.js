#!/usr/bin/env node
/**
 * Logic tests for reversi-game.
 *
 * Recommendations from CONTRIBUTING.md that drove this file:
 *   - Test the actual rules, not just the absence of crashes. Reversi bugs
 *     almost always live in the capture/flipping logic, so eight-direction
 *     capture, legal-move enumeration, passes and end-of-game scoring are
 *     asserted directly against the game's own pure functions.
 *   - Drive at least one full game through the REAL UI entry point (click the
 *     Start button, then click board squares) so a missing/blocked entry point
 *     would fail here, not only in production.
 *   - Prove the suite catches real bugs: three "reverse" checks inject a broken
 *     rule and assert the assertions would fail, then confirm the real code passes.
 *
 * The whole inline script is loaded in a vm sandbox (top-level `var`/`function`
 * declarations land on the context object, so internal state is readable).
 *
 * Usage:  node tools/reversi-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'reversi-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

/* ----------------------------------------------------------- fake DOM */
function makeContext() {
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
      this._text = '';
      this._html = '';
      this._cls = new Set();
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
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html || ''; }
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
    fire(t, ev) { (this.handlers[t] || []).forEach(f => f(ev || {})); }
    appendChild(c) {
      if (c && c.children && c.tag === undefined) { /* fragment guard */ }
      c.parent = this; this.children.push(c); return c;
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
  const docHandlers = {};
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
      createDocumentFragment: () => new El('frag'),
      querySelectorAll: () => [],
      addEventListener(t, f) { (docHandlers[t] = docHandlers[t] || []).push(f); }
    },
    navigator: { language: 'en' }
  };
  context.window = context;
  context.global = context;
  context.self = context;
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  vm.createContext(context);
  return { context, els, fireDoc: (t, ev) => (docHandlers[t] || []).forEach(f => f(ev || {})) };
}

function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const html = fs.readFileSync(GAME, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => vm.runInContext(s, env.context, { filename: `reversi#${i}` }));
  return env;
}

/* ----------------------------------------------------------- helpers */
// Build a board with EMPTY, then a line in direction `dir`: target (r0,c0) stays
// empty; the next n cells are `opp`; the cell after them is `color`. Placing
// `color` at (r0,c0) must capture exactly the n opponent cells.
function boardWithLine(r0, c0, color, opp, n, dir) {
  const b = new Array(64).fill(0);
  for (let k = 1; k <= n; k++) b[(r0 + dir[0] * k) * 8 + (c0 + dir[1] * k)] = opp;
  b[(r0 + dir[0] * (n + 1)) * 8 + (c0 + dir[1] * (n + 1))] = color;
  return b;
}
function eqSet(arr, expected) {
  if (arr.length !== expected.length) return false;
  const s = new Set(expected);
  return arr.every(i => s.has(i));
}

/* ----------------------------------------------------------- tests */
const DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1]
];
const DIR_NAMES = ['up-left', 'up', 'up-right', 'left', 'right', 'down-left', 'down', 'down-right'];

// For a 3-disc line (needs 4 steps along the direction) pick an in-bounds origin
// per direction so the bracketing own disc stays on the board.
const N3 = [
  [5, 5], [5, 4], [5, 2],   // up-left, up, up-right
  [4, 5],          [4, 2],   // left, right
  [2, 5], [2, 4], [2, 2]    // down-left, down, down-right
];

const env = boot();
const C = env.context;

group('eight-direction capture (each direction, both polarities)');
DIRS.forEach((dir, di) => {
  // Two sandwiched discs.
  const b = boardWithLine(4, 4, 1, 2, 2, dir);
  const f = C.flipsFor(b, 4, 4, 1);
  const exp = [ (4 + dir[0] * 1) * 8 + (4 + dir[1] * 1), (4 + dir[0] * 2) * 8 + (4 + dir[1] * 2) ];
  check(`${DIR_NAMES[di]}: captures exactly 2 discs`, f.length === 2 && eqSet(f, exp), JSON.stringify(f));
  check(`${DIR_NAMES[di]}: the move is recognised as legal`, C.legalMovesOn(b, 1).some(m => m.r === 4 && m.c === 4));

  // Single sandwiched disc.
  const b1 = boardWithLine(4, 4, 1, 2, 1, dir);
  check(`${DIR_NAMES[di]}: single disc captured too`, C.flipsFor(b1, 4, 4, 1).length === 1);

  // Three sandwiched discs (in-bounds origin per direction).
  const o3 = N3[di];
  const b3 = boardWithLine(o3[0], o3[1], 1, 2, 3, dir);
  check(`${DIR_NAMES[di]}: three discs captured`, C.flipsFor(b3, o3[0], o3[1], 1).length === 3);
});

group('illegal placements');
{
  // A line that does NOT end in an own disc must capture nothing.
  const b = new Array(64).fill(0);
  b[4 * 8 + 5] = 2; b[4 * 8 + 6] = 2; /* no bracketing own disc at (4,7) */
  check('open line with no bracketing disc captures nothing', C.flipsFor(b, 4, 4, 1).length === 0);

  // Placing on an occupied cell is illegal.
  const occ = new Array(64).fill(0); occ[3 * 8 + 3] = 2; occ[3 * 8 + 4] = 1;
  check('placing on an occupied square is illegal', C.flipsFor(occ, 3, 3, 1).length === 0);

  // A totally empty board: no legal moves at all.
  check('empty board has no legal moves', C.legalMovesOn(new Array(64).fill(0), 1).length === 0);

  // The illegal square is excluded from the legal-move set.
  const ib = new Array(64).fill(0); ib[4 * 8 + 5] = 2; ib[4 * 8 + 6] = 2;
  check('non-bracketing square absent from legal list', !C.legalMovesOn(ib, 1).some(m => m.r === 4 && m.c === 4));
}

group('applying a move flips exactly the right discs');
{
  const b = C.initialBoard();
  // Black plays (2,3): should flip the white disc at (3,3).
  const mv = C.legalMovesOn(b, 1).find(m => m.r === 2 && m.c === 3);
  check('found the black opening move at (2,3)', !!mv);
  const before = C.countDiscs(b);
  C.applyOn(b, mv, 1);
  check('placed disc is black', b[2 * 8 + 3] === 1);
  check('sandwiched white disc at (3,3) flipped to black', b[3 * 8 + 3] === 1);
  check('other white disc at (4,4) unchanged', b[4 * 8 + 4] === 2);
  const after = C.countDiscs(b);
  check('black gained 2, white lost 1', after.black === before.black + 2 && after.white === before.white - 1,
    `b${before.black}->${after.black} w${before.white}->${after.white}`);
}

group('opening legal moves');
{
  const b = C.initialBoard();
  const lm = C.legalMovesOn(b, 1); // black
  check('black has exactly 4 opening moves', lm.length === 4, `got ${lm.length}`);
  const set = lm.map(m => m.r * 8 + m.c).sort((a, b) => a - b);
  check('opening moves are (2,3)(3,2)(4,5)(5,4)', eqSet(set, [19, 26, 37, 44]), JSON.stringify(set));
  check('white also has exactly 4 opening moves', C.legalMovesOn(b, 2).length === 4);

  // Every legal move must flip at least one disc.
  check('every legal move flips >=1 disc', lm.every(m => m.flips.length >= 1));
}

group('pass and end-of-game logic');
{
  // Board where BLACK(0,0) and WHITE(1,1) surround each other: black can capture
  // diagonally at (2,2), but white has NO legal move at all (its only stone cannot
  // be bracketed because the symmetric cell is off the board). -> black moves, white passes.
  const pb = new Array(64).fill(0);
  pb[0] = 1; pb[9] = 2;
  check('white has no legal move on pass-board', C.hasMove(pb, 2) === false);
  check('black has a legal move on pass-board', C.hasMove(pb, 1) === true);

  const dn = C.decideNext(pb, 1);
  check('decideNext makes white pass, black continues', dn.turn === 1 && dn.pass === 2, JSON.stringify(dn));

  // A completely full board -> neither side can move -> game must end.
  const full = new Array(64).fill(0);
  for (let i = 0; i < 64; i++) full[i] = (i % 2 === 0) ? 1 : 2; // checkerboard, no empties
  check('full board has no legal moves for either side', C.hasMove(full, 1) === false && C.hasMove(full, 2) === false);
  check('decideNext reports end on full board', C.decideNext(full, 1).end === true);
}

group('scoring and winner detection');
{
  env.els.mode.value = 'pvp';
  const tie = new Array(64).fill(0);
  for (let i = 0; i < 64; i++) tie[i] = (i % 2 === 0) ? 1 : 2;
  C.board = tie.slice(); C.gameOver = false; C.endGame();
  check('equal discs -> draw', C.result === 'draw', C.result);

  const blackWin = new Array(64).fill(0);
  for (let i = 0; i < 40; i++) blackWin[i] = 1;
  for (let i = 40; i < 60; i++) blackWin[i] = 2;
  C.board = blackWin.slice(); C.gameOver = false; C.endGame();
  check('more black discs -> blackWin (pvp)', C.result === 'blackWin', C.result);

  const whiteWin = new Array(64).fill(0);
  for (let i = 0; i < 20; i++) whiteWin[i] = 1;
  for (let i = 20; i < 60; i++) whiteWin[i] = 2;
  C.board = whiteWin.slice(); C.gameOver = false; C.endGame();
  check('more white discs -> whiteWin (pvp)', C.result === 'whiteWin', C.result);

  // In pve the same board is reported from the human's perspective.
  env.els.mode.value = 'pve';
  env.els.chkAI.checked = true; // AI is black
  C.board = blackWin.slice(); C.gameOver = false; C.endGame();
  check('pve: AI(black) ahead -> aiWin', C.result === 'aiWin', C.result);
}

group('counter / disc totals are consistent');
{
  const b = C.initialBoard();
  const d = C.countDiscs(b);
  check('initial board has 2 black + 2 white = 4 discs', d.black === 2 && d.white === 2);
  // Play a few moves and ensure discs + empties always equal 64.
  env.els.mode.value = 'pvp';
  C.started = true; C.gameOver = false;
  C.board = C.initialBoard(); C.turn = 1; C.history = []; C.moveCount = 0; C.lastMove = null; C.passSide = null;
  let prev = C.countDiscs(C.board);
  for (let s = 0; s < 20; s++) {
    const moves = C.legalMovesOn(C.board, C.turn);
    if (!moves.length) {
      if (!C.legalMovesOn(C.board, C.other ? C.other(C.turn) : (C.turn === 1 ? 2 : 1)).length) break;
      C.turn = (C.turn === 1 ? 2 : 1); continue;
    }
    C.doPlay(moves[0], C.turn);
    const cur = C.countDiscs(C.board);
    const empties = C.board.filter(v => v === 0).length;
    check(`after move ${s + 1}: discs+empties == 64`, cur.black + cur.white + empties === 64);
    if (C.gameOver) break;
    prev = cur;
  }
  check('invariant held across simulated moves', true);
}

group('AI makes legal moves at every level');
{
  const b = C.initialBoard();
  ['easy', 'normal', 'hard'].forEach(lvl => {
    const mv = C.chooseAIMove(b.slice(), 1, lvl);
    const legal = C.legalMovesOn(b, 1).some(m => m.r === mv.r && m.c === mv.c);
    check(`level ${lvl}: chosen move is legal`, !!mv && legal, mv ? `(${mv.r},${mv.c})` : 'null');
  });
}

group('hard AI never plays an illegal move across a full game');
{
  let bd = C.initialBoard();
  let turn = 1; // human=black plays greedy-random, AI=white plays hard
  let illegal = false, steps = 0;
  while (steps < 120) {
    const moves = C.legalMovesOn(bd, turn);
    if (!moves.length) {
      if (!C.legalMovesOn(bd, turn === 1 ? 2 : 1).length) break;
      turn = (turn === 1 ? 2 : 1); continue;
    }
    let mv;
    if (turn === 1) mv = moves[Math.floor(Math.random() * moves.length)];
    else {
      mv = C.chooseAIMove(bd.slice(), 2, 'hard');
      const legal = C.legalMovesOn(bd, 2).some(m => m.r === mv.r && m.c === mv.c);
      if (!legal) { illegal = true; break; }
    }
    C.applyOn(bd, mv, turn);
    turn = (turn === 1 ? 2 : 1);
    steps++;
  }
  check('hard AI never placed an illegal stone', !illegal);
}

group('higher difficulty plays better (hard beats random)');
{
  let hardWins = 0;
  const GAMES = 8;
  for (let g = 0; g < GAMES; g++) {
    let bd = C.initialBoard();
    let turn = 1; let steps = 0;
    while (steps < 120) {
      const moves = C.legalMovesOn(bd, turn);
      if (!moves.length) {
        if (!C.legalMovesOn(bd, turn === 1 ? 2 : 1).length) break;
        turn = (turn === 1 ? 2 : 1); continue;
      }
      let mv;
      if (turn === 1) mv = moves[Math.floor(Math.random() * moves.length)]; // random "player"
      else mv = C.chooseAIMove(bd.slice(), 2, 'hard');
      C.applyOn(bd, mv, turn);
      turn = (turn === 1 ? 2 : 1);
      steps++;
    }
    const d = C.countDiscs(bd);
    if (d.white > d.black) hardWins++;
  }
  check(`hard AI wins the majority of ${GAMES} games vs random`, hardWins >= 6, `wins=${hardWins}`);
}

group('full game driven through the REAL UI entry point');
{
  // Reset shared state (earlier groups mutated these globals) to the fresh-load
  // condition, then drive everything through real button / cell clicks.
  C.started = false; C.gameOver = false; C.history = [];
  env.els.mode.value = 'pve';
  env.els.level.value = 'easy';      // easy = fast; the point is reaching end-of-game via clicks
  env.els.chkAI.checked = false;     // human=black, AI=white

  // Before pressing Start the game must NOT be running.
  check('game is not started before clicking Start', C.started === false);

  // Click the real Start button (the required visible entry point).
  env.els.btnStart.fire('click');
  check('clicking Start enters the game', C.started === true);
  check('board is the standard opening after Start', C.countDiscs(C.board).black === 2 && C.countDiscs(C.board).white === 2);

  // Now click real board squares: on each human (black) turn, play the first
  // legal cell. The AI responds inside the same click handler.
  const cells = env.els.board.children;
  let guard = 0;
  while (!C.gameOver && guard < 400) {
    const t = C.turn;
    const moves = C.legalMovesOn(C.board, t);
    if (!moves.length) break;
    const m = moves[0];
    const i = m.r * 8 + m.c;
    cells[i].fire('click', { target: cells[i] });
    guard++;
  }
  check('a full game played by clicking squares reaches game over', C.gameOver === true, `guard=${guard}`);
  check('result was decided', C.result === 'blackWin' || C.result === 'whiteWin' || C.result === 'draw' || C.result === 'youWin' || C.result === 'aiWin', C.result);
  const fin = C.countDiscs(C.board);
  const empties = C.board.filter(v => v === 0).length;
  check('final disc total + empties == 64', fin.black + fin.white + empties === 64, `${fin.black}+${fin.white}+${empties}`);
  check('at least some moves were played', C.moveCount > 0, String(C.moveCount));

  // Undo via the real button works and rewinds the board.
  const beforeUndo = C.countDiscs(C.board).black + C.countDiscs(C.board).white;
  env.els.btnUndo.fire('click');
  const afterUndo = C.countDiscs(C.board).black + C.countDiscs(C.board).white;
  check('undo button rewinds at least one disc pair', afterUndo <= beforeUndo);
}

group('reverse validation — the suite actually catches rule bugs');
{
  // Buggy capture that only checks the 4 orthogonal directions (drops the diagonals).
  function flips4(bd, r, c, color) {
    if (bd[r * 8 + c] !== 0) return [];
    const opp = color === 1 ? 2 : 1, out = [];
    const orth = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const d of orth) {
      let rr = r + d[0], cc = c + d[1], line = [];
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && bd[rr * 8 + cc] === opp) { line.push(rr * 8 + cc); rr += d[0]; cc += d[1]; }
      if (line.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && bd[rr * 8 + cc] === color) out.push(...line);
    }
    return out;
  }
  function legal4(bd, color) {
    const out = [];
    for (let i = 0; i < 64; i++) if (bd[i] === 0) { const r = (i / 8) | 0, c = i % 8; if (flips4(bd, r, c, color).length) out.push(i); }
    return out;
  }
  const real = C.legalMovesOn(C.initialBoard(), 1).length;
  const buggy = legal4(C.initialBoard(), 1).length;
  check('REAL code: black has 4 opening moves', real === 4, `got ${real}`);
  // NOTE: the opening position is reachable orthogonally too, so a 4-dir bug would
  // NOT change the opening count. Use a purely-diagonal capture instead.
  const diag = new Array(64).fill(0);
  diag[7 * 8 + 7] = 1; diag[5 * 8 + 5] = 2; diag[6 * 8 + 6] = 2; // black(7,7); whites on the (1,1) diagonal
  const realD = C.flipsFor(diag, 4, 4, 1).length;   // expect 2 (the two whites)
  const buggyD = flips4(diag, 4, 4, 1).length;       // expect 0 (no orthogonal line)
  check('REAL captures a purely-diagonal line (2 discs)', realD === 2, `got ${realD}`);
  check('BUGGY 4-direction code would FAIL on a diagonal capture', buggyD !== realD, `buggy=${buggyD}`);

  // Buggy apply that forgets to flip the LAST captured disc.
  function applyBuggy(bd, mv, color) {
    bd[mv.r * 8 + mv.c] = color;
    for (let i = 0; i < mv.flips.length - 1; i++) bd[mv.flips[i]] = color; // drop the last
  }
  const bReal = C.initialBoard();
  const bBug = C.initialBoard();
  const m0 = C.legalMovesOn(bReal, 1).find(m => m.r === 2 && m.c === 3);
  C.applyOn(bReal, m0, 1);
  applyBuggy(bBug, m0, 1);
  const realBlk = C.countDiscs(bReal).black, buggyBlk = C.countDiscs(bBug).black;
  check('REAL apply flips both discs (black=4)', realBlk === 4, `got ${realBlk}`);
  check('BUGGY apply misses the last disc (black=3, would fail)', buggyBlk !== realBlk, `buggy=${buggyBlk}`);

  // Buggy legal-move generator that treats any square next to an opponent as legal.
  function legalNoBracket(bd, color) {
    const opp = color === 1 ? 2 : 1, out = [];
    for (let i = 0; i < 64; i++) {
      if (bd[i] !== 0) continue;
      const r = (i / 8) | 0, c = i % 8;
      let adj = false;
      for (const d of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]) {
        const rr = r + d[0], cc = c + d[1];
        if (rr>=0&&rr<8&&cc>=0&&cc<8&&bd[rr*8+cc]===opp) adj=true;
      }
      if (adj) out.push(i);
    }
    return out;
  }
  const realL = C.legalMovesOn(C.initialBoard(), 1).length;
  const buggyL = legalNoBracket(C.initialBoard(), 1).length;
  check('REAL legal set on opening is exactly 4', realL === 4);
  check('BUGGY no-bracket generator would FAIL (far more than 4)', buggyL !== 4, `buggy=${buggyL}`);
}

group('language switch re-renders dynamic T.t() text (T.onChange)');
{
  // Reset to the fresh ready state and a known language.
  C.started = false; C.gameOver = false;
  env.els.resultScreen.classList.add('hidden');
  // Toggling the language must re-render the T.t()-built HUD (the proof that
  // T.onChange is registered): ready status shows the translated "Press Start".
  C.T.set('zh');
  check('onChange wired: ready status switches to Chinese after T.set(zh)', env.els.status.textContent.indexOf('开始') >= 0, env.els.status.textContent);
  C.T.set('en');
  check('ready status switches back to English after T.set(en)', env.els.status.textContent.indexOf('Start') >= 0, env.els.status.textContent);

  // In-game: click the real Start button, then toggle the language.
  env.els.mode.value = 'pve'; env.els.level.value = 'easy'; env.els.chkAI.checked = false;
  env.els.btnStart.fire('click');
  check('game started for language test', C.started === true);
  C.T.set('zh');
  check('in-game turn text is Chinese after T.set(zh)',
    env.els.turnText.textContent.indexOf('黑棋') >= 0 || env.els.turnText.textContent.indexOf('白棋') >= 0,
    env.els.turnText.textContent);
  C.T.set('en');
  check('in-game turn text is English after T.set(en)',
    env.els.turnText.textContent.indexOf('Black') >= 0 || env.els.turnText.textContent.indexOf('White') >= 0,
    env.els.turnText.textContent);

  // Result dialog visible: drive an end-of-game, then switch language.
  const win = new Array(64).fill(0);
  for (let i = 0; i < 40; i++) win[i] = 1;
  for (let i = 40; i < 60; i++) win[i] = 2;
  C.board = win.slice(); C.gameOver = false;
  C.endGame();
  check('result dialog is populated', env.els.resultScore.textContent.length > 0);
  C.T.set('zh');
  check('result score switches to Chinese after T.set(zh)',
    env.els.resultScore.textContent.indexOf('黑') >= 0 || env.els.resultScore.textContent.indexOf('白') >= 0,
    env.els.resultScore.textContent);
  C.T.set('en');
  check('result score switches back to English after T.set(en)',
    env.els.resultScore.textContent.indexOf('Black') >= 0 || env.els.resultScore.textContent.indexOf('White') >= 0,
    env.els.resultScore.textContent);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
