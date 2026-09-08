# gomoku-game · Gomoku

[简体中文](README.zh.md) · **[English](README.md)**

---

Gomoku on a 15x15 board with player-vs-player and player-vs-AI modes, implementing Renju forbidden-move rules.

## How to play

- Open [index.html](index.html) in a browser to start
- Click a board intersection to place a stone; black moves first
- The side panel switches the game mode, the AI's color, and how fouls are handled
- Undo and restart are supported

## Rules

- **Double-three**: one stone creates two open threes at once
- **Double-four**: one stone creates two fours at once
- **Overline**: one stone creates a run of six or more
- A "four-three" is legal for black, and five in a row takes precedence over a foul (except an overline)
- White has no forbidden moves and also wins with six or more in a row

Fouls can be handled in three ways: block the point (default) / lose on the foul / disabled.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
