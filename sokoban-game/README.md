# Sokoban

[简体中文](README.zh.md) · **[English](README.md)**

---

Push every crate onto a ringed goal tile. You can only push — never pull — so the whole game is about where you stand *before* you shove.

## How to play

- Move the porter with the **arrow keys** or **WASD**; on touch devices swipe the board or use the on-screen pad
- Walk into a crate to push it one tile in that direction
- A crate can only be pushed if the tile **behind it is free** — walls, other crates and the board edge all block it
- Land every crate on a goal to clear the level
- Press **U** to undo, **R** to restart the level, **Esc** to close the dialog

## 10 levels

Difficulty ramps gently: level 1 is a single straight push, level 10 asks you to juggle four crates in a symmetric layout. Movement counts and push counts are tracked separately — pushes are the ones worth bragging about.

Progress is stored in `localStorage`, so cleared levels keep a ✓ mark and the next session picks up where you left off. You can jump between levels freely with **Prev** / **Next**.

## Stuck?

A crate wedged into a corner (a wall on each of two perpendicular sides) can never move again. The game spots this and warns you immediately — hit **U** to undo or **R** to start the level over. Undo rewinds crate pushes as well as walking, so you can always walk a move back.

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.

## Tests

`node tools/sokoban-test.js` — 104 assertions. Besides the usual rule checks (walls, blocking, undo, deadlock detection) it runs a **breadth-first solver** over every bundled level to prove each one is actually finishable, then replays those solutions through the real `keydown` handler in a fake DOM. A level that cannot be completed fails the build.
