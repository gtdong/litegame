# gomoku-game · 五子棋

<div align="right">
  <b><a href="#zh">简体中文</a></b> · <b><a href="#en">English</a></b>
</div>

---

<a id="zh"></a>

## 简体中文

15×15 棋盘五子棋，支持双人对战与人机对战，内置连珠（Renju）禁手规则。

### 玩法

- 用浏览器打开 [index.html](index.html) 即可开始
- 点击棋盘交叉点落子，黑棋先行
- 右侧面板可切换对战模式、电脑执子颜色、禁手处理方式
- 支持悔棋与重新开始

### 规则

- **三三禁手**：一子落下同时形成两个「活三」
- **四四禁手**：一子落下同时形成两个「四」
- **长连禁手**：一子落下形成六子以上相连
- 黑棋「四三」合法，成五优先于禁手（长连除外）
- 白棋无禁手，六连以上同样获胜

禁手处理有三种模式：禁止落子（默认）/ 落禁手即判负 / 关闭禁手。

---

<a id="en"></a>

## English

Gomoku on a 15x15 board with player-vs-player and player-vs-AI modes, implementing Renju forbidden-move rules.

### How to play

- Open [index.html](index.html) in a browser to start
- Click a board intersection to place a stone; black moves first
- The side panel switches the game mode, the AI's color, and how fouls are handled
- Undo and restart are supported

### Rules

- **Double-three**: one stone creates two open threes at once
- **Double-four**: one stone creates two fours at once
- **Overline**: one stone creates a run of six or more
- A "four-three" is legal for black, and five in a row takes precedence over a foul (except an overline)
- White has no forbidden moves and also wins with six or more in a row

Fouls can be handled in three ways: block the point (default) / lose on the foul / disabled.
