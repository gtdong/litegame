# Whack-a-Mole

[简体中文](README.zh.md) · **[English](README.md)**

---

Grab the hammer and whack every mole that pops out of the grass — but watch out for bombs!

## How to play

- Moles pop out of the nine holes; click (or tap) one to whack it — **+1 point**
- **Bombs 💣** look like moles at a glance: hitting one costs **−3 points**
- Each round lasts **30 seconds**
- The score counter and the countdown sit next to the difficulty buttons
- When time runs out a **dialog** shows your score, moles hit, bombs whacked and your best score yet (kept in `localStorage`)

## Difficulty

| Button | Spawn pace | Time a mole stays up |
|---|---|---|
| Slow | ~1 per second | ~1.1 s |
| Normal | ~1.4 per second | ~0.8 s |
| Fast | ~2 per second | ~0.56 s |

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
