#!/usr/bin/env node
/**
 * Real-DOM check for link-game.
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id and `querySelectorAll` returns an
 * empty array; the vm sandbox has no DOM at all. Both hide whole bug classes
 * — a dangling id, a listener that was never bound, a board whose tiles are
 * not really the clickable children, or a decoration layer that leaks INTO
 * the board. This script runs the page for real in jsdom and drives it with
 * real events:
 *
 *   - the page loads with zero jsdom errors and `window.LL` is live in
 *     'ready';
 *   - the difficulty select really rebuilds the board (36 / 80 / 64 tiles)
 *     and clicking the actual Start button leaves the ready state;
 *   - clicking two ACTUAL tiles that LL.findPair() says are linkable removes
 *     them, raises the score and drops pairsLeft;
 *   - clicking two same-pattern tiles that CANNOT be linked denies the pair,
 *     moves the selection and changes nothing;
 *   - the real Hint / Shuffle buttons cost points through real clicks;
 *   - the actual HUD / notice / result DOM text follows T.set('zh') / 'en';
 *   - the link line and the floating decorations appear on their own layers
 *     (siblings of #board) and are recycled again;
 *   - every element id the game reaches for exists (getElementById !== null).
 *
 * jsdom lives in an isolated directory so this repo stays dependency-free.
 * A file:// origin throws on localStorage, so run it over http:
 *
 *   cd <repo-root> && python3 -m http.server 8132 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> \
 *     node tools/link-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy can be fed
 * to the same script to prove it is not vacuous.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8132/link-game/';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}
function group(title) { console.log(`\n[${title}]`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CJK = /[\u4e00-\u9fff]/;

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));

  const opts = { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc };
  const dom = await JSDOM.fromURL(TARGET, opts);
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  await new Promise(r => window.addEventListener('load', () => setTimeout(r, 3000)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  const text = s => { const n = $(s); return n ? n.textContent : ''; };
  const st = () => window.LL.getState();
  const tiles = () => [...doc.querySelectorAll('#board > .tile')];
  const tileAt = (r, c) => tiles()[r * window.LL.cols + c];
  const boardDirect = () => [...$('#board').children];

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  function change(val) {
    const sel = doc.getElementById('difficulty');
    sel.value = val;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  }
  // Settle the rAF phase machine (jsdom pretendToBeVisual drives real timers).
  async function settle(maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 4000)) {
      if (window.phase === 'idle' && window.status === 'playing') return true;
      await sleep(25);
    }
    return window.phase === 'idle' && window.status === 'playing';
  }

  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.LL, 'window.LL bridge exists in the real page');
  ok(!!st() && st().status === 'ready', `the game boots into 'ready' (got ${st() && st().status})`);
  ok(typeof window.LL.canConnect === 'function' && typeof window.LL.findPair === 'function',
    'canConnect / findPair are exposed on the bridge');
  ok(st().pairsLeft === 32 && st().hintsLeft === 3 && st().score === 0,
    `fresh normal game: 32 pairs, 3 hints, score 0 (got ${st().pairsLeft}/${st().hintsLeft}/${st().score})`);
  ok(tiles().length === 64, `the real board has 64 tile nodes (got ${tiles().length})`);
  ok(/^7:0\d$/.test(text('#time')), `the clock shows the full 420s (got ${JSON.stringify(text('#time'))})`);

  group('1b. the decoration layers are SIBLINGS of the board, never inside it');
  {
    const board = $('#board'), fx = $('#fxLayer'), link = $('#linkLayer');
    ok(!!board && !!fx && !!link, '#board, #fxLayer and #linkLayer all exist');
    ok(!!fx && fx.parentElement === board.parentElement, "the fx layer shares the board's parent (.board-wrap)");
    ok(!!link && link.parentElement === board.parentElement, "the link layer shares the board's parent (.board-wrap)");
    ok(!!fx && !board.contains(fx) && !board.contains(link), 'neither layer is a descendant of #board');
    const direct = boardDirect();
    ok(direct.length === 64, `#board has exactly 64 direct children (got ${direct.length})`);
    ok(direct.every(ch => /\btile\b/.test(ch.className || '')),
      'every direct child of #board is a .tile — no decoration leaked into the board');
    ok(fx.children.length === 0 && link.children.length === 0, 'both decoration layers are empty at boot');
  }

  group('2. the difficulty select rebuilds the board, Start leaves ready');
  {
    change('easy');
    ok(window.LL.rows === 6 && window.LL.cols === 6, `easy is 6x6 (got ${window.LL.rows}x${window.LL.cols})`);
    ok(tiles().length === 36, `easy board has 36 tiles (got ${tiles().length})`);
    change('hard');
    ok(window.LL.rows === 10 && window.LL.cols === 8, `hard is 10x8 (got ${window.LL.rows}x${window.LL.cols})`);
    ok(tiles().length === 80, `hard board has 80 tiles (got ${tiles().length})`);
    change('normal');
    ok(tiles().length === 64, 'back to normal: 64 tiles again');
    ok(!!$('#btnStart'), 'the Start button is present');
    click($('#btnStart'));
    ok(st().status === 'playing', `clicking Start enters 'playing' (got ${st().status})`);
    ok(!$('#startOverlay').classList.contains('show'), 'the start overlay is hidden');
    ok(tiles().length === 64, 'the board still has 64 real tiles after starting');
    // DOM <-> state parity: the first tile shows the emoji of grid[0][0].
    const v = window.grid[0][0];
    ok(tileAt(0, 0).textContent === window.KINDS[v],
      `tile(0,0) shows the emoji of grid[0][0] (got ${JSON.stringify(tileAt(0, 0).textContent)})`);
  }

  group('3. a real click on a linkable pair removes both tiles');
  {
    await settle();
    const pair = window.LL.findPair();           // board coords [[r,c],[r,c]]
    ok(!!pair, 'findPair finds a linkable pair on the live board');
    const before = st();
    const t1 = tileAt(pair[0][0], pair[0][1]);
    click(t1);
    ok(/\bsel\b/.test(t1.className), 'the first real click selects the tile');
    click(tileAt(pair[1][0], pair[1][1]));
    const justAfter = st();
    ok(justAfter.score === before.score + 10, `the pair scores +10 (${before.score} -> ${justAfter.score})`);
    ok(justAfter.pairsLeft === before.pairsLeft,
      `pairsLeft only drops when the clear animation finishes (${before.pairsLeft} -> ${justAfter.pairsLeft})`);
    const settled = await settle();
    ok(settled, 'the clear animation resolves back to idle');
    const e1 = tileAt(pair[0][0], pair[0][1]), e2 = tileAt(pair[1][0], pair[1][1]);
    ok(/\bempty\b/.test(e1.className) && e1.textContent === '', 'the first tile node is emptied');
    ok(/\bempty\b/.test(e2.className) && e2.textContent === '', 'the second tile node is emptied');
    ok(st().score === before.score + 10 && st().pairsLeft === before.pairsLeft - 1,
      'the state change stuck after the animation');
  }

  group('3b. the link line and floats appear on their own layers, then recycle');
  {
    await settle();
    const fx = $('#fxLayer'), link = $('#linkLayer');
    const pair = window.LL.findPair();
    ok(!!pair, 'another linkable pair is available for the fx check');
    let sawLink = false, sawFloat = false, linkPeak = 0, fxPeak = 0;
    click(tileAt(pair[0][0], pair[0][1]));
    click(tileAt(pair[1][0], pair[1][1]));
    for (let i = 0; i < 250; i++) {
      linkPeak = Math.max(linkPeak, link.children.length);
      fxPeak = Math.max(fxPeak, fx.children.length);
      if (link.children.length > 0) sawLink = true;
      if (fx.querySelector('.fx-float')) sawFloat = true;
      if (i > 20 && window.phase === 'idle' && fx.children.length === 0 && link.children.length === 0) break;
      await sleep(20);
    }
    ok(sawLink, 'the SVG link line appeared on #linkLayer during the clear');
    ok(linkPeak >= 1, `#linkLayer held the path while flashing (peak ${linkPeak})`);
    ok(sawFloat, 'the floating score appeared on #fxLayer');
    await sleep(1200);                     // longest ttl is 1000ms
    ok(link.children.length === 0 && fx.children.length === 0,
      `both layers recycled everything (link=${link.children.length}, fx=${fx.children.length})`);
    ok(boardDirect().length === 64 && boardDirect().every(ch => /\btile\b/.test(ch.className || '')),
      'no decoration ever landed inside #board');
  }

  group('4. a real click on an UNLINKABLE same-pattern pair denies it');
  {
    // Find a deterministic seed whose board actually contains a same-pattern
    // pair that cannot be linked (proves the deny path with real clicks).
    let seed = 0, bad = null;
    for (let k = 1; k <= 80 && !bad; k++) {
      window.LL.newGame({ difficulty: 'normal', seed: k });
      const g = window.grid;
      const byVal = {};
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        (byVal[g[r][c]] = byVal[g[r][c]] || []).push([r, c]);
      }
      outer:
      for (const key of Object.keys(byVal)) {
        const list = byVal[key];
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          if (window.LL.canConnect(list[i], list[j]) === null) { bad = [list[i], list[j]]; break outer; }
        }
      }
      if (bad) seed = k;
    }
    ok(!!bad, `found a seeded board with an unlinkable same-pattern pair (seed ${seed}: ${JSON.stringify(bad)})`);
    await settle();
    const before = st();
    const t1 = tileAt(bad[0][0], bad[0][1]);
    click(t1);
    click(tileAt(bad[1][0], bad[1][1]));
    const after = st();
    ok(after.score === before.score && after.pairsLeft === before.pairsLeft,
      'the unlinkable pair scores nothing and removes nothing');
    ok(!/\bempty\b/.test(t1.className), 'the first tile is still on the board');
    ok(JSON.stringify(after.selected) === JSON.stringify(bad[1]),
      `the selection moved to the second tile (got ${JSON.stringify(after.selected)})`);
    ok(/no path/i.test(text('#notice')), `the notice explains the denial (got ${JSON.stringify(text('#notice'))})`);
    const settled = await settle();
    ok(settled, 'the deny shake settles back to idle');
  }

  group('5. the real Hint and Shuffle buttons cost points');
  {
    window.LL.newGame({ difficulty: 'normal', seed: 7 });
    await settle();
    click($('#btnHint'));
    ok(st().hintsLeft === 2 && st().score === 0, `a hint spends a charge and clamps at 0 (got ${st().hintsLeft}/${st().score})`);
    ok(text('#hints') === '2', `the hints HUD updates (got ${JSON.stringify(text('#hints'))})`);
    ok([...doc.querySelectorAll('#board > .tile.hint')].length === 2, 'exactly two tiles carry the hint highlight');
    window.score = 45; window.updateHud();       // give the button a real balance to spend
    click($('#btnShuffle'));
    ok(st().score === 15, `a manual shuffle costs 30 (${45} -> ${st().score})`);
    const settled = await settle(6000);          // shuffling + dealing animations
    ok(settled, 'the shuffle/deal cycle returns to idle');
    ok(st().pairsLeft === 32, `the shuffle kept every pair (got ${st().pairsLeft})`);
    ok(window.LL.findPair() !== null, 'the shuffled board still has a linkable pair');
  }

  group('6. language switch re-renders the REAL DOM text');
  {
    const scoreLabel = () => text('[data-i18n="score"]');
    window.T.set('zh');
    await sleep(60);
    ok(window.T.lang === 'zh', 'the live language is zh');
    ok(text('#levelLabel') === '普通', `the level label is Chinese (got ${JSON.stringify(text('#levelLabel'))})`);
    ok(CJK.test(text('#notice')), `the notice line is Chinese (got ${JSON.stringify(text('#notice'))})`);
    ok(CJK.test(scoreLabel()), `the static HUD label is Chinese (got ${JSON.stringify(scoreLabel())})`);
    ok(/苹果|橙子|柠檬|西瓜|葡萄|草莓/.test(tileAt(0, 0).title),
      `a tile tooltip is a Chinese fruit name (got ${JSON.stringify(tileAt(0, 0).title)})`);
    // Result dialog text, driven through endGame -> updateHud.
    window.endGame(true);
    window.T.set('en');
    window.T.set('zh');
    await sleep(60);
    ok(CJK.test(text('#dlgTitle')), `the result title is Chinese (got ${JSON.stringify(text('#dlgTitle'))})`);
    ok(CJK.test(text('#dlgSub')), `the result subtitle is Chinese (got ${JSON.stringify(text('#dlgSub'))})`);
    window.T.set('en');
    await sleep(60);
    ok(window.T.lang === 'en', 'back to English');
    ok(!CJK.test(text('#dlgTitle')), `the result title is English again (got ${JSON.stringify(text('#dlgTitle'))})`);
    ok(!CJK.test(scoreLabel()), `the static HUD label is English again (got ${JSON.stringify(scoreLabel())})`);
    // The real switcher links exist (i18n.mount ran) and one really works.
    const links = [...doc.querySelectorAll('.lang-switch a')];
    ok(links.length === 2, `the language switcher rendered two links (got ${links.length})`);
    const zhLink = links.find(a => a.getAttribute('data-lang') === 'zh');
    if (zhLink) { click(zhLink); await sleep(60); }
    ok(!!zhLink && window.T.lang === 'zh', 'clicking the real 中文 link switches the language');
    window.T.set('en');
    await sleep(60);
  }

  group('7. no dangling element ids (real getElementById)');
  {
    const ids = ['board', 'fxLayer', 'linkLayer', 'score', 'time', 'pairs', 'combo', 'hints', 'best',
      'levelLabel', 'notice', 'difficulty', 'btnNew', 'btnStart', 'btnHint', 'btnShuffle',
      'dlgTitle', 'dlgSub', 'dlgBtn', 'startOverlay', 'overlay'];
    const missing = ids.filter(id => doc.getElementById(id) === null);
    ok(missing.length === 0, `every id the game needs resolves (missing: ${JSON.stringify(missing)})`);
  }

  group('8. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
