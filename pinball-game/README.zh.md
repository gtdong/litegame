# 弹球台

**[简体中文](README.zh.md)** · [English](README.md)

---

单台竖版弹球机。球台是一块**逻辑画布，恰好 480 × 720 px**（CSS 自适应缩放）；
整个模拟用 `canvas` 2D 渲染，无相机、无滚动。你有 **3 个球**、**3 个圆形弹珠**、
**2 块挡板**和一个**弹射器**。给弹射器蓄力，把球射上右侧通道，拨动挡板别让它掉进
底部中央的**落球孔**，并在弹珠上累积**连击倍率**。所有随机数都来自**同一条带种子的
随机流**，因此一局游戏完全可复现。

## 玩法

**键盘**

| 按键 | 作用 |
|---|---|
| **A** / **←** | 左挡板（按住） |
| **D** / **→** | 右挡板（按住） |
| **空格** | 按住给弹射器蓄力，松开即发射 |
| **W** | 向上撞台 |
| **S** | 向下撞台 |
| **Enter** | 开始 · 继续 · 再来一局 |
| **P** | 暂停 / 继续 |
| **R** | 新游戏 |

**屏幕按钮 / 触屏**

| 控件 | 作用 |
|---|---|
| **◀ 左** / **右 ▶** | 按住挡板（`pointerdown` / `pointerup`）；轻点则切换 |
| **发射** | 按住蓄力，松开发射；直接点击则以满力发射 |
| **新游戏** | 开始新一局 |

画布使用 `touch-action: manipulation`。挡板按钮响应
`pointerdown` / `pointerup` / `pointercancel` / `pointerleave`，所以手指滑出按钮
也会松开挡板。

## 球台

球台轮廓由 **9 段墙**组成（单位逻辑像素）。两侧墙从 `y = 140` 到 `y = 540`，
然后两道漏斗向内收，底部中央留出 **`x = 150` 到 `x = 330` 的落球孔**；球心越过
`DRAIN_Y = 700` 即告失球。**发射通道**是 `x = 420` 与 `x = 456`（右外墙）之间的窄
通道，底部由 `y = 660` 的地板封闭；球停靠在 `(438, 650)` 的弹射器上。

- **挡板**枢轴在 `(160, 600)`（左）与 `(320, 600)`（右），各是长 **70**、半径 **7**
  的胶囊。左挡板从静止角 `0.45 rad` 扫到激活角 `−0.55 rad`；右挡板镜像
  （`2.6916 rad` → `3.6916 rad`）。角速度为 **18 rad/s**。
- **弹珠**（半径 **22**）位于 `(240, 270)`、`(130, 320)`、`(330, 390)`。

### 常量（`PB.constants`）

| 常量 | 值 | 单位 |
|---|--:|---|
| `W` / `H` | 480 / 720 | px |
| `BALL_R` | 9 | px |
| `GRAVITY` | 900 | px/s² |
| `MAX_SPEED` | 1400 | px/s |
| `PHYS_STEP` | 1/240（= 0.0041667） | s |
| `MAX_SUBSTEPS` | 240 | 子步/次 |
| `DRAIN_Y` | 700 | px |
| `DRAIN_X0` / `DRAIN_X1` | 150 / 330 | px |
| `BALLS` | 3 | 球/局 |
| `DEFAULT_STEP` | 1/60 | s |
| `FLIPPER_LEN` | 70 | px |
| `FLIPPER_R` | 7 | px |
| `FLIPPER_REST_ANGLE` | 0.45 | rad |
| `FLIPPER_ACTIVE_ANGLE` | −0.55 | rad |
| `FLIPPER_SPEED` | 18 | rad/s |
| `FLIPPER_KICK` | 260 | px/s |
| `FLIP_RESTITUTION` | 0.7 | — |
| `BUMPER_R` | 22 | px |
| `BUMPER_KICK` | 320 | px/s |
| `BUMPER_REST` | 0.9 | — |
| `BUMPER_BASE` | 100 | 分 |
| `WALL_REST` | 0.86 | — |
| `DRAG` | 0 | 1/s |
| `STALL_SEC` | 6 | s |
| `STALL_SPEED` | 30 | px/s |
| `STALL_NUDGE` | 120 | px/s |
| `STREAK_TIMEOUT` | 3.5 | s |
| `STREAK_STEP` | 0.25 | 倍/击 |
| `STREAK_MAX_MULT` | 5 | 倍 |
| `BONUS_CHANCE` | 0.1 | 概率 |
| `BONUS_POINTS` | 500 | 分 |
| `LAUNCH_MIN` / `LAUNCH_MAX` | 700 / 1300 | px/s |
| `CHARGE_RATE` | 1 | 蓄力/s |
| `AUTO_LAUNCH_SEC` | 1.5 | s |
| `BALL_MAX_SEC` | 8 | s |
| `NUDGE_MAX` | 3 | 次/球 |
| `NUDGE_IMPULSE` | 180 | px/s |
| `NUDGE_SIDE` | 60 | px/s |
| `LANE_X` / `LANE_Y` | 438 / 650 | px |

## 计分

只有弹珠得分，且只有**连续命中**才累积连击。

- **第 k 次连续命中弹珠**（k = 1, 2, 3, …）得
  `round(100 × min(1 + 0.25·(k − 1), 5))` 分 —— 即 **100、125、150、175、200、…**，
  从 k = 17 起封顶 **500**。这就是 `PB.bumperScore(streak)`，其中 `streak` 是本次命中
  **之前**的连续命中次数（首次为 0）。
- **连击**在失球时归零，或在 **3.5 s**（`STREAK_TIMEOUT`）内没有任何得分接触
  （弹珠或挡板触碰）后归零。
- 每次命中弹珠有 **10%** 的带种子概率获得 **+500** 奖励分。
- **最高分**存入 `localStorage`（包在 `try/catch` 内）并显示在 HUD 上。

## 可证明公平 / 可证明终止

这些是所发布常量的性质，可通过 `window.PB` 校验。

**1. 不穿模（算术证明）。** 球在每个物理子步之间的最大位移为：

```
maxStepDisplacement() = MAX_SPEED × PHYS_STEP = 1400 × (1/240) = 5.8333 px
```

而球能遇到的最薄碰撞体是墙段，球把它看作 `2 × BALL_R`：

```
thinnestCollider() = 2 × BALL_R = 2 × 9 = 18 px
```

于是 `5.8333 / 18 = 0.3241 < 1` —— 球绝不可能在单个子步内跳过任何碰撞体。
该界对**任意** `dt` 都成立：`update()` 与 `stepBall()` 都以**不超过
`MAX_SUBSTEPS × PHYS_STEP = 1 s` 的分块**推进模型，每块再按 `h ≤ PHYS_STEP`
细分子步（5 秒会被拆成五个 1 秒分块，绝不会当成一个长步长；且不丢弃任何模拟时间）。
子步数上限与分块大小是同一预算，因此对任意输入都有 `h ≤ PHYS_STEP`。

**2. 能量有界。** 挡板会注入能量，所以接触点的速度上限是挡板尖端速度
`FLIPPER_LEN × FLIPPER_SPEED = 70 × 18 = 1260 px/s ≤ MAX_SPEED`，并且球的速率
**在每次碰撞后、以及每次积分后改动后都被硬钳到 `MAX_SPEED`**（弹珠抖动、撞台、
停滞踢）。因此停在持续摆动挡板上的球无法被泵过上限：

```
energyCeiling() = MAX_SPEED = 1400 px/s
```

连续猛拨挡板 20000 个子步的实测最大速率：**1400.000 px/s** —— 恰好等于上限，
从未超过。

**3. 球必定落袋（有界局）。** 无人操作时，球受重力加**停滞保护**
（低于 `STALL_SPEED` 持续 `STALL_SEC = 6 s`）驱动下落；**未受触碰球的计时器**
（`BALL_MAX_SEC = 8 s`）是最后的兜底，弹射器还会在 `AUTO_LAUNCH_SEC = 1.5 s` 后
**自动发射**。一次没射好的抛球若掉回通道，会**重新武装弹射器**，而不会把球困住。
在种子 1–40、**无任何输入**下的实测：**每个种子都会结束**，**最慢**一整局为
**10 s**，**最低**得分为 **300**（> 0），且 **120 个球全部自行落入底孔** —— 时间兜底
一次都没用上。没有任何一局出现 `NaN`/`Infinity`。

作为参照，一个傻瓜挡板 bot（球在哪一侧就按住那一侧的挡板）在种子 1–10 上得分为
**3175 – 37425**，可见得分确实随操作提升。

## 确定性

`PB.newGame({ seed })` 为**唯一一条** `mulberry32` 随机流设种；`PB.nextRandom()`
是它唯一的取用口。种子只驱动**弹珠奖励掷骰**（10%）与**弹珠 ±1% 抖动** —— 别的
都不受影响。几何、重力、碰撞、弹射器与挡板都是纯函数，所以相同种子配相同的定步长
`PB.tick(seconds, step)` 序列，会得到**逐字节一致**的一局（`getState()` 完全相等）。
用真实 `requestAnimationFrame` 时间戳驱动循环时帧长自然浮动，因此屏幕上的运行
**不**逐帧一致 —— 而无头地通过 `tick()` 驱动则一致。`stepBall(state, dt, world)`
是纯函数：同输入 → 逐字节同输出，且绝不修改入参。

## 测试桥接（`window.PB`）

- **`constants`** —— 上表数值。
- **`world()`** → `{ walls:[{ax,ay,bx,by}], bumpers:[{x,y,r,score}], flippers:[{side,x,y,len,r,restAngle,activeAngle,angle,omega,target,pressed}], drain:{y,x0,x1} }`。
- **`mulberry32(seed)`** —— 纯生成器工厂。
- **`nextRandom()`** —— 从当前游戏随机流取一个值，返回 `[0,1)`。
- **`segmentClosestPoint(px,py,ax,ay,bx,by)`** → `{x,y,t,dist}`。
- **`circleVsSegment(cx,cy,r,ax,ay,bx,by)`** → `null` 或 `{nx,ny,depth,t}`。
- **`circleVsCircle(ax,ay,ar,bx,by,br)`** → `null` 或 `{nx,ny,depth}`。
- **`circleVsAabb(cx,cy,r,minX,minY,maxX,maxY)`** → `null` 或 `{nx,ny,depth}`。
- **`reflect(vx,vy,nx,ny,restitution)`** → `{vx,vy}`。
- **`flipperAngle(side,t)`** —— 挡板按当前运动再走 `t` 秒后的角度。它读取挡板的**实时**状态（因此对时间并非纯函数）；若需纯投影，请用 `world()` 里携带的 `angle`。
- **`launchVelocity(charge)`** → `{vx,vy}`，`charge ∈ [0,1]`。
- **`bumperScore(streak)`** —— 第 `(streak)` 次连续命中弹珠的分数。
- **`stepBall(state,dt,world)`** → `{ball:{x,y,vx,vy}, events:[…]}`（纯积分器）。
- **`maxStepDisplacement()`** = 5.8333 · **`thinnestCollider()`** = 18 · **`energyCeiling()`** = 1400。
- **`toLogical(clientX,clientY)`** —— 真实点击 → 逻辑画布坐标，零宽安全。
- **`getState()`** → `{ phase, score, best, ballsLeft, ballNo, streak, ball:{x,y,vx,vy}, flippers:{left,right}, seed, rng:{seed,calls}, rngDraws, charge, nudges, awaitingLaunch, pause, over, clock, ticks, log }`。`rngDraws` 与 `rng.calls` 是同一个数 —— PRNG 被取用的次数；**每次命中弹珠取用两次**（±1% 抖动与奖励掷骰），所以第一次得分前它一直是 0。
- **`hudCache()`** —— HUD 值缓存的副本（与 `getState()` 对应）。
- **`log()`** —— 最近的事件条目。
- **`newGame({seed})` · `start()` · `pause()` · `resume()` · `togglePause()`**。
- **`setFlipper(side,on)`** —— `left`/`right` + 布尔。 **`chargePlunger(on)`** —— 按住/松开。 **`launch(charge)`** —— 直接发射。 **`nudge(dir)`** —— `'up'`/`'down'`。
- **`tick(seconds[, step])`** —— 用同一套 `update(dt)` 推进，不用 rAF、不用定时器，
  按 `step` 切成子步，最后**恰好一次**执行带值缓存的 `updateHud()`，并返回 `getState()`。

### 标定（实测）

- **自由落体。** 在空世界中，`stepBall({x,y,vx:0,vy:0,r:9}, 1, empty)` 在 1 s 后到达
  **`vy = 900` px/s** —— 即每秒恰好增加 `GRAVITY`（900 px/s²）—— 且向下位移
  **451.875 px**。这等于 `GRAVITY·t²/2 + GRAVITY·PHYS_STEP·t/2 = 450 + 1.875`，
  正是半隐式积分器预测的值。
- **不穿模链条。** `maxStepDisplacement() = 5.8333 px`、`thinnestCollider() = 18 px`、
  **比值 = 0.3241**。
- **弹射器。** `launchVelocity(0) = {vx:0, vy:−700}`、
  `launchVelocity(0.5) = {vx:0, vy:−1000}`、
  `launchVelocity(1) = {vx:0, vy:−1300}`。
- **连击。** 连续命中 0…6 次时 `bumperScore` = **100、125、150、175、200、225、250**。
- **能量。** 持续猛拨挡板时球的最高速率 = **1400.000 px/s**（= `energyCeiling()`）。

## 运行

直接用浏览器打开 `index.html` 即可 —— 零依赖、无需构建。

游戏顶部自带「English / 简体中文」切换，选择会记住。
