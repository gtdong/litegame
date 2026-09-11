# Pong

[简体中文](README.zh.md) · **[English](README.md)**

---

The classic two-player style Pong, rebuilt as a single-file Canvas game: you control the left paddle, an AI controls the right. First to 7 points wins.

## How to play

- Move the **left** paddle with `↑` `↓` or `W` `S`, the mouse, or your finger (touch)
- The **right** paddle is played by the AI, which tracks the ball according to the chosen difficulty
- The ball bounces off the top and bottom walls; hitting the paddle near its edge sends the ball at a steeper angle, and every rally speeds it up (capped per difficulty)
- Score by getting the ball past the opponent's paddle
- A **3-2-1** countdown serves the ball from the center after every point
- Press `Space` or `P` to pause

## Difficulty

| Tier | AI speed | AI accuracy | Ball speed |
|---|---|---|---|
| Easy | slow | loose aim | slow |
| Normal | medium | fair | medium |
| Hard | fast | precise | fast |

## Run

Just open `index.html` in a browser. Zero dependencies.

Pick a difficulty from the dropdown, then press **Start** (or `Space`, or click the field). The built-in English / 简体中文 switch sits at the top and is remembered in `localStorage`.
