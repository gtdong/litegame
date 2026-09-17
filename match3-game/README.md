# Match 3

[简体中文](README.zh.md) · **[English](README.md)**

---

Swap neighbouring gems to line up three or more of the same colour. Cleared gems vanish, everything above them falls, fresh gems drop in from the top — and if that lines up more of a colour, the chain keeps going. Reach the target score before you run out of moves.

## How to play

- **Select** a gem with a click / tap, then click an adjacent gem to swap them. You can also **drag** one gem onto a neighbour.
- A swap that lines up **3+** gems of one colour clears them. A swap that lines up nothing is **reverted** and costs no move.
- Cleared gems are replaced from above. If the fall makes another match, it clears too — every extra cascade round raises the **combo multiplier**.
- When no swap can produce a match, the board is **reshuffled automatically** so you are never stuck.
- **Hint** highlights one legal swap; **Shuffle** reshuffles on demand. Both are disabled until the round is running.

## Scoring

Each cleared gem is worth `10 × combo` points, where `combo` is the cascade round of the current move (1 for the first clear, 2 for the match it triggers, 3 for the next, …). So a move that clears 3 gems and then chains another 3 scores `3×10×1 + 3×10×2 = 90`.

**You win** the moment your score reaches the target; **you lose** if the moves run out first. Your best score is remembered in `localStorage`.

## Difficulty

| Level | Colours | Moves | Target |
|---|---|---|---|
| Easy | 5 | 30 | 1000 |
| Normal | 6 | 25 | 1500 |
| Hard | 7 | 20 | 2000 |

Fewer colours make matches easier; more colours and fewer moves make it harder. Pick a difficulty on the start screen before you begin.

## Run

Just open `index.html` in a browser. Zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered.
