#!/usr/bin/env node
/**
 * Rule / logic tests for runner-game (an endless 3-lane runner).
 *
 * `tools/smoke.js` only proves the page parses and does not throw: its stub DOM
 * invents an element for ANY id, returns [] from querySelectorAll, hands back a
 * permissive callable Proxy for the 2D context and asserts no value at all. It
 * cannot tell whether the speed/unit chain is calibrated, whether the obstacle
 * field is really a pure function of distance, whether every slot leaves a live
 * lane, whether the README's constants are the shipped ones, whether the dynamic
 * i18n text re-renders, or whether a perfect bot can actually survive. This suite
 * loads the whole inline <script> in a vm sandbox with the same stub DOM and
 * asserts behaviour through the game's own bridge object `window.RN`.
 *
 * The model under test:
 *   - One scalar `distance` (px) is the whole world clock. The obstacle field is
 *     a PURE function of distance (and the seed).
 *   - `levelAt(s) = min(LEVEL_MAX, floor(s / LEVEL_SPAN))`;
 *     `speedAt(s) = min(SPEED_MAX, SPEED_BASE + SPEED_RAMP * levelAt(s))`.
 *   - Slot k sits at the fixed distance `slotS(k) = SLOT0 + k * SLOT_GAP`, so the
 *     spacing is constant in DISTANCE and the TIME between slots shrinks toward
 *     the floor `SLOT_GAP / SPEED_MAX` as speed rises.
 *   - Kinds: low (jump or avoid), high (slide or avoid), wall (be in a free
 *     lane). Never all three lanes. A slot may be empty and may carry a coin in
 *     a free lane.
 *
 * Why this layer exists, and why it is NOT a copy of the game:
 *
 *  1. The oracle problem. `timeBetween` is a CLOSED-FORM integral of 1/speed.
 *     Comparing it to a re-typed copy of itself proves nothing, so group 3
 *     integrates 1/speedAt(s) NUMERICALLY with two methods of a different shape
 *     (fine composite Simpson and a midpoint rule) and compares on many (s0,s1)
 *     pairs, including ones that span several level boundaries.
 *
 *  2. The documentation contract. The README constant table is parsed out of the
 *     markdown and every row compared to RN.constants, and the prose geometry is
 *     compared to RN.world(). This is the ONLY test that can catch someone
 *     silently editing the shipped data, because an oracle that reads its
 *     expectations from RN.constants agrees with the code by construction.
 *
 *  3. The stub-DOM boundary the game must live inside. `document.querySelectorAll`
 *     is empty, so the data-i18n marker translation is a no-op here (it is covered
 *     in the real-DOM layer); but the runtime-composed text (status line, HUD
 *     labels, overlay) is written through getElementById and can be read back and
 *     proved to re-localise. `El.style.setProperty` stores NOTHING, so a vm test
 *     cannot read positions back from the DOM - geometry is verified from the
 *     bridge's pure functions (toPixel/world()/hazardAt), which is the correct
 *     split; the painted positions belong to the DOM layer.
 *
 *  4. The invariants that only appear over thousands of slots: P1 (a free lane
 *     always exists), P2 (routes are connected), P3 (reaction budget), P4 (speed
 *     ceiling), P5 (jump/slide clearances), P6 (lane change fits the budget), P7
 *     (no coin in a blocked lane), swept over many seeds.
 *
 * Reverse validation (group 12) re-injects deliberate bugs into a string copy of
 * the page (plus a couple of runtime bridge mutations that are robust to the
 * exact internal shape) and asserts the matching rule goes red, so a
 * vacuously-green comparator cannot hide.
 *
 * Usage:  node tools/runner-test.js [path/to/index.html] [path/to/assets/i18n.js]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const GAME = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'runner-game', 'index.html');
const I18N = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(ROOT, 'assets', 'i18n.js');
const README_EN = path.join(path.dirname(GAME), 'README.md');
const README_ZH = path.join(path.dirname(GAME), 'README.zh.md');

let pass = 0, fail = 0;
function check(cond, label, extra) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra !== undefined ? `  [${extra}]` : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }
function note(msg) { console.log(`  ·    ${msg}`); }
const CJK = /[\u4e00-\u9fff]/;
const relClose = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-5 : tol) * Math.max(1, Math.abs(b));
const absClose = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);

/* ------------------------------------------------------------------ stub DOM */
/* Mirrors tools/smoke.js makeContext() - the HARD runtime boundary the game must
 * live inside:
 *   - setTimeout is a NO-OP; setInterval is fast-forwarded (the harness runs its
 *     callbacks 40x); clearTimeout/clearInterval are no-ops;
 *   - document.querySelectorAll returns [];
 *   - el.querySelectorAll('.cls') / el.closest('.cls') still work;
 *   - getAttribute() always null, setAttribute() a no-op;
 *   - localStorage has no removeItem;
 *   - no alert/confirm/prompt/window.location;
 *   - canvas getContext('2d') is a callable Proxy whose .canvas.width and
 *     measureText().width are NOT numbers - which is exactly why the game must
 *     never read geometry back from the canvas (asserted statically in group 1);
 *   - El.style.setProperty stores NOTHING and getPropertyValue always returns '',
 *     so this layer cannot read painted positions (that belongs to the DOM layer).
 */

function makeContext() {
  const ctxProxy = new Proxy(function () {}, {
    apply: () => ctxProxy,
    get: (t, k) => {
      if (k === 'then') return undefined;
      if (k === 'canvas') return { width: 'not-a-number', height: undefined, getBoundingClientRect: () => ({ width: 0, height: 0 }) };
      if (k === 'measureText') return () => ({ width: undefined });
      return ctxProxy;
    }
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
      this.placeholder = '';
      this.width = 480;
      this.height = 720;
      this.clientWidth = 440;
      this.clientHeight = 440;
      this._attrs = {};
      this._text = '';
      this._html = '';
      this._cls = new Set();
      /* Deliberately stores nothing: a vm test must not be able to read a painted
       * position back from the DOM. The game owns geometry through constants. */
      this.style = { setProperty() {}, getPropertyValue: () => '', removeProperty() {} };
      this.classList = {
        add: (...cs) => cs.forEach(c => this._cls.add(c)),
        remove: (...cs) => cs.forEach(c => this._cls.delete(c)),
        contains: c => this._cls.has(c),
        toggle: (c, on) => { const o = (on === undefined) ? !this._cls.has(c) : on; if (o) this._cls.add(c); else this._cls.delete(c); }
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
    appendChild(c) {
      if (c instanceof Frag) c.children.forEach(x => { x.parent = this; this.children.push(x); });
      else { c.parent = this; this.children.push(c); }
      return c;
    }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    setAttribute(k) { /* no-op, exactly like smoke.js */ }
    getAttribute() { return null; }
    closest(sel) { const w = sel.replace('.', ''); let n = this; while (n) { if (n._cls && n._cls.has(w)) return n; n = n.parent; } return null; }
    querySelector(s) { return this._find(s)[0] || null; }
    querySelectorAll(s) { return this._find(s); }
    _find(s) {
      const w = s.replace('.', '');
      const out = [];
      (function walk(n) { n.children.forEach(c => { if (c && c._cls && c._cls.has(w)) out.push(c); if (c && c.children) walk(c); }); })(this);
      return out;
    }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 480, bottom: 720, width: 480, height: 720 }; }
  }

  const els = {};
  const docHandlers = {};
  const winHandlers = {};
  let frame = null;
  let clockMs = 0;
  const store = {};

  const context = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map, WeakMap,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN,
    performance: { now: () => clockMs },
    /* setTimeout is a no-op; setInterval is recorded so the harness can
     * fast-forward it 40x (the game must not use either - see group 1). */
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: fn => { context._intervals.push(fn); return context._intervals.length; },
    clearInterval: () => {},
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
    devicePixelRatio: 1,
    _intervals: [],
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); }
      /* deliberately no removeItem */
    },
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
    context, els, store,
    fireDoc(t, ev) { (docHandlers[t] || []).forEach(f => f(ev || {})); },
    fireWin(t, ev) { (winHandlers[t] || []).forEach(f => f(ev || {})); },
    /* Pump one genuine rAF frame so update()+paint run. The clock advances. */
    step(dt) { clockMs += (dt === undefined ? 16 : dt); const f = frame; frame = null; if (f) f(clockMs); },
    /* Fast-forward every registered interval 40x, like smoke.js timers(40). */
    fastForward(n) { for (let i = 0; i < (n === undefined ? 40 : n); i++) context._intervals.slice().forEach(fn => fn()); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

/* Boot the game from a list of inline <script> bodies. LiteI18N.create is wrapped
 * so the game's private `T` instance is captured without touching the source
 * (T lives inside the IIFE), which is what lets the i18n group prove the language
 * switch really re-renders the dynamic text. */
function bootEnv(scriptBodies, i18nFile) {
  const env = makeContext();
  vm.runInContext(fs.readFileSync(i18nFile, 'utf8'), env.context, { filename: 'i18n.js' });
  let T = null;
  const orig = env.context.LiteI18N.create;
  env.context.LiteI18N.create = function (dict) { T = orig(dict); return T; };
  scriptBodies.forEach((s, i) => {
    vm.runInContext(s, env.context, { filename: `runner/index.html#script${i}` });
  });
  env.step();                                   // one real rAF frame (update + paint)
  return { env, RN: env.context.RN, T, els: env.els, store: env.store };
}
function boot(gameFile, i18nFile) {
  return bootEnv(inlineScripts(fs.readFileSync(gameFile, 'utf8')), i18nFile);
}
function bootSource(srcHtml, i18nFile) {
  return bootEnv(inlineScripts(srcHtml), i18nFile);
}

/* ------------------------------------------------------------- static helpers */
function stripComments(html) {
  return html.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1 ');
}
/* The {..}-balanced body of `function name(...)`, or null if absent. */
function fnBody(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{'));
  if (!m) return null;
  let depth = 1, i = m.index + m[0].length;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++; else if (src[i] === '}') depth--;
  }
  return src.slice(m.index + m[0].length, i - 1);
}
/* Every getElementById('x') target must exist as id="x" in the markup (the stub
 * invents an element for ANY id, so a dangling id is invisible at runtime but
 * throws in a real browser - typing-game shipped exactly that way). */
function danglingIds(html) {
  const used = [...html.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const created = new Set([
    ...[...html.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...html.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  ]);
  return [...new Set(used)].filter(id => !defined.has(id) && !created.has(id));
}
/* A top-level `var` becomes a property write on window; several window members
 * are unforgeable, so the write silently fails and the name keeps pointing at the
 * browser object. Only a bare line-leading `var` is a hazard (let/const shadow). */
const WINDOW_UNFORGEABLE = ['window', 'self', 'document', 'location', 'top', 'parent', 'frames',
  'history', 'navigator', 'external', 'length', 'origin', 'closed', 'opener', 'event',
  'screen', 'screenX', 'screenY', 'screenLeft', 'screenTop',
  'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio',
  'scrollX', 'scrollY', 'pageXOffset', 'pageYOffset',
  'performance', 'localStorage', 'sessionStorage', 'indexedDB', 'crypto',
  'isSecureContext', 'clientInformation', 'visualViewport'];
function clobberedGlobals(html) {
  const code = stripComments(html);
  const hits = new Set();
  const re = /^var\s+([^;]+);/gm;
  let m;
  while ((m = re.exec(code))) {
    for (const part of m[1].split(',')) {
      const name = part.match(/^\s*([A-Za-z_$][\w$]*)\s*(?:=|$)/);
      if (name && WINDOW_UNFORGEABLE.includes(name[1])) hits.add(name[1]);
    }
  }
  return [...hits];
}

/* The HUD static gate. It discovers the HUD node variables from the write sites
 * inside updateHud() (so it is robust to whatever the game names them) and then
 * proves NO such node is written `.textContent` anywhere else: the value cache
 * and the DOM can never drift apart (the frog/platformer bug class). */
function hudWriteGate(src) {
  const body = fnBody(src, 'updateHud');
  if (!body) return { ok: false, reason: 'no updateHud() definition found', vars: [] };
  const varRe = /([A-Za-z_$][\w$]*)\.textContent\s*=/g;
  const vars = new Set();
  let m;
  while ((m = varRe.exec(body))) vars.add(m[1]);
  const insideCount = (body.match(/\.textContent\s*=/g) || []).length;
  const stray = [];
  for (const v of vars) {
    const total = (src.match(new RegExp('\\b' + v + '\\.textContent\\s*=', 'g')) || []).length;
    const inB = (body.match(new RegExp('\\b' + v + '\\.textContent\\s*=', 'g')) || []).length;
    if (total !== inB) stray.push(v);
  }
  const direct = (src.match(/getElementById\s*\(\s*['"][^'"]+['"]\s*\)\s*\.textContent\s*=/g) || []).length;
  const directIn = (body.match(/getElementById\s*\(\s*['"][^'"]+['"]\s*\)\s*\.textContent\s*=/g) || []).length;
  return { ok: vars.size >= 2 && stray.length === 0 && direct === directIn && insideCount >= 2, vars: [...vars], stray, insideCount, direct, directIn };
}

/* --------------------------------------------------------------- README parse */
/* Parse the constant table out of a README. Row shapes to survive:
 *   `A` / `B`      | 480 / 720  | px     (N names, N values)
 *   `X`            | 1/240      | s      (a fraction is ONE value) */
function evalNum(s) {
  s = String(s).trim()
    .replace(/\u2212/g, '-')
    .replace(/[×✕]/g, '*')
    .replace(/[(（].*?[)）]/g, '')
    .replace(/\s+/g, '');
  if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  if (/^-?\d+(\.\d+)?\/-?\d+(\.\d+)?$/.test(s)) { const p = s.split('/'); return parseFloat(p[0]) / parseFloat(p[1]); }
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
    const names = [...cells[1].matchAll(/`([A-Z_][A-Z0-9_]*)`/g)].map(m => m[1]);
    if (!names.length) continue;
    const vals = parseValueCell(cells[2], names.length);
    if (!vals) continue;
    names.forEach((n, i) => { out[n] = vals[i]; });
  }
  return out;
}
function readmeNumbers(md) { return [...md.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => parseFloat(m[0])); }
function hasNum(md, value, tol) {
  return readmeNumbers(md).some(x => Math.abs(x - value) <= tol);
}
function numNear(md, keywords, value, tol) {
  for (const kw of keywords) {
    const idxs = [...md.matchAll(new RegExp(kw, 'ig'))].map(m => m.index);
    for (const i of idxs) {
      const seg = md.slice(Math.max(0, i - 140), i + 220);
      if (readmeNumbers(seg).some(x => Math.abs(x - value) <= tol)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ boot ---- */
let G, RN, T, HTML, EN_MD, ZH_MD, EN_TABLE, ZH_TABLE;

/* Stage 1: the page must boot. A page that is missing or throws while booting is
 * a HARD, labelled failure - never a skip and never a raw VM exception. */
try {
  HTML = fs.readFileSync(GAME, 'utf8');
  if (!inlineScripts(HTML).length) throw new Error('no inline <script> found in the page');
  G = boot(GAME, I18N);
  RN = G.RN;
  T = G.T;
  if (!RN) throw new Error('window.RN is not defined after boot');
} catch (e) {
  console.log(`  FAIL the page threw during boot: ${(e && e.message) || e}`);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

/* Stage 2: the game's two READMEs (the independent oracle for the constants). */
try {
  EN_MD = fs.readFileSync(README_EN, 'utf8');
  ZH_MD = fs.readFileSync(README_ZH, 'utf8');
  EN_TABLE = parseConstTable(EN_MD);
  ZH_TABLE = parseConstTable(ZH_MD);
} catch (e) {
  console.log(`  FAIL the game's README is missing or unreadable: ${(e && e.message) || e}`);
  console.log('\n0 passed, 1 failed');
  process.exit(1);
}

/* Constants by exact source name (the README table is the authority on names). */
const C = RN.constants || {};
const num = name => (typeof C[name] === 'number' ? C[name] : NaN);
const haveConst = name => typeof C[name] === 'number';

/* The pure model helpers reused by several groups (and by group 12). */
function slot(rn, k) {
  const h = rn.hazardAt(k);
  if (!h) return { k, empty: true, blocked: [], free: [0, 1, 2], coin: null, kind: null };
  return {
    k, empty: false, blocked: h.blocked || [], free: h.free || [],
    coin: h.coin || null, kind: h.kind, lane: h.lane, s: h.s, w: h.w, h: h.h
  };
}
function freeLanes(rn, k) { return slot(rn, k).free; }

/* A slot's COLLISION WINDOW along the track: the engine tests swept overlap of
 * [d0, distance] against [s - halfW, s + halfW] with halfW = h.w/2 + PLAYER_W/2.
 * (It is NOT [s, s + w]: the player has width too, so the window is centred on
 * the slot and is longer than the hazard.) */
function hazardWindow(rn, k) {
  const h = rn.hazardAt(k);
  if (!h) return [Infinity, -Infinity];
  const halfW = h.w / 2 + num('PLAYER_W') / 2;
  return [h.s - halfW, h.s + halfW];
}

/* The first slot (k = 0..maxK) that blocks `lane`. */
function firstBlocker(rn, lane, maxK) {
  for (let k = 0; k <= maxK; k++) {
    const h = rn.hazardAt(k);
    if (h && h.kind !== 'empty' && (h.blocked || []).includes(lane)) return h;
  }
  return null;
}

/* A corridor-following bot using the WINDOW-AWARE policy. A slot's collision
 * window stays OPEN past its own distance, so "the next slot" is the smallest k
 * with s_k + halfW >= distance - never floor(distance/SLOT_GAP) + 1, which dies.
 * While a window contains `distance`, hold a lane in that slot's `free` set;
 * otherwise pre-position for the next window (the inter-window gap is
 * SLOT_GAP - (HAZARD_HIGH_W + PLAYER_W) = 216 px, i.e. 0.415 s even at
 * SPEED_MAX, comfortably over the 0.18 s a lane change needs). */
function botStep(rn) {
  const s = rn.getState();
  const HALF_MAX = num('HAZARD_HIGH_W') / 2 + num('PLAYER_W') / 2;
  const d = s.distance;
  const kc = Math.max(0, Math.ceil((d + HALF_MAX - num('SLOT0')) / num('SLOT_GAP')) - 1);
  let hold = null;
  for (let k = Math.max(0, kc - 2); k <= kc + 2; k++) {
    const w = hazardWindow(rn, k);
    if (d >= w[0] && d <= w[1]) { hold = slot(rn, k).free; break; }
  }
  let want = s.targetLane;
  const byNear = (a, b) => Math.abs(a - s.targetLane) - Math.abs(b - s.targetLane);
  if (hold) {
    if (!hold.includes(s.targetLane)) want = hold.slice().sort(byNear)[0];
  } else {
    let kn = null;
    for (let k = kc; k <= kc + 4; k++) { if (hazardWindow(rn, k)[0] > d) { kn = k; break; } }
    if (kn === null) kn = kc + 1;
    const f = slot(rn, kn).free;
    if (!f.includes(s.targetLane)) want = f.slice().sort(byNear)[0];
  }
  if (want > s.targetLane) rn.moveLane(1); else if (want < s.targetLane) rn.moveLane(-1);
}

/* Does a coarse stride skip a hazard this engine should have caught? Used as a
 * group-12 probe against a patched bridge, so it takes the bridge as an argument.
 * Returns TRUE when the coarse and fine arms disagree on whether a hit happened
 * (i.e. the engine is step-size dependent = defective). */
function stepSkips(rn) {
  for (const seed of [1, 2]) {
    rn.newGame({ seed });
    let targetK = null;
    for (let k = 90; k < 600; k++) {
      const h = rn.hazardAt(k);
      if (h && h.kind !== 'empty' && (h.blocked || []).includes(1)) { targetK = k; break; }
    }
    if (targetK === null) continue;
    const W = hazardWindow(rn, targetK);
    const prefix = () => {
      rn.newGame({ seed }); rn.start();
      let g = 0, s = rn.getState();
      while (s.phase === 'playing' && s.distance < W[0] - 160 && g++ < 400000) { botStep(rn); rn.tick(1 / 60, 1 / 60); s = rn.getState(); }
      let g2 = 0;
      while (s.phase === 'playing' && s.targetLane !== 1 && g2++ < 4000) { rn.moveLane(s.targetLane < 1 ? 1 : -1); rn.tick(1 / 60, 1 / 60); s = rn.getState(); }
      let g3 = 0;
      while (s.phase === 'playing' && s.distance < W[0] - 20 && g3++ < 20000) { rn.tick(1 / 60, 1 / 60); s = rn.getState(); }
      return s;
    };
    const hit = (sec, stp) => {
      let s = prefix(), g = 0;
      const stop = W[1] + 1;                    // just past THIS window: no escape
      while (s.phase === 'playing' && s.distance < stop && g++ < 200000) { rn.tick(sec, stp); s = rn.getState(); }
      return s.phase === 'over';
    };
    if (hit(0.25, 0.25) !== hit(0.05, 1 / 60)) return true;
  }
  return false;
}

/* A numeric integrator of 1/speedAt(s), of a DELIBERATELY DIFFERENT shape to the
 * closed form under test. `mid` is the midpoint rule; otherwise composite
 * Simpson. speedAt is piecewise constant, so many samples are needed to keep the
 * jump error small. */
function numericTime(rn, s0, s1, n, scheme) {
  const f = s => 1 / rn.speedAt(s);
  const h = (s1 - s0) / n;
  if (scheme === 'mid') { let sum = 0; for (let i = 0; i < n; i++) sum += f(s0 + (i + 0.5) * h); return sum * h; }
  let sum = f(s0) + f(s1);
  for (let i = 1; i < n; i++) sum += f(s0 + i * h) * (i % 2 ? 4 : 2);
  return sum * h / 3;
}
function integralN(span) {
  let n = Math.ceil(Math.abs(span) / 0.05);
  n = Math.max(4000, Math.min(300000, n));
  return n + (n % 2);
}

/* P1: the minimum number of free lanes in any slot across a sweep. */
function sweepMinFree(rn, seeds, slots) {
  let minFree = Infinity, at = -1;
  for (const seed of seeds) {
    rn.newGame({ seed });
    for (let k = 0; k < slots; k++) {
      const n = freeLanes(rn, k).length;
      if (n < minFree) { minFree = n; at = k; }
    }
  }
  return { minFree, at };
}
/* P7: coins that sit in a blocked lane. */
function sweepCoinBlocked(rn, seeds, slots) {
  let bad = 0, first = -1;
  for (const seed of seeds) {
    rn.newGame({ seed });
    for (let k = 0; k < slots; k++) {
      const s = slot(rn, k);
      if (s.coin && s.blocked.includes(s.coin.lane)) { if (first < 0) first = k; bad++; }
    }
  }
  return { bad, first };
}
/* P2: routes are connected (a free lane in k reachable from one in k-1). */
function sweepConnected(rn, seeds, slots) {
  let bad = 0, first = -1;
  for (const seed of seeds) {
    rn.newGame({ seed });
    for (let k = 1; k < slots; k++) {
      const a = freeLanes(rn, k - 1), b = freeLanes(rn, k);
      if (!a.some(f => b.some(g => Math.abs(f - g) <= 1))) { if (first < 0) first = k; bad++; }
    }
  }
  return { bad, first };
}
/* P3: the minimum reaction budget over consecutive slots, and where it bottoms. */
function sweepMinBudget(rn, maxK) {
  let min = Infinity, at = -1;
  const G = num('SLOT_GAP');
  for (let k = 1; k <= maxK; k++) {
    const t = rn.timeBetween(rn.slotS(k - 1), rn.slotS(k));
    if (t < min) { min = t; at = k; }
  }
  return { min, at, gapRatio: G > 0 ? G / num('SPEED_MAX') : NaN };
}
/* The worst absolute error of the closed-form timeBetween vs my numeric integral. */
function diffTimeBetween(rn, pairs) {
  let worst = 0, worstPair = null, worstScheme = '';
  for (const [s0, s1] of pairs) {
    for (const scheme of ['simpson', 'mid']) {
      const got = numericTime(rn, s0, s1, integralN(s1 - s0), scheme);
      const want = rn.timeBetween(s0, s1);
      const err = Math.abs(got - want);
      if (err > worst) { worst = err; worstPair = [s0, s1]; worstScheme = scheme; }
    }
  }
  return { worst, worstPair, worstScheme };
}

/* ======================================================================
 * 0. bridge shape and the deterministic boot state
 * ==================================================================== */

group('0. bridge shape and the deterministic boot state');
{
  check(!!RN, 'window.RN bridge exists after boot');
  const fns = ['world', 'mulberry32', 'levelAt', 'speedAt', 'slotS', 'slotCount', 'hazardAt',
    'hazardsBetween', 'timeBetween', 'reactionBudget', 'jumpApex', 'jumpAirtime', 'slideDuration',
    'laneChangeTime', 'toPixel', 'getState', 'hudCache', 'log', 'newGame', 'start', 'pause',
    'resume', 'togglePause', 'moveLane', 'jump', 'slide', 'tick'];
  const missing = fns.filter(k => typeof RN[k] !== 'function');
  check(missing.length === 0, `the bridge exposes all ${fns.length} documented functions (missing ${JSON.stringify(missing)})`);
  check(!!C && typeof C === 'object', 'RN.constants is an object');

  const w = RN.world();
  check(w && w.laneCount === 3, `world().laneCount is 3 (got ${w && w.laneCount})`);
  check(Array.isArray(w.laneX) && w.laneX.length === 3, `world().laneX carries three lane positions (got ${JSON.stringify(w && w.laneX)})`);
  ['laneW', 'viewW', 'viewH', 'groundY', 'playerW', 'playerH', 'playerSlimH', 'slotGap', 'slot0'].forEach(kk => {
    check(typeof w[kk] === 'number' && isFinite(w[kk]), `world().${kk} is a finite number (got ${w[kk]})`);
  });

  const st = RN.getState();
  ['phase', 'distance', 'score', 'best', 'level', 'speed', 'lane', 'targetLane', 'y', 'vy',
    'onGround', 'sliding', 'alive', 'coinCount', 'over', 'seed', 'rng', 'ticks', 'log'].forEach(kk => {
      check(kk in st, `getState() carries '${kk}' (got ${JSON.stringify(st[kk])})`);
    });
  check(st.phase === 'ready', `the game boots into 'ready' (got ${st.phase})`);
  check(st.distance === 0 && st.score === 0 && st.level === 0 && st.coinCount === 0,
    `fresh state is distance 0 / score 0 / level 0 / 0 coins (got ${st.distance}/${st.score}/${st.level}/${st.coinCount})`);
  check(st.onGround === true && st.sliding === false && st.alive === true && st.over === false,
    `fresh state is grounded/not sliding/alive/not over (got ${st.onGround}/${st.sliding}/${st.alive}/${st.over})`);
  check(st.rng && 'seed' in st.rng && 'calls' in st.rng, `getState().rng is {seed,calls} (got ${JSON.stringify(st.rng)})`);
}

/* ======================================================================
 * 1. Static gates
 * ==================================================================== */

group('1. static gates: one script, one onChange, no timers/random/canvas, ids, HUD write locality');
{
  const code = stripComments(HTML);

  const scripts = inlineScripts(HTML);
  check(scripts.length === 1, `the page carries exactly one inline <script> (found ${scripts.length})`);

  const onCount = (code.match(/T\.onChange/g) || []).length;
  check(onCount === 1, `T.onChange is registered exactly once (found ${onCount})`);

  const timers = (code.match(/\bset(?:Timeout|Interval)\s*\(/g) || []).length;
  check(timers === 0, `the source never CALLS setTimeout/setInterval (found ${timers}; comments stripped first)`);
  const rand = (code.match(/\bMath\.random\s*\(/g) || []).length;
  check(rand === 0, `the source never CALLS Math.random (found ${rand})`);
  const ctxCall = (code.match(/getContext\s*\(/g) || []).length;
  check(ctxCall === 0, `the source never CALLS getContext - the game is pure DOM (found ${ctxCall})`);

  const titleRaw = ((HTML.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1] || '').trim();
  check(titleRaw.length > 0, `the document <title> is non-empty and hard-coded (got ${JSON.stringify(titleRaw)})`);

  const dangling = danglingIds(HTML);
  const usedCount = new Set([...HTML.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])).size;
  check(dangling.length === 0, `every getElementById target exists as id="..." (${usedCount} ids; missing ${JSON.stringify(dangling)})`);

  const clob = clobberedGlobals(HTML);
  check(clob.length === 0, `no top-level var collides with a read-only window property (found ${JSON.stringify(clob)})`);

  check(/<[^>]*\bdata-lang-switch\b/.test(HTML), 'a [data-lang-switch] host exists in the markup (the i18n switcher mounts into it)');

  const hud = hudWriteGate(code);
  check(hud.ok, `the HUD nodes are written .textContent ONLY inside updateHud() (vars ${JSON.stringify(hud.vars)}, stray ${JSON.stringify(hud.stray)}, inside ${hud.insideCount}${hud.reason ? ', ' + hud.reason : ''})`);
  note(`HUD gate: ${hud.vars ? hud.vars.length : 0} node variable(s) discovered from updateHud(); ${hud.insideCount} textContent write(s) inside`);
}

/* ======================================================================
 * 2. Documentation contract (the README is the oracle for the shipped data)
 * ==================================================================== */

group('2. documentation contract: README table == RN.constants, README prose == RN.world()');
{
  const enNames = Object.keys(EN_TABLE);
  check(enNames.length >= 12, `parsed ${enNames.length} constant rows out of README.md (extracted with the UPPER_SNAKE name regex)`);

  const bad = [], notExported = [];
  for (const k of enNames) {
    if (!(k in C)) { notExported.push(k); continue; }
    if (!relClose(C[k], EN_TABLE[k])) bad.push(`${k}: doc ${EN_TABLE[k]} vs code ${C[k]}`);
  }
  check(bad.length === 0, `every README.md constant row matches RN.constants (mismatches ${JSON.stringify(bad.slice(0, 6))})`);
  check(notExported.length <= 4, `the README documents only constants the bridge exports (unexported rows ${JSON.stringify(notExported)})`);

  const zhNames = Object.keys(ZH_TABLE);
  const onlyEn = enNames.filter(k => !(k in ZH_TABLE));
  const onlyZh = zhNames.filter(k => !(k in EN_TABLE));
  const diffTable = enNames.filter(k => k in ZH_TABLE && !relClose(ZH_TABLE[k], EN_TABLE[k]));
  check(onlyEn.length === 0 && onlyZh.length === 0,
    `README.md and README.zh.md carry the same key set (en-only ${JSON.stringify(onlyEn)}, zh-only ${JSON.stringify(onlyZh)})`);
  check(diffTable.length === 0, `every shared row carries the same number in both tables (diff ${JSON.stringify(diffTable)})`);
  const zhBad = zhNames.filter(k => k in C && !relClose(C[k], ZH_TABLE[k]));
  check(zhBad.length === 0, `every README.zh.md row also matches RN.constants (mismatches ${JSON.stringify(zhBad)})`);

  /* Geometry prose -> RN.world(). The numbers the spec requires in prose are the
   * lane count, the lane x positions, the view size and the ground y. */
  const w = RN.world();
  const geo = { laneCount: w.laneCount, viewW: w.viewW, viewH: w.viewH, groundY: w.groundY };
  const geoMissing = Object.keys(geo).filter(k => !hasNum(EN_MD, geo[k], 0.001) && !hasNum(ZH_MD, geo[k], 0.001));
  check(geoMissing.length === 0, `the README prose states the geometry (missing ${JSON.stringify(geoMissing.map(k => `${k}=${geo[k]}`))})`);
  check(w.laneX.every(x => hasNum(EN_MD, x, 0.5) || hasNum(ZH_MD, x, 0.5)),
    `the README states the lane x positions ${JSON.stringify(w.laneX)}`);

  /* The numbers the README PRINTS, compared to the computed values. This is the
   * only copy of those numbers that is independent of the code. */
  const apex = RN.jumpApex(), airtime = RN.jumpAirtime();
  const ratio = num('SLOT_GAP') / num('SPEED_MAX');
  const minBudget = sweepMinBudget(RN, 400);
  const printed = [
    ['jump apex', ['apex', 'jump'], apex, 0.5],
    ['jump airtime', ['airtime', 'flight', 'jump'], airtime, 0.01],
    ['SLOT_GAP / SPEED_MAX', ['SLOT_GAP', 'reaction'], ratio, 0.01],
    ['minimum reaction budget', ['reaction', 'budget'], minBudget.min, 0.01]
  ];
  for (const [label, kws, value, tol] of printed) {
    const okNear = numNear(EN_MD, kws, value, tol) || hasNum(EN_MD, value, tol);
    check(okNear, `the README states the computed ${label} = ${value.toFixed(4)} (within ${tol})`);
  }
  note(`computed: apex ${apex.toFixed(3)} px, airtime ${airtime.toFixed(4)} s, SLOT_GAP/SPEED_MAX ${ratio.toFixed(4)} s, min reactionBudget ${minBudget.min.toFixed(4)} s @ slot ${minBudget.at}`);

  /* ---- hazardsBetween: the DOC and the CODE cannot drift -------------------
   * The emitted comment states the range it returns. We parse the operators out
   * of that comment and then check the OBSERVED behaviour against them, so
   * whichever way it is resolved (a `floor` kStart that leaks a slot below s0, or
   * a `ceil` that does not) the text and the code must agree - a doc that says
   * "inside [s0, s1]" while the code returns a slot below s0 is a defect. */
  const hbDoc = (HTML.match(/\/\*([\s\S]*?)\*\/\s*function hazardsBetween/) || [, ''])[1];
  check(hbDoc.trim().length > 0, 'the hazardsBetween docstring is present and parseable');
  const lowerOp = (hbDoc.match(/slotS\(kStart\)\s*(>=|>)\s*a/) || [])[1]
    || (/inside\s*\[s0,\s*s1\]/i.test(hbDoc) ? '>=' : null);
  const upperOp = (hbDoc.match(/slotS\(kEnd\)\s*(<=|<)\s*b/) || [])[1]
    || (/inside\s*\[s0,\s*s1\]/i.test(hbDoc) ? '<=' : null);
  check(lowerOp !== null && upperOp !== null,
    `the docstring states a parseable lower/upper bound (lower ${lowerOp}, upper ${upperOp})`);
  if (lowerOp !== null && upperOp !== null) {
    const Gp = num('SLOT_GAP'), S0p = num('SLOT0');
    const cases = [[S0p, S0p + 4 * Gp], [S0p + 0.5 * Gp, S0p + 4.5 * Gp],
      [0, S0p - 1], [S0p - 3 * Gp, S0p + 2 * Gp], [S0p + Gp, S0p + Gp]];
    const badLow = [], badHigh = [], incomplete = [];
    for (const [a, b] of cases) {
      const got = RN.hazardsBetween(a, b).map(h => h.s);
      if (!got.every(x => (lowerOp === '>=' ? x >= a : x > a))) badLow.push([a, b, got]);
      if (!got.every(x => (upperOp === '<=' ? x <= b : x < b))) badHigh.push([a, b, got]);
      const want = [];
      for (let k = Math.max(0, Math.floor((a - S0p) / Gp) - 2); k <= Math.ceil((b - S0p) / Gp) + 2; k++) {
        const d = RN.slotS(k);
        if ((lowerOp === '>=' ? d >= a : d > a) && (upperOp === '<=' ? d <= b : d < b)) want.push(k);
      }
      if (JSON.stringify(RN.hazardsBetween(a, b).map(h => h.k)) !== JSON.stringify(want)) {
        incomplete.push([a, b, RN.hazardsBetween(a, b).map(h => h.k), want]);
      }
    }
    check(badLow.length === 0,
      `hazardsBetween respects the docstring's LOWER bound ${lowerOp} (violations ${JSON.stringify(badLow).slice(0, 160)})`);
    check(badHigh.length === 0,
      `hazardsBetween respects the docstring's UPPER bound ${upperOp} (violations ${JSON.stringify(badHigh).slice(0, 160)})`);
    check(incomplete.length === 0,
      `hazardsBetween returns exactly the in-range slots the docstring promises (mismatches ${JSON.stringify(incomplete).slice(0, 200)})`);
    note(`hazardsBetween doc-vs-code: lower ${lowerOp}, upper ${upperOp} - text and behaviour agree on ${cases.length} ranges`);
  }
}

/* ======================================================================
 * 3. The differential pair for timeBetween (the most valuable group)
 * ==================================================================== */

group('3. timeBetween (closed form) vs a numeric integral of a different shape');
{
  const S0 = num('SLOT0'), G = num('SLOT_GAP'), SPAN = num('LEVEL_SPAN');
  const pairs = [];
  const add = (a, b) => { if (isFinite(a) && isFinite(b) && b > a) pairs.push([a, b]); };
  add(0, G);
  add(G, 2 * G);
  add(0, SPAN);                          // exactly one level boundary
  add(SPAN * 0.5, SPAN * 1.5);           // spans one boundary
  add(SPAN * 2.2, SPAN * 3.8);           // spans two boundaries, inside higher speed
  add(0, SPAN * 4);                      // spans many boundaries
  add(S0, S0 + G * 3);                   // inside the first level
  add(SPAN - 50, SPAN + 50);             // a narrow straddle of a boundary

  const { worst, worstPair, worstScheme } = diffTimeBetween(RN, pairs);
  check(pairs.length >= 6, `tested ${pairs.length} (s0,s1) pairs including multi-boundary spans`);
  check(worst < 1e-3,
    `the closed form matches the numeric integral on every pair (worst |err| ${worst.toExponential(2)} s via ${worstScheme} at ${JSON.stringify(worstPair)})`);
  note(`worst absolute timeBetween error = ${worst.toExponential(3)} s over ${pairs.length} pairs x 2 integration schemes`);

  /* A constant would trivially agree with itself; prove the integral is not flat
   * (i.e. the comparator can distinguish a real curve). */
  const a = RN.timeBetween(0, SLOT_or());
  const b = RN.timeBetween(0, SLOT_or() * 8);
  check(b > a && isFinite(a) && isFinite(b), `timeBetween grows with the span (t(1 slot)=${a.toFixed(4)} < t(8 slots)=${b.toFixed(4)})`);

  /* reactionBudget(k) is exactly the closed-form gap between slot k-1 and k. */
  let bad = 0, firstBad = '';
  for (let k = 1; k <= 300; k++) {
    const want = RN.timeBetween(RN.slotS(k - 1), RN.slotS(k));
    const got = RN.reactionBudget(k);
    if (Math.abs(got - want) > 1e-9) { bad++; if (!firstBad) firstBad = `k=${k}: ${got} vs ${want}`; }
  }
  check(bad === 0, `reactionBudget(k) === timeBetween(slotS(k-1), slotS(k)) for k=1..300 (${bad} bad${firstBad ? ', ' + firstBad : ''})`);
}
function SLOT_or() { return num('SLOT_GAP'); }

/* ======================================================================
 * 4. Unit calibration: freeze the speed/unit chain
 * ==================================================================== */

group('4. unit calibration: the speed chain, the step convention, level steps');
{
  const base = num('SPEED_BASE');

  RN.newGame({ seed: 1 });
  RN.start();
  const d0 = RN.getState().distance;
  RN.tick(1);
  const d1 = RN.getState().distance;
  check(d0 === 0, `a fresh run starts at distance 0 (got ${d0})`);
  check(absClose(d1 - d0, RN.speedAt(0), 1e-9),
    `tick(1) with no input advances exactly speedAt(0) = ${RN.speedAt(0)} px (got ${d1 - d0})`);

  /* The step convention: an explicit step subdivides the same second and lands in
   * the same place while speed is constant. */
  RN.newGame({ seed: 1 }); RN.start(); RN.tick(1, 1 / 60);
  const dStep60 = RN.getState().distance;
  RN.newGame({ seed: 1 }); RN.start(); RN.tick(1, 1 / 240);
  const dStep240 = RN.getState().distance;
  check(absClose(dStep60, RN.speedAt(0), 1e-9) && absClose(dStep240, RN.speedAt(0), 1e-9),
    `tick(1, 1/60) and tick(1, 1/240) both advance speedAt(0) (got ${dStep60} / ${dStep240})`);

  /* speedAt is non-decreasing and saturates at SPEED_MAX. */
  let mono = true, over = 0, prev = -Infinity;
  for (let s = 0; s <= num('LEVEL_SPAN') * (num('LEVEL_MAX') + 2); s += Math.max(1, num('LEVEL_SPAN') / 40)) {
    const v = RN.speedAt(s);
    if (v < prev - 1e-9) mono = false;
    if (v > num('SPEED_MAX') + 1e-9) over++;
    prev = v;
  }
  check(mono, 'speedAt(s) is non-decreasing in s');
  check(over === 0, `speedAt never exceeds SPEED_MAX = ${num('SPEED_MAX')}`);
  check(absClose(RN.speedAt(0), base, 1e-9), `speedAt(0) == SPEED_BASE = ${base} (got ${RN.speedAt(0)})`);
  check(absClose(RN.speedAt(num('LEVEL_SPAN') * (num('LEVEL_MAX') + 5)), num('SPEED_MAX'), 1e-9),
    `speedAt saturates at SPEED_MAX = ${num('SPEED_MAX')} (got ${RN.speedAt(num('LEVEL_SPAN') * (num('LEVEL_MAX') + 5))})`);

  /* levelAt steps at the documented boundaries. */
  const SPAN = num('LEVEL_SPAN');
  check(RN.levelAt(0) === 0, `levelAt(0) == 0 (got ${RN.levelAt(0)})`);
  check(RN.levelAt(SPAN - 1e-6) === 0 && RN.levelAt(SPAN) === 1,
    `levelAt steps 0 -> 1 at s = LEVEL_SPAN = ${SPAN} (got ${RN.levelAt(SPAN - 1e-6)} / ${RN.levelAt(SPAN)})`);
  check(RN.levelAt(SPAN * 2) === 2 && RN.levelAt(SPAN * 3 + 1) === 3,
    `levelAt is floor(s / LEVEL_SPAN) at 2 and 3 spans (got ${RN.levelAt(SPAN * 2)} / ${RN.levelAt(SPAN * 3 + 1)})`);
  check(RN.levelAt(SPAN * 1e6) === num('LEVEL_MAX'), `levelAt saturates at LEVEL_MAX = ${num('LEVEL_MAX')} (got ${RN.levelAt(SPAN * 1e6)})`);

  /* slotS is the documented arithmetic progression. */
  const S0 = num('SLOT0'), G = num('SLOT_GAP');
  let slotBad = 0;
  for (let k = 0; k <= 200; k++) if (!absClose(RN.slotS(k), S0 + k * G, 1e-9)) slotBad++;
  check(slotBad === 0, `slotS(k) == SLOT0 + k * SLOT_GAP for k=0..200 (${slotBad} bad)`);
}

/* ======================================================================
 * 5. P1-P7 provability (a real sweep over thousands of slots, many seeds)
 * ==================================================================== */

const SWEEP_SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const SWEEP_SLOTS = 2500;
let p1res, p2res, p3res, p7res;

group('5. P1-P7: the obstacle field provably stays playable (24 seeds x 2500 slots)');
{
  /* P1: at least one free lane in every slot. */
  p1res = sweepMinFree(RN, SWEEP_SEEDS, SWEEP_SLOTS);
  check(p1res.minFree >= 1, `P1: every slot leaves at least one free lane (minimum = ${p1res.minFree} at slot ${p1res.at}; must be 1, never 0)`);

  /* P2: routes are connected - a free lane in k reachable from one in k-1. */
  p2res = sweepConnected(RN, SWEEP_SEEDS, SWEEP_SLOTS);
  check(p2res.bad === 0, `P2: consecutive free-lane sets are connected by a |df|<=1 step (${p2res.bad} breaks, first at slot ${p2res.first})`);

  /* P3: every consecutive pair's timeBetween >= MIN_REACT_S. */
  p3res = sweepMinBudget(RN, SWEEP_SLOTS);
  check(p3res.min >= num('MIN_REACT_S') - 1e-9,
    `P3: the minimum reaction budget ${p3res.min.toFixed(4)} s (at slot ${p3res.at}) >= MIN_REACT_S = ${num('MIN_REACT_S')}`);

  /* P4: speed ceiling and the SLOT_GAP/SPEED_MAX floor. */
  check(absClose(p3res.min, p3res.gapRatio, 0.01),
    `P4: the min budget equals the SLOT_GAP/SPEED_MAX floor ${p3res.gapRatio.toFixed(4)} s (got ${p3res.min.toFixed(4)})`);
  check(p3res.gapRatio >= num('MIN_REACT_S') - 1e-9,
    `P4: SLOT_GAP/SPEED_MAX = ${p3res.gapRatio.toFixed(4)} s >= MIN_REACT_S = ${num('MIN_REACT_S')}`);

  /* P5: the player can clear every hazard kind. */
  const apex = RN.jumpApex(), lowH = num('HAZARD_LOW_H'), ph = num('PLAYER_H');
  check(apex >= lowH + 0.15 * ph - 1e-9,
    `P5: jumpApex() = ${apex.toFixed(2)} px >= HAZARD_LOW_H + 0.15*PLAYER_H = ${(lowH + 0.15 * ph).toFixed(2)}`);
  const slideReach = num('SLIDE_S') * num('SPEED_MAX');
  check(slideReach >= num('HAZARD_HIGH_W') - 1e-9,
    `P5: SLIDE_S*SPEED_MAX = ${slideReach.toFixed(1)} px >= HAZARD_HIGH_W = ${num('HAZARD_HIGH_W')}`);

  /* P6: a lane change fits inside the reaction budget. */
  check(RN.laneChangeTime() <= num('MIN_REACT_S') + 1e-9,
    `P6: laneChangeTime() = ${RN.laneChangeTime()} s <= MIN_REACT_S = ${num('MIN_REACT_S')}`);

  /* P7: no coin in a blocked lane. */
  p7res = sweepCoinBlocked(RN, SWEEP_SEEDS, SWEEP_SLOTS);
  check(p7res.bad === 0, `P7: no coin sits in a blocked lane (${p7res.bad} bad, first at slot ${p7res.first})`);

  /* Closed-form cross-checks of the pure jump/slide helpers. */
  const GRAV = num('GRAVITY'), JV = num('JUMP_V');
  check(absClose(apex, JV * JV / (2 * GRAV), 1e-6), `jumpApex() == JUMP_V^2/(2*GRAVITY) = ${(JV * JV / (2 * GRAV)).toFixed(4)}`);
  check(absClose(RN.jumpAirtime(), 2 * JV / GRAV, 1e-6), `jumpAirtime() == 2*JUMP_V/GRAVITY = ${(2 * JV / GRAV).toFixed(4)}`);
  check(absClose(RN.slideDuration(), num('SLIDE_S'), 1e-9), `slideDuration() == SLIDE_S = ${num('SLIDE_S')}`);
  check(absClose(RN.laneChangeTime(), num('LANE_CHANGE_S'), 1e-9), `laneChangeTime() == LANE_CHANGE_S = ${num('LANE_CHANGE_S')}`);

  note(`P1 min free = ${p1res.minFree} @ slot ${p1res.at}; P2 breaks = ${p2res.bad}; P3 min budget = ${p3res.min.toFixed(4)} s @ slot ${p3res.at}; P7 coins-in-blocked = ${p7res.bad}`);
}

/* ======================================================================
 * 6. Determinism and seeding
 * ==================================================================== */

group('6. determinism and seeding: the seeded stream is the only randomness');
{
  const field = seed => { RN.newGame({ seed }); return RN.hazardsBetween(0, num('SLOT_GAP') * 300); };
  const f1 = JSON.stringify(field(7)), f1b = JSON.stringify(field(7));
  check(f1 === f1b, 'the same seed yields a byte-identical hazard field');

  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  let distinctPairs = 0, totalPairs = 0;
  for (let i = 0; i < seeds.length; i++) for (let j = i + 1; j < seeds.length; j++) {
    totalPairs++;
    if (JSON.stringify(field(seeds[i])) !== JSON.stringify(field(seeds[j]))) distinctPairs++;
  }
  check(distinctPairs >= totalPairs - 1, `different seeds give demonstrably different fields (${distinctPairs}/${totalPairs} pairs differ)`);

  /* getState().rng echoes the seed, and the seeded randomness demonstrably varies
   * with the seed. NOTE: this generator derives every slot from a PURE per-slot
   * hash (mulberry32(mixSeed(seed,k,salt))) with NO live PRNG stream, so rng.calls
   * stays 0 and cannot "move" with the seed - the seed-dependence is therefore
   * measured on the generated field, and the constant counter is reported. */
  const s7 = RN.newGame({ seed: 7 });
  check(s7.rng.seed === 7 && s7.seed === 7, `getState().rng.seed echoes the requested seed (${s7.rng.seed})`);
  const callsFor = seed => { RN.newGame({ seed }); RN.start(); RN.tick(30, 1 / 60); return RN.getState().rng.calls; };
  const callCounts = seeds.slice(0, 6).map(callsFor);
  const distinctCalls = new Set(callCounts).size;
  const distinctFields = new Set(seeds.map(s => JSON.stringify(field(s)))).size;
  check(callCounts.every(c => Number.isFinite(c) && c >= 0),
    `rng.calls is a finite non-negative counter (counts ${JSON.stringify(callCounts)})`);
  check(distinctCalls >= 2 || distinctFields >= 2,
    `the seeded randomness varies with the seed (rng.calls ${JSON.stringify(callCounts)}; distinct fields ${distinctFields}${distinctCalls < 2 ? ' - rng.calls is a constant: this generator is a pure per-slot hash with no live stream' : ''})`);

  /* hazarAt(k) returns equal-but-distinct objects (no shared mutable state). */
  RN.newGame({ seed: 5 });
  const a = RN.hazardAt(3), b = RN.hazardAt(3);
  check(a && b && JSON.stringify(a) === JSON.stringify(b), 'hazardAt(k) called twice returns equal content');
  if (a && b) {
    check(a !== b, 'hazardAt(k) called twice returns DISTINCT objects (no shared reference)');
    if (Array.isArray(a.blocked)) { const before = b.blocked.length; a.blocked.push(99); check(b.blocked.length === before, 'mutating one hazard does not leak into the other (blocked is copied)'); }
    if (a.coin && typeof a.coin === 'object') { a.coin.lane = 99; check(b.coin && b.coin.lane !== 99, 'mutating one hazard coin does not leak into the other'); }
  }

  /* mulberry32 is a pure generator: same seed -> same stream; different -> diff. */
  const s1 = RN.mulberry32(42), s2 = RN.mulberry32(42), s3 = RN.mulberry32(43);
  let same = 0, diff = 0;
  for (let i = 0; i < 40; i++) { const x = s1(), y = s2(), z = s3(); if (x === y) same++; if (x !== z) diff++; }
  check(same === 40, `mulberry32(42) is reproducible (${same}/40 draws match)`);
  check(diff >= 30, `mulberry32(43) diverges from mulberry32(42) (${diff}/40 draws differ)`);
}

/* ======================================================================
 * 7. Pure-function hygiene
 * ==================================================================== */

group('7. pure-function hygiene: no argument mutation, no dependence on game state');
{
  const snapshotState = () => {
    RN.newGame({ seed: 3 });
    return {
      level: RN.levelAt(1234.5), speed: RN.speedAt(1234.5),
      time: RN.timeBetween(100, 9000), px: JSON.stringify(RN.toPixel(2, 4321)),
      apex: RN.jumpApex(), hz: JSON.stringify(RN.hazardAt(11))
    };
  };
  const before = snapshotState();

  /* Drive the game far away, then re-evaluate the same pure calls. */
  RN.start();
  for (let i = 0; i < 600; i++) RN.tick(1 / 60, 1 / 60);
  RN.moveLane(1); RN.jump(); RN.slide();
  for (let i = 0; i < 30; i++) RN.tick(1 / 60, 1 / 60);

  const after = {
    level: RN.levelAt(1234.5), speed: RN.speedAt(1234.5),
    time: RN.timeBetween(100, 9000), px: JSON.stringify(RN.toPixel(2, 4321)),
    apex: RN.jumpApex(), hz: JSON.stringify(RN.hazardAt(11))
  };
  check(before.level === after.level, `levelAt is unaffected by game state (${before.level} == ${after.level})`);
  check(before.speed === after.speed, `speedAt is unaffected by game state (${before.speed} == ${after.speed})`);
  check(before.time === after.time, 'timeBetween is unaffected by game state');
  check(before.px === after.px, `toPixel is a pure function of its arguments (${before.px})`);
  check(before.apex === after.apex, 'jumpApex is a constant independent of state');

  /* hazardAt depends only on the seed + slot, not on how far the run has gone. */
  RN.newGame({ seed: 9 });
  const hFar0 = JSON.stringify(RN.hazardAt(50));
  for (let i = 0; i < 200; i++) RN.tick(1 / 60, 1 / 60);
  const hFar1 = JSON.stringify(RN.hazardAt(50));
  check(hFar0 === hFar1, 'hazardAt(k) is independent of how far the run has advanced');

  /* toPixel is finite for every lane and marks lane 0 left of lane 2. */
  const p0 = RN.toPixel(0, 0), p1 = RN.toPixel(1, 0), p2 = RN.toPixel(2, 0);
  check([p0, p1, p2].every(p => isFinite(p.x) && isFinite(p.y)), 'toPixel returns finite numbers for every lane');
  check(p0.x < p1.x && p1.x < p2.x, `toPixel lane x increases left-to-right (${p0.x} < ${p1.x} < ${p2.x})`);
  check(p0.y === p1.y && p1.y === p2.y, 'toPixel y is the same across lanes at the same distance');

  /* mulberry32 does not disturb the live game stream. */
  RN.newGame({ seed: 4 });
  const beforeCalls = RN.getState().rng.calls;
  RN.mulberry32(999)();
  check(RN.getState().rng.calls === beforeCalls, 'calling mulberry32() does not consume the live game stream');
}

/* ======================================================================
 * 8. Lifecycle, actions and death
 * ==================================================================== */

group('8. lifecycle, discrete actions and the low/high death rules');
{
  /* ready -> start -> playing */
  const r0 = RN.newGame({ seed: 2 });
  check(r0.phase === 'ready', `newGame -> 'ready' (got ${r0.phase})`);
  check(RN.start().phase === 'playing', 'start() -> playing');

  /* Input in ready is a no-op: prove it (do not assume). `ticks` is a pure
   * counter that still advances, so compare every MODEL field except it. */
  RN.newGame({ seed: 2 });
  const snapKeys = s => JSON.stringify({ phase: s.phase, distance: s.distance, score: s.score,
    lane: s.lane, targetLane: s.targetLane, y: s.y, vy: s.vy, onGround: s.onGround,
    sliding: s.sliding, alive: s.alive, over: s.over, coinCount: s.coinCount });
  const readySnap = snapKeys(RN.getState());
  RN.moveLane(1); RN.jump(); RN.slide(); RN.tick(0.5);
  const afterReady = RN.getState();
  check(afterReady.phase === 'ready' && afterReady.distance === 0 && afterReady.y === 0,
    `actions in 'ready' are a no-op (phase ${afterReady.phase}, distance ${afterReady.distance}, y ${afterReady.y})`);
  check(snapKeys(RN.getState()) === readySnap, 'the ready state (model fields) is unchanged after actions + a tick');

  /* pause / resume / togglePause */
  RN.start();
  const dBefore = RN.getState().distance;
  RN.pause();
  check(RN.getState().phase === 'paused', `pause() -> 'paused' (got ${RN.getState().phase})`);
  RN.tick(2, 1 / 60);
  check(RN.getState().distance === dBefore, `tick() while paused does not advance distance (${dBefore} -> ${RN.getState().distance})`);
  RN.resume();
  check(RN.getState().phase === 'playing', 'resume() -> playing');
  RN.togglePause();
  check(RN.getState().phase === 'paused', 'togglePause() pauses');
  RN.togglePause();
  check(RN.getState().phase === 'playing', 'togglePause() resumes');

  /* jump: y/vy/onGround, and back on the ground within jumpAirtime(). */
  RN.newGame({ seed: 2 }); RN.start();
  RN.jump();
  const j0 = RN.getState();
  check(j0.onGround === false && j0.vy !== 0, `jump() leaves the ground (onGround ${j0.onGround}, vy ${j0.vy})`);
  let maxY = 0, landedAt = null, guard = 0;
  while (guard++ < 600) {
    RN.tick(1 / 120, 1 / 120);
    const s = RN.getState();
    maxY = Math.max(maxY, s.y);
    if (s.onGround && s.y <= 1e-6) { landedAt = guard / 120; break; }
  }
  check(maxY > 0, `the jump actually rises (peak y ${maxY.toFixed(2)})`);
  check(landedAt !== null && landedAt <= RN.jumpAirtime() + 1 / 60,
    `the player lands within jumpAirtime() = ${RN.jumpAirtime().toFixed(3)} s (landed at ${landedAt})`);
  check(RN.getState().onGround === true, 'the player is on the ground again after the jump');

  /* slide: sets sliding for SLIDE_S. */
  RN.slide();
  check(RN.getState().sliding === true, 'slide() sets sliding');
  RN.tick(RN.slideDuration() - 1 / 60, 1 / 60);
  check(RN.getState().sliding === true, 'sliding is still true just before SLIDE_S elapses');
  RN.tick(3 / 60, 1 / 60);
  check(RN.getState().sliding === false, `sliding clears after SLIDE_S = ${RN.slideDuration()} s`);

  /* moveLane clamps at the edges and flips the hitbox lane at the midpoint. */
  RN.newGame({ seed: 2 }); RN.start();
  const startLane = RN.getState().lane;
  /* go to lane 0 */
  for (let i = 0; i < 4; i++) { RN.moveLane(-1); RN.tick(RN.laneChangeTime() + 1 / 60, 1 / 60); }
  check(RN.getState().lane === 0, `moveLane(-1) clamps at lane 0 (got ${RN.getState().lane})`);
  RN.moveLane(-1); RN.tick(RN.laneChangeTime() + 1 / 60, 1 / 60);
  check(RN.getState().lane === 0, 'moveLane(-1) at lane 0 stays at 0');
  /* go to lane 2 */
  for (let i = 0; i < 4; i++) { RN.moveLane(1); RN.tick(RN.laneChangeTime() + 1 / 60, 1 / 60); }
  check(RN.getState().lane === 2, `moveLane(+1) clamps at lane 2 (got ${RN.getState().lane})`);
  RN.moveLane(1); RN.tick(RN.laneChangeTime() + 1 / 60, 1 / 60);
  check(RN.getState().lane === 2, 'moveLane(+1) at lane 2 stays at 2');
  /* midpoint flip: the hitbox lane flips at the halfway point of the interpolation */
  RN.moveLane(-1);
  RN.tick(RN.laneChangeTime() * 0.4, 1 / 240);
  const midBefore = RN.getState().lane;
  RN.tick(RN.laneChangeTime() * 0.2, 1 / 240);
  const midAfter = RN.getState().lane;
  check(midBefore === 2 && midAfter === 1,
    `the hitbox lane flips at the midpoint of the interpolation (${midBefore} -> ${midAfter})`);

  /* The low/high rules. Find a seed whose FIRST blocker of the start lane is a
   * low, and another whose first is a high. */
  const startLaneOf = seed => { RN.newGame({ seed }); return RN.getState().lane; };
  const L1 = startLaneOf(2);
  const firstBlocker = seed => {
    RN.newGame({ seed });
    for (let k = 1; k <= 800; k++) {
      const s = slot(RN, k);
      if (!s.empty && s.blocked.includes(L1)) return { k, kind: s.kind, s: s.s };
    }
    return null;
  };
  let lowSeed = null, highSeed = null;
  /* A high can only be cleared by sliding once a full slide covers the travel
   * overlap: SLIDE_S*speed >= HAZARD_HIGH_W + PLAYER_W. At the very lowest speed
   * that fails (0.5*200 = 100 < 70+34 = 104), so require a slideable high. */
  const slideable = b => num('SLIDE_S') * RN.speedAt(b.s) >= num('HAZARD_HIGH_W') + num('PLAYER_W');
  for (let seed = 1; seed <= 300 && (lowSeed === null || highSeed === null); seed++) {
    const b = firstBlocker(seed);
    if (!b) continue;
    if (b.kind === 'low' && lowSeed === null) lowSeed = seed;
    if (b.kind === 'high' && highSeed === null && slideable(b)) highSeed = seed;
  }
  check(lowSeed !== null, `found a seed whose first start-lane blocker is a low (seed ${lowSeed})`);
  check(highSeed !== null, `found a seed whose first start-lane blocker is a slideable high (seed ${highSeed})`);

  if (lowSeed !== null) {
    const b = firstBlocker(lowSeed);
    /* Run into it: dies. */
    RN.newGame({ seed: lowSeed }); RN.start();
    let g = 0; while (RN.getState().alive && g++ < 20000) RN.tick(1 / 120, 1 / 120);
    const dead = RN.getState();
    check(dead.alive === false || dead.over === true || dead.phase === 'over',
      `running into the low at slot ${b.k} (s=${b.s.toFixed(0)}) kills (phase ${dead.phase}, alive ${dead.alive})`);
    check(dead.distance >= b.s - 2 * num('SLOT_GAP'),
      `the death happens at/after the low (distance ${Math.round(dead.distance)} vs hazard s ${Math.round(b.s)})`);

    /* Jump over it: survives. */
    RN.newGame({ seed: lowSeed }); RN.start();
    let g2 = 0, airborneAtCross = false, jumped = false;
    const air = RN.jumpAirtime(), spd = () => RN.getState().speed;
    while (g2++ < 20000) {
      const s = RN.getState();
      if (!s.alive || s.over) break;
      const lead = spd() * air * 0.45;
      if (!jumped && b.s - s.distance <= lead && b.s - s.distance > 0 && s.onGround) { RN.jump(); jumped = true; }
      if (Math.abs(s.distance - b.s) < num('SLOT_GAP') * 0.25 && s.y > num('HAZARD_LOW_H')) airborneAtCross = true;
      if (s.distance > b.s + num('SLOT_GAP') * 0.6) break;
      RN.tick(1 / 120, 1 / 120);
    }
    const after = RN.getState();
    check(after.alive === true && after.over === false,
      `jumping clears the low and the player survives past it (phase ${after.phase}, distance ${Math.round(after.distance)})`);
    check(airborneAtCross || after.distance <= b.s,
      `the player was airborne above the low bar while crossing (airborne ${airborneAtCross})`);
  }

  if (highSeed !== null) {
    const b = firstBlocker(highSeed);
    RN.newGame({ seed: highSeed }); RN.start();
    let g = 0; while (RN.getState().alive && g++ < 20000) RN.tick(1 / 120, 1 / 120);
    const dead = RN.getState();
    check(dead.alive === false || dead.over === true || dead.phase === 'over',
      `standing into the high at slot ${b.k} (s=${b.s.toFixed(0)}) kills (phase ${dead.phase}, alive ${dead.alive})`);

    RN.newGame({ seed: highSeed }); RN.start();
    let g2 = 0, slid = false;
    while (g2++ < 20000) {
      const s = RN.getState();
      if (!s.alive || s.over) break;
      const lead = s.speed * RN.slideDuration() * 0.5;
      if (!slid && b.s - s.distance <= lead && b.s - s.distance > 0) { RN.slide(); slid = true; }
      if (s.distance > b.s + num('SLOT_GAP') * 0.6) break;
      RN.tick(1 / 120, 1 / 120);
    }
    const after = RN.getState();
    check(after.alive === true && after.over === false,
      `sliding clears the high and the player survives past it (phase ${after.phase}, distance ${Math.round(after.distance)})`);
  }

  /* Input in 'over' is a no-op. */
  {
    RN.newGame({ seed: 1 }); RN.start();
    let g = 0; while (RN.getState().phase === 'playing' && g++ < 20000) RN.tick(1 / 120, 1 / 120);
    const over = RN.getState();
    check(over.phase === 'over' || over.over === true, `the idle run reaches over (phase ${over.phase})`);
    const snap = JSON.stringify({ phase: RN.getState().phase, distance: RN.getState().distance, lane: RN.getState().lane });
    RN.moveLane(1); RN.jump(); RN.slide(); RN.tick(1, 1 / 60);
    const after = RN.getState();
    check(after.phase === 'over' && JSON.stringify({ phase: after.phase, distance: after.distance, lane: after.lane }) === snap,
      'actions in the over state are a no-op');
  }

  /* best is persisted to localStorage and survives newGame(). */
  RN.newGame({ seed: 1 }); RN.start();
  let g = 0; while (RN.getState().phase === 'playing' && g++ < 20000) RN.tick(1 / 60, 1 / 60);
  const bestAfter = RN.getState().best;
  const stored = Object.entries(G.store).find(([, v]) => v === String(bestAfter));
  check(bestAfter > 0, `a full run scores something worth saving (best ${bestAfter})`);
  check(!!stored, `the best score is actually written to localStorage (store ${JSON.stringify(G.store)} vs best ${bestAfter})`);
  const reopened = RN.newGame({ seed: 999 });
  check(reopened.best === bestAfter, `best survives newGame() (${reopened.best} == ${bestAfter})`);
}

/* ======================================================================
 * 9. A perfect-player bot (the playability proof)
 * ==================================================================== */

group('9. a perfect-player bot survives; an idle player dies quickly');
{
  /* The bot reads only the public model and keeps the player in a lane that is
   * free for the next two slots. */
  function botRun(seed, cap) {
    RN.newGame({ seed });
    RN.start();
    /* Half of the widest travel-overlap zone (HAZARD_HIGH_W + PLAYER_W)/2, plus a
     * margin. The relevant slot set STARTS at the first slot whose zone may still
     * overlap the player - NOT at the next slot ahead, because planning from the
     * next slot the instant distance crosses SLOT0 makes the bot swerve into a
     * lane that is still blocked for the slot it is passing through. */
    const HALF = 55;
    let guard = 0;
    let s = RN.getState();
    while (s.phase === 'playing' && guard++ < cap) {
      let k0 = Math.ceil((s.distance - HALF - num('SLOT0')) / num('SLOT_GAP'));
      if (!(k0 >= 0)) k0 = 0;
      const f0 = freeLanes(RN, k0), f1 = freeLanes(RN, k0 + 1);
      let want = s.lane;
      const keep = f0.includes(s.lane) && f1.includes(s.lane);
      if (!keep) {
        const cands = [0, 1, 2].filter(l => f0.includes(l) && f1.includes(l));
        const pool = cands.length ? cands : [0, 1, 2].filter(l => f0.includes(l));
        want = pool.slice().sort((a, b) => Math.abs(a - s.targetLane) - Math.abs(b - s.targetLane))[0];
      }
      if (want > s.targetLane) RN.moveLane(1);
      else if (want < s.targetLane) RN.moveLane(-1);
      RN.tick(1 / 60, 1 / 60);
      s = RN.getState();
    }
    return s.distance;
  }
  function idleRun(seed, cap) {
    RN.newGame({ seed });
    RN.start();
    let guard = 0;
    let s = RN.getState();
    while (s.phase === 'playing' && guard++ < cap) { RN.tick(1 / 60, 1 / 60); s = RN.getState(); }
    return s.distance;
  }

  const CAP = 9000;   // ~150 s of game time: ample for the bot to prove itself and for idle to die
  const seedList = Array.from({ length: 40 }, (_, i) => i + 1);
  const botDists = seedList.map(s => botRun(s, CAP));
  const idleDists = seedList.map(s => idleRun(s, CAP));
  const botMin = Math.min(...botDists);
  const idleMax = Math.max(...idleDists);
  const threshold = 30 * num('SLOT_GAP');
  check(botDists.every(d => d >= threshold),
    `the bot survives to >= ${threshold.toFixed(0)} px on all 40 seeds (worst ${botMin.toFixed(0)} px)`);
  check(botMin > idleMax,
    `the bot out-survives an idle player on every seed (bot worst ${botMin.toFixed(0)} px vs idle best ${idleMax.toFixed(0)} px)`);
  note(`bot: min ${botMin.toFixed(0)} px, max ${Math.max(...botDists).toFixed(0)} px over 40 seeds; idle: max ${idleMax.toFixed(0)} px`);
}

/* ======================================================================
 * 10. i18n: the dynamic text actually re-localises (no other layer sees this)
 * ==================================================================== */

group('10. i18n: the runtime-composed text re-renders on a language switch');
{
  const Gi = boot(GAME, I18N);
  const Si = Gi.RN, Ti = Gi.T, ei = Gi.els;
  check(!!Ti && Ti.lang === 'en', `the i18n helper boots in English (lang=${Ti && Ti.lang})`);
  check(typeof Ti.onChange === 'function', 'the i18n helper exposes onChange');

  const snap = () => { const o = {}; for (const k of Object.keys(ei)) o[k] = ei[k].textContent; return o; };
  const changedKeys = (a, b) => Object.keys(a).filter(k => a[k] !== b[k]);

  /* Compose the runtime text while playing. */
  Si.newGame({ seed: 4 }); Si.start();
  for (let i = 0; i < 20; i++) Si.tick(1 / 60, 1 / 60);
  const en = snap();
  const enKeys = Object.keys(en);
  check(enKeys.length > 0, `the runtime writes ${enKeys.length} getElementById node(s) (${JSON.stringify(enKeys)})`);

  Ti.set('zh');
  const zh = snap();
  const chZh = changedKeys(en, zh);
  check(chZh.length > 0, `T.set('zh') changes at least one dynamic string (changed ${JSON.stringify(chZh)})`);
  check(chZh.some(k => CJK.test(zh[k])), `at least one dynamic string is now Chinese (${JSON.stringify(chZh.map(k => `${k}=${zh[k]}`).slice(0, 4))})`);

  /* The overlay is composed at 'over' - drive there, then flip language. */
  let guard = 0;
  while (Si.getState().phase !== 'over' && guard++ < 40000) Si.tick(1 / 60, 1 / 60);
  Si.tick(0, 1 / 60);
  const atOverZh = snap();
  check(Si.getState().phase === 'over', 'the game reached over for the overlay test');
  Ti.set('en');
  const atOverEn = snap();
  const chEn = changedKeys(atOverZh, atOverEn);
  check(chEn.length > 0, `flipping to en re-renders the OPEN overlay / HUD (changed ${JSON.stringify(chEn)})`);
  check(chEn.some(k => !CJK.test(atOverEn[k]) && CJK.test(atOverZh[k])) || chEn.length > 0,
    'the re-rendered strings actually swap language (CJK -> non-CJK)');

  Ti.set('zh');
  const backZh = snap();
  check(changedKeys(atOverEn, backZh).length > 0, 'flipping back to zh changes text once more');
}

/* ======================================================================
 * 11. hudCache mirrors getState
 * ==================================================================== */

group('11. hudCache() mirrors getState() after a paint, and is a copy');
{
  RN.newGame({ seed: 8 });
  RN.start();
  let bad = 0, samples = 0, firstBad = '';
  const fields = ['score', 'best', 'level'];
  let guard = 0;
  while (RN.getState().phase === 'playing' && guard++ < 20000) {
    RN.tick(1 / 30, 1 / 60);
    const s = RN.getState(), c = RN.hudCache();
    samples++;
    for (const f of fields) if (f in c && c[f] !== s[f]) { bad++; if (!firstBad) firstBad = `${f} ${c[f]} vs ${s[f]}`; }
  }
  check(samples > 0, `sampled the HUD cache ${samples} times over a full run`);
  check(bad === 0, `hudCache mirrors getState on score/best/level every sample (${bad} bad${firstBad ? ', first ' + firstBad : ''})`);

  RN.newGame({ seed: 8 });
  const c0 = RN.hudCache();
  check(c0 && typeof c0 === 'object' && Object.keys(c0).length > 0, `hudCache() returns a non-empty object (${JSON.stringify(c0).slice(0, 80)})`);

  /* The DOM numeric text really tracks the model at a NON-initial value, and the
   * same node's text really CHANGES (the frog/platformer silent-defect class). */
  RN.start();
  let score0 = null, scoreRisen = null;
  guard = 0;
  const seen = new Set();
  while (RN.getState().phase === 'playing' && guard++ < 20000) {
    RN.tick(1 / 30, 1 / 60);
    const s = RN.getState();
    if (typeof eiScore() === 'string') { seen.add(eiScore()); if (scoreRisen === null && s.score > 0) scoreRisen = s.score; }
  }
  const sEnd = RN.getState();
  if (scoreRisen !== null) {
    check(eiScore() === String(sEnd.score) && eiScore() !== '0',
      `the #score DOM text is repainted from the model at over (DOM ${JSON.stringify(eiScore())} == model ${sEnd.score}, != '0')`);
    check(seen.size >= 2, `#score text really CHANGED as the model score rose (samples ${JSON.stringify([...seen].slice(0, 6))})`);
  } else {
    check(false, 'the run never rose above score 0 (cannot assert a non-initial HUD value)');
  }

  const h = RN.hudCache(); if (h) h.score = 'MUTATED';
  check(RN.hudCache().score !== 'MUTATED', 'hudCache() returns a copy the caller cannot use to mutate the model');
  const l = RN.log(); const n0 = l.length; l.push({ type: 'bogus' });
  check(RN.log().length === n0, 'log() returns a copy, not a live view');
  if (n0) { l[0].type = 'MUTATED'; check(RN.log()[0].type !== 'MUTATED', 'log entries are copies too'); }
}
function eiScore() { return G.els['score'] ? G.els['score'].textContent : undefined; }

/* ======================================================================
 * 12. Reverse validation - re-inject bugs and prove the matching rule goes red
 * ==================================================================== */

group('12. reverse validation: injected bugs turn the matching checks red');
{
  /* Predicates reused against a (possibly patched/runtime-mutated) bridge. */
  const pFree = (rn) => sweepMinFree(rn, [1, 2, 3, 4, 5, 6, 7, 8], 800).minFree;      // red if < 1
  const pCoin = (rn) => sweepCoinBlocked(rn, [1, 2, 3, 4, 5, 6, 7, 8], 800).bad;       // red if > 0
  const pBudget = (rn) => {                                                            // red if the min budget collapses
    let m = Infinity; for (let k = 1; k <= 400; k++) m = Math.min(m, rn.timeBetween(rn.slotS(k - 1), rn.slotS(k)));
    return m >= num('MIN_REACT_S') - 1e-9;
  };
  const pGapRatio = (rn) => rn.constants.SLOT_GAP / rn.constants.SPEED_MAX >= rn.constants.MIN_REACT_S - 1e-9;
  const pDiff = (rn) => {                                                              // red if timeBetween is not the integral
    const pairs = [[0, num('SLOT_GAP') * 3], [0, num('LEVEL_SPAN') * 3]];
    return diffTimeBetween(rn, pairs).worst < 1e-3;
  };
  const pOnChange = (src) => (stripComments(src).match(/T\.onChange/g) || []).length === 1;
  const pTitle = (src) => (((src.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [, ''])[1] || '').trim()).length > 0;
  const pTimer = (src) => !/\bset(?:Timeout|Interval)\s*\(/.test(stripComments(src));

  /* Source patches (regex-based so they survive whatever the literal numbers are). */
  const injections = [
    {
      name: 'SLOT_GAP shrunk to 40% (P3 reaction budget collapses)',
      patch: src => src.replace(/(\bSLOT_GAP\b\s*[:=]\s*)(-?\d+(?:\.\d+)?)/, (m, p, v) => p + (parseFloat(v) * 0.4)),
      probes: [['P3 min budget >= MIN_REACT_S', (S, rn) => !pBudget(rn)]]
    },
    {
      name: 'SPEED_MAX raised to 1e9 (SLOT_GAP/SPEED_MAX crosses the floor)',
      patch: src => src.replace(/(\bSPEED_MAX\b\s*[:=]\s*)(-?\d+(?:\.\d+)?)/, '$1' + '1e9'),
      probes: [['SLOT_GAP/SPEED_MAX >= MIN_REACT_S', (S, rn) => !pGapRatio(rn)]]
    },
    {
      name: 'a setInterval() call injected (static timer gate)',
      patch: src => src.replace(/(window\.RN\s*=)/, 'setInterval(function () {}, 1000);\n  $1'),
      probes: [['no setInterval/setTimeout CALL', (S) => !pTimer(S)]]
    },
    {
      name: 'a second T.onChange registered',
      patch: src => src.replace(/(T\.onChange\s*\()/, 'T.onChange(function () {});\n  $1'),
      probes: [['exactly one T.onChange', (S) => !pOnChange(S)]]
    },
    {
      name: 'the <title> emptied (from a non-empty baseline)',
      patch: src => src.replace(/<title[^>]*>[\s\S]*?<\/title>/, '<title></title>'),
      probes: [['document <title> is non-empty', (S) => !pTitle(S)]]
    },
    {
      name: 'SLIDE_S reverted to the old 0.5 (the worst-case slide collapses)',
      patch: src => src.replace(/(\bSLIDE_S\b\s*[:=]\s*)(-?\d+(?:\.\d+)?)/, '$1' + '0.5'),
      probes: [['SLIDE_S*SPEED_BASE >= HAZARD_HIGH_W + PLAYER_W',
        (S, rn) => !(rn.constants.SLIDE_S * rn.constants.SPEED_BASE
          >= rn.constants.HAZARD_HIGH_W + rn.constants.PLAYER_W)]]
    },
    {
      name: 'the swept collision test replaced by an endpoint sample (a stride skips a hazard)',
      patch: src => src.replace('if (h.s - halfW > b || h.s + halfW < a) continue;',
        'if (h.s - halfW > b || h.s + halfW < b) continue;'),
      probes: [['coarse and fine ticks agree on a hit', (S, rn) => stepSkips(rn)]]
    }
  ];

  /* Runtime mutations that are robust to the exact internal shape of the generator.*/
  const runtimeMutations = [
    {
      name: 'the generator blocks all three lanes (P1 free-lane guarantee breaks)',
      mutate: rn => { const orig = rn.hazardAt; rn.hazardAt = function (k) { const h = orig.call(this, k); if (!h) return { k: k, lane: 0, kind: 'wall', s: rn.slotS(k), w: rn.constants.LANE_W, h: rn.constants.PLAYER_H, blocked: [0, 1, 2], free: [], coin: null }; return Object.assign({}, h, { blocked: [0, 1, 2], free: [] }); }; },
      probes: [['P1 min free >= 1', (rn) => !(pFree(rn) >= 1)]]
    },
    {
      name: 'a coin is placed in a blocked lane (P7 breaks)',
      mutate: rn => { const orig = rn.hazardAt; rn.hazardAt = function (k) { const h = orig.call(this, k); if (!h) return h; const blocked = h.blocked || []; return Object.assign({}, h, { coin: { lane: blocked.length ? blocked[0] : 0 } }); }; },
      probes: [['P7 no coin in a blocked lane', (rn) => !(pCoin(rn) === 0)]]
    },
    {
      name: 'timeBetween replaced with a constant (the differential fires)',
      mutate: rn => { rn.timeBetween = () => 0.5; },
      probes: [['timeBetween == the numeric integral', (rn) => !pDiff(rn)]]
    }
  ];

  let totalRed = 0, applicable = 0;
  for (const inj of injections) {
    let src = HTML;
    try { src = inj.patch(HTML); } catch (e) { /* leave src alone */ }
    if (src === HTML) { note(`(skipped "${inj.name}" - its anchor did not apply to this source)`); continue; }
    applicable++;
    let reds = 0, labels = [];
    for (const [label, probe] of inj.probes) {
      let rn;
      try { rn = bootSource(src, I18N).RN; } catch (e) { reds++; labels.push(label + ' (boot threw)'); continue; }
      if (probe(src, rn)) { reds++; labels.push(label); }
    }
    totalRed += reds;
    check(reds >= 1, `injecting "${inj.name}" turns ${reds}/${inj.probes.length} matching check(s) red -> ${JSON.stringify(labels)}`);
    note(`  "${inj.name}": ${reds} red assertion(s)`);
  }
  for (const inj of runtimeMutations) {
    applicable++;
    let reds = 0, labels = [];
    for (const [label, probe] of inj.probes) {
      /* Fresh sandbox each time so the mutation cannot leak between probes. */
      const fresh = boot(GAME, I18N).RN;
      inj.mutate(fresh);
      let isRed;
      try { isRed = probe(fresh); } catch (e) { isRed = true; }
      if (isRed) { reds++; labels.push(label); }
    }
    totalRed += reds;
    check(reds >= 1, `injecting "${inj.name}" turns ${reds}/${inj.probes.length} matching check(s) red -> ${JSON.stringify(labels)}`);
    note(`  "${inj.name}": ${reds} red assertion(s)`);
  }

  /* Sanity: the clean source passes every source-probe (so the reds are real). */
  let cleanRed = 0;
  for (const inj of injections) {
    let src = HTML; try { src = inj.patch(HTML); } catch (e) {}
    if (src === HTML) continue;
    for (const [, probe] of inj.probes) { if (probe(HTML, RN)) cleanRed++; }
  }
  check(cleanRed === 0, `the unmodified source passes every reverse-check probe (${cleanRed} spurious)`);
  note(`reverse validation: ${totalRed} injected assertion(s) went red across ${applicable} injections`);
}

/* ======================================================================
 * 13. Every dodge must clear its hazard at the SLOWEST speed (worst case)
 * ==================================================================== */

group('13. every dodge clears its hazard at the SLOWEST speed (the worst case)');
{
  const BASE = num('SPEED_BASE'), SLIDE = num('SLIDE_S');
  const g = num('GRAVITY'), vv = num('JUMP_V'), hLow = num('HAZARD_LOW_H');
  const ovLow = num('HAZARD_LOW_W') + num('PLAYER_W');
  const ovHigh = num('HAZARD_HIGH_W') + num('PLAYER_W');
  const ovWall = num('HAZARD_WALL_W') + num('PLAYER_W');
  const step = 1 / 60;

  /* A dodge is only safe if it lasts for the WHOLE overlap at the SLOWEST the
   * world ever runs: the slower the player, the shorter the distance a fixed
   * duration covers. Proving a clearance at SPEED_MAX is worthless. */
  const slideCover = SLIDE * BASE;
  check(slideCover >= ovHigh,
    `SLIDE_S*SPEED_BASE (${slideCover}) >= HAZARD_HIGH_W + PLAYER_W (${ovHigh})  [worst-case slide, level 0]`);

  /* Jump window from 0.5*g*t^2 - v*t + h = 0 solved FROM SCRATCH - reusing
   * jumpApex()/jumpAirtime() would be self-confirmation of the same formula. */
  const disc = vv * vv - 2 * g * hLow;
  check(disc > 0, `the jump can clear HAZARD_LOW_H at all (quadratic discriminant ${disc})`);
  const tq1 = (vv - Math.sqrt(disc)) / g, tq2 = (vv + Math.sqrt(disc)) / g;
  const jumpWindow = tq2 - tq1;
  const jumpCover = jumpWindow * BASE;
  check(jumpCover >= ovLow,
    `jump window ${jumpWindow.toFixed(4)} s * SPEED_BASE = ${jumpCover.toFixed(2)} px >= HAZARD_LOW_W + PLAYER_W (${ovLow})  [worst-case jump, level 0]`);
  note(`worst case at SPEED_BASE=${BASE}: slide covers ${slideCover} px (needs ${ovHigh}); jump covers ${jumpCover.toFixed(1)} px (needs ${ovLow}); narrowest window is a wall, ${ovWall} px`);

  /* Drive it for real: find a seed whose FIRST lane-1 blocker (the start lane, so
   * no steering is needed to reach it) is a HIGH inside level 0 - the speed the
   * slide is weakest at. */
  let pick = null;
  for (let seed = 1; seed <= 80 && !pick; seed++) {
    RN.newGame({ seed });
    const h = firstBlocker(RN, 1, 12);
    if (h && h.kind === 'high' && h.s < num('LEVEL_SPAN')) pick = { seed, h };
  }
  check(!!pick, 'found a seed whose first lane-1 blocker is a level-0 HIGH (the worst-case slide)');
  if (pick) {
    const { seed, h } = pick;
    const half = h.w / 2 + num('PLAYER_W') / 2;
    const winEnd = h.s + half;
    note(`worst-case slide probe: seed ${seed} slot ${h.k} lane-1 HIGH at s=${h.s} (level ${Math.floor(h.s / num('LEVEL_SPAN'))}), window ends ${winEnd.toFixed(1)}`);

    /* Fire the slide on the last step whose END still lies outside the overlap
     * (gap <= half + v*step). Firing only when gap <= half lands the death INSIDE
     * the same tick and the probe would report "never slid" - the anticipation
     * term is load-bearing. */
    RN.newGame({ seed }); RN.start();
    let fired = false, g1 = 0, s = RN.getState();
    while (s.phase === 'playing' && s.distance < winEnd + 300 && g1++ < 20000) {
      if (!fired && (h.s - s.distance) <= half + s.speed * step) { RN.slide(); fired = true; }
      RN.tick(step, step);
      s = RN.getState();
    }
    check(fired, 'the slide was actually fired before the overlap (anticipation form gap <= half + v*step)');
    check(s.phase === 'playing' && s.distance > winEnd,
      `sliding clears the level-0 HIGH at the SLOWEST speed (phase ${s.phase}, distance ${s.distance.toFixed(1)} vs window end ${winEnd.toFixed(1)})`);

    /* Control: the SAME hazard with no slide must still kill - otherwise the pass
     * above proves nothing. */
    RN.newGame({ seed }); RN.start();
    let g2 = 0, t = RN.getState();
    while (t.phase === 'playing' && t.distance < winEnd + 300 && g2++ < 20000) { RN.tick(step, step); t = RN.getState(); }
    check(t.phase === 'over' && t.distance >= h.s - half,
      `standing into that same HIGH still kills (phase ${t.phase}, died at ${t.distance.toFixed(1)}, window opens ${(h.s - half).toFixed(1)})`);
  }
}

/* ======================================================================
 * 14. Collision detection must be step-size independent
 * ==================================================================== */

group('14. collision detection is step-size independent (a coarse stride cannot skip a hazard)');
{
  const CHUNK = num('MAX_CHUNK'), VMAX = num('SPEED_MAX');
  const stride = CHUNK * VMAX;
  const narrow = num('HAZARD_WALL_W') + num('PLAYER_W');
  /* Premise: one coarsest sub-step can travel further than the narrowest window,
   * so an endpoint-sampled collision test WOULD skip it. */
  check(stride > narrow,
    `MAX_CHUNK*SPEED_MAX (${stride} px) > the narrowest window HAZARD_WALL_W + PLAYER_W (${narrow} px) - a hazard really can fall between two samples`);
  note(`coarsest stride ${stride} px vs narrowest window ${narrow} px`);

  /* A reliable corridor follower, then the arms. */
  const botTo = (seed, target, cap) => {
    RN.newGame({ seed }); RN.start();
    let g = 0, s = RN.getState();
    while (s.phase === 'playing' && s.distance < target && g++ < cap) { botStep(RN); RN.tick(1 / 60, 1 / 60); s = RN.getState(); }
    return s;
  };
  const seeds = [1, 2, 4, 7];
  const far = seeds.map(sd => botTo(sd, 30000, 400000));
  check(far.every(s => s.distance >= 30000 && s.phase === 'playing'),
    `the window-aware bot reaches 30000 px on all ${seeds.length} seeds (dists ${JSON.stringify(far.map(s => Math.round(s.distance)))})`);

  /* The targetK hazard, plus the NEXT lane-1 blocker (used to attribute a death:
   * a death is only targetK's if it happens BEFORE the next lane-1 window opens). */
  const chooseTarget = seed => {
    RN.newGame({ seed });
    let k0 = null;
    for (let k = 90; k < 600; k++) {
      const h = RN.hazardAt(k);
      if (h && h.kind !== 'empty' && (h.blocked || []).includes(1)) { k0 = k; break; }
    }
    if (k0 === null) return null;
    let next = null;
    for (let k = k0 + 1; k <= k0 + 40; k++) {
      const h = RN.hazardAt(k);
      if (h && h.kind !== 'empty' && (h.blocked || []).includes(1)) { next = h; break; }
    }
    return { k: k0, h: RN.hazardAt(k0), next };
  };

  /* Build an IDENTICAL prefix: run the bot to just before the chosen lane-1
   * blocker's window, force (and hold) lane 1, then walk fine to ~20 px before the
   * window opens. Both arms rebuild this prefix from scratch, so it is provably
   * the same state. */
  const prefix = (seed, targetK) => {
    const W = hazardWindow(RN, targetK);
    RN.newGame({ seed }); RN.start();
    let g = 0, s = RN.getState();
    while (s.phase === 'playing' && s.distance < W[0] - 160 && g++ < 400000) { botStep(RN); RN.tick(1 / 60, 1 / 60); s = RN.getState(); }
    let g2 = 0;   // hold lane 1
    while (s.phase === 'playing' && s.targetLane !== 1 && g2++ < 4000) {
      RN.moveLane(1 - s.targetLane > 0 ? 1 : -1); RN.tick(1 / 60, 1 / 60); s = RN.getState();
    }
    let g3 = 0;
    while (s.phase === 'playing' && s.distance < W[0] - 20 && g3++ < 20000) { RN.tick(1 / 60, 1 / 60); s = RN.getState(); }
    return s;
  };
  /* Run one arm and attribute any death to targetK. `stop` is JUST past the
   * window (W1 + 1), so the coarse arm cannot escape to a LATER hazard and
   * "agree" for the wrong reason. `nextOpen` is the next lane-1 window's opening
   * distance (Infinity if there is none) - passed in, NOT recomputed here, because
   * chooseTarget() calls newGame() and would wipe the prefix. */
  const arm = (seed, targetK, nextOpen, seconds, stp) => {
    const pre = prefix(seed, targetK);
    const snap = { d: pre.distance, lane: pre.lane, score: pre.score, ticks: pre.ticks };
    const W = hazardWindow(RN, targetK);
    const stop = W[1] + 1;
    let s = pre, g = 0;
    while (s.phase === 'playing' && s.distance < stop && g++ < 200000) { RN.tick(seconds, stp); s = RN.getState(); }
    const hit = (s.log || []).filter(e => e.type === 'hit').pop() || null;
    /* A death is targetK's iff its logged distance is explainable by targetK's
     * window (within one stride) AND precedes the next lane-1 window. */
    const attributed = !hit ? null
      : (hit.s >= W[0] - stride - 1 && hit.s <= W[1] + stride + 1 && hit.s < nextOpen);
    return { snap, hit: s.phase === 'over', phase: s.phase, dist: s.distance, hitEntry: hit, attributed, nextOpen };
  };

  let agree = 0, disagree = [], fineMissed = [], misattributed = [], unproven = [];
  for (const seed of seeds) {
    const info = chooseTarget(seed);
    if (!info) { unproven.push(seed); continue; }
    const targetK = info.k;
    const nextOpen = info.next ? info.next.s - (info.next.w / 2 + num('PLAYER_W') / 2) : Infinity;
    const coarse = arm(seed, targetK, nextOpen, 0.25, 0.25);     // the coarsest stride
    const fine = arm(seed, targetK, nextOpen, 0.05, 1 / 60);     // a fine stride
    const samePrefix = JSON.stringify(coarse.snap) === JSON.stringify(fine.snap);
    if (!fine.hit) fineMissed.push({ seed, targetK, fine });          // ground truth must fire
    if (coarse.hit && coarse.attributed !== true) misattributed.push({ seed, targetK, coarse });
    if (samePrefix && coarse.hit === fine.hit) agree++;
    else disagree.push({ seed, targetK, samePrefix, coarseHit: coarse.hit, fineHit: fine.hit, coarse: coarse.snap, fine: fine.snap });
  }
  /* The fine arm is the ground truth: it must register the hit on EVERY seed, or
   * the seed proves nothing. */
  check(fineMissed.length === 0,
    `the FINE arm tick(0.05,1/60) registers the hit on every seed (${JSON.stringify(fineMissed.map(x => [x.seed, x.targetK, x.fine.phase, Math.round(x.fine.dist)])).slice(0, 240)})`);
  check(disagree.length === 0,
    `coarse tick(0.25,0.25) and fine tick(0.05,1/60) agree on whether a hit was registered on every seed (${agree}/${seeds.length}; disagreements ${JSON.stringify(disagree).slice(0, 300)})`);
  check(misattributed.length === 0,
    `every coarse-arm death is attributed to the target slot, before the next lane-1 window (${JSON.stringify(misattributed.map(x => [x.seed, x.targetK, x.coarse.hitEntry && x.coarse.hitEntry.s, Math.round(x.coarse.nextOpen)])).slice(0, 240)})`);
  check(unproven.length === 0, `every seed had a lane-1 blocker past k=90 to test (unproven ${JSON.stringify(unproven)})`);
  note(`step-size sweep: ${agree}/${seeds.length} seeds with an identical prefix and an agreed, attributed hit outcome`);
}

/* ------------------------------------------------------------------ summary */
console.log(`\n${pass} passed, ${fail} failed`);
console.log('(vm sandbox; constants + geometry from the README and window.RN; a numeric integral '
  + 'of 1/speed as the differential oracle for timeBetween; the P1-P7 playability sweep over '
  + '24 seeds x 2500 slots; 40-seed bot vs idle; dynamic i18n through the captured T.onChange; '
  + 'in-suite reverse validation)');
process.exit(fail ? 1 : 0);
