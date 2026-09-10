# Tetris

[简体中文](README.zh.md) · **[English](README.md)**

---

The classic falling-block game, built to modern competitive rules — SRS rotation with wall kicks, a 7-bag randomiser, hold slot, ghost piece and T-spin detection.

## How to play

- Blocks fall one at a time. Move and rotate them to complete horizontal lines, which then disappear
- Clearing 1 / 2 / 3 / 4 lines at once scores **100 / 300 / 500 / 800** (× level)
- The game ends when a new piece cannot enter the playfield

## Controls

| Key | Action |
|---|---|
| `←` `→` | Move left / right |
| `↓` | Soft drop (+1 point per cell) |
| `↑` or `X` | Rotate clockwise |
| `Z` | Rotate counter-clockwise |
| `Space` | Hard drop (+2 points per cell) |
| `C` | Hold / swap the current piece |
| `P` | Pause / resume |
| `R` | New game |
| `Esc` | Close the dialog |

On touch devices an on-screen button pad sits below the board.

## Features

- **SRS rotation** — the real Super Rotation System, including the wall-kick tables for both the JLSTZ and I pieces. A piece pinned against a wall will kick out instead of refusing to turn
- **7-bag randomiser** — every seven pieces contain each of the seven shapes exactly once, so you never get a drought of I-pieces
- **Hold slot** — stash a piece for later; usable once per piece
- **Next ×5** — five-piece preview queue
- **Ghost piece** — an outline showing where the current piece will land
- **T-spin detection** — the 3-corner rule for recognising T-spins, worth up to 1600 points
- **Combo counter** — every consecutive line clear adds `50 × combo × level`
- **Level speed-up** — one level per 10 lines; gravity falls from 800 ms/cell toward a 55 ms floor

Highest score is kept in `localStorage` under the `tetris_best` key.

## Run

Just open `index.html` in a browser. Zero dependencies.

An opening screen asks you to hit **Start** (or press `Space` / `Enter`) before the first piece drops. The **New game** button below the board restarts at any time.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.