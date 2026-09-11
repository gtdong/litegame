# 为 litegame 贡献代码

**[简体中文](CONTRIBUTING.zh.md)** · [English](CONTRIBUTING.md)

感谢你愿意帮忙。这份指南故意写得很短。

先说一件事：**这个仓库里的每一行代码都是 AI 写的，不是人敲的。** 这不是噱头，而是这个项目的设计约束 —— 也正因为如此，下面两条铁律才这么重要，测试套件才承担了这么重的责任。人的贡献和 AI 的贡献同样欢迎，标准也一样。

## 两条铁律

这个仓库里的一切都遵守两条硬性约束：

1. **零依赖。** 不用框架、不用 npm 包、不引 CDN。如果需要靠库才能跑，那它就不属于这里。
2. **无构建步骤。** 提交的文件就是发布的文件。clone 下来，打开 `index.html`，结束。

任何引入 `package.json` 依赖或构建流水线的 PR 都会被拒绝 —— 不是因为不好，而是因为它破坏了这个项目的立身之本。

## 开始

```sh
git clone https://github.com/gtdong/litegame.git
cd litegame
node tools/smoke.js      # 应该输出：N/N games smoke-clean
```

然后用浏览器打开 `index.html` 就行，没有别的要配置。

## 新增一个游戏

1. **建目录。** 复制一个现成的，比如 `cp -r snake-game my-game`，重命名为 `<name>-game/`。

2. **在 `<name>-game/index.html` 里写游戏。** 保持自包含 —— 单个文件，CSS 和 JS 都内联，不要 import。

3. **界面双语，代码不双语。**
   - 玩家能看到的所有文案都必须有英文和简体中文两份。
   - 用 [`assets/i18n.js`](../assets/i18n.js) 这个共享工具，不要自己再造一个切换器。给元素打上 `data-i18n`（或 `data-i18n-html` / `data-i18n-title` / `data-i18n-placeholder`）标记，并用 `LiteI18N.create({...})` 注册词典。
   - 任何运行时拼出来的文案都必须走 `T.t()`，**并且**在 `T.onChange()` 里重新渲染，否则切语言时它不会跟着变。
   - 先初始化游戏，再调 `T.start()`，顺序不要反。
   - **代码注释一律用英文。**

4. **永远给玩家一个看得见的入口。** 如果游戏有 `ready` 状态，就必须渲染出开始按钮或遮罩。一个加载后毫无反应、也不告诉玩家怎么开始的棋盘就是 Bug —— 这个仓库里已经出过不止一次。

5. **暂时不能用的按钮要 `disabled`**，而不只是「点了没反应」。

6. **给游戏写两份 README**：`README.md`（英文）和 `README.zh.md`（简体中文），顶部都要有左对齐的语言切换行。

7. **在四个地方登记这个游戏：**
   - 根 `index.html` 卡片墙里加一张卡片（链接不带结尾斜杠，例如 `href="my-game/"`）；
   - `index.html` head 里 JSON-LD `ItemList` 加一条 `<ListItem>`，并把 `numberOfItems` 加一；
   - `README.md` 和 `README.zh.md` 的表格里各加一行；
   - `sitemap.xml` 里加一条 `<url>`。

## 测试

分两层，提 PR 前两层都必须绿。

**`tools/smoke.js`** 会自动发现所有 `*-game/` 目录，在桩 DOM 里加载、按键、点按钮、快进定时器、跑动画帧，只断言「不抛异常」。任何一次改动之后都跑一下：

```sh
node tools/smoke.js
```

**各游戏专项逻辑测试**（`tools/*-test.js`）用 `vm` 沙箱加载整份游戏脚本，因此测试能读到内部状态，从而断言规则本身是否正确。现有套件：

```sh
node tools/tetris-test.js     # 98 项 —— SRS、7-bag、计分、T-spin、重力、调速
node tools/sokoban-test.js    # 104 项 —— 关卡合法性、BFS 求解、真实按键重放
```

如果你加的游戏规则比较复杂，就补一个套件。有两个习惯比覆盖率数字更重要：

- **从真实的 UI 入口测起。** 直接调 `newGame()` 的测试，永远发现不了「页面上根本没有按钮可点」。要点那个真实的按钮。
- **验证内容本身，而不只是「没崩」。** 关卡类或出题类游戏必须证明关卡真的可解 —— `sokoban-test.js` 对每一关跑 BFS 求解器，再把解通过真实键盘事件重放一遍。「加载没报错」是抓不到那种「推箱方向写反了」的关卡的。

## 提 PR 之前

- [ ] `node tools/smoke.js` 通过
- [ ] 每个 `node tools/*-test.js` 都通过
- [ ] 新增文案的中英两版都在
- [ ] 新游戏已在 `index.html`（卡片墙 **和** JSON-LD `ItemList`）、`README.md`、`README.zh.md`、`sitemap.xml` 四处登记
- [ ] HTML 里没有残留 `data-page-node-id` 之类的编辑器注入属性
- [ ] 没有提交密钥、内网主机名或本机绝对路径

然后用 PR 模板描述你改了什么。视觉类改动非常欢迎附截图或短录屏。

## 提 Bug

用 Bug 表单。最好用的描述形状是「打开哪个游戏，按了什么键，结果发生了什么、而你以为会发生什么」。记得带上浏览器和系统，因为布局和按键处理在不同平台上确实会不一样。

## 翻译与打磨

改一个别扭的英文用词、修一处中文翻译、调一下间距、让移动端布局正常 —— 在这个项目里都是真正有价值的贡献。你不必非得写一个游戏才能帮忙。

## 许可

提交贡献即表示你同意你的作品基于 [MIT License](LICENSE) 发布。
