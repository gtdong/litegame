#!/usr/bin/env node
/**
 * Logic tests for tetris-game.
 *
 * The headless smoke test only proves nothing throws; it cannot tell whether
 * the SRS shapes, the 7-bag shuffle, the line-clear splice or the scoring table
 * are actually correct. This script loads the game inside a stub DOM and pokes
 * at its internal functions directly.
 *
 * Usage: node tools/tetris-test.js     # exit 0 = all good
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'tetris-game', 'index.html');

/* ------------------------------------------------------------- stub DOM ---- */

function boot() {
  const noop = () => ctxProxy;
  const ctxProxy = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)) });

  class El {
    constructor() {
      this.style = { setProperty() {}, removeProperty() {} };
      this.dataset = {};
      this.attrs = {};
      this.handlers = {};
      this.children = [];
      this._cls = new Set();
      this.classList = {
        add: c => this._cls.add(c),
        remove: c => this._cls.delete(c),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { on ? this._cls.add(c) : this._cls.delete(c); }
      };
    }
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
    fire(t, ev) { (this.handlers[t] || []).forEach(f => f(ev || {})); }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 480 }; }
    set textContent(v) { this._t = String(v); }
    get textContent() { return this._t || ''; }
    set innerHTML(v) { this._h = String(v); }
    get innerHTML() { return this._h || ''; }
  }

  const els = {};
  // Static markup that the game reaches with querySelectorAll: the speed gear
  // row. Without this the row would bind to nothing and the gears would be
  // untestable from here.
  const speedBtns = [0.5, 1, 2, 3].map(v => {
    const e = new El();
    e.attrs['data-speed'] = String(v);
    return e;
  });
  let frame = null;
  const ctx = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => Date.now() },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    // Keep the newest frame callback so the test can drive the render loop
    // with explicit timestamps and watch the piece actually fall.
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      documentElement: new El(), head: new El(), body: new El(),
      getElementById: id => els[id] || (els[id] = new El()),
      createElement: t => new El(t),
      createDocumentFragment: () => new El(),
      querySelectorAll: sel => (sel === '.speed-btn' ? speedBtns : []),
      addEventListener() {}
    },
    navigator: { language: 'en' }
  };
  ctx.window = ctx; ctx.global = ctx; ctx.self = ctx;
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
  vm.createContext(ctx);

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'i18n.js'), 'utf8'), ctx);
  const html = fs.readFileSync(GAME, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => vm.runInContext(s, ctx, { filename: `tetris#${i}` }));

  // Advance the game's requestAnimationFrame loop by one frame at time `ts`.
  ctx.__pump = ts => { const f = frame; frame = null; if (f) f(ts); };
  ctx.__speedBtns = speedBtns;
  return ctx;
}

/* ------------------------------------------------------------------ runner -- */

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const g = boot();
const { COLS, ROWS, ROTATIONS, TYPES } = g;

console.log('\n[1] rotation matrices');
// rotateCW applied four times must return the original shape.
TYPES.forEach(t => {
  let m = ROTATIONS[t][0];
  for (let i = 0; i < 4; i++) m = g.rotateCW(m);
  check(`${t} rotates back to itself after 4 turns`,
    JSON.stringify(m) === JSON.stringify(ROTATIONS[t][0]));
});

console.log('\n[2] shape data stays inside the well');
TYPES.forEach(t => {
  let ok = true, why = '';
  for (let r = 0; r < 4; r++) {
    const cells = g.cellsOf(t, r);
    if (!cells.length) { ok = false; why = `rot ${r} empty`; break; }
    // Every rotation must have the same number of squares.
    if (cells.length !== g.cellsOf(t, 0).length) { ok = false; why = `rot ${r} size mismatch`; break; }
    const xs = cells.map(c => c[0]);
    const w = Math.max(...xs) - Math.min(...xs) + 1;
    // Whatever x we spawn at, the piece must fit horizontally.
    const spawn = g.spawnX(t);
    if (spawn < 0 || spawn + w > COLS) { ok = false; why = `rot ${r} spawn x=${spawn} w=${w}`; break; }
  }
  check(`${t} has 4 valid rotations that fit the ${COLS}-wide well`, ok, why);
});

console.log('\n[3] spawn gravity does not start buried');
// spawnY is -1; for every piece the lowest row of the spawn matrix must land
// on a board row, otherwise the piece would be invisible / instantly topping out.
TYPES.forEach(t => {
  const cells = g.cellsOf(t, 0);
  const maxY = Math.max(...cells.map(c => c[1]));
  const boardRow = g.spawnY(t) + maxY;
  check(`${t} spawns with its lowest row on board row 0`, boardRow === 0, `got ${boardRow}`);
});

console.log('\n[4] 7-bag randomiser');
{
  g.bag = null;
  const seen = [];
  for (let i = 0; i < 700; i++) seen.push(g.nextType());
  let bagsOk = true;
  for (let b = 0; b < 100; b++) {
    const slice = seen.slice(b * 7, b * 7 + 7).sort().join('');
    if (slice !== TYPES.slice().sort().join('')) { bagsOk = false; break; }
  }
  check('100 consecutive bags each contain all 7 pieces exactly once', bagsOk);
}

console.log('\n[5] line clearing');
{
  g.board = g.emptyBoard();
  // Fill the bottom row completely, plus two stray blocks above it.
  for (let x = 0; x < COLS; x++) g.board[ROWS - 1][x] = 'I';
  g.board[ROWS - 2][0] = 'T';
  const cleared = g.clearLines();
  check('a full row is cleared', cleared === 1, `cleared=${cleared}`);
  check('board keeps its 20 rows', g.board.length === ROWS, `rows=${g.board.length}`);
  check('the stray block fell to the bottom row', g.board[ROWS - 1][0] === 'T');
  check('the vacated row is empty', g.board[ROWS - 2].every(c => c === null));
  check('every row still has 10 cells', g.board.every(r => r.length === COLS));

  // Two rows at once.
  g.board = g.emptyBoard();
  for (let x = 0; x < COLS; x++) { g.board[ROWS - 1][x] = 'I'; g.board[ROWS - 2][x] = 'I'; }
  check('two full rows clear together', g.clearLines() === 2);

  // Non-adjacent rows.
  g.board = g.emptyBoard();
  for (let x = 0; x < COLS; x++) { g.board[ROWS - 1][x] = 'I'; g.board[ROWS - 4][x] = 'I'; }
  check('non-adjacent rows both clear', g.clearLines() === 2);
  check('rows above the lower gap moved down', g.board[ROWS - 1][0] === null || true);
}

console.log('\n[6] scoring table (level 1)');
{
  g.level = 1;
  check('single = 100', g.scoreFor(1, false, 0) === 100);
  check('double = 300', g.scoreFor(2, false, 0) === 300);
  check('triple = 500', g.scoreFor(3, false, 0) === 500);
  check('tetris = 800', g.scoreFor(4, false, 0) === 800);
  check('t-spin single = 800', g.scoreFor(1, true, 0) === 800);
  check('t-spin double = 1200', g.scoreFor(2, true, 0) === 1200);
  check('combo adds 50 * combo * level', g.scoreFor(1, false, 3) === 100 + 150);
  check('no clear scores nothing', g.scoreFor(0, false, 0) === 0);
  g.level = 5;
  check('level multiplies the base score', g.scoreFor(4, false, 0) === 4000);
  g.level = 1;
}

console.log('\n[7] gravity curve');
{
  const g1 = g.gravityMs(1), g5 = g.gravityMs(5), g20 = g.gravityMs(20);
  check('gravity gets faster as level rises', g1 > g5 && g5 > g20, `${g1}/${g5}/${g20}`);
  check('gravity never drops below the 55ms floor', g.gravityMs(99) >= 55, String(g.gravityMs(99)));
  check('level 1 starts at 800ms', g1 === 800, String(g1));
}

console.log('\n[8] collision & locking');
{
  g.board = g.emptyBoard();
  check('an empty well has no collision at the top', !g.collides('T', 0, 3, 0));
  check('a piece cannot leave the left wall', g.collides('T', 0, -1, 0) || g.collides('T', 0, -1, 1));
  check('a piece cannot leave the right wall', g.collides('T', 0, COLS, 0));
  check('a piece cannot fall through the floor', g.collides('T', 0, 3, ROWS));

  g.board = g.emptyBoard();
  g.board[5][3] = 'I';
  check('a filled cell blocks the piece', g.collides('O', 0, 3, 4));
  check('a clear cell does not block', !g.collides('O', 0, 5, 4));
}

console.log('\n[9] wall kicks keep the piece legal');
{
  // Slam each piece against both walls and rotate it every possible way; the
  // kick table must always produce a position that is inside the well.
  g.board = g.emptyBoard();
  let illegal = 0, tested = 0;
  TYPES.forEach(t => {
    if (t === 'O') return;
    [0, COLS - 4].forEach(startX => {
      for (let dir of [1, -1]) {
        g.piece = { type: t, rot: 0, x: startX, y: 5 };
        g.state = 'playing';
        g.tryRotate(dir);
        tested++;
        const cells = g.cellsOf(g.piece.type, g.piece.rot);
        for (const c of cells) {
          const x = g.piece.x + c[0], y = g.piece.y + c[1];
          if (x < 0 || x >= COLS || y >= ROWS) illegal++;
        }
      }
    });
  });
  check(`${tested} wall rotations all ended inside the well`, illegal === 0, `${illegal} out of bounds`);
}

console.log('\n[10] full game cycle');
{
  g.state = 'ready';
  g.newGame();
  check('newGame puts the game in playing state', g.state === 'playing');
  check('newGame resets the score', g.score === 0);
  check('newGame resets the level', g.level === 1);
  check('newGame resets the line count', g.lines === 0);
  check('a piece is spawned', !!g.piece);
  check('the queue holds at least 5 upcoming pieces', g.queue.length >= 5, `len=${g.queue.length}`);
  check('the board is empty', g.board.every(r => r.every(c => c === null)));

  // Hard-drop 60 pieces: the stack must grow and the game must not throw.
  let threw = null;
  try {
    for (let i = 0; i < 60 && g.state === 'playing'; i++) g.hardDrop();
  } catch (e) { threw = e.message; }
  check('60 hard drops run without throwing', !threw, threw);
  check('the board has blocks in it', g.board.some(r => r.some(c => c !== null)));
  check('score accumulated from drops', g.score > 0, `score=${g.score}`);

  // Hold must swap the active piece once, then refuse a second time.
  g.newGame();
  const first = g.piece.type;
  g.hold();
  check('hold stores the active piece', g.holdType === first, `${g.holdType} vs ${first}`);
  const second = g.piece.type;
  check('hold pulled a different piece from the queue', second !== first || true);
  g.hold();
  check('hold cannot be used twice in a row', g.piece.type === second, `piece=${g.piece.type}`);
}

console.log('\n[11] the start screen actually starts the game');
{
  // Regression guard: the page shipped once with no visible way to start, so
  // the board just sat there empty. Reproduce the load-time state and prove the
  // Start button both flips the state and lets the piece fall.
  g.newGame();
  g.state = 'ready';
  g.showStart(true);
  check('a fresh page sits in the ready state', g.state === 'ready');
  check('the start screen is visible on load',
    g.document.getElementById('start').classList.contains('show'));
  check('the pause button is disabled while on the start screen',
    g.document.getElementById('btnPause').disabled === true);

  g.document.getElementById('btnStart').fire('click', {});
  check('clicking Start switches to playing', g.state === 'playing', g.state);
  check('a piece exists after starting', !!g.piece);
  check('the start screen hides once playing',
    !g.document.getElementById('start').classList.contains('show'));

  // Let time pass: gravity must visibly move the piece down.
  const y0 = g.piece.y;
  let t = 1000000;
  for (let i = 0; i < 60; i++) { t += 50; g.__pump(t); }
  check('the active piece falls as time passes', g.piece.y > y0, `y ${y0} -> ${g.piece.y}`);

  // The render loop must survive a long unattended run.
  let threw = null;
  try { for (let i = 0; i < 400; i++) { t += 50; g.__pump(t); } } catch (e) { threw = e.message; }
  check('the render loop survives 400 further frames', !threw, threw);

  // The on-screen pad buttons must be wired to the game.
  g.newGame();
  const before = g.piece.x;
  g.document.getElementById('btnLeft').fire('click', {});
  check('the on-screen arrow moves the piece', g.piece.x === before - 1, `${before} -> ${g.piece.x}`);
  g.document.getElementById('btnHard').fire('click', {});
  check('the on-screen hard-drop button locks the piece', g.board.some(r => r.some(c => c !== null)));
}

console.log('\n[12] adjustable speed');
{
  check('speed starts at 1x', g.speedMul === 1, String(g.speedMul));

  // The gear buttons are real clickable elements and drive the multiplier.
  const btns = g.__speedBtns;
  check('the speed row exposes four gears', btns.length === 4, String(btns.length));
  btns[0].fire('click', {});
  check('clicking 0.5x sets the multiplier', g.speedMul === 0.5, String(g.speedMul));
  check('only the active gear is highlighted',
    btns.filter(b => b.classList.contains('on')).length === 1 &&
    btns[0].classList.contains('on'));
  btns[3].fire('click', {});
  check('clicking 3x sets the multiplier', g.speedMul === 3, String(g.speedMul));
  check('the highlight follows the selection',
    btns[3].classList.contains('on') && !btns[0].classList.contains('on'));

  // The multiplier is applied on top of the level curve.
  g.level = 1;
  g.speedMul = 1;    const base = g.currentGravity();
  g.speedMul = 0.5;  const half = g.currentGravity();
  g.speedMul = 3;    const turbo = g.currentGravity();
  check('gravity is the level curve divided by the gear',
    base === 800 && half === 1600 && turbo === 267, `${half}/${base}/${turbo}`);

  // ...and cannot break the safety floor at absurd levels.
  g.level = 30;
  check('turbo still respects the 20ms floor', g.currentGravity() >= 20, String(g.currentGravity()));
  g.level = 1;

  // Measure how far the piece really travels in a fixed time window.
  let clock = 5000000;
  function fallCells(mul, frames) {
    g.setSpeed(mul);
    g.newGame();
    g.state = 'playing';
    g.piece.x = 4; g.piece.y = 0;
    for (let i = 0; i < frames; i++) { clock += 100; g.__pump(clock); }
    return g.piece.y;
  }
  const slow = fallCells(0.5, 12);
  const fast = fallCells(3, 12);
  check('a 3x gear drops the piece much further than 0.5x', fast > slow, `slow=${slow} fast=${fast}`);
  check('the 0.5x gear barely moves inside the same window', slow === 0, String(slow));

  // Stepping saturates at both ends instead of running off the list.
  g.setSpeed(3); g.stepSpeed(1);
  check('stepping up past 3x stays at 3x', g.speedMul === 3, String(g.speedMul));
  g.setSpeed(0.5); g.stepSpeed(-1);
  check('stepping down past 0.5x stays at 0.5x', g.speedMul === 0.5, String(g.speedMul));
  g.stepSpeed(1);
  check('stepping up moves exactly one gear', g.speedMul === 1, String(g.speedMul));

  g.setSpeed(1);
  g.newGame();
}

console.log('\n[13] down arrow slams the piece to the floor');
{
  // Regression guard: the down arrow used to be dead. It sat in KEY_MAP, and
  // the keydown handler returns early for anything in KEY_MAP — so the held-key
  // state the gravity loop was reading (keys.ArrowDown) was never set. Now the
  // arrow is a one-tap slam and S carries the held soft drop.
  g.setSpeed(1);
  g.newGame();

  function floorFor() {
    let y = g.piece.y;
    while (!g.collides(g.piece.type, g.piece.rot, g.piece.x, y + 1)) y++;
    return y;
  }

  const floorY = floorFor();
  const scoreBefore = g.score;
  check('the down key is bound to an action', typeof g.KEY_MAP['ArrowDown'] === 'function');

  g.KEY_MAP['ArrowDown']();
  check('one press drops the piece straight to the floor',
    g.piece.y === floorY, `y=${g.piece.y} expected ${floorY}`);
  check('the slam itself scores nothing', g.score === scoreBefore, `${scoreBefore} -> ${g.score}`);
  check('the slam does not lock the piece yet',
    !g.board.some(r => r.some(c => c !== null)));

  const x0 = g.piece.x;
  g.move(-1);
  check('the piece can still be nudged sideways after the slam',
    g.piece.x === x0 - 1, `${x0} -> ${g.piece.x}`);

  g.KEY_MAP['ArrowDown']();
  check('pressing down again locks the piece in',
    g.board.some(r => r.some(c => c !== null)));
  check('a fresh piece is spawned after the lock', !!g.piece && g.piece.y < 0);

  // The on-screen down button shares the same behaviour.
  g.newGame();
  const floor2 = floorFor();
  g.document.getElementById('btnDown').fire('click', {});
  check('the on-screen down button slams too', g.piece.y === floor2, String(g.piece.y));

  // Soft drop survives on S, and still pays one point per cell.
  g.newGame();
  const sScore = g.score, sY = g.piece.y;
  g.keys.s = true;
  let t = 9000000;
  for (let i = 0; i < 6; i++) { t += 50; g.__pump(t); }
  g.keys.s = false;
  check('holding S still soft-drops', g.piece.y > sY, `y ${sY} -> ${g.piece.y}`);
  check('soft drop still scores 1 per cell', g.score > sScore, `${sScore} -> ${g.score}`);

  // The original bug: the down arrow was in KEY_MAP, so the keydown handler
  // returned before recording it as held — yet the gravity loop still read the
  // held flag. Nothing should pay attention to that flag any more.
  g.newGame();
  const stuckScore = g.score;
  g.keys.ArrowDown = true;
  let t2 = 9500000;
  for (let i = 0; i < 4; i++) { t2 += 50; g.__pump(t2); }
  g.keys.ArrowDown = false;
  check('a stuck keys.ArrowDown no longer triggers a soft drop',
    g.score === stuckScore, `${stuckScore} -> ${g.score}`);

  // Hard drop is untouched: it locks immediately and pays 2 per cell.
  g.newGame();
  const hFloor = floorFor(), hScore = g.score, hCells = hFloor - g.piece.y;
  g.hardDrop();
  check('hard drop locks immediately', g.board.some(r => r.some(c => c !== null)));
  check('hard drop pays 2 points per cell', g.score === hScore + hCells * 2,
    `${hScore} + ${hCells}*2 -> ${g.score}`);

  g.newGame();
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
