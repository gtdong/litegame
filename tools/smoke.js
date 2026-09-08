#!/usr/bin/env node
/**
 * Headless smoke test for every game in this repo.
 *
 * `node --check` only proves the JavaScript parses; it cannot catch the class of
 * bug that makes a game dead on arrival (e.g. 2048's emptyGrid() built a flat
 * array, so grid[1] was null and the very first render threw).
 *
 * This script loads each `*-game/index.html` inside a tiny fake DOM, fires the
 * usual inputs (arrow keys, space, every button) and pumps animation frames,
 * then reports anything that threw.
 *
 * Usage:  node tools/smoke.js            # smoke-test every game
 *         node tools/smoke.js 2048       # only games whose folder matches
 *
 * Exit code 0 = no runtime errors, 1 = at least one game broke.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const I18N = path.join(ROOT, 'assets', 'i18n.js');

/* ------------------------------------------------------------------ fake DOM */

function makeContext() {
  const noop = () => ctxProxy;
  const ctxProxy = new Proxy({}, {
    get: (t, k) => (k in t ? t[k] : (t[k] = noop))
  });

  class Frag {
    constructor() { this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
  }

  class El {
    constructor(tag) {
      this.tag = tag || 'div';
      this.children = [];
      this.style = {};
      this.dataset = {};
      this.handlers = {};
      this.parent = null;
      this.clientWidth = 440;
      this.clientHeight = 440;
      this.width = 480;
      this.height = 480;
      this.value = '';
      this.checked = false;
      this.selectedOptions = [{ text: 'Normal' }];
      this._text = '';
      this._html = '';
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
    setAttribute() {}
    getAttribute() { return null; }
    getContext() { return ctxProxy; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 480, height: 480 }; }
    set textContent(v) { this._text = String(v); }
    get textContent() { return this._text; }
    set innerHTML(v) { if (v === '') this.children = []; this._html = String(v); }
    get innerHTML() { return this._html; }
  }

  const els = {};
  const docHandlers = {};
  const winHandlers = {};
  let frame = null;

  const context = {
    console,
    Math, Date, JSON, Object, Array, String, Number, Boolean, Error, Set, Map,
    parseInt, parseFloat, isNaN,
    performance: { now: () => Date.now() },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: fn => { frame = fn; return 1; },
    cancelAnimationFrame: () => { frame = null; },
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
    context,
    els,
    fireDoc(t, ev) { (docHandlers[t] || []).forEach(f => f(ev || {})); },
    fireWin(t, ev) { (winHandlers[t] || []).forEach(f => f(ev || {})); },
    step() { const f = frame; frame = null; if (f) f(); }
  };
}

// A real <select> reports the option marked `selected` (or the first one) as its
// value; without this the games read '' and index into undefined config.
function preselectOptions(html, env) {
  const re = /<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g;
  let m;
  while ((m = re.exec(html))) {
    const [, id, body] = m;
    const opts = [...body.matchAll(/<option\b[^>]*\bvalue="([^"]*)"([^>]*)>/g)];
    if (!opts.length) continue;
    const picked = opts.find(o => /\bselected\b/.test(o[2])) || opts[0];
    env.context.document.getElementById(id).value = picked[1];
  }
}

/* ------------------------------------------------------------------- helpers */

function gameDirs() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.endsWith('-game'))
    .map(d => d.name);
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]);
}

const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter', 'w', 'a', 's', 'd'];

function smoke(dir) {
  const file = path.join(ROOT, dir, 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const scripts = inlineScripts(html);
  if (!scripts.length) return { dir, problems: ['no inline <script> found'] };

  const env = makeContext();
  const problems = [];

  try {
    preselectOptions(html, env);
    if (fs.existsSync(I18N)) {
      vm.runInContext(fs.readFileSync(I18N, 'utf8'), env.context, { filename: 'i18n.js' });
    }
    scripts.forEach((code, i) => {
      vm.runInContext(code, env.context, { filename: `${dir}/index.html#script${i}` });
    });
  } catch (e) {
    return { dir, problems: [`load: ${e.message}`] };
  }

  const poke = (label, fn) => {
    try { fn(); } catch (e) { problems.push(`${label}: ${e.message}`); }
  };

  KEYS.forEach(k => poke(`keydown ${JSON.stringify(k)}`, () => {
    const ev = { key: k, preventDefault() {} };
    env.fireDoc('keydown', ev);
    env.fireWin('keydown', ev);
  }));

  // Fire on the element itself and on its classed children, because delegated
  // handlers (board.addEventListener('click') + ev.target.closest('.cell'))
  // need a realistic ev.target to be exercised at all.
  Object.keys(env.els).forEach(id => {
    const el = env.els[id];
    poke(`click #${id}`, () =>
      el.fire('click', { target: el, button: 0, preventDefault() {} }));
    el.children.forEach((c, ci) => {
      if (c && c._cls && c._cls.size) {
        poke(`click #${id} > .${[...c._cls].join('.')} #${ci}`, () =>
          el.fire('click', { target: c, button: 0, preventDefault() {} }));
      }
    });
  });

  for (let i = 0; i < 40; i++) poke('frame', () => env.step());

  return { dir, problems };
}

/* ---------------------------------------------------------------------- main */

const filter = process.argv[2] || '';
const dirs = gameDirs().filter(d => !filter || d.includes(filter));

if (!dirs.length) {
  console.error(`no game directories matched ${filter ? `"${filter}"` : 'anything'}`);
  process.exit(1);
}

let failed = 0;
for (const dir of dirs) {
  const { problems } = smoke(dir);
  if (problems.length) {
    failed++;
    console.log(`FAIL  ${dir}`);
    problems.forEach(p => console.log(`        ${p}`));
  } else {
    console.log(`ok    ${dir}`);
  }
}

console.log(`\n${dirs.length - failed}/${dirs.length} games smoke-clean`);
process.exit(failed ? 1 : 0);
