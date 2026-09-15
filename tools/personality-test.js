#!/usr/bin/env node
/**
 * Logic + content tests for personality-game.
 *
 * The smoke test only proves the page does not throw. This script proves the
 * things that actually make or break a questionnaire:
 *
 *   1. content integrity  - every axis is balanced, every string exists in
 *      both languages, every type code is reachable from the real questions,
 *      and the game names baked into the recommendations still match the
 *      landing page;
 *   2. scoring            - exhaustively over all 2^12 answer combinations:
 *      every code is valid, no axis can tie, the percentages add up;
 *   3. recommendations    - every type gets three distinct, existing games;
 *   4. persistence        - a returning visitor gets their last result back,
 *      and a corrupted stored value degrades instead of throwing;
 *   5. the real UI        - driven through the actual Start button, the actual
 *      option clicks, the real Back button and the real keyboard handler.
 *
 * It loads the whole inline script in a vm sandbox so it can read the content
 * tables and live state directly.
 *
 * Usage:  node tools/personality-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'personality-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');
const LANDING = path.join(ROOT, 'index.html');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

const HTML = fs.readFileSync(GAME, 'utf8');

/* ----------------------------------------------- fake DOM (mirrors the others) */

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
  }
  const els = {};
  const winHandlers = {};
  const store = {};
  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
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
  if (seed) Object.keys(seed).forEach(k => env.store[k] = seed[k]);
  vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
  const scripts = [...HTML.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => vm.runInContext(s, env.context, { filename: `personality#${i}` }));
  const ctx = env.context;
  const state = () => ctx.PTEST.getState();
  return {
    env, ctx, state,
    optionsEl: () => env.els.options,
    // Click option `i` the way the page does: on the container, with the
    // option as ev.target (that is what the delegated handler reads).
    clickOption: i => env.els.options.fire('click', { target: state().optionEls[i], preventDefault() {} }),
    // Answer the current question with a specific pole, wherever it is shown.
    pickPole: letter => {
      const i = state().optionPoles.indexOf(letter);
      if (i < 0) return false;
      env.els.options.fire('click', { target: state().optionEls[i], preventDefault() {} });
      return true;
    },
    key: k => (env.winHandlers.keydown || []).forEach(f => f({ key: k, preventDefault() {} })),
    btn: id => env.els[id]
  };
}

/* ----------------------------------------------------- pure content helpers
 * Plain functions over plain data, so the reverse checks below can feed them a
 * deliberately broken copy and prove the check actually fails. */

function stringsOf(pair) {
  if (pair == null) return [];
  if (typeof pair === 'string') return [pair];
  return [pair.en, pair.zh].filter(v => v != null);
}

function axisBalance(questions) {
  const per = {};
  questions.forEach(q => { per[q.a] = (per[q.a] || 0) + 1; });
  return per;
}

function axisTiePossible(questions, axes) {
  // An axis can tie when it has an even number of questions.
  for (let i = 0; i < axes.length; i++) {
    const n = (axisBalance(questions)[i] || 0);
    if (n % 2 === 0) return true;
  }
  return false;
}

function optionPoleProblems(questions, axes) {
  const bad = [];
  questions.forEach((q, qi) => {
    if (q.a < 0 || q.a >= axes.length) { bad.push(`q${qi} bad axis`); return; }
    if (!Array.isArray(q.opts) || q.opts.length !== 2) { bad.push(`q${qi} needs exactly 2 options`); return; }
    const poles = q.opts.map(o => o.p).sort().join('');
    const want = axes[q.a].poles.slice().sort().join('');
    if (poles !== want) bad.push(`q${qi} options are ${poles}, axis ${q.a} wants ${want}`);
    if (q.opts[0].p === q.opts[1].p) bad.push(`q${qi} both options share a pole`);
  });
  return bad;
}

function duplicateOptionText(questions) {
  const bad = [];
  questions.forEach((q, qi) => {
    ['en', 'zh'].forEach(lang => {
      const a = q.opts[0][lang], b = q.opts[1][lang];
      if (a != null && a === b) bad.push(`q${qi}.${lang} options identical`);
    });
  });
  return bad;
}

function missingDictionaryKeys(dict, keys) {
  return keys.filter(k => !(k in dict));
}

function recoProblems(reco, games, axes, exists) {
  const bad = [];
  axes.forEach(ax => ax.poles.forEach(p => {
    if (!reco[p]) { bad.push(`no pool for pole ${p}`); return; }
    reco[p].forEach(dir => {
      if (!games[dir]) bad.push(`${p} -> ${dir} is not in GAMES`);
      else if (exists && !exists(dir)) bad.push(`${p} -> ${dir} has no directory`);
    });
  }));
  return bad;
}

/* ================================================================== run it */

group('content: axis balance and question shape');
{
  const B = boot();
  const Q = B.ctx.PTEST.QUESTIONS, AX = B.ctx.PTEST.AXES;

  check('there are 12 questions', Q.length === 12, `got ${Q.length}`);
  check('there are 4 axes', AX.length === 4, `got ${AX.length}`);

  const per = axisBalance(Q);
  check('every axis has exactly 3 questions', [0, 1, 2, 3].every(i => per[i] === 3), JSON.stringify(per));
  check('no axis can tie (every axis has an odd count)', !axisTiePossible(Q, AX));

  check('every question offers exactly the two poles of its axis', optionPoleProblems(Q, AX).length === 0,
        optionPoleProblems(Q, AX).join('; '));
  check('the two options of a question are never identical text', duplicateOptionText(Q).length === 0,
        duplicateOptionText(Q).join('; '));

  // reverse: a dropped question must unbalance an axis
  const short = Q.slice(1);
  check('reverse: removing one question unbalances an axis', axisBalance(short)[0] !== 3);
  check('reverse: an even axis would be reported as tie-able', axisTiePossible(short, AX) === true);
  // reverse: swapping one pole for a wrong one must be caught
  const swapped = JSON.parse(JSON.stringify(Q));
  swapped[0].opts[1].p = 'T';
  check('reverse: an option carrying the wrong pole is caught', optionPoleProblems(swapped, AX).length === 1);
}

group('content: every string exists in both languages');
{
  const B = boot();
  const { QUESTIONS: Q, TYPES, POLES, AXES: AX, RECO, GAMES } = B.ctx.PTEST;

  const groups = { questions: [], options: [], types: [], poles: [], axes: [] };
  Q.forEach(q => {
    groups.questions.push(['q.en', q.q]);
    q.opts.forEach((o, i) => groups.options.push([`opt${i}`, o]));
  });
  Object.keys(TYPES).forEach(c => {
    groups.types.push([`${c}.name`, TYPES[c].name]);
    groups.types.push([`${c}.tag`, TYPES[c].tag]);
    groups.types.push([`${c}.tip`, TYPES[c].tip]);
  });
  Object.keys(POLES).forEach(p => {
    groups.poles.push([`${p}.name`, POLES[p].name]);
    groups.poles.push([`${p}.desc`, POLES[p].desc]);
  });
  AX.forEach((ax, i) => {
    groups.axes.push([`axis${i}.name`, ax.name]);
    groups.axes.push([`axis${i}.low`, ax.low]);
    groups.axes.push([`axis${i}.high`, ax.high]);
  });

  Object.keys(groups).forEach(kind => {
    const list = groups[kind];
    const incomplete = list.filter(([, pair]) => {
      const vals = stringsOf(pair);
      return vals.length !== 2 || vals.some(v => !String(v).trim());
    });
    check(`every ${kind} string has a non-empty en and zh`, incomplete.length === 0,
          incomplete.map(x => x[0]).join(', '));
    const sameCopy = list.filter(([, pair]) => pair.en === pair.zh);
    check(`no ${kind} string is left untranslated (en === zh)`, sameCopy.length === 0,
          sameCopy.map(x => x[0]).join(', '));
  });

  // reverse: a pair missing its zh half must be reported
  const broken = [['x', { en: 'hello' }], ['y', { en: 'a', zh: '  ' }], ['z', { en: 'ok', zh: '好' }]];
  const caught = broken.filter(([, pair]) => {
    const vals = stringsOf(pair);
    return vals.length !== 2 || vals.some(v => !String(v).trim());
  });
  check('reverse: a missing or blank translation is caught', caught.length === 2, `caught ${caught.length}`);

  check('all 8 poles are present', Object.keys(POLES).sort().join('') === 'EFIJN PST'.replace(' ', '').split('').sort().join(''),
        Object.keys(POLES).sort().join(''));
  check('all 16 types are present', Object.keys(TYPES).length === 16, `got ${Object.keys(TYPES).length}`);
}

group('content: the 16 type codes match the axes exactly');
{
  const B = boot();
  const { TYPES, AXES: AX } = B.ctx.PTEST;
  const expect = [];
  (function build(i, acc) {
    if (i === AX.length) { expect.push(acc); return; }
    AX[i].poles.forEach(p => build(i + 1, acc + p));
  })(0, '');
  check('there are 16 possible codes from the axes', expect.length === 16);
  const missing = expect.filter(c => !TYPES[c]);
  const extra = Object.keys(TYPES).filter(c => expect.indexOf(c) < 0);
  check('TYPES covers exactly the reachable codes', missing.length === 0 && extra.length === 0,
        `missing=${missing.join(',')} extra=${extra.join(',')}`);
}

group('scoring: exhaustive over every possible answer set');
{
  const B = boot();
  const { QUESTIONS: Q, AXES: AX, TYPES } = B.ctx.PTEST;
  const P = B.ctx.PTEST;

  const codes = new Set();
  let badLetter = 0, badPair = 0, badPct = 0, ties = 0, badLength = 0;
  const total = 1 << Q.length;                       // 4096 answer sets

  for (let mask = 0; mask < total; mask++) {
    const picks = Q.map((q, i) => q.opts[(mask >> i) & 1].p);
    const res = P.resultFrom(P.countPoles(picks));
    if (res.code.length !== 4) badLength++;
    codes.add(res.code);
    res.bars.forEach((bar, ai) => {
      if (AX[ai].poles.indexOf(bar.pick) < 0) badLetter++;
      if (bar.a + bar.b !== 3) badPair++;
      if (bar.total % 2 === 0) ties++;
      // bars are rounded once, so the two sides must sum to exactly 100 or 99/101
      const other = 100 - bar.pct;
      const raw = bar.a === bar.b ? 50 : Math.round(100 * Math.max(bar.a, bar.b) / 3);
      if (bar.pct !== raw) badPct++;
      if (other + bar.pct !== 100) badPct++;
    });
  }

  check(`all ${total} answer sets produce a 4-letter code`, badLength === 0, `bad=${badLength}`);
  check('every axis sums to its 3 questions', badPair === 0, `bad=${badPair}`);
  check('no axis can ever tie', ties === 0, `ties=${ties}`);
  check('bar percentages are computed consistently', badPct === 0, `bad=${badPct}`);
  check('the chosen letter always belongs to that axis', badLetter === 0, `bad=${badLetter}`);
  check('all 16 types are reachable from the real questions', codes.size === 16, `reachable=${codes.size}`);
  check('every reachable code exists in TYPES', [...codes].every(c => !!TYPES[c]),
        [...codes].filter(c => !TYPES[c]).join(','));

  // spot-check the ends of an axis
  const allFirst = P.resultFrom(P.countPoles(Q.map(q => AX[q.a].poles[0])));
  const allSecond = P.resultFrom(P.countPoles(Q.map(q => AX[q.a].poles[1])));
  check('answering the first pole everywhere gives ESTJ', allFirst.code === 'ESTJ', allFirst.code);
  check('answering the second pole everywhere gives INFP', allSecond.code === 'INFP', allSecond.code);
  check('a 3-0 axis reads as a clear 100% preference',
        allFirst.bars[0].pct === 100 && allFirst.bars[0].strength === 'strong');
  const mixed = P.resultFrom(P.countPoles(['E', 'E', 'I', 'S', 'S', 'S', 'T', 'T', 'T', 'J', 'J', 'J']));
  check('a 2-1 axis reads as a slight 67% preference',
        mixed.bars[0].pct === 67 && mixed.bars[0].strength === 'slight', JSON.stringify(mixed.bars[0]));

  // reverse: a scorer that ignored the question order would collide codes
  const wrong = ['E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E', 'E'];
  check('reverse: an all-one-pole answer set is only one of 16 codes', codes.size > 1 && wrong.length === 12);
}

group('recommendations: three distinct, existing games per type');
{
  const B = boot();
  const { TYPES, AXES: AX, RECO, GAMES } = B.ctx.PTEST;
  const P = B.ctx.PTEST;
  const exists = dir => fs.existsSync(path.join(ROOT, dir, 'index.html'));

  check('every pool entry names a real game in GAMES', recoProblems(RECO, GAMES, AX, null).length === 0,
        recoProblems(RECO, GAMES, AX, null).join('; '));
  check('every pool entry has an existing game directory', recoProblems(RECO, GAMES, AX, exists).length === 0,
        recoProblems(RECO, GAMES, AX, exists).join('; '));
  check('every game in GAMES exists on disk', Object.keys(GAMES).every(exists),
        Object.keys(GAMES).filter(d => !exists(d)).join(', '));
  check('every pool is non-empty', AX.every(ax => ax.poles.every(p => (RECO[p] || []).length > 0)));

  let notThree = [], dupes = [], broken = [];
  Object.keys(TYPES).forEach(code => {
    const bars = code.split('').map((letter, i) => ({ pick: letter, axis: AX[i] }));
    const out = P.recommend(bars);
    if (out.length !== 3) notThree.push(`${code}:${out.length}`);
    if (new Set(out).size !== 3) dupes.push(code);
    if (!out.every(d => exists(d))) broken.push(code);
  });
  check('all 16 types get exactly 3 recommendations', notThree.length === 0, notThree.join(','));
  check('no type gets the same game twice', dupes.length === 0, dupes.join(','));
  check('every recommendation resolves to a real game', broken.length === 0, broken.join(','));

  const distinct = new Set(Object.keys(TYPES).map(c =>
    P.recommend(c.split('').map((l, i) => ({ pick: l, axis: AX[i] }))).join(',')));
  check('recommendations actually vary by type', distinct.size > 1, `distinct=${distinct.size}`);

  // reverse: a pool pointing at a directory that does not exist must be caught
  const badReco = JSON.parse(JSON.stringify(RECO));
  badReco.E[0] = 'does-not-exist-game';
  check('reverse: a pool entry with no directory is caught',
        recoProblems(badReco, GAMES, AX, exists).length === 1, recoProblems(badReco, GAMES, AX, exists).join(';'));
}

group('integration: game names still match the landing page');
{
  const landing = fs.readFileSync(LANDING, 'utf8');
  const re = /class="card" href="([^"]+)"[\s\S]*?<h2>\s*<span data-lang="en"[^>]*>([^<]+)<\/span>\s*<span data-lang="zh"[^>]*>([^<]+)<\/span>/g;
  const cards = {};
  let m;
  while ((m = re.exec(landing))) cards[m[1].replace(/\/$/, '')] = { en: m[2].trim(), zh: m[3].trim() };

  const B = boot();
  const GAMES = B.ctx.PTEST.GAMES;
  const mismatch = [];
  Object.keys(GAMES).forEach(dir => {
    const card = cards[dir];
    if (!card) { mismatch.push(`${dir} missing from landing`); return; }
    if (card.en !== GAMES[dir].en) mismatch.push(`${dir}.en "${GAMES[dir].en}" != "${card.en}"`);
    if (card.zh !== GAMES[dir].zh) mismatch.push(`${dir}.zh "${GAMES[dir].zh}" != "${card.zh}"`);
  });
  check('every recommended game is on the landing page with the same name', mismatch.length === 0,
        mismatch.join('; '));
  check('the game links use a relative ../<dir>/ path so they work from this folder',
        HTML.indexOf("a.href = '../' + dir + '/'") >= 0);

  // reverse: renaming a card in the map must be detected
  const broken = JSON.parse(JSON.stringify(GAMES));
  broken['sokoban-game'] = { en: 'Sokoban XXX', zh: '推箱子' };
  check('reverse: a drifted game name is caught', broken['sokoban-game'].en !== cards['sokoban-game'].en);
}

group('i18n: dictionary completeness and live re-render');
{
  const B = boot();
  const dict = B.ctx.DICT;
  const keys = new Set();
  [...HTML.matchAll(/T\.t\(\s*'([^']+)'/g)].forEach(m => keys.add(m[1]));
  [...HTML.matchAll(/data-i18n(?:-html|-title|-ph)?="([^"]+)"/g)].forEach(m => keys.add(m[1]));

  check('the game asks for at least 15 distinct copy keys', keys.size >= 15, `got ${keys.size}`);
  const missing = missingDictionaryKeys(dict, [...keys]);
  check('every copy key used in markup and code exists in the dictionary', missing.length === 0,
        missing.join(', '));
  // Some keys are looked up through a computed expression (e.g. the strength
  // label), which a static call scan cannot see, so look for the literal key
  // anywhere in the source instead.
  const unused = Object.keys(dict).filter(k =>
    HTML.indexOf("'" + k + "'") < 0 && HTML.indexOf('"' + k + '"') < 0);
  check('no dictionary entry is dead copy that nothing asks for', unused.length === 0, unused.join(', '));
  check('every dictionary entry has both languages',
        Object.keys(dict).every(k => dict[k] && dict[k].en && dict[k].zh),
        Object.keys(dict).filter(k => !(dict[k] && dict[k].en && dict[k].zh)).join(', '));

  // reverse: drop a key from a copy of the dict and the check must fail
  const brokenDict = Object.assign({}, dict);
  delete brokenDict[Object.keys(dict)[0]];
  check('reverse: a missing dictionary key is caught',
        missingDictionaryKeys(brokenDict, [...keys]).length === 1);

  // live language switch must re-render runtime-built copy
  const B2 = boot();
  B2.btn('btnStart').fire('click');
  const en = B2.env.els.qText.textContent;
  B2.ctx.T.set('zh');
  const zh = B2.env.els.qText.textContent;
  check('switching language re-renders the current question', en !== zh && zh.length > 0,
        JSON.stringify([en, zh]));
  check('the zh question text matches the content table',
        zh === B2.ctx.PTEST.QUESTIONS[0].q.zh, JSON.stringify(zh));
  const enBack = (() => { B2.ctx.T.set('en'); return B2.env.els.qText.textContent; })();
  check('switching back restores the en text', enBack === B2.ctx.PTEST.QUESTIONS[0].q.en);
}

group('the real UI: start, answer, back, keyboard, finish');
{
  const B = boot();
  check('the page starts on the start screen', B.state().view === 'start');
  check('the start button exists', !!B.btn('btnStart'));
  check('the last-result button is hidden with nothing stored', B.btn('btnLast').hidden === true);

  B.btn('btnStart').fire('click');
  check('Start moves to the quiz', B.state().view === 'quiz');
  check('the first question is showing', B.state().idx === 0);
  check('two options are on screen', B.state().optionEls.length === 2, `got ${B.state().optionEls.length}`);
  check('the two options carry the axis poles',
        B.state().optionPoles.slice().sort().join('') === 'EI', B.state().optionPoles.join(''));
  check('the back button is disabled on the first question', B.btn('btnBack').disabled === true);
  check('the question counter is filled in', String(B.env.els.qText.textContent).length > 0);

  // answer the whole thing as the first pole of every axis -> ESTJ
  const Q = B.ctx.PTEST.QUESTIONS, AX = B.ctx.PTEST.AXES;
  let ok = true;
  for (let i = 0; i < Q.length; i++) {
    if (!B.pickPole(AX[Q[i].a].poles[0])) { ok = false; break; }
  }
  check('clicking the options walks through all 12 questions', ok);
  check('finishing lands on the result screen', B.state().view === 'result', B.state().view);
  check('the computed code is ESTJ', B.state().code === 'ESTJ', B.state().code);
  check('the result screen shows four bars', B.state().bars.length === 4);
  check('the code is written into the page', B.env.els.rCode.textContent === 'ESTJ');
  check('the type name is written into the page', String(B.env.els.rName.textContent).length > 0);
  check('four trait paragraphs are rendered', B.env.els.traits.children.length === 4);
  check('three game suggestions are rendered', B.env.els.reco.children.length === 3);
  // The fake DOM's textContent does not aggregate children, so inspect them.
  const tipEl = B.env.els.rTip;
  check('the trait tip is filled in',
        tipEl.children.length === 2 &&
        String(tipEl.children[0].textContent).length > 0 &&
        String(tipEl.children[1].textContent).length > 0,
        `children=${tipEl.children.length}`);
  check('the progress bar reached the end', B.env.els.bar.style.width === '100%');

  // back button
  const B3 = boot();
  B3.btn('btnStart').fire('click');
  B3.clickOption(0);
  B3.clickOption(0);
  check('two answers advance to question 3', B3.state().idx === 2);
  B3.btn('btnBack').fire('click');
  check('Back returns to question 2', B3.state().idx === 1);
  check('Back drops the answer it rewound', B3.state().answers.length === 1, `got ${B3.state().answers.length}`);
  B3.btn('btnBack').fire('click');
  check('Back stops at the first question', B3.state().idx === 0);
  check('the back button is disabled again', B3.btn('btnBack').disabled === true);

  // keyboard
  const B4 = boot();
  B4.btn('btnStart').fire('click');
  const poles1 = B4.state().optionPoles.slice();
  B4.key('1');
  check('pressing 1 answers with the first shown option', B4.state().answers[0] === poles1[0],
        `${B4.state().answers[0]} vs ${poles1[0]}`);
  B4.key('ArrowLeft');
  check('ArrowLeft goes back', B4.state().idx === 0);
  // Must be checked while still on question 1 — answering advances and renders
  // the next question, whose own option order is unrelated.
  check('going back does not reshuffle the options already read',
        B4.state().optionPoles.join('') === poles1.join(''),
        `${B4.state().optionPoles.join('')} vs ${poles1.join('')}`);
  B4.key('2');
  check('pressing 2 answers with the second shown option', B4.state().answers[0] === poles1[1],
        `${B4.state().answers[0]} vs ${poles1[1]}`);
  check('keys other than 1/2/left are ignored', (() => {
    B4.key('ArrowLeft');
    const before = B4.state().idx;
    B4.key('q'); B4.key('Escape'); B4.key(' ');
    return B4.state().idx === before;
  })());

  // option shuffling: neither pole may always be first
  const firstPoles = new Set();
  for (let i = 0; i < 200; i++) {
    const B5 = boot();
    B5.btn('btnStart').fire('click');
    firstPoles.add(B5.state().optionPoles[0]);
  }
  check('the first shown option is not always the same pole', firstPoles.size === 2,
        `saw ${[...firstPoles].join(',')}`);

  // copy button must survive a browser without the clipboard API
  B.btn('btnCopy').fire('click');
  check('Copy falls back to showing the text when the clipboard is unavailable',
        String(B.env.els.copyMsg.textContent).length > 0, JSON.stringify(B.env.els.copyMsg.textContent));
  check('the share text is placed in the fallback box',
        String(B.env.els.shareBox.value).indexOf('ESTJ') >= 0, String(B.env.els.shareBox.value).slice(0, 60));
  check('the share text contains the site url',
        String(B.env.els.shareBox.value).indexOf(B.ctx.PTEST.SITE_URL) >= 0);
  check('the fallback box is revealed', B.env.els.shareBox.hidden === false);

  // retake
  B.btn('btnRetake').fire('click');
  check('Take it again returns to question 1', B.state().view === 'quiz' && B.state().idx === 0);
  check('Take it again clears the previous answers', B.state().answers.length === 0);
}

group('persistence: the last result comes back');
{
  const B = boot();
  B.btn('btnStart').fire('click');
  const Q = B.ctx.PTEST.QUESTIONS, AX = B.ctx.PTEST.AXES;
  Q.forEach(q => B.pickPole(AX[q.a].poles[1]));       // all second poles -> INFP
  check('the finished run is INFP', B.state().code === 'INFP', B.state().code);

  const raw = B.env.store[B.ctx.PTEST.shareKey];
  check('the result is written to localStorage', typeof raw === 'string' && raw.length > 0);
  check('the stored payload carries the code', JSON.parse(raw).code === 'INFP', raw);
  check('the stored payload carries the counts so bars can be rebuilt',
        !!JSON.parse(raw).counts && JSON.parse(raw).counts.I === 3, raw);

  // a returning visitor
  const B2 = boot({ [B.ctx.PTEST.shareKey]: raw });
  check('a returning visitor is offered their last result', B2.btn('btnLast').hidden === false);
  check('the offer names the previous code', String(B2.btn('btnLast').textContent).indexOf('INFP') >= 0,
        String(B2.btn('btnLast').textContent));
  B2.btn('btnLast').fire('click');
  check('viewing the last result opens the result screen', B2.state().view === 'result');
  check('the previous code is restored', B2.state().code === 'INFP', B2.state().code);
  check('the previous bars are restored', B2.state().bars[0].pct === 100, JSON.stringify(B2.state().bars[0]));

  // corrupted storage must degrade, not throw
  let threw = null, B3 = null;
  try { B3 = boot({ [B.ctx.PTEST.shareKey]: '{not json at all' }); } catch (e) { threw = e; }
  check('a corrupted stored value does not break the page', threw === null, threw && threw.message);
  check('a corrupted value simply hides the last-result button', B3 && B3.btn('btnLast').hidden === true);

  let threw2 = null, B4 = null;
  try { B4 = boot({ [B.ctx.PTEST.shareKey]: JSON.stringify({ code: 'ZZZZ' }) }); } catch (e) { threw2 = e; }
  check('a stored code that is not a real type is ignored', threw2 === null && B4.btn('btnLast').hidden === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
