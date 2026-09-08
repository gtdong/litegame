# snake-game · 贪吃蛇

**[简体中文](README.md)** · [English](README.en.md)

---

经典贪吃蛇，24×24 格棋盘。

## 玩法

- 用浏览器打开 [index.html](index.html) 即可开始
- 键盘：<kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> 或 <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> 控制方向
- 手机：在棋盘上滑动转向，双击暂停
- <kbd>空格</kbd> 暂停 / 继续，<kbd>Enter</kbd> 开始或重开

## 说明

- 每吃一个食物得 10 分，蛇身变长、速度略微提升
- 撞墙或撞到自身即结束
- 最高分保存在浏览器 localStorage（键名 `snake_best_score`）
