# Bubble Shooter

[简体中文](README.zh.md) · **[English](README.md)**

---

Shoot bubbles from the cannon and clear the board. Land three or more of the same colour touching each other and they pop; anything left hanging with no path to the ceiling drops for bonus points.

## How to play

- **Aim** with the mouse or your finger; the cannon shows a dashed guide line.
- **Rotate** with `←` / `→` (or `A` / `D`) for fine angle adjustments.
- **Fire** with `Space`, or just click / tap the board.
- The shot bounces off the left and right walls **once** each, then sticks to the nearest empty slot when it hits a bubble or the ceiling.
- Match **3+ same-colour bubbles** to clear them. Bubbles no longer connected to the top row then **fall** and score extra.
- Every **N shots** the ceiling descends one row. If any bubble crosses the red warning line, the game ends.
- The **next** bubble is previewed in the bottom-right corner; the colour loaded in the cannon always matches the one you are about to fire.

## Difficulty

| Level | Colours | Starting rows | Drop every |
|---|---|---|---|
| Easy | 4 | 5 | 8 shots |
| Normal | 5 | 6 | 6 shots |
| Hard | 6 | 7 | 5 shots |

Pick a difficulty from the menu before starting (or change it for a fresh game afterwards). Your best score is remembered in `localStorage`.

## Run

Just open `index.html` in a browser. Zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered.
