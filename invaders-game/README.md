# Space Invaders

[简体中文](README.zh.md) · **[English](README.md)**

---

A faithful remake of the classic arcade game. An 11 × 5 fleet of aliens marches left and right, dropping a whole cell every time it reaches a wall — and it marches **faster the fewer aliens survive**. Shoot them all before they reach your defence line, hide behind four per-pixel destructible shields, and grab the bonus UFO when it streaks across the top. Three lives, endless waves.

## How to play

- **Arrow keys / A D** move the ship (hold to keep moving). **Space / ArrowUp / W / Enter** fires. On touch devices use the ◀ ▶ pads and the **Fire** button.
- **One bullet at a time** — the classic rule. Your next shot only leaves the barrel once the previous bullet has hit something or left the screen.
- **The fleet marches in discrete steps.** Each step nudges the whole formation sideways; when its edge touches the wall it drops **one cell** and reverses. As aliens die the step interval shrinks, so the last survivor darts across the screen.
- **Shields are destroyed pixel by pixel.** Each of the four bunkers is a bitmap that both your bullets (from below) and the alien bombs (from above) nibble away, carving holes you can shoot or be shot through. They are *not* all-or-nothing.
- **The UFO** crosses the top every so often while the fleet is still large; shooting it pays a random-but-seeded reward (50 / 100 / 150 / 300).
- **Alien bombs** are dropped from the lowest living alien in a chosen column. Being hit costs a life; the fleet returns to its start pose and you carry on.
- **If the fleet reaches the defence line, the invasion wins** and the game is over immediately — the classic rule.
- **P** or the on-screen button pauses.

## Scoring

| Event | Points |
|---|---|
| Kill a **top-row** alien | +30 |
| Kill a **middle-row** alien (rows 1–2) | +20 |
| Kill a **bottom-row** alien (rows 3–4) | +10 |
| Shoot the **UFO** | +50 / +100 / +150 / +300 (seeded random) |
| Clear a wave | 300 + 100 × wave |

## Board

The playfield is **480 × 560** logical pixels. Geometry is owned by the `CELL` / `COLS` / `ROWS` / `FIELD_W` / `FIELD_H` constants and is never derived from the canvas.

| Element | Layout |
|---|---|
| Alien fleet | 11 columns × 5 rows, one `CELL` (28 px) each |
| Alien type by row | row 0 → `A`, rows 1–2 → `B`, rows 3–4 → `C` |
| Shields | 4 bunkers, 22 × 16 cells each, 2 px per cell, centred at x = 60 / 180 / 300 / 420 |
| Player ship | 40 × 22 px, centred at y = 500 |
| Defence line | fleet bottom reaching y = 470 ends the game |

## Waves

Each new wave starts **lower** and marches **faster**:

| Parameter | wave 1 | each wave |
|---|---|---|
| Fleet top y | 48 | +6 / wave (capped at 88) |
| Slowest step interval | 0.50 s | −0.02 s (floor 0.36 s) |
| Fastest step interval | 0.15 s | `stepBase × 0.3` |
| UFO period | 40 steps | −3 steps (floor 20) |

`stepInterval(aliveCount, wave)` interpolates between the fastest and slowest
interval in proportion to the surviving alien count: 55 alive → 0.500 s,
25 alive → 0.309 s, 1 alive → 0.156 s (all at wave 1).

### Every wave stays completable

Both difficulty dials (a lower start and a shorter step interval) cost the
player *fleet steps*, and with the one-bullet rule the kill rate is bounded by
the bullet's flight time. To guarantee a wave can always be won, the fleet's
**budget** — the number of steps it survives before it reaches the defence line
— is kept comfortably above the steps an ideal player needs to kill all 55
aliens, and the bullet is fast (800 px/s) so that cost stays low:

| Wave | Budget (steps) | Ideal player (50% hits) | Ratio |
|---|---|---|---|
| 1 | 769 | 190 | 4.05 |
| 4 | 699 | 211 | 3.31 |
| 8 | 629 | 248 | 2.54 |
| 12 | 629 | 248 | 2.54 |

The ratio falls as the waves get harder but never approaches 1, so waves 1–12
are all reachable. A deliberately sloppy bot that wastes ~60% of its shots
still clears waves 1–8.

## Determinism

Every alien position is a **pure function of the step count** —
`formationState(steps, aliveCount, wave)` returns `{ offsetX, originY, dir }`; no
per-frame floating position is ever accumulated, so any step index can be
recomputed exactly. The time between steps is the pure function
`stepInterval(aliveCount, wave)`.

All randomness (which column a bomb is dropped from, which reward a UFO carries)
comes from a **seeded** pseudo-random function of `(seed, counter)` — there is no
`Math.random()` anywhere. The seed and its counters live inside the game state
(`getState().rng`) and are exposed as parameters, so `newGame({ seed })` is fully
reproducible and different seeds produce different — but individually
reproducible — bomb and UFO sequences. The player ship and the bullets are drawn
with smooth per-time interpolation; the aliens step discretely (classic).

Nothing outside `draw()` mutates state, so a headless step-driven run stays in
lock-step with the on-screen game.

## Test bridge

The page exposes a machine-readable model on `window.SI`:

- **Constants:** `COLS`, `ROWS`, `CELL`, `FIELD_W`, `FIELD_H`
- **Pure geometry / scoring:** `waveConfig(wave)`, `stepInterval(aliveCount, wave)`,
  `formationState(steps, aliveCount, wave)`, `scoreFor(kind, row)`,
  `ufoScoreAt(seed, ufoIndex)`, `bombColumnFor(stepIndex, seed, aliveColumns)`,
  `nextRandom(state)`
- **Pure shield model:** `bunkers()`, `bunkerBitmap(i)`,
  `damageBunker(bunkerIndex, x, y, radius)`, `hitTestBunker(bunkerIndex, x, y)`,
  `makeBunker()`
- **Queries:** `invaderAt(state, index)`, `invaderBox(state, index)`,
  `playerBulletAt(t)`, `bulletY(y0, t)`, `bombAt(i)`, `bombs()`
- **Lifecycle:** `newGame(opts)`, `fire()`, `move(dir)`, `start()`, `pause()`,
  `tick(seconds[, step])`, `getState()`

`damageBunker` and `hitTestBunker` operate in **bunker-local cell coordinates**
(0..21 across, 0..15 down) and are non-mutating: `damageBunker` returns a *new*
bitmap and leaves the stored one untouched. `move(dir)` takes `-1` / `1` / `0`
(or `'left'` / `'right'`) and sets the held direction, which `tick()` then
integrates — so `move(1); tick(0.1)` slides the ship for exactly 0.1 s.

`tick()` advances the world deterministically without any wall clock and then
refreshes the DOM HUD (the same value-cached refresh the render loop runs every
frame), so a headless run stays in sync with the numbers on screen.

`getState()` returns
`{ score, lives, wave, phase, invadersLeft, rng, ship, bullets, bombs, bunkers, … }`
where `bunkers` is the number of shields still holding at least one solid cell,
plus extras (`steps`, `stepInterval`, `formation`, `invaders`, `aliveColumns`,
`ufo`, `bunkerSolid`) that make exhaustive and differential testing easy.

## Run

Just open `index.html` in a browser. Zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered.
