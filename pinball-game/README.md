# Pinball

[简体中文](README.zh.md) · **[English](README.md)**

---

A single-table portrait pinball machine. The table is a **fixed logical canvas of
exactly 480 × 720 px** (CSS scales it to fit); the whole simulation is
`canvas` 2D, no camera and no scrolling. You get **3 balls**, **3 round
bumpers**, **2 flippers** and a **plunger**. Charge the plunger, fire the ball
up the right-hand lane, flick the flippers to keep it off the **drain gap** at
the bottom centre, and pile up a **streak multiplier** on the bumpers. Every
random draw comes from **one seeded stream**, so a game is fully reproducible.

## How to play

**Keyboard**

| Key | Action |
|---|---|
| **A** / **←** | left flipper (hold) |
| **D** / **→** | right flipper (hold) |
| **Space** | hold to charge the plunger, release to fire |
| **W** | nudge up |
| **S** | nudge down |
| **Enter** | start · resume · play again |
| **P** | pause / resume |
| **R** | new game |

**On-screen buttons / touch**

| Control | Action |
|---|---|
| **◀ Left** / **Right ▶** | hold the flipper (`pointerdown` / `pointerup`); a plain tap toggles it |
| **Launch** | hold to charge, release to fire; a plain click fires at full charge |
| **New game** | start a fresh game |

The canvas uses `touch-action: manipulation`. Flipper buttons respond to
`pointerdown` / `pointerup` / `pointercancel` / `pointerleave`, so a finger
sliding off a button releases the flipper.

## The table

The contour is **9 wall segments** in logical pixels. The side walls run from
`y = 140` to `y = 540`, then two funnels slope inward leaving a **drain gap**
between `x = 150` and `x = 330` at the bottom; a ball whose centre passes
`DRAIN_Y = 700` is lost. The **launch lane** is the narrow channel between
`x = 420` and `x = 456` (the right outer wall), closed by a floor at `y = 660`;
the ball rests on the plunger at `(438, 650)`.

- **Flippers** pivot at `(160, 600)` (left) and `(320, 600)` (right), each a
  capsule of length **70** and radius **7**. The left flipper sweeps from rest
  `0.45 rad` to active `−0.55 rad`; the right is the mirror image
  (`2.6916 rad` → `3.6916 rad`). Angular speed is **18 rad/s**.
- **Bumpers** (radius **22**) sit at `(240, 270)`, `(130, 320)` and
  `(330, 390)`.

### Constants (`PB.constants`)

| Constant | Value | Unit |
|---|--:|---|
| `W` / `H` | 480 / 720 | px |
| `BALL_R` | 9 | px |
| `GRAVITY` | 900 | px/s² |
| `MAX_SPEED` | 1400 | px/s |
| `PHYS_STEP` | 1/240 (= 0.0041667) | s |
| `MAX_SUBSTEPS` | 240 | sub-steps/update |
| `DRAIN_Y` | 700 | px |
| `DRAIN_X0` / `DRAIN_X1` | 150 / 330 | px |
| `BALLS` | 3 | balls/game |
| `DEFAULT_STEP` | 1/60 | s |
| `FLIPPER_LEN` | 70 | px |
| `FLIPPER_R` | 7 | px |
| `FLIPPER_REST_ANGLE` | 0.45 | rad |
| `FLIPPER_ACTIVE_ANGLE` | −0.55 | rad |
| `FLIPPER_SPEED` | 18 | rad/s |
| `FLIPPER_KICK` | 260 | px/s |
| `FLIP_RESTITUTION` | 0.7 | — |
| `BUMPER_R` | 22 | px |
| `BUMPER_KICK` | 320 | px/s |
| `BUMPER_REST` | 0.9 | — |
| `BUMPER_BASE` | 100 | points |
| `WALL_REST` | 0.86 | — |
| `DRAG` | 0 | 1/s |
| `STALL_SEC` | 6 | s |
| `STALL_SPEED` | 30 | px/s |
| `STALL_NUDGE` | 120 | px/s |
| `STREAK_TIMEOUT` | 3.5 | s |
| `STREAK_STEP` | 0.25 | ×/hit |
| `STREAK_MAX_MULT` | 5 | × |
| `BONUS_CHANCE` | 0.1 | probability |
| `BONUS_POINTS` | 500 | points |
| `LAUNCH_MIN` / `LAUNCH_MAX` | 700 / 1300 | px/s |
| `CHARGE_RATE` | 1 | charge/s |
| `AUTO_LAUNCH_SEC` | 1.5 | s |
| `BALL_MAX_SEC` | 8 | s |
| `NUDGE_MAX` | 3 | nudges/ball |
| `NUDGE_IMPULSE` | 180 | px/s |
| `NUDGE_SIDE` | 60 | px/s |
| `LANE_X` / `LANE_Y` | 438 / 650 | px |

## Scoring

Only bumpers score, and only consecutive bumper hits build the streak.

- The **k-th consecutive bumper hit** (k = 1, 2, 3, …) is worth
  `round(100 × min(1 + 0.25·(k − 1), 5))` points — i.e. **100, 125, 150, 175,
  200, …** capped at **500** from k = 17 on. This is `PB.bumperScore(streak)`,
  where `streak` is the number of consecutive hits **before** the hit (0 for the
  first one).
- The **streak** resets to 0 when the ball is lost, or after **3.5 s**
  (`STREAK_TIMEOUT`) with no scoring contact (a bumper or a flipper touch).
- On each bumper hit there is a **10 %** seeded chance of a **+500** bonus.
- The **best** score is stored in `localStorage` (inside `try/catch`) and shown
  on the HUD.

## Provably fair / provably terminating

These are properties of the shipped constants, checkable through `window.PB`.

**1. No tunnelling (arithmetic).** The fastest a ball can move between physics
sub-steps is one sub-step's worth:

```
maxStepDisplacement() = MAX_SPEED × PHYS_STEP = 1400 × (1/240) = 5.8333 px
```

The thinnest collider the ball can meet is a wall segment, which the ball sees
as `2 × BALL_R`:

```
thinnestCollider() = 2 × BALL_R = 2 × 9 = 18 px
```

so `5.8333 / 18 = 0.3241 < 1` — the ball can never skip past a collider in a
single sub-step. The bound holds for **any** `dt`: both `update()` and
`stepBall()` advance the model in **chunks of at most `MAX_SUBSTEPS × PHYS_STEP =
1 s`, sub-stepping each chunk at `h ≤ PHYS_STEP`** (a 5-second step is integrated
as five 1-second chunks, never as one long step, and no simulated time is
dropped). The clamp on the sub-step *count* and the chunk size are the same
budget, so `h ≤ PHYS_STEP` for every input.

**2. Bounded energy gain.** A flipper can inject energy, so the contact point's
speed is bounded by the flipper's tip speed
`FLIPPER_LEN × FLIPPER_SPEED = 70 × 18 = 1260 px/s ≤ MAX_SPEED`, and the ball's
speed magnitude is **hard-clamped to `MAX_SPEED` after every collision and after
every post-integration change** (bumper jitter, nudge, stall kick). So a ball
resting on an oscillating flipper cannot be pumped past the ceiling:

```
energyCeiling() = MAX_SPEED = 1400 px/s
```

Measured maximum speed while hammering the flippers for 20 000 sub-steps:
**1400.000 px/s** — exactly the ceiling, never above.

**3. The ball always drains (bounded run).** Left alone, a ball is forced down
by gravity plus a **stall guard** (`STALL_SEC = 6 s` under `STALL_SPEED`); an
**untouched-ball timer** (`BALL_MAX_SEC = 8 s`) is a last-resort cap, and the
plunger **auto-fires** after `AUTO_LAUNCH_SEC = 1.5 s`. A wasted plunge that
falls back into the lane **re-arms the plunger** rather than trapping the ball.
Measured across seeds 1–40 with **no input**: **every seed finishes**, the
**worst** full game took **10 s**, the **lowest** score was **300** (> 0), and
**all 120 balls reached the drain by themselves** — the time cap never had to
fire. No run produced a `NaN`/`Infinity` ball.

For scale, a trivial flipper bot (hold a flipper while the ball is on that side)
scored **3 175 – 37 425** over seeds 1–10, so the score genuinely tracks play.

## Determinism

`PB.newGame({ seed })` seeds **one** `mulberry32` stream; `PB.nextRandom()` is
the only consumer. The seed drives only the **bumper bonus roll** (10 %) and the
**±1 % bumper jitter** — nothing else. Geometry, gravity, collisions, the
plunger and the flippers are pure functions, so with the same seed and the same
fixed-step `PB.tick(seconds, step)` sequence you get a **bit-for-bit identical**
run (`getState()` compares equal). Driving the loop with real
`requestAnimationFrame` timestamps naturally varies the frame time, so on-screen
runs are **not** frame-identical — but a headless run through `tick()` is.
`stepBall(state, dt, world)` is pure: same inputs → byte-identical output, and
it never mutates its arguments.

## Test bridge (`window.PB`)

- **`constants`** — the frozen value table above.
- **`world()`** → `{ walls:[{ax,ay,bx,by}], bumpers:[{x,y,r,score}], flippers:[{side,x,y,len,r,restAngle,activeAngle,angle,omega,target,pressed}], drain:{y,x0,x1} }`.
- **`mulberry32(seed)`** — pure generator factory.
- **`nextRandom()`** — pulls the live game stream, returns `[0,1)`.
- **`segmentClosestPoint(px,py,ax,ay,bx,by)`** → `{x,y,t,dist}`.
- **`circleVsSegment(cx,cy,r,ax,ay,bx,by)`** → `null` or `{nx,ny,depth,t}`.
- **`circleVsCircle(ax,ay,ar,bx,by,br)`** → `null` or `{nx,ny,depth}`.
- **`circleVsAabb(cx,cy,r,minX,minY,maxX,maxY)`** → `null` or `{nx,ny,depth}`.
- **`reflect(vx,vy,nx,ny,restitution)`** → `{vx,vy}`.
- **`flipperAngle(side,t)`** — the flipper's angle after `t` s of its current motion. It reads the flipper's **live** state (so it is not pure with respect to time); for a pure projection use the `angle` carried inside `world()`.
- **`launchVelocity(charge)`** → `{vx,vy}` for `charge ∈ [0,1]`.
- **`bumperScore(streak)`** — points for the `(streak)`-th consecutive bumper hit.
- **`stepBall(state,dt,world)`** → `{ball:{x,y,vx,vy}, events:[…]}` (pure integrator).
- **`maxStepDisplacement()`** = 5.8333 · **`thinnestCollider()`** = 18 · **`energyCeiling()`** = 1400.
- **`toLogical(clientX,clientY)`** — real click → logical canvas coords, 0-width-safe.
- **`getState()`** → `{ phase, score, best, ballsLeft, ballNo, streak, ball:{x,y,vx,vy}, flippers:{left,right}, seed, rng:{seed,calls}, rngDraws, charge, nudges, awaitingLaunch, pause, over, clock, ticks, log }`. `rngDraws` is the same number as `rng.calls` — how many times the PRNG has been pulled; there are **two pulls per bumper hit** (the ±1 % jitter and the bonus roll), so it stays 0 until the first score.
- **`hudCache()`** — a copy of the HUD value cache (mirrors `getState()`).
- **`log()`** — recent event entries.
- **`newGame({seed})` · `start()` · `pause()` · `resume()` · `togglePause()`**.
- **`setFlipper(side,on)`** — `left`/`right`, boolean. **`chargePlunger(on)`** — hold/release. **`launch(charge)`** — fire directly. **`nudge(dir)`** — `'up'`/`'down'`.
- **`tick(seconds[, step])`** — advances the same `update(dt)` with no rAF and no
  timers, split into `step`-sized sub-steps, then runs the value-cached
  `updateHud()` exactly once and returns `getState()`.

### Calibration (measured)

- **Free fall.** In an empty world, `stepBall({x,y,vx:0,vy:0,r:9}, 1, empty)`
  reaches **`vy = 900` px/s** after 1 s — i.e. it gains exactly `GRAVITY`
  (900 px/s²) per second — and moves **451.875 px** downward. That equals
  `GRAVITY·t²/2 + GRAVITY·PHYS_STEP·t/2 = 450 + 1.875`, the exact value the
  semi-implicit integrator predicts.
- **No-tunnel chain.** `maxStepDisplacement() = 5.8333 px`,
  `thinnestCollider() = 18 px`, **ratio = 0.3241**.
- **Plunger.** `launchVelocity(0) = {vx:0, vy:−700}`,
  `launchVelocity(0.5) = {vx:0, vy:−1000}`,
  `launchVelocity(1) = {vx:0, vy:−1300}`.
- **Streak.** `bumperScore` for streaks 0…6 = **100, 125, 150, 175, 200, 225, 250**.
- **Energy.** Max ball speed under sustained flipper abuse = **1400.000 px/s**
  (= `energyCeiling()`).

## Run

Just open `index.html` in a browser — zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is
remembered.
