# Klotski (华容道)

[简体中文](README.zh.md) · **[English](README.md)**

---

Slide the wooden blocks and guide **Cao Cao** (the red 2×2 piece) down to the exit at the bottom centre of the 4×5 board. This is the classic *Hua Rong Dao* sliding-block puzzle.

## How to play

- **Pick a level**, then press **Start**.
- **Tap / click a piece** to select it (a yellow outline appears).
- Move the selected piece with:
  - **Arrow keys** or **WASD**
  - the on-screen **direction pad**
  - a **swipe** on touch devices
  - **clicking an adjacent empty cell**
- Pieces slide one cell at a time into empty space — no diagonals, no overlaps, no leaving the board.
- When Cao Cao sits on the bottom-centre 2×2 exit, the level is cleared.

## Pieces

| Piece | Size | Count |
|---|---|---|
| 曹操 Cao Cao | 2 × 2 | 1 |
| 五虎将 Generals (关羽 horizontal, 张飞/赵云/马超/黄忠 vertical) | 2 × 1 / 1 × 2 | 5 |
| 兵 Soldiers | 1 × 1 | 4 |

## Features

- **6 classic layouts** (横刀立马, 指挥若定, 将拥曹营, 齐头并进, 兵分三路, 横冲直撞).
- **Undo** (`U`) and **Restart** (`R`) for the current level.
- **Moves**, **timer** and the **best move count** per level, saved in `localStorage`.
- Cleared levels are remembered; the level label shows a ✓.
- Bilingual UI (English / 简体中文) with the choice stored in `localStorage`.
- Fully playable on desktop and mobile.

## Run

Just open `index.html` in a browser. Zero dependencies, no build step.
