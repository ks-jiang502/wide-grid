/* 普通单位卡（39-75）效果测试：node tools/test_effects_b.js
 * 用 vm 沙箱加载与浏览器完全相同的脚本，逐张验证效果。
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
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  ✓ ' + msg); }
  else { fails++; console.log('  ✗ ' + msg); }
}
function sec(t) { console.log('\n=== ' + t + ' ==='); }

// ---- 建局工具 ----------------------------------------------------------
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

let uidSeq = 0;

function resetTurn(st, side) {
  st.active = side;
  st.phase = 'deploy';
  st.turnCtx = {
    side: side,
    deployCount: [0, 0],
    playedWide: [false, false],
    playedWideIds: [[], []],
    attacked: [false, false],
    combatHappened: false,
    buffEvents: [],
    energyGained: [false, false],
    onceUsed: {}
  };
}

function newSt(seed) {
  const st = E.newGame({
    decks: [makeDeck(stdIds()), makeDeck(stdIds())],
    names: ['A', 'B'],
    seed: seed || 1
  });
  E.beginMatch(st);
  for (let s = 0; s < 2; s++) {
    st.players[s].units = [null, null, null, null, null, null];
    st.players[s].wides = [null, null, null, null];
    st.players[s].energy = 6;
  }
  resetTurn(st, 0);
  E._sync(st);
  return st;
}

/** 直接摆一个单位到场上（不走 play，方便构造局面） */
function fu(st, side, slot, cardId) {
  const c = WG.cardById(cardId);
  uidSeq++;
  const u = {
    uid: 10000 + uidSeq, kind: 'unit', cardId: cardId, owner: side, slot: slot,
    atk: c.atk, maxHp: c.hp, wounds: 0, exhausted: false, attacked: false,
    buffs: [], staticAtk: 0, staticHp: 0, flags: {}, deployedTurn: 0, name: c.name
  };
  st.players[side].units[slot] = u;
  return u;
}

/** 摆一张宽幅卡 */
function fw(st, side, idx, cardId, areas, slots) {
  uidSeq++;
  const w = {
    uid: 20000 + uidSeq, kind: 'wide', cardId: cardId, owner: side,
    slots: (slots || areas).slice(), areas: areas.slice(),
    locked: false, upgraded: false, flags: {}, deployedTurn: 0,
    name: WG.cardName(cardId)
  };
  st.players[side].wides[idx] = w;
  return w;
}

/** 模拟一次部署：计入 deployCount（与引擎 play 一致），再触发 onDeploy */
function deploy(st, side, slot, cardId, picked) {
  const u = fu(st, side, slot, cardId);
  st.turnCtx.deployCount[side] += 1;
  const e = WG.Effects[cardId];
  if (e && e.onDeploy) {
    e.onDeploy(u, E._ctx(st, side, WG.cardById(cardId), u), picked || []);
  }
  E._sync(st);
  return u;
}

function tctx(st, side, card, self) {
  return E._ctx(st, side, card, self);
}

// ======================================================================
sec('1) 同区域协同（静态）');
{
  const st = newSt(101);
  const u39 = fu(st, 0, 0, 39);          // 4/4
  E._sync(st);
  ok(E.effMaxHp(st, u39) === 4, '39 区域内无其他友方：4 血');
  fu(st, 0, 1, 28);
  E._sync(st);
  ok(E.effMaxHp(st, u39) === 5, '39 区域内有友方：生命 4 -> 5');
}
{
  const st = newSt(102);
  const u41 = fu(st, 0, 0, 41);          // 2/3
  E._sync(st);
  ok(E.effAtk(st, u41) === 2, '41 区域内无其他友方：2 攻');
  fu(st, 0, 1, 28);
  E._sync(st);
  ok(E.effAtk(st, u41) === 3, '41 区域内有友方：攻击 2 -> 3');
}
{
  // 40：区域每有一名其他友方 +1 攻，最多 +2。
  // 注意：引擎每个攻击区域只有 2 个单位位，同区域"其他友方"上限就是 1，
  // 所以卡面的"最多 +2"在实际盘面上够不到；这里按引擎真实容量验证。
  const st = newSt(103);
  fu(st, 0, 1, 28);
  const u40a = deploy(st, 0, 0, 40, []);  // 3/4
  ok(E.effAtk(st, u40a) === 4, '40 区域 1 名其他友方：3 -> 4 攻');
  const st2 = newSt(104);
  fu(st2, 0, 0, 28);                      // 友方在区域 1
  const u40b = deploy(st2, 0, 2, 40, []); // 自己落在区域 2
  ok(E.effAtk(st2, u40b) === 3, '40 所在区域没有其他友方：不加攻');
  const st3 = newSt(105);
  fu(st3, 0, 2, 28);                      // 区域 2
  const u40c = deploy(st3, 0, 3, 40, []); // 区域 2
  ok(E.effAtk(st3, u40c) === 4, '40 区域 2 内 1 名其他友方：3 -> 4 攻');
}

sec('2) 看场上状态的静态效果');
{
  const st = newSt(111);
  const u42 = deploy(st, 0, 0, 42, []);   // 4/2
  ok(E.effMaxHp(st, u42) === 2, '42 本回合未部署宽幅：2 血');
  st.turnCtx.playedWide[0] = true;
  E._sync(st);
  ok(E.effMaxHp(st, u42) === 3, '42 本回合部署过宽幅：生命 2 -> 3');
}
{
  const st = newSt(112);
  const u44 = deploy(st, 0, 0, 44, []);   // 2/3
  ok(E.effAtk(st, u44) === 2, '44 本回合未发生战斗：2 攻');
  st.turnCtx.combatHappened = true;
  E._sync(st);
  ok(E.effAtk(st, u44) === 3, '44 本回合发生过战斗：攻击 2 -> 3');
}
{
  const st = newSt(113);
  const u45 = deploy(st, 0, 0, 45, []);   // 3/3
  ok(E.effMaxHp(st, u45) === 3, '45 区域内无宽幅卡：3 血');
  fw(st, 0, 1, 76, [1], [1]);
  E._sync(st);
  ok(E.effMaxHp(st, u45) === 4, '45 区域内有宽幅卡：生命 3 -> 4');
}
{
  const st = newSt(114);
  const u65 = deploy(st, 0, 0, 65, []);   // 4/3
  ok(E.effAtk(st, u65) === 4, '65 区域内无宽幅卡：4 攻');
  fw(st, 0, 1, 76, [1], [1]);
  E._sync(st);
  // 强音记号本身给区域 1 的单位 +2 攻，65 自己的静态效果再 +1
  ok(E.effAtk(st, u65) === 7, '65 区域内有宽幅卡：4 + 2（宽幅）+ 1（本卡）= 7 攻');
}
{
  // 46 / 74：三个攻击区域都有友方
  const st = newSt(115);
  fu(st, 0, 1, 28); fu(st, 0, 2, 28); fu(st, 0, 4, 28);
  const u46 = deploy(st, 0, 0, 46, []);   // 3/4
  ok(E.effAtk(st, u46) === 4, '46 三个区域都有友方：3 -> 4 攻');
  const st2 = newSt(116);
  fu(st2, 0, 1, 28); fu(st2, 0, 2, 28); fu(st2, 0, 4, 28);
  const u74 = deploy(st2, 0, 0, 74, []);  // 4/4
  ok(E.effAtk(st2, u74) === 5, '74 三个区域都有友方：4 -> 5 攻');
  const st3 = newSt(117);
  fu(st3, 0, 1, 28); fu(st3, 0, 2, 28);
  const u46b = deploy(st3, 0, 0, 46, []);
  ok(E.effAtk(st3, u46b) === 3, '46 只有两个区域有友方：不加攻');
}
{
  // 47：相邻攻击区域
  const st = newSt(118);
  fu(st, 0, 0, 28); fu(st, 0, 4, 28);     // 区域 1、3
  const u47 = deploy(st, 0, 3, 47, []);   // 2/4，位于区域 2
  ok(E.effAtk(st, u47) === 3, '47 位于区域 2，邻区 1/3 有友方：2 -> 3 攻');
  const st2 = newSt(119);
  fu(st2, 0, 4, 28);                      // 友方在区域 3，区域 2 空着
  const u47b = deploy(st2, 0, 0, 47, []); // 位于区域 1，邻区只有 2
  ok(E.effAtk(st2, u47b) === 2, '47 位于区域 1，邻区 2 无友方：不加攻');
}
{
  // 51：能量为 0
  const st = newSt(120);
  st.players[0].energy = 3;
  const u51 = deploy(st, 0, 0, 51, []);   // 4/3
  ok(E.effMaxHp(st, u51) === 3, '51 有能量时：3 血');
  st.players[0].energy = 0;
  E._sync(st);
  ok(E.effMaxHp(st, u51) === 4, '51 能量为 0：生命 3 -> 4');
}
{
  // 63：本回合尚未攻击
  const st = newSt(121);
  const u63 = fu(st, 0, 0, 63);           // 3/2
  E._sync(st);
  ok(E.effAtk(st, u63) === 4, '63 本回合尚未攻击：3 -> 4 攻');
  u63.attacked = true;
  E._sync(st);
  ok(E.effAtk(st, u63) === 3, '63 已攻击过：回到 3 攻');
}
{
  // 66：aura 给同区域另一名友方 +1 生命，自己不吃自己的光环
  const st = newSt(122);
  const u66 = fu(st, 0, 0, 66);           // 2/4
  E._sync(st);
  ok(E.effMaxHp(st, u66) === 4, '66 区域内无友方：自己 4 血');
  const f66 = fu(st, 0, 1, 28);
  E._sync(st);
  ok(E.effMaxHp(st, f66) === 5, '66 让同区域友方：4 -> 5 生命');
  ok(E.effMaxHp(st, u66) === 4, '66 自己不吃自己的光环：仍 4 血');
}
{
  // 55：本回合己方触发过两种不同增益
  const st = newSt(123);
  const u55 = deploy(st, 0, 0, 55, []);   // 3/4
  ok(E.effAtk(st, u55) === 3, '55 无增益事件：3 攻');
  st.turnCtx.buffEvents.push({ side: 0, tag: 'atk', atk: 1 });
  st.turnCtx.buffEvents.push({ side: 0, tag: 'hp', hp: 1 });
  E._sync(st);
  ok(E.effAtk(st, u55) === 4, '55 两种不同增益：3 -> 4 攻');
  const st2 = newSt(124);
  const u55b = deploy(st2, 0, 0, 55, []);
  st2.turnCtx.buffEvents.push({ side: 0, tag: 'atk', atk: 1 });
  st2.turnCtx.buffEvents.push({ side: 0, tag: 'atk', atk: 1 });
  E._sync(st2);
  ok(E.effAtk(st2, u55b) === 3, '55 同一种增益两次：不加攻');
  st2.turnCtx.buffEvents.push({ side: 1, tag: 'hp', hp: 1 });
  E._sync(st2);
  ok(E.effAtk(st2, u55b) === 3, '55 敌方获得的增益不计入');
}
{
  // 59：无特殊效果
  const st = newSt(125);
  const u59 = fu(st, 0, 0, 59);           // 1/4
  E._sync(st);
  ok(E.effAtk(st, u59) === 1 && E.effMaxHp(st, u59) === 4, '59 无特殊效果：1/4');
}

sec('3) 部署时：永久增益与回能');
{
  // 49：每有一张生效中的宽幅卡 +1 攻，最多 +2
  const st = newSt(131);
  const u49 = deploy(st, 0, 0, 49, []);   // 2/4
  ok(E.effAtk(st, u49) === 2, '49 区域无宽幅卡：2 攻');
  const st2 = newSt(132);
  fw(st2, 0, 1, 76, [1], [1]);
  fw(st2, 0, 2, 76, [1], [2]);
  const u49b = deploy(st2, 0, 0, 49, []);
  const wc = tctx(st2, 0, WG.cardById(49), u49b).wideCount(0, 1);
  // 2 基础 + 4（两张强音记号各给区域 1 单位 +2）+ 2（本卡每张宽幅 +1，封顶 +2）
  ok(wc === 2 && E.effAtk(st2, u49b) === 8, '49 区域两张宽幅卡：2 + 4 + 2 = 8 攻（wideCount=' + wc + '）');
}
{
  // 71：至少两个区域有友方 -> +1 攻
  const st = newSt(133);
  fu(st, 0, 2, 28);                       // 区域 2
  const u71 = deploy(st, 0, 0, 71, []);   // 2/2
  ok(E.effAtk(st, u71) === 3, '71 两个区域有友方：2 -> 3 攻');
  const st2 = newSt(134);
  const u71b = deploy(st2, 0, 0, 71, []);
  ok(E.effAtk(st2, u71b) === 2, '71 只有自己一个区域：2 攻');
}
{
  // 52：三个区域均有单位 -> 回能
  const st = newSt(135);
  fu(st, 0, 0, 28); fu(st, 0, 2, 28); fu(st, 0, 4, 28);
  st.players[0].energy = 2;
  deploy(st, 0, 1, 52, []);               // 3/5
  ok(st.players[0].energy === 3, '52 己方三区域均有单位：能量 2 -> 3');
  const st2 = newSt(136);
  fu(st2, 0, 0, 28);
  st2.players[0].energy = 2;
  deploy(st2, 0, 1, 52, []);
  ok(st2.players[0].energy === 2, '52 只有一个区域有单位：不回能');
}
{
  // 53：选择一名友方单位 +1 生命（永久）
  const st = newSt(137);
  const f = fu(st, 0, 1, 28);
  deploy(st, 0, 0, 53, [{ uid: f.uid }]); // 2/3
  ok(E.effMaxHp(st, f) === 5, '53 选中友方：4 -> 5 生命');
}
{
  // 61：所在区域另一名友方单位 +1 生命
  const st = newSt(138);
  const f = fu(st, 0, 0, 28);
  deploy(st, 0, 1, 61, []);               // 2/4
  ok(E.effMaxHp(st, f) === 5, '61 同区域友方：4 -> 5 生命');
}
{
  // 64：能量不少于 3 时回 1 点
  const st = newSt(139);
  st.players[0].maxEnergy = 6;
  st.players[0].energy = 3;
  deploy(st, 0, 0, 64, []);               // 2/4
  ok(st.players[0].energy === 4, '64 能量 3：回到 4');
  const st2 = newSt(140);
  st2.players[0].energy = 2;
  deploy(st2, 0, 0, 64, []);
  ok(st2.players[0].energy === 2, '64 能量 2（不足 3）：不回能');
}
{
  // 73：本回合尚未部署其他单位 -> 回 1 点
  const st = newSt(141);
  st.players[0].energy = 2;
  deploy(st, 0, 0, 73, []);               // 2/3，deployCount 变为 1
  ok(st.players[0].energy === 3, '73 本回合第一次部署：能量 2 -> 3');
  const st2 = newSt(142);
  deploy(st2, 0, 0, 28, []);              // 先部署一张别的
  st2.players[0].energy = 2;
  deploy(st2, 0, 1, 73, []);
  ok(st2.players[0].energy === 2, '73 本回合已部署过其他单位：不回能');
}

sec('4) 部署时：本回合增益与减益');
{
  // 43：另一名友方 +1 攻（至回合结束）
  const st = newSt(151);
  const f = fu(st, 0, 0, 28);
  deploy(st, 0, 1, 43, []);               // 3/4
  ok(E.effAtk(st, f) === 3, '43 同区域友方：2 -> 3 攻（本回合）');
}
{
  // 56 / 68：选友方 +1 攻（至回合结束）
  const st = newSt(152);
  const f = fu(st, 0, 1, 28);
  deploy(st, 0, 0, 56, [{ uid: f.uid }]); // 2/4
  ok(E.effAtk(st, f) === 3, '56 选中友方：2 -> 3 攻');
  const st2 = newSt(153);
  const f2 = fu(st2, 0, 1, 28);
  deploy(st2, 0, 0, 68, [{ uid: f2.uid }]); // 2/3
  ok(E.effAtk(st2, f2) === 3, '68 选中友方：2 -> 3 攻');
  // 没选目标时作用自己，不能白打
  const st3 = newSt(154);
  const u68 = deploy(st3, 0, 0, 68, []);
  ok(E.effAtk(st3, u68) === 3, '68 未选目标：作用于自己 2 -> 3 攻');
}
{
  // 72：本回合第一张卡 +1 生命；并选择一个敌方区域全体 -1 攻
  const st = newSt(155);
  const foe1 = fu(st, 1, 4, 28);          // 区域 3
  const u72 = deploy(st, 0, 0, 72, [{ uid: 'area3' }]); // 3/3
  ok(E.effMaxHp(st, u72) === 4, '72 本回合第一张卡：生命 3 -> 4');
  ok(E.effAtk(st, foe1) === 1, '72 选中区域 3：敌方 2 -> 1 攻');
  const st2 = newSt(156);
  deploy(st2, 0, 0, 28, []);
  const u72b = deploy(st2, 0, 1, 72, []);
  ok(E.effMaxHp(st2, u72b) === 3, '72 不是本回合第一张：不加生命');
}
{
  // 75：本回合己方获得过增益 -> +1 生命，否则减敌方攻击
  const st = newSt(157);
  const foe = fu(st, 1, 0, 28);
  deploy(st, 0, 0, 75, [{ uid: foe.uid }]);  // 3/3
  ok(E.effAtk(st, foe) === 1, '75 无增益时：敌方 2 -> 1 攻');
  const st2 = newSt(158);
  st2.turnCtx.buffEvents.push({ side: 0, tag: 'atk', atk: 1 });
  const u75 = deploy(st2, 0, 0, 75, []);
  ok(E.effMaxHp(st2, u75) === 4, '75 己方获得过增益：生命 3 -> 4');
}
{
  // 54：本回合部署了另一名单位 -> +1 生命；否则让敌方「下一次攻击伤害 -1」（不是降攻击力）
  const st = newSt(159);
  const tank = fu(st, 0, 1, 28);           // 我方坦克，撑厚血方便量伤害
  tank.maxHp += 10; E._sync(st);
  const foe = fu(st, 1, 0, 28);            // 敌方 2/2，区域 1
  const u54 = deploy(st, 0, 0, 54, [{ uid: foe.uid }]);   // 2/1，本回合第一张
  ok(E.effAtk(st, foe) === 2, '54 本回合首张：敌方攻击力不变（仍 2）');
  ok(foe.flags.atkDmgMod === -1, '54 给敌方挂了「下次攻击伤害 -1」');
  const hpBefore = E.effHp(st, tank);
  st.active = 1; st.phase = 'combat';
  const r = E.attack(st, 1, foe.uid, { type: 'unit', uid: tank.uid });
  ok(r.ok, '54 敌方攻击我方坦克成功');
  ok(hpBefore - E.effHp(st, tank) === 1, '54 敌方攻击伤害 2 -> 1');
  ok(!foe.flags.atkDmgMod, '54 一次性修饰用掉即清');

  const st2 = newSt(160);
  deploy(st2, 0, 0, 28, []);
  const u54b = deploy(st2, 0, 1, 54, []);
  ok(E.effMaxHp(st2, u54b) === 2, '54 本回合已部署过单位：生命 1 -> 2');
}
{
  // 69：选择一名敌方单位，使其本回合受到的下一次伤害 +1（不是直接造成 1 点伤害）
  const st = newSt(161);
  const foe = fu(st, 1, 0, 28);            // 2/2
  deploy(st, 0, 0, 69, [{ uid: foe.uid }]); // 3/3
  ok(E.effHp(st, foe) === 4, '69 选中敌方：生命不变（仍 4）');
  ok(foe.flags.dmgPlus === 1, '69 给敌方挂了「下次受伤 +1」');
  const hpBefore = E.effHp(st, foe);
  E._ctx(st, 0, WG.cardById(69), st.players[0].units[0]).hurt(foe, 1);
  ok(hpBefore - E.effHp(st, foe) === 2, '69 下一次受到 1 点伤害变成 2 点');
  ok(!foe.flags.dmgPlus, '69 一次性修饰用掉即清');
}
{
  // 63 的可选减益
  const st = newSt(162);
  const foe = fu(st, 1, 0, 28);
  deploy(st, 0, 0, 63, [{ uid: foe.uid }]);  // 3/2
  ok(E.effAtk(st, foe) === 1, '63 选中敌方：2 -> 1 攻');
}
{
  // 54 … 已在上方覆盖
}

sec('5) 特殊机制：58 / 60 / 62 / 67');
{
  // 58：每回合第一次受到的伤害 -1
  const st = newSt(171);
  const u58 = fu(st, 0, 0, 58);           // 2/5
  E._sync(st);
  const e58 = WG.Effects[58];
  const T = tctx(st, 0, WG.cardById(58), u58);
  const r1 = e58.onBeforeDamage(u58, 2, T);
  ok(r1 && r1.reduce === 1, '58 本回合第一次受伤：减免 1 点');
  const r2 = e58.onBeforeDamage(u58, 2, T);
  ok(!r2, '58 本回合第二次受伤：不再减免');
  resetTurn(st, 0);                       // 新回合
  const T2 = tctx(st, 0, WG.cardById(58), u58);
  const r3 = e58.onBeforeDamage(u58, 2, T2);
  ok(r3 && r3.reduce === 1, '58 新回合重新获得减免');
}
{
  // 60：下一次攻击增益 ±1（引擎 gainModAtk）
  const st = newSt(172);
  const mine = fu(st, 0, 1, 28);
  const foe = fu(st, 1, 0, 28);
  deploy(st, 0, 0, 60, [{ uid: mine.uid }, { uid: foe.uid }]); // 3/3
  ok(mine.flags.gainModAtk === 1, '60 友方获得「下一次攻击增益+1」标记');
  ok(foe.flags.gainModAtk === -1, '60 敌方获得「下一次攻击增益-1」标记');
  const T = tctx(st, 0, WG.cardById(60), null);
  const before = E.effAtk(st, mine);
  T.buff(mine, { atk: 1, tag: 'atk' });
  E._sync(st);
  ok(E.effAtk(st, mine) === before + 2, '60 友方下一次 +1 攻击增益实际生效 +2');
  ok(mine.flags.gainModAtk === undefined, '60 标记用掉后即清除');
  T.buff(foe, { atk: 1, tag: 'atk' });
  E._sync(st);
  ok(E.effAtk(st, foe) === 2, '60 敌方下一次 +1 攻击增益被抵到 +0（仍为 2 攻）');
}
{
  // 62：本回合用过宽幅卡则抽牌，每回合限一次
  const st = newSt(173);
  const h0 = st.players[0].hand.length;
  st.turnCtx.playedWide[0] = true;
  deploy(st, 0, 0, 62, []);               // 2/3
  ok(st.players[0].hand.length === h0 + 1, '62 用过宽幅卡：抽 1 张（' + h0 + ' -> ' + st.players[0].hand.length + '）');
  const h1 = st.players[0].hand.length;
  deploy(st, 0, 1, 62, []);
  ok(st.players[0].hand.length === h1, '62 同一回合第二张：不再抽牌');
  const st2 = newSt(174);
  const h2 = st2.players[0].hand.length;
  deploy(st2, 0, 0, 62, []);
  ok(st2.players[0].hand.length === h2, '62 未用过宽幅卡：不抽牌');
}
{
  // 67：牌库顶置底 + 目标本回合不吃宽幅卡增益
  const st = newSt(175);
  const top = E.peekTop(st, 0, 1)[0];
  const foe = fu(st, 1, 0, 28);
  fw(st, 1, 1, 76, [1], [1]);             // 敌方区域 1 有宽幅卡
  E._sync(st);
  ok(E.effAtk(st, foe) === 4, '67 前置：敌方单位吃宽幅加成 2 -> 4');
  deploy(st, 0, 0, 67, [{ uid: foe.uid }, { uid: 'bottom' }]); // 1/3
  ok(foe.flags.noWide === true, '67 标记目标「不能获得宽幅卡增益」');
  ok(E.effAtk(st, foe) === 2, '67 目标失去宽幅加成：4 -> 2 攻');
  const top2 = E.peekTop(st, 0, 1)[0];
  ok(!!top && !!top2 && top2.cardId !== top.cardId, '67 牌库顶那张已被置于牌库底');
}

sec('6) 转调（48）：先移动再按新区域减攻');
{
  const st = newSt(181);
  const foe = fu(st, 1, 4, 28);           // 区域 3
  const u48 = deploy(st, 0, 0, 48, [{ uid: 'slot4' }, { uid: foe.uid }]); // 3/3
  ok(u48.slot === 4, '48 移动到单位位 5（区域 3）');
  ok(E.effAtk(st, foe) === 1, '48 使新区域内敌方 2 -> 1 攻');
  const st2 = newSt(182);
  const foe2 = fu(st2, 1, 4, 28);
  const u48b = deploy(st2, 0, 0, 48, [{ uid: foe2.uid }]); // 不移动，仍在区域 1
  ok(u48b.slot === 0, '48 不选空位时不移动');
  ok(E.effAtk(st2, foe2) === 2, '48 目标在移动后区域外：不减攻');
}
{
  // 48 移动后区域内没有合格目标时，回退为该区域攻击力最高的敌方单位
  const st = newSt(183);
  const far = fu(st, 1, 0, 28);           // 区域 1
  const near = fu(st, 1, 4, 28);          // 区域 3
  deploy(st, 0, 0, 48, [{ uid: 'slot4' }, { uid: far.uid }]); // 目标在区域 1，移动后到区域 3
  ok(E.effAtk(st, near) === 1, '48 目标不合法时回退为移动后区域内敌方单位');
  ok(E.effAtk(st, far) === 2, '48 区域 1 的敌方不受影响');
}

sec('7) targets 契约与可打出性');
{
  // 空局面（无单位、无宽幅、能量 0）下，所有 targets 里可能为空的选项必须 optional
  const st = newSt(191);
  st.players[0].energy = 0;
  let bad = [];
  for (let id = 39; id <= 75; id++) {
    const e = WG.Effects[id];
    if (!e || !e.targets) continue;
    const card = WG.cardById(id);
    let tg;
    try { tg = e.targets(tctx(st, 0, card, null)); }
    catch (err) { bad.push(id + ' 抛异常: ' + err.message); continue; }
    if (!Array.isArray(tg)) { bad.push(id + ' targets 未返回数组'); continue; }
    for (let i = 0; i < tg.length; i++) {
      const opt = tg[i];
      if (!Array.isArray(opt.options)) { bad.push(id + ' 第' + (i + 1) + '项没有 options 数组'); continue; }
      if (opt.options.length === 0 && !opt.optional) {
        bad.push(id + ' 第' + (i + 1) + '项选项为空却未标 optional');
      }
    }
  }
  ok(bad.length === 0, '39-75 的 targets 全部满足契约' + (bad.length ? '：' + bad.join('；') : ''));

  // 空局面也能打出「选择一名友方单位」类卡（optional 生效）
  const st2 = newSt(192);
  st2.players[0].hand = [{ cardId: 56 }, { cardId: 60 }, { cardId: 48 }];
  const chk = E.canPlay(st2, 0, 0);
  ok(chk.ok, '空局面 canPlay(56) 仍然通过（targets 可跳过）' + (chk.reason ? '：' + chk.reason : ''));
  const chk2 = E.canPlay(st2, 0, 1);
  ok(chk2.ok, '空局面 canPlay(60) 仍然通过' + (chk2.reason ? '：' + chk2.reason : ''));
  const chk3 = E.canPlay(st2, 0, 2);
  ok(chk3.ok, '空局面 canPlay(48) 仍然通过' + (chk3.reason ? '：' + chk3.reason : ''));
}

sec('8) 覆盖清点');
{
  const missing = [];
  for (let id = 39; id <= 75; id++) {
    if (!WG.Effects[id]) missing.push(id);
  }
  ok(missing.length === 0, '39-75 共 37 张全部有实现' + (missing.length ? '，缺：' + missing.join(',') : ''));
  let withStatic = 0, withDeploy = 0;
  for (let id = 39; id <= 75; id++) {
    const e = WG.Effects[id];
    if (e.static) withStatic++;
    if (e.onDeploy) withDeploy++;
  }
  console.log('  带 static 的卡：' + withStatic + ' 张；带 onDeploy 的卡：' + withDeploy + ' 张');
}

console.log('\n=== 结果：' + passes + ' 项通过，' + fails + ' 项失败 ===');
console.log(fails === 0 ? '全部通过 ✓\n' : '存在失败 ✗\n');
process.exit(fails === 0 ? 0 : 1);
