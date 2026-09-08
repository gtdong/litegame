# xiangqi-game · Chinese Chess (Xiangqi)

[简体中文](README.zh.md) · **[English](README.md)**

---

Player-vs-computer Chinese chess on a 10x9 board, powered by a built-in negamax engine (alpha-beta pruning + piece-square tables).

## How to play

- Open [index.html](index.html) in a browser to start
- Click a piece to select it, then click a destination; you play red and move first, the computer plays black
- Three difficulty levels: Beginner / Normal / Expert (search depths 1 / 3 / 4)
- Tick "AI first (black)" to let the computer move first
- Undo, restart, and notation export (txt download) are supported

## Rules

- Standard xiangqi moves (blocked horse legs, blocked elephant eyes, cannon screens, river-crossed pawn sidesteps are all implemented)
- Three consecutive checks lose the game (perpetual check); the computer also avoids running one
- The game ends on checkmate or stalemate

## Notes

- Pure front-end, zero dependencies, no network requests — the AI runs entirely in the browser
- Notation uses spectator coordinates: files 1-9 left to right, ranks 1-10 bottom to top

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
