# Breakout

[简体中文](README.zh.md) · **[English](README.md)**

---

Classic Breakout: keep the ball in play and clear every brick.

## How to play

- **Move the mouse** to control the paddle (desktop)
- **Left / Right arrow keys** also work
- **Drag your finger** on touch devices
- **Space / Enter** launches the ball and resumes play
- Each brick is worth 10 points; clearing the screen advances the level

## Rules

- The bounce angle depends on **where the ball hits the paddle** — the further from centre, the sharper the angle
- Missing the ball costs one life; you start with 3
- After a miss the game pauses and tells you how many lives are left — click "Serve again" or press Space to continue
- Losing all three lives ends the game and shows the final score
- The ball speeds up on every level

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
