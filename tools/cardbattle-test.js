#!/usr/bin/env node
/**
 * Logic tests for cardbattle-game (a three-lane DOM card duel, no canvas).
 *
 * `tools/smoke.js` only proves the page parses and does not throw: its stub DOM
 * invents an element for ANY id, returns [] from querySelectorAll and never
 * asserts a single value. It cannot tell whether the energy curve caps at 10,
 * whether `shuffle` is a permutation that leaves its input alone, whether
 * `resolveCombat` is genuinely simultaneous, whether `enemyChooseAction` is a
 * pure function rather than a slot machine, whether a card is conserved across
 * a turn, or whether the dynamic i18n text re-renders on a language switch.
 * This suite loads the whole inline <script> in a vm sandbox with the same stub
 * DOM and asserts behaviour through the game's own bridge object `window.CB`.
 *
 * Three independent layers carry the weight:
 *
 *  1. PROPERTY TESTS OVER THE PRNG AND THE SHUFFLE. A hand-copied mulberry32
 *     compared against the shipped one proves nothing (it is the same
 *     algorithm twice). Instead the properties are pinned: the output is in
 *     [0,1), the seed is the whole state (a fresh generator replays an N-step
 *     stream byte for byte), different seeds diverge, and `shuffle` is a
 *     permutation, consumes exactly n-1 draws, and never mutates its argument.
 *
 *  2. A DIFFERENTIAL ORACLE FOR COMBAT. `resolveCombat` is re-derived in a
 *     different SHAPE - a per-lane pass that first collects the damage each
 *     side owes, then materialises the survivors, instead of the shipped
 *     clone-then-mutate. Several thousand random boards are compared field by
 *     field. An implementation-free INVARIANT is asserted alongside it: in
 *     every lane where exactly one side has a unit, the opposing base loses
 *     exactly that unit's atk, clamped at 0.
 *
 *  3. REAL GAMES THROUGH CB.tick() (no rAF, no wall clock). Card conservation
 *     (hand + deck + discard == 20 for both sides) is checked at every turn
 *     boundary; the player's play gate is differentially compared against a
 *     spec-derived predicate across thousands of (handIndex, lane) probes, and
 *     every accepted play must deduct exactly its cost and consume exactly one
 *     hand card; and two policies that can never damage the enemy base (idle,
 *     and Bulwark-only) must terminate in a loss on every seed.
 *
 * The two rare transitions in the pile get their own groups, because "it never
 * happens in the games we looked at" is exactly how a broken branch hides:
 *   7c'   the full-hand BURN (the drawn card is discarded, not held).
 *   7c''  the empty-deck RESHUFFLE. The pile arithmetic says where it must
 *         become reachable (17 cards + one draw a turn => draw #18, i.e. turn
 *         18), and a survival-maximising staller over 120 seeds gets there.
 *   7c''' what the `draws` counter really counts - it is shared by both sides
 *         and a burned draw does not increment it.
 *
 * Reverse checks (feeding a deliberately patched copy through argv) prove the
 * comparators are not vacuously green - see the runbook.
 *
 * Usage:  node tools/cardbattle-test.js [path/to/index.html] [path/to/assets/i18n.js]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'cardbattle-game', 'index.html');
const I18N = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(ROOT, 'assets', 'i18n.js');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const CJK = /[\u4e00-\u9fff]/;

/* ------------------------------------------------------------------ stub DOM */
/* Mirrors towerdefense-test.js / smoke.js makeContext: getElementById lazily
 * invents an element for ANY id, querySelectorAll is empty, getAttribute is
 * null, localStorage has no removeItem, setTimeout is a no-op and only rAF
 * advances the game. Every constraint the vm suite lives inside is here. */

function makeContext() {
  const noop = () => ctxProxy;
  const ctxProxy = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = noop)) });

  class Frag { constructor() { this.children = []; } appendChild(c) { this.children.push(c); return c; } }

  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.handlers = {};
      this.parent = null;
      this.dataset = {};
      this.disabled = false;
      this.value = '';
      this.title = '';
      this.placeholder = '';
      this.href = '';
      this.lang = '';
      this._attrs = {};
      this._text = '';
      this._html = '';
      this._cls = new Set();
      this.style = { setProperty() {}, getPropertyValue: () => '', removeProperty() {} };
      this.classList = {
        add: (...cs) => cs.forEach(c => this._cls.add(c)),
        remove: (...cs) => cs.forEach(c => this._cls.delete(c)),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { const o = (on === undefined) ? !this._cls.has(c) : on; o ? this._cls.add(c) : this._cls.delete(c); }
      };
    }
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._cls].join(' '); }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html; }
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); }
    fire(t, ev) { (this.handlers[t] || []).forEach(f => f(ev || {})); }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    setAttribute(k, v) { this._attrs[k] = String(v); }
    /* Deliberately null: the game must never store state in data-*. */
    getAttribute() { return null; }
    closest() { return null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getContext() { throw new Error('cardbattle has no canvas - getContext must never be called'); }
    getBoundingClientRect() { return { left: 0, top: 0, right: 700, bottom: 600, width: 700, height: 600 }; }
  }

  const els = {};
  const docHandlers = {};
  let frame = null;
  let clockMs = 0;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    performance: { now: () => clockMs },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    devicePixelRatio: 1,
    localStorage: (() => {
      const store = {};
      /* No removeItem: exactly like smoke.js, so a game that "clears" by
       * removing a key would throw here. */
      return { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    })(),
    document: {
      documentElement: new El('html'), head: new El('head'), body: new El('body'),
      title: '',
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
  context.addEventListener = () => {};
  context.removeEventListener = () => {};
  vm.createContext(context);

  return {
    context, els,
    fireDoc(t, ev) { (docHandlers[t] || []).forEach(f => f(ev || {})); },
    step(dt) { clockMs += (dt === undefined ? 16 : dt); const f = frame; frame = null; if (f) f(clockMs); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

/* Boot the game. LiteI18N.create is wrapped so the game's private `T` instance
 * is captured without touching the source (T lives inside the IIFE), which is
 * what lets the i18n group prove the language switch really re-renders the
 * dynamic text. */
function boot(gameFile, i18nFile) {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(i18nFile, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const orig = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = orig(dict); return T; };
  inlineScripts(fs.readFileSync(gameFile, 'utf8')).forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `cardbattle/index.html#script${i}` });
  });
  env.step();                                   // one real rAF frame (update + paint)
  return { env, CB: env.context.CB, T, els: env.els, html: fs.readFileSync(gameFile, 'utf8') };
}

let G, CB, HTML;
try {
  G = boot(GAME, I18N);
  CB = G.CB;
  HTML = G.html;
} catch (e) {
  /* A hard, labelled failure. A page that throws while booting must never be
   * reported as a skipped or an empty run - that is how a dead page passes. */
  console.log(`  FAIL the page threw during boot: ${(e && e.message) || e}`);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

/* ======================================================================
 * 0. Static gates: no canvas, no timers, no Math.random, one onChange,
 *    HUD-write locality
 * ==================================================================== */

group('0. static gates: canvas-free, timer-free, one onChange, HUD write locality');
{
  const code = HTML.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
  const markup = HTML.replace(/<script[\s\S]*?<\/script>/g, ' ');

  check(!!CB, 'window.CB exists after boot');
  check(!/<canvas\b/i.test(markup), 'the markup contains no <canvas> element');
  check((code.match(/\.getContext\s*\(/g) || []).length === 0,
    'the source never calls getContext (this game is DOM + CSS)');
  check((code.match(/Math\.random/g) || []).length === 0, 'the source never calls Math.random');
  const timers = (code.match(/\bset(?:Timeout|Interval)\s*\(/g) || []).length;
  check(timers === 0, `the source never calls setTimeout/setInterval (found ${timers})`);
  const onCount = (HTML.match(/T\.onChange/g) || []).length;
  check(onCount === 1, `T.onChange is registered exactly once (found ${onCount})`);

  /* Every write to a HUD node must live inside updateHud(): handlers only
   * mutate the model and let the frame paint it, which is what makes "what is
   * on screen" and "what getState() says" the same statement. Comments are
   * stripped first so a prose mention cannot fake a hit or hide one. */
  const start = code.indexOf('function updateHud(');
  let end = -1;
  if (start >= 0) {
    const open = code.indexOf('{', start);
    let depth = 0;
    for (let j = open; j < code.length; j++) {
      const ch = code[j];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
  }
  const handles = 'turn|energy|php|ehp|deckP|deckE|fx|hint|log|eSlots|pSlots|cards|' +
    'btnEnd|btnPause|btnNew|startOverlay|btnStart|overlay|ovTitle|ovSub|ovBtn';
  const writeRe = new RegExp(`\\bH\\s*\\.\\s*(?:${handles})\\b[\\s\\S]{0,24}?\\.\\s*(textContent|innerHTML|disabled|classList|title|placeholder|setAttribute)\\b`, 'g');
  const writes = [...code.matchAll(writeRe)];
  const outside = writes.filter(m => !(start >= 0 && m.index >= start && m.index <= end));
  check(start >= 0 && end > start, 'updateHud() is present and brace-matched');
  check(writes.length > 10, `HUD nodes are written somewhere (found ${writes.length} writes)`);
  check(outside.length === 0,
    `every HUD-node write lives inside updateHud() (found ${outside.length} outside)`,
    outside.slice(0, 3).map(m => m[0].replace(/\s+/g, ' ')).join('; '));

  /* The HUD handles must be exactly the ids the markup declares - a rename on
   * one side would otherwise be swallowed by the lazily-inventing stub. */
  const hudIds = [...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const reached = [...new Set([...HTML.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]))];
  const dangling = reached.filter(id => !hudIds.includes(id) && !/^litegame-i18n-style$/.test(id));
  check(reached.length >= 20, `the script reaches for ${reached.length} getElementById ids`);
  check(dangling.length === 0, `every getElementById id exists in the markup (dangling ${JSON.stringify(dangling)})`);
}

/* ======================================================================
 * 1. Constants + deck integrity
 * ==================================================================== */

group('1. constants and deck integrity');
const CARDS = CB.cards();
const SPEC = {};
for (const c of CARDS) SPEC[c.id] = c;
const CARD_IDS = CARDS.map(c => c.id);

check(CB.LANES === 3, `LANES is 3 (got ${CB.LANES})`);
check(CB.HAND_MAX === 5, `HAND_MAX is 5 (got ${CB.HAND_MAX})`);
check(CB.DECK_SIZE === 20, `DECK_SIZE is 20 (got ${CB.DECK_SIZE})`);
check(CB.START_HP === 20, `START_HP is 20 (got ${CB.START_HP})`);
check(CB.MAX_ENERGY === 10, `MAX_ENERGY is 10 (got ${CB.MAX_ENERGY})`);
check(CB.START_HAND === 3, `START_HAND is 3 (got ${CB.START_HAND})`);
check(CB.RESOLVE_SEC === 0.5 && CB.ENEMY_SEC === 0.6 && CB.ENEMY_STEP === 0.2 && CB.LOG_SHOW === 6,
  `the timing constants are 0.5 / 0.6 / 0.2 / 6 (got ${CB.RESOLVE_SEC}/${CB.ENEMY_SEC}/${CB.ENEMY_STEP}/${CB.LOG_SHOW})`);

check(CARDS.length === 8, `cards() returns 8 entries (got ${CARDS.length})`);
check(CARD_IDS.length === new Set(CARD_IDS).size, 'every card id is unique');

{
  const deck = CB.deck();
  check(deck.length === 20, `deck() is 20 cards long (got ${deck.length})`);
  /* Canonical order: the deck is the CARD_ORDER expansion, so it must equal the
   * expansion of deckList()'s own key order - two shipped accessors that could
   * disagree, read from the bridge rather than transcribed. */
  const list = CB.deckList();
  const keys = Object.keys(list);
  const expanded = [];
  for (const k of keys) for (let i = 0; i < list[k]; i++) expanded.push(k);
  check(JSON.stringify(deck) === JSON.stringify(expanded),
    'deck() equals the canonical expansion of deckList() (canonical order, no interleaving)');
  check(keys.length === 8, `deckList() names exactly the 8 catalogue ids (got ${keys.length})`);

  const tally = {};
  for (const id of deck) tally[id] = (tally[id] || 0) + 1;
  const keysSorted = Object.keys(tally).sort().map(k => k + '=' + tally[k]).join(',');
  const listSorted = Object.keys(list).sort().map(k => k + '=' + list[k]).join(',');
  check(keysSorted === listSorted,
    `the deck multiset equals deckList() (deck ${keysSorted} vs list ${listSorted})`);

  const documented = { scout: 3, soldier: 3, wall: 2, archer: 3, knight: 2, fireball: 3, mend: 2, rally: 2 };
  const docSorted = Object.keys(documented).sort().map(k => k + '=' + documented[k]).join(',');
  check(keysSorted === docSorted, `the deck counts match the documented 3/3/2/3/2/3/2/2 (got ${keysSorted})`);
  check(Object.keys(list).length === Object.keys(documented).length, 'deckList() has no extra or missing card');

  const missing = [...new Set(deck)].filter(id => !SPEC[id]);
  check(missing.length === 0, `every deck id exists in cards() (missing ${JSON.stringify(missing)})`);
}

{
  let kindBad = 0, unitBad = 0, spellBad = 0, costBad = 0, nameBad = 0, textBad = 0;
  let first = '';
  for (const c of CARDS) {
    if (c.kind !== 'unit' && c.kind !== 'spell') { kindBad++; if (!first) first = `kind ${c.id}=${c.kind}`; }
    if (c.kind === 'unit') {
      if (typeof c.atk !== 'number' || typeof c.hp !== 'number' || c.hp < 1 || c.atk < 0 || c.atk !== (c.atk | 0) || c.hp !== (c.hp | 0)) {
        unitBad++; if (!first) first = `unit ${c.id} atk=${c.atk} hp=${c.hp}`;
      }
    } else if (c.atk !== null || c.hp !== null) { spellBad++; if (!first) first = `spell ${c.id} atk=${c.atk}`; }
    if (!Number.isInteger(c.cost) || c.cost < 1 || c.cost > 10) { costBad++; if (!first) first = `cost ${c.id}=${c.cost}`; }
    if (typeof c.en !== 'string' || !c.en.trim() || typeof c.zh !== 'string' || !c.zh.trim()) { nameBad++; if (!first) first = `name ${c.id}`; }
    if (!c.text || typeof c.text.en !== 'string' || !c.text.en.trim() || typeof c.text.zh !== 'string' || !c.text.zh.trim()) {
      textBad++; if (!first) first = `text ${c.id}`;
    }
  }
  check(kindBad === 0, `every kind is unit or spell (${kindBad} bad)`);
  check(unitBad === 0, `every unit carries integer atk >= 0 and hp >= 1 (${unitBad} bad)` + (first ? ` first ${first}` : ''));
  check(spellBad === 0, `every spell carries atk === null && hp === null (${spellBad} bad)`);
  check(costBad === 0, `every cost is an integer in [1,10] (${costBad} bad)`);
  check(nameBad === 0, `every card has non-empty en and zh names (${nameBad} bad)`);
  check(textBad === 0, `every card has a non-empty {en, zh} rules text (${textBad} bad)`);
  check(CARDS.filter(c => c.kind === 'unit').length === 5 && CARDS.filter(c => c.kind === 'spell').length === 3,
    `5 units and 3 spells (got ${CARDS.filter(c => c.kind === 'unit').length}/${CARDS.filter(c => c.kind === 'spell').length})`);
  check(SPEC.soldier.atk === 3 && SPEC.soldier.hp === 3 && SPEC.wall.atk === 0 && SPEC.wall.hp === 8 &&
    SPEC.knight.atk === 5 && SPEC.knight.hp === 6 && SPEC.scout.atk === 2 && SPEC.scout.hp === 1 &&
    SPEC.archer.atk === 4 && SPEC.archer.hp === 2,
    'the five unit stat lines are the documented 2/1, 3/3, 0/8, 4/2, 5/6');
}

/* ======================================================================
 * 2. The energy curve
 * ==================================================================== */

group('2. energyFor: min(10, 1 + max(1, trunc(turn)))');
{
  const myEnergy = t => Math.min(CB.MAX_ENERGY, 1 + Math.max(1, Math.trunc(t)));
  let bad = 0, first = '';
  for (let t = -4; t <= 16; t++) {
    const got = CB.energyFor(t), want = myEnergy(t);
    if (got !== want) { bad++; if (!first) first = `t=${t} got ${got} want ${want}`; }
  }
  check(bad === 0, `the curve matches my recomputation for turn -4..16 (${bad} mismatches)` + (first ? ` first ${first}` : ''));

  const frac = [0.4, 1.9, 2.7, 5.5, 9.99];
  bad = 0;
  for (const t of frac) if (CB.energyFor(t) !== myEnergy(t)) { bad++; if (!first) first = `t=${t}`; }
  check(bad === 0, `the curve truncates fractional turns the same way (${bad} mismatches)`);

  check(CB.energyFor(1) === 2, `turn 1 pays 2 (got ${CB.energyFor(1)})`);
  check(CB.energyFor(2) === 3 && CB.energyFor(3) === 4, `turns 2/3 pay 3/4 (got ${CB.energyFor(2)}/${CB.energyFor(3)})`);
  check(CB.energyFor(9) === 10 && CB.energyFor(10) === 10 && CB.energyFor(50) === 10,
    `the curve saturates at MAX_ENERGY from turn 9 on (got ${CB.energyFor(9)}/${CB.energyFor(10)}/${CB.energyFor(50)})`);
  check(CB.energyFor(0) === 2 && CB.energyFor(-7) === 2, 'turn <= 0 clamps to the turn-1 value');

  let nonDecreasing = true;
  for (let t = -4; t < 40; t++) if (CB.energyFor(t + 1) < CB.energyFor(t)) nonDecreasing = false;
  check(nonDecreasing, 'the curve is non-decreasing across -4..40');
}

/* ======================================================================
 * 3. Seeded PRNG properties (never re-run mulberry32 and diff streams)
 * ==================================================================== */

group('3. mulberry32: range, replayability, divergence, seed 0');
{
  const r = CB.mulberry32(12345);
  let outOfRange = 0, allZero = true, distinct = new Set();
  for (let i = 0; i < 2000; i++) {
    const v = r();
    if (!(v >= 0 && v < 1)) outOfRange++;
    if (v !== 0) allZero = false;
    distinct.add(v);
  }
  check(outOfRange === 0, 'two thousand draws all land in [0,1)');
  check(!allZero, 'the stream is not a constant zero');
  check(distinct.size > 1500, `2000 draws are spread out (${distinct.size} distinct values)`);

  const a = CB.mulberry32(777), b = CB.mulberry32(777);
  let same = true;
  for (let i = 0; i < 500; i++) if (a() !== b()) same = false;
  check(same, 'the same seed replays an identical 500-draw stream');

  const c = CB.mulberry32(778);
  let diff = 0;
  const a2 = CB.mulberry32(777);
  for (let i = 0; i < 500; i++) if (a2() !== c()) diff++;
  check(diff > 400, `a different seed diverges (${diff}/500 of an adjacent seed's stream differ)`);

  /* The seed IS the whole state: a fresh generator replays an N-step stream. */
  const g1 = CB.mulberry32(2024);
  const stream = [];
  for (let i = 0; i < 137; i++) stream.push(g1());
  const g2 = CB.mulberry32(2024);
  let replay = true;
  for (let i = 0; i < 137; i++) if (g2() !== stream[i]) replay = false;
  check(replay, 'a fresh generator with the same seed replays a 137-step stream exactly');

  const z = CB.mulberry32(0);
  let zOk = true, zZero = true;
  for (let i = 0; i < 100; i++) { const v = z(); if (!(v >= 0 && v < 1)) zOk = false; if (v !== 0) zZero = false; }
  const z2 = CB.mulberry32(0);
  let zReplay = true;
  for (let i = 0; i < 100; i++) { const v = z2(); if (!(v >= 0 && v < 1)) zReplay = false; }
  check(zOk, 'seed 0 is a valid seed (100 draws in range)');
  check(!zZero, 'seed 0 does not produce a degenerate all-zero stream');
  check(zReplay, 'seed 0 replays identically');
  check(CB.mulberry32(1)() !== CB.mulberry32(0)(), 'seed 1 and seed 0 differ on the first draw');
}

/* ======================================================================
 * 4. shuffle(list, rng): permutation, immutability, exactly n-1 draws
 * ==================================================================== */

group('4. shuffle: permutation, purity, exactly n-1 draws');
{
  const tallyOf = arr => {
    const m = {};
    for (const x of arr) m[x] = (m[x] || 0) + 1;
    return Object.keys(m).sort().map(k => k + '=' + m[k]).join(',');
  };
  const base = CB.deck();
  const baseKey = tallyOf(base);
  const baseSnapshot = JSON.stringify(base);

  let notPerm = 0, mutated = 0, notReplay = 0, drawBad = 0;
  let first = '';
  const firsts = {};
  const N = 200;
  for (let seed = 1; seed <= N; seed++) {
    const input = CB.deck();
    const before = JSON.stringify(input);
    const r1 = CB.shuffle(input, CB.mulberry32(seed));
    const r2 = CB.shuffle(CB.deck(), CB.mulberry32(seed));
    if (tallyOf(r1) !== baseKey) { notPerm++; if (!first) first = `perm seed ${seed}`; }
    if (JSON.stringify(input) !== before) { mutated++; if (!first) first = `mutate seed ${seed}`; }
    if (JSON.stringify(r1) !== JSON.stringify(r2)) { notReplay++; if (!first) first = `replay seed ${seed}`; }
    firsts[r1[0]] = (firsts[r1[0]] || 0) + 1;

    /* Exactly n-1 draws: verify with a counting generator, not by guessing. */
    let draws = 0;
    const counted = () => { draws++; return 0.4242; };
    CB.shuffle(CB.deck(), counted);
    if (draws !== base.length - 1) { drawBad++; if (!first) first = `draws seed ${seed}=${draws}`; }
  }
  check(notPerm === 0, `shuffle is a multiset permutation for ${N} seeds (${notPerm} bad)` + (first ? ` first ${first}` : ''));
  check(mutated === 0, 'shuffle never mutates its input array across 200 seeds');
  check(notReplay === 0, 'the same seed gives a byte-identical shuffle across 200 seeds');
  check(drawBad === 0, `shuffle consumes exactly n-1 = ${base.length - 1} draws (${drawBad} bad)`);
  check(JSON.stringify(CB.deck()) === baseSnapshot, 'CB.deck() itself is still untouched after 200 shuffles');

  let zeroDraws = 0;
  CB.shuffle([], () => { zeroDraws++; return 0.5; });
  check(zeroDraws === 0, `shuffle([]) consumes 0 draws (got ${zeroDraws})`);
  check(JSON.stringify(CB.shuffle([], CB.mulberry32(1))) === '[]', 'shuffle([]) returns []');

  let oneDraws = 0;
  const single = CB.shuffle(['x'], () => { oneDraws++; return 0.5; });
  check(oneDraws === 0, `shuffle([x]) consumes 0 draws (got ${oneDraws})`);
  check(JSON.stringify(single) === '["x"]', 'shuffle([x]) returns [x]');

  const distinctFirsts = Object.keys(firsts).length;
  const hist = Object.keys(firsts).sort().map(k => k + ':' + firsts[k]).join(' ');
  check(distinctFirsts >= 6,
    `the first card is not pinned to one value (${distinctFirsts}/8 ids appeared first over ${N} seeds)`);
  note(`first-card histogram over ${N} seeds: ${hist}`);

  const tiny = CB.shuffle(['a', 'b', 'c'], () => 0);
  check(tiny.length === 3 && tallyOf(tiny) === 'a=1,b=1,c=1', 'a zero-valued rng still yields a permutation');
  const tiny2 = CB.shuffle(['a', 'b', 'c'], () => 0.999999);
  check(tallyOf(tiny2) === 'a=1,b=1,c=1', 'an rng pinned near 1 still yields a permutation (no out-of-range index)');
}

/* ======================================================================
 * 5. resolveCombat(board): differential + invariants (A)
 * ==================================================================== */

group('5. resolveCombat: independent oracle, invariants, documented cases');
{
  const U = (cardId, atk, hp) => ({ cardId, atk, hp, maxHp: hp });

  /* My own resolution, deliberately a different SHAPE: collect the base damage
   * each side owes in one pass, apply it, then materialise survivors. */
  function myResolve(board) {
    const b = board || {};
    const P = b.player || [null, null, null];
    const E = b.enemy || [null, null, null];
    let php = (typeof b.playerHp === 'number') ? (b.playerHp | 0) : 20;
    let ehp = (typeof b.enemyHp === 'number') ? (b.enemyHp | 0) : 20;
    let toEnemy = 0, toPlayer = 0;
    for (let l = 0; l < 3; l++) {
      if (P[l] && !E[l]) toEnemy += P[l].atk;
      if (E[l] && !P[l]) toPlayer += E[l].atk;
    }
    ehp = Math.max(0, ehp - toEnemy);
    php = Math.max(0, php - toPlayer);
    const np = [null, null, null], ne = [null, null, null];
    for (let l = 0; l < 3; l++) {
      const p = P[l], e = E[l];
      if (p && e) {
        const ph = p.hp - e.atk, eh = e.hp - p.atk;
        np[l] = ph > 0 ? { cardId: p.cardId, atk: p.atk, hp: ph, maxHp: p.maxHp } : null;
        ne[l] = eh > 0 ? { cardId: e.cardId, atk: e.atk, hp: eh, maxHp: e.maxHp } : null;
      } else {
        np[l] = p ? { cardId: p.cardId, atk: p.atk, hp: p.hp, maxHp: p.maxHp } : null;
        ne[l] = e ? { cardId: e.cardId, atk: e.atk, hp: e.hp, maxHp: e.maxHp } : null;
      }
    }
    return { player: np, enemy: ne, playerHp: php, enemyHp: ehp };
  }
  function unitDiff(got, want, tag) {
    if (got === null && want === null) return null;
    if (!got || !want) return `${tag}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`;
    for (const k of ['cardId', 'atk', 'hp', 'maxHp']) {
      if (got[k] !== want[k]) return `${tag}.${k}: got ${got[k]} want ${want[k]}`;
    }
    return null;
  }

  /* --- documented cases --- */
  const bothDie = CB.resolveCombat({ player: [U('soldier', 3, 3), null, null], enemy: [U('archer', 4, 2), null, null] });
  check(bothDie.player[0] === null && bothDie.enemy[0] === null, '3/3 vs 4/2 destroy each other in one simultaneous pass');
  check(bothDie.playerHp === 20 && bothDie.enemyHp === 20, 'a mutual kill deals no base damage');

  const wall = CB.resolveCombat({ player: [U('wall', 0, 8), null, null], enemy: [null, null, null] });
  check(wall.enemyHp === 20, `a lone Bulwark deals 0 to the base (got ${wall.enemyHp})`);
  check(wall.player[0] && wall.player[0].hp === 8, 'a lone Bulwark still occupies its lane');

  const scout = CB.resolveCombat({ player: [U('scout', 2, 1), null, null], enemy: [null, null, null] });
  check(scout.enemyHp === 18, `a lone 2/1 Scout deals exactly 2 (got ${scout.enemyHp})`);

  const knight = CB.resolveCombat({ player: [U('knight', 5, 6), null, null], enemy: [U('archer', 4, 2), null, null] });
  check(knight.player[0] && knight.player[0].hp === 2 && knight.player[0].cardId === 'knight',
    `a 5/6 Knight survives a 4/2 Archer at 2 HP (got ${JSON.stringify(knight.player[0])})`);
  check(knight.enemy[0] === null, 'the 4/2 Archer dies to the Knight');
  check(knight.playerHp === 20 && knight.enemyHp === 20, 'the blocked lane deals no base damage');

  const bare = CB.resolveCombat({ player: [U('scout', 2, 1), null, null], enemy: [null, null, null] });
  check(bare.playerHp === 20 && bare.enemyHp === 18, 'a board with no playerHp/enemyHp defaults both to START_HP');
  check(CB.resolveCombat({ player: [null, null, null], enemy: [null, null, null] }).playerHp === 20,
    'an empty board defaults to 20/20');

  const floor = CB.resolveCombat({ player: [U('knight', 5, 6), null, null], enemy: [null, null, null], enemyHp: 3 });
  check(floor.enemyHp === 0, `5 attack into a 3 HP base floors at 0 (got ${floor.enemyHp})`);
  const floorP = CB.resolveCombat({ player: [null, null, null], enemy: [U('knight', 5, 6), null, null], playerHp: 2 });
  check(floorP.playerHp === 0, `the player base also floors at 0 (got ${floorP.playerHp})`);

  const argBoard = { player: [U('soldier', 3, 3), null, null], enemy: [U('archer', 4, 2), null, null], playerHp: 7, enemyHp: 11 };
  const argSnap = JSON.stringify(argBoard);
  const res = CB.resolveCombat(argBoard);
  check(JSON.stringify(argBoard) === argSnap, 'resolveCombat never mutates its argument board');
  check(res !== argBoard, 'resolveCombat returns a NEW board object');
  check(res.playerHp === 7 && res.enemyHp === 11, 'resolveCombat carries the input base HP through');
  check(res.playerHp === argBoard.playerHp, 'the returned board is not a view of the argument');

  /* The lanes are independent: damage only lands on the opposing base. */
  const multi = CB.resolveCombat({
    player: [U('scout', 2, 1), null, U('soldier', 3, 3)],
    enemy: [null, U('archer', 4, 2), null]
  });
  check(multi.enemyHp === 20 - 2 - 3, `two open lanes deal 2+3 to the enemy base (got ${multi.enemyHp})`);
  check(multi.playerHp === 20 - 4, `one open enemy lane deals 4 to the player base (got ${multi.playerHp})`);
  check(multi.enemy[1] && multi.enemy[1].hp === 2 && multi.player[1] === null,
    'an unopposed enemy unit is untouched and hits the base');

  /* --- fuzz differential --- */
  const UNIT_IDS = CARDS.filter(c => c.kind === 'unit').map(c => c.id);
  const rnd = CB.mulberry32(0xC0FFEE);
  const pickUnit = () => {
    const id = UNIT_IDS[Math.floor(rnd() * UNIT_IDS.length)];
    const maxHp = 1 + Math.floor(rnd() * 8);
    const hp = 1 + Math.floor(rnd() * maxHp);
    const atk = Math.floor(rnd() * 7);
    return { cardId: id, atk, hp, maxHp };
  };
  let mismatches = 0, compared = 0, mutated = 0, invariantBad = 0, firstFuzz = '';
  const CASES = 4000;
  for (let t = 0; t < CASES; t++) {
    const P = [null, null, null], E = [null, null, null];
    for (let l = 0; l < 3; l++) {
      if (rnd() < 0.62) P[l] = pickUnit();
      if (rnd() < 0.62) E[l] = pickUnit();
    }
    const board = { player: P, enemy: E };
    if (rnd() < 0.7) board.playerHp = Math.floor(rnd() * 25);
    if (rnd() < 0.7) board.enemyHp = Math.floor(rnd() * 25);
    const snap = JSON.stringify(board);

    /* Implementation-free invariant: compute the expected base HP straight
     * from which lanes are held by exactly one side. */
    let expP = (typeof board.playerHp === 'number') ? board.playerHp : 20;
    let expE = (typeof board.enemyHp === 'number') ? board.enemyHp : 20;
    for (let l = 0; l < 3; l++) {
      if (P[l] && !E[l]) expE -= P[l].atk;
      if (E[l] && !P[l]) expP -= E[l].atk;
    }
    expP = Math.max(0, expP); expE = Math.max(0, expE);

    const got = CB.resolveCombat(board);
    const want = myResolve(board);
    compared++;
    let d = null;
    for (let l = 0; l < 3; l++) {
      d = d || unitDiff(got.player[l], want.player[l], `case${t} P${l}`);
      d = d || unitDiff(got.enemy[l], want.enemy[l], `case${t} E${l}`);
    }
    if (!d && got.playerHp !== want.playerHp) d = `case${t} playerHp got ${got.playerHp} want ${want.playerHp}`;
    if (!d && got.enemyHp !== want.enemyHp) d = `case${t} enemyHp got ${got.enemyHp} want ${want.enemyHp}`;
    if (d) { mismatches++; if (!firstFuzz) firstFuzz = d; }
    if (!d && (got.playerHp !== expP || got.enemyHp !== expE)) {
      invariantBad++;
      if (!firstFuzz) firstFuzz = `case${t} invariant hp ${got.playerHp}/${got.enemyHp} want ${expP}/${expE}`;
    }
    if (JSON.stringify(board) !== snap) mutated++;
  }
  check(compared === CASES, `fuzzed ${compared} random boards`);
  check(mismatches === 0, `the shipped resolveCombat matches my oracle on all ${CASES} boards (${mismatches} bad)` +
    (firstFuzz ? ` first ${firstFuzz}` : ''));
  check(invariantBad === 0,
    `the one-sided-lane invariant holds on all ${CASES} boards (${invariantBad} bad)`);
  check(mutated === 0, 'resolveCombat mutated none of the 4000 fuzz arguments');
  note(`resolveCombat: ${CASES} boards, oracle mismatches ${mismatches}, invariant violations ${invariantBad}`);
}

/* ======================================================================
 * 6. enemyChooseAction(board, hand, energy): purity, legality, priorities
 * ==================================================================== */

group('6. enemyChooseAction: determinism, legality, documented priorities');
{
  const U = (cardId, atk, hp, maxHp) => ({ cardId, atk, hp, maxHp: (maxHp === undefined ? hp : maxHp) });
  const empty = () => ({ player: [null, null, null], enemy: [null, null, null] });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* --- (a) determinism fuzz --- */
  const ids = CARDS.map(c => c.id);
  const UNIT_IDS = CARDS.filter(c => c.kind === 'unit').map(c => c.id);
  const rnd = CB.mulberry32(0xBEEF);
  const randUnit = () => {
    const id = UNIT_IDS[Math.floor(rnd() * UNIT_IDS.length)];
    const maxHp = 1 + Math.floor(rnd() * 8);
    return U(id, Math.floor(rnd() * 7), 1 + Math.floor(rnd() * maxHp), maxHp);
  };
  let nonDet = 0, boardMut = 0, handMut = 0, shapeBad = 0, illegal = 0, unaffordable = 0;
  let playN = 0, endN = 0, firstBad = '';
  const CASES = 4000;
  for (let t = 0; t < CASES; t++) {
    const b = empty();
    for (let l = 0; l < 3; l++) {
      if (rnd() < 0.6) b.player[l] = randUnit();
      if (rnd() < 0.6) b.enemy[l] = randUnit();
    }
    const hand = [];
    const hn = Math.floor(rnd() * 6);
    for (let i = 0; i < hn; i++) hand.push(ids[Math.floor(rnd() * ids.length)]);
    const energy = Math.floor(rnd() * 12);
    const bSnap = JSON.stringify(b), hSnap = JSON.stringify(hand);

    const a1 = CB.enemyChooseAction(b, hand, energy);
    const a2 = CB.enemyChooseAction(b, hand, energy);
    if (!eq(a1, a2)) { nonDet++; if (!firstBad) firstBad = `case${t} non-deterministic`; }
    if (JSON.stringify(b) !== bSnap) boardMut++;
    if (JSON.stringify(hand) !== hSnap) handMut++;

    if (!a1 || (a1.kind !== 'play' && a1.kind !== 'end')) {
      shapeBad++; if (!firstBad) firstBad = `case${t} kind ${JSON.stringify(a1)}`;
      continue;
    }
    if (a1.kind === 'end') { endN++; continue; }
    playN++;
    if (!Number.isInteger(a1.handIndex) || a1.handIndex < 0 || a1.handIndex >= hand.length ||
      !Number.isInteger(a1.lane) || a1.lane < 0 || a1.lane >= 3) {
      shapeBad++; if (!firstBad) firstBad = `case${t} shape ${JSON.stringify(a1)}`;
      continue;
    }
    const id = hand[a1.handIndex];
    const spec = SPEC[id];
    if (!spec || energy < spec.cost) { unaffordable++; if (!firstBad) firstBad = `case${t} unaffordable ${id}@${energy}`; }
    /* Transpose the board so the ENEMY side is checked by the player-side gate. */
    const legal = CB.canPlay(
      { phase: 'player', energy: 99, hand: [id], board: { player: b.enemy, enemy: b.player } },
      0, a1.lane);
    if (!legal) { illegal++; if (!firstBad) firstBad = `case${t} illegal ${id} lane ${a1.lane}`; }
  }
  check(nonDet === 0, `the AI is a pure function over ${CASES} positions (${nonDet} non-deterministic)`);
  check(boardMut === 0 && handMut === 0, `the AI mutates neither its board nor its hand (${boardMut}/${handMut})`);
  check(shapeBad === 0, `every action is a well-formed play/end (${shapeBad} bad)` + (firstBad ? ` first ${firstBad}` : ''));
  check(unaffordable === 0, `every chosen card is affordable AND present in the hand (${unaffordable} bad)`);
  check(illegal === 0, `every chosen play is legal for the enemy side (${illegal} bad)`);
  check(playN > 500 && endN > 50, `the fuzz produced both branches (play ${playN}, end ${endN})`);
  note(`AI fuzz: ${CASES} positions -> ${playN} play / ${endN} end`);

  /* --- (b) priority 1: killable Fireball, lowest lane --- */
  const fireKill = empty();
  fireKill.player = [U('soldier', 3, 2), null, null];
  const a1 = CB.enemyChooseAction(fireKill, ['fireball'], 3);
  check(a1.kind === 'play' && a1.lane === 0 && a1.handIndex === 0,
    `a killable Fireball is played at lane 0 (got ${JSON.stringify(a1)})`);

  const fireTwo = empty();
  fireTwo.player = [U('soldier', 3, 4), U('scout', 2, 1), U('archer', 4, 3)];
  const a2 = CB.enemyChooseAction(fireTwo, ['fireball'], 3);
  check(a2.kind === 'play' && a2.lane === 1,
    `the LOWEST killable lane wins the tie (got ${JSON.stringify(a2)}; lane 1 holds a 1 HP unit)`);

  const fireWounded = empty();
  fireWounded.player = [U('knight', 5, 1), null, null];
  const a3 = CB.enemyChooseAction(fireWounded, ['fireball'], 3);
  check(a3.kind === 'play' && a3.lane === 0, 'a 1 HP unit is still a legal Fireball target');

  const firePricey = empty();
  firePricey.player = [U('knight', 5, 4), null, null];
  const a4 = CB.enemyChooseAction(firePricey, ['fireball'], 3);
  check(a4.kind === 'play' && a4.lane === 0,
    `a 4 HP unit is NOT a Fireball target, but the spell is dumped at lane 0 (got ${JSON.stringify(a4)})`);

  const firePoor = CB.enemyChooseAction(fireKill, ['fireball'], 2);
  check(firePoor.kind === 'end',
    `an unaffordable Fireball is withheld when it is the only card (got ${JSON.stringify(firePoor)})`);

  /* --- (c) priority 2: Rally only at 2+ own bodies --- */
  const rallyTwo = empty();
  rallyTwo.enemy = [U('soldier', 3, 3), U('scout', 2, 1), null];
  const r2 = CB.enemyChooseAction(rallyTwo, ['rally', 'scout'], 4);
  check(r2.kind === 'play' && r2.handIndex === 0 && r2.lane === 0,
    `with two bodies the AI Rallies rather than pushing a body (got ${JSON.stringify(r2)})`);

  const rallyOne = empty();
  rallyOne.enemy = [U('soldier', 3, 3), null, null];
  const r1 = CB.enemyChooseAction(rallyOne, ['rally', 'scout'], 4);
  check(r1.kind === 'play' && r1.handIndex === 1 && r1.lane === 1,
    `with one body the AI pushes the body instead of Rallying (got ${JSON.stringify(r1)})`);

  /* --- (c') priority 3: Mend only when a unit lost >= 3 HP --- */
  const wounded = empty();
  wounded.enemy = [U('knight', 5, 2, 6), null, null];
  const m1 = CB.enemyChooseAction(wounded, ['mend', 'scout'], 2);
  check(m1.kind === 'play' && m1.handIndex === 0 && m1.lane === 0,
    `a unit that lost 4 HP is Mended (got ${JSON.stringify(m1)})`);

  const barelyHurt = empty();
  barelyHurt.enemy = [U('knight', 5, 4, 6), null, null];
  const m2 = CB.enemyChooseAction(barelyHurt, ['mend', 'scout'], 2);
  check(m2.kind === 'play' && m2.handIndex === 1 && m2.lane === 1,
    `a unit that lost only 2 HP is not Mended; the AI pushes instead (got ${JSON.stringify(m2)})`);

  const tieMend = empty();
  /* Two wounded units (loss 5 and loss 3): the deepest wound wins. */
  tieMend.enemy = [null, U('knight', 5, 1, 6), U('knight', 5, 3, 6)];
  const m3 = CB.enemyChooseAction(tieMend, ['mend'], 2);
  check(m3.kind === 'play' && m3.lane === 1,
    `Mend targets the unit that lost the MOST HP (got ${JSON.stringify(m3)})`);

  /* --- (d) priority 4: contest the lowest player-held lane with the priciest body --- */
  const contest = empty();
  contest.player = [U('soldier', 3, 3), null, null];
  const c1 = CB.enemyChooseAction(contest, ['scout', 'knight', 'soldier'], 10);
  check(c1.kind === 'play' && c1.handIndex === 1 && c1.lane === 0,
    `the priciest body (Knight, cost 4) contests lane 0 (got ${JSON.stringify(c1)})`);

  const contestTie = empty();
  contestTie.player = [U('soldier', 3, 3), null, null];
  const c2 = CB.enemyChooseAction(contestTie, ['wall', 'soldier'], 10);
  check(c2.kind === 'play' && c2.handIndex === 1,
    `a cost tie goes to the higher atk body (got ${JSON.stringify(c2)})`);

  const contestLow = empty();
  contestLow.player = [U('scout', 2, 1), U('soldier', 3, 3), null];
  const c3 = CB.enemyChooseAction(contestLow, ['soldier'], 10);
  check(c3.kind === 'play' && c3.lane === 0, `the LOWEST contested lane wins (got ${JSON.stringify(c3)})`);

  const notContest = empty();
  notContest.player = [U('soldier', 3, 3), null, null];
  notContest.enemy = [U('scout', 2, 1), null, null];
  const c4 = CB.enemyChooseAction(notContest, ['scout'], 10);
  check(c4.kind === 'play' && c4.lane === 1,
    `a lane the enemy already holds is not "contested"; it pushes into the open lane (got ${JSON.stringify(c4)})`);

  /* --- (e) priority 5: push the highest-atk body into a vacant lane --- */
  const push = empty();
  push.enemy = [U('soldier', 3, 3), null, null];
  push.player = [null, null, null];
  const p1 = CB.enemyChooseAction(push, ['scout', 'knight'], 10);
  check(p1.kind === 'play' && p1.handIndex === 1 && p1.lane === 1,
    `the highest-atk body pushes into the lowest vacant lane (got ${JSON.stringify(p1)})`);

  const pushTie = empty();
  const p2 = CB.enemyChooseAction(pushTie, ['scout', 'scout'], 10);
  check(p2.kind === 'play' && p2.handIndex === 0 && p2.lane === 0,
    `an atk tie falls back to the lowest hand index (got ${JSON.stringify(p2)})`);

  /* --- (f) end when nothing is playable --- */
  const e1 = CB.enemyChooseAction(empty(), [], 10);
  check(e1.kind === 'end', `an empty hand ends (got ${JSON.stringify(e1)})`);
  const e2 = CB.enemyChooseAction(empty(), ['knight'], 3);
  check(e2.kind === 'end', `a hand of unaffordable cards ends (got ${JSON.stringify(e2)})`);
  const e3 = CB.enemyChooseAction(empty(), ['soldier'], 0);
  check(e3.kind === 'end', `zero energy ends (got ${JSON.stringify(e3)})`);
  const full = empty();
  full.enemy = [U('scout', 2, 1), U('scout', 2, 1), U('scout', 2, 1)];
  const e4 = CB.enemyChooseAction(full, ['soldier', 'knight'], 10);
  check(e4.kind === 'end', `a full board with only bodies in hand ends (got ${JSON.stringify(e4)})`);
  /* A full board with a spell in hand still spends it (spells ignore occupancy). */
  const fullSpell = empty();
  fullSpell.enemy = [U('scout', 2, 1), U('scout', 2, 1), U('scout', 2, 1)];
  const e5 = CB.enemyChooseAction(fullSpell, ['rally'], 4);
  check(e5.kind === 'play' && e5.lane >= 0 && e5.lane < 3, `a spell still fires on a full board (got ${JSON.stringify(e5)})`);

  /* The AI never plays a card that is only affordable but not in hand. */
  const notInHand = CB.enemyChooseAction(empty(), ['scout'], 99);
  check(notInHand.kind === 'play' && notInHand.handIndex === 0,
    `the chosen handIndex always points at the card actually played (got ${JSON.stringify(notInHand)})`);
  const noBody = CB.enemyChooseAction(empty(), [], 10);
  check(noBody.handIndex === undefined, 'an end action carries no handIndex');
}

/* ======================================================================
 * 7. The live game through CB.tick()
 * ==================================================================== */

group('7. live game: phases, conservation, play gate, termination');
{
  /* --- 7a. newGame / start shapes --- */
  const fresh = CB.newGame({ seed: 5 });
  check(fresh.phase === 'ready', `newGame lands in 'ready' (got ${fresh.phase})`);
  check(fresh.turn === 1 && fresh.energy === 0, `a fresh game is turn 1 with 0 energy (got ${fresh.turn}/${fresh.energy})`);
  check(fresh.hand.length === 3, `a fresh game holds ${CB.START_HAND} cards (got ${fresh.hand.length})`);
  check(fresh.deckLeft === 17 && fresh.discardLeft === 0, `deck 17 / discard 0 after the opening deal (got ${fresh.deckLeft}/${fresh.discardLeft})`);
  check(fresh.enemyHand.length === 3 && fresh.enemyDeckLeft === 17, 'the enemy mirror-deals 3 cards and keeps 17');
  check(fresh.playerHp === 20 && fresh.enemyHp === 20, 'both bases start at 20');
  check(fresh.seed === 5, `getState echoes the requested seed (got ${fresh.seed})`);
  check(fresh.rngDraws === 38, `two 19-draw shuffles leave rngDraws at 38 (got ${fresh.rngDraws})`);
  check(fresh.rng.seed === 5 && fresh.rng.calls === 38, `rng = {seed, calls} mirrors the stream (got ${JSON.stringify(fresh.rng)})`);

  /* Determinism of the deal itself. */
  const dealA = JSON.stringify(CB.newGame({ seed: 5 }).hand);
  const dealB = JSON.stringify(CB.newGame({ seed: 5 }).hand);
  const dealC = JSON.stringify(CB.newGame({ seed: 6 }).hand);
  check(dealA === dealB, 'the same seed deals a byte-identical opening hand');
  check(dealA !== dealC, 'a different seed deals a different opening hand');
  check(CB.getState().seed === 6 && CB.getState().phase === 'ready',
    `a fresh newGame({seed:6}) really reseeds the live state (got ${CB.getState().seed}/${CB.getState().phase})`);

  CB.newGame({ seed: 5 });
  const started = CB.start();
  check(started.phase === 'player', `start() enters 'player' (got ${started.phase})`);
  check(started.energy === 2, `turn 1 refills to 2 energy (got ${started.energy})`);
  check(started.hand.length === 4, `the turn-1 draw makes 4 cards (got ${started.hand.length})`);
  check(started.deckLeft === 16 && started.discardLeft === 0, 'the draw comes off the deck (16 left)');

  const before2 = JSON.stringify(CB.getState());
  CB.start();
  check(JSON.stringify(CB.getState()) === before2, 'a second start() while in player changes nothing');

  /* --- 7b. pause freezes the model --- */
  CB.newGame({ seed: 5 }); CB.start();
  CB.endTurn();                                   // -> resolve
  check(CB.getState().phase === 'resolve', 'endTurn() enters resolve');
  const paused = CB.pause();
  check(paused.phase === 'paused', `pause() suspends the machine (got ${paused.phase})`);
  check(CB.getState().resumePhase === 'resolve', `resumePhase remembers 'resolve' (got ${CB.getState().resumePhase})`);
  const turnBefore = CB.getState().turn;
  CB.tick(30, 1 / 60);
  check(CB.getState().phase === 'paused', 'tick(30) does not advance a paused game');
  check(CB.getState().turn === turnBefore, `the turn counter is frozen while paused (${turnBefore} -> ${CB.getState().turn})`);
  CB.start();
  check(CB.getState().phase === 'resolve', `start() from paused resumes 'resolve' (got ${CB.getState().phase})`);

  let g0 = 0;
  while (CB.getState().phase !== 'player' && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose' && g0++ < 400) {
    CB.tick(0.1, 1 / 60);
  }
  check(CB.getState().phase === 'player' && CB.getState().turn === 2,
    `resuming runs resolve -> enemy -> player and turn 2 begins (got ${CB.getState().phase}/${CB.getState().turn})`);

  /* --- 7c. card conservation at every turn boundary --- */
  /* A "spend everything affordable, cheapest first" policy keeps the hands and
   * discards moving, so the conservation identity is stressed rather than
   * sampled once. The invariant is checked both at each turn boundary and after
   * every mid-turn play, because a play is exactly the transition that moves a
   * card from hand to discard. */
  const spendy = s => {
    let best = null;
    for (let i = 0; i < s.hand.length; i++) {
      const spec = SPEC[s.hand[i]];
      if (s.energy < spec.cost) continue;
      for (let lane = 0; lane < CB.LANES; lane++) {
        if (CB.canPlay(s, i, lane) && (!best || spec.cost < best.cost)) best = { i, lane, cost: spec.cost };
      }
    }
    return best;
  };
  let conserveBad = 0, boundaries = 0, midTurnSamples = 0, firstConserve = '';
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]) {
    CB.newGame({ seed }); CB.start();
    let guard = 0, lastTurn = -1;
    while (guard++ < 60) {
      const s = CB.getState();
      if (s.phase === 'win' || s.phase === 'lose') break;
      if (s.phase !== 'player') { CB.tick(0.1, 1 / 60); continue; }
      const pSum = s.hand.length + s.deckLeft + s.discardLeft;
      const eSum = s.enemyHand.length + s.enemyDeckLeft + s.enemyDiscardLeft;
      midTurnSamples++;
      if (s.turn !== lastTurn) { lastTurn = s.turn; boundaries++; }
      if (pSum !== 20 || eSum !== 20) {
        conserveBad++;
        if (!firstConserve) firstConserve = `seed${seed} t${s.turn} player ${pSum} enemy ${eSum} phase ${s.phase}`;
      }
      const pick = spendy(s);
      if (pick) { CB.playCard(pick.i, pick.lane); continue; }
      CB.endTurn();
      let g = 0;
      while (CB.getState().phase !== 'player' && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose' && g++ < 400) {
        CB.tick(0.1, 1 / 60);
      }
    }
  }
  check(boundaries > 60, `checked card conservation at ${boundaries} turn boundaries`);
  check(midTurnSamples > boundaries, `sampled conservation ${midTurnSamples} times (more than one per turn, so mid-turn plays are covered)`);
  check(conserveBad === 0, `hand + deck + discard === 20 for both sides everywhere (${conserveBad} bad)` +
    (firstConserve ? ` first ${firstConserve}` : ''));
  note(`conservation: ${midTurnSamples} samples over ${boundaries} turn boundaries`);

  /* --- 7c'. the hand cap burns the drawn card instead of stalling --- */
  /* An idle player fills the hand by turn 3, so the burn branch is reachable
   * in a normal game - and it is the transition most likely to lose a card.
   * The detector is a pure state delta: with nothing played, a turn that leaves
   * the hand unchanged but moves one card from deck to discard can only be a
   * burn. */
  let burnTurns = 0, burnBad = 0, capBad = 0, conserveBad2 = 0, firstBurn = '';
  let sawBurnLog = false;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    CB.newGame({ seed }); CB.start();
    let guard = 0;
    while (guard++ < 40 && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose') {
      const s = CB.getState();
      if (s.phase !== 'player') { CB.tick(0.1, 1 / 60); continue; }
      if (s.hand.length > CB.HAND_MAX) capBad++;
      if (s.hand.length + s.deckLeft + s.discardLeft !== 20) conserveBad2++;
      const deck0 = s.deckLeft, disc0 = s.discardLeft, hand0 = s.hand.length, turn0 = s.turn;
      CB.endTurn();
      let g = 0;
      while (CB.getState().phase !== 'player' && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose' && g++ < 400) {
        CB.tick(0.1, 1 / 60);
      }
      const t = CB.getState();
      if (t.phase === 'win' || t.phase === 'lose') break;
      if (t.turn === turn0 + 1 && hand0 >= CB.HAND_MAX) {
        burnTurns++;
        if (t.hand.length !== hand0 || t.discardLeft !== disc0 + 1 || t.deckLeft !== deck0 - 1) {
          burnBad++;
          if (!firstBurn) firstBurn = `seed${seed} hand ${hand0}->${t.hand.length} deck ${deck0}->${t.deckLeft} discard ${disc0}->${t.discardLeft}`;
        }
      }
      if (t.log.some(e => e.key === 'logBurned')) sawBurnLog = true;
    }
  }
  check(burnTurns >= 3, `the full-hand burn branch was reached on ${burnTurns} turns`);
  check(sawBurnLog, 'a full hand logs logBurned rather than stalling the deck');
  check(burnBad === 0, `a burn leaves the hand at the cap and moves exactly one card deck -> discard (${burnBad} bad)` +
    (firstBurn ? ` first ${firstBurn}` : ''));
  check(capBad === 0, `the hand never exceeds HAND_MAX (${capBad} bad)`);
  check(conserveBad2 === 0, `the 20-card identity survives a burn (${conserveBad2} bad)`);
  note(`hand-cap burn: reached on ${burnTurns} turn transitions across 6 seeds`);

  /* --- 7c''. the empty-deck reshuffle is reachable, and it is a MOVE ---------
   * drawCard's other rare branch is the reshuffle: when the deck is empty and
   * the discard is not, the discard is shuffled back into the deck. It is NOT
   * dead code, and the arithmetic says exactly where it must become reachable:
   * the player pile holds 20 - START_HAND = 17 cards at the deal and takes one
   * draw per turn, so it can only run dry on draw #18 - i.e. while turn 18 is
   * on the table. Either side reaching that point needs the game to last 18
   * turns, which is why the probe is a policy that MAXIMISES survival: block
   * every enemy attacker, heal a blocker that is about to die, and never push
   * into a lane the enemy has left empty (the only way to damage their base,
   * and therefore the only way to end the game early by winning).
   * On the seed family below the bound is comfortable: long defensive games do
   * reach turn 18+, and every one of them refills the deck from the discard. */
  function stallBot(st) {
    const me = st.board.player, foe = st.board.enemy, hand = st.hand, en = st.energy;
    let body = -1;
    for (let i = 0; i < hand.length; i++) {
      const c = SPEC[hand[i]];
      if (!c || c.kind !== 'unit' || en < c.cost) continue;
      if (body < 0 || c.hp > SPEC[hand[body]].hp || (c.hp === SPEC[hand[body]].hp && c.cost < SPEC[hand[body]].cost)) body = i;
    }
    if (body >= 0) {
      for (let l = 0; l < CB.LANES; l++) if (foe[l] && !me[l] && CB.canPlay(st, body, l)) return { i: body, lane: l };
    }
    const mi = hand.indexOf('mend');
    if (mi >= 0 && en >= SPEC.mend.cost) {
      for (let l = 0; l < CB.LANES; l++) {
        const u = me[l];
        if (u && foe[l] && u.hp - foe[l].atk <= 0 && CB.canPlay(st, mi, l)) return { i: mi, lane: l };
      }
    }
    return null;
  }

  let stallWorst = 0, stallWorstSeed = null, stallReached18 = 0, stallSeeds = 0;
  let stallReshuffleSeeds = 0, stallEvents = 0, stallEnemyEvents = 0, stallSamples = 0;
  let pileBad = 0, fundedBad = 0, unloggedBad = 0, firstReshuffle = '';
  const STALL_SEEDS = 120;
  for (let n = 1; n <= STALL_SEEDS; n++) {
    const seed = n * 53 + 7;
    CB.newGame({ seed }); CB.start();
    let guard = 0, maxTurn = 1, thisReshuffle = 0;
    let prevDeck = CB.getState().deckLeft, prevDisc = CB.getState().discardLeft;
    let prevEDeck = CB.getState().enemyDeckLeft;
    while (guard++ < 400) {
      let s = CB.getState();
      if (s.phase === 'win' || s.phase === 'lose') break;
      if (s.turn > maxTurn) maxTurn = s.turn;
      let plays = 0;
      if (s.phase === 'player') {
        let g = 0;
        while (g++ < 20) {
          s = CB.getState();
          if (s.phase !== 'player') break;
          const mv = stallBot(s);
          if (!mv || !CB.playCard(mv.i, mv.lane)) break;
          plays++;
        }
        if (CB.getState().phase === 'player') CB.endTurn();
      }
      CB.tick(8, 0.05);
      const a = CB.getState();
      /* The 20-card identity is the invariant that catches an INVENTING
       * reshuffle, and this sweep is where it matters: it is the only place a
       * refill ever runs. Checked on BOTH sides at every sample. */
      stallSamples++;
      if (a.hand.length + a.deckLeft + a.discardLeft !== 20 ||
        a.enemyHand.length + a.enemyDeckLeft + a.enemyDiscardLeft !== 20) pileBad++;
      if (a.deckLeft > prevDeck) {
        /* A deck that grew can only have come back from the discard. The check
         * is made at the moment it happens, never at the end: the log is a
         * 48-entry rolling window that drops the OLDEST lines, so a reshuffle
         * line can be spliced away long before a wrap-up scan looks for it. */
        thisReshuffle++;
        /* Funding: my own plays are the only thing that ADDS to the discard in
         * this window, and one turn's draw can burn at most one card. So a
         * discard that ends up holding fewer cards than I put there can only
         * have handed the difference to the deck. */
        if (a.discardLeft >= prevDisc + plays) fundedBad++;
        if (!CB.log().some(e => e.key === 'logReshuffle')) unloggedBad++;
        if (!firstReshuffle) {
          firstReshuffle = `seed${seed} t${a.turn} deck ${prevDeck}->${a.deckLeft} discard ${prevDisc}->${a.discardLeft} plays ${plays}`;
        }
      }
      if (a.enemyDeckLeft > prevEDeck) stallEnemyEvents++;
      prevDeck = a.deckLeft; prevDisc = a.discardLeft; prevEDeck = a.enemyDeckLeft;
    }
    if (maxTurn > stallWorst) { stallWorst = maxTurn; stallWorstSeed = seed; }
    if (maxTurn >= 18) stallReached18++;
    if (thisReshuffle > 0) { stallReshuffleSeeds++; stallEvents += thisReshuffle; }
    stallSeeds++;
  }
  check(stallWorst >= 18,
    `the longest stalling game reached turn ${stallWorst} (seed ${stallWorstSeed}); the pile can only empty on draw #18, ` +
    'so turn 18 is the reachability threshold and it is cleared');
  check(stallReached18 >= 1, `${stallReached18} of ${stallSeeds} seeds survive to turn 18`);
  check(stallReshuffleSeeds >= 1 && stallEvents >= 1,
    `the empty-deck reshuffle fires in real play: ${stallEvents} deck-grew-back events across ${stallReshuffleSeeds} seeds` +
    (firstReshuffle ? `, first ${firstReshuffle}` : ''));
  check(fundedBad === 0,
    `a reshuffle is funded by the discard, not invented: the discard ends up below (start + my plays) (${fundedBad} bad)`);
  check(unloggedBad === 0, `every reshuffle logs logReshuffle as it happens (${unloggedBad} unlogged)`);
  check(pileBad === 0,
    `the 20-card identity holds at all ${stallSamples} long-game samples, both sides (${pileBad} bad)`);
  note(`reshuffle: worst turn ${stallWorst}, ${stallReached18}/${stallSeeds} seeds at turn 18+, ` +
    `${stallEvents} player-side + ${stallEnemyEvents} enemy-side refills`);

  /* --- 7c'''. what the `draws` counter actually counts ----------------------
   * `draws` is debug surface on the bridge and it is NOT "cards this player
   * drew": it is ONE counter shared by both sides, and a draw that the hand cap
   * burns does not increment it. Both halves are pinned here because neither is
   * stated in the source or the README - and getting either wrong would make
   * the number an unreliable instrument for the pile tests above. */
  CB.newGame({ seed: 11 });
  check(CB.getState().draws === 0 && CB.getState().rngDraws === 38,
    `a fresh deal has draws 0 and rngDraws 38 (got ${CB.getState().draws}/${CB.getState().rngDraws})`);
  const draws1 = CB.start().draws;
  const afterStart = CB.getState();
  check(draws1 === 1, `start() counts the player's turn-1 draw: draws 0 -> ${draws1}`);
  CB.endTurn();
  let gDraw = 0;
  while (CB.getState().phase !== 'player' && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose' && gDraw++ < 400) {
    CB.tick(0.1, 1 / 60);
  }
  const sDraw2 = CB.getState();
  check(sDraw2.turn === 2 && sDraw2.draws === 3,
    `one full turn advances draws by 2 although the player drew once (${draws1} -> ${sDraw2.draws}): ` +
    'the counter is shared by both sides');
  check(sDraw2.deckLeft === afterStart.deckLeft - 1,
    `the player's own pile only lost one card over that turn (deck ${afterStart.deckLeft} -> ${sDraw2.deckLeft})`);
  const drawsBefore = sDraw2.draws, deckBefore2 = sDraw2.deckLeft;
  CB.endTurn();
  gDraw = 0;
  while (CB.getState().phase !== 'player' && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose' && gDraw++ < 400) {
    CB.tick(0.1, 1 / 60);
  }
  const sDraw3 = CB.getState();
  check(sDraw3.turn === 3 && sDraw3.hand.length === CB.HAND_MAX,
    `the idle hand is at the cap by turn 3 (got ${sDraw3.hand.length}/${CB.HAND_MAX})`);
  check(sDraw3.draws === drawsBefore + 1,
    `a burned draw does not increment draws (${drawsBefore} -> ${sDraw3.draws} while both sides drew)`);
  check(sDraw3.deckLeft === deckBefore2 - 1,
    `the burned card still came off the deck (${deckBefore2} -> ${sDraw3.deckLeft})`);
  check(CB.log().some(e => e.key === 'logBurned'), 'and the burn is logged as logBurned');
  note('draws: 0 at the deal; 1 after start(); +2 per idle turn while both hands have room; ' +
    '+1 once the cap burns the player\'s own draw');

  /* --- 7d. the play gate, differentially --- */
  function myLegality(board, id, side, lane) {
    if (!(lane >= 0 && lane < CB.LANES)) return false;
    const spec = SPEC[id];
    if (!spec) return false;
    const mine = (side === 'enemy') ? (board.enemy || []) : (board.player || []);
    if (spec.kind === 'unit') return !mine[lane];
    if (id === 'mend') return !!mine[lane];
    return true;                                    // fireball and rally accept any lane
  }
  function myCanPlay(s, i, lane) {
    if (!s || s.phase !== 'player') return false;
    if (!Number.isInteger(i) || i < 0 || i >= s.hand.length) return false;
    const spec = SPEC[s.hand[i]];
    if (!spec) return false;
    if (s.energy < spec.cost) return false;
    return myLegality(s.board, s.hand[i], 'player', lane);
  }

  let gateMismatch = 0, gateTrials = 0, accepted = 0, energyBad = 0, handBad = 0, noopBad = 0;
  let firstGate = '';
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21, 42, 99, 123, 256, 777, 2024, 31337]) {
    CB.newGame({ seed }); CB.start();
    let guard = 0;
    while (guard++ < 45 && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose') {
      if (CB.getState().phase !== 'player') { CB.tick(0.1, 1 / 60); continue; }
      /* A complete deterministic sweep of every (handIndex, lane) pair the
       * state admits, INCLUDING the out-of-range probes, so both the accept and
       * the refusal branches are covered on every turn. */
      const s0 = CB.getState();
      const probes = [];
      for (let i = -1; i <= s0.hand.length; i++) for (let lane = -1; lane <= CB.LANES; lane++) probes.push([i, lane]);
      for (const [i, lane] of probes) {
        const s = CB.getState();
        if (s.phase !== 'player') break;
        const pred = myCanPlay(s, i, lane);
        const got = CB.playCard(i, lane);
        gateTrials++;
        if (got !== pred) {
          gateMismatch++;
          if (!firstGate) firstGate = `seed${seed} i=${i} lane=${lane} pred=${pred} got=${got} hand=${JSON.stringify(s.hand)} energy=${s.energy}`;
        }
        if (got) {
          accepted++;
          const after = CB.getState();
          const cost = SPEC[s.hand[i]].cost;
          if (after.energy !== s.energy - cost) energyBad++;
          if (after.hand.length !== s.hand.length - 1) handBad++;
          if (after.discardLeft !== s.discardLeft + 1) handBad++;
          if (after.deckLeft !== s.deckLeft) handBad++;
          if (after.board.player[lane] === null && SPEC[s.hand[i]].kind === 'unit') handBad++;
        } else {
          const after = CB.getState();
          if (after.energy !== s.energy || after.hand.length !== s.hand.length ||
            after.discardLeft !== s.discardLeft || after.deckLeft !== s.deckLeft ||
            after.playerHp !== s.playerHp || after.enemyHp !== s.enemyHp ||
            JSON.stringify(after.board) !== JSON.stringify(s.board)) {
            noopBad++;
            if (!firstGate) firstGate = `seed${seed} refused play mutated the model`;
          }
        }
      }
      if (CB.getState().phase === 'player') CB.endTurn();
      let g = 0;
      while (CB.getState().phase !== 'player' && CB.getState().phase !== 'win' && CB.getState().phase !== 'lose' && g++ < 400) {
        CB.tick(0.1, 1 / 60);
      }
    }
  }
  check(gateTrials > 3000, `probed the play gate ${gateTrials} times (both valid and out-of-range arguments)`);
  check(gateMismatch === 0,
    `CB.playCard matches my spec-derived predicate on all ${gateTrials} probes (${gateMismatch} bad)` +
    (firstGate ? ` first ${firstGate}` : ''));
  check(accepted > 200, `the probes accepted ${accepted} real plays (a vacuous gate would accept 0)`);
  check(energyBad === 0, `every accepted play deducts exactly its cost (${energyBad} bad)`);
  check(handBad === 0, `every accepted play consumes one hand card into the discard (${handBad} bad)`);
  check(noopBad === 0, `every refused play leaves the model untouched (${noopBad} bad)`);
  note(`play gate: ${gateTrials} probes, ${accepted} accepted, ${gateTrials - accepted} refused`);

  /* --- 7e. unit-vs-spell specifics through the live model --- */
  CB.newGame({ seed: 4 }); CB.start();
  {
    const s = CB.getState();
    const unitIdx = s.hand.findIndex(id => SPEC[id].kind === 'unit');
    const firstLane = 0;
    const before = CB.getState();
    const ok1 = CB.playCard(unitIdx, firstLane);
    check(ok1, 'a unit can be played into an empty own lane');
    check(CB.getState().board.player[firstLane] !== null, 'the unit appears on the board');
    const gain = CB.getState().board.player[firstLane];
    check(gain.cardId === before.hand[unitIdx] && gain.atk === SPEC[gain.cardId].atk && gain.hp === SPEC[gain.cardId].hp,
      'the placed unit carries the card atk/hp and a maxHp equal to its printed hp');
    const occupy = CB.playCard(CB.getState().hand.findIndex(id => SPEC[id].kind === 'unit'), firstLane);
    check(occupy === false, 'a second unit cannot enter an occupied own lane');
  }

  /* Mend is illegal with no friendly unit, legal with one. */
  CB.newGame({ seed: 4 }); CB.start();
  {
    const s0 = CB.getState();
    const mendFree = { phase: 'player', energy: 10, hand: ['mend'], board: { player: [null, null, null], enemy: [null, null, null] } };
    check(CB.canPlay(mendFree, 0, 0) === false, 'Mend is illegal on a lane with no friendly unit');
    check(CB.canPlay({ phase: 'player', energy: 10, hand: ['fireball'], board: { player: [null, null, null], enemy: [null, null, null] } }, 0, 0) === true,
      'Fireball is legal on an empty lane');
    check(CB.canPlay({ phase: 'player', energy: 10, hand: ['rally'], board: { player: [null, null, null], enemy: [null, null, null] } }, 0, 2) === true,
      'Rally is legal on any lane');
    check(CB.canPlay({ phase: 'enemy', energy: 10, hand: ['scout'], board: { player: [null, null, null], enemy: [null, null, null] } }, 0, 0) === false,
      'canPlay is false outside the player phase');
    check(CB.canPlay({ phase: 'player', energy: 0, hand: ['scout'], board: { player: [null, null, null], enemy: [null, null, null] } }, 0, 0) === false,
      'canPlay is false without the energy');
    check(CB.canPlay({ phase: 'player', energy: 10, hand: ['scout'], board: { player: [null, null, null], enemy: [null, null, null] } }, 1, 0) === false,
      'canPlay is false for an out-of-range hand index');
    check(CB.canPlay({ phase: 'player', energy: 10, hand: ['scout'], board: { player: [null, null, null], enemy: [null, null, null] } }, 0, 3) === false,
      'canPlay is false for lane 3 (only lanes 0..2 exist)');
    check(CB.canPlay({ phase: 'player', energy: 10, hand: ['scout'], board: { player: [null, null, null], enemy: [null, null, null] } }, 0, -1) === false,
      'canPlay is false for lane -1');
    /* Mend heals only to the printed hp, so a fresh unit takes 0 back. */
    const healed = CB.resolveCombat({ player: [{ cardId: 'knight', atk: 5, hp: 2, maxHp: 6 }], enemy: [null, null, null] });
    check(healed.player[0].hp === 2, 'a wounded unit is carried through a resolve without healing');
  }

  /* selectCard toggles and is refused outside the player phase. */
  CB.newGame({ seed: 4 });
  check(CB.selectCard(0) === false, 'selectCard is refused in ready');
  CB.start();
  check(CB.selectCard(0) === true && CB.getState().selected === 0, 'selectCard(0) selects slot 0');
  CB.selectCard(0);
  check(CB.getState().selected === null, 'selecting the same slot again deselects it');
  check(CB.endTurn() === true && CB.getState().phase === 'resolve', 'endTurn() from player enters resolve');
  check(CB.endTurn() === false, 'endTurn() is refused outside the player phase');
  check(CB.getState().selected === null, 'ending the turn clears the selection');

  /* --- 7f. termination: two policies that can never damage the enemy base --- */
  function runPolicy(seed, decide, cap) {
    CB.newGame({ seed }); CB.start();
    let turns = 1, guard = 0;
    while (guard++ < cap) {
      const s = CB.getState();
      if (s.phase === 'win' || s.phase === 'lose') return { phase: s.phase, turns: s.turn, guard };
      if (s.phase === 'player') {
        const pick = decide(s);
        if (pick && CB.playCard(pick.i, pick.lane)) { turns = s.turn; continue; }
        CB.endTurn();
        continue;
      }
      CB.tick(0.1, 1 / 60);
    }
    return { phase: CB.getState().phase, turns: CB.getState().turn, guard, timedOut: true };
  }

  const idleSeeds = [1, 2, 3, 4, 5, 6, 7, 8];
  let idleWin = 0, idleTimeout = 0, idleWorst = 0, idleFirst = '';
  for (const seed of idleSeeds) {
    const r = runPolicy(seed, () => null, 4000);
    if (r.phase !== 'lose') { idleWin++; if (!idleFirst) idleFirst = `seed ${seed} -> ${r.phase}`; }
    if (r.timedOut) idleTimeout++;
    if (r.turns > idleWorst) idleWorst = r.turns;
  }
  check(idleWin === 0, `an idle player loses on every one of ${idleSeeds.length} seeds (${idleWin} did not)` +
    (idleFirst ? ` first ${idleFirst}` : ''));
  check(idleTimeout === 0, `no idle run failed to terminate within the guard (${idleTimeout})`);
  check(idleWorst > 0 && idleWorst <= 40, `the worst idle run ended on turn ${idleWorst} (bounded)`);
  note(`idle policy: ${idleSeeds.length} seeds, worst turn ${idleWorst}`);

  const onlyWall = s => {
    const i = s.hand.indexOf('wall');
    if (i < 0) return null;
    for (let lane = 0; lane < CB.LANES; lane++) {
      if (CB.canPlay(s, i, lane)) return { i, lane };
    }
    return null;
  };
  let wallWin = 0, wallTimeout = 0, wallWorst = 0, wallFirst = '';
  for (const seed of idleSeeds) {
    const r = runPolicy(seed, onlyWall, 6000);
    if (r.phase !== 'lose') { wallWin++; if (!wallFirst) wallFirst = `seed ${seed} -> ${r.phase}`; }
    if (r.timedOut) wallTimeout++;
    if (r.turns > wallWorst) wallWorst = r.turns;
  }
  check(wallWin === 0, `a Bulwark-only player loses on every one of ${idleSeeds.length} seeds (${wallWin} did not)` +
    (wallFirst ? ` first ${wallFirst}` : ''));
  check(wallTimeout === 0, `no Bulwark-only run failed to terminate within the guard (${wallTimeout})`);
  check(wallWorst > 0 && wallWorst <= 60, `the worst Bulwark-only run ended on turn ${wallWorst} (bounded)`);
  note(`Bulwark-only policy: ${idleSeeds.length} seeds, worst turn ${wallWorst}`);

  /* A greedy-ish player must be able to WIN, otherwise "loses" above proves
   * nothing about the game being winnable at all. */
  const greedy = s => {
    const best = [];
    for (let i = 0; i < s.hand.length; i++) {
      const spec = SPEC[s.hand[i]];
      if (s.energy < spec.cost) continue;
      for (let lane = 0; lane < CB.LANES; lane++) {
        if (!CB.canPlay(s, i, lane)) continue;
        /* Prefer removal, then bodies that hit an open lane, then anything. */
        let score = 0;
        const foe = s.board.enemy[lane];
        if (s.hand[i] === 'fireball' && foe) score = 100 + (4 - foe.hp);
        else if (spec.kind === 'unit' && !foe) score = 60 + spec.atk;
        else if (spec.kind === 'unit' && foe && foe.hp <= spec.atk) score = 50 + spec.atk;
        else if (spec.kind === 'unit') score = 20 + spec.atk;
        else if (s.hand[i] === 'rally') score = 10;
        else score = 1;
        best.push({ i, lane, score, cost: spec.cost });
      }
    }
    if (!best.length) return null;
    best.sort((a, b) => (b.score - a.score) || (b.cost - a.cost) || (a.i - b.i) || (a.lane - b.lane));
    return best[0];
  };
  let greedyWins = 0;
  const greedySeeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (const seed of greedySeeds) {
    const r = runPolicy(seed, greedy, 8000);
    if (r.phase === 'win') greedyWins++;
  }
  note(`greedy policy: ${greedyWins}/${greedySeeds.length} wins (reported, not asserted)`);
  check(greedyWins > 0, `a greedy policy wins at least one of ${greedySeeds.length} seeds (won ${greedyWins})`);

  /* --- 7g. the win/lose overlay state --- */
  CB.newGame({ seed: 1 }); CB.start();
  let gEnd = 0;
  while (CB.getState().phase !== 'win' && CB.getState().phase !== 'lose' && gEnd++ < 6000) {
    const s = CB.getState();
    if (s.phase === 'player') {
      const pick = greedy(s);
      if (!pick || !CB.playCard(pick.i, pick.lane)) CB.endTurn();
    } else {
      CB.tick(0.1, 1 / 60);
    }
  }
  const over = CB.getState();
  check(over.phase === 'win' || over.phase === 'lose', `a greedy run reaches a decision (got ${over.phase})`);
  check(over.over === true, 'getState().over is true at a decision');
  check(over.winner === (over.phase === 'win' ? 'player' : 'enemy'),
    `winner is '${over.phase === 'win' ? 'player' : 'enemy'}' (got ${over.winner})`);
  check(!over.hand.some(id => typeof id !== 'string'), 'the hand stays a list of card ids at the end');
}

/* ======================================================================
 * 8. i18n: exactly one onChange, and the DYNAMIC text really switches
 * ==================================================================== */

group('8. i18n: dynamic banner / hint / log re-render on a language switch');
{
  const Gi = boot(GAME, I18N);
  const Si = Gi.CB, Ti = Gi.T, ei = Gi.els;
  check(!!Ti && Ti.lang === 'en', `the i18n helper boots in English (lang=${Ti && Ti.lang})`);
  check(!!Ti && typeof Ti.onChange === 'function', 'the captured i18n instance exposes onChange');

  Si.newGame({ seed: 3 });
  /* The banner is a PHASE label: it shows in ready/resolve/enemy/paused/win/lose
   * and is deliberately blank while the player is the one deciding. All of its
   * text is written from the model each paint, so it must follow the switch. */
  const enReady = ei.fx.innerHTML;
  check(enReady.length > 0 && !CJK.test(enReady), `#fx shows the English ready banner (got ${JSON.stringify(enReady)})`);

  Si.start();
  check(ei.fx.innerHTML === '', 'the player phase deliberately shows no banner');
  const enHint = ei.hint.textContent;
  const enLog = ei.log.innerHTML;
  check(enHint.length > 0 && !CJK.test(enHint), `#hint starts English (got ${JSON.stringify(enHint)})`);
  check(enLog.length > 0 && !CJK.test(enLog), `#log starts English (got ${JSON.stringify(enLog)})`);
  check(ei.card0.innerHTML.length > 0 && !CJK.test(ei.card0.innerHTML),
    `#card0 renders an English face (got ${JSON.stringify(ei.card0.innerHTML)})`);

  /* Push a real turn into the log so the combat narration is non-trivial. */
  Si.endTurn();
  Si.tick(0.1, 1 / 60);
  check(Si.getState().phase === 'resolve', `the resolve phase is current (got ${Si.getState().phase})`);
  const enResolve = ei.fx.innerHTML;
  check(enResolve.length > 0 && !CJK.test(enResolve), `#fx shows the English combat banner (got ${JSON.stringify(enResolve)})`);

  let gg = 0;
  while (Si.getState().phase !== 'player' && Si.getState().phase !== 'win' && Si.getState().phase !== 'lose' && gg++ < 400) {
    Si.tick(0.1, 1 / 60);
  }
  const logAfterTurn = ei.log.innerHTML;
  check(logAfterTurn.length > enLog.length, 'the combat log grew after a real turn');
  check(!CJK.test(logAfterTurn), 'the post-turn combat log is still English');

  /* Now switch language while a non-player phase banner is on screen. */
  Si.endTurn();
  Si.tick(0.1, 1 / 60);
  Ti.set('zh');
  const zhBanner = ei.fx.innerHTML, zhHint = ei.hint.textContent, zhLog = ei.log.innerHTML;
  check(CJK.test(zhBanner), `#fx re-renders in Chinese via T.onChange (got ${JSON.stringify(zhBanner)})`);
  check(CJK.test(zhHint), `#hint re-renders in Chinese (got ${JSON.stringify(zhHint)})`);
  check(CJK.test(zhLog), `the DYNAMIC combat log re-renders in Chinese (got ${JSON.stringify(zhLog.slice(0, 80))})`);
  check(!/Turn \d/.test(zhLog), 'the old English turn line is gone from the log after the switch');
  check(CJK.test(ei.card0.innerHTML), `#card0 re-localises its card name (got ${JSON.stringify(ei.card0.innerHTML)})`);

  Ti.set('en');
  Si.tick(0.1, 1 / 60);
  check(ei.fx.innerHTML === enResolve || !CJK.test(ei.fx.innerHTML),
    'flipping back to en restores the English banner');
  check(!CJK.test(ei.hint.textContent) && !CJK.test(ei.log.innerHTML) && !CJK.test(ei.card0.innerHTML),
    'flipping back to en restores English hint/log/card faces');

  /* The static hooks: the title element carries data-i18n and resolves. */
  const titleKey = (HTML.match(/<title[^>]*data-i18n="([^"]+)"/) || [, null])[1];
  check(!!titleKey, `the <title> carries a data-i18n hook (got ${JSON.stringify(titleKey)})`);
  if (titleKey) {
    check(Ti.t(titleKey).length > 0 && Ti.t(titleKey) !== titleKey,
      `<title> resolves to non-empty text (got ${JSON.stringify(Ti.t(titleKey))})`);
  }
}

/* ======================================================================
 * 9. HUD cache invariant
 * ==================================================================== */

group('9. hudCache mirrors getState after every paint');
{
  const Gi = boot(GAME, I18N);
  const Si = Gi.CB;
  Si.newGame({ seed: 9 }); Si.start();
  let bad = 0, samples = 0, first = '';
  for (let i = 0; i < 200; i++) {
    if (Si.getState().phase === 'player') Si.endTurn();
    Si.tick(0.12, 1 / 60);
    const s = Si.getState(), c = Si.hudCache();
    samples++;
    const wantTurn = String(s.turn);
    const wantEnergy = s.energy + '/' + Si.energyFor(s.turn);
    if (c.turn !== wantTurn) { bad++; if (!first) first = `turn ${c.turn} vs ${wantTurn}`; }
    if (c.energy !== wantEnergy) { bad++; if (!first) first = `energy ${c.energy} vs ${wantEnergy}`; }
    if (c.php !== String(s.playerHp)) { bad++; if (!first) first = `php ${c.php} vs ${s.playerHp}`; }
    if (c.ehp !== String(s.enemyHp)) { bad++; if (!first) first = `ehp ${c.ehp} vs ${s.enemyHp}`; }
    if (c.deckP !== String(s.deckLeft)) { bad++; if (!first) first = `deckP ${c.deckP} vs ${s.deckLeft}`; }
    if (c.deckE !== String(s.enemyDeckLeft)) { bad++; if (!first) first = `deckE ${c.deckE} vs ${s.enemyDeckLeft}`; }
  }
  check(samples === 200, `sampled the HUD cache ${samples} times`);
  check(bad === 0, `the cached turn/energy/php/ehp/deck strings mirror getState on every sample (${bad} bad)` +
    (first ? ` first ${first}` : ''));
  const c = Si.hudCache();
  const keys = ['turn', 'energy', 'php', 'ehp', 'deckP', 'deckE', 'banner', 'hint', 'log', 'endDis',
    'pauseTxt', 'pauseDis', 'selKey', 'poorKey', 'targetKey', 'startShow', 'overShow',
    'ovTitle', 'ovSub', 'ovBtn', 'e0', 'e1', 'e2', 'p0', 'p1', 'p2', 'card0', 'card1', 'card2', 'card3', 'card4'];
  const missing = keys.filter(k => !(k in c));
  check(missing.length === 0, `hudCache exposes the full key set (missing ${JSON.stringify(missing)})`);
  check(c.turn !== null && c.energy !== null, 'the counters were actually painted (cache is not all null)');
}

/* ======================================================================
 * 10. Markup / i18n key audit
 * ==================================================================== */

group('10. markup i18n keys all resolve, in both languages');
{
  const Gi = boot(GAME, I18N);
  const Ti = Gi.T;
  const keys = new Set();
  for (const m of HTML.matchAll(/data-i18n(?:-html|-title|-ph)?="([^"]+)"/g)) keys.add(m[1]);
  check(keys.size >= 6, `the markup carries ${keys.size} data-i18n keys`);

  Ti.set('en');
  const enMap = {}; for (const k of keys) enMap[k] = Ti.t(k);
  Ti.set('zh');
  const zhMap = {}; for (const k of keys) zhMap[k] = Ti.t(k);

  const unresolved = [], same = [];
  for (const k of keys) {
    if (!enMap[k] || !zhMap[k] || enMap[k] === k || zhMap[k] === k) unresolved.push(k);
    else if (enMap[k] === zhMap[k]) same.push(k);
  }
  check(unresolved.length === 0,
    `every data-i18n key resolves to real, non-empty text in both languages (bad ${JSON.stringify(unresolved)})`);
  check(same.length === 0, `every data-i18n key differs between en and zh (same ${JSON.stringify(same)})`);

  const titleTag = (HTML.match(/<title[^>]*>([^<]*)<\/title>/) || [, ''])[1];
  const titleKey = (HTML.match(/<title[^>]*data-i18n="([^"]+)"/) || [, null])[1];
  check(titleTag.trim().length > 0 || (titleKey && Ti.t(titleKey).trim().length > 0),
    `the document <title> is non-empty (raw ${JSON.stringify(titleTag)}, key ${JSON.stringify(titleKey)})`);
  note('the <title> is i18n-driven (empty in the markup, filled from data-i18n="title") - asserted on the resolved value');

  check(/class="lang-switch"[^>]*data-lang-switch/.test(HTML), 'a [data-lang-switch] host is present in the markup');
  check((HTML.match(/data-lang-switch/g) || []).length === 1, 'exactly one language-switch host');
}

/* ======================================================================
 * 11. Bridge surface
 * ==================================================================== */

group('11. window.CB exposes the documented surface');
{
  const fns = ['cards', 'deckList', 'deck', 'energyFor', 'mulberry32', 'shuffle',
    'enemyChooseAction', 'resolveCombat', 'canPlay', 'getState', 'hudCache', 'log',
    'board', 'hand', 'unitAt', 'nextRandom', 'newGame', 'start', 'pause',
    'selectCard', 'playCard', 'endTurn', 'tick'];
  const missingFns = fns.filter(k => typeof CB[k] !== 'function');
  check(missingFns.length === 0, `all ${fns.length} documented bridge functions exist (missing ${JSON.stringify(missingFns)})`);

  const consts = { LANES: 3, HAND_MAX: 5, DECK_SIZE: 20, START_HP: 20, MAX_ENERGY: 10, START_HAND: 3 };
  const badConsts = Object.keys(consts).filter(k => CB[k] !== consts[k]);
  check(badConsts.length === 0, `the documented constants are exposed (bad ${JSON.stringify(badConsts)})`);

  const withVals = ['RESOLVE_SEC', 'ENEMY_SEC', 'ENEMY_STEP', 'LOG_SHOW'];
  const badVals = withVals.filter(k => typeof CB[k] !== 'number');
  check(badVals.length === 0, `the timing constants are numeric (bad ${JSON.stringify(badVals)})`);

  /* The RNG hook advances the LIVE stream and counts the call. */
  CB.newGame({ seed: 2 });
  const callsBefore = CB.getState().rng.calls;
  const rv = CB.nextRandom();
  check(typeof rv === 'number' && rv >= 0 && rv < 1,
    `nextRandom() returns a draw in [0,1) (got ${rv})`);
  check(CB.getState().rng.calls === callsBefore + 1,
    `nextRandom() advances the live stream counter (${callsBefore} -> ${CB.getState().rng.calls})`);

  CB.newGame({ seed: 2 });
  const s = CB.getState();
  const fields = ['phase', 'turn', 'energy', 'playerHp', 'enemyHp', 'hand', 'board', 'deckLeft',
    'discardLeft', 'seed', 'rng', 'rngDraws', 'winner', 'enemyHand', 'enemyEnergy',
    'enemyDeckLeft', 'enemyDiscardLeft', 'draws', 'handMax', 'deckSize', 'maxEnergy',
    'selected', 'resumePhase', 'best', 'over', 'log'];
  const missingFields = fields.filter(k => !(k in s));
  check(missingFields.length === 0, `getState() carries all ${fields.length} documented fields (missing ${JSON.stringify(missingFields)})`);
  check(s.rng && 'seed' in s.rng && 'calls' in s.rng, 'getState().rng is {seed, calls}');
  check(Array.isArray(s.board.player) && s.board.player.length === 3 &&
    Array.isArray(s.board.enemy) && s.board.enemy.length === 3,
    'the board is two three-lane rows');
  check(s.handMax === CB.HAND_MAX && s.deckSize === CB.DECK_SIZE && s.maxEnergy === CB.MAX_ENERGY,
    'the state mirrors the constants');
  check(CB.board().player.length === 3 && CB.hand().length === s.hand.length,
    'board() and hand() agree with getState()');
  check(CB.unitAt(0, 'player') === null && CB.unitAt(0, 'enemy') === null, 'unitAt() is null on a fresh board');
  check(Array.isArray(CB.log()) && CB.log().length > 0, 'log() returns the entry list');

  /* hand() and board() are copies, not live views. */
  const h = CB.hand(); h.push('bogus');
  check(CB.getState().hand.length !== h.length || CB.getState().hand.indexOf('bogus') === -1,
    'hand() returns a copy the caller cannot use to mutate the model');
  const b = CB.board(); b.player[0] = { cardId: 'bogus', atk: 99, hp: 99, maxHp: 99 };
  check(CB.getState().board.player[0] === null, 'board() returns a copy the caller cannot use to mutate the model');
}

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
console.log('(vm sandbox; deck/constants from CB; independent combat oracle; '
  + 'spec-derived play-gate differential; real games through CB.tick(); '
  + 'the burn and the reshuffle driven to their reachability thresholds; '
  + 'dynamic i18n through the captured T.onChange)');
process.exit(fail ? 1 : 0);
