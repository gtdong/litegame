#!/usr/bin/env node
/**
 * Logic tests for pong-game.
 *
 * Loads the whole inline script inside a stub DOM (same shape as smoke.js) so
 * the suite can read the game's internal state and drive its requestAnimationFrame
 * loop with explicit timestamps. It asserts the physics and rules are correct —
 * and that the game can actually be entered through the real Start button.
 *
 * Usage: node tools/pong-test.js     # exit 0 = all good
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'pong-game', 'index.html');

/* ------------------------------------------------------------- stub DOM ---- */

function boot() {
  const noop = () => ctxProxy;
  const ctxProxy = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)) });

  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.style = { setProperty() {}, removeProperty() {} };
      this.dataset = {};
      this.attrs = {};
      this.handlers = {};
      this.parent = null;
      this.width = 800;
      this.height = 480;
      this.value = '';
      this.disabled = false;
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
    appendChild(c) { this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 480 }; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html; }
  }

  const els = {};
  const docHandlers = {};
  let frame = null;

  const ctx = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => Date.now() },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      documentElement: new El('html'),
      head: new El('head'),
      body: new El('body'),
      getElementById: id => els[id] || (els[id] = new El()),
      createElement: t => new El(t),
      createDocumentFragment: () => new El(),
      querySelectorAll: () => [],
      addEventListener(t, f) { (docHandlers[t] = docHandlers[t] || []).push(f); }
    },
    navigator: { language: 'en' }
  };
  ctx.window = ctx; ctx.global = ctx; ctx.self = ctx;
  ctx.addEventListener = () => {}; ctx.removeEventListener = () => {};
  vm.createContext(ctx);

  // Pre-select the <select> default so the game (if it ever reads it) is sane.
  const html = fs.readFileSync(GAME, 'utf8');
  const m = html.match(/<select\b[^>]*\bid="diff"[^>]*>([\s\S]*?)<\/select>/);
  if (m) {
    const opts = [...m[1].matchAll(/<option\b[^>]*\bvalue="([^"]*)"([^>]*)>/g)];
    const picked = opts.find(o => /\bselected\b/.test(o[2])) || opts[0];
    if (picked) ctx.document.getElementById('diff').value = picked[1];
  }

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'assets', 'i18n.js'), 'utf8'), ctx);
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(s => s[1]);
  scripts.forEach((s, i) => vm.runInContext(s, ctx, { filename: `pong#${i}` }));

  // Drive the rAF loop with explicit timestamps (mirrors tetris-test's __pump).
  ctx.__pump = ts => { const f = frame; frame = null; if (f) f(ts); };
  ctx.__fireDoc = (t, ev) => (docHandlers[t] || []).forEach(f => f(ev || {}));
  return ctx;
}

/* ------------------------------------------------------------------ runner -- */

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const g = boot();

// Start a live match through the real entry path so the rAF loop is scheduled,
// then hand control back to the caller. Every physics scenario below relies on
// the loop actually running (a freshly-set state='playing' alone does nothing).
function beginMatch() {
  g.newGame();          // -> ready (no loop)
  g.startGame();        // -> countdown + requestAnimationFrame(loop)
  g.state = 'playing';
  g.serveT = 0;
  g.lastTs = null;
}

console.log('\n[1] constants & difficulty tiers');
check('field is 800x480', g.W === 800 && g.H === 480);
check('win threshold is 7', g.WIN === 7, String(g.WIN));
check('three difficulty tiers exist', !!g.DIFF.easy && !!g.DIFF.normal && !!g.DIFF.hard);
check('serve speed rises with difficulty', g.DIFF.easy.serve < g.DIFF.normal.serve && g.DIFF.normal.serve < g.DIFF.hard.serve);
check('max ball speed rises with difficulty', g.DIFF.easy.max < g.DIFF.normal.max && g.DIFF.normal.max < g.DIFF.hard.max);
check('AI reaction speed rises with difficulty', g.DIFF.easy.aiSpeed < g.DIFF.normal.aiSpeed && g.DIFF.normal.aiSpeed < g.DIFF.hard.aiSpeed);
check('AI aiming error shrinks with difficulty', g.DIFF.easy.aiErr > g.DIFF.normal.aiErr && g.DIFF.normal.aiErr > g.DIFF.hard.aiErr);
check('default difficulty is normal', g.diff === 'normal', String(g.diff));
check('a fresh load sits in the ready state', g.state === 'ready', g.state);
check('the start button is visible on load', g.document.getElementById('btnStart').textContent.length > 0);
check('the pause button is disabled on the start screen', g.document.getElementById('btnPause').disabled === true);

console.log('\n[2] wall bounces');
{
  beginMatch();
  g.ball.x = g.W / 2; g.ball.y = 30; g.ball.vx = 0.3; g.ball.vy = -6; g.ball.trail = [];
  let t = 100000;
  for (let i = 0; i < 8; i++) { t += 16; g.__pump(t); }
  check('ball rises then bounces off the top wall (vy flips up→down)', g.ball.vy > 0, 'vy=' + g.ball.vy.toFixed(2));

  beginMatch();
  g.ball.x = g.W / 2; g.ball.y = g.H - 30; g.ball.vx = 0.3; g.ball.vy = 6; g.ball.trail = [];
  t = 200000;
  for (let i = 0; i < 8; i++) { t += 16; g.__pump(t); }
  check('ball falls then bounces off the bottom wall (vy flips down→up)', g.ball.vy < 0, 'vy=' + g.ball.vy.toFixed(2));

  beginMatch();
  g.ball.x = g.W / 2; g.ball.y = g.H / 2; g.ball.vx = 0.2; g.ball.vy = -5; g.ball.trail = [];
  t = 300000;
  let inBounds = true;
  for (let i = 0; i < 200; i++) { t += 16; g.__pump(t); if (g.ball.y - g.ball.r < -1 || g.ball.y + g.ball.r > g.H + 1) { inBounds = false; break; } }
  check('ball stays inside the vertical field across 200 frames', inBounds);
}

console.log('\n[3] paddle reflection depends on hit position');
{
  // Fire the ball at a given y-offset on the player paddle and read vy.
  function hitPlayer(offsetFrac) {
    beginMatch();
    g.paddleL.y = (g.H - g.paddleL.h) / 2;
    const cy = g.paddleL.y + g.paddleL.h / 2;
    g.ball.x = g.paddleL.x + g.paddleL.w + g.ball.r;
    g.ball.y = cy + offsetFrac * (g.paddleL.h / 2);
    g.ball.vx = -5; g.ball.vy = 0; g.ball.trail = [];
    g.__pump(400000);
    return { vx: g.ball.vx, vy: g.ball.vy };
  }
  const center = hitPlayer(0);
  const edge = hitPlayer(-0.95);
  check('center hit sends the ball nearly flat (small |vy|)', Math.abs(center.vy) < 1.2, 'vy=' + center.vy.toFixed(2));
  check('edge hit sends the ball at a steep angle (large |vy|)', Math.abs(edge.vy) > 4, 'vy=' + edge.vy.toFixed(2));
  check('edge angle is steeper than center angle', Math.abs(edge.vy) > Math.abs(center.vy));
  check('player paddle reflects the ball to the right (vx > 0)', center.vx > 0 && edge.vx > 0);

  beginMatch();
  g.paddleR.y = (g.H - g.paddleR.h) / 2;
  const cyR = g.paddleR.y + g.paddleR.h / 2;
  g.ball.x = g.paddleR.x - g.ball.r;
  g.ball.y = cyR;
  g.ball.vx = 5; g.ball.vy = 0; g.ball.trail = [];
  g.__pump(500000);
  check('CPU paddle reflects the ball to the left (vx < 0)', g.ball.vx < 0, 'vx=' + g.ball.vx.toFixed(2));
}

console.log('\n[4] ball speed is capped');
{
  beginMatch();
  g.diff = 'normal';
  g.paddleL.y = (g.H - g.paddleL.h) / 2;
  const cy = g.paddleL.y + g.paddleL.h / 2;
  // High incoming speed + a steep angle; the cap must engage on the bounce.
  g.ball.x = g.paddleL.x + g.paddleL.w + g.ball.r;
  g.ball.y = cy;
  g.ball.vx = -3; g.ball.vy = 20; g.ball.trail = [];
  g.__pump(600000);
  const speed = Math.sqrt(g.ball.vx * g.ball.vx + g.ball.vy * g.ball.vy);
  check('speed after a bounce never exceeds the tier cap', speed <= g.DIFF.normal.max + 1e-6, 'speed=' + speed.toFixed(2));
}

console.log('\n[5] scoring when the ball leaves the field');
{
  beginMatch();
  g.scoreL = 0; g.scoreR = 0;
  g.ball.x = g.W + 2 * g.ball.r; g.ball.y = g.H / 2; g.ball.vx = 6; g.ball.vy = 0;
  g.__pump(700000);
  check('ball out the right edge awards a point to the player', g.scoreL === 1, 'scoreL=' + g.scoreL);

  beginMatch();
  g.scoreL = 0; g.scoreR = 0;
  g.ball.x = -2 * g.ball.r; g.ball.y = g.H / 2; g.ball.vx = -6; g.ball.vy = 0;
  g.__pump(710000);
  check('ball out the left edge awards a point to the CPU', g.scoreR === 1, 'scoreR=' + g.scoreR);
}

console.log('\n[6] first to 7 wins');
{
  beginMatch();
  g.scoreL = 6; g.scoreR = 0;
  g.ball.x = g.W + 2 * g.ball.r; g.ball.y = g.H / 2; g.ball.vx = 6; g.ball.vy = 0;
  g.__pump(720000);
  check('reaching 7 points ends the match', g.state === 'over', g.state);
  check('the winning score is 7', g.scoreL === 7, 'scoreL=' + g.scoreL);
  check('the winner is recorded as the player', g.winSide === 'L', String(g.winSide));
  check('the win overlay is shown', g.document.getElementById('overlay').classList.contains('hide') === false);
}

console.log('\n[7] serve countdown freezes the ball, then it moves');
{
  g.newGame();
  g.startGame();                 // -> countdown
  check('starting enters the countdown state', g.state === 'countdown', g.state);

  const cx = g.W / 2, cy = g.H / 2;
  let t = 800000;
  for (let i = 0; i < 5; i++) { t += 16; g.__pump(t); }
  const duringX = g.ball.x, duringY = g.ball.y;
  check('ball is parked at center during the countdown', Math.abs(duringX - cx) < 1e-6 && Math.abs(duringY - cy) < 1e-6);
  check('ball has no velocity during the countdown', g.ball.vx === 0 && g.ball.vy === 0);

  for (let i = 0; i < 6; i++) { t += 1000; g.__pump(t); }
  check('after the countdown the ball is moving', Math.abs(g.ball.vx) + Math.abs(g.ball.vy) > 0,
    'v=(' + g.ball.vx.toFixed(2) + ',' + g.ball.vy.toFixed(2) + ')');
  check('after the countdown the ball has left the center', Math.abs(g.ball.x - cx) + Math.abs(g.ball.y - cy) > 0.5);
  check('the match is now playing', g.state === 'playing', g.state);
}

console.log('\n[8] player paddle responds to real keydown events');
{
  g.newGame();
  g.startGame();
  let t = 900000;
  for (let i = 0; i < 20; i++) { t += 1000; g.__pump(t); }   // finish countdown
  const y0 = g.paddleL.y;
  g.__fireDoc('keydown', { key: 'ArrowUp', preventDefault() {} });
  for (let i = 0; i < 6; i++) { t += 16; g.__pump(t); }
  g.__fireDoc('keyup', { key: 'ArrowUp', preventDefault() {} });
  check('holding ↑ moves the player paddle up', g.paddleL.y < y0, y0 + ' -> ' + g.paddleL.y);

  const y1 = g.paddleL.y;
  g.__fireDoc('keydown', { key: 'ArrowDown', preventDefault() {} });
  for (let i = 0; i < 6; i++) { t += 16; g.__pump(t); }
  g.__fireDoc('keyup', { key: 'ArrowDown', preventDefault() {} });
  check('holding ↓ moves the player paddle down', g.paddleL.y > y1, y1 + ' -> ' + g.paddleL.y);

  const y2 = g.paddleL.y;
  g.__fireDoc('keydown', { key: 'w', preventDefault() {} });
  for (let i = 0; i < 4; i++) { t += 16; g.__pump(t); }
  g.__fireDoc('keyup', { key: 'w', preventDefault() {} });
  check('W is an alias for up', g.paddleL.y < y2, y2 + ' -> ' + g.paddleL.y);
}

console.log('\n[9] AI behaviour scales with difficulty');
{
  function trackDist(diffName) {
    g.diff = diffName;          // set BEFORE beginMatch so newServe() uses this tier's error
    beginMatch();
    g.ball.x = g.W / 2; g.ball.y = 120; g.ball.vx = 0.6; g.ball.vy = 0; g.ball.trail = [];
    g.paddleR.y = (g.H - g.paddleR.h) / 2;
    g.serveT = 0;
    let t = 1000000;
    for (let i = 0; i < 30; i++) { t += 16; g.__pump(t); }
    const cy = g.paddleR.y + g.paddleR.h / 2;
    return Math.abs(cy - g.ball.y);
  }
  // Run several trials: the harder AI should track more closely most of the time.
  let hardWins = 0;
  const trials = 8;
  let lastEasy = 0, lastHard = 0;
  for (let n = 0; n < trials; n++) {
    lastEasy = trackDist('easy');
    lastHard = trackDist('hard');
    if (lastHard < lastEasy) hardWins++;
  }
  check('hard AI tracks the ball more closely than easy AI (majority of 8 trials)', hardWins >= 6,
    hardWins + '/' + trials + ' (easy=' + lastEasy.toFixed(1) + ' hard=' + lastHard.toFixed(1) + ')');
  check('AI paddle never leaves the field', g.paddleR.y >= -0.01 && g.paddleR.y + g.paddleR.h <= g.H + 0.01);

  beginMatch();
  g.diff = 'hard';
  g.ball.x = g.W / 2; g.ball.y = 50; g.ball.vx = 1; g.ball.vy = 0;
  let prev = g.paddleR.y, maxStep = 0;
  let t = 1100000;
  for (let i = 0; i < 20; i++) { t += 16; g.__pump(t); maxStep = Math.max(maxStep, Math.abs(g.paddleR.y - prev)); prev = g.paddleR.y; }
  check('AI paddle step never exceeds its per-frame speed budget', maxStep <= g.DIFF.hard.aiSpeed + 1e-6, 'maxStep=' + maxStep.toFixed(2));
}

console.log('\n[10] the real Start button actually enters the match');
{
  g.newGame();
  check('before clicking, state is ready', g.state === 'ready', g.state);
  const startBtn = g.document.getElementById('btnStart');
  startBtn.fire('click', { target: startBtn });
  check('clicking Start leaves the ready state', g.state !== 'ready', g.state);
  check('clicking Start enables the pause button', g.document.getElementById('btnPause').disabled === false);
  let t = 1200000;
  const before = { x: g.ball.x, y: g.ball.y };
  for (let i = 0; i < 40; i++) { t += 100; g.__pump(t); }
  const moved = Math.abs(g.ball.x - before.x) + Math.abs(g.ball.y - before.y);
  check('after clicking Start the ball is in play and moving', moved > 0.5, 'moved=' + moved.toFixed(2));
}

console.log('\n[11] pause / resume');
{
  g.newGame();
  g.startGame();
  let t = 1300000;
  for (let i = 0; i < 20; i++) { t += 1000; g.__pump(t); }   // finish countdown
  g.__fireDoc('keydown', { key: ' ', preventDefault() {} });  // space pauses
  check('space pauses the game', g.state === 'paused', g.state);
  const bx = g.ball.x;
  for (let i = 0; i < 5; i++) { t += 16; g.__pump(t); }
  check('the ball is frozen while paused', g.ball.x === bx, 'x ' + bx + ' -> ' + g.ball.x);
  g.__fireDoc('keydown', { key: ' ', preventDefault() {} });  // space resumes
  check('space resumes the game', g.state === 'playing' || g.state === 'countdown', g.state);
}

/* --------------------------------------- reverse checks: prove the tests bite */
console.log('\n[12] reverse validations (inject a bug, expect the check to fail)');

// 1) If wall bounce were removed, the wall-bounce assertion above would fail.
{
  beginMatch();
  const orig = g.bounceOffWalls;
  g.bounceOffWalls = function () {};
  g.ball.x = g.W / 2; g.ball.y = 30; g.ball.vx = 0.3; g.ball.vy = -6; g.ball.trail = [];
  let t = 1400000;
  for (let i = 0; i < 12; i++) { t += 16; g.__pump(t); }
  const bounced = g.ball.vy > 0;          // the real test expects this to be true
  g.bounceOffWalls = orig;
  check('reverse: removing wall-bounce makes the bounce test report FAIL', bounced === false);
}

// 2) If the win threshold were wrong (99), the win-at-7 test would fail.
{
  beginMatch();
  const orig = g.WIN;
  g.WIN = 99;
  g.scoreL = 6; g.scoreR = 0;
  g.ball.x = g.W + 2 * g.ball.r; g.ball.y = g.H / 2; g.ball.vx = 6; g.ball.vy = 0;
  g.__pump(1500000);
  const wonAtSeven = (g.state === 'over');
  g.WIN = orig;
  check('reverse: a wrong WIN threshold (99) stops the win-at-7 test from firing', wonAtSeven === false);
}

// 3) If scoring were neutralised, the scoring test would fail.
{
  beginMatch();
  const orig = g.point;
  g.point = function () {};
  g.scoreL = 0;
  g.ball.x = g.W + 2 * g.ball.r; g.ball.y = g.H / 2; g.ball.vx = 6; g.ball.vy = 0;
  g.__pump(1600000);
  const scored = (g.scoreL === 1);
  g.point = orig;
  check('reverse: neutralising point() stops the ball-exit scoring test from firing', scored === false);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
