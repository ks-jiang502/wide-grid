/* 效果卡测试（普通单位卡 1-38）：node tools/test_effects_a.js
 * 沙箱加载方式与 tools/test_engine.js 一致；只加载到 effects_units_a.js，
 * 不依赖 effects_units_b.js（那张文件由另一位队友并行编写）。
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

[
  'game/js/engine/constants.js',
  'game/js/data/cards.js',
  'game/js/engine/engine.js',
  'game/js/engine/effects_core.js',
  'game/js/engine/effects_units_a.js'
].forEach(load);

const WG = sandbox.WG;
const E = WG.Engine;
let fails = 0;
let passes = 0;

function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}

// ---------- 公共脚手架 ----------
function makeDeck(ids) {
  const d = [];
  for (let i = 0; i < ids.length; i++) { d.push(ids[i]); d.push(ids[i]); }
  return d.slice(0, 30);
}
function stdIds() {
  return [28, 59, 13, 16, 4, 5, 1, 2, 3, 6, 7, 8, 10, 12, 14];
}

/** 造一个干净的部署局面：0 号位行动、部署阶段、能量充足 */
function mkWorld(seed) {
  const deck = makeDeck(stdIds());
  const st = E.newGame({ decks: [deck.slice(), makeDeck(stdIds())], names: ['A', 'B'], seed: seed || 3 });
  if (st.error) throw new Error(st.error);
  E.beginMatch(st);
  resetTurn(st, 0);
  return st;
}
function resetTurn(st, side) {
  st.active = side;
  st.phase = 'deploy';
  st.over = null;
  st.turnCtx = {
    side: side, deployCount: [0, 0], playedWide: [false, false], playedWideIds: [[], []],
    attacked: [false, false], combatHappened: false, buffEvents: [],
    energyGained: [false, false], onceUsed: {}
  };
  st.players[side].energy = 10;
  st.players[side].maxEnergy = 10;
}

let uidSeq = 5000;
/** 手动放一个单位（绕过 play，便于摆盘） */
function forceUnit(st, side, slot, cardId) {
  const c = WG.cardById(cardId);
  const u = {
    uid: ++uidSeq, kind: 'unit', cardId: cardId, owner: side, slot: slot,
    atk: c.atk, maxHp: c.hp, wounds: 0, exhausted: false, attacked: false,
    buffs: [], staticAtk: 0, staticHp: 0, flags: {}, deployedTurn: st.turnCount, name: c.name
  };
  st.players[side].units[slot] = u;
  E._sync(st);
  return u;
}
/** 手动放一张宽幅卡（默认 76 强音记号：本区域单位攻击力 +2） */
function forceWide(st, side, area, cardId) {
  const c = WG.cardById(cardId || 76);
  const w = {
    uid: ++uidSeq, kind: 'wide', cardId: c.id, owner: side, slots: [area], areas: [area],
    locked: false, upgraded: false, flags: {}, deployedTurn: st.turnCount, name: c.name
  };
  st.players[side].wides[area] = w;
  E._sync(st);
  return w;
}
/** 用手牌部署一张卡，返回部署结果 */
function deploy(st, side, cardId, slot, targets) {
  const p = st.players[side];
  p.hand = [{ cardId: cardId }];
  const chk = E.canPlay(st, side, 0);
  if (!chk.ok) return { ok: false, reason: chk.reason, chk: chk };
  const r = E.play(st, side, 0, { slot: slot, targets: targets || [] });
  return { ok: r.ok, reason: r.reason, chk: chk, unit: p.units[slot] };
}
function ctxOf(st, side, cardId) {
  return E._ctx(st, side, WG.cardById(cardId), null);
}
function atkOf(st, u) { return E.effAtk(st, u); }
function maxHpOf(st, u) { return E.effMaxHp(st, u); }
function baseAtk(id) { return WG.cardById(id).atk; }
function baseHp(id) { return WG.cardById(id).hp; }

// ============================================================
console.log('\n=== 1) 静态条件加成（2 / 10 / 13 / 25 / 26 / 30 / 32）===');
{
  const st = mkWorld(11);
  const c2 = forceUnit(st, 0, 0, 2);          // 2 三连音 2/2：同区有友方 -> +1 攻
  ok(atkOf(st, c2) === baseAtk(2), '2 三连音 单独时 ' + baseAtk(2));
  forceUnit(st, 0, 1, 28);
  ok(atkOf(st, c2) === baseAtk(2) + 1, '2 三连音 有同区友方 -> ' + (baseAtk(2) + 1));

  const c13 = forceUnit(st, 0, 2, 13);        // 13 掌击：该区无其他友方 -> +1 攻
  ok(atkOf(st, c13) === baseAtk(13) + 1, '13 掌击 独占一区 -> ' + (baseAtk(13) + 1));
  forceUnit(st, 0, 3, 28);
  ok(atkOf(st, c13) === baseAtk(13), '13 掌击 有同区友方后回到 ' + baseAtk(13));

  const c25 = forceUnit(st, 0, 4, 25);        // 25 贝斯吉他：同区有友方 -> +1 攻
  ok(atkOf(st, c25) === baseAtk(25), '25 贝斯吉他 单独时 ' + baseAtk(25));
  forceUnit(st, 0, 5, 28);
  ok(atkOf(st, c25) === baseAtk(25) + 1, '25 贝斯吉他 有同区友方 -> ' + (baseAtk(25) + 1));
}
{
  const st = mkWorld(12);
  const c10 = forceUnit(st, 0, 0, 10);        // 10 轮指：相邻区域有友方 -> +1 生命
  ok(maxHpOf(st, c10) === baseHp(10), '10 轮指 相邻区域空 -> ' + baseHp(10));
  forceUnit(st, 0, 2, 28);                    // 区域 2 与区域 1 相邻
  ok(maxHpOf(st, c10) === baseHp(10) + 1, '10 轮指 相邻区域有友方 -> ' + (baseHp(10) + 1));

  const c30 = forceUnit(st, 1, 3, 30);        // 30 低音提琴：同区有友方 -> +1 生命
  ok(maxHpOf(st, c30) === baseHp(30), '30 低音提琴 单独时 ' + baseHp(30));
  forceUnit(st, 1, 2, 28);
  ok(maxHpOf(st, c30) === baseHp(30) + 1, '30 低音提琴 有同区友方 -> ' + (baseHp(30) + 1));
}
{
  const st = mkWorld(13);
  const c26 = forceUnit(st, 0, 2, 26);        // 26 五弦贝斯：左右两区都有友方 -> +1 攻（仅区域 2 可满足）
  ok(atkOf(st, c26) === baseAtk(26), '26 五弦贝斯 两侧都空 -> ' + baseAtk(26));
  forceUnit(st, 0, 0, 28);
  ok(atkOf(st, c26) === baseAtk(26), '26 五弦贝斯 只有一侧有友方 -> ' + baseAtk(26));
  forceUnit(st, 0, 4, 28);
  ok(atkOf(st, c26) === baseAtk(26) + 1, '26 五弦贝斯 左右相邻都有友方 -> ' + (baseAtk(26) + 1));

  const st32 = mkWorld(14);
  const c32 = forceUnit(st32, 0, 0, 32);      // 32 副旋律：同区有攻击力更高的友方 -> +1 生命
  ok(maxHpOf(st32, c32) === baseHp(32), '32 副旋律 同区无更强友方 -> ' + baseHp(32));
  forceUnit(st32, 0, 1, 23);                  // 23 电吉他 atk 4，高于副旋律的 2
  ok(maxHpOf(st32, c32) === baseHp(32) + 1, '32 副旋律 同区有更高攻击友方 -> ' + (baseHp(32) + 1));
}

// ============================================================
console.log('\n=== 2) 宽幅卡相关（11 / 17 / 27 / 36）===');
{
  const st = mkWorld(21);
  const c11 = forceUnit(st, 0, 0, 11);        // 11 泛音：吃宽幅增益时 +1 攻
  const c17 = forceUnit(st, 0, 1, 17);        // 17 三角钢琴：所在区域有宽幅卡 -> +1 生命
  const c27 = forceUnit(st, 0, 2, 27);        // 27 小提琴
  const c36 = forceUnit(st, 0, 4, 36);        // 36 高音声部
  ok(atkOf(st, c11) === baseAtk(11), '11 泛音 无宽幅卡 -> ' + baseAtk(11));
  ok(maxHpOf(st, c17) === baseHp(17), '17 三角钢琴 无宽幅卡 -> ' + baseHp(17));
  const w = forceWide(st, 0, 1);              // 76 强音记号：区域 1 攻击 +2
  const wideAtk = E.effAtk(st, c11) - baseAtk(11) - 1;
  ok(wideAtk === 2, '76 强音记号 提供 +2 攻（用于下面的推算）');
  ok(atkOf(st, c11) === baseAtk(11) + 2 + 1, '11 泛音 吃宽幅卡 -> ' + (baseAtk(11) + 2 + 1));
  ok(maxHpOf(st, c17) === baseHp(17) + 1, '17 三角钢琴 区域有宽幅卡 -> ' + (baseHp(17) + 1));
  ok(atkOf(st, c27) === baseAtk(27), '27 小提琴 不在宽幅卡区域 -> ' + baseAtk(27));
  ok(atkOf(st, c36) === baseAtk(36), '36 高音声部 不在宽幅卡区域（区域3）-> ' + baseAtk(36));
  forceWide(st, 0, 2);
  ok(E.effAtk(st, c27) === baseAtk(27) + 2 + 1, '27 小提琴 所区域有宽幅卡 -> ' + (baseAtk(27) + 2 + 1));
  forceWide(st, 0, 3);
  ok(E.effAtk(st, c36) === baseAtk(36) + 2 + 1, '36 高音声部 有宽幅卡 -> ' + (baseAtk(36) + 2 + 1));
  ok(!!w, '宽幅卡摆放成功');
}

// ============================================================
console.log('\n=== 3) 部署当回合类（4 / 5 / 12 / 15 / 19 / 22）===');
{
  const st = mkWorld(31);
  const d4 = deploy(st, 0, 4, 0);             // 4 断奏：部署当回合 +1 攻
  ok(d4.ok, '4 断奏 部署成功');
  ok(atkOf(st, d4.unit) === baseAtk(4) + 1, '4 断奏 部署当回合 -> ' + (baseAtk(4) + 1));
  st.turnCount += 1;                          // 模拟进入下一回合
  E._sync(st);
  ok(atkOf(st, d4.unit) === baseAtk(4), '4 断奏 换回合后回到 ' + baseAtk(4));
}
{
  const st = mkWorld(32);
  const d5 = deploy(st, 0, 5, 0);             // 5 顿音：本回合尚未部署其他单位 -> +1 攻
  ok(atkOf(st, d5.unit) === baseAtk(5) + 1, '5 顿音 本回合第一张 -> ' + (baseAtk(5) + 1));
  deploy(st, 0, 28, 1);                       // 再部署一张，deployCount 变成 2
  E._sync(st);
  ok(atkOf(st, d5.unit) === baseAtk(5), '5 顿音 本回合已部署过其他单位 -> ' + baseAtk(5));
}
{
  const st = mkWorld(33);
  const d12 = deploy(st, 0, 12, 0);           // 12 拨弦：费用付完还有能量 -> +1 攻（至回合结束）
  ok(d12.ok && atkOf(st, d12.unit) === baseAtk(12) + 1, '12 拨弦 有余能 -> ' + (baseAtk(12) + 1));

  const st2 = mkWorld(34);
  st2.players[0].energy = 1;                  // 正好付清
  const d12b = deploy(st2, 0, 12, 0);
  ok(d12b.ok && atkOf(st2, d12b.unit) === baseAtk(12), '12 拨弦 无余能 -> ' + baseAtk(12));
}
{
  const st = mkWorld(35);
  const c15 = forceUnit(st, 0, 0, 15);        // 15 华彩段：本回合部署过宽幅卡 -> +1 攻
  ok(atkOf(st, c15) === baseAtk(15), '15 华彩段 未部署宽幅卡 -> ' + baseAtk(15));
  st.turnCtx.playedWide[0] = true;
  E._sync(st);
  ok(atkOf(st, c15) === baseAtk(15) + 1, '15 华彩段 本回合部署过宽幅卡 -> ' + (baseAtk(15) + 1));

  const c22 = forceUnit(st, 0, 1, 22);        // 22 模块合成器：本回合第一次获得能量 -> +1 攻
  ok(atkOf(st, c22) === baseAtk(22), '22 模块合成器 未获得能量 -> ' + baseAtk(22));
  st.turnCtx.energyGained[0] = true;
  E._sync(st);
  ok(atkOf(st, c22) === baseAtk(22) + 1, '22 模块合成器 本回合获得过能量 -> ' + (baseAtk(22) + 1));
}
{
  const st = mkWorld(36);
  const d19 = deploy(st, 0, 19, 0);           // 19 电钢琴：能量 >= 2 -> +1 攻（永久）
  ok(d19.ok && atkOf(st, d19.unit) === baseAtk(19) + 1, '19 电钢琴 余能 >= 2 -> ' + (baseAtk(19) + 1));

  const st2 = mkWorld(37);
  st2.players[0].energy = 2;                  // 付完刚好 0
  const d19b = deploy(st2, 0, 19, 0);
  ok(d19b.ok && atkOf(st2, d19b.unit) === baseAtk(19), '19 电钢琴 余能不足 -> ' + baseAtk(19));
}

// ============================================================
console.log('\n=== 4) 部署时给友方/敌方加成（1 / 8 / 24 / 31 / 33 / 34 / 38）===');
{
  const st = mkWorld(41);
  const friend = forceUnit(st, 0, 1, 28);
  const d1 = deploy(st, 0, 1, 0);             // 1 切分音：同区已有友方 -> +1 生命（永久）
  ok(d1.ok && maxHpOf(st, d1.unit) === baseHp(1) + 1, '1 切分音 同区有友方 -> ' + (baseHp(1) + 1));

  const st2 = mkWorld(42);
  const d1b = deploy(st2, 0, 1, 2);           // 区域 2 空无一人
  ok(d1b.ok && maxHpOf(st2, d1b.unit) === baseHp(1), '1 切分音 该区无友方 -> ' + baseHp(1));
  ok(!!friend, '友方单位就位');
}
{
  const st = mkWorld(43);
  const big = forceUnit(st, 0, 1, 28);        // 28 中提琴 2/4：同区唯一的另一名友方
  const before = atkOf(st, big);
  const d8 = deploy(st, 0, 8, 0);             // 8 倚音：同区另一名友方 +1 攻（至回合结束）
  ok(d8.ok && atkOf(st, big) === before + 1, '8 倚音 给同区另一名友方 +1 攻 -> ' + (before + 1));
  ok(atkOf(st, d8.unit) === baseAtk(8), '8 倚音 自己不加攻');

  const st2 = mkWorld(44);
  const f2 = forceUnit(st2, 0, 1, 28);
  const d24 = deploy(st2, 0, 24, 0);          // 24 原声吉他：同区另一名友方 +1 生命（永久）
  ok(d24.ok && maxHpOf(st2, f2) === baseHp(28) + 1, '24 原声吉他 友方生命 +1 -> ' + (baseHp(28) + 1));
}
{
  const st = mkWorld(45);
  const f = forceUnit(st, 0, 1, 28);
  const before = atkOf(st, f);
  const d31 = deploy(st, 0, 31, 0, [{ uid: f.uid }]);   // 31 主旋律：指定友方 +1 攻
  ok(d31.ok && atkOf(st, f) === before + 1, '31 主旋律 指定友方 +1 攻 -> ' + (before + 1));

  const st2 = mkWorld(46);
  const d31b = deploy(st2, 0, 31, 0);                   // 不选目标 -> 加给自己
  ok(d31b.ok && atkOf(st2, d31b.unit) === baseAtk(31) + 1, '31 主旋律 不选目标时加给自己 -> ' + (baseAtk(31) + 1));
}
{
  const st = mkWorld(47);
  const f1 = forceUnit(st, 0, 1, 28);
  const f3 = forceUnit(st, 0, 2, 30);         // 区域 2 的友方，不该被 33 影响到
  const before = maxHpOf(st, f1);
  const d33 = deploy(st, 0, 33, 0);           // 33 节奏组（降级实现）：同区其他友方 +1 永久生命
  ok(d33.ok && maxHpOf(st, f1) === before + 1, '33 节奏组 同区其他友方生命 +1 -> ' + (before + 1));
  ok(maxHpOf(st, f3) === baseHp(30), '33 节奏组 不影响其他区域友方');
}
{
  const st = mkWorld(48);
  const f = forceUnit(st, 0, 1, 28);
  const b1 = maxHpOf(st, f);
  const d34 = deploy(st, 0, 34, 0);           // 34 和声部：自己有友方 -> +1 生命；友方也 +1 生命
  ok(d34.ok && maxHpOf(st, d34.unit) === baseHp(34) + 1, '34 和声部 自己有友方 -> ' + (baseHp(34) + 1));
  ok(maxHpOf(st, f) === b1 + 1, '34 和声部 让同区友方生命 +1 -> ' + (b1 + 1));
}
{
  const st = mkWorld(49);
  const f = forceUnit(st, 0, 1, 28);
  const a0 = atkOf(st, f);
  const d38 = deploy(st, 0, 38, 0, [{ area: 1 }]);      // 38 指挥棒：区域 1 友方全体 +1 攻
  ok(d38.ok && atkOf(st, f) === a0 + 1, '38 指挥棒 区域 1 友方 +1 攻 -> ' + (a0 + 1));
  ok(atkOf(st, d38.unit) === baseAtk(38) + 1, '38 指挥棒 同区域的自己也算友方 -> ' + (baseAtk(38) + 1));
}

// ============================================================
console.log('\n=== 5) 目标选择与能量（7 / 18 / 21 / 37）===');
{
  const st = mkWorld(51);
  const d7 = deploy(st, 0, 7, 0, [{ slot: 1 }]);       // 7 滑音：同区换位
  ok(d7.ok && st.players[0].units[1] && !st.players[0].units[0], '7 滑音 同区换到槽位 2');

  const st2 = mkWorld(52);
  const d7b = deploy(st2, 0, 7, 0, [{ slot: 2 }]);     // 区域 2 不同区 -> 忽略移动
  ok(d7b.ok && st2.players[0].units[0], '7 滑音 跨区选择被忽略（留在原槽位）');

  const st3 = mkWorld(53);
  const d7c = deploy(st3, 0, 7, 0);                    // 不选 -> 留在原地
  ok(d7c.ok && st3.players[0].units[0], '7 滑音 不选目标时原地部署');
}
{
  const st = mkWorld(54);
  const foe = forceUnit(st, 1, 0, 28);
  const before = atkOf(st, foe);
  const d18 = deploy(st, 0, 18, 0, [{ uid: foe.uid }]);  // 18 立式钢琴：敌方单位 -1 攻（至回合结束）
  ok(d18.ok && atkOf(st, foe) === before - 1, '18 立式钢琴 敌方 -1 攻 -> ' + (before - 1));

  const st2 = mkWorld(55);
  const d18b = deploy(st2, 0, 18, 0);                    // 敌方无单位也能打（optional）
  ok(d18b.ok, '18 立式钢琴 无敌方单位时仍可部署');
}
{
  const st = mkWorld(56);
  const d21 = deploy(st, 0, 21, 0);                      // 21 模拟合成器：恢复 1 点能量
  ok(d21.ok && st.players[0].energy === 9, '21 模拟合成器 回 1 能量（10-2+1=9）: ' + st.players[0].energy);
  const d21b = deploy(st, 0, 21, 1);                     // 同回合第二张 -> 不再回能
  ok(d21b.ok && st.players[0].energy === 7, '21 模拟合成器 每回合限一次（9-2=7）: ' + st.players[0].energy);
}
{
  const st = mkWorld(57);
  const foe = forceUnit(st, 1, 0, 28);
  const d37 = deploy(st, 0, 37, 0, [{ uid: foe.uid }]);   // 37 节拍器：回能 + 敌方下一次攻击增益 -1
  ok(d37.ok && st.players[0].energy === 10, '37 节拍器 回 1 能量（10-1+1=10）: ' + st.players[0].energy);
  ok(foe.flags.gainModAtk === -1, '37 节拍器 打上「下一次攻击增益 -1」标记: ' + foe.flags.gainModAtk);
  ctxOf(st, 1, 28).buff(foe, { atk: 1 });
  ok(atkOf(st, foe) === baseAtk(28), '37 节拍器 让 +1 攻增益被削成 0（最低 0）: ' + atkOf(st, foe));
}

// ============================================================
console.log('\n=== 6) 受伤 / 增益触发（3 / 6 / 14 / 23 / 29 / 35）===');
{
  const st = mkWorld(61);
  const line = forceUnit(st, 0, 0, 3);         // 3 连音线
  const friend = forceUnit(st, 0, 1, 28);      // 2/4，被保护对象
  const Th = ctxOf(st, 0, 28);
  Th.hurt(friend, 2);
  ok(E.effHp(st, friend) === baseHp(28) - 1, '3 连音线 首次受伤 -1（实受 1）: ' + E.effHp(st, friend));
  Th.hurt(friend, 2);
  ok(E.effHp(st, friend) === baseHp(28) - 3, '3 连音线 同回合第二次不再减: ' + E.effHp(st, friend));
  ok(!!line, '连音线就位');
}
{
  const st = mkWorld(62);
  const v = forceUnit(st, 0, 0, 14);           // 14 震音：每回合第一次受伤 -1
  const T14 = ctxOf(st, 0, 14);
  T14.hurt(v, 2);
  ok(E.effHp(st, v) === baseHp(14) - 1, '14 震音 首次受伤 -1: ' + E.effHp(st, v));
  T14.hurt(v, 2);
  ok(E.effHp(st, v) === baseHp(14) - 3, '14 震音 第二次全额: ' + E.effHp(st, v));

  const c29 = forceUnit(st, 1, 0, 29);         // 29 大提琴：同上
  const T29 = ctxOf(st, 1, 29);
  T29.hurt(c29, 3);
  ok(E.effHp(st, c29) === baseHp(29) - 2, '29 大提琴 首次受伤 -1: ' + E.effHp(st, c29));
  T29.hurt(c29, 3);
  ok(E.effHp(st, c29) === baseHp(29) - 5, '29 大提琴 第二次全额: ' + E.effHp(st, c29));
}
{
  const st = mkWorld(63);
  const v35 = forceUnit(st, 0, 0, 35);         // 35 低音声部：同区有友方时首次受伤 -1
  ctxOf(st, 0, 35).hurt(v35, 2);
  ok(E.effHp(st, v35) === baseHp(35) - 2, '35 低音声部 无同区友方不减伤: ' + E.effHp(st, v35));
  forceUnit(st, 0, 1, 28);
  v35.flags = {};
  ctxOf(st, 0, 35).hurt(v35, 2);
  ok(E.effHp(st, v35) === baseHp(35) - 2 - 1, '35 低音声部 同区有友方时首次 -1: ' + E.effHp(st, v35));
}
{
  const st = mkWorld(64);
  const tr = forceUnit(st, 0, 0, 6);           // 6 颤音：本回合第一次获得增益时额外 +1 攻
  const T6 = ctxOf(st, 0, 6);
  ok(atkOf(st, tr) === baseAtk(6), '6 颤音 未获得增益 -> ' + baseAtk(6));
  T6.buff(tr, { atk: 1, tag: 'atk' });
  ok(atkOf(st, tr) === baseAtk(6) + 1 + 1, '6 颤音 获得增益后额外 +1 攻: ' + atkOf(st, tr));
  T6.buff(tr, { atk: 1, tag: 'atk' });
  ok(atkOf(st, tr) === baseAtk(6) + 2 + 1, '6 颤音 第二次增益仍只额外 +1 一次: ' + atkOf(st, tr));

  const eg = forceUnit(st, 0, 2, 23);          // 23 电吉他：所在区域获得攻击增益 -> 额外 +1 攻
  ok(atkOf(st, eg) === baseAtk(23), '23 电吉他 区域无攻击增益 -> ' + baseAtk(23));
  ctxOf(st, 0, 23).buff(tr, { atk: 1, tag: 'atk' });   // 同区（区域1）的颤音再吃一次增益
  ok(atkOf(st, eg) === baseAtk(23) + 0, '23 电吉他 不在区域 1 时不加攻（区域不同）');
  const eg2 = forceUnit(st, 0, 1, 23);         // 与吃到增益的颤音同在区域 1
  ok(atkOf(st, eg2) === baseAtk(23) + 1, '23 电吉他 与吃到增益的友方同区 -> +1 攻: ' + atkOf(st, eg2));
}

// ============================================================
console.log('\n=== 7) 部署时永久成长（16 / 20）===');
{
  const st = mkWorld(71);
  const d16 = deploy(st, 0, 16, 0);            // 16 钢琴独奏：场上没有其他单位 -> +1 攻（永久）
  ok(d16.ok && atkOf(st, d16.unit) === baseAtk(16) + 1, '16 钢琴独奏 独奏加成 -> ' + (baseAtk(16) + 1));

  const st2 = mkWorld(72);
  forceUnit(st2, 0, 3, 28);
  const d16b = deploy(st2, 0, 16, 0);
  ok(d16b.ok && atkOf(st2, d16b.unit) === baseAtk(16), '16 钢琴独奏 场上已有单位 -> ' + baseAtk(16));

  const st3 = mkWorld(73);
  const d20 = deploy(st3, 0, 20, 0);           // 20 合成器：本回合部署过宽幅卡 -> +1 生命
  ok(d20.ok && maxHpOf(st3, d20.unit) === baseHp(20), '20 合成器 未部署宽幅卡 -> ' + baseHp(20));

  const st4 = mkWorld(74);
  st4.turnCtx.playedWide[0] = true;
  const d20b = deploy(st4, 0, 20, 0);
  ok(d20b.ok && maxHpOf(st4, d20b.unit) === baseHp(20) + 1, '20 合成器 本回合部署过宽幅卡 -> ' + (baseHp(20) + 1));
}

// ============================================================
console.log('\n=== 8) 回音复制增益（9）===');
{
  const st = mkWorld(81);
  st.turnCtx.buffEvents = [{ side: 0, tag: 'atk', atk: 3 }];
  const d9 = deploy(st, 0, 9, 0);              // 9 回音：复制 3 的一半（向下取整 -> 1）
  ok(d9.ok && atkOf(st, d9.unit) === baseAtk(9) + 1, '9 回音 复制 +3 攻的一半 = +1: ' + atkOf(st, d9.unit));

  const st2 = mkWorld(82);
  const d9b = deploy(st2, 0, 9, 0);            // 本回合没有任何增益事件
  ok(d9b.ok && atkOf(st2, d9b.unit) === baseAtk(9), '9 回音 无增益可复制时不变: ' + atkOf(st2, d9b.unit));

  const st3 = mkWorld(83);
  st3.turnCtx.buffEvents = [{ side: 1, tag: 'atk', atk: 4 }];
  const d9c = deploy(st3, 0, 9, 0);            // 只复制己方增益
  ok(d9c.ok && atkOf(st3, d9c.unit) === baseAtk(9), '9 回音 不复制敌方增益: ' + atkOf(st3, d9c.unit));
}

// ============================================================
console.log('\n=== 9) 目标声明（targets 形状 / optional）===');
{
  const st = mkWorld(91);
  const foe = forceUnit(st, 1, 0, 28);
  const f = forceUnit(st, 0, 1, 28);
  const t7 = WG.Effects[7].targets(ctxOf(st, 0, 7));
  ok(t7.length === 1 && t7[0].optional === true && t7[0].options.length > 0, '7 滑音 targets 可选且有空槽');
  const t18 = WG.Effects[18].targets(ctxOf(st, 0, 18));
  ok(t18[0].options.length === 1 && t18[0].options[0].uid === foe.uid, '18 立式钢琴 targets 列出敌方单位');
  const t31 = WG.Effects[31].targets(ctxOf(st, 0, 31));
  ok(t31[0].options.length === 1 && t31[0].options[0].uid === f.uid, '31 主旋律 targets 列出友方单位');
  const t37 = WG.Effects[37].targets(ctxOf(st, 0, 37));
  ok(t37[0].options.length === 1 && t37[0].options[0].uid === foe.uid, '37 节拍器 targets 列出敌方单位');
  const t38 = WG.Effects[38].targets(ctxOf(st, 0, 38));
  ok(t38[0].options.length === 1 && t38[0].options[0].area === 1, '38 指挥棒 只列有友方的区域: ' + JSON.stringify(t38[0].options));
  // 空场时都应可跳过
  const st2 = mkWorld(92);
  ok(WG.Effects[18].targets(ctxOf(st2, 0, 18))[0].options.length === 0, '18 立式钢琴 空场时无目标');
  ok(E.canPlay((st2.players[0].hand = [{ cardId: 18 }], st2), 0, 0).ok, '18 立式钢琴 无目标时仍可打出（optional）');
}

// ============================================================
console.log('\n=== 10) 每张卡都有实现对象（1-38）===');
{
  const missing = [];
  for (let id = 1; id <= 38; id++) {
    if (WG.cardById(id).type !== 'unit') { missing.push(id + '(非单位)'); continue; }
    if (!WG.Effects[id] || typeof WG.Effects[id] !== 'object') missing.push(id);
  }
  ok(missing.length === 0, '1-38 全部注册到 WG.Effects' + (missing.length ? '，缺: ' + missing.join(',') : ''));
  ok(typeof WG.Effects[28] === 'object' && !WG.Effects[28].static && !WG.Effects[28].onDeploy, '28 中提琴 无效果');
}

console.log('\n=== 结果：' + (fails === 0 ? '全部通过 ✓' : fails + ' 项失败 ✗') +
  '（' + passes + ' 项通过 / ' + (passes + fails) + ' 项断言）===\n');
process.exit(fails === 0 ? 0 : 1);
