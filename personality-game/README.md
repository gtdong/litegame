# Personality Test

[简体中文](README.zh.md) · **[English](README.md)**

---

Twelve either/or questions. At the end you get a four-letter type code, four trait bars showing how strongly you leaned each way, and a few games from this site picked for that type.

## How it works

- **12 questions, 3 per axis.** Answer by clicking an option, or press **1** / **2**. Press **←** (or **Back**) to change an answer.
- Because every axis has an **odd** number of questions, an axis can never tie — you always get a definite letter.
- Options are **shuffled per question**, so neither pole is always "the one on the left". Going back does not reshuffle what you just read.

## The four axes

| Axis | Poles | What it is about |
| --- | --- | --- |
| Social energy | **E** Outward / **I** Inward | where your energy comes from |
| Information | **S** Concrete / **N** Possibilities | what you trust and what you notice |
| Decisions | **T** Logic / **F** People | what you weigh when it matters |
| Structure | **J** Planned / **P** Open | how you like things arranged |

The code is the four chosen letters in that order — `INFJ`, `ESTP`, and so on, covering all 16 combinations. Each of the 16 types has its own name, tagline and a note worth knowing.

## Your result

The result screen shows the **type code and name**, **four bars** (with a `clear` / `slight` marker so a 2–1 split reads differently from a 3–0 one), a paragraph for **each of the four poles you chose**, and **three games** from this site that suit that type.

**Copy my result** puts a shareable one-paragraph summary on your clipboard. If the browser refuses clipboard access, the text is shown so you can copy it by hand — it never fails silently.

Your last result is remembered in `localStorage`, so a returning visitor is offered it again on the start screen.

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.

## A note on what this is

This is an **original quiz for fun and self-reflection**. It is not a psychological diagnosis, and it is not affiliated with, or equivalent to, any commercial personality instrument. The four-letter shorthand is used because it is a familiar way to write four either/or axes — nothing more.

## Tests

`node tools/personality-test.js` — 104 assertions, in five groups:

- **content integrity** — every axis is balanced at 3 questions; every option carries the correct pole for its axis; no question has two identical options; every question, option, type, trait and axis string exists in **both** languages and none is left as untranslated English;
- **scoring, exhaustively** — all **4096** possible answer sets are scored, proving every axis sums to 3, no axis can tie, the percentages are consistent, and all **16 type codes are reachable** from the real questions (not just theoretically possible);
- **recommendations** — all 16 types get exactly three *distinct* games, all of which exist on disk, and the pool never points at a missing directory;
- **integration** — the game names baked into the recommendation list are compared against the landing page, so renaming a card can't silently desync them;
- **the real UI** — driven through the actual Start button, the actual option clicks (via the delegated handler), the real Back button and the real keyboard handler, plus the clipboard-failure path, the retake path, and a corrupted `localStorage` value.

It also runs **reverse checks**: deliberately broken copies of the content (a dropped question, a wrong pole, a missing translation, a pool entry with no directory, a disabled shuffle) are fed to the same validation functions, and the suite asserts it reports them. A check that cannot fail is decoration.
