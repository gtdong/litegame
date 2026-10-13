# Endless Runner

[简体中文](README.zh.md) · **[English](README.md)**

---

An endless, three-lane runner. The whole world is a **pure function of one
scalar, `distance`** (in px): speed is `speedAt(distance)`, and the entire
obstacle field is `hazardAt(k)` — slot `k` sits at the **fixed** absolute
distance `slotS(k) = SLOT0 + k·SLOT_GAP`, with slot content drawn from a seeded
**mulberry32** stream. Because spacing is constant in *distance* and speed is
capped, the time between slots can never fall below `SLOT_GAP / SPEED_MAX`, and a
generated **corridor** lane guarantees a route always exists. So the run is
**provably never impossible** (P1–P7 below) — you only ever lose by mistiming a
jump, a slide or a lane change. The field is **DOM + CSS only**: there is no
canvas anywhere, so every visual is a `<div>` positioned from the published
constants.

## How to play

**Keyboard**

| Key | Action |
|---|---|
| **←** / **A** | move one lane left |
| **→** / **D** | move one lane right |
| **↑** / **W** / **Space** | jump |
| **↓** / **S** | slide |
| **Enter** | start · resume · play again |
| **P** | pause / resume |
| **R** | new game |

**On-screen buttons / touch**

| Control | Action |
|---|---|
| **◀ Left** / **Right ▶** | move one lane left / right |
| **Jump** | jump |
| **Slide** | slide |
| **Pause / Resume** | pause or resume |
| **New game** | start a fresh game |

All actions are **discrete** — there are no held keys. A jump clears a `low`
bar; a slide fits under a `high` bar; a `wall` must be dodged by being in a free
lane. You have **one life**.

## Scoring

- `score = floor(distance / SCORE_PER_UNIT) + coinCount · COIN_POINTS`, i.e. **1
  point per 10 px travelled** plus **25 points per coin**.
- A coin may sit in a **free** lane of a slot; it is picked up when you pass it
  while your hitbox lane matches the coin's lane.
- The **best** score is stored in `localStorage` under `litegame_runner_best`
  (inside `try/catch`) and shown on the HUD.

## The track

The field is a fixed logical **288 × 448 px**. The three lanes are vertical
columns **96 px** wide; their centres are at **`x = 48, 144 and 240 px`**
(`laneXOf(lane) = LANE_W · (lane + 0.5)`), and the player runs along the line
`y = GROUND_Y = 392 px` while the world scrolls *down* toward it. Everything is a
plain `<div>` positioned from the constants: the player carries the bare custom
properties `--lane` (hitbox lane) and `--y` (jump height), and every `.hazard` /
`.coin` carries `--lane` and `--x` (its horizontal screen x). `#track` owns
`--cell` (= `LANE_W`) and the player's transform is
`translate(calc(var(--lane) * var(--cell)), calc(var(--y) * -1px))`. Positions
are never read back out of the DOM.

## Constants (`RN.constants`)

Every tuning constant, by its exact source name.

| Constant | Value | Unit |
|---|--:|---|
| `LANE_COUNT` | 3 | lanes |
| `LANE_W` | 96 | px |
| `VIEW_W` | 288 | px |
| `VIEW_H` | 448 | px |
| `GROUND_Y` | 392 | px |
| `PLAYER_W` | 34 | px |
| `PLAYER_H` | 56 | px |
| `PLAYER_SLIM_H` | 28 | px |
| `SLOT0` | 640 | px |
| `SLOT_GAP` | 320 | px |
| `LEVEL_SPAN` | 2000 | px |
| `LEVEL_MAX` | 16 | levels |
| `SPEED_BASE` | 200 | px/s |
| `SPEED_RAMP` | 20 | px/s per level |
| `SPEED_MAX` | 520 | px/s |
| `MIN_REACT_S` | 0.45 | s |
| `GRAVITY` | 2200 | px/s^2 |
| `JUMP_V` | 900 | px/s |
| `SLIDE_S` | 0.6 | s |
| `LANE_CHANGE_S` | 0.18 | s |
| `HAZARD_LOW_W` | 60 | px |
| `HAZARD_LOW_H` | 46 | px |
| `HAZARD_HIGH_W` | 70 | px |
| `HAZARD_HIGH_H` | 24 | px |
| `HAZARD_HIGH_CLEAR` | 34 | px |
| `HAZARD_WALL_W` | 40 | px |
| `WALL_H` | 120 | px |
| `COIN_R` | 10 | px |
| `COIN_POINTS` | 25 | points |
| `SCORE_PER_UNIT` | 10 | px per point |
| `COIN_CHANCE` | 0.4 | probability |
| `EMPTY_CHANCE` | 0.14 | probability |
| `SINGLE_CHANCE` | 0.66 | probability |
| `PATTERN_LEN` | 12 | slots |
| `DEFAULT_STEP` | 1/60 (= 0.0166667) | s |
| `MAX_CHUNK` | 0.25 | s |
| `POOL_SIZE` | 24 | nodes per layer |

## Why it is never impossible

All seven properties are properties of the shipped constants and are checkable
through `window.RN`; the numbers below are the real values.

**P1 — every slot leaves at least one free lane.** A slot blocks either 0 lanes
(empty), 1 lane, or **at most 2** lanes; it **never blocks all 3**. The corridor
lane `c(k)` (see P2) is always free, so `free.length >= 1` for every slot.
Verified over the first **5000 slots on each of 40 seeds**: the **minimum
free-lane count is 1**.

**P2 — routes are connected.** A per-seed **corridor pattern** of length
`PATTERN_LEN = 12` is a walk over lanes that starts on the middle lane and only
ever steps by **−1 / 0 / +1**, so for consecutive slots there are free lanes `f`
(in slot `k`) and `g` (in slot `k+1`) with `|f − g| <= 1`. This holds for the
periodic wrap too, because every pattern value (and the start value 1) lies in
`[0, 2]`, hence is within 1 of the middle lane. Verified for the first **5000
slots on each of 40 seeds**.

**P3 — there is always time to react.** `timeBetween(s0, s1)` is the **exact**
integral of `1/speed` over `[s0, s1]`, computed in **closed form** as a finite
sum over the constant-speed level segments (never numerically integrated). For
every consecutive slot pair the budget is at least `SLOT_GAP / SPEED_MAX`:

```
min timeBetween(slotS(k), slotS(k+1)) = 320 / 520 = 0.615385 s  >= MIN_REACT_S = 0.45 s
```

Verified over the first 5000 slots: the minimum is `0.615385 s` (satisfied with
a margin of `0.165385 s`).

**P4 — the ramp saturates.** `speedAt(s) <= SPEED_MAX = 520` for all `s` (the
level is clamped to `LEVEL_MAX = 16`, and `SPEED_BASE + SPEED_RAMP·LEVEL_MAX =
200 + 20·16 = 520`). The floor on the per-slot budget is

```
SLOT_GAP / SPEED_MAX = 320 / 520 = 0.615385  >=  MIN_REACT_S = 0.45
```

so P3 holds **forever**, not merely early on.

**P5 — the actions suffice.** Coverage (jump/slide travel) scales with **speed**,
while the collision overlap is a **fixed length** along the track, so the binding
case is the **slowest** speed — `SPEED_BASE = 200 px/s` — not the fastest.

```
Overlap with a low bar   = HAZARD_LOW_W  + PLAYER_W = 60 + 34 =  94 px
Overlap with a high bar  = HAZARD_HIGH_W + PLAYER_W = 70 + 34 = 104 px

jumpApex() = JUMP_V^2 / (2·GRAVITY) = 900^2 / 4400 = 184.090909 px
             >= HAZARD_LOW_H + 0.15·PLAYER_H = 46 + 8.4 = 54.4 px   (apex clears)

time above HAZARD_LOW_H = 2·sqrt(JUMP_V^2 − 2·GRAVITY·HAZARD_LOW_H) / GRAVITY
                        = 2·sqrt(607600) / 2200 = 0.708625 s
jump travel @ SPEED_BASE = 0.708625 · 200 = 141.725 px  >=  94 px   (PASS)

SLIDE_S · SPEED_BASE     = 0.6 · 200 = 120 px  >=  HAZARD_HIGH_W + PLAYER_W = 104 px  (PASS)
```

A jump stays strictly above `HAZARD_LOW_H` for **0.708625 s** (**141.725 px** at
`SPEED_BASE`, **368.485 px** at `SPEED_MAX`), and a slide covers **120 px** at
`SPEED_BASE` (**312 px** at `SPEED_MAX`). The slide's hitbox top
(`PLAYER_SLIM_H = 28`) fits under the clearance (`HAZARD_HIGH_CLEAR = 34`) while a
standing player (`PLAYER_H = 56`) does not.

**P6 — a lane change fits inside the budget.** `LANE_CHANGE_S = 0.18 <=
MIN_REACT_S = 0.45`.

**P7 — no coin is ever in a blocked lane.** A coin is only ever placed in a lane
taken from the slot's `free` set. Verified over the first **5000 slots on each of
40 seeds**.

## Calibration (measured)

- **Jump apex** `jumpApex() = 184.090909 px`; **airtime** `jumpAirtime() =
  0.818182 s`.
- **Slide duration** `slideDuration() = 0.6 s`.
- **Lane-change time** `laneChangeTime() = 0.18 s`.
- **Speed** at level 0: `speedAt(0) = 200 px/s`; at the cap: `speedAt(LEVEL_MAX ·
  LEVEL_SPAN) = speedAt(32000) = 520 px/s` (and `speedAt(1e9) = 520`).
- **Minimum `reactionBudget` over the first 500 slots = 0.615385 s**, first
  reached at **slot k = 99** (both `slotS(98) = 32000` and `slotS(99) = 32320`
  lie in the cap region), where it exactly equals `SLOT_GAP / speedAt(...) = 320
  / 520`.
- **`timeBetween` closed form vs numeric integration** (two-million-point
  midpoint rule): `timeBetween(0,640) = 3.2 / 3.2`, `timeBetween(32000,32320) =
  0.615385 / 0.615385`, `timeBetween(0,100000) = 229.468223 / 229.468223` — the
  two agree to floating-point rounding.
- **Perfect player** (a bot that follows the corridor route: each slot it picks a
  free lane adjacent to its previous intent, then walks the player there): on
  **40 seeds it survives**, never dying. Because `distance` is a pure function of
  time while alive, the distance reached is seed-independent: the **analytic**
  distance at `t = 90 s` is **27755.1302 px** (level 13, `speedAt = 460 px/s`),
  while a fixed-step driver reaches **27752.3333 px** after 5400 steps of
  `DEFAULT_STEP` — identical on all 40 seeds. **A single 600 s run** reached the
  **analytic 292676.5240 px** (913 slots), still alive — a driver at a 1/60 s step
  reports 292672.7 px and at 1/240 s 292675.5 px, i.e. every forward-Euler driver
  lands at or just below the analytic value, since `speedAt` is read at the step
  start and speed is non-decreasing. The final **score** is not a constant: the
  distance is bot-independent, but the **coin count is route-dependent** — over the
  same 600 s, surviving bots that took different lanes collected 213, 215 and 220
  coins (scores 34592, 34642 and 34767). A **careless** player that never reacts
  **does** die (seed 1, hitting a `wall` at distance 1563) — the game is loseable;
  it is just never *impossible*.
- **Slot content mix** (seed 1, first 5000 slots): `low` 1030, `high` 1034,
  one-lane `wall` 572, two-lane `wall` 1694, `empty` 670, and **2005 coins**.

## Determinism

`RN.newGame({ seed })` rebuilds the corridor pattern and fixes the per-slot PRNG
key, so **the whole field is a pure function of `(seed, k)`** and the same seed
always yields the same field. Driving the game through `RN.tick(seconds, step)`
with a fixed step is **bit-for-bit reproducible**: `getState()` compares equal
for the same seed and tick sequence. Every pure function (`levelAt`, `speedAt`,
`slotS`, `hazardAt`, `timeBetween`, `toPixel`, ...) is side-effect free and never
mutates its arguments. `distance` — and hence `level`, `speed`, `score` and the
renderer — is a pure function of elapsed simulated time while the run is alive,
so on-screen runs mirror headless runs exactly.

**Step-size independence.** Collision and coin-pickup detection is a **swept**
interval test: each `update` captures `d0 = distance` before advancing and the
hazard window `[h.s − w/2 − PLAYER_W/2, h.s + w/2 + PLAYER_W/2]` is intersected
with the travelled span `[d0, distance]`. Because the sub-steps tile the whole
interval contiguously, a hazard narrower than one stride — at the cap a stride is
`MAX_CHUNK · SPEED_MAX = 0.25 · 520 = 130 px`, while the narrowest window
`HAZARD_WALL_W + PLAYER_W = 40 + 34 = 74 px` is smaller — can **never** fall
between two samples. So `RN.tick(10, 1)` (a coarse fast-forward) and
`RN.tick(10, 1/60)` reach the **same** hit/no-hit verdict; the rAF loop likewise
clamps `dt` to 0.05 s, well inside a window.

## Bridge (`window.RN`)

- **`constants`** — the frozen value table above (37 entries).
- **`world()`** → `{ laneCount, laneX:[x0,x1,x2], laneW, viewW, viewH, groundY, playerW, playerH, playerSlimH, slotGap, slot0 }`.
- **`mulberry32(seed)`** — pure generator factory returning a `[0,1)` stream.
- **`levelAt(s)`** → integer difficulty level, `min(LEVEL_MAX, floor(s / LEVEL_SPAN))`, clamped at 0.
- **`speedAt(s)`** → world speed in px/s, `min(SPEED_MAX, SPEED_BASE + SPEED_RAMP·levelAt(s))`.
- **`slotS(k)`** → absolute distance of slot `k`, `SLOT0 + k·SLOT_GAP`.
- **`slotCount(s)`** → number of slots at or before `s`.
- **`hazardAt(k)`** → `{ k, lane, kind, s, w, h, blocked:[...], free:[...], coin:{lane}|null }`. `kind` is `'low' | 'high' | 'wall' | 'empty'`. A valid slot always returns an object (an empty slot has `kind:'empty'`, `blocked:[]`); **`null` is returned only when `k` is out of range** (`k < 0` or not a number).
- **`hazardsBetween(s0, s1)`** → the array of `hazardAt(k)` for every slot whose distance lies in `[s0, s1]`.
- **`timeBetween(s0, s1)`** → seconds to travel from `s0` to `s1`. This is the **exact** integral of `1/speed` over the interval, in **seconds**, computed **in closed form** by summing `(segment length) / (segment speed)` over the constant-speed level segments — never numerical integration. Signed: `timeBetween(a,b) = −timeBetween(b,a)`, and `0` when `a == b`.
- **`reactionBudget(k)`** → seconds available to react between slot `k−1` and slot `k`, i.e. `timeBetween(slotS(k−1), slotS(k))` (for `k = 0`, `timeBetween(0, slotS(0))`).
- **`jumpApex()`** = 184.090909 · **`jumpAirtime()`** = 0.818182 · **`slideDuration()`** = 0.6 · **`laneChangeTime()`** = 0.18.
- **`toPixel(lane, s)`** → `{ x, y }`, the pure lane+forward-distance → screen-pixel mapping the renderer uses. `x` is the lane centre `laneXOf(lane)`; `y = GROUND_Y − s`, where `s` is the **forward gap** ahead of the player (the renderer passes `s − distance`), so a larger `s` is higher up the field.
- **`getState()`** → `{ phase, distance, score, best, level, speed, lane, targetLane, y, vy, onGround, sliding, alive, coinCount, over, seed, rng:{seed,calls}, ticks, log }`. `lane` is the **hitbox lane**; during a lane change it flips to the destination at the **midpoint** of the interpolation, and `targetLane` is the destination. `rng.calls` is how many draws the live stream has produced (0 — the field is a pure function of distance, no live draws are needed).
- **`hudCache()`** — a copy of the HUD value cache.
- **`log()`** — a copy of the rolling event log.
- **`newGame(opts)` · `start()` · `pause()` · `resume()` · `togglePause()`** — `opts = { seed }` is optional; the default seed is 1.
- **`moveLane(dir)`** — `−1` / `+1`; **`jump()`**; **`slide()`**. All three are gated by `phase` (they do nothing in `ready` or `over`).
- **`tick(seconds[, step])`** — advances the same `update(dt)` with no rAF and no wall clock, split into chunks of at most `MAX_CHUNK` and each chunk sub-stepped at `h <= step` (default `DEFAULT_STEP`), then runs the value-cached `updateHud()` exactly **once** and returns `getState()`. Collision/pickup detection is **swept** over each sub-step's travelled span `[distance_before, distance_after]`, so a hazard narrower than one stride can never be stepped over: coarse and fine `step` values give the same hit/no-hit verdict (see the note under *Determinism*).

## Run

Just open `index.html` in a browser — zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is
remembered.
