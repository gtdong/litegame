# Klondike Solitaire

[简体中文](README.zh.md) · **[English](README.md)**

---

The classic patience game — and the first card game in this collection. Build the four foundations from Ace up to King while you untangle the tableau.

## How to play

- Tap (or click) a face-up card or a run of cards, then tap where it should go. Tap the same card again to cancel the selection.
- Double-tap a card to send it straight to a foundation (when legal).
- **Tableau** (the seven columns): build downward by alternating colour (a red 9 on a black 10, and so on). An empty column only accepts a King.
- **Foundations** (top right): build each suit up from Ace to King.
- **Stock** (top left): tap to draw cards to the waste. When the stock runs out, tap again to recycle the waste — limited recycling is scored.
- **Undo** rewinds any number of moves; **New Game** deals a fresh shuffle.

## Options

| Control | Meaning |
|---|---|
| Draw: 1 / Draw: 3 | Deal one card or three at a time from the stock |
| Undo | Step back through your move history (`U`) |
| New Game | Reshuffle and restart (`N`) |

The HUD shows your **score**, **move count** and **elapsed time**. The game detects a win automatically (all four foundations complete) and warns you when no moves remain.

## Run

Just open `index.html` in a browser. Zero dependencies.

The game has a built-in English / 简体中文 switch at the top; your choice is remembered in `localStorage`.
