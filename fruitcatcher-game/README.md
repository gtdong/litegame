# Fruit Catcher

[简体中文](README.zh.md) · **[English](README.md)**

---

Catch falling fruit with your basket — dodge the bombs. A timing-and-coordination game where speed picks up as you climb levels.

## How to play

- Fruit (🍎🍌🍇🍉🍑🍓) drops from the top of the canvas — move the basket to catch it. Different fruit score differently; rarer fruit give more points
- A **bomb 💣** drops alongside the fruit — catching one costs a life
- Missing a fruit (it hits the ground) also costs a life
- You start with **3 lives** — when they hit zero a results dialog pops up
- Difficulty ramps up automatically: spawn pace, fall speed and bomb ratio all climb with your level (one level every ~12 seconds)

## Controls

- **Mouse / touch**: move the basket horizontally
- **←/→** or **A/D**: keyboard movement
- **Space / Enter**: pause / resume
- **Escape**: close the results dialog
- **New** button (or "Play again" in the dialog): start a new round

## Scoring

| Event | Effect |
|---|---|
| Catch 🍎🍌🍇 | +10 to +14 |
| Catch 🍉🍑 | +16 to +18 |
| Catch 🍓 | +20 |
| Catch 💣 | −1 life |
| Miss a fruit | −1 life |

Best score is kept in `localStorage` under the `fruitcatcher_best` key.

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.