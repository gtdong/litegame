#!/usr/bin/env node
/**
 * Registry consistency check for the litegame collection.
 *
 * Adding a game means registering it in FOUR places that must never drift
 * apart. This script proves they agree, so a forgotten registration fails
 * loudly instead of shipping as a dead card or an orphaned directory.
 *
 *   1. index.html              card wall           <a class="card" href="x-game/">
 *   2. index.html              JSON-LD             mainEntity.itemListElement[]
 *                                                  (position / name / url) +
 *                                                  numberOfItems
 *   3. sitemap.xml             <loc> entries
 *   4. README.md / README.zh.md  games table row + games-N badge
 *
 * Plus: every game directory ships index.html + README.md + README.zh.md.
 *
 * Usage: node tools/verify-links.js
 * Exits 0 when everything is consistent, 1 otherwise. Read-only.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE = 'https://litegame-hub.github.io/';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; failures.push(label); console.log('  FAIL ' + label + (detail ? '  <' + detail + '>' : '')); }
}

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* ---------------------------------------------------------------- 1. cards */
const home = read('index.html');
const cardHrefs = [];
{
  const re = /<a\s+class="card"\s+href="([^"]+)"/g;
  let m;
  while ((m = re.exec(home))) cardHrefs.push(m[1].replace(/\/$/, ''));
}

/* -------------------------------------------------------------- 2. JSON-LD */
const jsonLd = [];
{
  const re = /\{\s*"@type":\s*"ListItem",\s*"position":\s*(\d+),\s*"name":\s*"((?:[^"\\]|\\.)*)",\s*"url":\s*"([^"]+)"\s*\}/g;
  let m;
  while ((m = re.exec(home))) {
    jsonLd.push({ position: parseInt(m[1], 10), name: m[2], url: m[3].replace(/\/$/, '') });
  }
}
const numberOfItems = (() => {
  const m = /"numberOfItems":\s*(\d+)/.exec(home);
  return m ? parseInt(m[1], 10) : -1;
})();

/* --------------------------------------------------------------- 3. sitemap */
const sitemap = read('sitemap.xml');
const sitemapLocs = [];
{
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(sitemap))) sitemapLocs.push(m[1].trim().replace(/\/$/, ''));
}

/* ------------------------------------------------------------ 4. directories */
const dirs = fs.readdirSync(ROOT)
  .filter(n => /-game$/.test(n) && fs.statSync(path.join(ROOT, n)).isDirectory())
  .sort();

/* ---------------------------------------------------------------- 5. READMEs */
function tableRows(rel) {
  const out = [];
  const re = /^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|/gm;
  let m;
  const txt = read(rel);
  while ((m = re.exec(txt))) out.push(m[2].replace(/\/$/, ''));
  return out;
}
const rowsEn = tableRows('README.md');
const rowsZh = tableRows('README.zh.md');
const badge = rel => {
  const m = /badge\/games-(\d+)-/.exec(read(rel));
  return m ? parseInt(m[1], 10) : -1;
};

/* ------------------------------------------------------------------ checks */
console.log('== registry consistency ==');
console.log('  cards=' + cardHrefs.length + ' jsonld=' + jsonLd.length
  + ' sitemapGames=' + (sitemapLocs.length - 1) + ' dirs=' + dirs.length);
console.log('  badge en=' + badge('README.md') + ' zh=' + badge('README.zh.md')
  + ' rows en=' + rowsEn.length + ' zh=' + rowsZh.length);

const cardSet = new Set(cardHrefs);
const jsonSet = new Set(jsonLd.map(o => o.url.replace(SITE, '')));
const sitemapGames = new Set(sitemapLocs.filter(u => u !== SITE.replace(/\/$/, '')).map(u => u.replace(SITE, '')));
const dirSet = new Set(dirs);

// card wall
ok(cardHrefs.length === new Set(cardHrefs).size, 'no duplicate cards in the card wall',
  cardHrefs.filter((x, i) => cardHrefs.indexOf(x) !== i).join(','));
for (const h of cardHrefs) {
  if (!dirSet.has(h)) ok(false, 'card points at an existing directory: ' + h);
}
ok(cardHrefs.every(h => dirSet.has(h)), 'every card points at an existing game directory',
  cardHrefs.filter(h => !dirSet.has(h)).join(','));
ok(cardHrefs.length === dirs.length && cardHrefs.every(h => dirSet.has(h)),
  'every game directory has a card', dirs.filter(d => !cardSet.has(d)).join(','));

// JSON-LD
ok(jsonLd.length === numberOfItems, 'numberOfItems matches the number of ListItems',
  numberOfItems + ' vs ' + jsonLd.length);
ok(jsonLd.every((o, i) => o.position === i + 1), 'JSON-LD positions are contiguous 1..N',
  jsonLd.filter((o, i) => o.position !== i + 1).map(o => o.position).join(','));
ok(jsonSet.size === jsonLd.length, 'no duplicate JSON-LD urls');
ok(jsonLd.map(o => o.url).join('|') === cardHrefs.map(h => SITE + h).join('|'),
  'JSON-LD order and urls match the card wall order');

// sitemap
ok(sitemapGames.size === dirs.length, 'sitemap lists every game directory',
  dirs.filter(d => !sitemapGames.has(d)).join(','));
ok([...sitemapGames].every(u => dirSet.has(u)), 'sitemap has no stale game urls',
  [...sitemapGames].filter(u => !dirSet.has(u)).join(','));
ok(sitemapLocs.includes(SITE.replace(/\/$/, '')), 'sitemap includes the homepage');

// READMEs
ok(badge('README.md') === dirs.length, 'README.md games-N badge matches the game count',
  String(badge('README.md')));
ok(badge('README.zh.md') === dirs.length, 'README.zh.md games-N badge matches the game count',
  String(badge('README.zh.md')));
ok(rowsEn.length === dirs.length && rowsEn.every(r => dirSet.has(r)),
  'README.md table has a row per game', dirs.filter(d => !rowsEn.includes(d)).join(','));
ok(rowsZh.length === dirs.length && rowsZh.every(r => dirSet.has(r)),
  'README.zh.md table has a row per game', dirs.filter(d => !rowsZh.includes(d)).join(','));
ok(rowsEn.join('|') === rowsZh.join('|'), 'the two README tables list the same games in the same order');

// per-game directory contents
const missing = [];
for (const d of dirs) {
  for (const f of ['index.html', 'README.md', 'README.zh.md']) {
    if (!fs.existsSync(path.join(ROOT, d, f))) missing.push(d + '/' + f);
  }
}
ok(missing.length === 0, 'every game ships index.html + both READMEs', missing.join(','));

const orphans = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter(n => /-test\.js$/.test(n))
  .map(n => n.replace(/-test\.js$/, ''));
ok(orphans.every(o => dirSet.has(o + '-game')), 'every tools/<game>-test.js has a matching game',
  orphans.filter(o => !dirSet.has(o + '-game')).join(','));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (failures.length) console.log('failures: ' + failures.join(' | '));
process.exit(fail ? 1 : 0);
