# 无尽跑酷

**[简体中文](README.zh.md)** · [English](README.md)

---

一款无尽的三跑道跑酷。整个世界是**单个标量 `distance`（px）的纯函数**：速度是
`speedAt(distance)`，整片障碍场是 `hazardAt(k)` —— 关位 `k` 位于**固定的**绝对距离
`slotS(k) = SLOT0 + k·SLOT_GAP`，关位内容来自一条带种子的 **mulberry32** 随机流。
由于间距在**距离**上恒定、速度有上限，关位之间的时间永远不会低于
`SLOT_GAP / SPEED_MAX`，并且生成出的**走廊**跑道保证路线始终存在。因此这一局
**可证明永不可能无解**（下方 P1–P7）—— 你只会因为跳跃、下滑或变道时机不对而失败。
整个场地**只用 DOM + CSS**：全程没有任何 canvas，所有视觉元素都是用发布常量定位的
`<div>`。

## 玩法

**键盘**

| 按键 | 作用 |
|---|---|
| **←** / **A** | 向左变一条跑道 |
| **→** / **D** | 向右变一条跑道 |
| **↑** / **W** / **空格** | 跳跃 |
| **↓** / **S** | 下滑 |
| **Enter** | 开始 · 继续 · 再来一局 |
| **P** | 暂停 / 继续 |
| **R** | 新游戏 |

**屏幕按钮 / 触屏**

| 控件 | 作用 |
|---|---|
| **◀ 左** / **右 ▶** | 向左 / 向右变一条跑道 |
| **跳跃** | 跳跃 |
| **下滑** | 下滑 |
| **暂停 / 继续** | 暂停或继续 |
| **新游戏** | 开始新一局 |

所有动作都是**离散**的 —— 没有需要按住的键。跳跃可以越过 `low` 横杆；下滑可以钻过
`high` 横杆；`wall` 方块则必须通过站在空闲跑道上来躲开。你只有**一条命**。

## 计分

- `score = floor(distance / SCORE_PER_UNIT) + coinCount · COIN_POINTS`，即**每移动
  10 px 得 1 分**，外加**每枚金币 25 分**。
- 金币可能出现在某个关位的**空闲**跑道上；当你的碰撞跑道与金币跑道一致并通过它时即拾取。
- **最高分**存入 `localStorage` 的 `litegame_runner_best` 键（包在 `try/catch` 内），
  并显示在 HUD 上。

## 场地

场地是一块固定的逻辑 **288 × 448 px**。三条跑道是宽 **96 px** 的竖直列，中心位于
**`x = 48、144 和 240 px`**（`laneXOf(lane) = LANE_W · (lane + 0.5)`）；玩家沿直线
`y = GROUND_Y = 392 px` 奔跑，世界向下滚动朝它逼近。所有元素都是用发布常量定位的普通
`<div>`：玩家带有裸自定义属性 `--lane`（碰撞跑道）与 `--y`（跳跃高度），每个 `.hazard` /
`.coin` 带有 `--lane` 与 `--x`（其水平屏幕 x）。`#track` 拥有 `--cell`（= `LANE_W`），
玩家的变换为 `translate(calc(var(--lane) * var(--cell)), calc(var(--y) * -1px))`。位置
从不从 DOM 回读。

## 常量（`RN.constants`）

全部调参常量，均以其源码中的确切名称列出。

| 常量 | 值 | 单位 |
|---|--:|---|
| `LANE_COUNT` | 3 | 条跑道 |
| `LANE_W` | 96 | px |
| `VIEW_W` | 288 | px |
| `VIEW_H` | 448 | px |
| `GROUND_Y` | 392 | px |
| `PLAYER_W` | 34 | px |
| `PLAYER_H` | 56 | px |
| `PLAYER_SLIM_H` | 28 | px |
| `SLOT0` | 640 | px |
| `SLOT_GAP` | 320 | px |
| `LEVEL_SPAN` | 2000 | px |
| `LEVEL_MAX` | 16 | 关 |
| `SPEED_BASE` | 200 | px/s |
| `SPEED_RAMP` | 20 | px/s 每关 |
| `SPEED_MAX` | 520 | px/s |
| `MIN_REACT_S` | 0.45 | s |
| `GRAVITY` | 2200 | px/s^2 |
| `JUMP_V` | 900 | px/s |
| `SLIDE_S` | 0.6 | s |
| `LANE_CHANGE_S` | 0.18 | s |
| `HAZARD_LOW_W` | 60 | px |
| `HAZARD_LOW_H` | 46 | px |
| `HAZARD_HIGH_W` | 70 | px |
| `HAZARD_HIGH_H` | 24 | px |
| `HAZARD_HIGH_CLEAR` | 34 | px |
| `HAZARD_WALL_W` | 40 | px |
| `WALL_H` | 120 | px |
| `COIN_R` | 10 | px |
| `COIN_POINTS` | 25 | 分 |
| `SCORE_PER_UNIT` | 10 | px 每分 |
| `COIN_CHANCE` | 0.4 | 概率 |
| `EMPTY_CHANCE` | 0.14 | 概率 |
| `SINGLE_CHANCE` | 0.66 | 概率 |
| `PATTERN_LEN` | 12 | 关位 |
| `DEFAULT_STEP` | 1/60 (= 0.0166667) | s |
| `MAX_CHUNK` | 0.25 | s |
| `POOL_SIZE` | 24 | 节点/层 |

## 为什么它永不可能无解

这七条性质都是所发布常量的性质，可通过 `window.RN` 校验；下列数字均为实测值。

**P1 —— 每个关位至少留下一条空闲跑道。** 一个关位要么堵 0 条（空关位）、1 条，要么
**最多堵 2 条**跑道；它**绝不会堵死全部 3 条**。走廊跑道 `c(k)`（见 P2）永远空闲，因此
每个关位都有 `free.length >= 1`。在 **40 个种子、各自前 5000 个关位**上验证：**最少
空闲跑道数为 1**。

**P2 —— 路线连通。** 每个种子有一条约 `PATTERN_LEN = 12` 长的**走廊模式**，它是跑道上的
一条随机游走，从中间跑道出发，每步只走 **−1 / 0 / +1**，因此相邻关位之间存在空闲跑道
`f`（关位 `k`）与 `g`（关位 `k+1`）满足 `|f − g| <= 1`。周期回绕处同样成立，因为所有
模式取值（以及起始值 1）都落在 `[0, 2]` 内，故与中间跑道的距离不超过 1。已在 **40 个
种子、各自前 5000 个关位**上验证。

**P3 —— 永远有反应时间。** `timeBetween(s0, s1)` 是 `1/speed` 在 `[s0, s1]` 上的**精确**
积分，用**闭式**对常速关卡分段求和得到（绝不数值积分）。每一对相邻关位的预算都不低于
`SLOT_GAP / SPEED_MAX`：

```
min timeBetween(slotS(k), slotS(k+1)) = 320 / 520 = 0.615385 s  >= MIN_REACT_S = 0.45 s
```

前 5000 个关位实测最小值为 `0.615385 s`（留有 `0.165385 s` 余量）。

**P4 —— 斜坡会饱和。** 对所有 `s` 都有 `speedAt(s) <= SPEED_MAX = 520`（关卡被钳到
`LEVEL_MAX = 16`，且 `SPEED_BASE + SPEED_RAMP·LEVEL_MAX = 200 + 20·16 = 520`）。每关
预算的下限为

```
SLOT_GAP / SPEED_MAX = 320 / 520 = 0.615385  >=  MIN_REACT_S = 0.45
```

所以 P3 **永远**成立，而不只是开头。

**P5 —— 这些动作足够。** 覆盖距离（跳跃/下滑的位移）随**速度**缩放，而碰撞重叠是轨道上
的**固定长度**，所以最坏情形是**最慢**速度 `SPEED_BASE = 200 px/s`，而不是最快。

```
低横杆重叠 = HAZARD_LOW_W  + PLAYER_W = 60 + 34 =  94 px
高横杆重叠 = HAZARD_HIGH_W + PLAYER_W = 70 + 34 = 104 px

jumpApex() = JUMP_V^2 / (2·GRAVITY) = 900^2 / 4400 = 184.090909 px
             >= HAZARD_LOW_H + 0.15·PLAYER_H = 46 + 8.4 = 54.4 px   （最高点足够）

高于 HAZARD_LOW_H 的时间 = 2·sqrt(JUMP_V^2 − 2·GRAVITY·HAZARD_LOW_H) / GRAVITY
                        = 2·sqrt(607600) / 2200 = 0.708625 s
跳跃位移 @ SPEED_BASE    = 0.708625 · 200 = 141.725 px  >=  94 px   （通过）

SLIDE_S · SPEED_BASE     = 0.6 · 200 = 120 px  >=  HAZARD_HIGH_W + PLAYER_W = 104 px  （通过）
```

一次跳跃会严格高于 `HAZARD_LOW_H` 持续 **0.708625 s**（`SPEED_BASE` 下 **141.725 px**、
`SPEED_MAX` 下 **368.485 px**），一次下滑在 `SPEED_BASE` 下覆盖 **120 px**（`SPEED_MAX` 下
**312 px**）。下滑时碰撞盒顶部（`PLAYER_SLIM_H = 28`）能塞进净空（`HAZARD_HIGH_CLEAR = 34`）
之下，而站立玩家（`PLAYER_H = 56`）塞不进。

**P6 —— 变道时间落在预算内。** `LANE_CHANGE_S = 0.18 <= MIN_REACT_S = 0.45`。

**P7 —— 金币永远不会出现在被堵的跑道上。** 金币只会放在该关位 `free` 集合中的跑道里。
已在 **40 个种子、各自前 5000 个关位**上验证。

## 标定（实测）

- **跳跃最高点** `jumpApex() = 184.090909 px`；**滞空时间** `jumpAirtime() = 0.818182 s`。
- **下滑时长** `slideDuration() = 0.6 s`。
- **变道时间** `laneChangeTime() = 0.18 s`。
- **速度**：关卡 0 时 `speedAt(0) = 200 px/s`；到顶时 `speedAt(LEVEL_MAX · LEVEL_SPAN) =
  speedAt(32000) = 520 px/s`（且 `speedAt(1e9) = 520`）。
- **前 500 个关位的最小 `reactionBudget` = 0.615385 s**，首次出现在 **关位 k = 99**
  （此时 `slotS(98) = 32000` 与 `slotS(99) = 32320` 都落在到顶区），恰好等于
  `SLOT_GAP / speedAt(...) = 320 / 520`。
- **`timeBetween` 闭式解与数值积分对比**（两百万点中点法）：`timeBetween(0,640) =
  3.2 / 3.2`、`timeBetween(32000,32320) = 0.615385 / 0.615385`、`timeBetween(0,100000)
  = 229.468223 / 229.468223` —— 两者在浮点舍入范围内一致。
- **完美玩家**（一个跟随走廊路线的 bot：每个关位选一条与上一意图相邻的空闲跑道，然后把
  玩家走过去）：在 **40 个种子上全部存活**，从未死亡。由于存活的 `distance` 是时间的
  纯函数，所达距离与种子无关：`t = 90 s` 时的**解析**距离为 **27755.1302 px**（关卡 13，
  `speedAt = 460 px/s`）；而按 **5400 步 `DEFAULT_STEP`** 驱动的定步长模拟到达
  **27752.3333 px** —— 40 个种子完全一致。
  单次 **600 s** 的长跑到达**解析值 292676.5240 px**（913 个关位），仍然存活 —— 按 1/60 s
  步长驱动得到 292672.7 px、按 1/240 s 得到 292675.5 px，即所有前向欧拉驱动都落在解析值处
  或其略下方，因为 `speedAt` 在步起点读取、且速度单调不减。终局**得分不是常数**：距离与
  bot 无关，但**金币数与路线相关** —— 同样 600 s，走不同跑道的存活 bot 分别吃到 213、215、
  220 枚金币（得分 34592、34642、34767）。而一个 **完全不反应**的玩家**会**死亡（种子 1，
  在距离 1563 处撞上 `wall`）—— 这一局是可能输的，只是永远**不可能无解**。
- **关位内容分布**（种子 1，前 5000 个关位）：`low` 1030、`high` 1034、单跑道 `wall`
  572、双跑道 `wall` 1694、`empty` 670，以及 **2005 枚金币**。

## 确定性

`RN.newGame({ seed })` 会重建走廊模式并固定每个关位的 PRNG 键，因此**整片场地是
`(seed, k)` 的纯函数**，同一种子永远得到同一片场地。用定步长 `RN.tick(seconds, step)`
驱动时，游戏**逐位可复现**：同一种子配同一 tick 序列，`getState()` 完全相等。所有纯函数
（`levelAt`、`speedAt`、`slotS`、`hazardAt`、`timeBetween`、`toPixel` 等）都无副作用，
且绝不修改入参。存活期间 `distance` —— 进而 `level`、`speed`、`score` 与渲染 —— 是
模拟时间的纯函数，因此屏幕上的运行与无头运行完全一致。

**步长无关性。** 碰撞与金币拾取检测是**扫掠**区间测试：每次 `update` 在推进前记录
`d0 = distance`，然后求障碍窗口 `[h.s − w/2 − PLAYER_W/2, h.s + w/2 + PLAYER_W/2]` 与
走过区间 `[d0, distance]` 的交集。由于各子步连续铺满整个区间，比一步跨度还窄的障碍 —— 到顶
时一步跨度为 `MAX_CHUNK · SPEED_MAX = 0.25 · 520 = 130 px`，而最窄窗口
`HAZARD_WALL_W + PLAYER_W = 40 + 34 = 74 px` 比它更窄 —— **绝不**会落在两个采样点之间。
因此 `RN.tick(10, 1)`（粗粒度快进）与 `RN.tick(10, 1/60)` 得到**相同**的命中/未命中判定；
rAF 循环同样把 `dt` 钳到 0.05 s，远在窗口之内。

## 桥接（`window.RN`）

- **`constants`** —— 上表数值（共 37 项）。
- **`world()`** → `{ laneCount, laneX:[x0,x1,x2], laneW, viewW, viewH, groundY, playerW, playerH, playerSlimH, slotGap, slot0 }`。
- **`mulberry32(seed)`** —— 纯生成器工厂，返回 `[0,1)` 随机流。
- **`levelAt(s)`** → 整数难度关卡，`min(LEVEL_MAX, floor(s / LEVEL_SPAN))`，下限为 0。
- **`speedAt(s)`** → 世界速度（px/s），`min(SPEED_MAX, SPEED_BASE + SPEED_RAMP·levelAt(s))`。
- **`slotS(k)`** → 关位 `k` 的绝对距离，`SLOT0 + k·SLOT_GAP`。
- **`slotCount(s)`** → 距离 `s` 及之前的关位数量。
- **`hazardAt(k)`** → `{ k, lane, kind, s, w, h, blocked:[...], free:[...], coin:{lane}|null }`。`kind` 为 `'low' | 'high' | 'wall' | 'empty'`。有效关位永远返回对象（空关位为 `kind:'empty'`、`blocked:[]`）；**仅当 `k` 越界**（`k < 0` 或非数字）时返回 `null`。
- **`hazardsBetween(s0, s1)`** → `[s0, s1]` 内每个关位的 `hazardAt(k)` 组成数组。
- **`timeBetween(s0, s1)`** → 从 `s0` 到 `s1` 所需秒数。它是 `1/speed` 在区间上的**精确**
  积分（单位：**秒**），用**闭式**对常速关卡分段求和得到 —— 绝不数值积分。有符号：
  `timeBetween(a,b) = −timeBetween(b,a)`，且 `a == b` 时为 `0`。
- **`reactionBudget(k)`** → 关位 `k−1` 与关位 `k` 之间可用的反应秒数，即
  `timeBetween(slotS(k−1), slotS(k))`（`k = 0` 时为 `timeBetween(0, slotS(0))`）。
- **`jumpApex()`** = 184.090909 · **`jumpAirtime()`** = 0.818182 · **`slideDuration()`** = 0.6 · **`laneChangeTime()`** = 0.18。
- **`toPixel(lane, s)`** → `{ x, y }`，渲染器使用的“跑道 + 前向距离 → 屏幕像素”纯映射。
  `x` 为跑道中心 `laneXOf(lane)`；`y = GROUND_Y − s`，其中 `s` 是玩家**前方的距离间隙**
  （渲染器传入 `s − distance`），故 `s` 越大位置越靠上。
- **`getState()`** → `{ phase, distance, score, best, level, speed, lane, targetLane, y, vy, onGround, sliding, alive, coinCount, over, seed, rng:{seed,calls}, ticks, log }`。`lane` 是**碰撞跑道**；变道过程中它会在插值的**中点**翻到目标跑道，`targetLane` 是目的地。`rng.calls` 是实时随机流已产生的取用次数（为 0 —— 场地是距离的纯函数，无需实时取用）。
- **`hudCache()`** —— HUD 值缓存的副本。
- **`log()`** —— 滚动事件日志的副本。
- **`newGame(opts)` · `start()` · `pause()` · `resume()` · `togglePause()`** —— `opts = { seed }` 可选；默认种子为 1。
- **`moveLane(dir)`** —— `−1` / `+1`；**`jump()`**；**`slide()`**。三者都受 `phase` 门控（在 `ready` 或 `over` 下什么都不做）。
- **`tick(seconds[, step])`** —— 用同一套 `update(dt)` 推进，不用 rAF、不用墙上时钟；先按不超过 `MAX_CHUNK` 分块，每块再按 `h <= step`（默认 `DEFAULT_STEP`）细分子步，最后**恰好一次**执行带值缓存的 `updateHud()`，并返回 `getState()`。碰撞/拾取检测按每个子步走过的区间 `[distance_before, distance_after]` **扫掠**进行，因此比一步跨度还窄的障碍绝不会被跨过而漏检：粗 `step` 与细 `step` 给出相同的命中/未命中判定（见「确定性」下的说明）。

## 运行

直接用浏览器打开 `index.html` 即可 —— 零依赖、无需构建。

游戏顶部自带「English / 简体中文」切换，选择会记住。
