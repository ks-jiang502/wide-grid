/* Wide-Grid · 效果系统 —— 核心框架 + 宽幅卡（76-100）
 *
 * 契约见 game/EFFECTS_API.md。所有效果都挂在 WG.Effects[卡牌id] 上。
 * 参数 T 是引擎给的上下文对象（见 engine.js 的 ctx()）。
 */
(function (WG) {
  'use strict';
  WG.Effects = WG.Effects || {};
  var E = WG.Effects;

  // ---------- 通用辅助 ----------
  function areaOf(u) { return WG.areaOfSlot(u.slot); }
  function friendsInArea(u, T) {
    return WG.Engine.unitsInArea(T.st, u.owner, areaOf(u)).filter(function (x) { return x.uid !== u.uid; });
  }
  function enemiesInArea(u, T) {
    return WG.Engine.unitsInArea(T.st, WG.foe(u.owner), areaOf(u));
  }
  function allFriends(u, T) {
    var out = [];
    for (var a = 1; a <= 3; a++) {
      out = out.concat(WG.Engine.unitsInArea(T.st, u.owner, a));
    }
    return out;
  }
  function allEnemies(u, T) {
    var out = [];
    for (var a = 1; a <= 3; a++) {
      out = out.concat(WG.Engine.unitsInArea(T.st, WG.foe(u.owner), a));
    }
    return out;
  }
  WG.EffectsUtil = {
    areaOf: areaOf,
    friendsInArea: friendsInArea,
    enemiesInArea: enemiesInArea,
    allFriends: allFriends,
    allEnemies: allEnemies,
    /** 区域内攻击力最高的友方单位（并列取槽位靠前）
     *  用 bAtk（不含宽幅卡加成）比较：宽幅卡的 wide() 会调用本函数，
     *  若用 effAtk 会经 wideAtkFor 递归回自身，栈溢出。
     */
    topAtk: function (u, T) {
      var list = WG.Engine.unitsInArea(T.st, u.owner, areaOf(u));
      if (!list.length) return null;
      var best = list[0], bestV = WG.Engine.bAtk(best);
      for (var i = 1; i < list.length; i++) {
        var v = WG.Engine.bAtk(list[i]);
        if (v > bestV) { best = list[i]; bestV = v; }
      }
      return best;
    },
    /** 区域内生命值最高的友方单位 */
    topHp: function (u, T) {
      var list = WG.Engine.unitsInArea(T.st, u.owner, areaOf(u));
      if (!list.length) return null;
      var best = list[0], bestV = WG.Engine.bMaxHp(best);
      for (var i = 1; i < list.length; i++) {
        var v = WG.Engine.bMaxHp(list[i]);
        if (v > bestV) { best = list[i]; bestV = v; }
      }
      return best;
    }
  };

  // 宽幅卡统一升级数值：+1（实现补充，文档未给出强化形态数值）
  var UP = 1;

  // ============================================================
  // 攻击增益
  // ============================================================

  // 76 强音记号：该区域友方单位攻击力 +2
  E[76] = {
    upgradeCost: 2,
    wide: function (u, T) { return { atk: 2 + (T.self.upgraded ? UP : 0) }; }
  };

  // 77 渐强记号：攻击力 +1；若本回合尚未攻击，再 +1
  E[77] = {
    upgradeCost: 2,
    wide: function (u, T) {
      var base = 1 + (T.self.upgraded ? UP : 0);
      var bonus = T.st.turnCtx.attacked[u.owner] ? 0 : 1;
      return { atk: base + bonus };
    }
  };

  // 78 重音记号：该区域一名友方单位攻击力 +2 —— 指定为攻击力最高者
  E[78] = {
    upgradeCost: 2,
    wide: function (u, T) {
      var top = WG.EffectsUtil.topAtk(u, T);
      if (!top || top.uid !== u.uid) return { atk: 0 };
      return { atk: 2 + (T.self.upgraded ? UP : 0) };
    }
  };

  // 79 高音谱号：该区域攻击力最高的友方单位 +1 攻击力
  E[79] = {
    upgradeCost: 2,
    wide: function (u, T) {
      var top = WG.EffectsUtil.topAtk(u, T);
      if (!top || top.uid !== u.uid) return { atk: 0 };
      return { atk: 1 + (T.self.upgraded ? UP : 0) };
    }
  };

  // 80 低音谱号：该区域生命值最高的友方单位 +1 生命
  E[80] = {
    upgradeCost: 2,
    wide: function (u, T) {
      var top = WG.EffectsUtil.topHp(u, T);
      if (!top || top.uid !== u.uid) return { hp: 0 };
      return { hp: 1 + (T.self.upgraded ? UP : 0) };
    }
  };

  // 81 双八度：该区域友方单位攻击力 +2
  E[81] = {
    upgradeCost: 3,
    wide: function (u, T) { return { atk: 2 + (T.self.upgraded ? UP : 0) }; }
  };

  // 82 三连音符：最多三名友方单位各 +1 攻击力（本作每区最多 2 名，全部生效）
  E[82] = {
    upgradeCost: 2,
    wide: function (u, T) { return { atk: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // 83 琶音记号：一名友方 +1；若该区域还有另一名，后者也 +1（最多 2 名）
  E[83] = {
    upgradeCost: 2,
    wide: function (u, T) { return { atk: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // 84 华彩谱线：该区域友方 +1；若该区域只有一名单位，该单位额外 +1
  E[84] = {
    upgradeCost: 2,
    wide: function (u, T) {
      var n = WG.Engine.unitsInArea(T.st, u.owner, areaOf(u)).length;
      var add = (n === 1) ? 1 : 0;
      return { atk: 1 + add + (T.self.upgraded ? UP : 0) };
    }
  };

  // 85 合奏和弦：最多两名友方单位各 +1 攻击力
  E[85] = {
    upgradeCost: 2,
    wide: function (u, T) { return { atk: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // ============================================================
  // 防护增益
  // ============================================================

  // 86 延音线：该区域友方单位各 +1 生命
  E[86] = {
    upgradeCost: 2,
    wide: function (u, T) { return { hp: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // 87 延长记号：该区域一名友方单位本回合第一次受到的伤害 -2
  E[87] = {
    upgradeCost: 2,
    wide: function (u, T) {
      // 只保护攻击力最高的单位（"一名友方单位"）
      var top = WG.EffectsUtil.topAtk(u, T);
      if (!top || top.uid !== u.uid) return null;
      return null;    // 生命值不直接变化，伤害削减走 wideProtect
    },
    wideProtect: function (wide, victim, T) {
      var top = WG.EffectsUtil.topAtk(victim, T);
      if (!top || top.uid !== victim.uid) return null;
      if (victim.flags.__w87) return null;
      victim.flags.__w87 = true;
      return { reduce: 2 + (wide.upgraded ? UP : 0) };
    }
  };

  // 88 休止符：一名友方 +1 生命；若该单位本回合未攻击，再 +1
  E[88] = {
    upgradeCost: 2,
    wide: function (u, T) {
      var top = WG.EffectsUtil.topHp(u, T);
      if (!top || top.uid !== u.uid) return { hp: 0 };
      var bonus = u.attacked ? 0 : 1;
      return { hp: 1 + bonus + (T.self.upgraded ? UP : 0) };
    }
  };

  // 89 持续音：该区域友方单位各 +1 生命
  E[89] = {
    upgradeCost: 2,
    wide: function (u, T) { return { hp: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // 90 柔音记号：该区域一名友方单位每回合第一次受到伤害时 -1
  E[90] = {
    upgradeCost: 2,
    wideProtect: function (wide, victim, T) {
      var top = WG.EffectsUtil.topHp(victim, T);
      if (!top || top.uid !== victim.uid) return null;
      if (victim.flags.__w90) return null;
      victim.flags.__w90 = true;
      return { reduce: 1 + (wide.upgraded ? UP : 0) };
    }
  };

  // ============================================================
  // 资源 / 抽牌 / 牌库
  // ============================================================

  // 91 节拍标记：部署时恢复 1 点能量
  E[91] = {
    upgradeCost: 1,
    onDeploy: function (wide, T) { T.energy_(wide.owner, 1); }
  };

  // 92 拍号变换：部署时，若己方当前能量不超过 2，恢复 1 点能量
  E[92] = {
    upgradeCost: 1,
    onDeploy: function (wide, T) {
      if (T.energy(wide.owner) <= 2) T.energy_(wide.owner, 1);
    }
  };

  // 93 反复记号：部署时，若本回合己方触发过宽幅卡增益，抽 1 张；每回合限一次
  E[93] = {
    upgradeCost: 2,
    onDeploy: function (wide, T) {
      var tc = T.tc();
      if (tc.onceUsed.__draw93) return;
      if (tc.buffEvents.length > 0) {
        tc.onceUsed.__draw93 = true;
        T.draw(wide.owner, 1);
      }
    }
  };

  // 94 乐句分隔线：查看牌库顶 2 张，将其中 1 张置于牌库底
  E[94] = {
    upgradeCost: 2,
    onDeploy: function (wide, T) {
      var top = WG.Engine.peekTop(T.st, wide.owner, 2);
      if (top.length < 2) return;
      // 保留费用更高的一张在顶部，另一张放底（确定性规则）
      var a = WG.cardById(top[0].cardId).cost;
      var b = WG.cardById(top[1].cardId).cost;
      var toBottom = (a >= b) ? 1 : 0;
      var card = WG.Engine.putBottom(T.st, wide.owner, toBottom);
      if (card) T.log('乐句分隔线：' + WG.cardName(card.cardId) + ' 置于牌库底');
    }
  };

  // 95 终止线：部署时，若己方三个攻击区域均有友方单位，抽 1 张
  E[95] = {
    upgradeCost: 2,
    onDeploy: function (wide, T) {
      var s = wide.owner;
      var ok = true;
      for (var a = 1; a <= 3; a++) if (!WG.Engine.unitsInArea(T.st, s, a).length) ok = false;
      if (ok) T.draw(s, 1);
    }
  };

  // ============================================================
  // 跨区域协同
  // ============================================================

  // 96 跨声部连线：覆盖区域 1 与 2，两区域友方单位各 +1 攻击力
  E[96] = {
    upgradeCost: 2,
    wideCovers: function (T) { return [1, 2]; },
    wide: function (u, T) { return { atk: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // 97 交错节奏：覆盖区域 2 与 3
  E[97] = {
    upgradeCost: 2,
    wideCovers: function (T) { return [2, 3]; },
    wide: function (u, T) { return { atk: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // 98 复调谱面：覆盖区域 1 与 3
  E[98] = {
    upgradeCost: 2,
    wideCovers: function (T) { return [1, 3]; },
    wide: function (u, T) { return { atk: 1 + (T.self.upgraded ? UP : 0) }; }
  };

  // 99 总谱：指定一个攻击区域，该区域内友方单位各 +1 攻 +1 生命
  E[99] = {
    upgradeCost: 3,
    wide: function (u, T) {
      var add = T.self.upgraded ? UP : 0;
      return { atk: 1 + add, hp: 1 + add };
    }
  };

  // 100 终场合奏：三个攻击区域内各选一名友方单位，每名 +1 攻 +1 生命
  E[100] = {
    upgradeCost: 4,
    wideCovers: function (T) { return [1, 2, 3]; },
    wide: function (u, T) {
      var area = areaOf(u);
      var list = WG.Engine.unitsInArea(T.st, u.owner, area);
      if (!list.length) return null;
      // 每区只惠及攻击力最高的一名
      var best = list[0], bestV = WG.Engine.effAtk(T.st, best);
      for (var i = 1; i < list.length; i++) {
        var v = WG.Engine.effAtk(T.st, list[i]);
        if (v > bestV) { best = list[i]; bestV = v; }
      }
      if (best.uid !== u.uid) return null;
      var add = T.self.upgraded ? UP : 0;
      return { atk: 1 + add, hp: 1 + add };
    }
  };

})(typeof window !== 'undefined'
  ? (window.WG = window.WG || {})
  : (global.WG = global.WG || {}));
