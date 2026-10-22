# Pool

[English](README.md) | [中文](README.zh.md)

A single-table 8-ball **clear-the-table challenge**: fifteen object balls on an
**800 × 400 px** logical table with **six pockets**, one cue ball, and a score
that punishes every extra shot and every foul. Geometry, collisions and the
rack are all closed-form and seeded, so a game is reproducible from its seed
and the physics is verifiable from `window.PL` alone. The whole table is plain
DOM — no canvas — and every position is written as
`element.style.transform = 'translate(Xpx, Ypx)'`.

## How to play

Sink **all fifteen object balls in as few shots as possible**. The **8-ball must
go down last** — while any other object ball is still on the table it is a foul.

- **Cue ball** — a scratch (the cue ball drops) is a foul. It is re-spotted at
  the first free spot of a fixed ring search around the head spot
  `(200, 200)`, never on top of another ball and never inside a pocket mouth.
- **8-ball down early** — a foul. The 8 is re-spotted the same way and does
  **not** count as potted; the ball is put back, not credited.
- **Legal clear** — when the 8 drops as the *last* object ball the game ends and
  the shot count is compared with the stored best. If the last object ball and
  the 8 drop in the same shot, the 8 is judged at the moment the table settles:
  the table is otherwise clear, so it counts.
- **Phases** — `ready` (start overlay) → `aiming` → `rolling` → back to
  `aiming` … → `over`. `#btnPause` and `#btnShoot` are disabled while `ready`
  and once the table is clear; `#btnNew` and `#ovBtn` stay live in every phase,
  so there is always a way out. Pause only has meaning in `aiming` / `rolling`.
- **Score** — `potted × 100 − shots × 15 − fouls × 50`, floored at 0.
- **Best** — the *fewest shots* used to clear, kept in
  `localStorage['litegame_pool_best']` inside `try/catch` (a `file://` page has
  an opaque origin and may throw).

## Controls

| Key | Action |
|---|---|
| **←** / **A** | rotate the aim 0.02 rad counter-clockwise |
| **→** / **D** | rotate the aim 0.02 rad clockwise |
| **↑** / **W** | power +40 px/s |
| **↓** / **S** | power −40 px/s |
| **Space** | shoot with the current aim and power |
| **Enter** | start · shoot · play again once the table is clear |
| **P** | pause / resume |
| **R** | new game |

| Pointer | Action |
|---|---|
| Move over the table | aim at the pointer (only while `aiming`) |
| Click / tap the table | aim at that point |
| **◀** / **▶** | rotate the aim by 0.02 rad |
| **−** / **+** | power −40 / +40 px/s |
| **Shoot** | fire at the current aim and power |
| **Pause** / **New game** | pause-resume · re-rack and play |

The table is laid out at its logical size and scaled with CSS, so pointer
coordinates are converted with `getBoundingClientRect()` (`TABLE_W / rect.width`)
and clamped into `[0, TABLE_W] × [0, TABLE_H]`; a rect of width 0 (headless /
unstyled) falls back to 1:1 and still cannot produce `NaN`.

## Constants (`PL.constants`)

| Constant | Value | Unit |
|---|--:|---|
| `TABLE_W` | 800 | px |
| `TABLE_H` | 400 | px |
| `BALL_R` | 10 | px |
| `POCKET_R` | 20 | px |
| `BALL_COUNT` | 16 | balls |
| `PHYS_H` | 1/240 (= 0.00416667) | s |
| `MAX_CHUNK` | 0.25 | s |
| `MAX_SPEED` | 1400 | px/s |
| `MIN_SPEED` | 200 | px/s |
| `FRICTION` | 260 | px/s² |
| `STOP_SPEED` | 6 | px/s |
| `WALL_RESTITUTION` | 0.86 | — |
| `BALL_RESTITUTION` | 0.96 | — |
| `CUE_START_X` | 200 | px |
| `CUE_START_Y` | 200 | px |
| `RACK_APEX_X` | 560 | px |
| `RACK_APEX_Y` | 200 | px |
| `RACK_GAP` | 20.2 | px |
| `RACK_DX` | 17.4937 | px |
| `AIM_STEP` | 0.02 | rad |
| `POWER_STEP` | 40 | px/s |
| `BALL_POINTS` | 100 | points |
| `SHOT_PENALTY` | 15 | points |
| `FOUL_PENALTY` | 50 | points |
| `LOG_SIZE` | 64 | entries |

`RACK_DX` is not a hand-written literal: the source computes
`RACK_GAP × √3 / 2 = 20.2 × 0.8660254 = 17.493713…` (a perfect triangular
lattice). `setPower` clamps into `[MIN_SPEED, MAX_SPEED]` — the same two
constants, exposed under their canonical names.

## Why the physics is sound

**P1 — no tunnelling, by arithmetic.** Inside `advance()` the model moves at
most one physics cell per sub-step, and a sub-step is never longer than
`PHYS_H`:

```
MAX_SPEED × PHYS_H = 1400 / 240 = 5.8333 px < 2 × BALL_R = 20 px
2 × MAX_SPEED × PHYS_H = 11.6667 px < 20 px          (two balls closing head-on)
```

so a ball can never jump over another ball's contact circle nor over its own
diameter in a single cell. Contact is an **overlap** test (`dist < 2·BALL_R`),
not an equality test, so the bound holds with room to spare.

**P2 — fixed grid, so the submission step size cannot change the result.**
`advance(balls, h)` cuts `h` into `round(h / PHYS_H)` cells of exactly `PHYS_H`
plus, only if `h` is not a multiple, one remainder cell of `h mod PHYS_H ≤ PHYS_H`.
It never re-divides `h` by the number of cells (that is what would widen a
coarse step and let balls pass through each other). Consequence: for any `h`
that is an integer multiple of `PHYS_H`, one call is bit-for-bit the same as the
equivalent sequence of smaller calls.

```
1/30 in one call  ≡  1/240 in eight calls      measured max |Δ| over x,y,vx,vy = 0
1/60 in one call  ≡  1/240 in four calls       measured max |Δ| = 0
0.25 in one call  ≡  1/240 in sixty calls      measured max |Δ| = 0
```

**P3 — a ball is always on the table.** Every cell ends with a positional clamp
to `BALL_R ≤ x ≤ TABLE_W − BALL_R` and `BALL_R ≤ y ≤ TABLE_H − BALL_R`; the
cushion pass also clamps before it reflects. The collision de-overlap can push a
squeezed ball a fraction of a pixel over a cushion, which the end-of-cell clamp
removes with no change to velocity, so the bound holds at the end of *every*
`advance()` call and therefore in every `getState()`.

**P4 — energy never increases.** Each bounce multiplies the relevant normal
component, so the kinetic energy of that component is scaled by the square:

```
ball-ball: BALL_RESTITUTION² = 0.96² = 0.9216
cushion:    WALL_RESTITUTION² = 0.86² = 0.7396
friction:   |v| ← max(0, |v| − FRICTION·dt)   (never increases |v|)
```

The cushion reflection only fires when the normal velocity points *into* the
cushion, so clamping a ball that is already moving inward can never inject
energy. De-overlap moves centres, not velocities, so it adds no energy either.

**P5 — equal-mass collision, tangential motion untouched.** With
`n = (b − a)/|b − a|`, `vn = (v_b − v_a)·n`:

```
j = −(1 + BALL_RESTITUTION) · vn / 2      (half of the impulse to each ball)
v_a ← v_a − j·n ,  v_b ← v_b + j·n
```

so the relative normal speed becomes `−0.96 · vn` (with `RESTITUTION = 1` the
normal velocities are swapped exactly). There is no ball-ball friction, so the
tangential components are unchanged — a cut shot takes the line of centres.

**P6 — every shot stops, in closed form.** Coulomb friction is constant, so the
distance and time to rest are exact:

```
full power:  MAX_SPEED² / (2·FRICTION) = 1960000 / 520 = 3769.2308 px
             MAX_SPEED / FRICTION       = 1400 / 260   =    5.3846 s
softest:     MIN_SPEED² / (2·FRICTION) = 40000 / 520    =   76.9231 px
             MIN_SPEED / FRICTION       = 200 / 260     =    0.7692 s
```

A ball is parked the first time its speed would fall to `STOP_SPEED` or below,
so every shot settles in at most `5.3846 s` plus the time spent bouncing (which
only removes energy). Measured: a full-power break is at rest after **3.392 s**.

**P7 — the rack is provable, not random-looking.** `rack(seed)` places a
perfect triangular lattice from `RACK_APEX_X/Y`, `RACK_GAP` and
`RACK_DX = RACK_GAP·√3/2`, so every neighbour distance is exactly `20.2 px`
(≥ `2·BALL_R = 20 px`, margin 0.2 px) and the whole rack sits inside
`x ∈ [560, 629.9749]`, `y ∈ [159.6, 240.4]`, i.e. at least
`BALL_R = 10 px` clear of every cushion. The **8-ball is fixed at the centre of
the third row**:

```
x = RACK_APEX_X + 2·RACK_DX = 560 + 34.9874 = 594.9874
y = RACK_APEX_Y             = 200
```

The other fourteen ids are shuffled by one `mulberry32` stream, so the same seed
gives the same rack and a different seed gives a different one. The cue ball at
`(200, 200)` has a **clear 360 px line to the apex ball**: the nearest other
ball centre is `20.2 px` from that segment, i.e. `0.2 px` more than the `20 px`
contact distance, so no ball can block the break. Measured over the rack:
minimum pairwise centre distance **20.200000 px**, balls outside the cushions
**0**.

## Test bridge (`window.PL`)

- **`constants`** — the frozen table above, every name exposed as a number.
- **`rack(seed)`** → the 16 ball objects (`cue` first, then the triangle in
  lattice order). Pure: no `Math.random()`, same seed → same array.
- **`advance(balls, h)`** → `{ balls, events }`. Pure: it deep-copies its input
  and never mutates it (verified: the argument's JSON is identical before and
  after). Potted balls are **removed** from the returned array and reported as
  `{t, type:'pot', a:id, b:null, x:pocketX, y:pocketY}`. Event types are
  `'ball'` (with both ids), `'wall'`, `'pot'`, `'stop'`; `t` is the cumulative
  time from the start of that call, so event times are non-decreasing.
- **`pockets()`** → six `{x,y,r}` entries: `(0,0) (0,400) (400,0) (400,400)
  (800,0) (800,400)`.
- **`scoreOf({potted, shots, fouls})`** → the integer score, floored at 0.
  `potted` may be a count or the array itself.
- **`stopDistance(v)`** = `v²/(2·FRICTION)`, **`stopTime(v)`** = `v/FRICTION`,
  **`substepTravel()`** = `MAX_SPEED·PHYS_H`, **`energyRatio(e)`** = `e²`.
- **`respotSpot(balls)`** → `{x, y}`: the first free spot of a deterministic
  ring search around the head spot (clear of balls, cushions and pocket
  mouths). Pure with respect to its argument.
- **`getState()`** → a deep copy: `{phase, paused, seed, shots, fouls,
  potted:[ids], remain, score, best, aim, power, elapsed, over, balls:[…]}`.
- **`hudCache()`** → a copy of the HUD value cache (`score`, `best`, `shots`,
  `potted`, `fouls`, `remain`, `msg`, `status`, `pauseLabel`, `pauseOff`); every
  value is the string actually written to the DOM.
- **`log()`** → a copy of the last `LOG_SIZE = 64` events.
- **`newGame({seed})` · `start()` · `pause()` · `resume()` · `togglePause()`**.
- **`aimAt(x,y)`** (absolute table coordinates — the aim becomes the direction
  from the cue ball to that point), **`rotateAim(d)`** (radians),
  **`setPower(p)`** (clamped to `[MIN_SPEED, MAX_SPEED]`), **`shoot()`**
  (no-op unless `phase === 'aiming'` and the game is not paused).
- **`tick(seconds, step)`** → `getState()`. It is the **only channel that can
  feed a coarse step into `advance()`**: `seconds` is walked in chunks of
  `step` (default `PHYS_H`, capped at `MAX_CHUNK`), each chunk calls `advance()`,
  then the HUD is refreshed once. Because of P2, `tick(2, 1/30)` and
  `tick(2, 1/240)` produce the same **ball** state — measured max `|Δ|` = **0**
  over `x, y, vx, vy`. `elapsed` is the one field that parts company: it stops
  at the end of the chunk in which the last ball settled, so a coarser step can
  overshoot the true settle time by up to one chunk. `tick(8)` and `tick(10)`
  over a whole game agree in *every* field, because both settle inside the same
  chunk.

Stub constraints this page is written against: `requestAnimationFrame` is the
only clock (no `setTimeout` anywhere, nothing is driven by an interval);
`document.querySelectorAll()` returns `[]` in the smoke stub, so every element
is fetched with `getElementById`; `getAttribute()` returns `null` and
`setAttribute()` is a no-op there, so no state is read back from the DOM;
`localStorage` has no `removeItem` and may throw, so both accesses are wrapped;
`el.style` is a plain object in which **direct property assignment persists**,
which is why every position is a `style.transform` write and never a CSS custom
property.

## Determinism

- `rack(seed)` is pure: one `mulberry32(seed)` stream drives one Fisher-Yates
  shuffle of the fourteen non-eight ids, and nothing else. The 8-ball, the cue
  ball and all fifteen lattice positions are constants of the geometry.
- `advance(balls, h)` is pure and fixed-grid: identical input → identical
  output, and the input array is never touched.
- The live game has **no other randomness** — aim, power, and the rules are all
  driven by explicit input — so `newGame({seed: 1})`, `start()`, the same
  `shoot()`/`tick()` sequence reproduces the same run. On-screen play is *not*
  frame-identical, because the rAF timestamp varies the per-frame `dt`; a
  headless run through `tick()` is.

## Run

Open `index.html` in a browser — zero dependencies, no build step. The page
carries a built-in English / 简体中文 switch at the top and remembers the
choice.
