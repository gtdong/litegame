# Nonogram

[简体中文](README.zh.md) · **[English](README.md)**

---

Paint cells so every row and column matches its number clues. The numbers give the lengths of the filled runs, in order, with at least one gap between them. Deduce — don't guess.

## How to play

- **Left click** cycles a cell: empty → filled → ✕ → empty
- **Right click** (or long-press on touch) marks ✕ straight away — your own "this one is empty" note
- Each row and column shows its clue list; a clue dims once that line is fully decided *and* matches
- **Hint** fills one cell that the solution demands
- **Undo** rewinds one move, **Restart** clears the board and the clock, **New game** deals a fresh puzzle
- Keys: **U** undo · **R** restart · **Esc** close the result dialog

Turn **Error highlight** off whenever you'd rather not be told you're wrong.

## Three sizes

| Size | Name | Feel |
| --- | --- | --- |
| 5×5 | Newbie | learn the mechanic |
| 10×10 | Normal | recognisable little pictures |
| 15×15 | Hard | generated shapes, a proper workout |

## Every puzzle has exactly one solution

That is the design rule, not a nice-to-have. A nonogram with two solutions is a guessing game, and guessing isn't deduction.

- The **10 hand-drawn 5×5 pictures** and the **10 hand-drawn 10×10 pictures** were each verified to yield exactly one solution.
- **Generated puzzles** start from a random double-symmetric pattern; the generator only accepts it once a constraint-propagation solver has fully resolved the grid. If propagation alone pins down every cell, that grid is provably the *unique* solution.
- So the board never lies: the answer you are chasing is always reachable by logic.

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.

## Tests

`node tools/nonogram-test.js` — 157 assertions. Beyond the usual rule checks (clue generation, the click cycle, clue auto-strike, undo, the win condition) it pins down the solver itself:

- **every enumerated line arrangement must genuinely match the clue it was generated for**, with no duplicates — a direct regression guard for a stale-tail bug that once let the enumerator emit arrangements belonging to a *different* clue (e.g. `[1,1]` produced `01011`, whose clue is `[1,2]`);
- every built-in picture has exactly one solution, **and** the solver's answer is identical to the picture;
- every generated puzzle is unique and round-trips through the solver;
- a full play-through runs through the **real Start button and real cell clicks** in a fake DOM, and the reverse-check group re-injects known bugs to prove the suite would actually fail them.
