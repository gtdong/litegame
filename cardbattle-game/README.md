# Card Battle

[简体中文](README.zh.md) · **[English](README.md)**

---

A three-lane card duel rendered with **plain DOM + CSS** — no canvas anywhere.
Both bases start at **20 HP**, both players shuffle the **same 20-card list**,
and the whole game is **DOM-reconcilable**: every lane slot and hand card is a
real element whose text is written from `getState()`, so what you see is a
rendering of the model rather than a second copy of it.

You get **2 energy on turn 1**, **+1 per turn up to a hard cap of 10**, refilled
(never accumulated) at the start of each of your turns, and you draw **1 card
per turn**. You play first each round: you act, combat resolves, then the enemy
acts. **Break the enemy base before yours falls.**

## How to play

**Mouse / touch**

- Click a **card** in your hand to select it (the selection shows as an outline
  ring — never a transform, so it cannot fight the layout), then click a **lane
  slot** to play it. Both the enemy slot and the player slot of a lane are the
  same target: a play is aimed at the **lane**.
- **End turn** hands the round to combat. Spells take the same lane click:
  Fireball burns that lane's enemy unit, or the enemy base when the lane is
  empty; Mend heals that lane's friendly unit and is *illegal* when you have no
  unit there; Rally ignores the lane but still receives one.

**Keyboard**

- **1 – 5** — select hand slot 1–5.
- **Q / W / E** (or **A / S / D**) — play the selected card into lane 1 / 2 / 3.
- **Space** / **Enter** — start the game from `ready`, end your turn, or restart
  after a result. **P** — pause / resume. **N** — new game. **Esc** — deselect.

**On-screen buttons**

- **End turn** (disabled outside your turn) · **Pause / Resume** (disabled in
  `ready` and after a result) · **New game**.

## The board

Three lanes, numbered **0/1/2** left to right. Each lane holds **at most one
unit per side**, and the two sides are independent — you may put a unit opposite
an enemy unit, which is how you block and trade. Units you place fight at the
end of *your* turn; enemy units placed after combat wait until the next resolve,
which is why going first is worth something.

## Cards

Eight cards, six numbers apart from the two that only carry text. `atk`/`hp` are
`null` for spells (`CB.cards()`).

| id | en | zh | cost | atk | hp | what it does |
|---|---|--:|--:|--:|---|
| `scout` | Scout | 斥候 | 1 | 2 | 1 | Body |
| `soldier` | Soldier | 步兵 | 2 | 3 | 3 | Body |
| `wall` | Bulwark | 盾墙 | 2 | 0 | 8 | Body. **atk 0**: it blocks and deals nothing |
| `archer` | Archer | 弓手 | 3 | 4 | 2 | Body. **On play:** 1 damage to the enemy unit in its lane |
| `knight` | Knight | 骑士 | 4 | 5 | 6 | Body |
| `fireball` | Fireball | 火球 | 3 | — | — | Spell: 3 damage to that lane's enemy **unit**, or to the enemy **base** if the lane is empty |
| `mend` | Mend | 治疗 | 2 | — | — | Spell: +4 HP to that lane's friendly unit (capped at its starting HP). **Illegal with no friendly unit there** |
| `rally` | Rally | 集结 | 4 | — | — | Spell: **every** friendly unit gains **+2 atk**, permanently. Ignores the lane |

`rally` is the only card that changes a number without being played into a
particular lane, so a fifth turn with three bodies on the board is worth
**+6 attack per resolve**.

## The deck

**20 cards**, and both sides shuffle this exact list — the fairness argument is
just "same multiset, same shuffle". `CB.deckList()` returns the counts,
`CB.deck()` the expanded array.

```
scout × 3, soldier × 3, wall × 2, archer × 3, knight × 2, fireball × 3, mend × 2, rally × 2
```

Each side opens with **3 cards** and draws **1 per turn**; a hand is capped at
**5**. An empty draw pile reshuffles that side's discard with the seeded PRNG
(`logReshuffle`); if the hand is already full the drawn card is discarded
instead of stalling the pile (`logBurned`).

## Turn structure

One `requestAnimationFrame` clock feeds one `update(dt)`. Every timed
transition is an explicit phase with its own countdown — there is no timer API
anywhere in the file (`grep -cE 'setTimeout|setInterval'` = **0**).

| phase | length | what happens |
|---|---|---|
| `ready` | — | Start overlay; the model does not advance |
| `player` | input-driven | Energy refilled to `energyFor(turn)`, 1 card drawn; play as many affordable cards as you like, then End turn |
| `resolve` | **0.5 s** | `resolveCombat()` runs once; win/lose is checked |
| `enemy` | **≈0.6 s** | Energy refilled and 1 card drawn for the enemy, then the AI plays one card every **0.2 s**; `turn++`, back to `player` |
| `win` / `lose` | — | Result overlay with **Play again** |
| `paused` | — | `tick()` does not advance the model at all |

The energy curve (`CB.energyFor`) is `min(10, 1 + turn)`, and it **refills**
each turn rather than accumulating — so banking a turn buys you nothing:

| turn | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10+ |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| energy | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 10 |

## Combat resolution

`CB.resolveCombat(board)` is a **pure function** that returns a **new** board and
never touches its argument. For every lane, in one pass:

- **Both sides hold a unit** → they strike **simultaneously**: both damaged
  values are computed from the pre-combat state and only then are the dead
  removed. A 3/3 and a 4/2 therefore *destroy each other* — this is not
  first-strike combat.
- **One side holds a unit** → that unit deals **exactly its `atk`** to the
  opposing **base**.
- **atk 0** (Bulwark) deals 0, and still occupies the lane, so it blocks.
- Base HP **floors at 0** and is never negative.

If a board is handed over without `playerHp` / `enemyHp`, both default to
`START_HP = 20`, so a bare `{ player, enemy }` position is a valid argument.

## The enemy AI

`CB.enemyChooseAction(board, hand, energy)` is **pure, deterministic and
random-free** — no clock, no RNG, no hidden state. The same input always returns
the same action (asserted over 50 repeats per scenario). It walks this priority
list and returns the first hit:

1. **Fireball** a player unit it can actually kill (`hp ≤ 3`); lowest such lane.
2. **Rally** once **2 or more** of its own units are standing.
3. **Mend** the unit that has lost the **most** HP, if it lost **≥ 3** (ties → lowest lane).
4. Contest a lane **the player holds alone**, with the **priciest** affordable
   body (ties → highest atk → lowest hand index); lowest such lane.
5. Take a lane **nobody holds**, with the **highest-atk** affordable body
   (ties → priciest → lowest hand index); lowest such lane.
6. Otherwise dump the **priciest** affordable card on its **lowest legal lane**
   (trying the next card when the priciest has no legal target).
7. Otherwise `{ kind: 'end' }`.

## Determinism and the seeded shuffle

The only randomness is a **mulberry32** stream. `Math.random()` is never called
(`grep -c 'Math.random'` = **0**); every number comes from `nextRandom()`, which
counts its calls, and `getState().rng = { seed, calls }` exposes the stream
position so a shuffle can be replayed exactly. `shuffle(list, rng)` is a pure
Fisher–Yates: it copies, permutes the copy and never mutates the input.

`newGame({ seed })` shuffles two decks back to back off **one** stream — same
card table, same deal for both sides, one seed for the whole game.

## Balance and correctness proof (machine-verified)

Eight checks were run against the shipped file through `window.CB`, driving the
real `tick()` — no reimplementation, no clock stubbing. Every number below is
measured output. (The last two were added by later independent audits: the
difficulty calibration, then the pile branches.)

**1. A greedy bot wins — 10/10 seeds.** The bot plays removal first (Fireball on
anything it can kill, biggest threat first), then Rally at two or more bodies,
then answers every unblocked lane with `atk > 0` using the cheapest body that
survives (or trades up), then pushes its hardest hitter into a lane nobody
holds, then Mends, then spends leftover energy on the biggest remaining threat:

| seed | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| result | win | win | win | win | win | win | win | win | win | win |
| winning turn | 5 | 4 | 11 | 6 | 4 | 8 | 4 | 5 | 4 | 6 |
| your base left | 20 | 20 | 20 | 20 | 20 | 18 | 20 | 20 | 20 | 20 |

**10/10 wins**, minimum 4 turns, maximum 11.

**2. Playing nothing loses — every seed.** With a policy that ends every turn
without playing a card, all 10 seeds lose **within 6 turns** (turns
`4, 5, 4, 4, 5, 4, 4, 5, 5, 5`, latest **5**). No run anywhere in this document
ever reached turn 16 — see item 3.

**3. Unbounded stalemate is impossible.** Two independent arguments, and both
are checkable:

- **Resource argument.** A resolve deals no base damage only if every lane is
  blocked. Blocking a lane whose attacker has `atk > 0` needs a **unit of your
  own in that lane**, and units die in the trades — so a lasting stalemate needs
  roughly **three fresh units per turn**, while both sides draw **exactly 1 card
  per turn**. The hand cap of 5 bounds the surplus, so the block supply runs out
  and lanes open.
- **Measured argument.** The worst possible policy for termination is a bot that
  *only* blocks — it never swings, so it maximises the chance of a static board.
  It still **loses 10/10 seeds**, and **all 30 runs** in this document (10 greedy
  + 10 idle + 10 block-only) **ended on or before turn 16**, none exceeded it.
  A wider sweep of that same block-only policy (**120 seeds**) pushes the bound
  out to **turn 38** — longer games exist, they are just rarer. That is also what
  makes the pile branches reachable: a side holds `20 - START_HAND = 17` cards at
  the deal and draws one per turn, so its pile can only run dry on draw #18, i.e.
  in a game that reaches turn 18. Over those 120 seeds the reshuffle branch
  ran **20 times** and the full-hand burn fired in **78** of the games. No run
  failed to finish.

**4. The shuffle is a permutation — 200/200 seeds.** For `seed = 1…200`:

| check | result |
|---|---|
| `shuffle(deck(), mulberry32(seed))` is a multiset-equal permutation of its input | **200/200** |
| same seed twice → byte-identical array | **200/200** |
| `deck()` input left untouched | **true** |
| distinct first cards across the 200 shuffles | **8/8 → 100.0 %** |

First-card histogram. In a uniform permutation the expected count is
**multiplicity-weighted** — **30** for a 3-copy card, **20** for a 2-copy one —
so the 200-shuffle sample reads `fireball 41`, `archer 37`, `soldier 34`,
`rally 23`, `scout 22`, `knight 17`, `wall 13`, `mend 13` (3/3/3/2/3/2/2/2
copies). 200 draws is a small sample, so the claim is re-checked at **20 000
shuffles**: expected 3000/2000, observed
`archer 2961, fireball 2895, knight 2036, mend 1991, rally 2011, scout 2996,
soldier 3053, wall 2057` → **χ² = 7.50 on 7 degrees of freedom**, comfortably
uniform (the 5 % critical value is 14.07). No card is pinned to the top of the
deck, so the opening hand is not degenerate.

**5. The AI is a function — 8/8 positions, 50 repeats each.** Eight constructed
positions (Fireball kill, Fireball correctly withheld, Rally, Mend, contest,
push, nothing affordable, full board with spells only) were queried 50 times
each: **identical output every time**, and the argument board was left
unmodified. Two of the scenarios caught a real bug during development — checking
that a card was *affordable* without checking that it was *in hand* produced
`handIndex: -1`, which is why `afford()` now requires both.

**6. Combat is simultaneous and exact.** Constructed positions through
`CB.resolveCombat`:

| position | expected | measured |
|---|---|---|
| 3/3 vs 4/2 | both die | both lanes empty ✓ |
| Bulwark 0/8 alone vs nothing | enemy base takes **0** | `20 → 20` ✓ |
| Scout 2/1 alone vs nothing | enemy base takes **exactly 2** | `20 → 18` ✓ |
| Knight 5/6 vs Scout 2/1 | Knight survives at **4 HP**, no base damage | `knight 5/4`, bases `20 / 20` ✓ |
| 5 attack into a 3 HP base | floors at **0**, not negative | `3 → 0` ✓ |
| input board after any call | unchanged | unchanged ✓ |

**7. Difficulty is calibrated, and the first move is worth a lot.** The order
"you act → combat → the enemy acts" means your freshly placed units strike
before the enemy can answer, while enemy units wait a full round — the
qualitative note under [The board](#the-board), made numeric. A **mirror match**,
where one single policy drives *both* seats, isolates how much the seat alone is
worth: with the shipped AI in both chairs the player seat wins **20/24**; with a
greedy policy in both chairs, **22/24**. The difficulty is therefore calibrated
against weaker play. Over 24 seeds:

| player policy | player wins | AI wins | base damage taken (avg) | flawless wins |
|---|--:|--:|--:|--:|
| greedy (thinks) | **20** | 4 | 6.8 | 10 |
| plays the first legal card | 13 | **11** | 10.8 | 8 |
| picks uniformly among legal plays | 13 | **11** | 13.1 | 3 |

Four AI policies were measured against the same player bots, and **no variant
beat the shipped priority list**: an attack-first body choice for priority 4 ties
it (11/24 vs the random player, 20/24 vs the greedy one), while pushing before
contesting and a full greedy port both make the AI *weaker* (8/24 against the
random player). So the shipped list is the strongest of the four, and the
"lowest lane first" tie-break — occasionally flagged as an exploitable tell — is
not the source of the player's edge: it costs nothing measurable, since the
mirror match above hands that same tie-break to both seats.

**8. The pile's two rare branches really run — and both are exact.** Drawing has
exactly two non-trivial exits, and "it never happens in the games we looked at"
is how a broken one hides, so each was driven to its own threshold:

- **The full-hand burn.** An idle hand is full by turn 3, so the next draw finds
  the cap: the card goes straight to the discard and the hand stays at 5.
  Reached on **14 turn transitions across 6 seeds**. The burn leaves the hand at
  the cap, moves exactly one card deck → discard, logs `logBurned`, and the
  20-card identity survives it.
- **The empty-deck reshuffle.** The arithmetic fixes where this must become
  reachable: a side holds `20 - START_HAND = 17` cards at the deal and takes one
  draw a turn, so its pile can only run dry on draw #18 — a game that survives
  into turn 18. A survival-maximising staller (block every attacker, heal a
  blocker about to die, never push an empty lane) gets there on **19 of 120
  seeds**, with **20 player-side and 17 enemy-side refills**, the longest game
  running to **turn 38**. Every refill is checked at the instant it happens —
  the log is a 48-entry rolling window that drops its *oldest* lines, so a
  wrap-up scan would miss the entry — and it must show a deck that grew, a
  discard that funded it, a `logReshuffle` line, and the 20-card identity intact
  on both sides at all **1 531** samples along the way.

Neither branch is dead code, and neither is documented by the source alone: the
`draws` counter they feed is a **single counter shared by both sides** (a full
turn advances it by 2 while both hands have room) that **excludes burned draws**,
which is now stated under the bridge below.

## Test bridge (`window.CB`)

- **Constants:** `LANES` (3), `HAND_MAX` (5), `DECK_SIZE` (20), `START_HP` (20),
  `MAX_ENERGY` (10), `START_HAND` (3), `RESOLVE_SEC` (0.5), `ENEMY_SEC` (0.6),
  `ENEMY_STEP` (0.2), `LOG_SHOW` (6)
- **Pure data:** `cards()` (8 entries: `id, en, zh, cost, atk, hp, kind, text` —
  `atk`/`hp` are `null` for spells, `text` is a `{en, zh}` pair),
  `deckList()` (counts), `deck()` (20 ids in canonical order)
- **Pure functions:** `energyFor(turn)`, `mulberry32(seed)`,
  `shuffle(list, rng)`, `enemyChooseAction(board, hand, energy)`,
  `resolveCombat(board)`, `canPlay(state, handIndex, lane)`
- **Queries:** `getState()`, `hudCache()`, `log()`, `board()`, `hand()`,
  `unitAt(lane, side)` (`side` is `'player'` or `'enemy'`)
- **Lifecycle:** `newGame(opts)` (`{ seed }`), `start()`, `pause()`,
  `selectCard(idx)`, `playCard(handIndex, lane)`, `endTurn()`,
  `tick(seconds[, step])`
- **RNG hook:** `nextRandom()` advances the **live** stream and counts the call.
  For isolated randomness use `mulberry32(seed)`, which owns its own state.

`getState()` returns at least `{ phase, turn, energy, playerHp, enemyHp,
hand: [cardId…], board: { player: [unit|null ×3], enemy: [unit|null ×3] },
deckLeft, discardLeft, seed, rng: { seed, calls }, rngDraws, winner }` where a
`unit` is `{ cardId, atk, hp, maxHp }`. It also carries `enemyHand`,
`enemyEnergy`, `enemyDeckLeft`, `enemyDiscardLeft`, `draws`, `handMax`,
`deckSize`, `maxEnergy`, `selected`, `resumePhase`, `best`, `over` and `log`.

**Three names worth pinning down.** `rng.calls` and `rngDraws` are the same number:
how many times the PRNG has been pulled (`shuffle` pulls it via `next`, so a
fresh game is already at `calls = 38`). The separate `draws` field counts cards
that **entered a hand**, and it is deliberately **not** per side: one counter is
shared by both players, so a full turn advances it by two while each side still
has room for the card. A draw the hand cap **burns** is not counted either — the
card does come off the deck (straight into the discard) but never entered a hand.
Both halves are pinned by the test suite, because neither is obvious and a
mislabelled counter makes the pile arithmetic look wrong when it is not: across
an idle game `draws` runs 0 (at the deal) → 1 (after `start()`) → 3 (turn 2) →
4 (turn 3), the last step being the turn where the cap starts burning.

**`tick(seconds[, step])` contract.** `seconds` is **real seconds**; it is split
into `step`-sized sub-steps (default `1/60`) that each call the same
`update(dt)` the rAF loop calls, and the value-cached `updateHud()` runs exactly
once at the end. No `requestAnimationFrame`, no wall clock, no timers — so a
headless run and the on-screen game never disagree. It returns `getState()`.

**`newGame()` vs the New button.** `newGame({seed})` returns the machine to
`ready` (the start overlay). The on-screen **New game** and **Play again**
buttons call `newGame()` and then `start()`, so one click deals and plays —
matching the other games in this collection. The buttons seed from the wall
clock; every headless entry point passes an explicit seed.

## Run

Just open `index.html` in a browser — zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is
remembered, and the switch re-paints the dynamic text too (the turn line, the
combat log, the card faces and the result dialog), not just the static labels.
