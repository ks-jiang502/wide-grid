# UI 资源模块接口契约 v1

> 给并行开发者：本文件定义 **卡面渲染** 与 **音频系统** 两个独立模块的接口。
> 两个模块各自一个文件，互不依赖，也不允许改 `game/js/ui/ui.js`、`game/js/engine/*`、`game/css/style.css`。
> 你的文件写完之后，由 Lead 在 `ui.js` 里接线。

## 0. 通用约束（两个模块都适用）

- **纯 ES5**，IIFE 包裹，只用 `var` / `function`，不用 `let`/`const`/箭头函数/模板字符串。
- 全局命名空间：挂到 `window.WG` 下的子对象，互相不覆盖。
- **零外部资源**：不加载任何图片、字体、音频、网络请求。所有视觉/音频都由代码生成。
- 页面可能以 `file://` 打开，不能假设有服务器。
- 加载顺序固定：`constants → cards → engine → effects_core → effects_units_a → effects_units_b → cardface → audio → ui`。
- 任何异常都要自己吞掉（`try/catch`），**绝不能让游戏白屏或卡死**。出错时退化为「什么都不画 / 什么都不播」，不能抛到全局。
- 代码注释用中文，写「为什么」不写「是什么」。

## 1. 卡面模块：`game/js/ui/cardface.js`

### 1.1 卡数据的形状（来自 `game/js/data/cards.js`）

```js
// 普通单位卡
{ id: 26, type: 'unit', name: '五弦贝斯', cat: '乐器演奏',
  cost: 4, atk: 3, hp: 5,
  text: '若相邻的两个攻击区域均有友方单位，获得+1攻击力。',
  pos: '低频支撑', art: '（美术主题描述）' }

// 宽幅卡
{ id: 96, type: 'wide', name: '...', cat: '...', cost: 3,
  wcat: '攻击增益', text: '...', pos: '...', art: '...' }
```

`cat` 的取值只有这 6 类（普通单位卡）：
`演奏技法与节奏`(id 1-15) / `乐器演奏`(16-30) / `乐队编制与演奏岗位`(31-45) /
`音乐理论与作曲`(46-55) / `录音混音与电子音乐`(56-65) / `舞台与音乐制作`(66-75)

宽幅卡的 `wcat` 取值：`攻击增益` / `防护增益` / `资源辅助` / `抽牌辅助` / `牌库调整` / `跨区域协同`（id 76-100）

`art` 字段是这张卡的美术主题描述，可作为构图的语义依据（但不要求画出具象物体）。

### 1.2 必须实现的对象

```js
window.WG.CardFace = {
  /**
   * 卡面插画区。返回一段 SVG 字符串（不含外层 <svg> 的话自己包），
   * 用 viewBox 做尺寸自适应，不要写死 width/height 属性绝对值。
   * @param {object} card  卡数据对象
   * @param {object} opts  { w:number, h:number, variant:'normal'|'upgraded', side:'me'|'opp' }
   * @returns {string} SVG 字符串
   */
  art: function (card, opts) { ... },

  /**
   * 缩略图：场上单位/宽幅区用的整张卡面（含底部费用/攻血很小的一行）。
   * 只用在「场上卡牌」这一种场景，尺寸由容器决定（viewBox 0 0 250 350）。
   * @returns {string} SVG 字符串
   */
  thumb: function (card, opts) { ... },

  /**
   * 分类配色。返回 { accent, deep, pale, motif }
   * accent = 主色（十六进制），deep = 深色版，pale = 浅底，motif = 该分类的图形语言名
   */
  catStyle: function (cat) { ... }
};
```

### 1.3 视觉规格

- **画布比例 5:7**（`viewBox="0 0 250 350"`）。宽幅卡是横置的，但你仍按 5:7 竖版画，由 CSS 旋转/缩放。
- **风格定位**：延续项目现有的克制美学 —— 米白纸面 `#f4f2ed` 底、深墨 `#1b1a17` 线、极细描边（0.6-1.2px）、大量留白。
  不要做赛博霓虹、不要浓艳渐变、不要 emoji。做成「乐谱纸上的抽象乐理图」那种感觉。
- **每张卡必须视觉可区分**，但不能是随机噪点。用**确定性伪随机**：以 `card.id` 为种子，同一个 id 每次渲染结果必须完全一致（不能 `Math.random()`）。
- **图形语言按 `cat` 分 6 套**，每套一种构成方式（举例，可自行设计得更巧妙）：
  - 演奏技法与节奏 → 等距竖条（节奏刻度）+ 弧线连音
  - 乐器演奏 → 乐器轮廓的极简线稿（弦/管/键的抽象化，3-6 笔）
  - 乐队编制与演奏岗位 → 网格站位点阵 + 编号
  - 音乐理论与作曲 → 五线谱横线 + 音级点阵
  - 录音混音与电子音乐 → 波形/频谱柱 + 网格底噪
  - 舞台与音乐制作 → 同心弧（声场）+ 光斑
- 宽幅卡：构图更横向铺开，加一条贯通的粗基准线表示「覆盖范围」。
- `variant === 'upgraded'` 时加深主色、加一圈细描边双线，不要加发光。
- **文字一律不放进 SVG**（字体渲染不可控），卡面上的文字由 HTML 层叠加。

### 1.4 自测

写一个 `tools/test_cardface.js`，用 vm 沙箱加载 `constants.js` + `cards.js` + `cardface.js`，断言：

1. `WG.CardFace` 存在，三个方法都是函数
2. 遍历全部 100 张卡：`art()` 都返回非空字符串、包含 `<svg`、不含 `undefined`/`NaN`/`null` 字样
3. 同一个 id 调用两次，结果**字符串完全相同**（确定性）
4. 6 个 `cat` 的 `catStyle()` 返回的 `accent` 互不相同
5. 输出长度在合理区间（比如每张 200~20000 字符），防止有人塞了巨大的 base64
6. `opts` 缺省（不传）时不报错

跑法：`node tools/test_cardface.js`，最后打印 `=== 结果：全部通过 ✓ ===` 或失败明细。

## 2. 音频模块：`game/js/ui/audio.js`

### 2.1 必须实现的对象

```js
window.WG.Audio = {
  init: function () {},          // 首次用户手势时调用，里面 resume AudioContext
  sfx: function (name) {},       // 播放一个音效，name 见下表
  bgm: function (track) {},      // 'main' | 'battle' | 'off'
  setMuted: function (v) {},     // 全局静音
  isMuted: function () {},       // 返回 bool
  setVolume: function (v) {}     // v = { master:0..1, music:0..1, sfx:0..1 }
};
```

**音效名（必须全部实现，缺一个就少一处反馈）**：

| name | 触发时机 | 声音设计 |
|---|---|---|
| `click` | 点任意按钮 | 极短（30ms）木质轻点，中高频 |
| `select` | 选中手牌/单位 | 一声清亮的泛音（像轻敲玻璃杯） |
| `cancel` | 取消选择 | select 的反向下行 |
| `draw` | 抽牌 | 纸张摩擦：带通噪声 + 快速衰减 |
| `play` | 部署单位 | 低频「落子」闷响 + 一点纸声 |
| `wide` | 部署/升级宽幅卡 | 更宽的低频铺底 + 轻微和声 |
| `upgrade` | 宽幅卡强化 | 上行三音琶音 |
| `attack` | 发起攻击 | 短促的弓弦刮擦（噪声 + 快速扫频） |
| `hit` | 单位受伤 | 低频撞击 + 短噪声尾 |
| `die` | 单位被破坏 | 下行滑音 + 噪声散开 |
| `energy` | 能量恢复/消耗 | 极轻的铃声（高频正弦 2 个） |
| `turn` | 回合切换 | 两声间隔的和弦（像翻页+定音） |
| `mulligan` | 换牌 | 洗牌声（多次短噪声） |
| `win` | 胜利 | 大调上行五音琶音，留长尾 |
| `lose` | 失败 | 小调下行，短尾 |

**BGM 轨道**：

- `main`：**72 BPM，D 大调五声（D E F# A B）**，做成可无缝循环的 8 小节。
  编制用纯合成：低频 pad（两个失谐锯齿/三角波经低通）+ 中频柔和拨弦（衰减正弦）+ 极轻的高频空气声。
  **要能长时间循环不烦**：不要有明显旋律记忆点，走和声铺底（Dmaj7 → Bm7 → Gmaj7 → A），音量压低（约主音量的 35%）。
- `battle`：同调性，速度提到 **96 BPM**，加入稳定的低频脉冲（每拍一下）和更明显的节奏层，紧张但不吵。
- 切换轨道要**淡入淡出**（0.6 秒），不能硬切。

### 2.2 硬性要求

- **只用 Web Audio API 程序化合成**，不加载任何音频文件、不 base64 内嵌音频。
- `init()` 之前**绝不能创建 AudioContext**（浏览器自动播放策略会让它挂起并报警告）。所有 `sfx`/`bgm` 调用在 init 之前必须静默返回。
- 每次 `sfx` 的节点用完必须 `stop()` + 断开连接，**不能泄漏**。快速连点 200 次不能爆音或卡死。
- 全局总音量要给个上限（比如 master 默认 0.6），避免刺耳。
- 所有方法 try/catch 包裹，音频不可用时游戏照常运行。

### 2.3 自测

写一个 `tools/test_audio.js`，用 vm 沙箱 **注入一个假的 AudioContext**（stub），断言：

1. `WG.Audio` 存在，6 个方法都是函数
2. 未 `init()` 前调用 `sfx('draw')`/`bgm('main')` 不报错、不创建 AudioContext（stub 计数为 0）
3. `init()` 后 AudioContext 恰好创建 1 次；再调 `init()` 不重复创建
4. 遍历全部 15 个音效名 + 3 个 BGM 轨道名：调用都不抛异常
5. 连续调用 `sfx('hit')` 200 次，stub 创建节点数有增长但不为 0、且没有异常
6. 传非法 name（`sfx('nope')`）静默跳过，不抛
7. `setMuted(true)` 后 `isMuted()` 为 true，且此时 `sfx` 不创建新节点

跑法：`node tools/test_audio.js`，同样打印 `=== 结果：全部通过 ✓ ===`。

## 3. 交付

- `game/js/ui/cardface.js`
- `tools/test_cardface.js`
- `game/js/ui/audio.js`
- `tools/test_audio.js`

回报时请写：文件行数、测试通过数、每个分类的配色值、以及你实际做出来的音色构成（用了哪些波形/滤波）。
