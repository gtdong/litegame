# Frogger

[简体中文](README.zh.md) · **[English](README.md)**

---

A faithful remake of the classic arcade game. Hop the frog **one cell at a time** from the bottom bank to the five home bays at the top: first cross five lanes of traffic, then five lanes of water by riding logs and turtles — then land in an empty bay. Fill all five bays to clear the level. You have three lives and a countdown for every attempt.

## How to play

- **Arrow keys / WASD** hop the frog one cell up / down / left / right. The hop is animated (smooth interpolation, not a teleport) and your key presses are queued, so you can chain hops without waiting.
- **Traffic** (cars and trucks) kills you on contact. Lanes move in alternating directions at different speeds; trucks are longer and slower.
- **Water**: land on a **log** or a **turtle** and you are carried along with it. Land in the water with no platform, or let a platform carry you off the edge of the screen, and you drown.
- **Turtles dive**: every turtle lane submerges on a fixed 5-second cycle. A warning blink appears just before it goes under — get off in time or you drown.
- **Home bays**: hop into an **empty** bay to fill it. Hopping into a bay that is already full — or hitting the wall between two bays — is fatal.
- **Timer**: each attempt has its own countdown. Run it down and you lose a life. Fill a bay and you get a fresh frog and a fresh countdown, without spending a life.
- Filling all five bays clears the level; every lane speeds up on the next one.
- **P** or the on-screen button pauses.

## Scoring

| Event | Points |
|---|---|
| Reach a new row for the first time (per attempt) | +10 |
| Land in an empty home bay | +50 |
| Time bonus when a bay is filled | +5 × (whole seconds left) |
| Clear the level | 300 + 100 × level |

## Board

The board is **13 columns × 13 rows**. Rows are numbered top (0) to bottom (12):

| Row(s) | Role |
|---|---|
| 0 | Five home bays with walls between them |
| 1–5 | River (logs + turtles) |
| 6 | Median (safe) |
| 7–11 | Road (cars + trucks) |
| 12 | Start bank (safe) |

The five home bays are at **columns 1, 3, 6, 9, 11** (the frog starts at row 12, column 6).

## Lanes (level 1)

| Row | Kind | Type | Direction | Speed (cells/s) | Length | Gap |
|---|---|---|---|---|---|---|
| 1 | river | log | left | 1.1 | 3 | 2.0 |
| 2 | river | turtle | right | 1.4 | 2 | 2.0 |
| 3 | river | log | left | 1.7 | 4 | 1.5 |
| 4 | river | turtle | right | 1.2 | 3 | 2.0 |
| 5 | river | log | left | 2.0 | 2 | 2.5 |
| 7 | road | car | right | 2.2 | 1 | 3.0 |
| 8 | road | truck | left | 1.3 | 2 | 4.0 |
| 9 | road | car | right | 3.2 | 1 | 2.5 |
| 10 | road | car | left | 2.6 | 1 | 3.0 |
| 11 | road | car | right | 1.6 | 1 | 3.5 |

Every speed is multiplied by `1 + 0.15 × (level − 1)` (capped), so each new level is faster but the lane *shape* (lengths and gaps) never changes. The per-attempt countdown is `max(10, 25 − 2 × (level − 1))` seconds.

## Determinism

Every car, truck, log and turtle is a **pure function of `(lane, time, level)`** — its left edge is `L(k, t) = k·step + phase + dir·speed·t` for a stable slot identity `k`. No randomness runs during simulation, so the whole board can be recomputed exactly for any time, and `newGame({ level, seed })` is fully reproducible.

## Test bridge

The page exposes a machine-readable model on `window.FR` (`COLS`, `ROWS`, `CELL`, `laneConfig(level)`, `vehiclesAt(lane, t, level)`, `platformsAt(lane, t, level)`, `hopTarget(r, c, dir)`, `collidesAt(state)`, `supportAt(r, c, t, level)`, `homeSlot(c)`, `scoreFor(event, state)`, `newGame(opts)`, `hop(dir)`, `tick(seconds[, step])`, `getState()`). The geometric helpers are pure functions and `tick()` advances the world deterministically without any wall clock. `tick()` also refreshes the DOM HUD after advancing (the same value-cached refresh the render loop runs each frame), so a headless step-driven run stays in sync with the numbers on screen.

`getState()` also carries a `carriedBy` field: while the frog is resting on a river platform it is `{ lane, p }`, where `p` is the **frog's own current continuous column, in cells** (e.g. `6.42` — not a 0..1 ratio); otherwise it is `null`.

## Run

Just open `index.html` in a browser. Zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered.
