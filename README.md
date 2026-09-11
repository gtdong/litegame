# litegame

[简体中文](README.zh.md) · **[English](README.md)**

[![games](https://img.shields.io/badge/games-13-blue?style=flat-square)](#games)
[![AI-generated](https://img.shields.io/badge/AI--generated-100%25-8b5cf6?style=flat-square)](#how-this-was-made)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?style=flat-square)](#why-litegame)
[![vanilla JS](https://img.shields.io/badge/vanilla-JS-f7df1e?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/docs/Web/JavaScript)
[![build](https://img.shields.io/badge/build-none%20required-success?style=flat-square)](#why-litegame)
[![license](https://img.shields.io/github/license/gtdong/litegame?style=flat-square)](LICENSE)
[![CI](https://github.com/gtdong/litegame/actions/workflows/smoke.yml/badge.svg)](https://github.com/gtdong/litegame/actions/workflows/smoke.yml)
[![last commit](https://img.shields.io/github/last-commit/gtdong/litegame?style=flat-square)](https://github.com/gtdong/litegame/commits)
[![repo size](https://img.shields.io/github/repo-size/gtdong/litegame?style=flat-square)](https://github.com/gtdong/litegame)
[![stars](https://img.shields.io/github/stars/gtdong/litegame?style=flat-square)](https://github.com/gtdong/litegame/stargazers)

![litegame — zero-dependency HTML5 mini games, 100% AI-generated](assets/social-preview.png)

---

**13 zero-dependency HTML5 mini games written in plain vanilla JavaScript — 100% AI-generated, 0 lines of hand-written code.** Open `index.html` in a browser and play — no build step, no framework, no `npm install`, no bundler.

### ▶ Play online: <https://litegame-hub.github.io/>

> If you have fun with these games, a ⭐ **star** helps other people find the project.

## Games

Each game lives in its own folder and is a single self-contained `index.html`. Tags hint at what it plays like.

| Game | Description | Tags |
| --- | --- | --- |
| [snake-game](snake-game) | Eat, grow, and don't bite yourself | `arcade` `canvas` `swipe` |
| [gomoku-game](gomoku-game) | Five in a row with Renju forbidden-move rules | `board` `ai` `2-player` |
| [xiangqi-game](xiangqi-game) | Chinese Chess against a built-in engine, three difficulties | `board` `ai` `strategy` |
| [2048-game](2048-game) | Slide and merge tiles to reach 2048 | `puzzle` `swipe` `undo` |
| [minesweeper-game](minesweeper-game) | Clear the board, first click is always safe | `puzzle` `logic` `difficulty` |
| [breakout-game](breakout-game) | Smash every brick, balls speed up per level | `arcade` `canvas` `levels` |
| [memory-game](memory-game) | Flip two cards at a time and match the pairs | `card` `memory` `kids` |
| [tictactoe-game](tictactoe-game) | Minimax AI that never loses, or two players | `board` `ai` `minimax` |
| [whackmole-game](whackmole-game) | 30-second rounds, bombs cost you points | `reflex` `timed` `keyboard` |
| [sudoku-game](sudoku-game) | Unique-solution puzzles with notes mode | `puzzle` `logic` `generator` |
| [fruitcatcher-game](fruitcatcher-game) | Catch the fruit, dodge the bombs | `arcade` `canvas` `levels` |
| [tetris-game](tetris-game) | SRS rotation, 7-bag, hold, ghost, T-spin | `arcade` `canvas` `srs` |
| [sokoban-game](sokoban-game) | Push-only crate puzzles, 10 levels with undo | `puzzle` `levels` `undo` |

## Why litegame

- **Zero dependencies** — nothing to install, nothing to audit, nothing to break.
- **No build step** — the files in this repository *are* the shipped artifact. Clone and double-click.
- **Genuinely vanilla** — plain HTML, CSS and JavaScript. No framework, no bundler, no transpiler.
- **Bilingual UI** — every game switches between English and 简体中文 via one shared 2 KB i18n module.
- **Plays anywhere** — desktop keyboard, mouse, and touch/swipe on phones; each game fills the screen and scales.
- **Tested** — a smoke suite loads all 13 games in a stub DOM plus per-game logic suites (Tetris 98 checks, Sokoban 104 checks).
- **AI-written, end to end** — roughly 9,000 lines of HTML, CSS and JavaScript, none of it typed by a human. See [How this was made](#how-this-was-made).

## How this was made

**Every line of code in this repository was written by an AI agent. None of it was typed by hand.**

The human half of the loop was: describe a game, look at the result, say what is wrong, ask for the next one. The agent half was: write the HTML, CSS and JavaScript, write the tests, run them, fix what failed, and commit.

```text
prompt  ->  generate  ->  run tests  ->  inspect in a browser  ->  fix  ->  publish
```

That is also why the two constraints below are non-negotiable. An AI-written codebase that quietly pulled in frameworks and build tooling would be impossible to review; the whole value here is that you can open any file and read it top to bottom.

- 13 games plus a landing page, ~9,000 lines, zero dependencies, zero build steps.
- The tests were written the same way, and they are what keeps the pile honest: a smoke suite loads every game, and rule-heavy games get logic suites (Tetris 98 checks, Sokoban 104 checks) that prove a game *works*, not merely that it loads.
- The bugs are in the history too — a down arrow in Tetris whose held state was never recorded, Sokoban levels whose crates could not be pushed, a start screen the player could not reach. Finding and fixing those in the open is part of the point.

If you are curious what an AI can build unaided, this is a reasonably honest sample. If you want to see where it still needed a human, read the commit log.

## Tech

- Plain `HTML` / `CSS` / `JavaScript`, rendered with DOM elements and `<canvas>` where it pays off.
- Shared i18n helper: [`assets/i18n.js`](assets/i18n.js) — a ~2 KB, zero-dependency language switcher persisted in `localStorage`.
- Served straight from the repository with **GitHub Pages** (`.nojekyll` keeps the pipeline out of the way).

## Topics

`html5-games` · `javascript-games` · `browser-games` · `mini-games` · `vanilla-javascript` · `zero-dependencies` · `ai-generated` · `vibe-coding` · `github-pages` · `game-development` · `puzzle-game` · `canvas` · `tetris` · `sokoban` · `sudoku` · `minesweeper` · `snake-game` · `2048` · `gomoku` · `chinese-chess`

## Repository layout

```text
litegame/
├── index.html              # landing page: game grid + random picker
├── assets/
│   ├── i18n.js             # shared language switcher
│   └── social-preview.png  # link-preview banner
├── <game>-game/            # one self-contained game per folder
│   ├── index.html
│   ├── README.md           # English
│   └── README.zh.md        # 简体中文
├── tools/                  # smoke test, per-game logic suites, banner generator
├── .github/                # CI workflow, issue forms, PR template
└── robots.txt / sitemap.xml  # search-engine hints for the published site
```

## Add your own game

1. Copy an existing `<game>-game/` folder and rename it.
2. Replace the game logic inside `index.html`.
3. Add an entry to the card grid in the root `index.html`, to its JSON-LD `ItemList`, to the table above, and to `sitemap.xml`.
4. Run `node tools/smoke.js` — it discovers every `*-game/` folder automatically and fails on any uncaught error.
5. Open a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Bug reports, new games, translations and visual polish are all welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first — it is short.

## License

Released under the [MIT License](LICENSE). Have fun.
