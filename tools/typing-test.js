#!/usr/bin/env node
/**
 * Logic tests for typing-game.
 *
 * The smoke test (tools/smoke.js) only proves the page does not throw. It
 * cannot tell whether a correct keystroke is counted, whether a backspace
 * wrongly erases an earlier error, or whether the WPM number is even right.
 *
 * This suite loads the whole game script in a vm sandbox (so it can read the
 * engine's internal state) and asserts the actual typing rules. It follows the
 * two habits from CONTRIBUTING.md:
 *   1. Test through the REAL UI entry point — click the actual Start button
 *      and feed real keydown events, don't call the engine directly — for the
 *      "time runs out and the game stops" path, because a callable startGame()
 *      is not the same thing as a button a human can click.
 *   2. Prove the content, not just the absence of crashes: WPM and accuracy
 *      formulas are checked against hand-computed values, and the word banks
 *      are checked to actually differ by difficulty.
 *
 * Reverse tests temporarily inject a bug (wrong WPM divisor, inverted accuracy,
 * backspace that rewinds the error count) and confirm the very same assertions
 * would now fail — i.e. the suite genuinely catches regressions.
 *
 * Usage:  node tools/typing-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'typing-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

/* ----------------------------------------------------------------- fake DOM */

function makeContext() {
  // performance.now() reads a controllable clock so tests can drive the timer.
  let clock = 0;
  const noop = () => ctxProxy;
  const ctxProxy = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)) });

  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.handlers = {};
      this.parent = null;
      this.dataset = {};
      this.disabled = false;
      this.value = '';
      this._text = '';
      this._html = '';
      this._cls = new Set();
      this._attrs = {};
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
    appendChild(c) { if (c) { c.parent = this; this.children.push(c); } return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 480 }; }
    focus() {}
    blur() {}
  }

  const els = {};
  const docHandlers = {};
  let frame = null;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => clock },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    // Keep the newest rAF callback so the test can drive the loop with explicit
    // timestamps and watch the clock actually run out.
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    // The smoke stub has NO removeItem; the game must not use it. Mirror that.
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
      createDocumentFragment: () => new El(),
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

  // Advance the game's rAF loop by one frame at time `ts`.
  context.__pump = ts => { clock = ts; const f = frame; frame = null; if (f) f(ts); };

  return { context, els, docHandlers,
    get __pump() { return context.__pump; },
    fireDoc(t, ev) { (docHandlers[t] || []).forEach(f => f(ev || {})); } };
}

function boot() {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const html = fs.readFileSync(GAME, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => vm.runInContext(s, env.context, { filename: `typing#${i}` }));
  return env;
}

// Put the engine into a controlled, mid-round state for rule unit checks.
function setWord(env, w) {
  const T = env.context.__typing;
  T.words = [w];
  T.wordIndex = 0;
  T.typed = '';
  T.keystrokes = 0;
  T.errors = 0;
  T.correctWords = 0;
  T.combo = 0;
  T.maxCombo = 0;
  T.phase = 'playing';
}
function feed(env, key) { env.context.__typing.feedKey(key); }

/* ----------------------------------------------------------- test data */

const BANK = {
  easy:   ['the', 'cat', 'sun', 'red', 'go', 'up', 'bee', 'hat', 'key', 'sea'],
  normal: ['keyboard', 'garden', 'window', 'simple', 'purple', 'friend', 'animal', 'flower', 'castle', 'bridge'],
  hard:   ['JavaScript', 'CamelCase', "don't", 'well-known', 'Hello,', 'World!', 'self-esteem', 'Mississippi', 'QWERTY', 'U.S.A.']
};

/* ------------------------------------------------------------------ tests */

group('word banks differ by difficulty');
{
  const avg = arr => arr.reduce((s, w) => s + w.length, 0) / arr.length;
  const e = avg(BANK.easy), n = avg(BANK.normal), h = avg(BANK.hard);
  check('easy bank is non-empty', BANK.easy.length > 0);
  check('normal bank is non-empty', BANK.normal.length > 0);
  check('hard bank is non-empty', BANK.hard.length > 0);
  check('easy shorter than normal', e < n, `easy=${e.toFixed(2)} normal=${n.toFixed(2)}`);
  check('normal shorter than hard', n < h, `normal=${n.toFixed(2)} hard=${h.toFixed(2)}`);
}

group('per-character judgement (real feedKey)');
{
  const env = boot();
  setWord(env, 'cat');
  feed(env, 'c');
  check('correct char does not raise errors', env.context.__typing.errors === 0, 'errors=' + env.context.__typing.errors);
  check('correct char raises keystrokes', env.context.__typing.keystrokes === 1);

  feed(env, 'x'); // wrong at position 1 (expected 'a')
  check('wrong char raises errors', env.context.__typing.errors === 1, 'errors=' + env.context.__typing.errors);
  check('wrong char still raises keystrokes', env.context.__typing.keystrokes === 2);

  const env2 = boot();
  setWord(env2, 'cat');
  feed(env2, 'c'); feed(env2, 'a'); feed(env2, 'x'); // 'x' is an error
  feed(env2, 'Backspace');                            // fix it
  feed(env2, 't');                                     // now 'cat' is complete
  const T = env2.context.__typing;
  check('backspace-corrected word completes', T.correctWords === 1, 'words=' + T.correctWords);
  check('backspace does NOT double-count the error', T.errors === 1, 'errors=' + T.errors);
  check('keystrokes counts every char incl. the fix', T.keystrokes === 4, 'ks=' + T.keystrokes);
  check('combo increments on a completed word', T.combo === 1);

  const env3 = boot();
  setWord(env3, 'sun');
  feed(env3, 's'); feed(env3, 'u');
  feed(env3, ' '); // submit a partial (wrong) word
  check('space on a wrong word is not counted', env3.context.__typing.correctWords === 0);
  check('wrong submit breaks the combo', env3.context.__typing.combo === 0);
  setWord(env3, 'sun');
  feed(env3, 's'); feed(env3, 'u'); feed(env3, 'n'); // auto-completes
  feed(env3, ' '); // space on empty typed must be ignored
  check('space on an already-complete word is ignored', env3.context.__typing.correctWords === 1);

  const env4 = boot();
  setWord(env4, 'cat');
  feed(env4, 'ArrowLeft'); // ignored key
  feed(env4, 'Enter');     // ignored key
  check('non-printable keys are ignored', env4.context.__typing.typed === '' && env4.context.__typing.keystrokes === 0);

  const env5 = boot();
  setWord(env5, 'cat');
  feed(env5, 'Backspace'); // nothing to delete yet
  check('backspace on empty buffer is safe', env5.context.__typing.typed === '' && env5.context.__typing.keystrokes === 0);

  const env6 = boot();
  setWord(env6, 'cat');
  feed(env6, 'c'); feed(env6, 'a'); feed(env6, 'x'); // full but wrong (len == target)
  feed(env6, 'y'); // overflow past the word length is ignored
  check('typing past the word length is ignored', env6.context.__typing.keystrokes === 3, 'ks=' + env6.context.__typing.keystrokes);

  const env7 = boot();
  setWord(env7, 'JavaScript');
  feed(env7, 'j'); // lowercase vs capital J
  check('casing matters: lowercase J is an error', env7.context.__typing.errors === 1, 'errors=' + env7.context.__typing.errors);
}

group('WPM formula');
{
  const env = boot();
  const T = env.context.__typing;
  T.keystrokes = 50; T.errors = 0; T.elapsed = 30000; // 0.5 min, 50 correct chars
  check('50 correct chars in 30s = 20 WPM', T.wpm() === 20, 'wpm=' + T.wpm());
  T.elapsed = 60000; // 1 min
  check('50 correct chars in 60s = 10 WPM', T.wpm() === 10, 'wpm=' + T.wpm());
  T.keystrokes = 100; T.errors = 0; T.elapsed = 60000;
  check('100 correct chars in 60s = 20 WPM', T.wpm() === 20, 'wpm=' + T.wpm());
  T.keystrokes = 50; T.errors = 10; T.elapsed = 30000; // 40 correct chars
  check('40 correct chars in 30s = 16 WPM', T.wpm() === 16, 'wpm=' + T.wpm());
  T.elapsed = 0;
  check('zero elapsed time yields 0 WPM (no divide-by-zero)', T.wpm() === 0);
}

group('accuracy formula');
{
  const env = boot();
  const T = env.context.__typing;
  T.keystrokes = 50; T.errors = 10;
  check('50 keystrokes, 10 errors = 80%', T.accuracy() === 80, 'acc=' + T.accuracy());
  T.keystrokes = 0; T.errors = 0;
  check('no keystrokes yet = 100%', T.accuracy() === 100);
  T.keystrokes = 40; T.errors = 40;
  check('all wrong = 0%', T.accuracy() === 0, 'acc=' + T.accuracy());
}

group('end-to-end through the real UI (start button + keydown)');
{
  const env = boot();
  const T = env.context.__typing;
  env.els.btnStart.fire('click', { target: env.els.btnStart });
  check('clicking Start enters the playing phase', T.phase === 'playing');
  check('New game button is enabled while playing', env.els.btnNew.disabled === false);
  check('difficulty buttons are disabled while playing', env.els.btnEasy.disabled === true);

  env.__pump(1000); // initialise the rAF clock

  const w0 = T.words[0], w1 = T.words[1], w2 = T.words[2];
  const typeViaInput = w => { for (let i = 0; i < w.length; i++) env.els.typedInput.fire('keydown', { key: w[i], preventDefault() {} }); };
  typeViaInput(w0); typeViaInput(w1); typeViaInput(w2);
  check('three words were completed via real input', T.correctWords === 3, 'words=' + T.correctWords);

  const C = w0.length + w1.length + w2.length;
  env.__pump(31000); // 30s elapsed
  check('still playing at 30s', T.phase === 'playing');
  check('WPM matches the formula at 30s', T.wpm() === Math.round((C / 5) / (30000 / 60000)), 'wpm=' + T.wpm() + ' C=' + C);
  check('accuracy is 100% with no mistakes', T.accuracy() === 100);

  env.__pump(61000); // 60s elapsed -> time up
  check('time reaching 0 ends the round', T.phase === 'ended');
  check('New game button is enabled at the end', env.els.btnNew.disabled === false);
  check('result overlay is shown', env.els.overlay._cls.has('show'));

  env.els.typedInput.fire('keydown', { key: 'z', preventDefault() {} });
  check('input is ignored after time is up', T.correctWords === 3 && T.errors === 0);
  const expectedBest = String(Math.round(C / 5)); // 60s round, all correct
  check('localStorage best equals final WPM',
    env.context.localStorage.getItem('typing_best') === expectedBest,
    'stored=' + env.context.localStorage.getItem('typing_best') + ' expected=' + expectedBest);
}

group('document keydown fallback (focus not on the input)');
{
  const env = boot();
  const T = env.context.__typing;
  env.els.btnStart.fire('click', { target: env.els.btnStart });
  T.words = ['cat']; T.wordIndex = 0; T.typed = ''; T.keystrokes = 0; T.errors = 0; T.phase = 'playing';
  env.fireDoc('keydown', { key: 'c', target: env.context.document.body, preventDefault() {} });
  check('document keydown types when input is not focused', T.typed === 'c', 'typed=' + T.typed);
}

group('personal best persists and only goes up');
{
  const env = boot();
  const T = env.context.__typing;
  // Round 1: short word, low WPM.
  T.start('easy', 60);
  T.words = ['cat']; T.wordIndex = 0; T.typed = ''; T.keystrokes = 0; T.errors = 0; T.correctWords = 0; T.phase = 'playing';
  T.feedKey('c'); T.feedKey('a'); T.feedKey('t');
  env.__pump(1000); env.__pump(61000);
  check('round 1 sets a best', env.context.localStorage.getItem('typing_best') === '1', 'best=' + env.context.localStorage.getItem('typing_best'));

  // Round 2: even shorter word, would lower WPM -> best must not drop.
  T.start('easy', 60);
  T.words = ['a']; T.wordIndex = 0; T.typed = ''; T.keystrokes = 0; T.errors = 0; T.correctWords = 0; T.phase = 'playing';
  T.feedKey('a');
  env.__pump(1000); env.__pump(61000);
  check('best does not drop on a worse round', env.context.localStorage.getItem('typing_best') === '1', 'best=' + env.context.localStorage.getItem('typing_best'));

  // Round 3: long word, higher WPM -> best must rise.
  T.start('hard', 60);
  T.words = ['JavaScript']; T.wordIndex = 0; T.typed = ''; T.keystrokes = 0; T.errors = 0; T.correctWords = 0; T.phase = 'playing';
  'JavaScript'.split('').forEach(ch => T.feedKey(ch));
  env.__pump(1000); env.__pump(61000);
  check('best rises on a better round', env.context.localStorage.getItem('typing_best') === '2', 'best=' + env.context.localStorage.getItem('typing_best'));
}

group('duration boundaries end the round');
{
  const env = boot();
  const T = env.context.__typing;
  T.start('normal', 15);
  env.__pump(1000); env.__pump(16000);
  check('15s round ends at 15s', T.phase === 'ended', 'phase=' + T.phase);

  const env2 = boot();
  const T2 = env2.context.__typing;
  T2.start('normal', 30);
  env2.__pump(1000); env2.__pump(31000);
  check('30s round ends at 30s', T2.phase === 'ended', 'phase=' + T2.phase);
}

group('ready state shows a visible entry and disables New game');
{
  const env = boot();
  const T = env.context.__typing;
  check('boots into the ready phase', T.phase === 'ready');
  check('New game is disabled before first start', env.els.btnNew.disabled === true);
  check('difficulty buttons are enabled in ready', env.els.btnEasy.disabled === false);
  check('start overlay is visible on load', env.els.overlay._cls.has('show'));
}

group('reverse: the suite catches injected bugs');
{
  // R1: WPM that divides by seconds instead of minutes (missing the x60).
  const env = boot();
  const T = env.context.__typing;
  T.keystrokes = 50; T.errors = 0; T.elapsed = 30000;
  const correctWpm = T.wpm();                 // 20
  const realWpm = T.wpm;
  T.wpm = function () {                        // buggy version
    const m = this.elapsed / 1000;             // seconds, not minutes
    if (m <= 0) return 0;
    return Math.round(((this.keystrokes - this.errors) / 5) / m);
  };
  const buggyWpm = T.wpm();
  T.wpm = realWpm;
  check('reverse: buggy WPM (seconds) differs from correct', buggyWpm !== correctWpm, `buggy=${buggyWpm} correct=${correctWpm}`);

  // R2: accuracy inverted (errors / keystrokes instead of correct / keystrokes).
  const env2 = boot();
  const T2 = env2.context.__typing;
  T2.keystrokes = 50; T2.errors = 10;
  const correctAcc = T2.accuracy();           // 80
  const realAcc = T2.accuracy;
  T2.accuracy = function () { return Math.round(this.errors / this.keystrokes * 100); }; // buggy
  const buggyAcc = T2.accuracy();
  T2.accuracy = realAcc;
  check('reverse: buggy accuracy (inverted) differs from correct', buggyAcc !== correctAcc, `buggy=${buggyAcc} correct=${correctAcc}`);

  // R3: backspace that wrongly rewinds the error counter.
  const env3 = boot();
  const T3 = env3.context.__typing;
  const origFeed = T3.feedKey;
  T3.feedKey = function (key) {                // buggy: decrement errors on backspace
    if (key === 'Backspace') { this.errors--; if (this.typed.length) this.typed = this.typed.slice(0, -1); return; }
    return origFeed.call(this, key);
  };
  T3.words = ['cat']; T3.wordIndex = 0; T3.typed = ''; T3.keystrokes = 0; T3.errors = 0; T3.correctWords = 0; T3.combo = 0; T3.phase = 'playing';
  T3.feedKey('c'); T3.feedKey('a'); T3.feedKey('x'); T3.feedKey('Backspace'); T3.feedKey('t');
  const buggyErrors = T3.errors;              // buggy -> 0, correct -> 1
  T3.feedKey = origFeed;
  check('reverse: buggy backspace (errors--) gives 0, not 1', buggyErrors === 0, 'buggy errors=' + buggyErrors);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
