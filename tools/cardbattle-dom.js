#!/usr/bin/env node
/**
 * Real-DOM check for cardbattle-game.
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id and `querySelectorAll` returns an empty
 * array; the vm suite has no DOM at all. Both hide whole bug classes - a
 * dangling id, a listener that was never bound, a lane slot that is not
 * clickable, an overlay that never hides, a card face that never repaints, or a
 * language switch that mounts no links and never re-renders the dynamic text.
 * This script runs the page for real in jsdom and drives it with real events:
 *
 *   - the page loads with zero jsdom errors and `window.CB` is live in 'ready';
 *   - a real click on Start leaves 'ready', hides the start overlay, fills the
 *     hand and enables End turn / Pause;
 *   - a real click on a card then on a LANE SLOT (either the player or the
 *     enemy slot of that lane) really plays it: energy drops by the cost, the
 *     hand shrinks, the lane renders the unit, and a slot click with nothing
 *     selected is refused with a logged hint;
 *   - real keydowns drive the same machine (1-5, Q/W/E, A/S/D, Escape, P, N,
 *     Space/Enter);
 *   - the HUD text (#turn/#energy/#php/#ehp/#deckP/#deckE) always mirrors
 *     CB.getState() and actually CHANGES as the game progresses;
 *   - a bridge-driven run reaches a decision, shows the result overlay and the
 *     real Play-again button restarts into a playable 'player' phase;
 *   - the language switcher is a set of <a> and clicking the real 简体中文 link
 *     re-renders the DYNAMIC hint, log and banner through the single
 *     T.onChange callback, not just the static labels.
 *
 * jsdom NOTE: this game is DOM + CSS and never touches a 2D context, so there
 * is no canvas stub here at all - `getContext` is instrumented instead, and the
 * suite asserts the page never calls it.
 *
 * Usage:
 *   cd <repo-root> && python3 -m http.server 8123 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> node tools/cardbattle-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy (or the
 * deployed page) can be fed to the same script to prove it is not vacuous.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8123/cardbattle-game/';
const IS_LOCAL = /127\.0\.0\.1|localhost/.test(TARGET);
const SETTLE = IS_LOCAL ? 1200 : 4000; // remote / first load needs much longer

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CJK = /[\u4e00-\u9fff]/;

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));

  const opts = {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      /* No canvas anywhere in this game: instrument getContext so the suite can
       * prove the page never reaches for a 2D context. */
      window.__ctxCalls = 0;
      window.HTMLCanvasElement.prototype.getContext = function () { window.__ctxCalls++; return null; };
      /* Capture rAF so the test owns the frame clock; the loop still runs when
       * the test calls window.__pump(). */
      let cb = null;
      let clock = 0;
      window.requestAnimationFrame = fn => { cb = fn; return 1; };
      window.cancelAnimationFrame = () => { cb = null; };
      window.__pump = () => { const f = cb; cb = null; if (f) f(clock); };
      window.__advance = ms => { clock += ms; };
    }
  };

  let dom;
  try {
    dom = await JSDOM.fromURL(TARGET, opts);
  } catch (e) {
    // An explicitly-passed REMOTE url may point at a page that is not deployed
    // yet; that is a skip, not a failure. But a LOCAL target - including the
    // default - must never exit 0 on a failed load: a typo in the argument, a
    // dead http server or a page that throws on boot would otherwise masquerade
    // as a passing run. A bare path is not a remote url either.
    const explicitlyRemote = /^https?:\/\//i.test(TARGET) && !IS_LOCAL && !!process.argv[2];
    if (explicitlyRemote) {
      console.log(`SKIP: could not load ${TARGET} (${(e && e.message) || e})`);
      process.exit(0);
    }
    console.log(`FAIL: could not load ${TARGET} (${(e && e.message) || e})`);
    process.exit(1);
  }
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  await new Promise(r => window.addEventListener('load', () => setTimeout(r, SETTLE)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const byId = id => doc.getElementById(id);
  const txt = id => { const n = byId(id); return n ? n.textContent : ''; };
  const html = id => { const n = byId(id); return n ? n.innerHTML : ''; };
  const cls = id => { const n = byId(id); return n ? n.classList : null; };
  const st = () => window.CB.getState();
  const CARDS = window.CB.cards();
  const SPEC = {};
  for (const c of CARDS) SPEC[c.id] = c;

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function press(key) {
    doc.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, view: window }));
  }
  function pump(n, ms) {
    const m = ms || 16;
    for (let i = 0; i < (n || 1); i++) { window.__advance(m); window.__pump(); }
  }
  /* A bounded frame pump: the loop can only run the frames the test gives it,
   * so this can never hang. */
  function framesUntil(pred, maxFrames) {
    let i = 0;
    while (i++ < maxFrames) { if (pred()) return true; pump(1); }
    return pred();
  }
  function fresh(seed) { window.CB.newGame({ seed }); window.CB.start(); pump(1); }

  /* Is there a legal lane for hand slot i? Used to pick a target that the game
   * itself says is legal, rather than one the test assumes. */
  function firstLegal(s) {
    for (let i = 0; i < s.hand.length; i++) {
      for (let lane = 0; lane < 3; lane++) {
        if (window.CB.canPlay(s, i, lane)) return { i, lane, id: s.hand[i], spec: SPEC[s.hand[i]] };
      }
    }
    return null;
  }
  function firstLegalUnit(s) {
    for (let i = 0; i < s.hand.length; i++) {
      if (SPEC[s.hand[i]].kind !== 'unit') continue;
      for (let lane = 0; lane < 3; lane++) {
        if (window.CB.canPlay(s, i, lane)) return { i, lane, id: s.hand[i], spec: SPEC[s.hand[i]] };
      }
    }
    return null;
  }
  /* An opening hand can legitimately be unplayable - turn 1 has only 2 energy,
   * so a hand of Knight/Archer/Fireball/Mend has no legal play at all. Search a
   * few explicit seeds for one that does, rather than assuming a hand shape. */
  function freshPlayable(seeds, unitOnly) {
    for (const seed of seeds) {
      fresh(seed);
      const p = unitOnly ? firstLegalUnit(st()) : firstLegal(st());
      if (p) return { pick: p, seed };
    }
    return { pick: null, seed: null };
  }

  /* -------------------------------------------------------------------- 1 */
  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.CB, 'window.CB bridge exists in the real page');
  const api = ['cards', 'deckList', 'deck', 'energyFor', 'mulberry32', 'shuffle',
    'enemyChooseAction', 'resolveCombat', 'canPlay', 'getState', 'hudCache', 'log',
    'board', 'hand', 'unitAt', 'nextRandom', 'newGame', 'start', 'pause',
    'selectCard', 'playCard', 'endTurn', 'tick'];
  ok(api.every(k => typeof window.CB[k] === 'function'),
    `the bridge exposes ${api.length} functions (missing ${JSON.stringify(api.filter(k => typeof window.CB[k] !== 'function'))})`);
  ok(window.CB.LANES === 3 && window.CB.HAND_MAX === 5 && window.CB.DECK_SIZE === 20 &&
    window.CB.START_HP === 20 && window.CB.MAX_ENERGY === 10 && window.CB.START_HAND === 3,
    'the documented constants are the shipped values');
  ok(st().phase === 'ready', `the game boots into 'ready' (got ${st().phase})`);
  ok(st().turn === 1 && st().hand.length === 3 && st().playerHp === 20 && st().enemyHp === 20,
    `a fresh deal is turn 1, 3 cards, 20/20 (got ${st().turn}/${st().hand.length}/${st().playerHp}/${st().enemyHp})`);

  group('2. the real DOM is wired up');
  ok(cls('startOverlay') && cls('startOverlay').contains('show'), 'the start overlay is visible on load');
  ok(cls('overlay') && !cls('overlay').contains('show'), 'the result overlay is hidden at boot');
  ok(byId('btnEnd').disabled === true, 'End turn is disabled in ready');
  ok(byId('btnPause').disabled === true, 'Pause is disabled in ready');
  ok(byId('btnStart') && byId('btnStart').tagName === 'BUTTON', '#btnStart is a real <button>');
  const wanted = ['turn', 'energy', 'php', 'ehp', 'deckP', 'deckE', 'board', 'hand', 'fx', 'hint', 'log',
    'eSlot0', 'eSlot1', 'eSlot2', 'pSlot0', 'pSlot1', 'pSlot2',
    'card0', 'card1', 'card2', 'card3', 'card4',
    'btnEnd', 'btnPause', 'btnNew', 'startOverlay', 'btnStart', 'overlay', 'ovTitle', 'ovSub', 'ovBtn'];
  const missing = wanted.filter(id => byId(id) === null);
  ok(missing.length === 0, `all ${wanted.length} game ids resolve in the real DOM (missing ${JSON.stringify(missing)})`);
  ok(doc.querySelectorAll('canvas').length === 0, 'there is no <canvas> in the real page');
  ok(window.__ctxCalls === 0, `the page never calls getContext (${window.__ctxCalls} calls)`);
  ok(doc.querySelectorAll('[data-lang-switch]').length === 1, 'a single language-switch host is present');
  ok(doc.title.length > 0, `the document title is non-empty (got ${JSON.stringify(doc.title)})`);
  ok(txt('turn') === String(st().turn) && txt('energy') === st().energy + '/' + window.CB.energyFor(st().turn),
    `the HUD boots consistent with getState (${JSON.stringify(txt('turn'))}, ${JSON.stringify(txt('energy'))})`);

  /* -------------------------------------------------------------------- 3 */
  group('3. a real click on Start leaves ready and fills the hand');
  click(byId('btnStart'));
  ok(st().phase === 'player', `clicking Start enters 'player' (got ${st().phase})`);
  ok(!cls('startOverlay').contains('show'), 'the start overlay is really hidden after Start');
  ok(txt('energy') === '2/2', `turn 1 shows 2/2 energy (got ${JSON.stringify(txt('energy'))})`);
  ok(txt('card0').length > 0 && txt('card1').length > 0 && txt('card2').length > 0 && txt('card3').length > 0,
    'the first four hand slots render a card face');
  ok(txt('card4') === '' && cls('card4').contains('empty'), 'the fifth hand slot is empty on turn 1');
  ok(txt('turn') === String(st().turn) && txt('energy') === st().energy + '/' + window.CB.energyFor(st().turn),
    'the turn/energy HUD mirrors getState after Start');
  ok(txt('php') === String(st().playerHp) && txt('ehp') === String(st().enemyHp),
    `the HP HUD mirrors getState (${txt('php')}/${txt('ehp')})`);
  ok(txt('deckP') === String(st().deckLeft) && txt('deckE') === String(st().enemyDeckLeft),
    `the deck HUD mirrors getState (${txt('deckP')}/${txt('deckE')})`);
  ok(byId('btnEnd').disabled === false, 'End turn becomes enabled once playing');
  ok(byId('btnPause').disabled === false, 'Pause becomes enabled once playing');

  /* -------------------------------------------------------------------- 4 */
  group('4. real clicks select a card and play it into a lane');
  {
    const fp = freshPlayable([12345, 31337, 101, 202, 303, 404], true);
    const pick = fp.pick;
    ok(!!pick, `the opening hand has a playable unit (seed ${fp.seed}, hand ${JSON.stringify(st().hand)})`);
    if (pick) {
      click(byId('card' + pick.i));
      ok(st().selected === pick.i, `clicking #card${pick.i} selects slot ${pick.i} (got ${st().selected})`);
      ok(cls('card' + pick.i).contains('sel'), 'the selected card carries the .sel ring');

      click(byId('card' + pick.i));
      ok(st().selected === null, 'clicking the same card again deselects it');

      /* With nothing selected a lane click must be refused and logged. */
      const logLen = window.CB.log().length;
      const snap = JSON.stringify(st().board) + '|' + st().energy + '|' + JSON.stringify(st().hand);
      click(byId('pSlot0'));
      ok(JSON.stringify(st().board) + '|' + st().energy + '|' + JSON.stringify(st().hand) === snap,
        'a lane click with nothing selected changes nothing');
      const lg = window.CB.log();
      ok(lg.length > logLen && lg[lg.length - 1].key === 'logNoSelection',
        `the refusal is logged as logNoSelection (got ${JSON.stringify(lg[lg.length - 1])})`);

      /* Now the real play. */
      click(byId('card' + pick.i));
      const e0 = st().energy, h0 = st().hand.length, d0 = st().discardLeft;
      click(byId('pSlot' + pick.lane));
      ok(st().energy === e0 - pick.spec.cost,
        `the play deducts the card cost ${pick.spec.cost} (${e0} -> ${st().energy})`);
      ok(st().hand.length === h0 - 1 && st().discardLeft === d0 + 1, 'the card leaves the hand into the discard');
      const u = st().board.player[pick.lane];
      ok(u && u.cardId === pick.id, `the unit lands in lane ${pick.lane} (got ${JSON.stringify(u)})`);
      ok(html('pSlot' + pick.lane).indexOf(pick.spec.en) !== -1,
        `the lane slot renders the unit name (got ${JSON.stringify(html('pSlot' + pick.lane))})`);
      ok(st().selected === null, 'a successful play clears the selection');

      /* Occupied-lane refusal: pick another unit that is legal SOMEWHERE. */
      const s1 = st();
      let other = null;
      for (let i = 0; i < s1.hand.length && !other; i++) {
        if (SPEC[s1.hand[i]].kind !== 'unit') continue;
        for (let l = 0; l < 3; l++) if (window.CB.canPlay(s1, i, l) && l !== pick.lane) other = { i, lane: l };
      }
      if (other) {
        click(byId('card' + other.i));
        const e1 = st().energy, h1 = st().hand.length;
        click(byId('pSlot' + pick.lane));
        ok(st().energy === e1 && st().hand.length === h1 && st().board.player[pick.lane].cardId === pick.id,
          'playing a unit onto an already-occupied lane is refused');
      } else {
        ok(st().hand.every(id => SPEC[id].kind !== 'unit' || SPEC[id].cost > st().energy),
          'no second affordable unit was in hand, so the occupied-lane case did not apply here');
      }
    }
  }

  /* -------------------------------------------------------------------- 5 */
  group('5. the enemy slot of a lane is the same target as the player slot');
  {
    const fp = freshPlayable([999, 1000, 1001, 1002, 1003, 1004], true);
    const pick = fp.pick;
    ok(!!pick, `a playable unit is available (seed ${fp.seed}, hand ${JSON.stringify(st().hand)})`);
    if (pick) {
      const enemyBefore = JSON.stringify(st().board.enemy);
      click(byId('card' + pick.i));
      const e0 = st().energy;
      click(byId('eSlot' + pick.lane));
      ok(st().energy === e0 - pick.spec.cost, 'clicking the ENEMY slot plays the selected card');
      const u = st().board.player[pick.lane];
      ok(u && u.cardId === pick.id, `the unit lands on the PLAYER side (got ${JSON.stringify(u)})`);
      ok(JSON.stringify(st().board.enemy) === enemyBefore, 'the enemy row is untouched by a player lane click');
      ok(html('pSlot' + pick.lane).indexOf(pick.spec.en) !== -1, 'the player slot repaints with the new unit');
    }
  }

  /* -------------------------------------------------------------------- 6 */
  group('6. real keyboard input drives the same state machine');
  {
    fresh(321);
    press('1');
    ok(st().selected === 0, `key "1" selects hand slot 0 (got ${st().selected})`);
    press('2');
    ok(st().selected === 1, `key "2" selects hand slot 1 (got ${st().selected})`);
    ok(cls('card1').contains('sel') && !cls('card0').contains('sel'), 'the .sel ring follows the keyboard selection');
    press('Escape');
    ok(st().selected === null, 'Escape clears the selection');

    const fp = freshPlayable([321, 3221, 3223, 3225, 3227, 3229], false);
    const pick = fp.pick;
    ok(!!pick, `a legal (handIndex, lane) exists (seed ${fp.seed}, hand ${JSON.stringify(st().hand)})`);
    if (pick) {
      press(String(pick.i + 1));
      const e0 = st().energy, h0 = st().hand.length;
      press(['q', 'w', 'e'][pick.lane]);
      ok(st().energy === e0 - pick.spec.cost && st().hand.length === h0 - 1,
        `"${['q', 'w', 'e'][pick.lane]}" plays the selected card into lane ${pick.lane}`);
      const u = st().board.player[pick.lane];
      ok(!!u, 'the keyboard play landed on the board');
    }

    /* The a/s/d alias for lane 0/1/2. */
    const fp2 = freshPlayable([322, 3222, 3224, 3226, 3228, 3230], false);
    const pick2 = fp2.pick;
    ok(!!pick2, `a playable card exists for the a/s/d alias (seed ${fp2.seed}, hand ${JSON.stringify(st().hand)})`);
    if (pick2) {
      press(String(pick2.i + 1));
      const e0 = st().energy;
      press(['a', 's', 'd'][pick2.lane]);
      ok(st().energy === e0 - pick2.spec.cost, `"${['a', 's', 'd'][pick2.lane]}" plays into lane ${pick2.lane}`);
    }

    press('p');
    ok(st().phase === 'paused', `key "p" pauses (got ${st().phase})`);
    ok(txt('btnPause') === 'Resume', `paused shows the Resume label (got ${JSON.stringify(txt('btnPause'))})`);
    press('p');
    ok(st().phase === 'player', 'key "p" resumes');

    press('n');
    ok(st().phase === 'player' && st().turn === 1 && st().hand.length === 4,
      `key "n" restarts a fresh, already-started game (${st().phase}/${st().turn}/${st().hand.length})`);

    press(' ');
    ok(st().phase === 'resolve', `Space ends the turn from player (got ${st().phase})`);
    ok(byId('btnEnd').disabled === true, 'End turn is disabled during resolve');

    window.CB.newGame({ seed: 5 });
    pump(1);
    ok(st().phase === 'ready', 'a bridge newGame returns to ready');
    press('Enter');
    ok(st().phase === 'player', 'Enter starts the game from ready');
    press(' ');
    ok(st().phase === 'resolve', 'Space ends the turn from player');
  }

  /* -------------------------------------------------------------------- 7 */
  group('7. a whole turn cycle by real events');
  {
    fresh(11);
    const t0 = st().turn;
    click(byId('btnEnd'));
    ok(st().phase === 'resolve', `#btnEnd hands the round to resolve (got ${st().phase})`);
    ok(txt('hint').length > 0, 'the hint line is non-empty during resolve');
    const done = framesUntil(() => st().phase === 'player' || st().phase === 'win' || st().phase === 'lose', 900);
    ok(done && st().phase === 'player', `pumping rAF frames returns to the player phase (got ${st().phase})`);
    ok(st().turn === t0 + 1, `the turn counter advanced (${t0} -> ${st().turn})`);
    ok(txt('turn') === String(st().turn), 'the #turn HUD followed the turn');
    ok(txt('energy') === st().energy + '/' + window.CB.energyFor(st().turn), 'the #energy HUD followed the refill');
    ok(txt('deckP') === String(st().deckLeft), 'the #deckP HUD followed the draw');
  }

  /* -------------------------------------------------------------------- 8 */
  group('8. real button bar: Pause / Resume / New game');
  {
    fresh(12);
    click(byId('btnPause'));
    ok(st().phase === 'paused', `#btnPause pauses (got ${st().phase})`);
    ok(txt('btnPause') === 'Resume', 'the button relabels to Resume');
    ok(cls('fx').contains('on') && txt('fx').length > 0, 'the paused banner is on screen');
    click(byId('btnPause'));
    ok(st().phase === 'player', '#btnPause resumes');

    window.CB.tick(1, 1 / 60);
    click(byId('btnNew'));
    ok(st().phase === 'player' && st().turn === 1 && st().hand.length === 4,
      `#btnNew deals and starts in one click (${st().phase}/${st().turn}/${st().hand.length})`);
    ok(txt('turn') === '1' && txt('energy') === '2/2', 'the HUD reflects the reset');
  }

  /* -------------------------------------------------------------------- 9 */
  group('9. the result overlay and the real Play-again button');
  {
    fresh(7);
    let guard = 0;
    const greedy = s => {
      const best = [];
      for (let i = 0; i < s.hand.length; i++) {
        const spec = SPEC[s.hand[i]];
        if (s.energy < spec.cost) continue;
        for (let lane = 0; lane < 3; lane++) {
          if (!window.CB.canPlay(s, i, lane)) continue;
          let score = 1;
          const foe = s.board.enemy[lane];
          if (s.hand[i] === 'fireball' && foe) score = 100 + (4 - foe.hp);
          else if (spec.kind === 'unit' && !foe) score = 60 + spec.atk;
          else if (spec.kind === 'unit' && foe && foe.hp <= spec.atk) score = 50 + spec.atk;
          else if (spec.kind === 'unit') score = 20 + spec.atk;
          else if (s.hand[i] === 'rally') score = 10;
          best.push({ i, lane, score, cost: spec.cost });
        }
      }
      if (!best.length) return null;
      best.sort((a, b) => (b.score - a.score) || (b.cost - a.cost) || (a.i - b.i) || (a.lane - b.lane));
      return best[0];
    };
    while (st().phase !== 'win' && st().phase !== 'lose' && guard++ < 2000) {
      const s = st();
      if (s.phase === 'player') {
        const pick = greedy(s);
        if (!pick || !window.CB.playCard(pick.i, pick.lane)) window.CB.endTurn();
      } else {
        window.CB.tick(0.1, 1 / 60);
      }
      pump(1);
    }
    const s = st();
    ok(s.phase === 'win' || s.phase === 'lose', `driving a real game reaches a decision (got ${s.phase})`);
    ok(cls('overlay').contains('show'), 'the result overlay is shown at a decision');
    const title = txt('ovTitle');
    ok(title === (s.phase === 'win' ? 'Victory' : 'Defeat'),
      `#ovTitle names the result (got ${JSON.stringify(title)} for ${s.phase})`);
    ok(txt('ovSub').length > 0 && txt('ovBtn') === 'Play again',
      `#ovSub is non-empty and #ovBtn offers Play again (got ${JSON.stringify(txt('ovSub'))}/${JSON.stringify(txt('ovBtn'))})`);
    ok(!cls('startOverlay').contains('show'), 'the start overlay stays hidden at the result');

    click(byId('ovBtn'));
    pump(1);
    ok(st().phase === 'player' && st().turn === 1 && st().hand.length === 4,
      `the real Play-again button restarts into a playable player phase (${st().phase}/${st().turn}/${st().hand.length})`);
    ok(!cls('overlay').contains('show'), 'the result overlay is hidden after the restart');
    ok(txt('energy') === '2/2', 'the restarted game shows the turn-1 energy again');
  }

  /* ------------------------------------------------------------------- 10 */
  group('10. the HUD always mirrors getState and really changes');
  {
    fresh(21);
    let bad = 0, samples = [], firstBad = '';
    for (let i = 0; i < 40; i++) {
      if (st().phase === 'player') click(byId('btnEnd'));
      pump(24, 16);
      const s = st();
      const checks = [
        ['turn', String(s.turn)], ['energy', s.energy + '/' + window.CB.energyFor(s.turn)],
        ['php', String(s.playerHp)], ['ehp', String(s.enemyHp)],
        ['deckP', String(s.deckLeft)], ['deckE', String(s.enemyDeckLeft)]
      ];
      for (const [id, want] of checks) {
        if (txt(id) !== want) { bad++; if (!firstBad) firstBad = `#${id} ${JSON.stringify(txt(id))} vs ${JSON.stringify(want)}`; }
      }
      samples.push(txt('turn') + '|' + txt('energy') + '|' + txt('php') + '|' + txt('ehp') + '|' + txt('deckP'));
      if (s.phase === 'win' || s.phase === 'lose') break;
    }
    ok(bad === 0, `every HUD node mirrors getState across the run (${bad} mismatches)` + (firstBad ? ` first ${firstBad}` : ''));
    ok(new Set(samples).size > 1,
      `at least one HUD value actually changed across ${samples.length} samples (a frozen HUD would be one value)`);
    /* A frozen HUD is the classic silent defect - pin the change explicitly. */
    const ui = window.CB.getState();
    ok(txt('php') === String(ui.playerHp) && txt('ehp') === String(ui.enemyHp) && txt('deckP') === String(ui.deckLeft),
      'the HP and deck nodes still agree with getState at the end');
  }

  /* ------------------------------------------------------------------- 11 */
  group('11. the language switcher is <a> and real clicks re-localise everything');
  {
    const links = [...doc.querySelectorAll('[data-lang-switch] a')];
    ok(links.length === 2, `the switcher rendered two links (got ${links.length})`);
    ok(links.length === 2 && links.every(a => a.tagName === 'A'), 'both switcher entries are <a>, not <button>');
    const zhLink = links.find(a => a.getAttribute('data-lang') === 'zh');
    const enLink = links.find(a => a.getAttribute('data-lang') === 'en');
    ok(!!zhLink && !!enLink, 'there are en and zh links');
    ok(!!zhLink && zhLink.textContent === '简体中文', `the zh link is labelled 简体中文 (got ${zhLink && zhLink.textContent})`);

    fresh(31);
    const enHint = txt('hint');
    ok(enHint.length > 0 && !CJK.test(enHint), `#hint starts English (got ${JSON.stringify(enHint)})`);
    ok(!CJK.test(html('log')) && html('log').length > 0, 'the combat log starts English');
    const h1 = $('h1[data-i18n="title"]');
    ok(!!h1 && !CJK.test(h1.textContent), `the static title starts English (got ${h1 && JSON.stringify(h1.textContent)})`);

    click(zhLink);
    await sleep(60);
    ok(doc.documentElement.lang === 'zh-CN', `document lang is zh-CN after the click (got ${doc.documentElement.lang})`);
    ok(window.localStorage.getItem('litegame_lang') === 'zh', 'the choice is persisted to localStorage');
    ok(CJK.test(h1.textContent), `the STATIC title is Chinese (got ${JSON.stringify(h1.textContent)})`);
    ok(CJK.test(txt('hint')), `the DYNAMIC #hint is Chinese via T.onChange (got ${JSON.stringify(txt('hint'))})`);
    ok(CJK.test(html('log')), `the DYNAMIC #log is Chinese (got ${JSON.stringify(html('log').slice(0, 60))})`);
    ok(CJK.test(txt('btnEnd')), `the End-turn button is Chinese (got ${JSON.stringify(txt('btnEnd'))})`);
    window.CB.newGame({ seed: 31 });
    pump(1);
    ok(CJK.test(txt('fx')), `the DYNAMIC phase banner is Chinese (got ${JSON.stringify(txt('fx'))})`);
    ok(!/Press start/i.test(txt('fx')), 'the old English banner text is gone');

    click(enLink);
    await sleep(60);
    ok(doc.documentElement.lang === 'en', 'document lang is back to en');
    ok(window.localStorage.getItem('litegame_lang') === 'en', 'the en choice is persisted');
    ok(!CJK.test(h1.textContent), 'the static title is English again');
    window.CB.start();
    pump(1);
    ok(!CJK.test(txt('hint')) && !CJK.test(html('log')), '#hint and #log are English again');

    /* A real click on the active switch is the same language, so nothing breaks. */
    click(enLink);
    await sleep(20);
    ok(doc.documentElement.lang === 'en' && errs.length === 0, 'clicking the active language is a no-op');
  }

  /* ------------------------------------------------------------------- 12 */
  group('12. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));
  ok(window.__ctxCalls === 0, `getContext was still never called at the end (${window.__ctxCalls} calls)`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
