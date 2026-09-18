# Lianliankan (Link Match)

[简体中文](README.zh.md) · **[English](README.md)**

---

The classic tile-linking game. The board is full of paired picture tiles: tap one tile, then tap a second tile with the **same picture** — if the two can be joined by a path with **at most two turns** (three straight segments), both tiles are removed along the drawn link line. Clear the whole board before the timer runs out.

Paths may leave the board: the space **around the outer edge** is a free corridor, so two tiles on the border can be linked *around the outside* of the board.

## How to play

- **Tap** a tile to select it (tap again to deselect).
- Tap a second tile with the same picture:
  - a legal link (≤ 2 turns, no other tile on the path) removes both tiles and **draws the connecting line**;
  - otherwise the first tile shakes and the second tile becomes the new selection.
- The path may run through the virtual ring **outside the board** — border tiles can connect around the edge.
- **Hint** (`H`): highlights a currently linkable pair — 3 per game, −20 points each.
- **Shuffle** (`S`): re-deals the remaining tiles, −30 points. A reshuffled board always keeps at least one linkable pair.
- When no linkable pair exists at all, the board **auto-reshuffles** (also −30 points) so the game never dead-ends.
- Clear every tile to win; run out of time and you lose. Your best score is remembered in `localStorage`.

## Scoring

| Event | Points |
|---|---|
| Matched pair | 10 + 5 × (combo − 1) |
| Combo | consecutive matches within 5 s stack the multiplier |
| Hint | −20 (max 3 per game) |
| Shuffle (manual or auto) | −30 (score never drops below 0) |
| Win bonus | +2 per remaining second |

## Difficulty

| Level | Board | Pairs | Tile kinds | Time limit |
|---|---|---|---|---|
| Easy | 6×6 | 18 | 8 | 6 min |
| Normal | 8×8 | 32 | 10 | 7 min |
| Hard | 10×8 | 40 | 12 | 8 min |

## Run

Just open `index.html` in a browser. Zero dependencies, no build step.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered.
