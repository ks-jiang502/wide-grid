# Wide-Grid 效果系统 API 契约

> 本文件是 `game/js/engine/effects_*.js` 的**唯一接口规范**。
> 改动引擎前先改本文件。所有效果挂在 `WG.Effects[卡牌id]` 上，id 与 `WG.CARDS[].id` 一致。

---

## 0. 加载顺序（必须遵守）

`index.html` 里脚本顺序固定为：

```
js/engine/constants.js
js/data/cards.js
js/engine/engine.js
js/engine/effects_core.js      ← 框架 + 宽幅卡 76-100
js/engine/effects_units_a.js   ← 普通单位 1-38
js/engine/effects_units_b.js   ← 普通单位 39-75
js/ui/ui.js
```

**每个效果文件都用 IIFE 包裹**，形状一律是：

```js
(function (WG) {
  'use strict';
  WG.Effects = WG.Effects || {};
  var E = WG.Effects;
  var U = WG.EffectsUtil;          // 由 effects_core.js 提供

  E[1] = { /* ... */ };

})(typeof window !== 'undefined' ? (window.WG = window.WG || {}) : (global.WG = global.WG || {}));
```

不许用 `import` / `export` / `require`，不许改文件末尾那段 IIFE 形状（node 测试靠它）。
不许修改 `cards.js`（自动生成）与 `engine.js`（引擎）。**只写自己的 effects 文件。**

---

## 1. 生命模型（最容易搞错，先读这段）

单位实例的字段只有这些：

| 字段 | 含义 |
|---|---|
| `u.cardId` | 卡牌 id |
| `u.uid` | 实例唯一 id |
| `u.owner` | 0 / 1 |
| `u.slot` | 0-5，`WG.areaOfSlot(slot) = Math.floor(slot/2)+1` |
| `u.atk` | **基础**攻击力（永久修改变它） |
| `u.maxHp` | **基础**最大生命（永久修改变它） |
| `u.wounds` | **累计伤害**（受伤害加它，治疗减它） |
| `u.staticAtk` / `u.staticHp` | 引擎写入，**不要直接写** |
| `u.buffs` | `[{atk,hp,until:'turnEnd',tag,src}]` |
| `u.exhausted` / `u.attacked` | 横置 / 本回合已攻击 |
| `u.flags` | 你的私有标记，**每回合开始自动清空**（`u.flags = {}`） |
| `u.upgraded` | 仅宽幅卡 |

引擎识别的特殊 flags（写进去就生效，用完自动清）：

| flag | 作用 | 用在 |
|---|---|---|
| `u.flags.noWide = true` | 该单位**不获得任何宽幅卡增益**（`wideAtkFor`/`wideHpFor` 直接返回 0） | 卡 67 |
| `u.flags.gainModAtk = ±N` | 该单位**下一次获得攻击增益**时额外 ±N（只作用于 `T.buff`，不影响宽幅卡实时加成） | 卡 37 / 60 |
| `u.flags.atkDmgMod = ±N` | 该单位**下一次攻击造成的伤害** ±N（`attackDamage` 读取后立即 delete） | 卡 54 |
| `u.flags.dmgPlus = +N` | 该单位**下一次受到的伤害** +N（`dealDamage` 在减免结算后追加，用完即清） | 卡 69 |

计算式：

```
有效攻击力 effAtk    = u.atk + u.staticAtk + Σ buffs.atk + Σ 宽幅卡增益
有效最大生命 effMaxHp = u.maxHp + u.staticHp + Σ buffs.hp + Σ 宽幅卡增益
当前生命   effHp    = effMaxHp - u.wounds
存活       effHp > 0
```

**所以：**

- 「攻击力 +N」→ `static` 返回 `{atk:N}`（持续）或 `T.buff(u,{atk:N})`（临时）
- 「生命值 +N」→ `static` 返回 `{hp:N}` —— 因为当前生命 = effMaxHp - wounds，**最大生命涨了当前生命同步涨**，不要去动 `wounds`
- 「受到 N 点伤害」→ `T.hurt(u, N)`（走减免）或 `u.wounds += N`（不减免）
- 「治疗 N 点」→ `T.heal(u, N)`，即 `wounds = max(0, wounds-N)`
- 「永久 +N 攻击力」（卡面写"永久"时）→ `T.permAtk(u, N)`
- 「永久 +N 生命」→ `T.permHp(u, N)`

⚠️ **绝对不要写 `u.hp`**——那个字段不存在。判断存活用 `WG.Engine.isAlive(st, u)` 或 `WG.Engine.effHp(st, u) > 0`。

---

## 2. 上下文对象 `T`

每个钩子的最后一个参数都是 `T`（引擎的 `ctx()`），可用成员如下：

### 读

| 方法 | 返回值 |
|---|---|
| `T.st` | 整局状态对象（见 §6） |
| `T.side` | 触发方阵营（0/1） |
| `T.card` | 触发的卡牌定义（`WG.CARDS` 里的对象） |
| `T.self` | 触发的单位/宽幅卡实例 |
| `T.area(u)` | 该单位所在区域 1-3 |
| `T.units(side, area)` | 某方某区域的单位数组（**不含**死亡单位） |
| `T.myArea(u)` | u 所在区域的**全部友方**（含自己） |
| `T.friends(u)` | u 所在区域的友方（**不含**自己） |
| `T.enemies(u)` | u 所在区域的敌方 |
| `T.enemyOf(side)` | 对手玩家对象 |
| `T.energy(side)` / `T.hp(side)` | 当前能量 / 生命 |
| `T.effAtk(u)` / `T.effHp(u)` | 有效数值（**只能用这个读，不要读 u.atk/u.hp**） |
| `T.hasWide(u)` | 是否吃到任何宽幅卡增益 |
| `T.wideCount(side, area)` | 该区宽幅卡数 |
| `T.areaCount(side, area)` | 该区单位数 |
| `T.areasOccupied(side)` | 该方有单位的区域数 |
| `T.tc()` | 本回合上下文（见 §5） |

### 写

| 方法 | 说明 |
|---|---|
| `T.buff(u,{atk,hp,tag})` | 临时增益，**回合结束清除**。tag 是给别的卡判条件用的标记（如 `'atk'`/`'hp'`/`'shield'`） |
| `T.permAtk(u,n)` | 永久攻击力 |
| `T.permHp(u,n)` | 永久最大生命 |
| `T.heal(u,n)` | 治疗 |
| `T.hurt(u,n)` | 造成伤害（走减免链，会触发 onDamaged） |
| `T.energy_(s,n)` | 获得能量（**不会超过上限**）。注意末尾下划线 |
| `T.draw(s,n)` | 抽牌（牌库空 → 该方判负） |
| `T.log(msg)` | 写对局日志 |
| `T.firstTime(u,key)` | 首次触发守卫：第一次返回 true 并置位，之后返回 false |

### 其他引擎动作（用 `WG.Engine.xxx` 调用）

```js
WG.Engine.moveUnit(st, u, newSlot)          // 移到空的己方槽，返回 {ok,from,to}
WG.Engine.peekTop(st, side, n)              // 看牌库顶 n 张（数组，顶在前）
WG.Engine.putBottom(st, side, offset)       // 把顶第 offset 张放底
WG.Engine.drawCards(st, side, n)
WG.Engine.destroyUnit → 用 WG.Engine._destroyUnit(st, u)
```

---

## 3. 单位卡钩子（全部可选）

```js
E[1] = {
  // ① 持续加成：每次状态重算都会调用，必须无副作用、纯函数
  static: function (u, T) { return { atk: 1, hp: 0 }; },

  // ①-b 光环：给「同区域的其他友方单位」持续加成。
  //     target = 被加成的单位，self = 光环来源（就是这张卡），T.self 也是 self。
  //     只对同区域生效；自己不会吃到自己的光环（要给自己加就用 static）。
  aura: function (target, self, T) { return { atk: 1, hp: 0 }; },

  // ② 部署时：T 的 self 已指向新单位，已放进 slot
  //    第三参 picked = choice.targets 数组（见 §4）
  onDeploy: function (u, T, picked) { },

  // ③ 攻击时（攻击方，伤害已在 pending 里记录后调用）
  onAttack: function (u, T) { },

  // ④ 自己将受到伤害前：返回减免量
  onBeforeDamage: function (u, n, T) { return { reduce: 1 }; },

  // ⑤ 保护同区域友方：f = 有该效果的单位，v = 受伤者（可能是 f 自己？不会，引擎跳过 f===v）
  protect: function (f, v, T) { return { reduce: 1 }; },

  // ⑥ 已经受到伤害后
  onDamaged: function (u, amount, T) { },

  // ⑦ 被破坏离场后（此时 slot 已清空，单位已进弃牌堆）
  onDestroy: function (u, T) { },

  // ⑧ 自己回合开始（横置已重置、能量已恢复、flags 已清空）
  onTurnStart: function (u, T) { },

  // ⑨ 自己回合结束（伤害清理之前）
  onTurnEnd: function (u, T) { },

  // ⑩ 打出前的目标选择
  targets: function (T) { return [ /* 见 §4 */ ]; }
};
```

**`static` 的铁律**：只读 `u`、`T`，**绝对不许**写状态、抽牌、造成伤害、改 `st`。它在一回合里会被调用几十次。
需要"每回合一次"的效果放 `onTurnStart` + `u.flags`。

---

## 4. 需要选择目标的卡

`targets(T)` 返回数组，每项：

```js
{
  key: 'pick',                    // 标识，可省略
  label: '选择一名友方单位',       // 给 UI 的提示文案
  optional: false,                // 缺省 false；true 表示允许"不选"
  options: [                      // 可选集合；空数组 + optional:false = 这张卡打不出去
    { uid: 123, label: '小提琴 2/3' },
    ...
  ]
}
```

`onDeploy(u, T, picked)` 里 `picked[0]` 就是玩家选的 option 对象（含 `uid`）。

**如果 `options` 会为空，必须设 `optional: true`**，否则这张卡永久无法打出（`canPlay` 会拒绝）。

---

## 5. 本回合上下文 `T.tc()`

```js
{
  side,                   // 当前回合方
  deployCount: [n0, n1],  // 各方本回合部署了几个单位
  playedWide: [b0, b1],   // 各方本回合是否打过宽幅卡
  playedWideIds: [[], []],// 各方本回合打过的宽幅卡 id
  attacked: [b0, b1],     // 各方本回合是否发起过攻击
  combatHappened: false,
  buffEvents: [],         // ctx.buff() 自动 push 的事件，可数：{side,tag,atk,hp}
  energyGained: [b0,b1],
  onceUsed: {}            // 通用"每回合一次"口袋，键自定：T.tc().onceUsed['k'+uid]
}
```

`u.attacked` 是"该单位本回合是否攻击过"，`T.tc().attacked[side]` 是"该方本回合是否攻击过"。

---

## 6. `T.st` 状态对象

```js
{
  players: [P0, P1],
  active, phase, turnCount,
  pending: {1:null,2:null,3:null},   // 战斗伤害暂存
  log: [...],
  over: null | { loser, reason },
  firstPlayer, round
}
P = {
  name, hp, energy, maxEnergy, turnsTaken,
  deck: [inst...],      // 0 位是底，末尾是顶
  hand: [inst...],      // inst = {cardId}
  discard: [inst...],
  units: [null x6],     // slot -> unit
  wides: {1:null,2:null,3:null},  // 区域 -> wide
  definition: { charge, lockedAreas: [] }  // 定义牌，一般不用碰
}
```

---

## 7. 宽幅卡钩子（只给 effects_core.js，单位卡文件不要碰）

```js
E[76] = {
  upgradeCost: 2,                                  // 强化费用
  wideAreas: function (T) { return [1, 2]; },      // 可放的区域；缺省 [1,2,3]（占几个槽）
  wide: function (u, T) { return { atk: 2 }; },    // 对该区域内每个友方单位的加成
  wideProtect: function (w, v, T) { return { reduce: 1 }; },
  onDeploy: function (w, T, picked) {},
  onTurnStart: function (w, T) {},
  targets: function (T) { return []; }
};
```

---

## 8. 写效果的常见陷阱

1. **`static` 里写副作用** → 引擎无限重算，数值爆炸或死循环。禁止。
2. **直接改 `u.atk` 而不是返回 `static`** → 看起来能用，但每次 `applyStatics` 不会撤销你的修改，条件失效后加成永远留着。持续型一律用 `static`。
3. **读 `u.hp`** → undefined，比较全部失效。用 `T.effHp(u)`。
4. **在 `onDeploy` 里判断 `T.self`** → 引擎已把 `T.self` 指向新单位，直接用 `u` 参数即可，不要用 `T.self`。
5. **抽牌导致牌库空** → `T.draw` 会让对方/自己判负，这是文档规则，不要绕过。
6. **`targets` 返回空 options 却没设 optional** → 该卡永远打不出去。
7. **跨卡依赖**：不要引用别的卡 id 的 `WG.Effects[...]`（除了自己文件内已定义的），会因加载顺序炸。要判断"某单位有没有某效果"，用 `u.flags` 或 `T.hasWide(u)`。
8. **判断"区域内有友方"** 包含自己吗？——`T.friends(u)` **不含**自己，`T.myArea(u)` **含**。按卡面语义挑。
9. **数值上限**：能量不得超过 `maxEnergy`（用 `T.energy_`），手牌没有上限（文档未规定）。
10. **`u.flags` 每回合开始清空**，所以"本回合首次"用 flags 不需要手动清。

---

## 9. 自测

```bash
node tools/test_engine.js      # 引擎 + 宽幅卡冒烟测试
node tools/test_effects.js     # 效果卡专项测试（你的文件要能通过）
```

写效果时同步在 `tools/test_effects.js` 里加断言。**不许为了通过测试改测试的期望值**——如果你认为期望值错了，说明你为什么认为它错。
