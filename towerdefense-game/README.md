# Tower Defense

[简体中文](README.zh.md) · **[English](README.md)**

---

A single-screen grid tower defense. The field is a **20 × 12 grid of 32 px
tiles** — exactly **640 × 384** logical pixels, `canvas` 2D, no camera and no
scrolling. Enemies march a **fixed polyline** from the off-screen entrance to
the off-screen base; you spend gold on three tower types to stop **12 waves**
from reaching it. The base has **20 lives**, you start with **220 gold**, and
the whole simulation is **100% deterministic**.

## How to play

**Mouse / touch**

- Click a **buildable tile** to select it, then click one of the three tower
  buttons (or press **1 / 2 / 3**) to build there. If a tower type is already
  selected, clicking a buildable tile builds immediately.
- Click an existing **tower** to select it, then use **Upgrade** / **Sell**
  (keyboard **U** / **S**). Selling returns **70%** of everything spent on that
  tower, rounded down.

**Keyboard**

- **1 / 2 / 3** — select Gun / Cannon / Frost.
- **Space** — call the next wave (starts it, or cashes in the current one early).
- **U / S** — upgrade / sell the selected tower. **Esc** — clear the selection.
- **P** — pause / resume. **R** — restart. **Enter** — start / resume / play again.

**On-screen buttons**

- Three tower buttons (with prices) + **Upgrade** / **Sell** / **Call next wave**
  / **Pause** / **speed 1× · 2×** / **New game**.

## Path and buildable tiles

The enemy route is a single fixed, **axis-aligned, non-self-intersecting**
polyline declared in grid coordinates. In this build it is:

```
(-1,2) → (4,2) → (4,6) → (9,6) → (9,1) → (15,1) → (15,9) → (20,9)
```

The first and last vertices sit **one tile outside** the grid so enemies walk on
and off the screen. `TD.path()` returns the vertices and `TD.pathLength()`
returns the pixel length (**1216 px**). A tile is **buildable** iff it is inside
the grid, **not** on the path, and **not** one of the decorative blocker tiles
declared in `TD.blocked()`. There are **190** buildable tiles.

## Towers (three types × three levels)

Level curve: **L2** costs `round(base × 0.8)` and multiplies damage by **1.7**
(range **+0.4**); **L3** costs `round(base × 1.4)` and multiplies damage by
**1.7**, fire rate by **1.25** and range **+0.4** — L3 applies on top of L2.
The full table (`TD.towers()`), prices in gold, range in tiles, rate in shots/s:

| Tower | Lv | Cost | Damage | Rate | Range | Trait |
|---|---|--:|--:|--:|--:|---|
| **gun** (Gun) | 1 | 50 | 8 | 2.5 | 2.5 | single target |
| | 2 | 40 | 13.6 | 2.5 | 2.9 | |
| | 3 | 70 | 23.12 | 3.13 | 3.3 | |
| **cannon** (Cannon) | 1 | 90 | 26 | 0.7 | 3.5 | **splash**, full damage to every enemy within **1.2** tiles of the impact |
| | 2 | 72 | 44.2 | 0.7 | 3.9 | |
| | 3 | 126 | 75.14 | 0.88 | 4.3 | |
| **frost** (Frost) | 1 | 70 | 3 | 1.2 | 2.8 | on hit: **−45% speed for 1.5 s** (does not stack, strongest wins) |
| | 2 | 56 | 5.1 | 1.2 | 3.2 | |
| | 3 | 98 | 8.67 | 1.5 | 3.6 | |

Damage model: `actual = max(1, towerDamage − enemyArmor)` — flat armour
reduction with a **floor of 1**.

## Enemies (`TD.enemies()`)

Speed is in tiles/s; gold is the kill bounty.

| Enemy | HP | Speed | Armor | Gold |
|---|--:|--:|--:|--:|
| **swarm** (Swarm) | 22 | 2.2 | 0 | 3 |
| **runner** (Runner) | 40 | 1.6 | 0 | 6 |
| **brute** (Brute) | 140 | 0.9 | 3 | 14 |

## Waves (12 — `TD.waves()`)

Each wave is a set of groups `{ type, count, gapSec, delaySec }`; `gapSec` is the
delay between consecutive spawns in a group and `delaySec` is the delay from the
wave start until that group's first spawn. Difficulty ramps by count, by
tighter gaps and by mixing in `brute` from wave 5 on. **Enemy count and
armour-weighted HP are both monotonically non-decreasing** across the 12 waves
(asserted by the test harness): counts `8, 12, 13, 14, 15, 17, 18, 20, 20, 23,
24, 26`; armour-weighted HP `176, 300, 340, 452, 595, 603, 782, 826, 862, 1049,
1089, 1236`.

| Wave | Groups (type × count, gap / delay) | Enemies | HP total | Armour-weighted HP |
|--:|---|--:|--:|--:|
| 1 | swarm × 8, 1.6 / 0 | 8 | 176 | 176 |
| 2 | swarm × 10, 1.4 / 0 · runner × 2, 1.8 / 4 | 12 | 300 | 300 |
| 3 | swarm × 10, 1.2 / 0 · runner × 3, 1.5 / 5 | 13 | 340 | 340 |
| 4 | runner × 8, 1.2 / 0 · swarm × 6, 1.4 / 6 | 14 | 452 | 452 |
| 5 | runner × 8, 1.1 / 0 · swarm × 6, 1.3 / 7 · brute × 1, 1.0 / 10 | 15 | 592 | 595 |
| 6 | swarm × 10, 1.1 / 0 · runner × 6, 1.3 / 6 · brute × 1, 1.0 / 12 | 17 | 600 | 603 |
| 7 | runner × 8, 1.0 / 0 · swarm × 8, 1.2 / 5 · brute × 2, 1.4 / 10 | 18 | 776 | 782 |
| 8 | swarm × 10, 1.0 / 0 · runner × 8, 1.1 / 5 · brute × 2, 1.3 / 12 | 20 | 820 | 826 |
| 9 | runner × 10, 0.95 / 0 · swarm × 8, 1.1 / 5 · brute × 2, 1.2 / 12 | 20 | 856 | 862 |
| 10 | swarm × 10, 0.95 / 0 · runner × 10, 1.0 / 4 · brute × 3, 1.2 / 10 | 23 | 1040 | 1049 |
| 11 | runner × 11, 0.9 / 0 · swarm × 10, 1.0 / 4 · brute × 3, 1.1 / 10 | 24 | 1080 | 1089 |
| 12 | swarm × 12, 0.9 / 0 · runner × 10, 0.95 / 4 · brute × 4, 1.1 / 9 | 26 | 1224 | 1236 |

## Economy and scoring

- Start: **220 gold**, **20 base lives**.
- Kill an enemy: **+its bounty** (also added to the score).
- Clear a wave: **+40 + 8 × wave** (also added to the score). If you **call the
  next wave early**, the current wave's bonus is settled at once — but you get
  no extra gold for the shortcut, and any stragglers keep walking.
- An enemy that reaches the base costs **1 life**; **0 lives = loss**;
  clearing **wave 12 = win**.
- Between waves there is a **6 s** break, then the next wave starts
  automatically (`TD.NEXT_WAVE_DELAY`). You may skip the break with the call
  button / **Space**.
- Selling a tower returns `floor(invested × 0.7)` (`TD.SELL_RATE = 0.7`).

## Balance proof (machine-verified)

Three independent checks are run against the shipped tables (via `window.TD`):

**1. Feasibility — no wave is impossible.** For each wave,
`waveFeasibilityRatio(w) = bestKillBudget(w) / waveArmorWeightedHp(w)`, where
`bestKillBudget(w)` greedily buys the most damage-per-gold tower on the best
`exposure × dps` tiles using `goldAvailableByWave(w)` gold, and
`waveArmorWeightedHp(w)` sums `hp + armor` over the wave. **Every wave scores
≥ 1.5:**

| Wave | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| ratio | 11.57 | 13.47 | 18.36 | 23.68 | 24.72 | 32.17 | 32.70 | 40.73 | 48.16 | 52.81 | 59.76 | 63.26 |

`bestKillBudget` sums `exposure × dps` over **every** (tower, enemy) pair. Since
`exposureSeconds` measures the in-range arc by **sampling**, this is an upper
bound **modulo up to two sampling steps** — the sample straddling each range
boundary can round either way, so the error is two-way and at most
`2 × SAMPLE_STEP = 8 px`, i.e. **≤ 0.66 % of the 1216 px path**. The point of
the check is only to show that no wave is mathematically out of reach.

**2. Non-triviality — it is not a free win.** With **zero towers built** the
total damage dealt is **0**, and an "do nothing" run (never build, let waves
auto-advance) **loses on wave 2** — the 8 leaked `swarm` of wave 1 plus the 12
enemies of wave 2 drain exactly the 20 lives.

**3. A greedy bot actually wins.** A bot that, before each wave, upgrades any
maxed-efficiency tower it can afford and otherwise drops the strongest tower on
the tile with the highest `exposure × dps`, played the whole game through
`TD.tick()` and **cleared all 12 waves**:

| Result | Value |
|---|---|
| Final phase | **win** |
| Lives remaining | **20** |
| Gold remaining | **176** |
| Towers standing | **14** |
| Score | **2184** |

`exposureSeconds(col, row, rangeTiles, speed)` — the seconds a single enemy at
that speed spends inside a tower's range — is computed by **sampling the path
polyline every `SAMPLE_STEP = 4 px`** and dividing the in-range arc length by
the speed. It is strictly **monotonic**: a faster enemy always spends less time
in range (asserted in the harness).

## Determinism

There is **no randomness at all — not even seeded**: the wave table, the spawn
schedule and every spawn position are fixed data, and particle "hit bursts" are
placed at the exact event coordinates with **no jitter**. `newGame({ seed })`
accepts and echoes a seed for API uniformity with the other games in this
collection, but it does **not** affect the simulation — every seed produces a
bit-for-bit identical run. The whole model advances through a single
`update(dt)`, and geometry is owned by the `TILE/COLS/ROWS/WIDTH/HEIGHT`
constants — **never read back from the canvas**.

The game runs on **one `requestAnimationFrame` clock** that accumulates delta
time (clamped to 50 ms). No browser timer APIs are used: wave spawning, the
inter-wave break, win and lose are all explicit phases advanced by that same
clock, so `TD.tick()` and the on-screen game stay in lock-step.

## Test bridge (`window.TD`)

- **Constants:** `TILE` (32), `COLS` (20), `ROWS` (12), `WIDTH` (640),
  `HEIGHT` (384), `START_GOLD` (220), `START_LIVES` (20), `WAVE_COUNT` (12),
  `SELL_RATE` (0.7), `SAMPLE_STEP` (4), `NEXT_WAVE_DELAY` (6)
- **Pure data:** `towers()` (3 types × 3 levels), `towerSpec(type)`,
  `enemies()`, `waves()`, `path()`, `blocked()`
- **Pure geometry:** `buildable(col,row)`, `buildableSlots()`,
  `isOnPath(col,row)`, `pathLength()`, `pathPointAt(dist)`,
  `tileAtPoint(px,py)`, `pointOnPath(px,py)`
- **Pure math (side-effect free, deterministic):** `exposureSeconds(col,row,
  rangeTiles,speed)`, `towerDps(type,level,armor)`, `goldAvailableByWave(w)`,
  `waveHpTotal(w)`, `waveArmorWeightedHp(w)`, `bestKillBudget(w)`,
  `waveFeasibilityRatio(w)`
- **Queries:** `towerAt(col,row)`, `builtTowers()` / `towerList()`,
  `enemyAt(i)`, `enemyList()`, `waveState()`, `gold()`, `lives()`, `hudCache()`
- **Lifecycle:** `newGame(opts)` (`{ seed, wave }`), `start()`, `pause()`,
  `setSpeed(x)` (1 or 2), `selectTowerType(t)`, `placeTower(col,row[,type])`,
  `upgradeTower(col,row)`, `sellTower(col,row)`, `callNextWave()`,
  `tick(seconds[, step])`, `getState()`, `loadWave(n)`

> Note on names: `towers()` returns the **pure spec table** (the balance
> contract). The list of towers on the board is `builtTowers()` (alias
> `towerList()`), and is also on `getState().towers`.

`getState()` returns at least `{ phase, wave, lives, gold, score, speed,
towers:[{col,row,type,level}], enemies:[{type,hp,x,y,pathDist,slowT,alive}],
pendingCount, seed, ticks, selectedType, best }`.

**`tick(seconds[, step])` contract.** It advances the world **deterministically**
with no `requestAnimationFrame` and no wall clock (the current speed multiplier
scales the game time advanced), then **refreshes the DOM HUD** exactly once —
the same value-cached refresh the render loop runs every frame. A headless run
therefore stays in sync with the numbers on screen.

### Calibration (measured)

- `setSpeed(1); tick(1)` moves a `runner` **51.200 px** (= `1.6 × 32`, i.e.
  1.6 tiles) along the path.
- A level-1 `gun` against a `brute` (armor 3) deals **12.5 dps** =
  `2.5 × max(1, 8 − 3)`.

## Run

Just open `index.html` in a browser — zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is
remembered.
