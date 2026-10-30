/* 引擎冒烟测试：node tools/test_engine.js
 * 用 vm 把浏览器脚本加载进一个带 window 的沙箱，跑通完整回合。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const sandbox = { console: console };
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log('  (skip ' + rel + ')'); return; }
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: rel });
}

const files = [
  'game/js/engine/constants.js',
  'game/js/data/cards.js',
  'game/js/engine/engine.js',
  'game/js/engine/effects_core.js',
  'game/js/engine/effects_units_a.js',
  'game/js/engine/effects_units_b.js'
];
files.forEach(load);

const WG = sandbox.WG;
const E = WG.Engine;
let fails = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); }
  else { console.log('  ✗ ' + msg); fails++; }
}

console.log('\n=== 1) 卡牌数据 ===');
ok(WG.CARDS.length === 100, '100 张卡');
ok(WG.CARDS.filter(c => c.type === 'unit').length === 75, '75 张普通单位');
ok(WG.CARDS.filter(c => c.type === 'wide').length === 25, '25 张宽幅卡');

console.log('\n=== 2) 建局 ===');
// 用 28 号（无特殊效果）与 13 号等构造牌组，保证同名 <= 2
function makeDeck(ids) {
  const d = [];
  for (let i = 0; i < ids.length; i++) { d.push(ids[i]); d.push(ids[i]); }
  return d.slice(0, 30);
}
// 15 种卡各 2 张 = 30，同名不超过 2
function stdIds(hero) {
  const pool = [28, 59, 13, 16, 4, 5, 1, 2, 3, 6, 7, 8, 10, 12, 14];
  if (hero) pool[0] = hero;
  return pool.slice(0, 15);
}
const deck0 = makeDeck(stdIds());
const st = E.newGame({ decks: [deck0.slice(), deck0.slice()], names: ['P0', 'P1'], seed: 42 });
ok(!st.error, 'newGame 成功' + (st.error ? ': ' + st.error : ''));
E.beginMatch(st);
ok(st.players[0].hand.length === 4, '起始手牌 4 张（P0）');
ok(st.players[1].hand.length === 4, '起始手牌 4 张（P1）');
ok(st.players[0].hp === 15 && st.players[1].hp === 15, '双方 15 血');
ok(st.players[0].energy === 3, '起始能量 3（P0 先手回合开始后仍为 3）');
console.log('  phase=' + st.phase + ' active=' + st.active + ' p0.energy=' + st.players[0].energy);

console.log('\n=== 3) 能量规则 ===');
// 先手第一回合：上限 3，能量 3（恢复 3 后不超过 3）
ok(st.players[0].maxEnergy === 3, '第一回合上限仍为 3');
// 让 P0 结束回合，看 P1
E.endTurn(st, 0);
ok(st.active === 1, '轮到 P1');
ok(st.players[1].maxEnergy === 3, 'P1 第一回合上限 3');
E.endTurn(st, 1);
ok(st.active === 0, '回到 P0');
ok(st.players[0].maxEnergy === 4, 'P0 第二回合上限 +1 = 4');
console.log('  P0 energy=' + st.players[0].energy + ' / ' + st.players[0].maxEnergy);

console.log('\n=== 4) 部署 ===');
// 找一张能打的单位卡
let hand = st.players[0].hand;
let idx = -1;
for (let i = 0; i < hand.length; i++) {
  const c = WG.cardById(hand[i].cardId);
  if (c.type === 'unit' && c.cost <= st.players[0].energy) { idx = i; break; }
}
ok(idx >= 0, '手牌中有可部署的单位卡');
if (idx >= 0) {
  const chk = E.canPlay(st, 0, idx);
  console.log('  canPlay: ' + JSON.stringify({ ok: chk.ok, needSlots: chk.needSlots, targets: (chk.targets || []).length }));
  ok(chk.ok, 'canPlay 通过');
  if (chk.ok) {
    const res = E.play(st, 0, idx, { slot: chk.needSlots[0] });
    ok(res.ok, '部署成功' + (res.reason ? ': ' + res.reason : ''));
    const u = st.players[0].units[chk.needSlots[0]];
    ok(!!u, '槽位上有单位');
    if (u) console.log('  单位: ' + WG.cardName(u.cardId) + ' atk=' + E.effAtk(st, u) + ' hp=' + E.effHp(st, u) + '/' + E.effMaxHp(st, u));
  }
}

console.log('\n=== 5) 战斗流程 ===');
// 直接构造一个双方同区域对峙的局面
const st2 = E.newGame({ decks: [makeDeck(stdIds()), makeDeck(stdIds())], names: ['A', 'B'], seed: 7 });
E.beginMatch(st2);
// 手动放单位
function forceUnit(st, side, slot, cardId) {
  const p = st.players[side];
  const u = {
    uid: 9000 + side * 10 + slot, kind: 'unit', cardId: cardId, owner: side, slot: slot,
    atk: WG.cardById(cardId).atk, maxHp: WG.cardById(cardId).hp, wounds: 0,
    exhausted: false, attacked: false, buffs: [], staticAtk: 0, staticHp: 0, flags: {},
    deployedTurn: 0, name: WG.cardById(cardId).name
  };
  p.units[slot] = u;
  return u;
}
const a0 = forceUnit(st2, 0, 0, 28);  // 2/4 中提琴
const b0 = forceUnit(st2, 1, 0, 28);
st2.phase = 'combat';
st2.active = 0;
st2.turnCtx = { side: 0, deployCount: [0, 0], playedWide: [false, false], playedWideIds: [[], []], attacked: [false, false], combatHappened: false, buffEvents: [], energyGained: [false, false], onceUsed: {} };
let lt = E.legalAttackTargets(st2, a0);
ok(lt.units.length === 1 && !lt.face, '同区域有敌方单位 -> 可打单位');
let atk = E.attack(st2, 0, a0.uid, { type: 'unit', uid: b0.uid });
ok(atk.ok, '攻击成功');
ok(a0.attacked && a0.exhausted, '攻击后横置且标记已攻击');
ok(E.effHp(st2, b0) === 2, 'B 单位受到 2 点伤害（4-2）: ' + E.effHp(st2, b0));
ok(E.effHp(st2, a0) === 2, 'A 单位受到反击 2 点（4-2）: ' + E.effHp(st2, a0));

// 空区域直击
const st3 = E.newGame({ decks: [makeDeck(stdIds()), makeDeck(stdIds())], seed: 9 });
E.beginMatch(st3);
const a1 = forceUnit(st3, 0, 4, 28);
st3.phase = 'combat'; st3.active = 0;
st3.turnCtx = { side: 0, deployCount: [0, 0], playedWide: [false, false], playedWideIds: [[], []], attacked: [false, false], combatHappened: false, buffEvents: [], energyGained: [false, false], onceUsed: {} };
let lt3 = E.legalAttackTargets(st3, a1);
ok(lt3.face, '敌方该区域为空 -> 可直击玩家');
E.attack(st3, 0, a1.uid, { type: 'face' });
ok(st3.players[1].hp === 13, '对手生命 15 -> 13: ' + st3.players[1].hp);

console.log('\n=== 6) 宽幅卡 ===');
const st4 = E.newGame({ decks: [makeDeck(stdIds()), makeDeck(stdIds())], seed: 11 });
E.beginMatch(st4);
const w = forceUnit(st4, 0, 0, 28);
st4.players[0].wides[1] = {
  uid: 7001, kind: 'wide', cardId: 76, owner: 0, slots: [1], areas: [1],
  locked: false, upgraded: false, flags: {}, deployedTurn: 0, name: '强音记号'
};
E._sync(st4);
ok(E.effAtk(st4, w) === 4, '强音记号使区域 1 单位 2 -> 4: ' + E.effAtk(st4, w));

// 跨区卡覆盖校验
const covers = WG.Effects[96].wideCovers(WG.Engine._ctx(st4, 0, WG.cardById(96), null));
ok(JSON.stringify(covers) === '[1,2]', '跨声部连线覆盖区域 1 与 2');

// 96 占两槽后，区域 3 仍可放单区卡
st4.players[0].wides[2] = {
  uid: 7002, kind: 'wide', cardId: 96, owner: 0, slots: [1, 2], areas: [1, 2],
  locked: false, upgraded: false, flags: {}, deployedTurn: 0, name: '跨声部连线'
};
st4.players[0].wides[1] = st4.players[0].wides[2];
let vws = E.validWideSlots(st4, 0, 86);
ok(vws.length === 1 && vws[0][0] === 3, '区域1/2 被占后，单区宽幅卡只剩区域 3 可选: ' + JSON.stringify(vws));

console.log('\n=== 7) 静态效果（若已实现单位卡效果）===');
const st5 = E.newGame({ decks: [makeDeck(stdIds()), makeDeck(stdIds())], seed: 13 });
E.beginMatch(st5);
const u2 = forceUnit(st5, 0, 0, 2);   // 2 三连音：若所在区域有另一名友方单位，攻击力+1
const u3 = forceUnit(st5, 0, 1, 28);
E._sync(st5);
if (WG.Effects[2] && WG.Effects[2].static) {
  ok(E.effAtk(st5, u2) === 3, '三连音在区域有友方时 2 -> 3: ' + E.effAtk(st5, u2));
} else {
  console.log('  (单位卡效果尚未实现，跳过)');
}

console.log('\n=== 8) 胜负 ===');
const st6 = E.newGame({ decks: [makeDeck(stdIds()), makeDeck(stdIds())], seed: 17 });
E.beginMatch(st6);
st6.players[1].hp = 0;
// 走一次结算路径
const a6 = forceUnit(st6, 0, 0, 28);
st6.phase = 'combat'; st6.active = 0;
st6.turnCtx = { side: 0, deployCount: [0, 0], playedWide: [false, false], playedWideIds: [[], []], attacked: [false, false], combatHappened: false, buffEvents: [], energyGained: [false, false], onceUsed: {} };
E.attack(st6, 0, a6.uid, { type: 'face' });
ok(st6.over && st6.over.loser === 1, '生命归零判负: ' + JSON.stringify(st6.over));

console.log('\n=== 结果：' + (fails === 0 ? '全部通过 ✓' : fails + ' 项失败 ✗') + ' ===\n');
process.exit(fails === 0 ? 0 : 1);
