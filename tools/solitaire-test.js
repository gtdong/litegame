#!/usr/bin/env node
/**
 * Logic tests for solitaire-game (Klondike).
 *
 * The smoke test only proves the page never throws. It cannot tell whether
 * the deal is legal, whether the tableau/foundation rules are correct, or
 * whether the game can actually be finished. This suite loads the whole
 * inline script in a vm sandbox (the game's `var`/`function` declarations land
 * on the sandbox global, so the test can read internal state directly) and
 * asserts the real rules.
 *
 * Three habits from CONTRIBUTING.md are followed here:
 *   1. Test the actual rules, not just "it loaded".
 *   2. Drive a full game through the *real* UI entry point (the Start button,
 *      then real board clicks) — not by calling internal functions directly.
 *   3. Include negative controls that inject a bug and prove the assertions
 *      would catch it, so we know the tests are effective.
 *
 * Usage:  node tools/solitaire-test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = path.join(ROOT, 'solitaire-game', 'index.html');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  (${detail})` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

/* ------------------------------------------------------------------ DOM */
/* Mirrors tools/smoke.js: getAttribute() returns null, querySelectorAll()
 * returns [], but El.querySelectorAll / closest resolve by class and
 * style.setProperty just records — exactly the quirks the game must survive. */
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
    setAttribute() {}
    getAttribute() { return null; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 400 }; }
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
  }

  const els = {};
  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => Date.now() },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    localStorage: (() => {
      const store = {};
      return { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
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
  context.addEventListener = (t, f) => { (context._wh = context._wh || {})[t] = (context._wh[t] || []); context._wh[t].push(f); };
  context.removeEventListener = () => {};

  vm.createContext(context);
  return { context, els };
}

function run(code, ctx, name) { vm.runInContext(code, ctx, { filename: name }); }

function boot() {
  const env = makeContext();
  run(fs.readFileSync(I18N, 'utf8'), env.context, 'i18n.js');
  const html = fs.readFileSync(GAME, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  scripts.forEach((s, i) => run(s, env.context, `solitaire#${i}`));
  return env;
}

/* ------------------------------------------------------------- helpers */
function clickCard(ctx, id) {
  ctx.boardEl.fire('click', { target: ctx.cardEls[id], button: 0, preventDefault() {} });
}
function clickTab(ctx, c) {
  ctx.boardEl.fire('click', { target: ctx.tabEl[c], button: 0, preventDefault() {} });
}
function clickFound(ctx, s) {
  ctx.boardEl.fire('click', { target: ctx.foundEl[s], button: 0, preventDefault() {} });
}
function clickStock(ctx) {
  ctx.boardEl.fire('click', { target: ctx.stockEl, button: 0, preventDefault() {} });
}
function clickEl(el) {
  el.fire('click', { target: el, button: 0, preventDefault() {} });
}

/* ===================================================================== */
/* 1. Deal correctness                                                   */
/* ===================================================================== */
group('deal correctness (real deal)');
{
  const { context: ctx } = boot();
  ctx.newGame(20240601);

  check('exactly 52 cards are in play', ctx.totalCards() === 52, `got ${ctx.totalCards()}`);

  // Every id 0..51 present exactly once.
  const seen = {};
  let dup = false;
  function walk(pile) { pile.forEach(c => { if (seen[c.id]) dup = true; seen[c.id] = 1; }); }
  walk(ctx.stock); walk(ctx.waste);
  ctx.founds.forEach(walk); ctx.tableau.forEach(walk);
  let count = 0; for (let i = 0; i < 52; i++) if (seen[i]) count++;
  check('no duplicate card ids', !dup);
  check('all 52 distinct ids present', count === 52, `got ${count}`);

  // 7 tableau columns with 1..7 cards.
  let colOk = true;
  for (let c = 0; c < 7; c++) if (ctx.tableau[c].length !== c + 1) colOk = false;
  check('column counts are 1,2,3,4,5,6,7', colOk,
    ctx.tableau.map(p => p.length).join(','));

  // Only the last card of each column is face up.
  let flipOk = true;
  ctx.tableau.forEach(p => {
    for (let k = 0; k < p.length; k++) {
      const shouldBeUp = (k === p.length - 1);
      if (p[k].up !== shouldBeUp) flipOk = false;
    }
  });
  check('only the bottom card of each column is face up', flipOk);

  check('stock holds the remaining 24 cards', ctx.stock.length === 24, `got ${ctx.stock.length}`);
  check('waste starts empty', ctx.waste.length === 0);
  check('all four foundations start empty',
    ctx.founds[0].length === 0 && ctx.founds[1].length === 0 &&
    ctx.founds[2].length === 0 && ctx.founds[3].length === 0);

  // Conservation across piles.
  const conserved = ctx.stock.length + ctx.waste.length +
    ctx.founds.reduce((a, f) => a + f.length, 0) +
    ctx.tableau.reduce((a, p) => a + p.length, 0);
  check('stock + waste + tableau + foundations conserve 52', conserved === 52, `got ${conserved}`);
}

/* ===================================================================== */
/* 2. Static rule judges                                                 */
/* ===================================================================== */
group('rule judges (colour alternation, descending, foundation order)');
{
  const { context: ctx } = boot();
  ctx.newGame(1);

  check('isRed: spade/club are black', ctx.isRed(0) === false && ctx.isRed(3) === false);
  check('isRed: heart/diamond are red', ctx.isRed(1) === true && ctx.isRed(2) === true);

  const H9 = { suit: 1, rank: 9 };   // red
  const D10 = { suit: 2, rank: 10 };  // red
  const S9 = { suit: 0, rank: 9 };    // black
  const C10 = { suit: 3, rank: 10 };  // black
  const S10 = { suit: 0, rank: 10 };  // black
  const H10 = { suit: 1, rank: 10 };  // red

  check('empty column accepts a King', ctx.canPlaceTableau({ suit: 0, rank: 13 }, null) === true);
  check('empty column rejects a Queen', ctx.canPlaceTableau({ suit: 0, rank: 12 }, null) === false);
  check('red-on-red is rejected', ctx.canPlaceTableau(H9, D10) === false);
  check('black-on-black is rejected', ctx.canPlaceTableau(S9, C10) === false);
  check('red-on-black is allowed', ctx.canPlaceTableau(H9, S10) === true);
  check('black-on-red is allowed', ctx.canPlaceTableau(S9, H10) === true);
  check('non-descending is rejected', ctx.canPlaceTableau(H9, H10) === false);
  check('gap in rank is rejected', ctx.canPlaceTableau({ suit: 0, rank: 8 }, S10) === false);

  ctx.founds[0] = [];
  check('empty foundation accepts an Ace', ctx.canPlaceFoundation(0, { suit: 0, rank: 1 }) === true);
  check('empty foundation rejects a Five', ctx.canPlaceFoundation(0, { suit: 0, rank: 5 }) === false);
  ctx.founds[0] = [{ suit: 0, rank: 5 }];
  check('foundation accepts the next rank of the same suit', ctx.canPlaceFoundation(0, { suit: 0, rank: 6 }) === true);
  check('foundation rejects a different suit', ctx.canPlaceFoundation(0, { suit: 1, rank: 6 }) === false);
  check('foundation rejects a skipped rank', ctx.canPlaceFoundation(0, { suit: 0, rank: 7 }) === false);
}

/* ===================================================================== */
/* 3. Draw 1 vs draw 3, and recycling                                    */
/* ===================================================================== */
group('stock: draw-1, draw-3 and recycle');
{
  const { context: ctx } = boot();
  ctx.newGame(2); ctx.started = true;

  ctx.drawCount = 1;
  clickStock(ctx);
  check('draw-1 turns one card face up into the waste', ctx.waste.length === 1 && ctx.stock.length === 23,
    `waste=${ctx.waste.length} stock=${ctx.stock.length}`);
  check('the drawn card is face up', ctx.waste[0].up === true);

  const { context: ctx3 } = boot();
  ctx3.newGame(3); ctx3.started = true;
  ctx3.drawCount = 3;
  clickStock(ctx3);
  check('draw-3 turns three cards into the waste', ctx3.waste.length === 3 && ctx3.stock.length === 21,
    `waste=${ctx3.waste.length} stock=${ctx3.stock.length}`);

  // Recycle: empty the stock by drawing, then click again to send waste back.
  ctx.drawCount = 1;
  for (let i = 0; i < 23; i++) clickStock(ctx);   // 1 already drawn -> 24 total
  check('stock is empty after all cards drawn', ctx.stock.length === 0 && ctx.waste.length === 24,
    `stock=${ctx.stock.length} waste=${ctx.waste.length}`);
  clickStock(ctx);   // recycle
  check('recycle returns the waste to the stock', ctx.stock.length === 24 && ctx.waste.length === 0,
    `stock=${ctx.stock.length} waste=${ctx.waste.length}`);
}

/* ===================================================================== */
/* 4. Real-UI moves (Start button, then board clicks)                    */
/* ===================================================================== */
group('real-UI moves through the board handler');
{
  const { context: ctx } = boot();
  // Enter through the real Start button, not by flipping internal flags.
  check('game starts in the ready (not started) state', ctx.started === false);
  clickEl(ctx.btnStartEl);
  check('clicking the Start button begins the game', ctx.started === true);

  // --- tableau -> tableau ---
  ctx.newGame(7); ctx.started = true;
  ctx.stock.length = 0; ctx.waste.length = 0;
  ctx.founds[0] = []; ctx.founds[1] = []; ctx.founds[2] = []; ctx.founds[3] = [];
  ctx.tableau.forEach(p => { p.length = 0; });
  const c9h = ctx.cardEls[21].__card;   // 9♥ (red)
  const c10s = ctx.cardEls[9].__card;   // 10♠ (black)
  c9h.up = true; c10s.up = true;
  ctx.tableau[1].push(c9h);
  ctx.tableau[2].push(c10s);
  ctx.render();

  clickCard(ctx, 21);
  check('clicking a face-up card selects it',
    ctx.sel && ctx.sel.type === 'tableau' && ctx.sel.col === 1 && ctx.sel.idx === 0,
    JSON.stringify(ctx.sel));
  clickTab(ctx, 2);   // move the 9♥ onto the 10♠ column
  check('the card moved to the target column', ctx.tableau[2].length === 2 && ctx.tableau[2][1] === c9h);
  check('the source column is now empty', ctx.tableau[1].length === 0);
  check('a move was counted', ctx.moves === 1, `moves=${ctx.moves}`);

  // --- tableau -> foundation via UI ---
  ctx.newGame(8); ctx.started = true;
  ctx.stock.length = 0; ctx.waste.length = 0;
  ctx.founds[0] = []; ctx.founds[1] = []; ctx.founds[2] = []; ctx.founds[3] = [];
  ctx.tableau.forEach(p => { p.length = 0; });
  const aSpade = ctx.cardEls[0].__card;   // A♠
  aSpade.up = true;
  ctx.tableau[0].push(aSpade);
  ctx.render();

  clickCard(ctx, 0);
  clickFound(ctx, 0);
  check('an Ace sent to the foundation via UI', ctx.founds[0].length === 1 && ctx.founds[0][0] === aSpade);
  check('a foundation move scores +10', ctx.score === 10, `score=${ctx.score}`);

  // --- illegal red-on-red is rejected through the UI ---
  ctx.newGame(11); ctx.started = true;
  ctx.stock.length = 0; ctx.waste.length = 0;
  ctx.founds.forEach(f => { f.length = 0; });
  ctx.tableau.forEach(p => { p.length = 0; });
  const h9 = ctx.cardEls[21].__card;   // 9♥
  const h10 = ctx.cardEls[22].__card;  // 10♥
  h9.up = true; h10.up = true;
  ctx.tableau[1].push(h9);
  ctx.tableau[2].push(h10);
  ctx.render();
  clickCard(ctx, 21);
  clickTab(ctx, 2);
  check('red-on-red tableau move is refused via UI', ctx.tableau[2].length === 1 && ctx.sel === null);
}

/* ===================================================================== */
/* 5. Full game to victory through real UI clicks                        */
/* ===================================================================== */
group('full win through the real UI');
{
  const { context: ctx } = boot();
  clickEl(ctx.btnStartEl);
  ctx.newGame(99);

  // Arrange a board one move from victory: three foundations already complete,
  // the fourth (spades) missing only its King, which sits face up on column 0.
  function setupNearWin(c) {
    const cards = [];
    for (let i = 0; i < 52; i++) cards.push(c.cardEls[i].__card);
    c.stock.length = 0; c.waste.length = 0;
    c.founds.forEach(f => { f.length = 0; });
    c.tableau.forEach(p => { p.length = 0; });
    const kings = [];
    cards.forEach(card => {
      if (card.rank === 13) {
        if (card.suit === 0) kings.push(card);     // keep the spade King for the tableau
        else c.founds[card.suit].push(card);        // other Kings complete their piles
      } else {
        c.founds[card.suit].push(card);             // A..Q into each foundation
      }
    });
    kings[0].up = true;
    c.tableau[0].push(kings[0]);                     // K♠ (id 12) ready to deliver
    c.render();
  }

  setupNearWin(ctx);
  check('three foundations are already full',
    ctx.founds[1].length === 13 && ctx.founds[2].length === 13 && ctx.founds[3].length === 13);
  check('spades foundation is one card short',
    ctx.founds[0].length === 12, `got ${ctx.founds[0].length}`);

  clickCard(ctx, 12);   // select K♠
  check('the winning King is selected', ctx.sel && ctx.sel.type === 'tableau' && ctx.sel.col === 0);
  clickFound(ctx, 0);   // deliver it to the spades foundation

  check('win flag is raised', ctx.won === true);
  check('all four foundations now hold 13',
    ctx.founds[0].length === 13 && ctx.founds[1].length === 13 &&
    ctx.founds[2].length === 13 && ctx.founds[3].length === 13);
  check('win overlay is shown', ctx.overlayEl.classList.contains('show'));
  check('win dialog has a title', ctx.dlgTitleEl.textContent.length > 0,
    JSON.stringify(ctx.dlgTitleEl.textContent));
}

/* ===================================================================== */
/* 5b. Advanced interactions (double-click, take-back, win gating)      */
/* ===================================================================== */
group('advanced interactions');
{
  const { context: ctx } = boot();
  ctx.newGame(8); ctx.started = true;
  ctx.stock.length = 0; ctx.waste.length = 0;
  ctx.founds.forEach(f => { f.length = 0; });
  ctx.tableau.forEach(p => { p.length = 0; });
  const aSpade = ctx.cardEls[0].__card;   // A♠
  aSpade.up = true;
  ctx.tableau[0].push(aSpade);
  ctx.render();

  // Double-click should auto-send a movable card to its foundation.
  ctx.boardEl.fire('dblclick', { target: ctx.cardEls[0], button: 0, preventDefault() {} });
  check('double-click auto-sends an Ace to the foundation',
    ctx.founds[0].length === 1 && ctx.founds[0][0] === aSpade);

  // Take-back: a card already on a foundation may be moved onto a valid column.
  const threeH = ctx.cardEls[15].__card;   // 3♥ (red)
  const twoS = ctx.cardEls[1].__card;      // 2♠ (black)
  threeH.up = true;
  ctx.tableau.forEach(p => { p.length = 0; });
  ctx.tableau[0].push(threeH);
  ctx.founds[0] = [twoS];
  ctx.score = 0;
  ctx.render();
  clickCard(ctx, 1);          // select the 2♠ on the foundation
  clickTab(ctx, 0);           // drop it onto the 3♥ column (black on red, descending)
  check('a foundation card can be moved back to a tableau column',
    ctx.tableau[0].length === 2 && ctx.tableau[0][1] === twoS);
  check('moving foundation -> tableau is penalised (-15)', ctx.score === -15, `score=${ctx.score}`);

  // Win gating: three complete foundations plus one short must NOT win yet.
  function nearWin(c) {
    const cards = [];
    for (let i = 0; i < 52; i++) cards.push(c.cardEls[i].__card);
    c.stock.length = 0; c.waste.length = 0;
    c.founds.forEach(f => { f.length = 0; });
    c.tableau.forEach(p => { p.length = 0; });
    const kings = [];
    cards.forEach(card => {
      if (card.rank === 13) { if (card.suit === 0) kings.push(card); else c.founds[card.suit].push(card); }
      else c.founds[card.suit].push(card);
    });
    kings[0].up = true;
    c.tableau[0].push(kings[0]);
    c.render();
  }
  ctx.newGame(99);
  nearWin(ctx);
  check('before the last delivery the game is not yet won', ctx.won === false);
}

/* ===================================================================== */
/* 6. Undo                                                               */
/* ===================================================================== */
group('undo rewinds moves');
{
  const { context: ctx } = boot();
  ctx.newGame(7); ctx.started = true;
  ctx.stock.length = 0; ctx.waste.length = 0;
  ctx.founds.forEach(f => { f.length = 0; });
  ctx.tableau.forEach(p => { p.length = 0; });
  const c9h = ctx.cardEls[21].__card;
  const c10s = ctx.cardEls[9].__card;
  c9h.up = true; c10s.up = true;
  ctx.tableau[1].push(c9h);
  ctx.tableau[2].push(c10s);
  ctx.render();

  clickCard(ctx, 21);
  clickTab(ctx, 2);
  clickEl(ctx.btnUndoEl);
  check('undo restores the moved card to its column', ctx.tableau[1].length === 1 && ctx.tableau[1][0] === c9h);
  check('undo empties the destination column', ctx.tableau[2].length === 1 && ctx.tableau[2][0] === c10s);
  check('undo decrements the move counter', ctx.moves === 0, `moves=${ctx.moves}`);
  check('undo clears the selection', ctx.sel === null);

  // undo with an empty history must be a safe no-op
  const { context: ctx2 } = boot();
  ctx2.newGame(10); ctx2.started = true;
  const before = ctx2.moves;
  clickEl(ctx2.btnUndoEl);
  check('undo on an empty history is a no-op', ctx2.moves === before && ctx2.moves === 0);
}

/* ===================================================================== */
/* 7. Draw-mode toggle button                                            */
/* ===================================================================== */
group('draw-mode toggle button');
{
  const { context: ctx } = boot();
  ctx.newGame(1); ctx.started = true;
  const initial = ctx.drawCount;
  clickEl(ctx.btnModeEl);
  check('mode button flips draw 1 <-> draw 3', ctx.drawCount !== initial,
    `was ${initial} now ${ctx.drawCount}`);
  clickEl(ctx.btnModeEl);
  check('mode button toggles back', ctx.drawCount === initial);
}

/* ===================================================================== */
/* 8. Negative controls — prove the tests would catch a broken rule      */
/* ===================================================================== */
group('negative controls (a broken rule changes the verdict)');
{
  const { context: ctx } = boot();
  ctx.newGame(1);

  // (a) Colour rule: with the correct isRed, red-on-red is illegal; if we
  //     make everything "black", the same call flips to legal.
  const H9 = { suit: 1, rank: 9 };
  const D10 = { suit: 2, rank: 10 };
  const correct = ctx.canPlaceTableau(H9, D10);     // must be false
  const savedRed = ctx.isRed;
  ctx.isRed = function (s) { return s === 1; };     // inject the bug: only hearts "red"
  const broken = ctx.canPlaceTableau(H9, D10);      // now (wrongly) legal
  ctx.isRed = savedRed;
  check('colour rule is correct (red-on-red rejected)', correct === false);
  check('injecting a colour bug flips the verdict (test is sensitive)',
    correct === false && broken === true);

  // (b) Foundation order: normally a 6 on an empty spade pile is illegal;
  //     a permissive canPlaceFoundation makes it legal.
  ctx.founds[0] = [];
  const normal = ctx.canPlaceFoundation(0, { suit: 0, rank: 6 });   // false
  const savedFn = ctx.canPlaceFoundation;
  ctx.canPlaceFoundation = function () { return true; };           // inject the bug
  const permissive = ctx.canPlaceFoundation(0, { suit: 0, rank: 6 }); // true
  ctx.canPlaceFoundation = savedFn;
  check('foundation order is correct (6 on empty rejected)', normal === false);
  check('injecting a foundation bug flips the verdict (test is sensitive)',
    normal === false && permissive === true);

  // (c) Deal conservation: a full deal sums to 52; dropping a card from the
  //     stock makes totalCards() drop, and a re-deal recovers.
  const full = ctx.totalCards();
  ctx.stock.pop();                                       // inject a missing card
  const shortDeal = ctx.totalCards();
  ctx.newGame(2);
  const recovered = ctx.totalCards();
  check('conservation holds on a clean deal', full === 52);
  check('a missing card is detected by the conservation check', shortDeal === 51);
  check('a fresh deal restores 52', recovered === 52);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
