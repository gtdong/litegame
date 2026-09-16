# Word Guess

[简体中文](README.zh.md) · **[English](README.md)**

---

Six tries to find a hidden word. Every guess is scored letter by letter, and the board narrows it down until the answer is the only thing left.

## How to play

- Pick the language at the top of the page and the game switches banks with you: **English** hides a five-letter word, **中文** hides a four-character idiom (成语).
- Type a full guess and submit it. The keyboard works too — type, then **Enter**; **Backspace** deletes; **Esc** starts a new round.
- Each cell of the guess comes back as one of three states:

| Colour | Meaning |
| --- | --- |
| 🟩 Green | Right character, right position |
| 🟨 Amber | The character is in the word, but not here |
| ⬜ Grey | The word does not contain this character at all |

- Six guesses. Guess the word and you win; run out and the answer is revealed.

The amber rule is the one everybody gets wrong on their first game: **a letter lights up at most as many times as it actually appears in the answer.** If the answer has one `E` and your guess has three, only one of them can be green or amber — the exact match wins, and the rest are grey.

## Two languages, two boards

Switching language switches to **that language's own board**, and neither board is reset. Your English game in progress is still there when you come back, and each language keeps its own win/loss record. The two are not comparable anyway — a 5-letter English word and a 4-character idiom are different problems.

The **Chinese pad** is the interesting part. English types on the 26 letters you already know, but there is no 26-key alphabet for Chinese, so the pad is built from the word list itself: one key per distinct character in the bank, most frequent first. That is why the idiom list is curated for character reuse — a broader list would push the pad past 200 keys and turn every guess into a scrolling exercise. As it stands it is 130 keys.

Characters you have already eliminated are dimmed, so the pad gets easier to read the longer you play.

## Sharing

Once a round is over, **Copy result** puts a spoiler-free grid on the clipboard:

```
Word Guess 3/6
⬜⬜🟩⬜🟩
🟨⬜⬜⬜🟩
🟩🟩🟩🟩🟩
https://litegame-hub.github.io/wordguess-game/
```

It is emoji only, so nobody can read the answer off it. If the browser refuses clipboard access, the same text is revealed in a box for you to copy by hand — it never fails silently.

## About the word lists

Both banks are embedded in the page, so the game stays a single dependency-free file.

- English: **635 accepted guesses**, drawn from **558** common words. Only words on the list are accepted — a valid English word that is not on it will be rejected, which is the trade-off for having no dictionary to download.
- Chinese: **52 common 成语**.

The accepted-guess list is deliberately wider than the answer pool, so a sensible guess is never refused just because it could not have been the answer. The record is kept in `localStorage` and a corrupt value degrades to a fresh record rather than breaking the page.

## Running it

Open `index.html` in a browser. No build step, no dependencies.

## Tests

`node tools/wordguess-test.js` — 117 assertions in eleven groups.

The one that matters most is **differential testing of the scorer**. A word game's scoring looks trivial and is not: the `hit` / `present` / `miss` split has to handle repeated characters exactly right, and the classic wrong answer is a single pass that lights up every occurrence of a shared letter. This file scores thousands of guesses against a **second, independently written implementation** (a consumed-slot array, versus the count map the game uses), so the two cannot share a bug:

- exhaustive over **all 256** pairs of 4-character A/B strings and **all 729** pairs of 3-character A/B/C strings — tiny alphabets force the duplicate cases;
- 8,000 random 5-character A–D pairs, plus 2,000 real English and 2,000 real Chinese pairs;
- 6,000 random pairs checked against invariants: a letter lights up exactly `min(count in guess, count in answer)` times, and nothing lights up that the answer does not contain.

The rest covers word-bank integrity (length, character set, no duplicates, every answer is also an accepted guess), the pad (one key per distinct character, covering every character of every accepted guess), the game flow driven through the real pad clicks and the real buttons, the stats and streak logic, the clipboard fallback, per-language board state, and the bilingual copy — no key the markup asks for is missing, nothing is left untranslated, and both languages use the same placeholders.

Group 11 **re-injects deliberate bugs** and requires the suite to notice. Each one is caught by the assertion written for it: a one-pass scorer turns 9 assertions red across five groups; a pad missing a needed character, an answer missing from the accepted list, a wrong-length word, a duplicate, a Chinese entry containing Latin, a share grid that leaks letters, an untranslated string, a dropped placeholder and a missing dictionary key are each reported by name.

### Real-DOM check

`tools/wordguess-dom.js` is a third layer that runs the page in a real browser-like DOM with `jsdom` — the stub DOM has no `querySelectorAll`, no `getAttribute` and no aggregated `textContent`, so whole classes of bug never reach the suites above. It clicks the actual pad keys, the actual buttons and the actual language links, and asserts the real board dimensions (6×5 in English, 6×4 in Chinese), the real pad sizes (26 keys, 130 keys), the real cell colours, and that each language's board survives a switch.

It needs `jsdom`, which lives in an isolated directory so this repo stays dependency-free:

```
NODE_PATH=/Users/dgt/.workbuddy/binaries/node/workspace/node_modules \
  node tools/wordguess-dom.js
```

44 assertions. Removing the Enter button's listener turns 12 of them red; making the pad ignore the current language turns 3 red; dropping the language-change re-render turns 5 red. The script takes an optional path argument so that check can be repeated against a deliberately broken copy.
