/* 随机对局压力测试：node tools/test_soak.js [局数]
 *
 * 目的：把 100 张卡（含所有已实现效果）扔进随机对局里反复跑，
 *       用最简单的贪心策略驱动双方，检查
 *         - 不抛异常
 *         - 不产生 NaN / Infinity
 *         - 能量始终在 [0, maxEnergy]
 *         - 不出现同一位置两个单位 / 单位数超 6
 *         - 不无限循环
 * 不校验"打得对不对"（那是 test_effects_*.js 的事），只校验"不会烂掉"。
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
  if (!fs.existsSync(p)) return false;
  vm.runInContext(fs.readFileSync(p, 'utf8'), sandbox, { filename: rel });
  return true;
}

// 顺序与 index.html 一致
const files = [
  'game/js/engine/constants.js',
  'game/js/data/cards.js',
  'game/js/engine/engine.js',
  'game/js/engine/effects_core.js',
  'game/js/engine/effects_units_a.js',
  'game/js/engine/effects_units_b.js'
];
const loaded = files.filter(load);
const missing = files.filter(f => loaded.indexOf(f) < 0);

const WG = sandbox.WG;
const E = WG.Engine;
const C = WG.C;

const GAMES = parseInt(process.argv[2], 10) || 200;
const MAX_STEPS = 4000;

let fails = 0;
const problems = [];

function fail(msg) {
  fails++;
  if (problems.length < 40) problems.push(msg);
}

// ---------- 随机牌组：15 种 × 2 = 30 ----------
function randDeck(rnd) {
  const units = WG.CARDS.filter(c => c.type === 'unit').map(c => c.id);
  const wides = WG.CARDS.filter(c => c.type === 'wide').map(c => c.id);
  function pick(arr, n) {
    const pool = arr.slice();
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = Math.floor(rnd() * pool.length);
      out.push(pool.splice(k, 1)[0]);
    }
    return out;
  }
  const w = pick(wides, 5);              // 5 种宽幅卡
  const u = pick(units, 10);             // 10 种单位卡
  const ids = w.concat(u);               // 15 种
  const deck = [];
  ids.forEach(id => { deck.push(id); deck.push(id); });
  return deck;
}

// mulberry32
function makeRnd(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 不变量检查 ----------
function checkInvariants(st, where) {
  for (let s = 0; s < 2; s++) {
    const p = st.players[s];
    if (!isFinite(p.hp)) fail(where + ' P' + s + '.hp 非法: ' + p.hp);
    if (!isFinite(p.energy)) fail(where + ' P' + s + '.energy 非法: ' + p.energy);
    if (!isFinite(p.maxEnergy)) fail(where + ' P' + s + '.maxEnergy 非法: ' + p.maxEnergy);
    if (p.energy < 0) fail(where + ' P' + s + ' 能量为负: ' + p.energy);
    if (p.energy > p.maxEnergy) fail(where + ' P' + s + ' 能量超过上限: ' + p.energy + '>' + p.maxEnergy);
    if (p.maxEnergy > C.MAX_ENERGY_CAP) fail(where + ' P' + s + ' 上限超过 ' + C.MAX_ENERGY_CAP + ': ' + p.maxEnergy);

    let seen = {};
    let count = 0;
    for (let i = 0; i < C.UNIT_SLOTS; i++) {
      const u = p.units[i];
      if (!u) continue;
      count++;
      if (seen[u.uid]) fail(where + ' P' + s + ' 同一单位出现两次: uid=' + u.uid);
      seen[u.uid] = 1;
      if (u.slot !== i) fail(where + ' P' + s + ' 单位 slot 字段与数组下标不符: ' + u.slot + ' vs ' + i);
      if (u.owner !== s) fail(where + ' P' + s + ' 单位 owner 不符: ' + u.owner);
      const a = E.effAtk(st, u), mh = E.effMaxHp(st, u), h = E.effHp(st, u);
      if (!isFinite(a)) fail(where + ' 单位 ' + u.uid + ' 攻击力非法: ' + a);
      if (!isFinite(mh)) fail(where + ' 单位 ' + u.uid + ' 最大生命非法: ' + mh);
      if (!isFinite(h)) fail(where + ' 单位 ' + u.uid + ' 当前生命非法: ' + h);
      if (a < 0) fail(where + ' 单位 ' + u.uid + ' 攻击力为负: ' + a);
      if (!isFinite(u.wounds)) fail(where + ' 单位 ' + u.uid + ' wounds 非法: ' + u.wounds);
    }
    if (count > C.UNIT_SLOTS) fail(where + ' P' + s + ' 单位数超过 ' + C.UNIT_SLOTS);
  }
}

// ---------- 贪心策略 ----------
function pickSlotForUnit(st, side, chk, rnd) {
  const slots = chk.needSlots;
  return slots[Math.floor(rnd() * slots.length)];
}

/** 执行一个动作；返回是否做了事 */
function greedyDeploy(st, side, rnd) {
  if (st.over) return false;
  if (st.phase !== 'deploy') return false;
  const p = st.players[side];

  // 先试着升级宽幅卡
  for (let a = 1; a <= C.AREAS; a++) {
    const up = E.canUpgrade(st, side, a);
    if (up.ok) {
      const r = E.upgradeWide(st, side, a);
      if (!r.ok) fail('upgradeWide 失败: ' + r.reason);
      checkInvariants(st, 'after upgrade a' + a);
      return true;
    }
  }

  // 再试着打出手牌（从贵到便宜，尽量用光能量）
  const order = [];
  for (let i = 0; i < p.hand.length; i++) {
    const card = WG.cardById(p.hand[i].cardId);
    if (card.cost <= p.energy) order.push(i);
  }
  order.sort((x, y) => WG.cardById(p.hand[y].cardId).cost - WG.cardById(p.hand[x].cardId).cost);

  for (const i of order) {
    const chk = E.canPlay(st, side, i);
    if (!chk.ok) continue;
    const choice = {};
    if (chk.type === 'unit') {
      choice.slot = pickSlotForUnit(st, side, chk, rnd);
    } else {
      const cands = chk.needSlots;
      choice.wideSlots = cands[Math.floor(rnd() * cands.length)];
    }
    // 目标
    if (chk.targets && chk.targets.length) {
      choice.targets = chk.targets.map(t => {
        if (t.optional && (!t.options || !t.options.length)) return null;
        if (!t.options || !t.options.length) return null;
        return t.options[Math.floor(rnd() * t.options.length)];
      });
      // 必填项没得选就跳过这张卡
      for (let k = 0; k < chk.targets.length; k++) {
        if (!chk.targets[k].optional && !choice.targets[k]) { choice.__skip = true; break; }
      }
      if (choice.__skip) continue;
    }
    const r = E.play(st, side, i, choice);
    if (!r.ok) {
      // 策略选了非法组合也算问题，但记录后继续
      fail('play 被拒: ' + r.reason + ' (卡 ' + WG.cardById(st.players[side].hand[i] && st.players[side].hand[i].cardId) + ')');
      continue;
    }
    checkInvariants(st, 'after play');
    return true;
  }
  return false;
}

function greedyCombat(st, side, rnd) {
  if (st.over) return false;
  if (st.phase !== 'combat') return false;
  const list = E.allUnits(st).filter(u => u.owner === side && E.canAttack(st, u));
  if (!list.length) return false;
  const u = list[Math.floor(rnd() * list.length)];
  const legal = E.legalAttackTargets(st, u);
  let target;
  if (legal.face) {
    target = { type: 'face' };
  } else if (!legal.units.length) {
    // v0.3：对方主卡区域还有单位、但本攻击区是空的 -> 本单位本回合无合法目标
    return false;
  } else {
    // 优先打能打死的，否则打攻击力最低的
    let best = null;
    for (const t of legal.units) {
      const canKill = E.effAtk(st, u) >= E.effHp(st, t);
      if (!best) best = t;
      else if (canKill && E.effHp(st, t) < E.effHp(st, best)) best = t;
      else if (!canKill && E.effAtk(st, t) < E.effAtk(st, best)) best = t;
    }
    target = { type: 'unit', uid: best.uid };
  }
  const r = E.attack(st, side, u.uid, target);
  if (!r.ok) { fail('attack 被拒: ' + r.reason); return false; }
  checkInvariants(st, 'after attack');
  return true;
}

/** 清理残留的 pending 区域（引擎在区域最后一名单位攻击后自动结算，
 *  但如果该区域我方单位都被破坏了，可能残留） */
function flushPending(st) {
  let did = false;
  for (let a = 1; a <= C.AREAS; a++) {
    const pd = st.pending && st.pending[a];
    if (pd && (Object.keys(pd.damage || {}).length || Object.keys(pd.face || {}).length)) {
      E.resolveArea(st, a);
      did = true;
    }
  }
  return did;
}

// ---------- 跑一局 ----------
function runGame(seed) {
  const rnd = makeRnd(seed);
  const d0 = randDeck(rnd), d1 = randDeck(rnd);
  const st = E.newGame({ decks: [d0, d1], names: ['A', 'B'], seed: seed });
  if (st.error) { fail('newGame 失败: ' + st.error); return null; }
  E.beginMatch(st);
  E.mulligan(st, 0, [0]);
  E.mulligan(st, 1, []);
  checkInvariants(st, 'after begin');

  let steps = 0;
  let idle = 0;
  while (!st.over && steps < MAX_STEPS) {
    steps++;
    const side = st.active;
    let acted = false;

    if (st.phase === 'deploy') {
      acted = greedyDeploy(st, side, rnd);
      if (!acted) {
        const r = E.toCombat(st, side);
        if (!r.ok) fail('toCombat 失败: ' + r.reason);
        acted = true;
      }
    } else if (st.phase === 'combat') {
      acted = greedyCombat(st, side, rnd);
      if (!acted) {
        if (flushPending(st)) { acted = true; }
        else {
          const r = E.endTurn(st, side);
          if (!r.ok && !st.over) fail('endTurn 失败: ' + r.reason);
          acted = true;
        }
      }
    } else {
      // start/draw/def/end 这些是引擎内部的瞬态，不该停在这里
      fail('对局停在阶段 ' + st.phase);
      break;
    }

    if (acted) idle = 0; else idle++;
    if (idle > 20) { fail('连续 20 步无进展，可能死循环（阶段 ' + st.phase + '）'); break; }
    checkInvariants(st, 'step ' + steps);
    if (st.over) break;
  }

  if (!st.over && steps >= MAX_STEPS) fail('超过 ' + MAX_STEPS + ' 步未结束（seed ' + seed + '）');

  return { st, steps };
}

// ---------- 主流程 ----------
console.log('加载: ' + loaded.length + '/' + files.length + ' 个脚本');
if (missing.length) console.log('  缺失: ' + missing.join(', '));
console.log('运行 ' + GAMES + ' 局随机对局…\n');

const t0 = Date.now();
let finished = 0, totalSteps = 0, wins = [0, 0], reasons = {};

for (let g = 0; g < GAMES; g++) {
  const seed = 1000 + g * 7919;
  let r;
  try {
    r = runGame(seed);
  } catch (err) {
    fail('第 ' + g + ' 局抛异常: ' + (err && err.message) + '\n    ' + (err && err.stack || '').split('\n')[1]);
    continue;
  }
  if (!r) continue;
  if (r.st.over) {
    finished++;
    wins[r.st.over.loser === 0 ? 1 : 0]++;
    const key = r.st.over.reason;
    reasons[key] = (reasons[key] || 0) + 1;
  }
  totalSteps += r.steps;
}

const ms = Date.now() - t0;
console.log('完成对局: ' + finished + '/' + GAMES);
console.log('平均步数: ' + (finished ? Math.round(totalSteps / GAMES) : 0));
console.log('先手胜 / 后手胜: ' + wins[0] + ' / ' + wins[1]);
console.log('结束原因:');
Object.keys(reasons).forEach(k => console.log('  ' + reasons[k] + '× ' + k));
console.log('耗时: ' + ms + 'ms');

if (problems.length) {
  console.log('\n发现的问题（最多列 40 条）:');
  problems.forEach((p, i) => console.log('  ' + (i + 1) + ') ' + p));
}

console.log('\n=== 结果：' + (fails === 0 ? '全部通过 ✓' : fails + ' 个问题 ✗') + ' ===\n');
process.exit(fails === 0 ? 0 : 1);
