/* Wide-Grid · 效果系统 —— 普通单位卡 1-38
 *
 * 契约见 game/EFFECTS_API.md。所有效果都挂在 WG.Effects[卡牌id] 上。
 * 参数 T 是引擎给的上下文对象（见 engine.js 的 ctx()）。
 *
 * 通用判断约定：
 *   - 卡面写"持续至回合结束" → T.buff（临时）；没写持续时间的"获得 +N" → T.permAtk / T.permHp（永久）。
 *   - 纯条件加成（含"若…"的持续条件）→ static，无副作用。
 *   - "每回合第一次…" → u.flags 守卫（回合开始自动清空）。
 */
(function (WG) {
  'use strict';
  WG.Effects = WG.Effects || {};
  var E = WG.Effects;
  var U = WG.EffectsUtil;

  // ---------- 本文件内部辅助 ----------
  function areaOf(u) { return WG.areaOfSlot(u.slot); }

  /** 某方全场单位 */
  function ownUnits(T, side) {
    var out = [];
    for (var a = 1; a <= 3; a++) out = out.concat(WG.Engine.unitsInArea(T.st, side, a));
    return out;
  }

  /** 某方全场的敌方单位 */
  function foeUnits(T, side) {
    var out = [];
    for (var a = 1; a <= 3; a++) out = out.concat(WG.Engine.unitsInArea(T.st, WG.foe(side), a));
    return out;
  }

  /** 同区域友方里生命上限最高的一名（不含自己），并列取槽位靠前者 */
  function bestFriendByHp(u, T) {
    var list = T.friends(u);
    if (!list.length) return null;
    var best = list[0], bv = WG.Engine.effMaxHp(T.st, best);
    for (var i = 1; i < list.length; i++) {
      var v = WG.Engine.effMaxHp(T.st, list[i]);
      if (v > bv) { best = list[i]; bv = v; }
    }
    return best;
  }

  /** 从 picked 项里取单位（兼容 {uid:...} 与直接给 uid 数字） */
  function pickUnit(T, p) {
    if (p === undefined || p === null) return null;
    var uid = (typeof p === 'number') ? p : p.uid;
    if (uid === undefined || uid === null) return null;
    return WG.Engine.unitByUid(T.st, uid);
  }

  /** 从 picked 项里取攻击区域号（兼容 {area:n} / {value:n} / 数字） */
  function pickArea(p) {
    if (p === undefined || p === null) return 0;
    if (typeof p === 'number') return p;
    if (p.area) return p.area;
    if (p.value) return p.value;
    return 0;
  }

  function unitLabel(T, x) {
    return WG.cardName(x.cardId) + ' ' + WG.Engine.effAtk(T.st, x) + '/' + WG.Engine.effHp(T.st, x) +
      '（区域' + WG.areaOfSlot(x.slot) + '）';
  }

  // ============================================================
  // 1-15 演奏技法与节奏
  // ============================================================

  // 1 切分音：部署时，若所在区域已有友方单位，获得+1生命。
  // 实现判断：无"持续至回合结束"字样 → 永久（permHp），"已有友方单位"引用部署前的同区友方（不含自己）。
  E[1] = {
    onDeploy: function (u, T) {
      if (T.friends(u).length) T.permHp(u, 1);
    }
  };

  // 2 三连音：若所在区域有另一名友方单位，攻击力+1。
  E[2] = {
    static: function (u, T) {
      return { atk: T.friends(u).length ? 1 : 0 };
    }
  };

  // 3 连音线：所在区域的另一名友方单位首次受到伤害时，伤害-1。
  // 实现判断："首次"按该受伤单位每回合第一次受到伤害计（victim.flags，回合开始清空）。
  E[3] = {
    protect: function (f, v, T) {
      if (v.flags.__lianyinxian) return null;
      v.flags.__lianyinxian = true;
      return { reduce: 1 };
    }
  };

  // 4 断奏：部署当回合攻击力+1。
  // 实现判断：用 turnCount === deployedTurn 判定"当回合"，跨回合自动失效（static 不产生副作用）。
  E[4] = {
    static: function (u, T) {
      return { atk: (u.deployedTurn === T.st.turnCount) ? 1 : 0 };
    }
  };

  // 5 顿音：若本回合尚未部署其他单位，攻击力+1。
  // 实现判断：本回合自身部署数 <= 1 即视为"尚未部署其他单位"（未部署任何单位时同样成立）。
  E[5] = {
    static: function (u, T) {
      var n = T.tc().deployCount[u.owner] || 0;
      return { atk: n <= 1 ? 1 : 0 };
    }
  };

  // 6 颤音：每回合第一次获得增益时，额外获得+1攻击力，持续至回合结束。
  // 实现判断：引擎没有"获得增益"钩子；static 里检测自己身上是否有本回合的正向临时增益
  // （buff 回合结束清除），有则 +1，多份增益也只 +1，等价于"第一次获得增益后 +1 至回合结束"。
  E[6] = {
    static: function (u, T) {
      for (var i = 0; i < u.buffs.length; i++) {
        var b = u.buffs[i];
        if ((b.atk || 0) > 0 || (b.hp || 0) > 0) return { atk: 1 };
      }
      return { atk: 0 };
    }
  };

  // 7 滑音：部署时，可在同一攻击区域内选择另一个空位重新放置。
  // 实现判断：targets 在选位之前调用，拿不到"将要放置的区域"，故列出全部己方空位，
  // 由 onDeploy 校验必须同区域（不同区域的选择直接忽略）。可选，不选则不移动。
  E[7] = {
    targets: function (T) {
      var opts = [];
      var slots = WG.Engine.validUnitSlots(T.st, T.side);
      for (var i = 0; i < slots.length; i++) {
        opts.push({
          slot: slots[i],
          label: '槽位 ' + (slots[i] + 1) + '（区域' + WG.areaOfSlot(slots[i]) + '）'
        });
      }
      return [{
        key: 'slot',
        label: '可换到同一攻击区域的另一个空位（可跳过）',
        optional: true,
        options: opts
      }];
    },
    onDeploy: function (u, T, picked) {
      var p = picked && picked[0];
      if (!p) return;
      var slot = (typeof p === 'number') ? p : p.slot;
      if (slot === undefined || slot === null) return;
      if (WG.areaOfSlot(slot) !== areaOf(u)) return;
      var r = WG.Engine.moveUnit(T.st, u, slot);
      if (r.ok) T.log('滑音：改放到区域' + WG.areaOfSlot(slot) + ' 的空位');
    }
  };

  // 8 倚音：部署时，所在区域另一名友方单位获得+1攻击力，持续至回合结束。
  // 实现判断：同区有多名友方时，指定攻击力最高的一名（并列取槽位靠前者）。
  E[8] = {
    onDeploy: function (u, T) {
      var t = U.topAtk(u, T);
      if (!t || t.uid === u.uid) return;
      T.buff(t, { atk: 1, tag: 'atk' });
      T.log('倚音：' + WG.cardName(t.cardId) + ' 攻击力 +1（至回合结束）');
    }
  };

  // 9 回音：部署时，复制本回合己方已触发的一项友方增益效果；数值减半，向下取整。
  // 实现判断：引擎只记录增益事件（T.buff 写入 buffEvents），不含目标单位；
  // 因此取"本回合己方最近一次正向增益"，按数值减半（向下取整）复制到自己身上，持续至回合结束。
  E[9] = {
    onDeploy: function (u, T) {
      var ev = T.tc().buffEvents;
      var src = null;
      for (var i = ev.length - 1; i >= 0; i--) {
        var e = ev[i];
        if (e.side !== u.owner) continue;
        if ((e.atk || 0) <= 0 && (e.hp || 0) <= 0) continue;
        src = e;
        break;
      }
      if (!src) return;
      var atk = Math.floor((src.atk || 0) / 2);
      var hp = Math.floor((src.hp || 0) / 2);
      if (!atk && !hp) return;
      T.buff(u, { atk: atk, hp: hp, tag: src.tag || 'atk' });
      T.log('回音：复制增益 攻+' + atk + ' / 生命+' + hp + '（至回合结束）');
    }
  };

  // 10 轮指：若相邻攻击区域也有友方单位，获得+1生命。
  E[10] = {
    static: function (u, T) {
      var a = areaOf(u);
      for (var d = -1; d <= 1; d += 2) {
        var b = a + d;
        if (b >= 1 && b <= 3 && WG.Engine.unitsInArea(T.st, u.owner, b).length) return { hp: 1 };
      }
      return { hp: 0 };
    }
  };

  // 11 泛音：受到宽幅卡增益时，额外获得+1攻击力。
  E[11] = {
    static: function (u, T) {
      return { atk: T.hasWide(u) ? 1 : 0 };
    }
  };

  // 12 拨弦：部署后若当前能量尚有剩余，获得+1攻击力，持续至回合结束。
  // 实现判断：onDeploy 时费用已支付，此时 energy > 0 即"尚有剩余"。
  E[12] = {
    onDeploy: function (u, T) {
      if (T.energy(u.owner) > 0) T.buff(u, { atk: 1, tag: 'atk' });
    }
  };

  // 13 掌击：若所在区域没有其他友方单位，获得+1攻击力。
  E[13] = {
    static: function (u, T) {
      return { atk: T.friends(u).length ? 0 : 1 };
    }
  };

  // 14 震音：每回合第一次受到伤害时，伤害-1。
  E[14] = {
    onBeforeDamage: function (u, n, T) {
      if (u.flags.__firstHit) return null;
      u.flags.__firstHit = true;
      return { reduce: 1 };
    }
  };

  // 15 华彩段：若本回合已经部署过宽幅卡，获得+1攻击力。
  E[15] = {
    static: function (u, T) {
      return { atk: T.tc().playedWide[u.owner] ? 1 : 0 };
    }
  };

  // ============================================================
  // 16-30 乐器与弦乐
  // ============================================================

  // 16 钢琴独奏：部署时，若己方场上没有其他单位，获得+1攻击力。
  // 实现判断：无持续时间说明 → 永久（permAtk）。
  E[16] = {
    onDeploy: function (u, T) {
      var others = ownUnits(T, u.owner).filter(function (x) { return x.uid !== u.uid; });
      if (!others.length) T.permAtk(u, 1);
    }
  };

  // 17 三角钢琴：若所在区域有宽幅卡增益，获得+1生命。
  E[17] = {
    static: function (u, T) {
      return { hp: T.wideCount(u.owner, areaOf(u)) > 0 ? 1 : 0 };
    }
  };

  // 18 立式钢琴：部署时，选择一个敌方攻击区域；该区域内一名敌方单位攻击力-1，持续至回合结束。
  // 实现判断：目标选择合并为一次"选一名敌方单位"（区域即该单位所在区域，
  // 卡面文案"选区域 + 选单位"两段选择无法在单一 targets 调用里表达依赖关系）；无敌方单位时可跳过。
  E[18] = {
    targets: function (T) {
      var foe = foeUnits(T, T.side), opts = [];
      for (var i = 0; i < foe.length; i++) opts.push({ uid: foe[i].uid, label: unitLabel(T, foe[i]) });
      return [{
        key: 'enemy',
        label: '选择一名敌方单位（该区域）',
        optional: true,
        options: opts
      }];
    },
    onDeploy: function (u, T, picked) {
      var t = pickUnit(T, picked && picked[0]);
      if (!t || t.owner === u.owner) return;
      T.buff(t, { atk: -1, tag: 'debuff' });
      T.log('立式钢琴：' + WG.cardName(t.cardId) + ' 攻击力 -1（至回合结束）');
    }
  };

  // 19 电钢琴：部署时，若当前能量不少于2，获得+1攻击力。
  // 实现判断：费用已支付后判定；无持续时间说明 → 永久（permAtk）。
  E[19] = {
    onDeploy: function (u, T) {
      if (T.energy(u.owner) >= 2) T.permAtk(u, 1);
    }
  };

  // 20 合成器：部署时，若本回合部署过宽幅卡，获得+1生命。
  E[20] = {
    onDeploy: function (u, T) {
      if (T.tc().playedWide[u.owner]) T.permHp(u, 1);
    }
  };

  // 21 模拟合成器：部署时，恢复1点能量；每回合限一次。
  E[21] = {
    onDeploy: function (u, T) {
      var tc = T.tc();
      if (tc.onceUsed.__e21) return;
      tc.onceUsed.__e21 = true;
      T.energy_(u.owner, 1);
    }
  };

  // 22 模块合成器：每回合第一次获得能量时，攻击力+1，持续至回合结束。
  // 实现判断：引擎只在 T.energy_ 触发时置 turnCtx.energyGained（回合开始恢复能量不算），
  // 用该标记派生 +1，一回合内只 +1 一次，回合结束自动消失。
  E[22] = {
    static: function (u, T) {
      return { atk: T.tc().energyGained[u.owner] ? 1 : 0 };
    }
  };

  // 23 电吉他：若所在区域获得攻击增益，额外获得+1攻击力。
  // 实现判断：以"同区域（含自己）存在正向攻击类临时增益，或该区有宽幅卡加成"为条件
  // （宽幅卡无法只查攻击类加成，用 T.hasWide 近似）。
  E[23] = {
    static: function (u, T) {
      var list = WG.Engine.unitsInArea(T.st, u.owner, areaOf(u));
      for (var i = 0; i < list.length; i++) {
        var bs = list[i].buffs;
        for (var j = 0; j < bs.length; j++) if ((bs[j].atk || 0) > 0) return { atk: 1 };
        if (T.hasWide(list[i])) return { atk: 1 };
      }
      return { atk: 0 };
    }
  };

  // 24 原声吉他：部署时，所在区域另一名友方单位获得+1生命。
  // 实现判断：无"持续至回合结束" → 永久（permHp）；同区多名友方时取生命上限最高者。
  E[24] = {
    onDeploy: function (u, T) {
      var t = bestFriendByHp(u, T);
      if (!t) return;
      T.permHp(t, 1);
      T.log('原声吉他：' + WG.cardName(t.cardId) + ' 生命 +1');
    }
  };

  // 25 贝斯吉他：若所在区域有另一名友方单位，获得+1攻击力。
  E[25] = {
    static: function (u, T) {
      return { atk: T.friends(u).length ? 1 : 0 };
    }
  };

  // 26 五弦贝斯：若相邻两个攻击区域均有友方单位，获得+1攻击力。
  // 实现判断：仅区域 2 具备左右两个相邻区域，其他区域永远无法满足。
  E[26] = {
    static: function (u, T) {
      var a = areaOf(u), n = 0;
      for (var d = -1; d <= 1; d += 2) {
        var b = a + d;
        if (b >= 1 && b <= 3 && WG.Engine.unitsInArea(T.st, u.owner, b).length) n++;
      }
      return { atk: n >= 2 ? 1 : 0 };
    }
  };

  // 27 小提琴：若所在区域有宽幅卡，获得+1攻击力。
  E[27] = {
    static: function (u, T) {
      return { atk: T.wideCount(u.owner, areaOf(u)) > 0 ? 1 : 0 };
    }
  };

  // 28 中提琴：无特殊效果。
  E[28] = {};

  // 29 大提琴：每回合第一次受到伤害时，伤害-1。
  E[29] = {
    onBeforeDamage: function (u, n, T) {
      if (u.flags.__firstHit) return null;
      u.flags.__firstHit = true;
      return { reduce: 1 };
    }
  };

  // 30 低音提琴：若所在区域有其他友方单位，获得+1生命。
  E[30] = {
    static: function (u, T) {
      return { hp: T.friends(u).length ? 1 : 0 };
    }
  };

  // ============================================================
  // 31-38 声部与指挥
  // ============================================================

  // 31 主旋律：部署时，选择一名友方单位，攻击力+1，持续至回合结束。
  // 实现判断："一名友方单位"含自己；targets 在自己进场前计算（此时自己还不在场上），
  // 所以未选/无可选时默认加给自己。
  E[31] = {
    targets: function (T) {
      var mine = ownUnits(T, T.side), opts = [];
      for (var i = 0; i < mine.length; i++) opts.push({ uid: mine[i].uid, label: unitLabel(T, mine[i]) });
      return [{
        key: 'friend',
        label: '选择一名友方单位（不选则加给自己）',
        optional: true,
        options: opts
      }];
    },
    onDeploy: function (u, T, picked) {
      var t = pickUnit(T, picked && picked[0]);
      if (!t || t.owner !== u.owner) t = u;
      T.buff(t, { atk: 1, tag: 'atk' });
      T.log('主旋律：' + WG.cardName(t.cardId) + ' 攻击力 +1（至回合结束）');
    }
  };

  // 32 副旋律：若所在区域有攻击力更高的友方单位，获得+1生命。
  E[32] = {
    static: function (u, T) {
      var list = T.friends(u), mine = WG.Engine.effAtk(T.st, u);
      for (var i = 0; i < list.length; i++) {
        if (WG.Engine.effAtk(T.st, list[i]) > mine) return { hp: 1 };
      }
      return { hp: 0 };
    }
  };

  // 33 节奏组：所在区域内其他友方单位获得+1生命。
  // 光环（aura）：同区域的其他友方单位持续 +1 生命，不含自己；
  // 节奏组离场加成自动消失，后进场的友方单位自动享受。
  E[33] = {
    aura: function (target, self) {
      return { hp: 1 };
    }
  };

  // 34 和声部：若所在区域有另一名友方单位，双方各获得+1生命。
  // 两个来源：static 给自己那份（条件是「有另一名友方」），aura 给同区每名其他友方那份。
  // 场上有两张和声部时各给各的，加成叠加 —— 每张卡独立生效，符合卡牌惯例。
  E[34] = {
    static: function (u, T) {
      return { hp: T.friends(u).length ? 1 : 0 };
    },
    aura: function (target, self) {
      return { hp: 1 };
    }
  };

  // 35 低音声部：所在区域有友方单位时，自己受到的第一次伤害-1。
  E[35] = {
    onBeforeDamage: function (u, n, T) {
      if (!T.friends(u).length) return null;
      if (u.flags.__firstHit) return null;
      u.flags.__firstHit = true;
      return { reduce: 1 };
    }
  };

  // 36 高音声部：若所在区域有宽幅卡增益，攻击力+1。
  E[36] = {
    static: function (u, T) {
      return { atk: T.hasWide(u) ? 1 : 0 };
    }
  };

  // 37 节拍器：部署时，恢复1点能量；选择一名敌方单位，使其本回合下一次获得的攻击增益-1（最低为0）。
  // 用引擎的 u.flags.gainModAtk（一次性修饰下一次 T.buff 的攻击增益，最低 0），
  // 注意它不作用于宽幅卡的实时加成（引擎有意降级）。
  E[37] = {
    targets: function (T) {
      var foe = foeUnits(T, T.side), opts = [];
      for (var i = 0; i < foe.length; i++) opts.push({ uid: foe[i].uid, label: unitLabel(T, foe[i]) });
      return [{
        key: 'enemy',
        label: '选择一名敌方单位',
        optional: true,
        options: opts
      }];
    },
    onDeploy: function (u, T, picked) {
      T.energy_(u.owner, 1);
      var t = pickUnit(T, picked && picked[0]);
      if (!t || t.owner === u.owner) return;
      t.flags.gainModAtk = (t.flags.gainModAtk || 0) - 1;
      T.log('节拍器：' + WG.cardName(t.cardId) + ' 下一次攻击增益 -1');
    }
  };

  // 38 指挥棒：部署时，选择一个攻击区域，该区域内友方单位攻击力+1，持续至回合结束。
  // 实现判断："友方单位"含该区域内的自己（若自己就在所选区域）。无可选区域时可跳过。
  E[38] = {
    targets: function (T) {
      var opts = [];
      for (var a = 1; a <= 3; a++) {
        if (WG.Engine.unitsInArea(T.st, T.side, a).length) {
          opts.push({
            area: a,
            label: '区域' + a + '（友方 ' + WG.Engine.unitsInArea(T.st, T.side, a).length + ' 名）'
          });
        }
      }
      return [{
        key: 'area',
        label: '选择一个攻击区域',
        optional: true,
        options: opts
      }];
    },
    onDeploy: function (u, T, picked) {
      var a = pickArea(picked && picked[0]);
      if (a < 1 || a > 3) return;
      var list = WG.Engine.unitsInArea(T.st, u.owner, a);
      for (var i = 0; i < list.length; i++) T.buff(list[i], { atk: 1, tag: 'atk' });
      T.log('指挥棒：区域' + a + ' 友方单位攻击力 +1（至回合结束）');
    }
  };

})(typeof window !== 'undefined'
  ? (window.WG = window.WG || {})
  : (global.WG = global.WG || {}));
