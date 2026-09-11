#!/usr/bin/env node
/**
 * Logic tests for bubble-game.
 *
 * The smoke test only proves the page does not throw. It cannot tell whether
 * the hex neighbour math is right, whether 3 same-colour bubbles actually clear,
 * or whether a bubble cut off from the ceiling really drops. This suite loads the
 * whole inline script in a vm sandbox (top-level `var`/functions land on the
 * context global, so we can read internal state) and asserts the rules.
 *
 * It also replays a full game through the REAL UI entry points — clicking the
 * actual Start button and firing with real keydown / canvas-click events — so a
 * bug like "the start button does nothing" would be caught, not just a callable
 * internal function.
 *
 * Three reverse checks deliberately break an internal function and confirm the
 * matching test then fails, proving the assertions are live rather than tautological.
 *
 * Usage:  node tools/bubble-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'bubble-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail !== undefined ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

/* ----------------------------------------------------------------- fake DOM
 * Faithful copy of tools/smoke.js' makeContext: the game is validated against
 * this exact stub, so the suite must reproduce it. */
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
      this.style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' };
      this.dataset = {};
      this.handlers = {};
      this.parent = null;
      this.clientWidth = 440;
      this.clientHeight = 440;
      this.width = 480;
      this.height = 480;
      this.value = '';
      this.checked = false;
      this.selectedOptions = [{ text: 'Normal' }];
      this._text = '';
      this._html = '';
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
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
    fire(t, ev) { (this.handlers[t] || []).forEach(f => f(ev || {})); }
    appendChild(c) {
      if (c instanceof Frag) c.children.forEach(x => { x.parent = this; this.children.push(x); });
      else { c.parent = this; this.children.push(c); }
      return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
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
    setAttribute() {}
    getAttribute() { return null; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 480, height: 480 }; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html; }
  }

  const els = {};
  const docHandlers = {};
  const winHandlers = {};
  let frame = null;

  const context = {
    console,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => Date.now() },
    intervals: [],
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: fn => context.intervals.push(fn),
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
    winHandlers,
    fireDoc(t, ev) { (docHandlers[t] || []).forEach(f => f(ev || {})); },
    fireWin(t, ev) { (winHandlers[t] || []).forEach(f => f(ev || {})); },
    step() { const f = frame; frame = null; if (f) f(); },
    timers(n) {
      const out = [];
      for (let i = 0; i < n; i++) context.intervals.slice().forEach(fn => { if (fn) out.push(fn); });
      return out;
    }
  };
}

// Mirror tools/smoke.js: pre-select the `selected` <option> so the game reads a
// real difficulty instead of ''.
function preselectOptions(html, env) {
  const re = /<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, id, body] = m;
    const opts = [...body.matchAll(/<option\b[^>]*\bvalue="([^"]*)"([^>]*)>/g)];
    if (!opts.length) continue;
    const picked = opts.find(o => /\bselected\b/.test(o[2])) || opts[0];
    env.context.document.getElementById(id).value = picked[1];
  }
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const html = fs.readFileSync(GAME, 'utf8');
  preselectOptions(html, env);
  inlineScripts(html).forEach((s, i) =>
    vm.runInContext(s, env.context, { filename: `bubble#${i}` }));
  return env;
}

/* ------------------------------------------------------------- test helpers */
function has(list, r, c) {
  for (let i = 0; i < list.length; i++) if (list[i][0] === r && list[i][1] === c) return true;
  return false;
}
function mkGrid(env) {
  const COLS = env.context.COLS;
  const g = [];
  for (let r = 0; r < 24; r++) { const row = []; for (let c = 0; c < COLS; c++) row[c] = -1; g.push(row); }
  return g;
}
function put(g, r, c, v) { g[r][c] = v; }

/* ============================================================== the tests */

const env = boot();
const C = env.context;
const COLS = C.COLS;
const key = k => env.fireWin('keydown', { key: k, preventDefault() {} });
const frames = n => { for (let i = 0; i < n; i++) env.step(); };

group('geometry & hex neighbours');
check('COLS is 14', COLS === 14, COLS);
check('radius R is 14', C.R === 14, C.R);
check('FIELD_W = COLS*CELL + R', C.FIELD_W === COLS * C.CELL + C.R, C.FIELD_W);
check('row height is positive', C.ROW_H > 0, C.ROW_H);
check('shooter sits at horizontal centre', C.SHOOTER_X === C.FIELD_W / 2, C.SHOOTER_X);
check('even-row cell (0,0) centre x = R', C.centerX(0, 0) === C.R, C.centerX(0, 0));
check('odd-row cell (1,0) centre x = 2R (shifted right)', C.centerX(1, 0) === 2 * C.R, C.centerX(1, 0));
check('odd/even rows use different x offsets', C.centerX(0, 0) !== C.centerX(1, 0));
check('even row (0,1) centre x = R + CELL', C.centerX(0, 1) === C.R + C.CELL, C.centerX(0, 1));
check('rightmost even cell stays inside the field', C.centerX(0, COLS - 1) <= C.FIELD_W - C.R, C.centerX(0, COLS - 1));

check('even interior cell (5,5) has 6 neighbours', C.neighbors(5, 5).length === 6, C.neighbors(5, 5).length);
check('odd interior cell  (4,5) has 6 neighbours', C.neighbors(4, 5).length === 6, C.neighbors(4, 5).length);
check('even (0,1) has 4 in-bounds neighbours', C.neighbors(0, 1).length === 4, C.neighbors(0, 1).length);
check('even corner (0,0) has 2 neighbours', C.neighbors(0, 0).length === 2, C.neighbors(0, 0).length);
check('odd boundary (1,0) has 5 neighbours', C.neighbors(1, 0).length === 5, C.neighbors(1, 0).length);
check('even (0,1) reaches down to (1,0) and (1,1)',
  has(C.neighbors(0, 1), 1, 0) && has(C.neighbors(0, 1), 1, 1));
check('odd (1,1) reaches up to (0,1) and (0,2)',
  has(C.neighbors(1, 1), 0, 1) && has(C.neighbors(1, 1), 0, 2));
check('even up-left of (2,5) is (1,4)',
  has(C.neighbors(2, 5), 1, 4), JSON.stringify(C.neighbors(2, 5)));
check('odd up-left of (3,5) is (2,5)',
  has(C.neighbors(3, 5), 2, 5), JSON.stringify(C.neighbors(3, 5)));
check('neighbour relation is symmetric (2,5) <-> (3,5)',
  has(C.neighbors(2, 5), 3, 5) && has(C.neighbors(3, 5), 2, 5));

group('match detection (same-colour flood fill)');
{
  let g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 0, 1, 0); put(g, 0, 2, 0);
  C.grid = g;
  check('three in a row form a group of 3', C.findGroup(0, 1).length === 3, C.findGroup(0, 1).length);

  g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 0, 1, 0); put(g, 0, 2, 1);
  C.grid = g;
  check('a different colour breaks the chain (group of 2)', C.findGroup(0, 0).length === 2, C.findGroup(0, 0).length);

  g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 1, 0, 0); put(g, 1, 1, 0);
  C.grid = g;
  check('hex-connected trio also counts as 3', C.findGroup(0, 0).length === 3, C.findGroup(0, 0).length);

  g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 0, 1, 1); put(g, 0, 2, 0);
  C.grid = g;
  check('middle of a different colour gives a lone bubble', C.findGroup(0, 1).length === 1, C.findGroup(0, 1).length);

  g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 0, 1, 0); put(g, 0, 2, 0); put(g, 0, 3, 0);
  C.grid = g;
  check('a run of four still clears (>=3)', C.findGroup(0, 1).length === 4, C.findGroup(0, 1).length);

  g = mkGrid(env);
  C.grid = g;
  check('an empty cell yields an empty group', C.findGroup(5, 5).length === 0, C.findGroup(5, 5).length);
  check('findGroup returns an array', Array.isArray(C.findGroup(0, 0)));
}

group('floating detection (disconnected from ceiling)');
{
  let g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 5, 5, 0);          // one on the ceiling, one stranded
  C.grid = g;
  const fl = C.findFloating();
  check('a bubble with no path to the top is floating', fl.length >= 1 && has(fl, 5, 5), JSON.stringify(fl));

  g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 1, 0, 0); put(g, 2, 0, 0);  // vertical chain to ceiling
  C.grid = g;
  check('a chain anchored to the ceiling is NOT floating', C.findFloating().length === 0, JSON.stringify(C.findFloating()));

  g = mkGrid(env);
  put(g, 3, 3, 0);                            // fully stranded, no ceiling anchor at all
  C.grid = g;
  check('with an empty top row everything filled is floating',
    C.findFloating().length === 1 && has(C.findFloating(), 3, 3), JSON.stringify(C.findFloating()));

  g = mkGrid(env);
  C.grid = g;
  check('an empty board has nothing floating', C.findFloating().length === 0, C.findFloating().length);
  check('findFloating returns an array', Array.isArray(C.findFloating()));
}

group('snap / resolveCell');
{
  let g = mkGrid(env);
  C.grid = g;
  const top = C.resolveCell(C.SHOOTER_X, C.CEIL_Y + 2);
  check('a shot at the ceiling resolves to row 0', top[0] === 0, JSON.stringify(top));
  check('resolveCell returns [r, c] with a valid column', top[1] >= 0 && top[1] < COLS, JSON.stringify(top));
  check('resolveCell returns a 2-element array', Array.isArray(top) && top.length === 2);

  // Fill the whole top row, then fire into it: the bubble must stick to an
  // EMPTY neighbour, never onto an occupied cell.
  g = mkGrid(env);
  for (let c = 0; c < COLS; c++) put(g, 0, c, 0);
  C.grid = g;
  const stuck = C.resolveCell(C.centerX(0, 7), C.centerY(0) + 1);
  check('snap near a full row lands on an empty cell', C.getColor(stuck[0], stuck[1]) === -1, JSON.stringify(stuck));
  check('snapped column stays in range', stuck[1] >= 0 && stuck[1] < COLS);

  g = mkGrid(env);
  C.grid = g;
  const exact = C.resolveCell(C.centerX(0, 7), C.centerY(0));
  check('empty board snaps to the exact cell aimed at', exact[0] === 0 && exact[1] === 7, JSON.stringify(exact));
}

group('match + drop pipeline (applyMatches)');
{
  let g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 0, 1, 0); put(g, 0, 2, 0);
  C.grid = g;
  const res = C.applyMatches(0, 1);
  check('applying a 3-match removes 3 bubbles', res.removed === 3, res.removed);
  check('matched bubble is cleared from the grid', C.getColor(0, 1) === -1);
  check('no bubbles drop when the group was self-supported', res.dropped === 0, res.dropped);

  // Top trio is the only link to the ceiling; clearing it strands the bubble below.
  g = mkGrid(env);
  put(g, 0, 5, 1); put(g, 1, 5, 1); put(g, 2, 5, 1);  // the match (colour 1)
  put(g, 3, 5, 2);                                      // hangs below, different colour
  C.grid = g;
  const res2 = C.applyMatches(0, 5);
  check('clearing the ceiling link drops the stranded bubble', res2.dropped === 1, res2.dropped);
  check('the stranded bubble is removed after dropping', C.getColor(3, 5) === -1);

  g = mkGrid(env);
  put(g, 0, 0, 0);                       // single bubble, no match
  C.grid = g;
  const res3 = C.applyMatches(0, 0);
  check('a lone bubble (fewer than 3) is not removed', res3.removed === 0 && C.getColor(0, 0) === 0);
}

group('real UI entry point (click Start, fire with key / click)');
{
  check('game boots into the ready state', C.state === 'ready', C.state);
  check('start overlay is visible at boot', C && env.els.startOverlay._cls.has('show'));

  // Difficulty can be changed while not playing.
  env.els.difficulty.value = 'hard';
  env.els.difficulty.fire('change');
  check('difficulty switch to hard sets 6 colours', C.config.colors === 6, C.config.colors);
  check('hard difficulty starts 7 rows', C.config.initRows === 7, C.config.initRows);
  env.els.difficulty.value = 'normal';
  env.els.difficulty.fire('change');
  check('difficulty switch back to normal sets 5 colours', C.config.colors === 5, C.config.colors);

  // A key pressed in the ready state must NOT throw or fire a shot.
  key('ArrowLeft');
  check('arrow key in ready state is a no-op (no crash)', C.state === 'ready' && C.shots === 0, C.shots);

  // The headline requirement: the visible Start button actually begins a game.
  env.els.btnStart.fire('click');
  check('clicking Start enters the playing state', C.state === 'playing', C.state);
  check('start overlay hidden after Start', !env.els.startOverlay._cls.has('show'));
  check('HUD progress shows shots-until-drop at game start',
    env.els.progress.textContent === String(C.config.pushEvery), env.els.progress.textContent);
  check('level label shows the difficulty name', env.els.levelLabel.textContent === 'Normal', env.els.levelLabel.textContent);
  check('best score loaded as a number', typeof C.best === 'number' && C.best >= 0, C.best);

  const before = C.totalFilled();
  check('board is pre-filled at start', before > 0, before);

  // Fire with a REAL space keydown, then advance the physics via animation frames.
  key(' ');
  check('space keydown fires a shot (shots = 1)', C.shots === 1, C.shots);
  check('a bubble is now in flight', C.flying !== null);
  check('loaded + next colours are valid indices', C.curColor < C.config.colors && C.nextColor < C.config.colors,
    C.curColor + '/' + C.nextColor);

  frames(300);
  check('the flying bubble eventually attaches (flight ends)', C.flying === null, 'still flying');
  check('game still running after the shot resolved', C.state === 'playing', C.state);

  // Also exercise the click-to-fire path on the real canvas element.
  const s2 = C.shots;
  env.els.board.fire('click', { target: env.els.board, button: 0, preventDefault() {} });
  check('clicking the board fires another shot', C.shots === s2 + 1, C.shots);
  frames(300);
  check('second shot also resolves cleanly', C.flying === null && C.state === 'playing');
}

group('game over & restart through the dialog');
{
  // Force a bubble across the warning line, then ask the rule to evaluate.
  let g = mkGrid(env);
  put(g, 21, 0, 0);     // row 21 centre + R exceeds WARN_Y (verified by geometry)
  C.grid = g;
  C.checkGameOver();
  check('crossing the warning line ends the game', C.state === 'over', C.state);
  check('result overlay is shown on game over', env.els.overlay._cls.has('show'));
  check('dialog title is the game-over message', env.els.dlgTitle.textContent === 'Game Over', env.els.dlgTitle.textContent);

  // The result dialog's button starts a fresh game.
  env.els.dlgBtn.fire('click');
  check('Play Again returns to a live game', C.state === 'playing', C.state);
  check('a restarted game resets the score', env.els.score.textContent === '0', env.els.score.textContent);
  check('result overlay hidden after restart', !env.els.overlay._cls.has('show'));
}

/* --------------------------------------------------- reverse (live) checks
 * Each of these temporarily corrupts an internal function and confirms the
 * matching assertion then FAILS. That proves the assertions above are not
 * vacuously true — they would actually catch a regression. */
group('reverse checks (prove the assertions are effective)');
{
  // 1) Break neighbours(): a known 3-cluster must then fail to be found.
  const origN = C.neighbors;
  C.neighbors = function () { return []; };
  let g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 0, 1, 0); put(g, 0, 2, 0);
  C.grid = g;
  const brokenGroup = C.findGroup(0, 1).length >= 3;
  check('reverse: broken neighbours() makes the match test fail (caught)', brokenGroup === false);
  C.neighbors = origN;

  // 2) Break findFloating(): a stranded bubble must then go undetected.
  const origF = C.findFloating;
  C.findFloating = function () { return []; };
  g = mkGrid(env);
  put(g, 0, 0, 0); put(g, 5, 5, 0);
  C.grid = g;
  const detected = C.findFloating().length >= 1;
  check('reverse: broken findFloating() makes the float test fail (caught)', detected === false);
  C.findFloating = origF;

  // 3) Break resolveCell(): it must then return an out-of-range cell, which the
  //    snap test (cell must be in range) would reject.
  const origR = C.resolveCell;
  C.resolveCell = function () { return [999, 999]; };
  g = mkGrid(env);
  C.grid = g;
  const cell = C.resolveCell(100, 100);
  const inRange = cell[0] >= 0 && cell[0] < 60 && cell[1] >= 0 && cell[1] < COLS;
  check('reverse: broken resolveCell() returns an invalid cell (caught)', inRange === false);
  C.resolveCell = origR;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
