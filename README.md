# litegame

<div align="right">
  <b><a href="#zh">简体中文</a></b> ·
  <b><a href="#en">English</a></b>
</div>

---

<a id="zh"></a>

## 简体中文

AI 生成的 HTML5 小游戏合集。零依赖、零构建，直接在浏览器打开 `index.html` 即可玩。

### 目录说明

| 目录 | 游戏 | 说明 |
| --- | --- | --- |
| `snake-game/` | 贪吃蛇 | 24×24 格棋盘，方向键 / WASD 控制，手机可滑动转向。含最高分本地存储、暂停、随得分递增的速度曲线。 |
| `gomoku-game/` | 五子棋 | 15×15 棋盘，支持双人对战与人机对战。内置连珠（Renju）禁手规则：三三 / 四四 / 长连，可切换「禁止落子 / 落子判负 / 关闭禁手」三种处理模式。含悔棋、重开与落子坐标提示。 |

### 运行方式

```bash
# 方式一：直接双击某个目录下的 index.html
# 方式二：起一个本地静态服务（推荐，避免浏览器本地文件限制）
python3 -m http.server 8000
# 然后访问 http://localhost:8000/snake-game/
```

### 约定

- 每个游戏一个独立目录，命名为 `<game>-game/`。
- 入口文件统一为 `index.html`。
- 所有注释使用英文，界面文案保留中文。

---

<a id="en"></a>

## English

A collection of AI-generated HTML5 mini games. Zero dependencies, no build step — just open `index.html` in a browser.

### Folder Overview

| Folder | Game | Description |
| --- | --- | --- |
| `snake-game/` | Snake | 24x24 grid. Arrow keys / WASD to move, swipe on mobile. Local best-score persistence, pause, and a speed curve that ramps up as you score. |
| `gomoku-game/` | Gomoku | 15x15 board with player-vs-player and player-vs-AI modes. Implements Renju forbidden-move rules (double-three / double-four / overline) with three enforcement modes: block the point, lose on the foul, or disable fouls entirely. Includes undo, restart, and coordinate hints. |

### Getting Started

```bash
# Option 1: simply double-click index.html inside any game folder
# Option 2: serve the folder over HTTP (recommended, avoids local-file restrictions)
python3 -m http.server 8000
# then open http://localhost:8000/snake-game/
```

### Conventions

- One directory per game, named `<game>-game/`.
- The entry point is always `index.html`.
- Code comments are written in English; in-game UI copy stays in Chinese.
