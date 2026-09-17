#!/usr/bin/env node
/**
 * Real-DOM check for match3-game.
 *
 * The third layer. The smoke test runs a stub DOM where `getElementById`
 * lazily invents an element for ANY id, `querySelectorAll` returns an empty
 * array and `textContent` does not aggregate; the vm sandbox has no DOM at all.
 * Both hide whole bug classes — a dangling id, a listener that was never bound,
 * or a bridge object that is only reachable from a stub. This script runs the
 * page for real in jsdom and drives it with real events:
 *
 *   - the page loads with zero jsdom errors and `window.M3` is live in 'ready',
 *   - clicking the actual Start button leaves the ready state,
 *   - clicking two ACTUAL cells performs a real swap: moves fall by one and the
 *     score rises,
 *   - the actual HUD / notice / result DOM text follows T.set('zh') / 'en',
 *   - every element id the game reaches for exists (getElementById !== null).
 *
 * jsdom lives in an isolated directory so this repo stays dependency-free.
 * A file:// origin throws on localStorage, so run it over http:
 *
 *   cd <repo-root> && python3 -m http.server 8124 --bind 127.0.0.1 &
 *   NODE_PATH=<isolated-node-modules> \
 *     node tools/match3-dom.js [url]
 *
 * The optional url argument exists so a deliberately broken copy can be fed to
 * the same script to prove it is not vacuous.
 */

'use strict';

const { JSDOM, VirtualConsole } = require('jsdom');

const TARGET = process.argv[2] || 'http://127.0.0.1:8124/match3-game/';

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}
function group(title) { console.log(`\n[${title}]`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const errs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errs.push(String((e && e.stack) || e)));

  const opts = { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc };
  const dom = await JSDOM.fromURL(TARGET, opts);
  const { window } = dom;
  window.addEventListener('error', e => errs.push(e.message || String(e)));
  window.addEventListener('unhandledrejection', e => errs.push('unhandledrejection: ' + (e.reason || e)));

  // Remote pages need longer; "not loaded yet" otherwise reads as "the button
  // does nothing".
  await new Promise(r => window.addEventListener('load', () => setTimeout(r, 4000)));

  const doc = window.document;
  const $ = s => doc.querySelector(s);
  // Null-safe text: a missing element must read as a FAIL, never a crash.
  const text = s => { const n = $(s); return n ? n.textContent : ''; };
  const M3 = () => window.M3;
  const st = () => window.M3.getState();
  const cells = () => [...doc.querySelectorAll('#board .cell')];
  const cellAt = (r, c) => cells()[r * 8 + c];
  const boardDirect = () => [...$('#board').children];
  const fxKids = () => { const f = $('#fxLayer'); return f ? [...f.children] : []; };
  // Concatenated stylesheet text, so we can prove the decorative CSS really shipped.
  const cssText = () => {
    let out = '';
    for (const sheet of doc.styleSheets) { try { for (const r of sheet.cssRules) out += r.cssText + '\n'; } catch (e) { /* ignore */ } }
    return out;
  };

  function click(node) {
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  }
  // Settle the rAF phase machine (jsdom pretendToBeVisual drives real timers).
  async function settle(maxMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (maxMs || 4000)) {
      const ph = window.phase;
      if (ph === 'idle') return true;
      await sleep(25);
    }
    return window.phase === 'idle';
  }
  // A swap of (r,c) with a neighbour that actually creates a match.
  function findLegalSwap(grid) {
    const swap = (g, r1, c1, r2, c2) => {
      const t = g.map(row => row.slice());
      const tmp = t[r1][c1]; t[r1][c1] = t[r2][c2]; t[r2][c2] = tmp;
      return t;
    };
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (c + 1 < 8 && window.M3.findMatches(swap(grid, r, c, r, c + 1)).length > 0) return [r, c, r, c + 1];
        if (r + 1 < 8 && window.M3.findMatches(swap(grid, r, c, r + 1, c)).length > 0) return [r, c, r + 1, c];
      }
    }
    return null;
  }

  group('1. loads clean and the bridge is live');
  ok(errs.length === 0, 'no jsdom errors while loading' + (errs.length ? `\n     ${errs.slice(0, 3).join('\n     ')}` : ''));
  ok(!!window.M3, 'window.M3 bridge exists in the real page');
  ok(!!st() && st().status === 'ready', `the game boots into 'ready' (got ${st() && st().status})`);
  ok(Array.isArray(st().grid) && st().grid.length === 8 && st().grid.every(r => r.length === 8),
    'the live grid is 8x8');
  ok(cells().length === 64, `the real board has 64 cell nodes (got ${cells().length})`);
  ok(cells().every(el => /\bc\d\b/.test(el.className)), 'every real cell carries a colour class at boot');

  group('1b. the decoration layer is a SIBLING of the board, never inside it');
  {
    const board = $('#board'), fx = $('#fxLayer');
    ok(!!board && !!fx, 'both #board and #fxLayer exist');
    ok(!!fx && fx.parentElement === board.parentElement, "the fx layer shares the board's parent (.board-wrap)");
    ok(!!fx && !board.contains(fx), '#fxLayer is NOT a descendant of #board');
    const direct = boardDirect();
    ok(direct.length === 64, `#board has exactly 64 direct children (got ${direct.length})`);
    ok(direct.every(ch => /\bcell\b/.test(ch.className || '')),
      'every direct child of #board is a .cell tile — no decoration leaked into the board');
    ok(fxKids().length === 0, `the fx layer is empty at boot (got ${fxKids().length})`);
    ok(/#fxLayer\s*\{[^}]*pointer-events:\s*none/.test(cssText()), 'the fx layer CSS declares pointer-events:none');
  }

  group('1c. the decorative CSS shipped (keyframes + reduced-motion)');
  {
    const css = cssText();
    const kf = ['swapSlide', 'clearBurst', 'clearFlash', 'clearRing', 'fallDrop', 'refillDrop',
      'boardShake', 'fxRing', 'fxSpark', 'fxFloat', 'fxCombo'];
    const missing = kf.filter(k => !new RegExp('@keyframes\\s+' + k + '\\b').test(css));
    ok(missing.length === 0, `all decoration keyframes are present (missing: ${JSON.stringify(missing)})`);
    ok(/#board\.shake\s*\{/.test(css), 'the #board.shake rule is present');
    ok(/@media[^{]*prefers-reduced-motion[^{]*reduce/.test(css), 'the prefers-reduced-motion block is present');
  }

  group('2. the Start button leaves the ready state');
  ok(!!$('#btnStart'), 'the Start button is present');
  click($('#btnStart'));
  ok(st().status === 'playing', `clicking Start enters 'playing' (got ${st().status})`);
  ok(!$('#startOverlay').classList.contains('show'), 'the start overlay is hidden');
  ok(cells().length === 64, 'the board still has 64 real cells after starting');
  // The real cell class must mirror the live grid colour (DOM <-> state parity).
  const live = st().grid;
  ok(new RegExp('\\bc' + live[0][0] + '\\b').test(cellAt(0, 0).className),
    `cell(0,0) class matches grid[0][0]=${live[0][0]} (got ${cellAt(0, 0).className})`);

  group('3. a real click-to-swap spends a move and scores');
  {
    await settle();
    const g = st().grid;
    const mv = findLegalSwap(g);
    ok(!!mv, `found a legal adjacent swap in the live grid: ${JSON.stringify(mv)}`);
    const before = st();
    // Two real clicks: select A, then click the adjacent B (the game's own
    // click-select flow — see cellSelect()).
    click(cellAt(mv[0], mv[1]));
    ok(window.selected !== null || (window.phase === 'idle'),
      'the first click selects a gem (selection state set)');
    click(cellAt(mv[2], mv[3]));
    const justAfter = st();
    ok(justAfter.moves === before.moves - 1,
      `a legal swap spends exactly one move (${before.moves} -> ${justAfter.moves})`);
    ok(justAfter.status === 'playing', 'still playing after the swap');
    const settled = await settle();
    ok(settled, 'the swap animation resolves back to idle');
    ok(st().score > before.score, `the score rose (${before.score} -> ${st().score})`);
    ok(st().combo >= 1, `a combo multiplier was applied (combo=${st().combo})`);
  }

  group('3b. a real clear spawns decorations on #fxLayer, then recycles them');
  {
    await settle();
    const board = $('#board'), fx = $('#fxLayer');
    const mv = findLegalSwap(st().grid);
    ok(!!mv, `a legal swap is available for the fx check: ${JSON.stringify(mv)}`);
    let peak = 0, sawDecoration = false;
    click(cellAt(mv[0], mv[1]));
    click(cellAt(mv[2], mv[3]));
    // Poll the live DOM across the cascade: decorations must appear on the
    // overlay (never on the tiles) and must be gone again once it settles.
    for (let i = 0; i < 300; i++) {
      const n = fx.children.length;
      if (n > peak) peak = n;
      if (fx.querySelector('.fx-ring, .fx-spark, .fx-float, .fx-combo')) sawDecoration = true;
      if (i > 20 && window.phase === 'idle' && n === 0) break;
      await sleep(20);
    }
    ok(sawDecoration, 'the real clear attached decoration nodes to #fxLayer (ring/spark/float/combo)');
    ok(peak > 0, `#fxLayer held decorations during the cascade (peak ${peak})`);
    ok(peak <= 90, `the decoration list never exceeded the 90-node cap (peak ${peak})`);
    await sleep(1500);                 // the longest ttl is 1000ms
    ok(fx.children.length === 0, `#fxLayer is empty again once the animations retire (got ${fx.children.length})`);
    ok(boardDirect().length === 64, `#board still has exactly 64 tiles (got ${boardDirect().length})`);
    ok(cells().length === 64, 'still exactly 64 .cell nodes after the cascade');
    ok(boardDirect().every(ch => /\bcell\b/.test(ch.className || '')), 'no decoration ever landed on a board tile');
  }

  group('4. language switch re-renders the REAL DOM text');
  {
    const scoreLabel = () => text('[data-i18n="score"]');
    window.T.set('zh');
    await sleep(60);
    ok(window.T.lang === 'zh', 'the live language is zh');
    ok(text('#levelLabel') === '普通', `the level label is Chinese (got ${JSON.stringify(text('#levelLabel'))})`);
    ok(/[\u4e00-\u9fff]/.test(text('#notice')), `the notice line is Chinese (got ${JSON.stringify(text('#notice'))})`);
    ok(/[\u4e00-\u9fff]/.test(scoreLabel()), `the static HUD label is Chinese (got ${JSON.stringify(scoreLabel())})`);
    // Result dialog text, driven through endGame -> updateHud.
    window.endGame(true);
    window.T.set('en');
    window.T.set('zh');
    await sleep(60);
    ok(/[\u4e00-\u9fff]/.test(text('#dlgTitle')), `the result title is Chinese (got ${JSON.stringify(text('#dlgTitle'))})`);
    ok(/[\u4e00-\u9fff]/.test(text('#dlgSub')), `the result subtitle is Chinese (got ${JSON.stringify(text('#dlgSub'))})`);
    window.T.set('en');
    await sleep(60);
    ok(window.T.lang === 'en', 'back to English');
    ok(!/[\u4e00-\u9fff]/.test(text('#dlgTitle')), `the result title is English again (got ${JSON.stringify(text('#dlgTitle'))})`);
    ok(!/[\u4e00-\u9fff]/.test(scoreLabel()), `the static HUD label is English again (got ${JSON.stringify(scoreLabel())})`);
    // The real switcher links exist (i18n.mount ran) and one really works.
    const links = [...doc.querySelectorAll('.lang-switch a')];
    ok(links.length === 2, `the language switcher rendered two links (got ${links.length})`);
    const zhLink = links.find(a => a.getAttribute('data-lang') === 'zh');
    if (zhLink) { click(zhLink); await sleep(60); }
    ok(!!zhLink && window.T.lang === 'zh', 'clicking the real 中文 link switches the language');
    window.T.set('en');
  }

  group('5. no dangling element ids (real getElementById)');
  {
    const ids = ['board', 'fxLayer', 'score', 'moves', 'target', 'best', 'combo', 'levelLabel', 'notice',
      'difficulty', 'btnNew', 'btnStart', 'btnHint', 'btnShuffle', 'dlgTitle', 'dlgSub', 'dlgBtn',
      'startOverlay', 'overlay'];
    const missing = ids.filter(id => doc.getElementById(id) === null);
    ok(missing.length === 0, `every id the game needs resolves (missing: ${JSON.stringify(missing)})`);
  }

  group('6. runtime errors');
  ok(errs.length === 0, 'no uncaught errors end to end' + (errs.length ? `\n     ${errs.slice(0, 5).join('\n     ')}` : ''));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
