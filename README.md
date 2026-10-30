# Wide-Grid

一款双人对战的卡牌游戏，由三份设计材料实现而来：

- `assets/src/cards.xlsx` —— 100 张卡牌设计表
- `assets/src/flow.docx` —— 游戏流程与首次纸面测试 V0.2
- `assets/src/table.psd` —— 桌面布局设计稿

## 怎么玩

双击打开 **`game/index.html`**。

不需要装任何东西，不需要服务器，不需要联网。Chrome / Edge / Firefox 都行。

1. 点「快速开始」用随机牌组开局，或「自选牌组」自己组 30 张。
2. 换牌阶段：点击不想要的手牌，点「开始对局」（也可以不换直接开始）。
3. 对局中：
   - **部署阶段**：点手牌 → 点亮的格子打出；点场上的宽幅卡可以升级。
   - 点「进入战斗」→ 点自己的单位 → 点敌方单位或敌方玩家 → 它打一次。
   - 点「结束回合」把回合交给对手。
4. 把对手 15 点生命打光，或者让对手把牌库抽干。

界面截图在 [`assets/screens/`](assets/screens/)。

完整规则见 **[`game/RULES.md`](game/RULES.md)**，游戏里也有「规则」按钮。

## 项目结构

```
game/
  index.html                    入口
  RULES.md                      规则书（权威版本）
  EFFECTS_API.md                效果系统接口契约
  css/style.css                 样式
  js/
    data/cards.js               100 张卡数据（由 tools/gen_cards.py 生成，勿手改）
    engine/constants.js         常量与工具
    engine/engine.js            规则引擎（无 DOM 依赖，可单独在 node 里跑）
    engine/effects_core.js      效果框架 + 宽幅卡 76-100
    engine/effects_units_a.js   普通单位卡 1-38
    engine/effects_units_b.js   普通单位卡 39-75
    ui/ui.js                    界面与 AI 对手
tools/
  gen_cards.py                  xlsx → cards.js
  psd_layers.py                 PSD 图层边界提取
  test_engine.js                引擎冒烟测试
  test_effects_a.js / _b.js     效果卡测试
  test_ui_dom.js                UI 防白屏测试
  test_soak.js                  随机对局压力测试（500 局）
assets/src/                     原始设计材料 + 设计稿预览图
assets/screens/                 界面截图
```

## 架构

引擎和界面是**完全分离**的：

- `engine.js` 不碰 DOM、不碰 `window` 之外的宿主 API，只接收一个 `st` 状态对象并返回结果对象。
  所以它能在 node 里被直接测试（`tools/test_engine.js` 就是这么做的）。
- 所有卡牌效果挂在 `WG.Effects[卡牌id]` 上，通过一组固定钩子（`static` / `onDeploy` /
  `onAttack` / `onDamaged` / `onTurnStart` 等）接入引擎。新增卡牌只需要加一个对象，
  不用改引擎。契约见 `game/EFFECTS_API.md`。
- 界面每步操作后全量重绘。100 张卡的体量下这样最省心，也不必担心状态不同步。

**生命模型**是这块最容易踩坑的地方：单位只有 `maxHp` 和 `wounds`（累计伤害），
当前生命 = 有效最大生命 − 累计伤害。所以「+1 生命」是提升最大生命（当前生命跟着涨），
「受到 3 点伤害」是累计伤害 +3，回合结束累计伤害清零。

## 测试

```bash
node tools/test_engine.js        # 引擎与宽幅卡（30 断言）
node tools/test_effects_a.js     # 单位卡 1-38（93 断言）
node tools/test_effects_b.js     # 单位卡 39-75（90 断言）
node tools/test_ui_dom.js        # UI 加载与防白屏（35 断言）
node tools/test_soak.js 500      # 500 局随机对局，查死循环与状态不变量
```

（Windows 上用 DSH 自带的 node 也可以：
`"C:/Users/20306/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe" tools/test_engine.js`）

## 原文档的两处空白与我们的裁定

1. **宽幅卡强化形态没有数值。** 文档说明了升级是「在场状态变化」，但没给强化后加多少。
   我们定为：升级费用按卡 1-4 点能量，强化后该卡的增益数值 +1。详见 `RULES.md` §5。

2. **定义牌没有任何卡能赋予定义。** 卡表里的 100 张卡没有一张写明「赋予定义牌内容」，
   所以定义牌在实际对局中永远无法发动。我们把占位、排挤、连续锁定限制这套机制
   完整实现在引擎里，但它是设计预留位——不是 bug，是原设计的留白。

这两点在 `RULES.md` 里都标了「【实现补充】」，不会和原文档的规则混淆。
