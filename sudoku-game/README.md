# Sudoku

[简体中文](README.zh.md) · **[English](README.md)**

---

Classic 9×9 Sudoku with three difficulties. Every puzzle is generated on the fly and guaranteed to have exactly one solution.

## How to play

- Click (or tap) a cell to select it, then press a number key or use the on-screen digits
- Fill every **row**, **column** and **3×3 box** with 1–9 — no repeats
- Arrow keys move the selection; `Backspace` / `Delete` clears a cell
- Press **N** to toggle **Notes** mode and jot down pencil marks in empty cells
- Wrong entries turn red immediately (duplicates in a row / column / box)
- The **mistakes counter** tallies every entry that differs from the solution

## Difficulty

| Level | Clues (given digits) |
|---|---|
| Easy | ~43 |
| Medium | ~35 |
| Hard | ~29 |

Puzzles are dug out of a freshly generated full grid, and each removal is only kept if the board still has a **unique solution** — so every puzzle is fair and solvable by logic alone.

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
