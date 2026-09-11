# Maze

[简体中文](README.zh.md) · **[English](README.md)**

---

Randomly generated perfect mazes to walk through, from a tiny 11×11 grid up to a sprawling 25×25.

## How to play

- Move with **Arrow keys** or **WASD**; on touch devices, **swipe** anywhere on the board or use the on-screen **D-pad**.
- You start at the 🚩 (top-left) and must reach the 🏁 (bottom-right).
- Press **H** or tap **Hint** to reveal the **shortest path** (computed by BFS) from your current spot to the exit. Each hint is counted.
- Your **route is traced** with faint footprints so you can backtrack with confidence.
- The goal is to escape as fast as possible: the **timer** starts on your first move and the **step counter** only ticks when you actually walk.

## Board sizes

| Button | Grid | Cells per side |
|---|---|---|
| Small | 11 × 11 | 5 |
| Medium | 17 × 17 | 8 |
| Large | 25 × 25 | 12 |

## Extras

- **Fog** mode hides everything beyond the cell next to you, for a harder memory challenge.
- **New game** regenerates a fresh maze of the current size at any time.

## How it works

The maze is carved by a **recursive-backtracker (DFS)** generator, so every maze is *perfect*: any two passages are joined by exactly one route, with no loops and full connectivity. Generation is seedable, and the test suite verifies the perfect-maze invariants (connected + acyclic) across all sizes and many seeds.

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
