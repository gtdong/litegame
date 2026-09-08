# 2048

[简体中文](README.zh.md) · **[English](README.md)**

---

The classic 2048: slide tiles to merge equal numbers and reach 2048.

## How to play

- **Arrow keys** or **WASD** to move the tiles
- On touch devices just **swipe**
- Two tiles with the same number merge into double the value; every merge adds to your score
- Reach 2048 to win, then keep going for a higher tile
- The game ends when the board is full and no move is possible

## Extras

- **Undo**: roll back your last move, up to 20 steps
- **Best score** is stored in the browser under the `localStorage` key `game2048_best`

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
