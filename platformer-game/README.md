# Platformer

[简体中文](README.zh.md) · **[English](README.md)**

---

A single-screen side-scrolling platformer. Each of the **10 levels** is a 32 × 18
ASCII map of 16 px tiles — exactly **512 × 288** logical pixels, one screen, **no
camera and no scrolling**. Run and jump from the spawn `S` to the glowing goal
door `G`, stomp patrolling enemies, dodge spikes, grab coins, and don't fall in
the gaps. Three lives, a 120-second timer per level, and physics that is 100%
deterministic.

## How to play

**Keyboard**

- **← →** or **A D** — move left / right.
- **Space**, **↑** or **W** — jump. **Hold it longer to jump higher** (release
  early for a short hop — see *variable jump height* below).
- **Shift** — run (hold it while moving).
- **R** — restart the current level. **P** — pause / resume.
- **Enter** — start from the ready screen, resume when paused, or play again
  after a game over.

**Touch**

- ◀ / ▶ pads move; the **Jump** button jumps (hold it for a higher jump).

## Legend

A level is a closed set of eight glyphs. `PF.legend()` returns this table.

| Glyph | Meaning |
|---|---|
| `.` | air |
| `#` | solid block (collides on all four sides) |
| `=` | one-way platform (stand on it from above, pass through it from below) |
| `S` | player spawn (exactly one per level) |
| `G` | goal door (at least one per level; touch it to clear the level) |
| `c` | coin (+10) |
| `e` | patrolling enemy (walks back and forth between walls and ledges) |
| `^` | spike (touch it and you die) |

## Rules and scoring

| Event | Effect |
|---|---|
| Touch **`G`** | clear the level, `score += 100 + coins collected this level × 10` |
| Collect a **coin** | +10 (coins reset on every death and every level) |
| **Stomp** an enemy (land on its head while falling) | enemy dies, you bounce back up |
| Touch a **spike**, get hit by an enemy from the side, fall off the map, or run out of time | lose **1 life** and **restart the whole level** (coins, enemies and the timer all reset) |
| Lives reach 0 | **Game over** overlay |
| Clear level 10 | **You win!** overlay |

Clearing a level, dying, or restarting all reset that level's coins, enemies and
timer — state stays small and fully deterministic. Your **best score** and
**highest unlocked level** are persisted in `localStorage` under
`litegame_platformer_best` (always wrapped in `try/catch`, so the game still runs
if storage is unavailable).

**Variable jump height.** Releasing the jump key while still rising multiplies
the upward speed by `JUMP_CUT` (0.45), so a tap gives a short hop and a full hold
gives the full ≈75 px jump. **Coyote time** (`COYOTE` = 0.10 s) lets you still
jump just after walking off a ledge, and the **jump buffer** (`BUFFER` = 0.12 s)
remembers a jump pressed just before you land and fires it on touchdown.

## Physics constants

Units are pixels (`px`) and seconds (`s`). All of these are exported as
constants on `window.PF`.

| Constant | Value | Unit | Meaning |
|---|---|---|---|
| `TILE` | 16 | px | one map cell |
| `COLS` × `ROWS` | 32 × 18 | cells | map size → `WIDTH` × `HEIGHT` = 512 × 288 px |
| `GRAVITY` | 1800 | px/s² | downward acceleration |
| `JUMP_V` | −520 | px/s | launch velocity (upward is negative) |
| `MAX_FALL` | 900 | px/s | terminal falling speed |
| `WALK` | 175 | px/s | horizontal speed |
| `RUN` | 265 | px/s | horizontal speed while holding Shift |
| `COYOTE` | 0.10 | s | grace window to jump after leaving the ground |
| `BUFFER` | 0.12 | s | window in which an early jump press still fires |
| `JUMP_CUT` | 0.45 | × | `vy` multiplier when the jump key is released |
| `ENEMY_SPEED` | 45 | px/s | patrol speed |
| `STOMP_BOUNCE` | −380 | px/s | rebound speed after stomping an enemy |
| `DEATH_TIME` | 0.8 | s | death animation length |
| `LEVEL_TIME` | 120 | s | per-level countdown |
| `LIVES_START` | 3 | lives | lives at the start of a game |

### Derived reach (and the measured numbers)

The `y` axis is integrated with an **average-velocity update**
(`y += ½·(vy_before + vy_after)·dt`), which for constant acceleration is
kinematically exact — so the *measured* apex matches the closed form to the
pixel.

- **Maximum jump height** = `JUMP_V² / (2·GRAVITY)` = 520² / 3600 = **75.11 px**
  ≈ **4.69 tiles**. Measured in-game: **75.10 px**.
- **Airtime** of a full jump = `2·|JUMP_V| / GRAVITY` = **0.578 s**.
- **Horizontal distance** = speed × airtime:
  - walking: `175 × 0.578` = **101.1 px = 6.32 tiles** (landing tile ≈ **+6**)
  - running: `265 × 0.578` = **153.1 px = 9.57 tiles**; measured **154.58 px =
    9.66 tiles** (landing tile **+10**)
- **Holding → move** measures exactly `WALK` per second: `move(1); tick(1)`
  moves the player **175.000 px** on flat ground.

So a running jump clears ~9–10 tiles and a full jump tops out at ~4.7 tiles
above the ground — every gap, step and platform in the game is sized to fit
inside that envelope.

## The 10 levels stay completable

Every level is **machine-verified** to be traversable. The proof is a breadth-first
search over a graph whose nodes are the tiles the player can stand on and whose
edges are actual jumps:

- **`standTiles(level)`** — every `{col, row}` where the tile and the tile above
  it are open and the tile below supports the player. These are the BFS nodes.
- **`simulateJump(level, col, row, dir, run)`** — launch from a stand tile with
  direction `dir` (−1 / 0 / 1) and optional run, integrate at **1/120 s** with the
  same `movePlayerCore` the live game uses, and return the first landing
  (`{ landCol, landRow, hitGoal, hitHazard }`, or `null` if the jump leaves the
  map). These are the BFS edges (skipping any that touch a `^`).

A level passes if BFS from its `S` reaches a stand-tile/arc that touches a `G`
without ever touching a `^`.

| Level | Theme | Reachable nodes | Solvable |
|---|---|---|---|
| 1 | First Steps — long flat opening, two gaps, small steps | 23 | **PASS** |
| 2 | Hop Up — one-way platforms introduce climbing | 35 | **PASS** |
| 3 | Patrol — enemies walk the ledges | 26 | **PASS** |
| 4 | Spikes — static hazards to jump over | 20 | **PASS** |
| 5 | Overhang — ceilings force low routes | 36 | **PASS** |
| 6 | Gauntlet — enemies + spikes + gaps | 22 | **PASS** |
| 7 | Towers — climb stacked one-way towers | 32 | **PASS** |
| 8 | Descent — plateaus at two heights over a low basin | 31 | **PASS** |
| 9 | Circuit — layered gaps, platforms, enemies, a spike | 34 | **PASS** |
| 10 | Finale — everything at once, tight | 30 | **PASS** |

All 10 levels pass. Every level also satisfies: exactly 32 × 18 rectangle · only
legend glyphs · exactly one `S` · at least one `G` · no `S`/`G`/`c`/`e`/`^` inside
a `#` · every enemy has a floor within 4 tiles below it.

## Determinism

Enemy facing comes from a **seeded** hash, `rngHash(seed, index)` — there is no
unseeded randomness anywhere. The seed lives in the state and is reported by
`getState().seed`, so `newGame({ seed })` is fully reproducible and different
seeds give different-but-reproducible enemy layouts. The background stars are
seeded the same way.

The whole game runs on **one `requestAnimationFrame` clock** that accumulates
delta time (clamped to 50 ms) and feeds a fixed **1/120 s** physics step.
`setTimeout` / `setInterval` are never used: death and level-clear are explicit
phases (`dying`, `levelclear`) with a `phaseTimer` advanced by the same clock.

The physics lives in a single pure function, `movePlayerCore(player, level, dt)`.
The live game and the test oracle `simulateJump` both call it, so the headless
traversability proof is a proof about the shipped code, not a parallel model.
Nothing outside `draw()` mutates state, so a step-driven run stays in lock-step
with the on-screen game.

## Test bridge

The page exposes a machine-readable model on `window.PF`:

- **Constants:** `TILE`, `COLS`, `ROWS`, `WIDTH`, `HEIGHT`, `GRAVITY`, `JUMP_V`,
  `MAX_FALL`, `WALK`, `RUN`, `COYOTE`, `BUFFER`, `JUMP_CUT`, `ENEMY_SPEED`,
  `STOMP_BOUNCE`, `DEATH_TIME`, `LEVEL_TIME`, `LIVES_START`
- **Levels:** `levels()` (array; each `{ index, map, rows, cols, coins, enemies,
  start, goals }`), `levelAt(i)`
- **Pure geometry:** `legend()`, `tileAt(level, col, row)`, `isSolid(level, col,
  row)`, `isOneWay(level, col, row)`, `isHazard(level, col, row)`
- **Reachability primitives (pure, side-effect free, deterministic):**
  `standTiles(level)`, `simulateJump(level, col, row, dir, run)`
- **Queries:** `playerState()`, `enemies()`, `enemyAt(i)`, `collectedCoins()`,
  `hudCache()`
- **Lifecycle:** `newGame(opts)` (`{ seed, level }`), `start()`, `pause()`,
  `move(dir)`, `jump(down)`, `restartLevel()`, `loadLevel(n)`, `tick(seconds[,
  step])`, `getState()`
- **PRNG:** `rngHash(seed, index)`, `nextRandom(state)`

`getState()` returns at least
`{ score, lives, level, phase, coins, coinsTotal, timeLeft, player, enemies,
collectedCoins, seed, ticks, best }` where `player` is
`{ x, y, vx, vy, onGround, facing }` and each enemy is
`{ x, y, vx, alive, col, row }`.

`move(dir)` takes `-1` / `1` / `0` (or `'left'` / `'right'`) and sets the held
direction, which `tick()` then integrates — so `move(1); tick(0.1)` slides the
player right for exactly 0.1 s. `jump(true)` presses and `jump(false)` releases
(the release applies the variable-height cut).

**`tick(seconds[, step])` contract.** It advances the world deterministically
with **no `requestAnimationFrame` and no wall clock**, then **refreshes the DOM
HUD** (the same value-cached refresh the render loop runs every frame). A
headless run therefore stays in sync with the numbers on screen. `tick(1)` with
no input does not move the player; `move(1); tick(1)` moves it by `WALK` pixels.

## Run

Just open `index.html` in a browser — zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is
remembered.
