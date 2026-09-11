# Reversi · Othello

[简体中文](README.zh.md) · **[English](README.md)**

---

Classic 8×8 Reversi (Othello). Sandwich the opponent's discs to flip them; the
player with the most discs when the board is full wins. Zero dependencies,
single file, just open it in a browser.

## How to play

- Black moves first. Click a highlighted square to place a disc.
- A move is legal only if it **flips at least one** of the opponent's discs: the
  placed disc, a straight line of opponent discs, and one of your own discs at
  the far end must lie on the same row, column, or diagonal. All 8 directions are
  checked, and every disc in between is flipped.
- If a side has no legal move, its turn is **passed** automatically (with a
  notice). If neither side can move, the game ends and the disc counts decide
  the winner.
- Each legal square shows a dot and the number of discs it would flip.

## Modes & AI

- **Two players (PvP)** — pass and play locally.
- **vs Computer (PvE)** — you play Black first; the computer plays White. Tick
  *AI plays first (black)* to let the computer open.
- **Three difficulty levels:**
  - *Easy* — greedy: takes the move that flips the most discs.
  - *Normal* — 1-ply search using a positional weight table (corners are gold,
    X/C squares are traps).
  - *Hard* — 4-ply minimax with alpha-beta pruning over the same weights.

## Controls

- **U** — undo (in PvE this rewinds a full human + computer pair of moves).
- **R** — restart a new game.
- The HUD shows each side's disc count, whose turn it is, the move number, and
  the current lead (`+n` / `Even`). The last placed disc is marked.

## Run

Just open `index.html` in a browser. No build step, no dependencies.

The in-page English / 简体中文 switch (top-right) is remembered in `localStorage`.
