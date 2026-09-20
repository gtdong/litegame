# Pac-Man

[简体中文](README.zh.md) · **[English](README.md)**

---

The classic arcade chase. Steer Pac-Man around the maze, eat every pellet, dodge the four ghosts — and grab a power pellet to turn the tables and eat *them*.

## How to play

- **Move** with the arrow keys or `W` / `A` / `S` / `D`. The direction you press is remembered and applied at the next junction, just like the arcade original. Running into a wall simply stops Pac-Man.
- **Pellets** are worth 10 points, **power pellets** 50. Clearing every pellet on the board completes the level.
- **Side tunnels** on the middle row wrap Pac-Man (and the ghosts) straight across the board.
- **Power pellet**: the four ghosts turn blue, slow down and reverse. While they are blue you can eat them for a **200 → 400 → 800 → 1600** chain. A blue ghost flashes white just before it recovers.
- **Eaten ghosts** turn into a pair of eyes that race back to the ghost house, then rejoin the chase.
- **Lives**: you start with 3. Touch a ghost while it is *not* blue and you lose a life and play a death animation. Losing the last life ends the game.

## The four ghosts

Each ghost has its own targeting rule, exactly as in the arcade:

| Ghost | Colour | Target when chasing |
|---|---|---|
| **Blinky** | red | Pac-Man's current tile |
| **Pinky** | pink | the tile **4 ahead** of Pac-Man |
| **Inky** | cyan | Pac-Man's tile mirrored through Blinky (vector reflection) |
| **Clyde** | orange | Pac-Man when far away, but flees to his corner when within **8 tiles** |

Ghosts alternate between **Scatter** (head to a fixed corner) and **Chase** on a level-based timer. Every mode switch forces a single reversal; otherwise ghosts never turn back of their own accord. Decisions are fully **deterministic**: ties are broken with the classic priority **up → left → down → right**, so the same state always produces the same move (handy for exhaustive testing).

## Scoring

| Event | Points |
|---|---|
| Pellet | 10 |
| Power pellet | 50 |
| 1st / 2nd / 3rd / 4th ghost in a chain | 200 / 400 / 800 / 1600 |

## Run

Just open `index.html` in a browser. Zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered.

## Test bridge

The page exposes a stable `window.PM` object so the game can be driven headlessly:

```js
PM.COLS, PM.ROWS, PM.TILE          // maze dimensions and tile size
PM.maze()                          // the raw maze as an array of flat strings
PM.isWall(r, c)                    // true for walls / out of bounds
PM.canWalk(r, c)                   // passable by Pac-Man (tunnel wrap aware)
PM.wrap(r, c)                      // normalise a tunnel column -> { r, c }
PM.ghostTarget(name, mode, st)     // pure: { r, c } target tile
PM.ghostNextDir(name, st)          // pure: 'up' | 'down' | 'left' | 'right'
PM.newGame({ level })              // reset to a fully deterministic state
PM.getState()                      // { score, lives, level, phase, pelletsLeft,
                                   //   pac, ghosts }
PM.start()                         // leave the ready state
PM.tick(seconds[, step])           // advance the simulation deterministically
```

`ghostTarget` and `ghostNextDir` are pure functions — they depend only on their arguments, never on the animation frame or the canvas — so they can be exercised exhaustively.

While **frightened**, a ghost picks its turn with a deterministic pseudo-random rule (a hash of the ghost's name, its current tile and the fright session), mirroring the arcade's randomised blue-ghost wander while staying fully reproducible for a given input.
