# Minesweeper

[简体中文](README.zh.md) · **[English](README.md)**

---

Classic Minesweeper: reveal every safe cell to win.

## How to play

- **Left click** to reveal a cell
- **Right click** to flag it (on mobile, **long-press** for 400 ms)
- A number tells you how many mines sit in the 8 surrounding cells
- Revealing a blank cell floods out the whole empty region
- **Your first click is never a mine** — the board is laid out after that click

## Difficulty

| Level | Board | Mines |
|---|---|---|
| Easy | 9 × 9 | 10 |
| Medium | 16 × 16 | 40 |
| Hard | 30 × 16 | 99 |

## Extras

- The left counter shows **mines remaining** (total mines minus flags placed)
- The right counter is a **timer**, started by your first move and capped at 999 seconds
- Losing reveals every mine and marks the flags you got wrong

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
