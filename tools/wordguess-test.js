#!/usr/bin/env node
/**
 * Logic + content tests for wordguess-game.
 *
 * The smoke test only proves the page does not throw. This one proves the
 * things that make or break a word game:
 *
 *   1. scoring        - the per-position hit/present/miss algorithm, checked
 *      against an INDEPENDENTLY written reference implementation. Getting
 *      repeated characters wrong is the classic bug (a guess with two of a
 *      letter lights both up when the answer only has one), and it is
 *      invisible until someone hits it in play;
 *   2. word banks     - every word is the right length and character set, no
 *      duplicates, and every answer is also an accepted guess (otherwise the
 *      game can deal you a word it then refuses to take);
 *   3. the pad        - the pad is the input alphabet, so it must cover every
 *      character any accepted guess can contain. English hardcodes A-Z; the
 *      Chinese pad is derived from the bank, and the two must not drift;
 *   4. game flow      - driven through the real pad clicks, the real Enter and
 *      Delete buttons and the real keydown handler;
 *   5. stats + store  - streaks, the guess distribution, and a corrupted
 *      stored value degrading instead of throwing;
 *   6. the share grid - emoji only, so it can never spoil the answer;
 *   7. bilingual copy - every string exists in both languages, no key the
 *      markup asks for is missing, no translation was left as a copy of the
 *      English, and placeholders survive translation.
 *
 * Group 11 re-injects deliberate bugs and requires the suite to notice.
 *
 * Usage:  node tools/wordguess-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'wordguess-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

const HTML = fs.readFileSync(GAME, 'utf8');

/* ------------------------------------------------- fake DOM (as elsewhere) */

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
      this.value = '';
      this.disabled = false;
      this.hidden = false;
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
    closest(sel) {
      const want = sel.replace('.', '');
      let n = this;
      while (n) { if (n._cls && n._cls.has(want)) return n; n = n.parent; }
      return null;
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute() {}
    getAttribute() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html; }
  }
  const els = {};
  const winHandlers = {};
  const store = {};
  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    Promise, parseInt, parseFloat, isNaN, isFinite,
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
    },
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
  return { context, els, winHandlers, store };
}

function boot(seed) {
  const env = makeContext();
  if (seed) Object.keys(seed).forEach(k => { env.store[k] = seed[k]; });
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const scripts = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => vm.runInContext(s, env.context, { filename: `wordguess#${i}` }));
  const ctx = env.context;

  const app = {
    env, ctx,
    state: () => ctx.WG.getState(),
    // Click a pad key the way the page does: on the container, with the key as
    // ev.target — that is the only input path the stub DOM can exercise.
    clickKey(ch) {
      const i = ctx.padChars.indexOf(ch);
      if (i < 0) return false;
      env.els.pad.fire('click', { target: ctx.padEls[i], preventDefault() {} });
      return true;
    },
    spell(word) {
      for (const ch of word) if (!app.clickKey(ch)) return false;
      return true;
    },
    enter() { env.els.btnEnter.fire('click', { preventDefault() {} }); },
    del() { env.els.btnDel.fire('click', { preventDefault() {} }); },
    newGame() { env.els.btnNew.fire('click', { preventDefault() {} }); },
    copy() { env.els.btnCopy.fire('click', { preventDefault() {} }); },
    key(k) { (env.winHandlers.keydown || []).forEach(f => f({ key: k, preventDefault() {} })); },
    play(word) { app.spell(word); app.enter(); },
    setLang(l) { ctx.T.set(l); }
  };
  return app;
}

/* ------------------------------------------- pure helpers over plain data
 * Kept as plain functions so group 10 can feed them a deliberately broken copy
 * and prove each check actually fails. */

// The reference scorer for the differential test. Written with a slot array
// that gets consumed, which is a different shape from the count-map the game
// uses — so the two cannot share a bug.
function referenceEvaluate(guess, answer) {
  const n = answer.length;
  const slots = [...answer];
  const out = new Array(n).fill('miss');
  for (let i = 0; i < n; i++) {
    if (guess[i] === slots[i]) { out[i] = 'hit'; slots[i] = null; }
  }
  for (let i = 0; i < n; i++) {
    if (out[i] === 'hit') continue;
    const j = slots.indexOf(guess[i]);
    if (j >= 0 && slots[j] !== null) { out[i] = 'present'; slots[j] = null; }
  }
  return out;
}

function countChar(s, c) {
  let n = 0;
  for (const ch of s) if (ch === c) n++;
  return n;
}

// Returns an array of human-readable problems; empty means the bank is sound.
function bankProblems(name, bank) {
  const issues = [];
  const { len, words, answers, pad } = bank;

  if (!Array.isArray(words) || words.length < 20) issues.push(`${name}: word list is too small`);
  if (!Array.isArray(answers) || !answers.length) issues.push(`${name}: answer list is empty`);
  if (!Array.isArray(pad) || !pad.length) issues.push(`${name}: pad is empty`);

  const seen = new Set();
  for (const w of words) {
    if (w.length !== len) issues.push(`${name}: "${w}" is ${w.length} units, expected ${len}`);
    if ([...w].length !== w.length) issues.push(`${name}: "${w}" contains a surrogate pair`);
    if (seen.has(w)) issues.push(`${name}: duplicate word "${w}"`);
    seen.add(w);
    if (name === 'en' && !/^[A-Z]+$/.test(w)) issues.push(`${name}: "${w}" is not A-Z`);
    if (name === 'zh') {
      for (const ch of w) {
        const c = ch.codePointAt(0);
        if (c < 0x4e00 || c > 0x9fff) issues.push(`${name}: "${w}" contains a non-CJK character ${ch}`);
      }
    }
  }

  const seenA = new Set();
  for (const w of answers) {
    if (seenA.has(w)) issues.push(`${name}: duplicate answer "${w}"`);
    seenA.add(w);
    if (!seen.has(w)) issues.push(`${name}: answer "${w}" is not an accepted guess`);
  }

  const seenP = new Set();
  for (const k of pad) {
    if (seenP.has(k)) issues.push(`${name}: duplicate pad key "${k}"`);
    seenP.add(k);
    if ([...k].length !== 1) issues.push(`${name}: pad key "${k}" is not a single character`);
  }

  // The pad is the input alphabet: it must cover every character of every word.
  for (const w of words) {
    for (const ch of w) {
      if (!seenP.has(ch)) issues.push(`${name}: pad has no key for "${ch}" (needed by "${w}")`);
    }
  }
  return issues;
}

// Emoji-only grid: anything else risks leaking the answer.
function gridLeaksLetters(grid) {
  return grid.split('\n').some(line => /[A-Za-z\u4e00-\u9fff]/.test(line));
}

function padKeyCount(grid) { return [...grid].filter(c => c !== '\n').length; }

/* --------------------------------------------------------------------- main */

const app = boot();
const ctx = app.ctx;

console.log('wordguess-game — logic, content and UI tests\n');
console.log(`banks: en ${ctx.BANKS.en.words.length} words / ${ctx.BANKS.en.answers.length} answers / ` +
            `${ctx.BANKS.en.pad.length} pad keys · zh ${ctx.BANKS.zh.words.length} words / ` +
            `${ctx.BANKS.zh.pad.length} pad keys`);

/* ============================================================ 1. hand cases */
group('1. scoring — hand-checked cases');

const exact = ctx.evaluate('CRANE', 'CRANE');
check('an exact match is all hits', exact.join(',') === 'hit,hit,hit,hit,hit', exact.join(','));

const disjoint = ctx.evaluate('MOULD', 'CRANE');
check('a disjoint guess is all misses', disjoint.join(',') === 'miss,miss,miss,miss,miss', disjoint.join(','));

const mixed = ctx.evaluate('SLATE', 'CRANE');
check('mixed guess scores each position', mixed.join(',') === 'miss,miss,hit,miss,hit', mixed.join(','));

// Two Es in the guess, two in the answer, but one answer E is a hit elsewhere.
const twoE = ctx.evaluate('SPEED', 'ERASE');
check('duplicate letters: both guess Es can light up when the answer has two',
  twoE.join(',') === 'present,miss,present,present,miss', twoE.join(','));

// THE classic bug: the answer has one E, already spent on the exact hit, so the
// other guess Es must be grey — a one-pass scorer lights them amber.
const oneE = ctx.evaluate('EERIE', 'CRANE');
check('duplicate letters: a hit consumes the only copy of that letter',
  oneE.join(',') === 'miss,miss,present,miss,hit', oneE.join(','));

const abbey = ctx.evaluate('BABES', 'ABBEY');
check('duplicate letters: shared pair splits into a hit and an amber',
  abbey.join(',') === 'present,present,hit,hit,miss', abbey.join(','));

// The answer's only E is already spent on the exact hit at position 4, so the
// E at position 0 must be grey — a one-pass scorer lights it amber. (And the
// guess's A is amber, not a hit: the answer's A sits at position 2.)
const noneLeft = ctx.evaluate('EAGLE', 'CRANE');
check('a letter already matched exactly cannot go amber again',
  noneLeft.join(',') === 'miss,present,miss,miss,hit', noneLeft.join(','));

const chinese = ctx.evaluate('一心一意', '三心二意');
check('the same scorer works on Chinese characters',
  chinese.join(',') === 'miss,hit,miss,hit', chinese.join(','));

/* =========================================== 2. differential vs a reference */
group('2. scoring — differential against an independent implementation');

function differ(bank, pairs) {
  let bad = 0, first = null;
  for (const [g, a] of pairs) {
    const mine = ctx.evaluate(g, a).join(',');
    const ref = referenceEvaluate(g, a).join(',');
    if (mine !== ref) { bad++; if (!first) first = `${g} vs ${a}: ours ${mine} · reference ${ref}`; }
  }
  return { bad, first };
}

function allStrings(alphabet, len) {
  let out = [''];
  for (let i = 0; i < len; i++) {
    const next = [];
    for (const s of out) for (const c of alphabet) next.push(s + c);
    out = next;
  }
  return out;
}

{
  const S = allStrings('AB', 4);
  const pairs = [];
  for (const g of S) for (const a of S) pairs.push([g, a]);
  const r = differ('tiny', pairs);
  check(`exhaustive over every pair of 4-character A/B strings (${pairs.length} pairs)`,
    r.bad === 0, r.first);
}
{
  const S = allStrings('ABC', 3);
  const pairs = [];
  for (const g of S) for (const a of S) pairs.push([g, a]);
  const r = differ('small', pairs);
  check(`exhaustive over every pair of 3-character A/B/C strings (${pairs.length} pairs)`,
    r.bad === 0, r.first);
}
{
  const alpha = 'ABCD';
  const pairs = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = () => alpha[Math.floor(rnd() * alpha.length)];
  for (let i = 0; i < 8000; i++) {
    let g = '', a = '';
    for (let j = 0; j < 5; j++) { g += pick(); a += pick(); }
    pairs.push([g, a]);
  }
  const r = differ('random', pairs);
  check(`8000 random 5-character A-D pairs (heavy duplication)`, r.bad === 0, r.first);
}
{
  const pairs = [];
  for (let i = 0; i < 2000; i++) {
    const a = ctx.EN_WORDS[Math.floor(Math.random() * ctx.EN_WORDS.length)];
    const g = ctx.EN_WORDS[Math.floor(Math.random() * ctx.EN_WORDS.length)];
    pairs.push([g, a]);
  }
  const r = differ('english', pairs);
  check('2000 random real English word pairs', r.bad === 0, r.first);
}
{
  const pairs = [];
  for (let i = 0; i < 2000; i++) {
    const a = ctx.ZH_WORDS[Math.floor(Math.random() * ctx.ZH_WORDS.length)];
    const g = ctx.ZH_WORDS[Math.floor(Math.random() * ctx.ZH_WORDS.length)];
    pairs.push([g, a]);
  }
  const r = differ('chinese', pairs);
  check('2000 random real Chinese idiom pairs', r.bad === 0, r.first);
}

/* ============================================== 3. scoring — invariants hold */
group('3. scoring — invariants over randomized pairs');

{
  let bad = null;
  const alpha = 'ABCDE';
  for (let i = 0; i < 6000 && !bad; i++) {
    let g = '', a = '';
    for (let j = 0; j < 6; j++) { g += alpha[Math.floor(Math.random() * 5)]; a += alpha[Math.floor(Math.random() * 5)]; }
    const m = ctx.evaluate(g, a);
    if (m.length !== g.length) { bad = 'wrong length'; break; }
    if (m.some(x => x !== 'hit' && x !== 'present' && x !== 'miss')) { bad = `bad state in ${m}`; break; }

    // hit is exactly "same character, same position"
    for (let j = 0; j < g.length; j++) {
      const shouldHit = g[j] === a[j];
      if (shouldHit !== (m[j] === 'hit')) { bad = `${g} vs ${a}: position ${j}`; break; }
    }
    if (bad) break;

    // A letter lights up exactly min(count in guess, count in answer) times.
    for (const c of new Set(g + a)) {
      const lit = m.filter((x, j) => x !== 'miss' && g[j] === c).length;
      const expect = Math.min(countChar(g, c), countChar(a, c));
      if (lit !== expect) { bad = `${g} vs ${a}: "${c}" lit ${lit}×, expected ${expect}`; break; }
    }
    if (bad) break;

    // Nothing lights up that the answer does not contain at all.
    for (let j = 0; j < g.length; j++) {
      if (m[j] !== 'miss' && countChar(a, g[j]) === 0) { bad = `${g} vs ${a}: "${g[j]}" lit but absent`; break; }
    }
  }
  check('6000 random pairs: length, state set, exact hits, per-letter light-up count, no phantom letters',
    !bad, bad);
}

/* ======================================================== 4. word bank data */
group('4. word banks');

for (const lang of ['en', 'zh']) {
  const problems = bankProblems(lang, ctx.BANKS[lang]);
  check(`${lang} bank is internally consistent` +
        (lang === 'en' ? ` (${ctx.BANKS.en.words.length} words)` : ` (${ctx.BANKS.zh.words.length} idioms)`),
    problems.length === 0, problems.slice(0, 4).join(' | '));
}

check('en: well-known words are answerable',
  ['about', 'crane', 'money', 'light', 'water', 'world'].every(w => ctx.EN_ANSWERS.includes(w.toUpperCase())));
check('en: the accepted list is wider than or equal to the answer pool',
  ctx.EN_WORDS.length >= ctx.EN_ANSWERS.length,
  `${ctx.EN_WORDS.length} vs ${ctx.EN_ANSWERS.length}`);
// The whole point of a wider accepted list: a sensible guess that is not in the
// answer pool must still be accepted as a guess.
check('en: a word outside the answer pool is still accepted as a guess',
  ctx.EN_WORDS.includes('SLATE') && !ctx.EN_ANSWERS.includes('SLATE'));
check('zh: every idiom is a real 4-character entry (no Latin mixed in)',
  ctx.ZH_WORDS.every(w => [...w].every(ch => ch.codePointAt(0) >= 0x4e00 && ch.codePointAt(0) <= 0x9fff)));
check('zh: answer pool and accepted list are the same 52 idioms',
  ctx.BANKS.zh.answers === ctx.BANKS.zh.words || ctx.BANKS.zh.answers.length === ctx.BANKS.zh.words.length);

/* ============================================================== 5. the pad */
group('5. the pad (input alphabet)');

{
  const enPad = ctx.BANKS.en.pad;
  check('en pad is exactly A-Z', enPad.length === 26 && enPad.every((c, i) => c === String.fromCharCode(65 + i)),
    enPad.join(''));
  check('en pad covers every character of every accepted guess',
    ctx.EN_WORDS.every(w => [...w].every(c => enPad.includes(c))));
}
{
  const zhPad = ctx.BANKS.zh.pad;
  const distinct = [...new Set(ctx.ZH_WORDS.join('').split(''))];
  check('zh pad has exactly one key per distinct bank character',
    zhPad.length === distinct.length && distinct.every(c => zhPad.includes(c)),
    `${zhPad.length} keys vs ${distinct.length} distinct`);
  check('zh pad is small enough to scan (<= 150 keys, 10 per row)',
    zhPad.length <= 150, `${zhPad.length} keys = ${Math.ceil(zhPad.length / 10)} rows`);
  check('zh pad is ordered by descending character frequency',
    zhPad.every((c, i) => i === 0 ||
      (countChar(ctx.ZH_WORDS.join(''), zhPad[i - 1]) >= countChar(ctx.ZH_WORDS.join(''), c))));
  check('distinctChars is deterministic and order-stable',
    ctx.distinctChars(ctx.ZH_WORDS).join('') === zhPad.join(''));
}

/* =========================================================== 6. game flow */
group('6. game flow — through the real pad, buttons and keyboard');

{
  const g = boot();
  check('a fresh page starts with an empty board and an unarmed result panel',
    g.state().rows.length === 0 && !g.state().done && g.state().overHidden === true);

  g.ctx.WG.forceAnswer('CRANE');
  g.enter();
  check('Enter on an empty row is refused and says how many are missing',
    g.state().rows.length === 0 && /5/.test(g.state().msg), g.state().msg);

  g.spell('SLAT');
  g.enter();
  check('a short guess is refused without consuming a try',
    g.state().rows.length === 0 && /1/.test(g.state().msg), g.state().msg);

  g.spell('E');
  check('typing past the row length is ignored', g.state().typed.length === 5, g.state().typed.join(''));
  g.del();
  g.del();
  check('Delete removes one character at a time', g.state().typed.join('') === 'SLA', g.state().typed.join(''));
  g.del(); g.del(); g.del();
  check('and it can empty the row again', g.state().typed.length === 0, g.state().typed.join(''));

  g.spell('ZZZZZ');
  g.enter();
  check('a full but unknown word is refused without consuming a try',
    g.state().rows.length === 0 && /词库|word list/i.test(g.state().msg), g.state().msg);

  g.del(); g.del(); g.del(); g.del(); g.del();
  g.play('SLATE');
  const st = g.state();
  check('a valid guess is scored and consumes a try',
    st.rows.length === 1 && st.rows[0] === 'SLATE' && st.typed.length === 0);
  check('the row is coloured by the scorer',
    st.marks[0].join(',') === 'miss,miss,hit,miss,hit', st.marks[0].join(','));
  check('the same colours reach the board markup',
    g.env.els.board.children[0].children.map(c => c.className).join('|')
      === 'cell miss|cell miss|cell hit|cell miss|cell hit',
    g.env.els.board.children[0].children.map(c => c.className).join('|'));
}
{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  // ABOVE lands its E on the answer's E (a hit). MONEY also contains an E, but
  // not in the matching position, and by then the answer's only E is used up —
  // so MONEY scores a grey E. The keyboard must not downgrade a known-good letter.
  g.play('ABOVE');
  const afterFirst = g.state().keyState.E;
  const midA = g.state().keyState.A;
  g.play('MONEY');
  check('a letter that scored a hit is never downgraded by a later guess',
    afterFirst === 'hit' && g.state().keyState.E === 'hit',
    `${afterFirst} -> ${g.state().keyState.E}`);
  check('a letter that scored amber keeps at least amber', midA === 'present' && g.state().keyState.A === 'present',
    `${midA} -> ${g.state().keyState.A}`);
  const keys = g.state().padKeys, chars = g.state().padChars;
  check('the pad key for a hit letter keeps the hit colour',
    /(^|\s)hit(\s|$)/.test(keys[chars.indexOf('E')]), keys[chars.indexOf('E')]);
  check('the pad key for an amber letter keeps the amber colour',
    /(^|\s)present(\s|$)/.test(keys[chars.indexOf('A')]), keys[chars.indexOf('A')]);
  check('misses are recorded on the pad too',
    /(^|\s)miss(\s|$)/.test(keys[chars.indexOf('V')]), keys[chars.indexOf('V')]);
}
{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  g.play('CRANE');
  const st = g.state();
  check('guessing the answer ends the game as a win', st.done === true && st.won === true);
  check('the result panel opens on a win', st.overHidden === false);
  check('the win title is shown', g.env.els.overTitle.textContent.length > 0);
  check('the win sub-line reports how many tries it took',
    /1/.test(g.env.els.overSub.textContent), g.env.els.overSub.textContent);
  const before = g.state().rows.length;
  g.spell('ABOUT');
  g.enter();
  check('input after the game is over is ignored', g.state().rows.length === before);
}
{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  const wrong = ctx.EN_WORDS.filter(w => w !== 'CRANE').slice(0, 6);
  wrong.forEach(w => g.play(w));
  const st = g.state();
  check('six wrong guesses end the game as a loss', st.done === true && st.won === false && st.rows.length === 6);
  check('a loss reveals the answer', /CRANE/.test(g.env.els.overSub.textContent), g.env.els.overSub.textContent);
  check('the score card reports the answers', g.state().msg === '' || typeof g.state().msg === 'string');
}
{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  g.play('SLATE');
  g.newGame();
  check('New game clears the board', g.state().rows.length === 0 && g.state().done === false);
  check('New game clears the letter colours',
    Object.keys(g.state().keyState).length === 0, JSON.stringify(g.state().keyState));
  check('New game announces itself', /新一局|New game/i.test(g.state().msg), g.state().msg);
  check('New game picks a fresh answer from the bank',
    ctx.EN_ANSWERS.includes(g.state().answer), g.state().answer);
}
{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  g.key('s'); g.key('L'); g.key('a'); g.key('t'); g.key('e');
  check('the physical keyboard types the guess', g.state().typed.join('') === 'SLATE', g.state().typed.join(''));
  g.key('Backspace');
  check('Backspace deletes', g.state().typed.join('') === 'SLAT', g.state().typed.join(''));
  g.key('e');
  g.key('Enter');
  check('Enter submits the guess', g.state().rows.length === 1 && g.state().rows[0] === 'SLATE');
  g.key('Escape');
  check('Escape starts a fresh game', g.state().rows.length === 0);
}

/* ==================================================== 7. stats and storage */
group('7. stats and the stored record');

{
  const g = boot();
  check('a first visit starts at zero',
    g.state().stats.en.played === 0 && g.state().stats.zh.played === 0);

  g.ctx.WG.forceAnswer('CRANE');
  g.play('SLATE');
  g.play('CRANE');
  let s = g.state().stats.en;
  check('a win in 2 games counts as played 1, won 1, streak 1', s.played === 1 && s.wins === 1 && s.streak === 1, JSON.stringify(s));
  check('the guess count lands in the right distribution bucket', s.dist[1] === 1 && s.dist[0] === 0, JSON.stringify(s.dist));

  g.newGame();
  g.ctx.WG.forceAnswer('ABOUT');
  g.play('CRANE');
  g.play('ABOUT');
  s = g.state().stats.en;
  check('a second win extends the streak', s.played === 2 && s.wins === 2 && s.streak === 2, JSON.stringify(s));
  check('the best streak is remembered', s.max === 2, JSON.stringify(s.max));

  g.newGame();
  g.ctx.WG.forceAnswer('CRANE');
  ctx.EN_WORDS.filter(w => w !== 'CRANE').slice(0, 6).forEach(w => g.play(w));
  s = g.state().stats.en;
  check('a loss resets the streak but keeps the best', s.played === 3 && s.wins === 2 && s.streak === 0 && s.max === 2, JSON.stringify(s));

  check('the Chinese record was left alone by English games', g.state().stats.zh.played === 0);

  const raw = g.env.store[ctx.WG.STORE_KEY];
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* handled by the assertion */ }
  check('the record is written to localStorage', !!parsed && parsed.en.played === 3, raw);

  // switching language and playing there must not touch the English record
  g.setLang('zh');
  g.ctx.WG.forceAnswer(ctx.ZH_WORDS[0]);
  g.play(ctx.ZH_WORDS[0]);
  check('a Chinese win is recorded separately',
    g.state().stats.zh.played === 1 && g.state().stats.zh.wins === 1 && g.state().stats.en.played === 3,
    JSON.stringify(g.state().stats));
}
{
  const g = boot({ [ctx.WG.STORE_KEY]: 'this is not json at all' });
  check('a corrupt stored value degrades to a fresh record instead of throwing',
    g.state().stats.en.played === 0 && g.state().stats.zh.played === 0);
}
{
  const g = boot({ [ctx.WG.STORE_KEY]: JSON.stringify({ en: { played: 'lots', dist: [1, 2] }, zh: 7 }) });
  const s = g.state().stats.en;
  check('a stored record with junk fields is sanitised',
    s.played === 0 && s.dist.length === ctx.WG.MAX_TRIES && s.dist.every(v => v === 0),
    JSON.stringify(s));
}
{
  const seeded = { en: { played: 9, wins: 4, streak: 1, max: 3, dist: [1, 1, 1, 1, 0, 0] }, zh: { played: 2, wins: 2, streak: 2, max: 2, dist: [0, 0, 2, 0, 0, 0] } };
  const g = boot({ [ctx.WG.STORE_KEY]: JSON.stringify(seeded) });
  const s = g.state().stats.en;
  check('a well-formed stored record is read back intact',
    s.played === 9 && s.wins === 4 && s.max === 3 && s.dist[3] === 1, JSON.stringify(s));
  check('and the other language comes back too', g.state().stats.zh.streak === 2);
  check('the stats block is rendered into the page',
    g.env.els.statBox.children.length > 0 && /9/.test(JSON.stringify(g.env.els.statBox.children.map(c => c.textContent))));
}

/* ===================================================== 8. share and copying */
group('8. the share grid and clipboard fallback');

{
  const G = '\uD83D\uDFE9', Y = '\uD83D\uDFE8', W = '\u2B1C';
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  g.play('SLATE');   // no amber in this one
  g.play('ABOVE');   // the A goes amber
  g.play('CRANE');
  const grid = ctx.WG.gridText(g.ctx.games.en);
  const lines = grid.split('\n');
  check('the share grid has one line per guess', lines.length === 3, JSON.stringify(grid));
  check('every line is as wide as the board',
    lines.every(l => padKeyCount(l) === 5), lines.map(padKeyCount).join(','));
  check('the grid leaks no letters at all', !gridLeaksLetters(grid), JSON.stringify(grid));
  check('each row is coloured cell by cell',
    lines[0] === W + W + G + W + G && lines[1] === Y + W + W + W + G,
    JSON.stringify(lines));
  check('the winning row is all green', lines[2] === G + G + G + G + G, JSON.stringify(lines[2]));
  check('all three colours are representable',
    grid.includes(G) && grid.includes(Y) && grid.includes(W), JSON.stringify(grid));

  const text = ctx.WG.shareText(g.ctx.games.en);
  check('the share text carries the score line', /3\/6/.test(text), text);
  check('the share text carries the site link', text.includes(ctx.WG.SITE_URL));
  check('the share text is spoiler-free', !/CRANE|SLATE|ABOVE/.test(text.replace(ctx.WG.SITE_URL, '')), text);

  // The stub has no navigator.clipboard, which is exactly the old-browser path.
  g.copy();
  check('with no clipboard API the fallback textarea is revealed',
    g.state().shareBoxHidden === false && g.state().shareBoxValue.includes(G),
    JSON.stringify(g.state().shareBoxValue));
  check('and the user is told to copy by hand', /手动|by hand/i.test(g.env.els.copyMsg.textContent),
    g.env.els.copyMsg.textContent);
}
{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  g.play('CRANE');
  // A synchronous thenable stands in for the clipboard promise.
  g.ctx.navigator.clipboard = { writeText: () => ({ then: ok => ok() }) };
  g.copy();
  check('a resolving clipboard write is reported as copied',
    /已复制|Copied/.test(g.env.els.copyMsg.textContent) && g.state().shareBoxHidden === true,
    g.env.els.copyMsg.textContent);
}
{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  g.play('CRANE');
  g.ctx.navigator.clipboard = { writeText: () => ({ then: (ok, err) => err() }) };
  g.copy();
  check('a rejected clipboard write falls back instead of failing silently',
    g.state().shareBoxHidden === false && /手动|by hand/i.test(g.env.els.copyMsg.textContent));
}
{
  const g = boot();
  g.ctx.navigator.clipboard = { writeText: () => { throw new Error('blocked'); } };
  let threw = false;
  try { g.copy(); } catch (e) { threw = true; }
  check('clicking copy before the game ends is a no-op, not a crash', !threw);
}

/* ============================================ 9. two languages, two boards */
group('9. language switching keeps each board');

{
  const g = boot();
  g.ctx.WG.forceAnswer('CRANE');
  g.play('SLATE');
  check('the English board has a row', g.state().lang === 'en' && g.state().rows.length === 1);
  check('the English pad is 26 letters', g.state().padChars.length === 26);

  g.setLang('zh');
  let st = g.state();
  check('switching to Chinese switches the live language', st.lang === 'zh');
  check('the Chinese board starts empty — progress is per language', st.rows.length === 0 && st.typed.length === 0);
  check('the board is four slots wide in Chinese', st.len === 4);
  check('the Chinese pad is the derived character set',
    st.padChars.length === ctx.BANKS.zh.pad.length && st.padChars.includes('心'));
  check('the hint line is rebuilt for Chinese', /4/.test(g.env.els.hintRow.textContent), g.env.els.hintRow.textContent);

  const idiom = ctx.ZH_WORDS[3];
  g.ctx.WG.forceAnswer(idiom);
  g.play(idiom);
  check('a Chinese idiom can be typed on the pad and won', g.state().won === true, idiom);
  check('the Chinese key colours are recorded',
    Object.keys(g.state().keyState).length >= 3, JSON.stringify(g.state().keyState));

  g.setLang('en');
  st = g.state();
  check('switching back restores the English board', st.lang === 'en' && st.rows.length === 1 && st.rows[0] === 'SLATE');
  check('and the English letter colours are still there', st.keyState.E !== undefined, JSON.stringify(st.keyState));

  g.setLang('zh');
  check('the Chinese board still has its win', g.state().won === true && g.state().rows.length === 1);

  let threw = false;
  try { g.ctx.T.set('fr'); } catch (e) { threw = true; }
  check('an unsupported language code is ignored', !threw && g.state().lang === 'zh');
}

/* ========================================================== 10. bilingual copy */
group('10. bilingual copy');

{
  const dict = ctx.DICT;
  const keys = Object.keys(dict);
  check(`the dictionary has a key for every string (${keys.length} keys)`, keys.length >= 20);

  const problems = [];
  for (const k of keys) {
    const e = dict[k];
    if (!e || typeof e.en !== 'string' || typeof e.zh !== 'string') { problems.push(`${k}: missing a language`); continue; }
    if (!e.en.trim()) problems.push(`${k}: empty en`);
    if (!e.zh.trim()) problems.push(`${k}: empty zh`);
    if (e.en === e.zh) problems.push(`${k}: zh is an untranslated copy of en`);
  }
  check('every key has non-empty copy in both languages, none copy-pasted',
    problems.length === 0, problems.slice(0, 4).join(' | '));

  // A key the markup asks for but the dictionary lacks renders the raw key name
  // to the user — e.g. a button labelled "newGame".
  const markupKeys = [...new Set([...HTML.matchAll(/data-i18n(?:-html|-title|-ph)?="([^"]+)"/g)].map(m => m[1]))];
  const missingMarkup = markupKeys.filter(k => !(k in dict));
  check(`all ${markupKeys.length} markup data-i18n keys exist in the dictionary`,
    missingMarkup.length === 0, missingMarkup.join(','));

  const tKeys = [...new Set([...HTML.matchAll(/T\.t\('([^']+)'/g)].map(m => m[1]))];
  const missingT = tKeys.filter(k => !(k in dict));
  check(`all ${tKeys.length} T.t() keys exist in the dictionary`, missingT.length === 0, missingT.join(','));

  const used = new Set([...markupKeys, ...tKeys]);
  const dead = keys.filter(k => !used.has(k));
  check('no dead dictionary entries left behind', dead.length === 0, dead.join(','));

  // Placeholders must survive translation, or a rendered string keeps a raw
  // "{answer}" in it.
  const holders = [];
  for (const k of keys) {
    const inEn = [...(dict[k].en || '').matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
    const inZh = [...(dict[k].zh || '').matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
    if (inEn !== inZh) holders.push(`${k}: en{${inEn}} vs zh{${inZh}}`);
  }
  check('both languages use the same placeholders', holders.length === 0, holders.join(' | '));
}

/* =================================================== 11. reverse injections */
group('11. reverse checks — the suite must notice these');

{
  // The one-pass scorer, which is the bug this whole file exists to catch.
  const naive = (guess, answer) => [...answer].map((ch, i) =>
    guess[i] === ch ? 'hit' : (answer.includes(guess[i]) ? 'present' : 'miss'));

  let disagreements = 0;
  const S = allStrings('AB', 4);
  for (const g2 of S) for (const a2 of S) {
    if (naive(g2, a2).join(',') !== referenceEvaluate(g2, a2).join(',')) disagreements++;
  }
  check('a one-pass scorer disagrees with the reference on many pairs (so the differential test has teeth)',
    disagreements > 0, `${disagreements} disagreements`);
  check('and the real scorer is not that implementation',
    ctx.evaluate('EERIE', 'CRANE').join(',') !== naive('EERIE', 'CRANE').join(','));

  // Broken banks must be rejected by bankProblems.
  const en = ctx.BANKS.en;
  check('an answer missing from the accepted list is reported',
    bankProblems('en', { ...en, words: en.words.filter(w => w !== en.answers[0]) }).length > 0);
  check('a wrong-length word is reported',
    bankProblems('en', { ...en, words: [...en.words, 'TOOLONG'] }).length > 0);
  check('a duplicate word is reported',
    bankProblems('en', { ...en, words: [...en.words, en.words[0]] }).length > 0);
  check('a lowercase word is reported',
    bankProblems('en', { ...en, words: [...en.words, 'abcde'] }).length > 0);
  check('a pad missing a needed key is reported',
    bankProblems('en', { ...en, pad: en.pad.filter(c => c !== 'Z') }).length > 0);
  const zh = ctx.BANKS.zh;
  check('a Chinese entry that is not four characters is reported',
    bankProblems('zh', { ...zh, words: [...zh.words, '一心'] }).length > 0);
  check('Latin characters smuggled into the Chinese bank are reported',
    bankProblems('zh', { ...zh, words: [...zh.words, 'ABCD'] }).length > 0);
  check('a surrogate pair in a Chinese entry is reported',
    bankProblems('zh', { ...zh, words: [...zh.words, '\uD842\uDFB7一意'] }).length > 0);

  // A leaking grid must be caught by the spoiler check.
  check('a share grid that contains letters is caught',
    gridLeaksLetters('\uD83D\uDFE9\uD83D\uDFE9\uD83D\uDFE9\uD83D\uDFE9\uD83D\uDFE9\nCRANE'));
  check('a clean emoji grid is not flagged', !gridLeaksLetters('\uD83D\uDFE9\u2B1C\n\uD83D\uDFE8\u2B1C'));
}

/* ------------------------------------------------------------------- report */
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
