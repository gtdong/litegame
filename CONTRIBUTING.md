# Contributing to litegame

[简体中文](CONTRIBUTING.zh.md) · **[English](CONTRIBUTING.md)**

Thanks for wanting to help. This guide is short on purpose.

One thing to know up front: **every line of code in this repository was written by an AI agent, not typed by a human.** That is not a gimmick, it is the design constraint — which is why the two rules below matter so much, and why the test suite carries so much weight. Contributions from people and from agents are equally welcome, and held to the same bar.

## The two rules

Everything in this repository follows two hard constraints:

1. **Zero dependencies.** No frameworks, no npm packages, no CDN links. If it needs a library, it does not belong here.
2. **No build step.** The files committed are the files shipped. Clone, open `index.html`, done.

Any pull request that adds a `package.json` dependency or a build pipeline will be declined — not because it is bad, but because it breaks the point of the project.

## Getting started

```sh
git clone https://github.com/gtdong/litegame.git
cd litegame
node tools/smoke.js      # should print: 13/13 games smoke-clean
```

Then just open `index.html` in a browser. There is nothing else to set up.

## Adding a game

1. **Create the folder.** Copy an existing one, e.g. `cp -r snake-game my-game` and rename it to `<name>-game/`.

2. **Write the game** in `<name>-game/index.html`. Keep it self-contained — one file, inline CSS and JS, no imports.

3. **Bilingual UI, not bilingual code.**
   - All copy that a player sees must exist in both English and 简体中文.
   - Use the shared helper in [`assets/i18n.js`](../assets/i18n.js) rather than rolling your own switcher. Mark elements with `data-i18n` (or `data-i18n-html` / `data-i18n-title` / `data-i18n-placeholder`) and register the dictionary with `LiteI18N.create({...})`.
   - Any text assembled at runtime must go through `T.t()` **and** be rebuilt inside `T.onChange()`, otherwise it will not follow a language switch.
   - Initialize the game first, then call `T.start()` — not the other way round.
   - **Code comments stay in English.**

4. **Always give the player a visible way in.** If the game has a `ready` state, render a start button or overlay. A board that silently does nothing on load is a bug, and it has happened more than once in this repository.

5. **Buttons that cannot be used yet must be `disabled`**, not merely inert.

6. **Write two READMEs** next to your game: `README.md` (English) and `README.zh.md` (简体中文), each with the left-aligned switcher line at the top.

7. **Register the game in four places:**
   - a card in the grid in the root `index.html` (link without a trailing slash, e.g. `href="my-game/"`),
   - a `<ListItem>` in the JSON-LD `ItemList` in the `index.html` head, and bump `numberOfItems`,
   - a row in the tables in `README.md` and `README.zh.md`,
   - a `<url>` entry in `sitemap.xml`.

## Tests

Two layers, and both must be green before a pull request.

**`tools/smoke.js`** discovers every `*-game/` folder automatically, loads it in a stub DOM, presses keys, clicks buttons, fast-forwards timers and pumps animation frames. It only asserts that nothing throws. Run it after literally any edit:

```sh
node tools/smoke.js
```

**Per-game logic suites** (`tools/*-test.js`) load the whole game script in a `vm` sandbox so the tests can read internal state, and assert the actual rules are correct. Existing suites:

```sh
node tools/tetris-test.js     # 98 checks — SRS, 7-bag, scoring, T-spin, gravity, speed gears
node tools/sokoban-test.js    # 104 checks — level validity, BFS solver, replay via real keydown
```

If you add a game with non-trivial rules, add a suite. Two habits matter more than coverage numbers:

- **Test through the real UI entry point.** A test that calls `newGame()` directly will not notice that there is no button a human can click. Click the actual button instead.
- **Prove the content, not just the absence of crashes.** For level-based or generated-content games, verify the puzzle is actually solvable — `sokoban-test.js` runs a BFS solver over every level and then replays the solution through real keyboard events. "It loaded without throwing" would not have caught the levels whose push directions were inverted.

## Before you open a pull request

- [ ] `node tools/smoke.js` passes
- [ ] Every `node tools/*-test.js` passes
- [ ] Both language variants of any new copy are present
- [ ] New game registered in `index.html` (card grid **and** JSON-LD `ItemList`), `README.md`, `README.zh.md` and `sitemap.xml`
- [ ] No `data-page-node-id` or other editor-injected attributes left behind in the HTML
- [ ] No secrets, private hostnames or personal absolute paths committed

Then use the pull request template and describe what changed. Screenshots or a short screen recording are very welcome for visual work.

## Reporting a bug

Use the bug report form. "Open this game, press these keys, this happens instead of that" is the most useful shape. Include your browser and OS, since layout and input handling differ across them.

## Translations and polish

Fixing an awkward English string, improving a Chinese translation, tightening spacing, or making a mobile layout behave are all genuinely valuable contributions here. You do not need to write a game to help.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
