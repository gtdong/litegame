#!/usr/bin/env node
/**
 * Rule / logic tests for pinball-game (a canvas-2D portrait pinball table).
 *
 * `tools/smoke.js` only proves the page parses and does not throw: its stub DOM
 * invents an element for ANY id, returns [] from querySelectorAll, hands back a
 * permissive callable Proxy for the 2D context and asserts no value at all. It
 * cannot tell whether the free-fall integral is calibrated, whether the drain
 * gap is where the README says, whether the seeded stream is the only source of
 * randomness, whether a ball left alone really drains, or whether the dynamic
 * i18n text re-renders on a language switch. This suite loads the whole inline
 * <script> in a vm sandbox with the same stub DOM and asserts behaviour through
 * the game's own bridge object `window.PB`.
 *
 * Why this layer exists, and why it is NOT a copy of the game:
 *
 *  1. The oracle problem. Comparing an implementation to a re-typed copy of
 *     itself proves nothing. So the geometry primitives are checked against a
 *     method of a DIFFERENT shape (a 2000-point brute-force sweep, a clamp-based
 *     ground truth, algebraic properties) and the integrator is checked against
 *     a closed form re-derived from scratch (the semi-implicit gain
 *     GRAVITY·h²·n(n+1)/2, plus one analytic bumper bounce).
 *
 *  2. The documentation contract. The README constant table is parsed out of
 *     the markdown and every row compared to PB.constants, and the geometry
 *     prose is compared to PB.world(). This is the ONLY test that can catch
 *     someone silently editing the shipped data, because an oracle that reads
 *     its expectations from PB.constants agrees with the code by construction.
 *
 *  3. The stub-DOM boundary the game must live inside. `document.querySelectorAll`
 *     is empty, so data-i18n marker translation is a no-op here; but the HUD is
 *     written through getElementById, so the DYNAMIC text (msg / launch / over)
 *     can still be read back and proved to re-localise - the project's classic
 *     silent defect. localStorage has no removeItem; timers do not fire; the 2D
 *     context is a chainable callable Proxy whose ctx.canvas.width is not a
 *     number, which is exactly why the game must never read geometry back from
 *     the canvas (asserted statically).
 *
 *  4. The invariants that only appear over thousands of steps. 30+ seeds are
 *     driven to completion with NO input and the ball is checked to never leave
 *     the table (the tunnelling tell), never carry a NaN, never fire `respawn`,
 *     never depend on the `timeout` cap, and never exceed MAX_SPEED. Then a
 *     flipper-abuse run hammers the flippers and the peak speed is checked
 *     against energyCeiling(). A trivial flipper bot must outscore an idle
 *     player, so the score genuinely tracks play.
 *
 * Reverse validation (group 12) re-injects deliberate bugs into a string copy of
 * the page inside this file and asserts the matching rule goes red, so a
 * vacuously-green comparator cannot hide.
 *
 * Usage:  node tools/pinball-test.js [path/to/index.html] [path/to/assets/i18n.js]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'pinball-game', 'index.html');
const I18N = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(ROOT, 'assets', 'i18n.js');
const README_EN = path.join(ROOT, 'pinball-game', 'README.md');
const README_ZH = path.join(ROOT, 'pinball-game', 'README.zh.md');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const CJK = /[\u4e00-\u9fff]/;
const relClose = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-5 : tol) * Math.max(1, Math.abs(b));
const hyp = (x, y) => Math.sqrt(x * x + y * y);

/* ------------------------------------------------------------------ stub DOM */
/* Mirrors cardbattle-test.js / smoke.js makeContext: getElementById lazily
 * invents an element for ANY id, querySelectorAll is empty, getAttribute is
 * null, localStorage has no removeItem, setTimeout is a no-op and only rAF
 * advances the game. The one addition over the cardbattle stub is the canvas
 * context: pinball-game calls getContext('2d'), so the stub returns a chainable
 * callable Proxy (from invaders-dom.js) whose every property is the same Proxy.
 * Geometry is never read back from it - that is asserted statically in group 1. */

function makeContext() {
  const ctxProxy = new Proxy(function () {}, {
    apply: () => ctxProxy,
    get: (t, k) => (k === 'then' ? undefined : ctxProxy)
  });

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
      this.width = 480;
      this.height = 720;
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
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 480, bottom: 720, width: 480, height: 720 }; }
  }

  const els = {};
  const docHandlers = {};
  const winHandlers = {};
  let frame = null;
  let clockMs = 0;

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    performance: { now: () => clockMs },
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
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
  context.addEventListener = (t, f) => { (winHandlers[t] = winHandlers[t] || []).push(f); };
  context.removeEventListener = () => {};
  vm.createContext(context);

  return {
    context, els,
    fireDoc(t, ev) { (docHandlers[t] || []).forEach(f => f(ev || {})); },
    fireWin(t, ev) { (winHandlers[t] || []).forEach(f => f(ev || {})); },
    step(dt) { clockMs += (dt === undefined ? 16 : dt); const f = frame; frame = null; if (f) f(clockMs); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

/* Boot the game from a list of inline <script> bodies. LiteI18N.create is
 * wrapped so the game's private `T` instance is captured without touching the
 * source (T lives inside the IIFE), which is what lets the i18n group prove the
 * language switch really re-renders the dynamic text. */
function bootEnv(scriptBodies, i18nFile) {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(i18nFile, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const orig = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = orig(dict); return T; };
  scriptBodies.forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `pinball/index.html#script${i}` });
  });
  env.step();                                   // one real rAF frame (update + paint)
  return { env, PB: env.context.PB, T, els: env.els };
}
function boot(gameFile, i18nFile) {
  return bootEnv(inlineScripts(fs.readFileSync(gameFile, 'utf8')), i18nFile);
}
function bootSource(srcHtml, i18nFile) {
  return bootEnv(inlineScripts(srcHtml), i18nFile);
}

/* Setup the static-gate text helpers shared by group 1 and group 12. */
function stripComments(html) {
  return html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
}
function markupOnly(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, ' ');
}

/* ------------------------------------------------------------------ README --- */
/* Parse the constant table. Row shapes to survive:
 *   `W` / `H`                     | 480 / 720        | px      (N names, N values)
 *   `PHYS_STEP`                   | 1/240 (= 0.0041667) | s    (a fraction is ONE value)
 *   `FLIPPER_ACTIVE_ANGLE`        | −0.55            | rad     (U+2212 minus)
 * The rule: split the value cell on '/' only when the row has N names and N
 * values; otherwise the whole cell is a single (possibly fractional) value. */
function evalNum(s) {
  s = String(s).trim()
    .replace(/\u2212/g, '-')          // U+2212 minus
    .replace(/[×✕]/g, '*')
    .replace(/[(（].*?[)）]/g, '')      // drop "(= 0.0041667)" / full-width parens
    .replace(/\s+/g, '');
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  if (/^-?\d+(\.\d+)?\/-?\d+(\.\d+)?$/.test(s)) {
    const p = s.split('/'); return parseFloat(p[0]) / parseFloat(p[1]);
  }
  return NaN;
}
function parseValueCell(cell, n) {
  const clean = String(cell).replace(/[(（].*?[)）]/g, ' ').trim();
  if (n === 1) { const v = evalNum(cell); return isNaN(v) ? null : [v]; }
  const parts = clean.split('/').map(s => s.trim()).filter(Boolean);
  if (parts.length !== n) return null;
  const nums = parts.map(evalNum);
  return nums.some(isNaN) ? null : nums;
}
function parseConstTable(md) {
  const out = {};
  for (const line of md.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 4) continue;
    const names = [...cells[1].matchAll(/`([A-Za-z0-9_]+)`/g)].map(m => m[1]);
    if (!names.length) continue;
    const vals = parseValueCell(cells[2], names.length);
    if (!vals) continue;
    names.forEach((n, i) => { out[n] = vals[i]; });
  }
  return out;
}

/* ------------------------------------------------------------------ boot ---- */
let G, PB, HTML, EN_TABLE, ZH_TABLE;
try {
  G = boot(GAME, I18N);
  PB = G.PB;
  HTML = fs.readFileSync(GAME, 'utf8');
  EN_TABLE = parseConstTable(fs.readFileSync(README_EN, 'utf8'));
  ZH_TABLE = parseConstTable(fs.readFileSync(README_ZH, 'utf8'));
} catch (e) {
  /* A hard, labelled failure. A page that throws while booting must never be
   * reported as a skipped or an empty run - that is how a dead page passes. */
  console.log(`  FAIL the page threw during boot: ${(e && e.message) || e}`);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

/* ======================================================================
 * 1. Static gates
 * ==================================================================== */

group('1. static gates: one onChange, no timers/random, canvas-read-free, ids, markup');
{
  const code = stripComments(HTML);
  const markup = markupOnly(HTML);

  check(!!PB, 'window.PB exists after boot');
  const onCount = (HTML.match(/T\.onChange/g) || []).length;
  check(onCount === 1, `T.onChange is registered exactly once (found ${onCount})`);

  const timers = (code.match(/\bset(?:Timeout|Interval)\s*\(/g) || []).length;
  check(timers === 0, `the source never calls setTimeout/setInterval (found ${timers})`);
  const rand = (code.match(/\bMath\.random\b/g) || []).length;
  check(rand === 0, `the source never calls Math.random (found ${rand}; the header comment is stripped first)`);

  /* Geometry is owned by constants, never read back from the canvas: the proxy
   * context hands back a non-number from ctx.canvas.width and measureText().width,
   * so any read-back would poison the sim. Assert it statically. */
  check(!/measureText\s*\(/.test(code), 'never reads text metrics back from the canvas');
  check(!/\bctx\.canvas\b/.test(code), 'never reads ctx.canvas');
  check(!/\bcv\.(width|height)\s*(?!=[^=])/.test(code.replace(/cv\.(width|height)\s*=[^=]/g, ' ')),
    'never reads cv.width / cv.height (the size is only ever written FROM the constants)');
  check(/cv\.width\s*=\s*W/.test(code) && /cv\.height\s*=\s*H/.test(code),
    'the canvas backing store is set from the W/H constants (cv.width = W, cv.height = H)');

  /* HUD write locality: the numeric HUD nodes may be written ONLY from
   * updateHud(), so the value cache and the DOM can never drift apart (the
   * frog/platformer bug class). A second write site, or a removed write, is
   * caught here statically. */
  const hudNodes = ['scoreEl', 'bestEl', 'ballEl', 'streakEl', 'chargeEl'];
  const uhStart = code.indexOf('function updateHud(');
  let uhBody = '';
  if (uhStart >= 0) {
    const open = code.indexOf('{', uhStart);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (depth === 0) { uhBody = code.slice(open, i + 1); break; } }
    }
  }
  const stray = hudNodes.filter(ref => {
    const re = new RegExp('\\b' + ref + '\\.textContent\\s*=', 'g');
    const total = (code.match(re) || []).length;
    const inside = (uhBody.match(re) || []).length;
    return total !== inside || inside === 0;
  });
  check(uhStart >= 0 && stray.length === 0,
    `the numeric HUD nodes (#score/#best/#ball/#streak/#charge) are written ONLY inside updateHud() (stray ${JSON.stringify(stray)})`);

  /* Every getElementById('x') target must exist as id="x" in the markup. The
   * stub invents an element for ANY id, so a dangling id is invisible at runtime
   * but throws in a real browser. */
  const used = [...HTML.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const defined = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const dangling = [...new Set(used)].filter(id => !defined.has(id));
  check(dangling.length === 0, `every getElementById target exists as id="..." (${new Set(used).size} ids; missing ${JSON.stringify(dangling)})`);

  check(/<html[^>]*\blang\s*=\s*"zh-CN"/.test(markup), 'the <html> root declares lang="zh-CN"');
  check(/<[^>]*\bdata-lang-switch\b/.test(markup), 'a [data-lang-switch] host exists in the markup');
  check(!/\bdata-lang\s*=/.test(markup), 'the markup carries no data-lang= marker (that is a root-page-only convention)');

  const titleRaw = ((HTML.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1] || '').trim();
  const titleKey = ((HTML.match(/<title[^>]*data-i18n="([^"]+)"/) || [, ''])[1] || '');
  const titleText = titleRaw || (titleKey ? G.T.t(titleKey) : '');
  check(titleText.length > 0,
    `the document <title> is non-empty (raw ${JSON.stringify(titleRaw)}, i18n key ${JSON.stringify(titleKey) || 'none'})`);
}

/* ======================================================================
 * 2. Documentation contract (the README is the oracle for the shipped data)
 * ==================================================================== */

group('2. documentation contract: README table == PB.constants, README prose == PB.world()');
{
  const enNames = Object.keys(EN_TABLE);
  check(enNames.length >= 40, `parsed ${enNames.length} constant rows out of README.md`);
  const bad = [];
  for (const k of enNames) {
    if (!(k in PB.constants)) { bad.push(`${k}=?`); continue; }
    if (!relClose(PB.constants[k], EN_TABLE[k])) bad.push(`${k}: doc ${EN_TABLE[k]} vs code ${PB.constants[k]}`);
  }
  check(bad.length === 0, `every README.md constant row matches PB.constants (mismatches ${JSON.stringify(bad.slice(0, 6))})`);
  note(`checked W=${PB.constants.W}, PHYS_STEP=${PB.constants.PHYS_STEP} (doc ${EN_TABLE.PHYS_STEP}), `
    + `FLIPPER_ACTIVE_ANGLE=${PB.constants.FLIPPER_ACTIVE_ANGLE} (U+2212 doc row), BUMPER_BASE=${PB.constants.BUMPER_BASE}`);

  /* The Chinese table must carry identical NUMBERS. */
  const zhNames = Object.keys(ZH_TABLE);
  const onlyEn = enNames.filter(k => !(k in ZH_TABLE));
  const onlyZh = zhNames.filter(k => !(k in EN_TABLE));
  const diff = enNames.filter(k => k in ZH_TABLE && !relClose(ZH_TABLE[k], EN_TABLE[k]));
  check(onlyEn.length === 0 && onlyZh.length === 0,
    `README.md and README.zh.md carry the same key set (en-only ${JSON.stringify(onlyEn)}, zh-only ${JSON.stringify(onlyZh)})`);
  check(diff.length === 0, `every shared row carries the same number in both tables (diff ${JSON.stringify(diff)})`);
  const zhBad = zhNames.filter(k => k in PB.constants && !relClose(PB.constants[k], ZH_TABLE[k]));
  check(zhBad.length === 0, `every README.zh.md row also matches PB.constants (mismatches ${JSON.stringify(zhBad)})`);

  /* Geometry prose -> PB.world(). */
  const w = PB.world();
  check(w.walls.length === 9, `PB.world() carries 9 wall segments (got ${w.walls.length})`);
  const EXPECT_WALLS = [
    [24, 140, 24, 540], [24, 540, 150, 648], [24, 140, 150, 60], [150, 60, 330, 60],
    [330, 60, 456, 140], [456, 140, 456, 660], [420, 180, 420, 660], [420, 660, 456, 660],
    [420, 560, 330, 648]
  ];
  const segKey = s => `${s.ax},${s.ay},${s.bx},${s.by}`;
  const haveWalls = new Set(w.walls.map(segKey));
  const missWalls = EXPECT_WALLS.map(e => e.join(',')).filter(k => !haveWalls.has(k));
  check(missWalls.length === 0, `all 9 documented wall segments are present with the exact coordinates (missing ${JSON.stringify(missWalls)})`);
  const extraWalls = [...haveWalls].filter(k => !EXPECT_WALLS.map(e => e.join(',')).includes(k));
  check(extraWalls.length === 0, `no undocumented wall segments (extra ${JSON.stringify(extraWalls)})`);

  check(w.bumpers.length === 3, `PB.world() carries 3 bumpers (got ${w.bumpers.length})`);
  const BUMP_EXPECT = [[240, 270], [130, 320], [330, 390]];
  const bumpAt = BUMP_EXPECT.every(([x, y]) => w.bumpers.some(b => b.x === x && b.y === y && b.r === PB.constants.BUMPER_R && b.score === PB.constants.BUMPER_BASE));
  check(bumpAt, `bumpers sit at (240,270)/(130,320)/(330,390) with r=${PB.constants.BUMPER_R} and score=${PB.constants.BUMPER_BASE} ` +
    `(got ${w.bumpers.map(b => `(${b.x},${b.y},r${b.r})`).join(' ')})`);

  const [fl, fr] = w.flippers;
  check(fl.side === 'left' && fl.x === 160 && fl.y === 600 && fr.side === 'right' && fr.x === 320 && fr.y === 600,
    `flipper pivots are (160,600) / (320,600) (got (${fl.x},${fl.y}) / (${fr.x},${fr.y}))`);
  check(fl.len === PB.constants.FLIPPER_LEN && fl.r === PB.constants.FLIPPER_R &&
    fr.len === PB.constants.FLIPPER_LEN && fr.r === PB.constants.FLIPPER_R,
    `flipper capsule length/radius is ${PB.constants.FLIPPER_LEN}/${PB.constants.FLIPPER_R} (got ${fl.len}/${fl.r})`);
  check(relClose(fl.restAngle, 0.45) && relClose(fl.activeAngle, -0.55),
    `left flipper sweeps rest 0.45 -> active -0.55 (got ${fl.restAngle} -> ${fl.activeAngle})`);
  check(relClose(fr.restAngle, Math.PI - 0.45) && relClose(fr.activeAngle, Math.PI + 0.55),
    `right flipper is the mirror: rest ${(Math.PI - 0.45).toFixed(4)} -> active ${(Math.PI + 0.55).toFixed(4)} (got ${fr.restAngle.toFixed(4)} -> ${fr.activeAngle.toFixed(4)})`);
  note(`README prose: "2.6916 rad -> 3.6916 rad" == mirrored left angles`);

  check(w.drain.y === 700 && w.drain.x0 === 150 && w.drain.x1 === 330,
    `the drain gap is x[${w.drain.x0},${w.drain.x1}] lost past y=${w.drain.y}`);

  /* The plunger rest position, from the README prose and the constants. */
  check(PB.constants.LANE_X === 438 && PB.constants.LANE_Y === 650,
    `the plunger rest position is (438,650) (got (${PB.constants.LANE_X},${PB.constants.LANE_Y}))`);
  const s0 = PB.newGame({ seed: 1 });
  check(s0.ball.x === PB.constants.LANE_X && s0.ball.y === PB.constants.LANE_Y,
    `a fresh game parks the ball on the plunger at (438,650) (got (${s0.ball.x},${s0.ball.y}))`);
}

/* ======================================================================
 * 3. Geometry primitives, independently (no second copy of the algorithm)
 * ==================================================================== */

group('3. geometry primitives verified against a method of a different shape');
{
  /* segmentClosestPoint vs a 2000-point brute-force sweep. */
  const segs = [
    [10, 10, 60, 40], [0, 0, 0, 100], [5, 5, 5, 5], [100, 0, 0, 100], [-20, 30, 40, 30]
  ];
  const pts = [[30, 5], [0, 50], [7, 7], [50, 50], [-10, -10], [40, 30], [12, 33]];
  let worstErr = 0, onSegBad = 0, tBad = 0;
  for (const [ax, ay, bx, by] of segs) {
    for (const [px, py] of pts) {
      const got = PB.segmentClosestPoint(px, py, ax, ay, bx, by);
      let best = Infinity;
      for (let i = 0; i <= 2000; i++) {
        const t = i / 2000;
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        best = Math.min(best, hyp(px - x, py - y));
      }
      worstErr = Math.max(worstErr, Math.abs(got.dist - best));
      if (got.t < 0 || got.t > 1) tBad++;
      /* The returned point must lie on the segment: cross product ~ 0 and inside. */
      const cross = ((bx - ax) * (got.y - ay) - (by - ay) * (got.x - ax));
      const len = hyp(bx - ax, by - ay);
      if (Math.abs(cross) > 1e-9 * Math.max(1, len)) onSegBad++;
    }
  }
  check(worstErr < 1e-3, `segmentClosestPoint.dist matches a 2000-sample brute force (worst err ${worstErr.toExponential(2)})`);
  check(tBad === 0, `segmentClosestPoint.t stays in [0,1] (${tBad} out of range)`);
  check(onSegBad === 0, `the returned point lies on the segment (cross-product test, ${onSegBad} off)`);

  /* circleVsSegment fires iff brute-force dist < r; normal unit; depth == r-dist;
   * moving by depth*n clears the overlap. */
  let svOk = 0, svBad = 0, unitBad = 0, depthBad = 0, clearBad = 0;
  const svCases = [
    [53, 50, 9, 20, 50, 40, 50], [53.2, 50, 9, 20, 50, 40, 50], [40, 20, 6, 30, 10, 30, 40],
    [15, 15, 5, 0, 0, 0, 40], [10, 10, 4, 30, 30, 60, 30], [200, 200, 9, 0, 0, 10, 0]
  ];
  for (const [cx, cy, r, ax, ay, bx, by] of svCases) {
    const cp = PB.segmentClosestPoint(cx, cy, ax, ay, bx, by);
    const hit = PB.circleVsSegment(cx, cy, r, ax, ay, bx, by);
    const fires = cp.dist < r;
    if ((!!hit) !== fires) svBad++; else svOk++;
    if (hit) {
      if (Math.abs(hyp(hit.nx, hit.ny) - 1) > 1e-9) unitBad++;
      if (Math.abs(hit.depth - (r - cp.dist)) > 1e-9) depthBad++;
      /* n points from the segment toward the circle */
      const ox = (cx + hit.nx * hit.depth) - cp.x, oy = (cy + hit.ny * hit.depth) - cp.y;
      if (hyp(ox, oy) > 1e-6) unitBad++;
      /* moving by depth*n clears the overlap */
      const moved = PB.circleVsSegment(cx + hit.nx * hit.depth, cy + hit.ny * hit.depth, r, ax, ay, bx, by);
      if (moved) clearBad++;
    }
  }
  check(svBad === 0, `circleVsSegment fires iff the closest distance < r (${svOk}/${svCases.length} agree)`);
  check(unitBad === 0, `the circleVsSegment normal is unit and points from the segment toward the circle (${unitBad} bad)`);
  check(depthBad === 0, `circleVsSegment depth == r - dist (${depthBad} bad)`);
  check(clearBad === 0, `the ball moved by depth*n no longer overlaps (${clearBad} still overlapping)`);

  /* circleVsCircle. */
  let ccBad = 0, ccUnit = 0, ccDepth = 0, ccColl = 0;
  const ccCases = [
    [0, 0, 9, 10, 0, 5], [0, 0, 9, 100, 0, 5], [3, 4, 5, 0, 0, 5], [0, 0, 5, 0, 0, 5],
    [7, 0, 5, 0, 0, 5], [-7, 0, 5, 0, 0, 5]
  ];
  for (const [ax, ay, ar, bx, by, br] of ccCases) {
    const d = hyp(ax - bx, ay - by);
    const hit = PB.circleVsCircle(ax, ay, ar, bx, by, br);
    if ((!!hit) !== (d < ar + br)) ccBad++;
    if (hit) {
      if (Math.abs(hyp(hit.nx, hit.ny) - 1) > 1e-9) ccUnit++;
      if (Math.abs(hit.depth - (ar + br - d)) > 1e-9) ccDepth++;
      /* normal collinear with the centre line (or the (1,0) fallback when coincident) */
      if (d > 1e-9) {
        const cr = (ax - bx) * hit.ny - (ay - by) * hit.nx;
        if (Math.abs(cr) > 1e-6 * Math.max(1, d)) ccColl++;
      }
    }
  }
  check(ccBad === 0, `circleVsCircle fires iff d < ar+br (${ccCases.length} cases)`);
  check(ccUnit === 0 && ccDepth === 0, `circleVsCircle normal is unit and depth == ar+br-d (${ccUnit}/${ccDepth} bad)`);
  check(ccColl === 0, 'the circleVsCircle normal is collinear with the centre line');
  const coinc = PB.circleVsCircle(3, 3, 5, 3, 3, 5);
  check(coinc && Math.abs(hyp(coinc.nx, coinc.ny) - 1) < 1e-9 && coinc.depth === 10,
    `coincident centres still give a unit normal (got (${coinc && coinc.nx},${coinc && coinc.ny}) depth ${coinc && coinc.depth})`);

  /* circleVsAabb: ground truth is my own clamp. */
  let aabbBad = 0, aabbPush = 0, aabbInside = 0;
  const box = [0, 0, 10, 10];
  const cl = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const aabbCases = [
    [12, 5, 3], [13, 5, 3], [5, 5, 3], [5, 5, 12], [11, 11, 2], [-1, 5, 3], [15, 15, 1]
  ];
  for (const [cx, cy, r] of aabbCases) {
    const qx = cl(cx, box[0], box[2]), qy = cl(cy, box[1], box[3]);
    const trueHit = hyp(cx - qx, cy - qy) <= r;
    const hit = PB.circleVsAabb(cx, cy, r, ...box);
    if ((!!hit) !== trueHit) aabbBad++;
    if (hit) {
      if (!isFinite(hit.nx) || !isFinite(hit.ny) || !isFinite(hit.depth)) aabbInside++;
      /* Push out by depth*n; the circle must no longer penetrate the box. */
      const mx = cx + hit.nx * hit.depth, my = cy + hit.ny * hit.depth;
      const mxq = cl(mx, box[0], box[2]), myq = cl(my, box[1], box[3]);
      if (hyp(mx - mxq, my - myq) < r - 1e-6) aabbPush++;
    }
  }
  check(aabbBad === 0, `circleVsAabb fires on the true clamp overlap (${aabbCases.length} cases)`);
  check(aabbPush === 0, `the circle pushed out of the box no longer penetrates (${aabbPush} still overlapping)`);
  check(aabbInside === 0, 'a centre inside the box escapes instead of returning NaN');
  const rev = PB.circleVsAabb(5, 5, 3, 10, 10, 0, 0);
  const fwd = PB.circleVsAabb(5, 5, 3, 0, 0, 10, 10);
  check(rev && fwd && rev.nx === fwd.nx && rev.ny === fwd.ny && Math.abs(rev.depth - fwd.depth) < 1e-12,
    'reversed min/max bounds are normalised to the same result');

  /* reflect: tangential preserved, normal reversed*e, energy never grows for e<=1,
   * elastic at e=1, grazing unchanged. */
  let rBad = 0;
  for (const [vx, vy, nx, ny] of [[3, 4, 0, -1], [5, 0, 1, 0], [2, -7, 0.6, 0.8], [0, 9, 0, -1], [4, 4, -1, 0]]) {
    const vn = vx * nx + vy * ny;
    const tx = vx - vn * nx, ty = vy - vn * ny;            // tangential part
    const e = 0.7;
    const r = PB.reflect(vx, vy, nx, ny, e);
    // tangential preserved
    const rvn = r.vx * nx + r.vy * ny;
    const rtx = r.vx - rvn * nx, rty = r.vy - rvn * ny;
    if (Math.abs(rtx - tx) > 1e-9 || Math.abs(rty - ty) > 1e-9) rBad++;
    // normal component reversed and scaled by e
    if (Math.abs(rvn + e * vn) > 1e-9) rBad++;
    // energy never increases for e<=1
    if (hyp(r.vx, r.vy) > hyp(vx, vy) + 1e-9) rBad++;
  }
  check(rBad === 0, 'reflect preserves the tangential component and reverses/scales the normal by e');
  const el = PB.reflect(3, 4, 0, -1, 1);
  check(Math.abs(hyp(el.vx, el.vy) - 5) < 1e-9 && el.vx === 3 && el.vy === -4,
    `reflect is elastic at e=1 (|v| ${hyp(el.vx, el.vy)} == 5, v=(3,-4))`);
  const grz = PB.reflect(5, 0, 0, -1, 0.5);
  check(grz.vx === 5 && grz.vy === 0, `a grazing hit (v perpendicular to n) is unchanged (got (${grz.vx},${grz.vy}))`);

  /* Degenerate inputs must never yield NaN. */
  const degenerate = [
    () => PB.segmentClosestPoint(NaN, 5, 0, 0, 10, 0),
    () => PB.circleVsSegment(0, 0, 9, 0, 0, 0, 0),      // zero-length segment, circle on it
    () => PB.circleVsSegment(5, 5, 0, 0, 0, 10, 0),     // zero radius
    () => PB.circleVsCircle(0, 0, 0, 0, 0, 0),          // both zero radius, coincident
    () => PB.circleVsAabb(NaN, NaN, 9, 0, 0, 10, 10),
    () => PB.reflect(NaN, NaN, 1, 0, 1),
    () => PB.circleVsSegment(Infinity, 3, 9, 0, 0, 10, 10)
  ];
  let nanBad = 0;
  for (const fn of degenerate) {
    let out;
    try { out = fn(); } catch (e) { nanBad++; continue; }
    const nums = out ? Object.values(out) : [];
    if (nums.some(v => typeof v === 'number' && !isFinite(v))) nanBad++;
  }
  check(nanBad === 0, `degenerate inputs (zero-length, zero radius, coincident, NaN, Infinity) never yield NaN (${nanBad} bad)`);
}

/* ======================================================================
 * 4. Integrator calibration with an independent closed form
 * ==================================================================== */

group('4. integrator calibration: semi-implicit free fall and one analytic bounce');
{
  const EMPTY = { walls: [], bumpers: [], flippers: [], drain: null };
  const cs = PB.constants;
  const n = Math.ceil(1 / cs.PHYS_STEP);
  const h = 1 / n;
  const expectDisp = cs.GRAVITY * h * h * n * (n + 1) / 2;

  const ff = PB.stepBall({ x: 100, y: 0, vx: 0, vy: 0, r: cs.BALL_R }, 1, EMPTY);
  check(n === cs.MAX_SUBSTEPS, `ceil(1/PHYS_STEP) == MAX_SUBSTEPS (${n} == ${cs.MAX_SUBSTEPS})`);
  check(Math.abs(ff.ball.vy - cs.GRAVITY) < 1e-9,
    `one second of free fall reaches vy == GRAVITY (got ${ff.ball.vy}, want ${cs.GRAVITY})`);
  check(Math.abs(ff.ball.y - expectDisp) < 1e-6,
    `displacement == GRAVITY*h^2*n(n+1)/2 = ${expectDisp} (got ${ff.ball.y}, README says 451.875)`);
  note(`derived in-test: n=${n}, h=${h}, GRAVITY*h^2*n(n+1)/2=${expectDisp}`);

  check(Array.isArray(ff.events) && ff.events.length === 0, `an empty world yields no events (got ${ff.events.length})`);

  /* Analytic bumper bounce: ball exactly touching, moving straight down at s0,
   * one sub-step of dt = PHYS_STEP. */
  const s0 = 200;
  const bw = { walls: [], bumpers: [{ x: 240, y: 270, r: cs.BUMPER_R, score: cs.BUMPER_BASE }], flippers: [], drain: null };
  const startY = 270 - (cs.BALL_R + cs.BUMPER_R);
  const res = PB.stepBall({ x: 240, y: startY, vx: 0, vy: s0, r: cs.BALL_R }, cs.PHYS_STEP, bw);
  const wantVy = -cs.BUMPER_REST * (s0 + cs.GRAVITY * cs.PHYS_STEP) - cs.BUMPER_KICK;
  check(Math.abs(res.ball.vy - wantVy) < 1e-9,
    `post-hit vy == -BUMPER_REST*(s0+GRAVITY*PHYS_STEP)-BUMPER_KICK = ${wantVy} (got ${res.ball.vy})`);
  const dist = hyp(res.ball.x - 240, res.ball.y - 270);
  check(Math.abs(dist - (cs.BALL_R + cs.BUMPER_R)) < 1e-6,
    `the push-out restores the touching distance ${cs.BALL_R + cs.BUMPER_R} (got ${dist})`);
  check(res.events.some(e => e.type === 'bumper'), `the bounce is reported as a 'bumper' event (${JSON.stringify(res.events.map(e => e.type))})`);

  /* Purity / determinism / idempotence. */
  const st = { x: 240, y: 100, vx: 30, vy: 0, r: cs.BALL_R };
  const snapshot = JSON.stringify(st);
  const rA = PB.stepBall(st, 0.5, PB.world());
  const rB = PB.stepBall(st, 0.5, PB.world());
  check(JSON.stringify(st) === snapshot, 'stepBall never mutates its state argument');
  check(JSON.stringify(rA) === JSON.stringify(rB), 'stepBall is deterministic (same inputs -> identical output)');
  const zero = PB.stepBall({ x: 240, y: 300, vx: 10, vy: -20, r: cs.BALL_R }, 0, PB.world());
  check(zero.ball.x === 240 && zero.ball.y === 300 && zero.ball.vx === 10 && zero.ball.vy === -20 && zero.events.length === 0,
    'dt = 0 is a no-op');
}

/* ======================================================================
 * 5. No tunnelling, three independent ways
 * ==================================================================== */

group('5. no tunnelling: arithmetic bound, wall sweep, and the large-dt regression');
{
  const cs = PB.constants;
  const maxDisp = PB.maxStepDisplacement();
  const thin = PB.thinnestCollider();
  check(Math.abs(maxDisp - cs.MAX_SPEED * cs.PHYS_STEP) < 1e-9,
    `maxStepDisplacement() == MAX_SPEED*PHYS_STEP = ${cs.MAX_SPEED * cs.PHYS_STEP} (got ${maxDisp})`);
  check(Math.abs(thin - 2 * cs.BALL_R) < 1e-9, `thinnestCollider() == 2*BALL_R = ${2 * cs.BALL_R} (got ${thin})`);
  const ratio = maxDisp / thin;
  check(ratio < 1, `the no-tunnel ratio ${maxDisp}/${thin} = ${ratio.toFixed(4)} < 1`);

  /* Empirical wall sweep on the real table. */
  const POLY = [[24, 140], [150, 60], [330, 60], [456, 140], [456, 660], [420, 660], [420, 560], [330, 648], [150, 648], [24, 540]];
  function pip(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  const inTable = (x, y) => pip(POLY, x, y)
    || (x >= 420 && x <= 456 && y >= 60 && y <= 660)
    || (x >= 150 && x <= 330 && y >= 600 && y <= 702);

  const w = PB.world();
  let fired = 0, escaped = 0, minSigned = Infinity, ambiguous = 0;
  for (const s of w.walls) {
    const dx = s.bx - s.ax, dy = s.by - s.ay, L = hyp(dx, dy);
    const cand = [[dy / L, -dx / L], [-dy / L, dx / L]];
    for (const t of [0.2, 0.5, 0.8]) {
      const P = { x: s.ax + dx * t, y: s.ay + dy * t };
      /* Fire from every playable side of the wall (a lane wall borders two). */
      const sides = cand.filter(([nx, ny]) => inTable(P.x + nx * (cs.BALL_R + 1), P.y + ny * (cs.BALL_R + 1)));
      if (sides.length === 0) { ambiguous++; continue; }
      for (const [nx, ny] of sides) {
        const C0 = { x: P.x + nx * (cs.BALL_R + 1), y: P.y + ny * (cs.BALL_R + 1) };
        const out = PB.stepBall({ x: C0.x, y: C0.y, vx: -nx * cs.MAX_SPEED, vy: -ny * cs.MAX_SPEED, r: cs.BALL_R }, cs.PHYS_STEP, w);
        fired++;
        const signed = (out.ball.x - P.x) * nx + (out.ball.y - P.y) * ny;
        minSigned = Math.min(minSigned, signed);
        if (signed <= 0) escaped++;
      }
    }
  }
  note(`wall sweep: ${fired} shots fired, ${ambiguous} skipped as ambiguous, min signed distance after impact = ${minSigned.toFixed(3)} px`);
  check(fired >= 20, `the wall sweep fired ${fired} shots (>= 20 across 9 walls x 3 points)`);
  check(escaped === 0, `no shot crossed to the far side of the wall (${escaped} escaped)`);

  /* (c) The large-dt regression. RED until the integrator bounds the per-sub-step
   * displacement by PHYS_STEP for ANY dt. */
  const big = PB.stepBall({ x: 24 + cs.BALL_R + 1, y: 300, vx: -cs.MAX_SPEED, vy: 0, r: cs.BALL_R }, 5, PB.world());
  check(big.ball.x >= 24,
    `a 5 s step at MAX_SPEED cannot leave the table (centre x = ${big.ball.x.toFixed(3)}; must be >= 24)`);

  /* A large tick step must still advance the SAME total simulated time. */
  const deltas = [0.5, 0.1, 1 / 60, 1 / 240].map(step => {
    PB.newGame({ seed: 1 });
    PB.start();
    const before = PB.getState().clock;
    PB.tick(1, step);
    return PB.getState().clock - before;
  });
  check(deltas.every(d => Math.abs(d - 1) < 1e-6),
    `tick(1, step) advances exactly 1 s of model time for every step (deltas ${deltas.map(d => d.toFixed(6)).join(', ')})`);
}

/* ======================================================================
 * 6. Scoring
 * ==================================================================== */

group('6. scoring: bumperScore table, live score, streak, seeded bonus');
{
  const cs = PB.constants;
  let sBad = 0, firstBad = 0;
  for (let k = 0; k <= 25; k++) {
    const want = Math.round(cs.BUMPER_BASE * Math.min(1 + cs.STREAK_STEP * k, cs.STREAK_MAX_MULT));
    if (PB.bumperScore(k) !== want) sBad++;
  }
  check(sBad === 0, `bumperScore(k) == round(BUMPER_BASE*min(1+STREAK_STEP*k, STREAK_MAX_MULT)) for k=0..25`);
  check(PB.bumperScore(0) === cs.BUMPER_BASE, `the first hit is worth ${cs.BUMPER_BASE} (got ${PB.bumperScore(0)})`);
  const capK = Math.ceil((cs.STREAK_MAX_MULT - 1) / cs.STREAK_STEP);
  check(PB.bumperScore(capK) === Math.round(cs.BUMPER_BASE * cs.STREAK_MAX_MULT) && PB.bumperScore(25) === PB.bumperScore(capK),
    `the multiplier caps at x${cs.STREAK_MAX_MULT} = ${Math.round(cs.BUMPER_BASE * cs.STREAK_MAX_MULT)} from k=${capK} on (got ${PB.bumperScore(capK)})`);
  check([-1, NaN, Infinity, -Infinity].every(v => PB.bumperScore(v) === cs.BUMPER_BASE),
    `negative/NaN/Infinity degrade to the first-hit value (${[-1, NaN, Infinity, -Infinity].map(v => PB.bumperScore(v)).join(',')})`);

  /* Live game: score is monotone, streak rises on consecutive hits, the seeded
   * stream is the only randomness. Events are counted from the log by appending
   * only the entries that are NEW since the previous sample (the log is a
   * rolling window, so a naive before/after slice would double-count or drop). */
  function appended(prev, cur) {
    const key = e => JSON.stringify(e);
    let L = 0;
    for (let cand = Math.min(prev.length, cur.length); cand >= 0; cand--) {
      let ok = true;
      for (let i = 0; i < cand; i++) if (key(prev[prev.length - cand + i]) !== key(cur[i])) { ok = false; break; }
      if (ok) { L = cand; break; }
    }
    return cur.slice(L);
  }
  PB.newGame({ seed: 7 });
  PB.start();
  let prevScore = 0, monotone = true, maxStreak = 0, nan = 0;
  const evCount = { bumper: 0, bonus: 0, respawn: 0, timeout: 0 };
  let prevLog = [];
  let guard = 0;
  while (PB.getState().phase === 'playing' && guard++ < 6000) {
    PB.tick(1 / 60, 1 / 60);
    const st = PB.getState();
    if (st.score < prevScore) monotone = false;
    prevScore = st.score;
    maxStreak = Math.max(maxStreak, st.streak);
    if (!isFinite(st.ball.x) || !isFinite(st.ball.y)) nan++;
    for (const e of appended(prevLog, st.log)) if (e.type in evCount) evCount[e.type]++;
    prevLog = st.log;
  }
  const fin = PB.getState();
  check(fin.phase === 'over' && fin.over === true, `a no-input game finishes in 'over' (got ${fin.phase})`);
  check(monotone, 'the live score never decreases');
  check(maxStreak >= 1, `at least one bumper hit built a streak (max streak ${maxStreak})`);
  check(fin.streak === 0, `streak resets to 0 once the last ball is lost (got ${fin.streak})`);
  check(nan === 0, 'the ball state never carries a NaN through a whole game');
  check(evCount.bumper > 0, `the game logged ${evCount.bumper} bumper hits`);

  /* The bonus is a seeded roll: replay the mulberry stream and predict it.
   * Each bumper consumes exactly two draws (a <=2% jitter, then the bonus roll),
   * so rngDraws must be 2 x (bumper count) and the bonuses must match. */
  const bumps = evCount.bumper;
  check(fin.rngDraws === 2 * bumps,
    `rngDraws == 2 x bumper count (rngDraws=${fin.rngDraws}, bumpers=${bumps}) - the seeded stream is the only randomness`);
  const stream = PB.mulberry32(7);
  let expectedBonus = 0;
  for (let m = 0; m < bumps; m++) { stream(); if (stream() < cs.BONUS_CHANCE) expectedBonus++; }
  check(evCount.bonus === expectedBonus,
    `the +${cs.BONUS_POINTS} bonus count matches the seeded mulberry32 stream (log ${evCount.bonus} vs predicted ${expectedBonus} at p=${cs.BONUS_CHANCE})`);

  /* A different seed really does diverge through the same source. */
  const r1 = PB.mulberry32(11), r2 = PB.mulberry32(12);
  let same = 0;
  for (let i = 0; i < 50; i++) if (r1() === r2()) same++;
  check(same < 5, `two different seeds barely share draws through the same source (${same}/50 equal)`);
}

/* ======================================================================
 * 7. Ball lifecycle and rules
 * ==================================================================== */

group('7. ball lifecycle: ready/playing, plunger, flippers, nudge/tilt, pause, best');
{
  const cs = PB.constants;
  const s0 = PB.newGame({ seed: 3 });
  check(s0.phase === 'ready', `newGame -> 'ready' (got ${s0.phase})`);
  check(s0.ballsLeft === 3 && s0.ballNo === 1, `3 balls, ball 1 (got ${s0.ballsLeft} left, ball ${s0.ballNo})`);
  check(s0.awaitingLaunch === true, 'the plunger is armed (awaitingLaunch)');
  check(s0.ball.x === cs.LANE_X && s0.ball.y === cs.LANE_Y, `the ball waits at (LANE_X,LANE_Y) = (${cs.LANE_X},${cs.LANE_Y})`);
  check(s0.score === 0 && s0.streak === 0 && s0.over === false, `score/streak zeroed (got ${s0.score}/${s0.streak})`);
  check(PB.start().phase === 'playing', 'start() -> playing');

  /* launchVelocity: exact endpoints and out-of-range clamping. */
  const lv = [0, 0.5, 1].map(c => PB.launchVelocity(c));
  check(lv[0].vx === 0 && lv[0].vy === -700 && lv[1].vy === -1000 && lv[2].vy === -1300,
    `launchVelocity 0/0.5/1 -> (0,-700)/(0,-1000)/(0,-1300) (got ${lv.map(v => v.vy).join(',')})`);
  check(PB.launchVelocity(-1).vy === -700 && PB.launchVelocity(2).vy === -1300 && PB.launchVelocity(NaN).vy === -700,
    `out-of-range charge clamps to [0,1] (got ${[PB.launchVelocity(-1).vy, PB.launchVelocity(2).vy, PB.launchVelocity(NaN).vy].join(',')})`);

  /* setFlipper moves target and, over time, the angle reaches it. */
  PB.setFlipper('left', true);
  const t0 = PB.getState().flippers.left;
  check(t0.target === cs.FLIPPER_ACTIVE_ANGLE && t0.pressed === true, `setFlipper(left,true) sets target=${cs.FLIPPER_ACTIVE_ANGLE}`);
  PB.tick(0.3, 1 / 240);
  const t1 = PB.getState().flippers.left;
  check(Math.abs(t1.angle - cs.FLIPPER_ACTIVE_ANGLE) < 1e-6,
    `the left flipper reaches its active angle in finite time (angle ${t1.angle} -> target ${cs.FLIPPER_ACTIVE_ANGLE})`);
  PB.setFlipper('left', false);
  PB.tick(0.3, 1 / 240);
  check(Math.abs(PB.getState().flippers.left.angle - cs.FLIPPER_REST_ANGLE) < 1e-6, 'and returns to rest');

  /* nudge beyond NUDGE_MAX tilts and costs a ball. */
  PB.setFlipper('left', false);
  PB.launch(1);
  check(PB.getState().awaitingLaunch === false, 'launch(1) puts the ball in play');
  const beforeNudge = PB.getState().ballsLeft;
  let tiltSeen = false, nudgesPeak = 0;
  for (let i = 0; i < cs.NUDGE_MAX + 1; i++) {
    PB.nudge('up');
    const st = PB.getState();
    nudgesPeak = Math.max(nudgesPeak, st.nudges);
    if (st.log.some(e => e.type === 'tilt')) tiltSeen = true;
  }
  /* The tilt costs the ball, which re-arms the plunger and zeroes `nudges`. */
  check(tiltSeen && nudgesPeak === cs.NUDGE_MAX,
    `nudging past NUDGE_MAX=${cs.NUDGE_MAX} tilts (peak nudges ${nudgesPeak}, tilt logged ${tiltSeen})`);
  check(PB.getState().ballsLeft === beforeNudge - 1 && PB.getState().nudges === 0,
    `the tilt costs a ball and resets the nudge counter (${beforeNudge} -> ${PB.getState().ballsLeft}, nudges ${PB.getState().nudges})`);

  /* pause freezes the model through tick(); resume restarts it. */
  PB.launch(1);
  PB.pause();
  check(PB.getState().phase === 'paused' && PB.getState().pause === true, `pause() -> 'paused' (got ${PB.getState().phase})`);
  const frozen = PB.getState();
  PB.tick(1, 1 / 60);
  const afterPause = PB.getState();
  check(afterPause.score === frozen.score && afterPause.ball.x === frozen.ball.x && afterPause.ball.y === frozen.ball.y,
    'tick() while paused does not move the ball or the score');
  check(afterPause.clock > frozen.clock, 'the model clock still advances while paused (wall time is tracked)');
  PB.resume();
  check(PB.getState().phase === 'playing', 'resume() -> playing');

  /* ballsLeft decrements 3->0 exactly once per drain, reaching 'over'. */
  PB.newGame({ seed: 5 });
  PB.start();
  const seq = [];
  let g = 0, nanSeen = 0;
  while (PB.getState().phase === 'playing' && g++ < 8000) {
    PB.tick(1 / 60, 1 / 60);
    const st = PB.getState();
    if (!seq.length || seq[seq.length - 1] !== st.ballsLeft) seq.push(st.ballsLeft);
    if (!isFinite(st.ball.x) || !isFinite(st.ball.y) || !isFinite(st.ball.vx) || !isFinite(st.ball.vy)) nanSeen++;
  }
  const end = PB.getState();
  check(JSON.stringify(seq) === JSON.stringify([3, 2, 1, 0]),
    `ballsLeft steps 3 -> 2 -> 1 -> 0 exactly once each (observed ${JSON.stringify(seq)})`);
  check(end.phase === 'over' && end.over === true && end.ballsLeft === 0,
    `the game reaches 'over' with over===true and ballsLeft 0 (got ${end.phase}/${end.over}/${end.ballsLeft})`);
  check(nanSeen === 0, 'no NaN appears across the whole game');

  /* best survives a new game (read back from localStorage; the stub persists). */
  PB.newGame({ seed: 5 });
  PB.start();
  let gg = 0;
  while (PB.getState().phase === 'playing' && gg++ < 8000) PB.tick(1 / 60, 1 / 60);
  const bestAfter = PB.getState().best;
  const stored = G.env.context.localStorage.getItem('litegame_pinball_best');
  check(bestAfter > 0, `a no-input game scores something worth saving (best ${bestAfter})`);
  check(stored === String(bestAfter), `the best is persisted to localStorage (stored ${JSON.stringify(stored)} == ${bestAfter})`);
  const reopened = PB.newGame({ seed: 999 });
  check(reopened.best === bestAfter, `best survives newGame (${reopened.best} == ${bestAfter})`);
}

/* ======================================================================
 * 8. Long drives - invariants that only show up over thousands of steps
 * ==================================================================== */

group('8. long drives: no escape, no NaN, no respawn/timeout, energy ceiling, bot > idle');
{
  const cs = PB.constants;
  const POLY = [[24, 140], [150, 60], [330, 60], [456, 140], [456, 660], [420, 660], [420, 560], [330, 648], [150, 648], [24, 540]];
  function pip(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  const inTable = (x, y) => pip(POLY, x, y)
    || (x >= 420 && x <= 456 && y >= 60 && y <= 660)
    || (x >= 140 && x <= 340 && y >= 600 && y <= 720);

  /* Run one no-input game to completion, sampling every small tick. Rare events
   * are detected by presence AT THE MOMENT they happen (the log is a rolling
   * window, so a before/after slice would miss them): a single `some()` over the
   * live window catches an event for as long as it is present, which is far
   * longer than one tick. */
  function idleGame(seed) {
    PB.newGame({ seed });
    PB.start();
    const r = { seed, finished: false, score: 0, maxClock: 0, maxSpeed: 0, nan: 0, escaped: 0, respawn: 0, timeout: 0, drains: 0, ticks: 0 };
    let guard = 0;
    while (PB.getState().phase === 'playing' && guard++ < 4000) {
      PB.tick(1 / 60, 1 / 60);
      const st = PB.getState();
      r.ticks++;
      if (!isFinite(st.ball.x) || !isFinite(st.ball.y) || !isFinite(st.ball.vx) || !isFinite(st.ball.vy)) r.nan++;
      const sp = hyp(st.ball.vx, st.ball.vy);
      if (sp > r.maxSpeed) r.maxSpeed = sp;
      if (!inTable(st.ball.x, st.ball.y)) r.escaped++;
      for (const e of st.log) {
        if (e.type === 'respawn') r.respawn = 1;
        if (e.type === 'timeout') r.timeout = 1;
      }
    }
    const fin = PB.getState();
    r.finished = fin.phase === 'over';
    r.score = fin.score;
    r.maxClock = fin.clock;
    return r;
  }

  const RUNS = 32;
  const results = [];
  for (let seed = 1; seed <= RUNS; seed++) results.push(idleGame(seed));
  const unfinished = results.filter(r => !r.finished).map(r => r.seed);
  const nanRuns = results.filter(r => r.nan > 0).map(r => r.seed);
  const escRuns = results.filter(r => r.escaped > 0).map(r => r.seed);
  const respawnRuns = results.filter(r => r.respawn).map(r => r.seed);
  const timeoutRuns = results.filter(r => r.timeout).map(r => r.seed);
  const overSpeed = results.filter(r => r.maxSpeed > cs.MAX_SPEED + 1e-6).map(r => r.seed);
  const worstClock = Math.max(...results.map(r => r.maxClock));
  const lowestScore = Math.min(...results.map(r => r.score));
  const allDrained = results.every(r => r.finished);

  check(results.length === RUNS && unfinished.length === 0, `all ${RUNS} no-input seeds finish (unfinished ${JSON.stringify(unfinished)})`);
  check(nanRuns.length === 0, `no NaN/Infinity ever appears in the ball state (bad seeds ${JSON.stringify(nanRuns)})`);
  check(escRuns.length === 0, `the ball never leaves the table across ${RUNS} games (bad seeds ${JSON.stringify(escRuns)})`);
  check(respawnRuns.length === 0, `the 'respawn' tell never fires - no tunnelling (bad seeds ${JSON.stringify(respawnRuns)})`);
  check(timeoutRuns.length === 0, `zero 'timeout' events - every ball really drains by gravity (bad seeds ${JSON.stringify(timeoutRuns)})`);
  check(overSpeed.length === 0, `peak speed never exceeds MAX_SPEED=${cs.MAX_SPEED} (bad seeds ${JSON.stringify(overSpeed)})`);
  note(`worst full game length = ${worstClock.toFixed(2)} s, lowest score = ${lowestScore} over ${RUNS} seeds; allDrained=${allDrained}`);

  /* Flipper abuse: hammer both flippers for thousands of sub-steps and confirm
   * the hard clamp holds at energyCeiling(). */
  PB.newGame({ seed: 2 });
  PB.start();
  let peak = 0, g2 = 0;
  for (let i = 0; i < 6000 && g2 < 12000; i++) {
    PB.setFlipper('left', (i % 4) < 2);
    PB.setFlipper('right', (i % 6) < 3);
    PB.tick(1 / 120, 1 / 120);
    const st = PB.getState();
    g2++;
    peak = Math.max(peak, hyp(st.ball.vx, st.ball.vy));
    if (st.phase === 'over') { PB.newGame({ seed: 2 }); PB.start(); PB.launch(1); }
  }
  check(peak <= PB.energyCeiling() + 1e-6,
    `hammering the flippers ${g2} ticks never beats energyCeiling()=${PB.energyCeiling()} (peak ${peak.toFixed(3)})`);

  /* A trivial flipper bot must outscore an idle player: the score tracks play. */
  function botGame(seed) {
    PB.newGame({ seed });
    PB.start();
    let guard = 0;
    while (PB.getState().phase === 'playing' && guard++ < 4000) {
      const st = PB.getState();
      PB.setFlipper('left', st.ball.x < cs.W / 2);
      PB.setFlipper('right', st.ball.x >= cs.W / 2);
      PB.tick(1 / 60, 1 / 60);
    }
    return PB.getState().score;
  }
  let botSum = 0, idleSum = 0;
  for (let seed = 1; seed <= 8; seed++) { botSum += botGame(seed); idleSum += idleGame(seed).score; }
  check(botSum > idleSum, `a trivial flipper bot outscores an idle player over 8 seeds (bot ${botSum} vs idle ${idleSum})`);
}

/* ======================================================================
 * 9. i18n: the dynamic text actually re-localises (no other layer sees this)
 * ==================================================================== */

group('9. i18n: dynamic HUD and overlay text re-render on a language switch');
{
  const Gi = boot(GAME, I18N);
  const Si = Gi.PB, Ti = Gi.T, ei = Gi.els;
  check(!!Ti && Ti.lang === 'en', `the i18n helper boots in English (lang=${Ti && Ti.lang})`);
  const before = HTML.match(/T\.onChange/g).length;
  check(before === 1 && typeof Ti.onChange === 'function', 'exactly one onChange consumer is wired');

  Si.newGame({ seed: 4 });
  const enMsg = ei.msg.textContent, enLaunch = ei.btnLaunch.textContent, enNew = ei.btnNew.textContent;
  check(enMsg.length > 0 && !CJK.test(enMsg), `#msg starts English (got ${JSON.stringify(enMsg)})`);
  check(enLaunch.length > 0 && !CJK.test(enLaunch), `#btnLaunch starts English (got ${JSON.stringify(enLaunch)})`);
  check(enNew.length > 0 && !CJK.test(enNew), `#btnNew starts English (got ${JSON.stringify(enNew)})`);

  Ti.set('zh');
  const zhMsg = ei.msg.textContent, zhLaunch = ei.btnLaunch.textContent, zhNew = ei.btnNew.textContent;
  check(CJK.test(zhMsg) && zhMsg !== enMsg, `#msg re-localises to Chinese and differs (${JSON.stringify(enMsg)} -> ${JSON.stringify(zhMsg)})`);
  check(CJK.test(zhLaunch) && zhLaunch !== enLaunch, `#btnLaunch re-localises to Chinese (${JSON.stringify(enLaunch)} -> ${JSON.stringify(zhLaunch)})`);
  check(CJK.test(zhNew) && zhNew !== enNew, `#btnNew re-localises to Chinese (${JSON.stringify(enNew)} -> ${JSON.stringify(zhNew)})`);

  /* Drive to 'over' and confirm the runtime-composed overlay re-localises. */
  Si.start();
  let guard = 0;
  while (Si.getState().phase !== 'over' && guard++ < 8000) Si.tick(1 / 60, 1 / 60);
  Si.tick(0, 1 / 60);
  const zhTitle = ei.ovTitle.textContent;
  check(Si.getState().phase === 'over', 'the game reached over for the overlay test');
  check(CJK.test(zhTitle) && /\d/.test(ei.ovSub.textContent),
    `the composed overlay title/body are Chinese and carry the score (title ${JSON.stringify(zhTitle)}, sub ${JSON.stringify(ei.ovSub.textContent)})`);
  const zhBody = ei.ovSub.textContent;
  Ti.set('en');
  check(!CJK.test(ei.ovTitle.textContent) && ei.ovTitle.textContent !== zhTitle,
    `flipping to en re-renders the OPEN overlay (got ${JSON.stringify(ei.ovTitle.textContent)})`);
  check(ei.ovSub.textContent !== zhBody, 'the overlay body re-localises too');
  Ti.set('zh');
  check(CJK.test(ei.msg.textContent) && ei.msg.textContent !== enMsg, 'the HUD re-localises again after the second flip');
}

/* ======================================================================
 * 10. hudCache mirrors getState
 * ==================================================================== */

group('10. hudCache mirrors getState after a paint');
{
  PB.newGame({ seed: 8 });
  PB.start();
  let bad = 0, samples = 0, firstBad = '';
  let guard = 0;
  while (PB.getState().phase === 'playing' && guard++ < 4000) {
    PB.tick(1 / 30, 1 / 60);
    const s = PB.getState(), c = PB.hudCache();
    samples++;
    /* hudCache stores the model VALUES for score/best (numbers) and the painted
     * TEXT for charge/ball/streak - mirror those types exactly. */
    if (c.score !== s.score) { bad++; if (!firstBad) firstBad = `score ${c.score} vs ${s.score}`; }
    if (c.best !== s.best) { bad++; if (!firstBad) firstBad = `best ${c.best} vs ${s.best}`; }
    if (c.charge !== Math.round(s.charge * 100) + '%') { bad++; if (!firstBad) firstBad = `charge ${c.charge}`; }
    if (!/^\d+ \/ \d+$/.test(String(c.ball))) { bad++; if (!firstBad) firstBad = `ball ${c.ball}`; }
    if (!/^\u00d7[\d.]+$/.test(String(c.streak))) { bad++; if (!firstBad) firstBad = `streak ${c.streak}`; }
  }
  check(samples > 0, `sampled the HUD cache ${samples} times`);
  check(bad === 0, `hudCache mirrors getState on every sample (${bad} bad${firstBad ? `, first ${firstBad}` : ''})`);

  /* The always-painted slots are never null; the three overlay slots are null
   * while no dialog is up and non-null once the game is over. */
  PB.newGame({ seed: 8 });
  let c = PB.hudCache();
  const always = ['score', 'best', 'ball', 'streak', 'charge', 'msg', 'launchTxt', 'launchDis', 'flipDis', 'leftTxt', 'rightTxt', 'newTxt', 'startLbl', 'showStart', 'showRes'];
  const nullAlways = always.filter(k => c[k] === null || c[k] === undefined);
  check(nullAlways.length === 0, `after a paint the ${always.length} always-painted slots are non-null (null ${JSON.stringify(nullAlways)})`);
  check(c.ovTitle === null && c.ovSub === null && c.ovBtn === null, `the three overlay slots are null while no dialog is up (${c.ovTitle}/${c.ovSub}/${c.ovBtn})`);
  check(c.showStart === true && c.showRes === false, `ready shows the start overlay and hides the result one (${c.showStart}/${c.showRes})`);

  PB.start();
  guard = 0;
  while (PB.getState().phase !== 'over' && guard++ < 8000) PB.tick(1 / 60, 1 / 60);
  c = PB.hudCache();
  check(c.ovTitle !== null && c.ovSub !== null && c.ovBtn !== null, `after the game is over the overlay slots are painted (${JSON.stringify(c.ovTitle)})`);
  check(c.showRes === true && c.showStart === false, 'the result overlay shows and the start one hides at over');

  /* Copies, not live views. */
  const h = PB.hudCache(); h.score = 'MUTATED';
  check(PB.hudCache().score !== 'MUTATED', 'hudCache() returns a copy the caller cannot use to mutate the model');
  const l = PB.log(); const n0 = l.length; l.push({ type: 'bogus' });
  check(PB.log().length === n0, 'log() returns a copy, not a live view');
  if (n0) { l[0].type = 'MUTATED'; check(PB.log()[0].type !== 'MUTATED', 'the log entries are copies too'); }
}

/* ======================================================================
 * 11. Bridge surface
 * ==================================================================== */

group('11. window.PB exposes the documented surface');
{
  const fns = ['world', 'mulberry32', 'nextRandom', 'segmentClosestPoint', 'circleVsSegment',
    'circleVsCircle', 'circleVsAabb', 'reflect', 'flipperAngle', 'launchVelocity', 'bumperScore',
    'stepBall', 'maxStepDisplacement', 'thinnestCollider', 'energyCeiling', 'toLogical',
    'getState', 'hudCache', 'log', 'newGame', 'start', 'pause', 'resume', 'togglePause',
    'setFlipper', 'chargePlunger', 'launch', 'nudge', 'tick'];
  const missingFns = fns.filter(k => typeof PB[k] !== 'function');
  check(missingFns.length === 0, `all ${fns.length} documented bridge functions exist (missing ${JSON.stringify(missingFns)})`);
  check(PB.constants && typeof PB.constants === 'object', 'PB.constants is an object');
  const constKeys = ['W', 'H', 'BALL_R', 'GRAVITY', 'MAX_SPEED', 'PHYS_STEP', 'MAX_SUBSTEPS', 'DRAIN_Y',
    'DRAIN_X0', 'DRAIN_X1', 'BALLS', 'DEFAULT_STEP', 'FLIPPER_LEN', 'FLIPPER_R', 'FLIPPER_REST_ANGLE',
    'FLIPPER_ACTIVE_ANGLE', 'FLIPPER_SPEED', 'FLIPPER_KICK', 'FLIP_RESTITUTION', 'BUMPER_R', 'BUMPER_KICK',
    'BUMPER_REST', 'BUMPER_BASE', 'WALL_REST', 'DRAG', 'STALL_SEC', 'STALL_SPEED', 'STALL_NUDGE',
    'STREAK_TIMEOUT', 'STREAK_STEP', 'STREAK_MAX_MULT', 'BONUS_CHANCE', 'BONUS_POINTS', 'LAUNCH_MIN',
    'LAUNCH_MAX', 'CHARGE_RATE', 'AUTO_LAUNCH_SEC', 'BALL_MAX_SEC', 'NUDGE_MAX', 'NUDGE_IMPULSE',
    'NUDGE_SIDE', 'LANE_X', 'LANE_Y'];
  const missConst = constKeys.filter(k => typeof PB.constants[k] !== 'number');
  check(missConst.length === 0, `PB.constants carries all ${constKeys.length} documented numbers (missing ${JSON.stringify(missConst)})`);

  const s = PB.getState();
  const fields = ['phase', 'score', 'best', 'ballsLeft', 'ballNo', 'streak', 'ball', 'flippers', 'seed',
    'rng', 'rngDraws', 'charge', 'nudges', 'awaitingLaunch', 'pause', 'over', 'clock', 'ticks', 'log'];
  const missingFields = fields.filter(k => !(k in s));
  check(missingFields.length === 0, `getState() carries all ${fields.length} documented fields (missing ${JSON.stringify(missingFields)})`);
  check(['x', 'y', 'vx', 'vy'].every(k => k in s.ball), 'getState().ball is {x,y,vx,vy}');
  check(s.flippers && s.flippers.left && s.flippers.right && ['angle', 'target', 'pressed', 'restAngle', 'activeAngle'].every(k => k in s.flippers.left),
    'getState().flippers.left/right expose angle/target/pressed/restAngle/activeAngle');
  check(s.rng && 'seed' in s.rng && 'calls' in s.rng && s.rngDraws === s.rng.calls,
    `rngDraws === rng.calls (${s.rngDraws} == ${s.rng.calls})`);
  check(['ready', 'playing', 'paused', 'over'].includes(s.phase), `the phase is one of the four documented values (got ${s.phase})`);

  const norm = PB.toLogical(240, 360);
  check(isFinite(norm.x) && isFinite(norm.y), `toLogical returns finite numbers (${norm.x},${norm.y})`);
  /* Zero-width rect: the game must fall back to 1:1 rather than divide by zero. */
  const cvEl = G.els['cv'];
  const origRect = cvEl.getBoundingClientRect;
  cvEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const zeroRect = PB.toLogical(10, 20);
  cvEl.getBoundingClientRect = origRect;
  check(isFinite(zeroRect.x) && isFinite(zeroRect.y), `toLogical stays finite with a zero-width rect (${zeroRect.x},${zeroRect.y})`);

  const fc = PB.flipperAngle('left', 0.01);
  check(typeof fc === 'number' && isFinite(fc), `flipperAngle('left', t) returns a finite number (${fc})`);
}

/* ======================================================================
 * 12. Reverse validation - re-inject bugs into a string copy and prove the
 *     matching rule goes red. (Cheap, deterministic, in-suite.)
 * ==================================================================== */

group('12. reverse validation: injected bugs turn the matching checks red');
{
  /* A predicate set reused against a (possibly patched) source + its PB. */
  function docContractReds(pb) {
    let bad = 0;
    for (const k of Object.keys(EN_TABLE)) {
      if (!(k in pb.constants) || !relClose(pb.constants[k], EN_TABLE[k])) bad++;
    }
    return bad;
  }
  function noTunnelRed(pb) { return !(pb.maxStepDisplacement() / pb.thinnestCollider() < 1); }
  function unitNormalRed(pb) {
    const h = pb.circleVsSegment(44, 50, 9, 20, 50, 40, 50);
    return !(h && Math.abs(Math.hypot(h.nx, h.ny) - 1) < 1e-9);
  }
  function streakCapRed(pb) {
    /* The documented cap is BUMPER_BASE * STREAK_MAX_MULT from the README. */
    return pb.bumperScore(25) !== Math.round(EN_TABLE.BUMPER_BASE * EN_TABLE.STREAK_MAX_MULT);
  }
  function titleRed(src) {
    const raw = ((src.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1] || '').trim();
    const key = ((src.match(/<title[^>]*data-i18n="([^"]+)"/) || [, ''])[1] || '');
    return (raw || (key ? 'x' : '')).length === 0;
  }
  function timerRed(src) { return /\bset(?:Timeout|Interval)\s*\(/.test(stripComments(src)); }
  function onChangeRed(src) { return (src.match(/T\.onChange/g) || []).length !== 1; }

  const injections = [
    { name: 'MAX_SPEED 1400 -> 5000 (no-tunnel ratio crosses 1)',
      patch: h => h.replace(/var MAX_SPEED\s*=\s*1400;/, 'var MAX_SPEED = 5000;'),
      probes: [['no-tunnel ratio < 1', (S, pb) => !noTunnelRed(pb)],
               ['maxStepDisplacement == MAX_SPEED*PHYS_STEP', (S, pb) => Math.abs(pb.maxStepDisplacement() - pb.constants.MAX_SPEED * pb.constants.PHYS_STEP) < 1e-9]] },
    { name: 'BUMPER_BASE 100 -> 130 in the code (doc contract fires)',
      patch: h => h.replace(/var BUMPER_BASE\s*=\s*100;/, 'var BUMPER_BASE = 130;'),
      probes: [['README table matches PB.constants', (S, pb) => docContractReds(pb) === 0]] },
    { name: 'STREAK_MAX_MULT 5 -> 4 (bumperScore cap moves)',
      patch: h => h.replace(/var STREAK_MAX_MULT\s*=\s*5;/, 'var STREAK_MAX_MULT = 4;'),
      probes: [['bumperScore caps at BUMPER_BASE*STREAK_MAX_MULT', (S, pb) => !streakCapRed(pb)],
               ['README table matches PB.constants', (S, pb) => docContractReds(pb) === 0]] },
    { name: 'circleVsSegment returns an unnormalised normal',
      patch: h => h.replace('nx = (num(cx) - cp.x) / cp.dist;', 'nx = (num(cx) - cp.x);'),
      probes: [['circleVsSegment normal is unit', (S, pb) => !unitNormalRed(pb)]] },
    { name: 'the <title> emptied (from a non-empty baseline)',
      patch: h => h.replace(/<title[^>]*>[\s\S]*?<\/title>/, '<title></title>'),
      baseline: h => h.replace(/<title[^>]*>[\s\S]*?<\/title>/, '<title>Pinball</title>'),
      probes: [['document <title> is non-empty', (S) => !titleRed(S)]] },
    { name: 'a setInterval() call injected (static timer gate)',
      patch: h => h.replace('newGame({ seed: 1 });', 'setInterval(function () {}, 1000);\n  newGame({ seed: 1 });'),
      probes: [['no setInterval/setTimeout', (S) => !timerRed(S)]] },
    { name: 'a second T.onChange registered',
      patch: h => h.replace('T.onChange(function () {', 'T.onChange(function () {});\n  T.onChange(function () {'),
      probes: [['exactly one T.onChange', (S) => !onChangeRed(S)]] }
  ];

  let totalRed = 0, totalProbes = 0;
  for (const inj of injections) {
    let reds = 0, labels = [];
    for (const [label, probe] of inj.probes) {
      totalProbes++;
      let src = inj.patch(HTML);
      /* Some injections need a GREEN baseline first (the title starts empty). */
      if (inj.baseline) {
        const green = inj.baseline(HTML);
        const gEnv = bootSource(green, I18N);
        const greenOk = probe(green, gEnv.PB);
        if (!greenOk) note(`(baseline for "${inj.name}" was already red)`);
      }
      const env = bootSource(src, I18N);
      const isRed = !probe(src, env.PB);
      if (isRed) { reds++; labels.push(label); }
    }
    totalRed += reds;
    check(reds >= 1, `injecting "${inj.name}" turns ${reds}/${inj.probes.length} matching check(s) red -> ${JSON.stringify(labels)}`);
    note(`  "${inj.name}": ${reds} red assertion(s)`);
  }

  /* Sanity: the clean source passes every probe (so the reds above are real). */
  let cleanRed = 0;
  for (const inj of injections) for (const [, probe] of inj.probes) {
    if (inj.baseline) continue;                      // title baseline handled above
    if (!probe(HTML, PB)) cleanRed++;
  }
  check(cleanRed === 0, `the unmodified source passes every reverse-check probe (${cleanRed} spurious)`);
  note(`reverse validation: ${totalRed} injected assertions went red out of ${totalProbes} probes across ${injections.length} injections`);
}

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
console.log('(vm sandbox; constants + geometry from the README and PB.world(); independent '
  + 'brute-force/clamp oracles for the geometry; a closed-form integrator check; the '
  + 'no-tunnel bound three ways incl. the large-dt regression; 32 no-input seeds + a '
  + 'flipper-abuse run; dynamic i18n through the captured T.onChange; in-suite reverse validation)');
process.exit(fail ? 1 : 0);
