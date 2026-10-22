# 台球厅

[中文](README.zh.md) | [English](README.md)

单张球台的 8 球 **清台挑战**：**800 × 400 px** 逻辑台面上摆着十五颗目标球、
**六个袋口**、一颗母球，得分会惩罚多打的每一杆和每一次犯规。几何、碰撞与摆球
全部是闭式解，且只由种子决定，因此一局可以从种子复现，物理也能仅通过
`window.PL` 验证。整张台面是纯 DOM（不用 canvas），所有位置都写成
`element.style.transform = 'translate(Xpx, Ypx)'`。

## 玩法

目标：**用尽量少的杆数把十五颗目标球全部落袋**。**8 号球必须最后落袋**——
只要台面上还有别的目标球，把它打进去就是犯规。

- **母球**——母球落袋（scratch）算犯规。它会在头点 `(200, 200)` 周围按固定
  环形搜索找到的第一个空位重摆，绝不会压在别的球上，也不会落在袋口圆内。
- **8 号提前落袋**——犯规。8 号会以同样方式重摆回台面，**不计入落袋数**：
  球是被放回去，而不是被记分。
- **合法清台**——当 8 号作为**最后一颗**目标球落袋时对局结束，杆数会与已存
  的最高纪录比较。若最后一颗目标球与 8 号在同一杆落袋，8 号在球全部停下的
  那一刻判定：此时台面已经清空，因此算合法。
- **阶段**——`ready`（开始遮罩）→ `aiming` → `rolling` → 回到 `aiming` … →
  `over`。`#btnPause` 与 `#btnShoot` 在 `ready` 与清台后禁用；`#btnNew` 与
  `#ovBtn` 在任何阶段都可用，所以永远有出路。暂停只在 `aiming` / `rolling`
  有意义。
- **得分**——`落袋数 × 100 − 杆数 × 15 − 犯规数 × 50`，下限为 0。
- **最高**——清台所用**最少杆数**，存在
  `localStorage['litegame_pool_best']`，读写包在 `try/catch` 里（`file://`
  页面是不透明源，可能抛异常）。

## 操作

| 按键 | 动作 |
|---|---|
| **←** / **A** | 瞄准角逆时针转 0.02 rad |
| **→** / **D** | 瞄准角顺时针转 0.02 rad |
| **↑** / **W** | 力度 +40 px/s |
| **↓** / **S** | 力度 −40 px/s |
| **空格** | 以当前瞄准角与力度出杆 |
| **Enter** | 开始 · 出杆 · 清台后重开一局 |
| **P** | 暂停 / 继续 |
| **R** | 新游戏 |

| 指针 | 动作 |
|---|---|
| 在台面上移动 | 朝指针方向瞄准（仅 `aiming` 阶段） |
| 点击 / 轻触台面 | 朝该点瞄准 |
| **◀** / **▶** | 瞄准角转动 0.02 rad |
| **−** / **+** | 力度 −40 / +40 px/s |
| **击球** | 以当前瞄准角与力度出杆 |
| **暂停** / **新游戏** | 暂停-继续 · 重新摆球并开始 |

台面按逻辑尺寸布局再用 CSS 缩放，所以指针坐标用
`getBoundingClientRect()` 换算（`TABLE_W / rect.width`）并夹进
`[0, TABLE_W] × [0, TABLE_H]`；矩形宽度为 0（无头 / 未样式化）时退化成 1:1，
同样不可能算出 `NaN`。

## Constants (`PL.constants`)

| Constant | Value | Unit |
|---|--:|---|
| `TABLE_W` | 800 | px |
| `TABLE_H` | 400 | px |
| `BALL_R` | 10 | px |
| `POCKET_R` | 20 | px |
| `BALL_COUNT` | 16 | balls |
| `PHYS_H` | 1/240 (= 0.00416667) | s |
| `MAX_CHUNK` | 0.25 | s |
| `MAX_SPEED` | 1400 | px/s |
| `MIN_SPEED` | 200 | px/s |
| `FRICTION` | 260 | px/s² |
| `STOP_SPEED` | 6 | px/s |
| `WALL_RESTITUTION` | 0.86 | — |
| `BALL_RESTITUTION` | 0.96 | — |
| `CUE_START_X` | 200 | px |
| `CUE_START_Y` | 200 | px |
| `RACK_APEX_X` | 560 | px |
| `RACK_APEX_Y` | 200 | px |
| `RACK_GAP` | 20.2 | px |
| `RACK_DX` | 17.4937 | px |
| `AIM_STEP` | 0.02 | rad |
| `POWER_STEP` | 40 | px/s |
| `BALL_POINTS` | 100 | points |
| `SHOT_PENALTY` | 15 | points |
| `FOUL_PENALTY` | 50 | points |
| `LOG_SIZE` | 64 | entries |

`RACK_DX` 不是手写常量：源码由
`RACK_GAP × √3 / 2 = 20.2 × 0.8660254 = 17.493713…` 算出（标准三角格）。
`setPower` 把力度夹在 `[MIN_SPEED, MAX_SPEED]`——就是这两个常量，用它们的正式
名字暴露。

## 物理为什么站得住

**P1 — 不可能穿透（算术结论）。** `advance()` 内部每个子步最多走一个物理格，
而子步长度永不超过 `PHYS_H`：

```
MAX_SPEED × PHYS_H = 1400 / 240 = 5.8333 px < 2 × BALL_R = 20 px
2 × MAX_SPEED × PHYS_H = 11.6667 px < 20 px          （两球对撞，相对位移）
```

所以球既不会跳过别的球的接触圆，也不会在一个格内跳过自身直径。接触判据是
**重叠**（`dist < 2·BALL_R`）而不是相等判据，因此这个界还留有余量。

**P2 — 固定物理格，提交步长无法改变结果。** `advance(balls, h)` 把 `h` 切成
`round(h / PHYS_H)` 个长度恰为 `PHYS_H` 的格子，只有当 `h` 不是整数倍时才追加
一个 `h mod PHYS_H ≤ PHYS_H` 的余量格。它绝不按「格子数」去等分 `h`（那才会
让粗步长变宽、让球互相穿过）。结论：任何 `PHYS_H` 整数倍的 `h`，一次调用与
等价的一组小步调用逐位相同。

```
1/30 一次  ≡  1/240 共八次      实测 x,y,vx,vy 最大 |Δ| = 0
1/60 一次  ≡  1/240 共四次      实测最大 |Δ| = 0
0.25 一次  ≡  1/240 共六十次    实测最大 |Δ| = 0
```

**P3 — 球永远在台面上。** 每个格结束时都会做位置夹取，满足
`BALL_R ≤ x ≤ TABLE_W − BALL_R` 与 `BALL_R ≤ y ≤ TABLE_H − BALL_R`；撞库那一
步也是先夹回再反射。去重叠可能把被挤住的球推出库边零点几个像素，格末的夹取
会把这点位移吃掉（不改变速度），因此该界在**每一次** `advance()` 调用结束时都
成立，也就对每次 `getState()` 成立。

**P4 — 能量只减不增。** 每次反弹都只乘在法向分量上，所以该分量的动能被乘上
平方：

```
球球：BALL_RESTITUTION² = 0.96² = 0.9216
撞库：WALL_RESTITUTION² = 0.86² = 0.7396
摩擦：|v| ← max(0, |v| − FRICTION·dt)   （只会让 |v| 变小）
```

撞库反射只在法向速度**指向**库边时触发，所以把一个已经在往台内走的球夹回原位
永远不会注入能量。去重叠移动的是圆心而不是速度，同样不增加能量。

**P5 — 等质量碰撞，切向不受影响。** 令 `n = (b − a)/|b − a|`、
`vn = (v_b − v_a)·n`：

```
j = −(1 + BALL_RESTITUTION) · vn / 2      （冲量一半给每颗球）
v_a ← v_a − j·n ,  v_b ← v_b + j·n
```

于是法向相对速度变成 `−0.96 · vn`（`RESTITUTION = 1` 时两球法向速度精确互换）。
球与球之间没有摩擦，切向分量不变——切球走的就是连心线。

**P6 — 每一杆都会停，且有闭式解。** 库仑摩擦是常量减速，所以到静止的距离与时间
是精确值：

```
满力：  MAX_SPEED² / (2·FRICTION) = 1960000 / 520 = 3769.2308 px
        MAX_SPEED / FRICTION       = 1400 / 260   =    5.3846 s
最轻：  MIN_SPEED² / (2·FRICTION) = 40000 / 520    =   76.9231 px
        MIN_SPEED / FRICTION       = 200 / 260     =    0.7692 s
```

球的速度第一次跌到 `STOP_SPEED` 及以下时立即置零，所以每杆最多
`5.3846 s` 加上弹跳时间（弹跳只会带走能量）。实测：满力开球在 **3.392 s**
后全部静止。

**P7 — 摆球可证，而不是「看起来随机」。** `rack(seed)` 用 `RACK_APEX_X/Y`、
`RACK_GAP`、`RACK_DX = RACK_GAP·√3/2` 摆出标准三角格，因此每个相邻球心距都
恰好是 `20.2 px`（≥ `2·BALL_R = 20 px`，余量 0.2 px），整座球堆落在
`x ∈ [560, 629.9749]`、`y ∈ [159.6, 240.4]`，距每条库边至少
`BALL_R = 10 px`。**8 号球固定在第三排正中**：

```
x = RACK_APEX_X + 2·RACK_DX = 560 + 34.9874 = 594.9874
y = RACK_APEX_Y             = 200
```

其余十四个号码由同一条 `mulberry32` 流洗牌，所以同种子同摆法、不同种子不同
摆法。母球在 `(200, 200)`，到顶点球有一条**长 360 px 的空线**：最近的其他球
球心距该线段 `20.2 px`，比 `20 px` 的接触距离还多 `0.2 px`，因此没有任何球能
挡住开球。实测：球堆内最小球心距 **20.200000 px**，越出库边的球 **0** 颗。

## 测试桥接（`window.PL`）

- **`constants`** —— 上面那张冻结表，每个名字都暴露成数值。
- **`rack(seed)`** → 16 个球对象（母球在前，随后按格点顺序排三角）。纯函数：
  不碰 `Math.random()`，同种子同数组。
- **`advance(balls, h)`** → `{ balls, events }`。纯函数：先深拷贝入参，绝不修改
  它（已验证：调用前后入参 JSON 完全相同）。落袋的球从返回数组里**移除**，并
  以 `{t, type:'pot', a:id, b:null, x:袋心x, y:袋心y}` 记在事件里。事件类型有
  `'ball'`（带两个 id）、`'wall'`、`'pot'`、`'stop'`；`t` 是从本次调用起点累计
  的时间，因此事件时间单调不减。
- **`pockets()`** → 六个 `{x,y,r}`：`(0,0) (0,400) (400,0) (400,400) (800,0)
  (800,400)`。
- **`scoreOf({potted, shots, fouls})`** → 整数分数，下限 0。`potted` 可以是数量
  也可以是数组本身。
- **`stopDistance(v)`** = `v²/(2·FRICTION)`，**`stopTime(v)`** = `v/FRICTION`，
  **`substepTravel()`** = `MAX_SPEED·PHYS_H`，**`energyRatio(e)`** = `e²`。
- **`respotSpot(balls)`** → `{x, y}`：头点周围确定性环形搜索得到的第一个空位
  （避开球、库边和袋口圆）。对入参是纯函数。
- **`getState()`** → 深拷贝：`{phase, paused, seed, shots, fouls, potted:[ids],
  remain, score, best, aim, power, elapsed, over, balls:[…]}`。
- **`hudCache()`** → HUD 值缓存的副本（`score`、`best`、`shots`、`potted`、
  `fouls`、`remain`、`msg`、`status`、`pauseLabel`、`pauseOff`）；每个值就是
  真正写进 DOM 的字符串。
- **`log()`** → 最近 `LOG_SIZE = 64` 条事件的副本。
- **`newGame({seed})` · `start()` · `pause()` · `resume()` · `togglePause()`**。
- **`aimAt(x,y)`**（绝对台面坐标——瞄准方向就是母球指向该点的方向）、
  **`rotateAim(d)`**（弧度）、**`setPower(p)`**（夹到
  `[MIN_SPEED, MAX_SPEED]`）、**`shoot()`**（仅在 `phase === 'aiming'` 且未
  暂停时有效）。
- **`tick(seconds, step)`** → `getState()`。它是**唯一能把粗步长喂进
  `advance()` 的通道**：`seconds` 按 `step`（默认 `PHYS_H`，上限 `MAX_CHUNK`）
  分块，每块调一次 `advance()`，最后刷新一次 HUD。由于 P2，`tick(2, 1/30)` 与
  `tick(2, 1/240)` 得到的**球**状态一样——在 `x, y, vx, vy` 上实测最大 `|Δ|`
  = **0**。唯一会分家的字段是 `elapsed`：它在「最后一颗球停下的那一块」结尾
  冻结，所以步长更粗时最多会多算一块。整局的 `tick(8)` 与 `tick(10)` 则在
  **每一个**字段上都一致，因为两者都在同一块里停下。

本页面遵守的桩约束：`requestAnimationFrame` 是唯一的时钟（页面里没有任何
`setTimeout`，也没有任何流程由 interval 驱动）；smoke 桩的
`document.querySelectorAll()` 返回 `[]`，所以所有元素都用 `getElementById` 取；
桩里 `getAttribute()` 恒为 `null`、`setAttribute()` 是空操作，因此状态从不从
DOM 读回；桩的 `localStorage` 没有 `removeItem` 而且可能抛异常，所以两处访问
都包了 `try/catch`；桩的 `el.style` 是普通对象，但**直接赋值会被真实保存**，
这就是所有位置都用 `style.transform` 写入、而不是用 CSS 自定义属性的原因。

## 确定性

- `rack(seed)` 是纯的：一条 `mulberry32(seed)` 流只驱动一次对十四个非八号球
  的 Fisher-Yates 洗牌，别的什么都不做。8 号、母球和十五个格点位置都是几何
  常量。
- `advance(balls, h)` 是纯的、固定格的：同输入同输出，且绝不改动入参数组。
- 实际对局**没有其它随机源**——瞄准、力度、规则都由显式输入驱动，因此
  `newGame({seed: 1})`、`start()`、同一串 `shoot()`/`tick()` 会复现同一局。
  屏幕上的实时对局**不是**逐帧一致的，因为 rAF 时间戳决定了每帧的 `dt`；而
  通过 `tick()` 跑的无头对局是逐位一致的。

## 运行

直接用浏览器打开 `index.html` 即可——零依赖、无需构建。页面顶部自带
English / 简体中文 切换，并会记住选择。
