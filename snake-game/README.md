# snake-game · Snake

[简体中文](README.zh.md) · **[English](README.md)**

---

Classic Snake on a 24x24 grid.

## How to play

- Open [index.html](index.html) in a browser to start
- Keyboard: arrow keys or <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> to steer
- Mobile: swipe on the board to turn, double tap to pause
- <kbd>Space</kbd> pauses / resumes, <kbd>Enter</kbd> starts or restarts

## Notes

- Each food is worth 10 points; the snake grows and speeds up slightly
- Hitting a wall or the snake's own body ends the game
- The best score is stored in localStorage under the key `snake_best_score`

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
