/* Wide-Grid · 效果系统 —— 普通单位卡（39-75）
 *
 * 契约见 game/EFFECTS_API.md。所有效果都挂在 WG.Effects[卡牌id] 上。
 * 与 effects_core.js 同一风格：static 只读不写，一次性效果放 onDeploy。
 * 卡面没写"持续至回合结束"的数值增益按永久处理（permAtk / permHp）。
 */
(function (WG) {
  'use strict';
  WG.Effects = WG.Effects || {};
  var E = WG.Effects;
  var U = WG.EffectsUtil;

  // ============================================================
  // 本文件通用辅助
  // ============================================================

  function isEmptySlot(st, side, slot) {
    return slot >= 0 && slot < 6 && !st.players[side].units[slot];
  }

  /** 某一方跨三个区域的全部单位（targets 列选项用） */
  function allUnitsOf(T, side) {
    var out = [];
    for (var a = 1; a <= 3; a++) out = out.concat(T.units(side, a));
    return out;
  }

  function unitOpt(u, T) {
    return { uid: u.uid, label: WG.cardName(u.cardId) + ' ' + T.effAtk(u) + '/' + T.effHp(u) };
  }

  /** 从 picked 里取出所有指向单位的选项（uid 为数字的是单位） */
  function pickedUnits(T, picked) {
    var out = [];
    if (!picked) return out;
    for (var i = 0; i < picked.length; i++) {
      var it = picked[i];
      if (!it || typeof it.uid !== 'number') continue;
      var x = WG.Engine.unitByUid(T.st, it.uid);
      if (x) out.push(x);
    }
    return out;
  }

  /** 从 picked 里取出第一个指向单位的选项 */
  function pickedUnit(T, picked) {
    var list = pickedUnits(T, picked);
    return list.length ? list[0] : null;
  }

  /** 从 picked 里取出 'areaN' 形式的区域选项，返回区域号或 0 */
  function pickedArea(picked, prefix) {
    if (!picked) return 0;
    for (var i = 0; i < picked.length; i++) {
      var it = picked[i];
      if (it && typeof it.uid === 'string' && it.uid.indexOf(prefix) === 0) {
        return parseInt(it.uid.slice(prefix.length), 10) || 0;
      }
    }
    return 0;
  }

  /** picked 里是否包含某个标记选项（如 'bottom'） */
  function pickedHas(picked, tag) {
    if (!picked) return false;
    for (var i = 0; i < picked.length; i++) if (picked[i] && picked[i].uid === tag) return true;
    return false;
  }

  /** 区域内攻击力 / 生命最高的另一名友方单位 */
  function bestFriend(u, T, byHp) {
    var fs = T.friends(u);
    if (!fs.length) return null;
    var best = fs[0];
    var bv = byHp ? T.effHp(fs[0]) : T.effAtk(fs[0]);
    for (var i = 1; i < fs.length; i++) {
      var v = byHp ? T.effHp(fs[i]) : T.effAtk(fs[i]);
      if (v > bv) { best = fs[i]; bv = v; }
    }
    return best;
  }

  /** 己方本回合是否发生过「正向增益」事件（减益统一打 debuff 标记） */
  function hasPositiveBuff(T, side) {
    var ev = T.tc().buffEvents;
    for (var i = 0; i < ev.length; i++) {
      if (ev[i].side === side && (ev[i].atk > 0 || ev[i].hp > 0)) return true;
    }
    return false;
  }

  /** 本回合内的攻击力减益：统一 tag 'debuff'，避免污染「增益种类」类判断 */
  function weaken(T, u, n) {
    if (!u) return;
    T.buff(u, { atk: -n, tag: 'debuff' });
  }

  /** 敌方全部单位（targets 列选项用） */
  function foeUnitsOf(T, side) {
    var out = [], list = allUnitsOf(T, WG.foe(side));
    for (var i = 0; i < list.length; i++) out.push(unitOpt(list[i], T));
    return out;
  }

  // ============================================================
  // 同区域协同（攻击）
  // ============================================================

  // 39 首席演奏：若所在区域有其他友方单位，生命值+1。
  E[39] = {
    static: function (u, T) {
      return T.friends(u).length ? { hp: 1 } : null;
    }
  };

  // 40 合奏领奏：部署时，所在区域每有一名其他友方单位，自己获得+1攻击力，最多+2。
  E[40] = {
    onDeploy: function (u, T) {
      var n = Math.min(2, T.friends(u).length);
      if (n > 0) T.permAtk(u, n);
    }
  };

  // 41 节奏吉他：若所在区域有其他友方单位，获得+1攻击力。
  E[41] = {
    static: function (u, T) {
      return T.friends(u).length ? { atk: 1 } : null;
    }
  };

  // 42 主音吉他：若本回合部署过宽幅卡，获得+1生命。
  E[42] = {
    static: function (u, T) {
      return T.tc().playedWide[u.owner] ? { hp: 1 } : null;
    }
  };

  // 43 鼓组：部署时，所在区域另一名友方单位获得+1攻击力，持续至回合结束。
  E[43] = {
    onDeploy: function (u, T) {
      // 实现判断：区域内有多个"另一名"时，取攻击力最高者（协同收益最大）
      var f = bestFriend(u, T, false);
      if (f) T.buff(f, { atk: 1, tag: 'atk' });
    }
  };

  // 44 打击乐组：若本回合已经发生过战斗，获得+1攻击力，持续至回合结束。
  E[44] = {
    static: function (u, T) {
      return T.tc().combatHappened ? { atk: 1 } : null;
    }
  };

  // 45 铜管声部：若所在区域有宽幅卡增益，获得+1生命。
  E[45] = {
    static: function (u, T) {
      // 实现判断：判定为"该区域存在生效中的宽幅卡"（不要求它给本单位加成）
      return T.wideCount(u.owner, T.area(u)) > 0 ? { hp: 1 } : null;
    }
  };

  // 46 复调：若三个攻击区域都有友方单位，获得+1攻击力。
  E[46] = {
    static: function (u, T) {
      return T.areasOccupied(u.owner) === 3 ? { atk: 1 } : null;
    }
  };

  // 47 对位法：若相邻攻击区域均有友方单位，获得+1攻击力。
  E[47] = {
    static: function (u, T) {
      // 实现判断：与所在区域相邻的每个区域（区域 1/3 只有一个邻区）都要有友方单位
      var a = T.area(u), nb = [];
      if (a > 1) nb.push(a - 1);
      if (a < 3) nb.push(a + 1);
      if (!nb.length) return null;
      for (var i = 0; i < nb.length; i++) {
        if (T.areaCount(u.owner, nb[i]) === 0) return null;
      }
      return { atk: 1 };
    }
  };

  // 48 转调：部署时，可将自己移动到另一个空置的己方单位位置；移动后选择所在攻击区域内一名敌方单位，使其攻击力-1，持续至回合结束。
  // 内一名敌方单位，使其攻击力-1，持续至回合结束。
  E[48] = {
    // 降级说明：targets 在打出前计算，此时不知道移动后的位置，因此敌方选项列全场敌方单位，
    // onDeploy 里再按"移动后所在区域"校验，不合格则回退为该区域攻击力最高的敌方单位。
    targets: function (T) {
      var st = T.st, slots = [];
      for (var s = 0; s < 6; s++) {
        if (!st.players[T.side].units[s]) {
          slots.push({ uid: 'slot' + s, label: '单位位 ' + (s + 1) + '（区域' + WG.areaOfSlot(s) + '）' });
        }
      }
      return [
        { key: 'move', label: '选择要移动到的空位（可跳过）', optional: true, options: slots },
        { key: 'enemy', label: '选择一名敌方单位（移动后所在区域内）', optional: true, options: foeUnitsOf(T, T.side) }
      ];
    },
    onDeploy: function (u, T, picked) {
      var st = T.st;
      // 移动
      for (var i = 0; picked && i < picked.length; i++) {
        var it = picked[i];
        if (it && typeof it.uid === 'string' && it.uid.indexOf('slot') === 0) {
          var slot = parseInt(it.uid.slice(4), 10);
          if (isEmptySlot(st, u.owner, slot)) {
            var r = WG.Engine.moveUnit(st, u, slot);
            if (r.ok) T.log('转调：移动到单位位 ' + (slot + 1));
          }
          break;
        }
      }
      // 选目标：优先玩家所选，且必须在移动后区域内
      var area = T.area(u);
      var foes = T.units(WG.foe(u.owner), area);
      var target = null;
      var want = pickedUnit(T, picked);
      for (var k = 0; k < foes.length; k++) if (foes[k] === want) { target = want; break; }
      if (!target) {
        // 回退：区域内攻击力最高的敌方单位
        var best = null, bv = -1;
        for (var m = 0; m < foes.length; m++) {
          var v = T.effAtk(foes[m]);
          if (v > bv) { best = foes[m]; bv = v; }
        }
        target = best;
      }
      if (target) weaken(T, target, 1);
    }
  };

  // 49 和弦进行：部署时，所在区域每有一张生效中的宽幅卡，获得+1攻击力，最多+2。
  E[49] = {
    onDeploy: function (u, T) {
      var n = Math.min(2, T.wideCount(u.owner, T.area(u)));
      if (n > 0) T.permAtk(u, n);
    }
  };

  // 50 属七和弦：若所在区域有另一名友方单位，获得+1攻击力。
  E[50] = {
    static: function (u, T) {
      return T.friends(u).length ? { atk: 1 } : null;
    }
  };

  // 51 增六和弦：若当前能量为0，获得+1生命。
  E[51] = {
    static: function (u, T) {
      return T.energy(u.owner) === 0 ? { hp: 1 } : null;
    }
  };

  // 52 五度圈：部署时，若己方三个攻击区域均有单位，恢复1点能量。
  E[52] = {
    onDeploy: function (u, T) {
      // 实现判断：部署后的状态计数（包含自己）
      if (T.areasOccupied(u.owner) === 3) T.energy_(u.owner, 1);
    }
  };

  // 53 调式转换：部署时，选择一名友方单位，获得+1生命。
  E[53] = {
    // 实现判断："友方单位"含自己，但打出前自己还不存在，故列场上己方单位；
    // 没有可选目标时可跳过，onDeploy 回退为作用在自己身上。
    targets: function (T) {
      var opts = [];
      var list = allUnitsOf(T, T.side);
      for (var i = 0; i < list.length; i++) opts.push(unitOpt(list[i], T));
      return [{ key: 'ally', label: '选择一名友方单位（+1 生命）', optional: true, options: opts }];
    },
    onDeploy: function (u, T, picked) {
      var t = pickedUnit(T, picked) || u;
      T.permHp(t, 1);
      T.log('调式转换：' + WG.cardName(t.cardId) + ' +1 生命');
    }
  };

  // 54 节奏动机：若本回合部署了另一名单位，获得+1生命；否则选择一名敌方单位，使其下次攻击造成的伤害-1。
  // 使其下次攻击造成的伤害-1。
  E[54] = {
    // static 部分是动态的：本回合后续再部署单位也会点亮 +1 生命，符合"本回合部署了"。
    static: function (u, T) {
      return T.tc().deployCount[u.owner] >= 2 ? { hp: 1 } : null;
    },
    targets: function (T) {
      return [{ key: 'enemy', label: '选择一名敌方单位（其下次攻击伤害-1）', optional: true, options: foeUnitsOf(T, T.side) }];
    },
    onDeploy: function (u, T, picked) {
      // 本张已计入 deployCount，所以 <2 表示「本回合还没部署过别的单位」
      if (T.tc().deployCount[u.owner] >= 2) return;
      // 引擎的 u.flags.atkDmgMod：该单位下一次攻击造成的伤害 ±N，attackDamage 用完即清。
      var t = pickedUnit(T, picked);
      if (t) t.flags.atkDmgMod = (t.flags.atkDmgMod || 0) - 1;
    }
  };

  // 55 主题变奏：若本回合己方触发过两种不同增益，获得+1攻击力。
  E[55] = {
    static: function (u, T) {
      var ev = T.tc().buffEvents, tags = {}, n = 0;
      for (var i = 0; i < ev.length; i++) {
        if (ev[i].side !== u.owner) continue;
        if (!(ev[i].atk > 0 || ev[i].hp > 0)) continue;
        if (!tags[ev[i].tag]) { tags[ev[i].tag] = 1; n++; }
      }
      return n >= 2 ? { atk: 1 } : null;
    }
  };

  // 56 混音台：部署时，选择一名友方单位，攻击力+1，持续至回合结束。
  E[56] = {
    targets: function (T) {
      var opts = [];
      var list = allUnitsOf(T, T.side);
      for (var i = 0; i < list.length; i++) opts.push(unitOpt(list[i], T));
      return [{ key: 'ally', label: '选择一名友方单位（+1 攻击力）', optional: true, options: opts }];
    },
    onDeploy: function (u, T, picked) {
      // 实现判断：没有可选的场上友方时，作用在自己身上
      var t = pickedUnit(T, picked) || u;
      T.buff(t, { atk: 1, tag: 'atk' });
    }
  };

  // 57 均衡器：若所在区域有宽幅卡增益，获得+1生命。
  E[57] = {
    static: function (u, T) {
      return T.wideCount(u.owner, T.area(u)) > 0 ? { hp: 1 } : null;
    }
  };

  // 58 压缩器：每回合第一次受到的伤害减少1点。
  E[58] = {
    onBeforeDamage: function (u, n, T) {
      // 用 turnCtx.onceUsed 而不是 u.flags：u.flags 要到「该单位下个回合开始」才清，
      // 会连对手回合的那次受伤也挡住；turnCtx 每个玩家回合都是新的，才是「每回合第一次」。
      var k = '__d58_' + u.uid;
      var tc = T.tc();
      if (tc.onceUsed[k]) return null;
      tc.onceUsed[k] = true;
      return { reduce: 1 };
    }
  };

  // 59 限幅器：无特殊效果。
  E[59] = {};

  // 60 延迟效果器：部署时，选择一名友方单位，该单位下一次获得的攻击增益额外+1；并选择一名敌方单位，使其本回合下一次获得的攻击增益-1（最低为0）。
  // 并选择一名敌方单位，使其本回合下一次获得的攻击增益-1（最低为0）。
  E[60] = {
    // 用引擎的 u.flags.gainModAtk：下一次 T.buff(u,{atk:正数}) 时自动加减并清除标记。
    // 限制（引擎有意降级）：不影响宽幅卡的实时加成。
    targets: function (T) {
      var allies = [];
      var list = allUnitsOf(T, T.side);
      for (var i = 0; i < list.length; i++) allies.push(unitOpt(list[i], T));
      return [
        { key: 'ally', label: '选择一名友方单位（下一次攻击增益+1）', optional: true, options: allies },
        { key: 'enemy', label: '选择一名敌方单位（本回合下一次攻击增益-1）', optional: true, options: foeUnitsOf(T, T.side) }
      ];
    },
    onDeploy: function (u, T, picked) {
      var list = pickedUnits(T, picked);
      var mine = null, foe = null;
      for (var i = 0; i < list.length; i++) {
        if (list[i].owner === u.owner) { if (!mine) mine = list[i]; }
        else if (!foe) foe = list[i];
      }
      if (!mine) mine = u;   // 没有可选友方时作用在自己
      mine.flags.gainModAtk = (mine.flags.gainModAtk || 0) + 1;
      if (foe) foe.flags.gainModAtk = (foe.flags.gainModAtk || 0) - 1;
      T.log('延迟效果器：' + WG.cardName(mine.cardId) + ' 的下一次攻击增益+1'
        + (foe ? '，' + WG.cardName(foe.cardId) + ' 的下一次攻击增益-1' : ''));
    }
  };

  // 61 混响效果器：部署时，所在区域另一名友方单位获得+1生命。
  E[61] = {
    onDeploy: function (u, T) {
      // 实现判断：有多名"另一名"时取生命最高者
      var f = bestFriend(u, T, true);
      if (f) T.permHp(f, 1);
    }
  };

  // 62 采样器：部署时，若本回合使用过宽幅卡，抽1张牌；每回合限一次。
  E[62] = {
    onDeploy: function (u, T) {
      var tc = T.tc();
      if (tc.onceUsed.__s62) return;
      if (!tc.playedWide[u.owner]) return;
      tc.onceUsed.__s62 = true;
      T.draw(u.owner, 1);
    }
  };

  // 63 鼓机：若本回合尚未攻击，获得+1攻击力，持续至回合结束；部署时可选择一名敌方单位，使其本回合攻击力-1。
  // 单位，使其本回合攻击力-1。
  E[63] = {
    static: function (u, T) {
      return u.attacked ? null : { atk: 1 };
    },
    targets: function (T) {
      return [{ key: 'enemy', label: '选择一名敌方单位（本回合攻击力-1）', optional: true, options: foeUnitsOf(T, T.side) }];
    },
    onDeploy: function (u, T, picked) {
      var t = pickedUnit(T, picked);
      if (t) weaken(T, t, 1);
    }
  };

  // 64 音序器：部署时，若己方当前能量不少于3，恢复1点能量。
  E[64] = {
    onDeploy: function (u, T) {
      // 此时费用已支付
      if (T.energy(u.owner) >= 3) T.energy_(u.owner, 1);
    }
  };

  // 65 波形合成：若所在区域有宽幅卡增益，获得+1攻击力。
  E[65] = {
    static: function (u, T) {
      return T.wideCount(u.owner, T.area(u)) > 0 ? { atk: 1 } : null;
    }
  };

  // 66 返送监听：所在区域另一名友方单位获得+1生命。
  E[66] = {
    // 用引擎的 aura 钩子：给同区域其他友方单位 +1 生命（引擎会跳过自己，不含自己）。
    aura: function (target, self) {
      return { hp: 1 };
    }
  };

  // 67 监听耳机：部署时，查看自己牌库顶的1张牌，可选择将其置于牌库底；然后选择一个敌方攻击区域，该区域内一名敌方单位本回合不能获得宽幅卡增益。
  // 敌方攻击区域，该区域内一名敌方单位本回合不能获得宽幅卡增益。
  E[67] = {
    // 用引擎的 u.flags.noWide：wideAtkFor / wideHpFor 已直接拦截。
    // 清空时机是该单位自己的下个回合开始，所以比卡面的"本回合"稍长（引擎有意如此）。
    targets: function (T) {
      var out = [];
      var top = WG.Engine.peekTop(T.st, T.side, 1);
      if (top.length) {
        out.push({
          key: 'bottom',
          label: '牌库顶是「' + WG.cardName(top[0].cardId) + '」，可置于牌库底',
          optional: true,
          options: [{ uid: 'bottom', label: '置于牌库底' }]
        });
      }
      out.push({
        key: 'enemy',
        label: '选择一名敌方单位（本回合不能获得宽幅卡增益）',
        optional: true,
        options: foeUnitsOf(T, T.side)
      });
      return out;
    },
    onDeploy: function (u, T, picked) {
      if (pickedHas(picked, 'bottom')) {
        var card = WG.Engine.putBottom(T.st, u.owner, 0);
        if (card) T.log('监听耳机：' + WG.cardName(card.cardId) + ' 置于牌库底');
      }
      var t = pickedUnit(T, picked);
      if (!t) return;
      t.flags.noWide = true;
      WG.Engine._sync(T.st);
      T.log('监听耳机：' + WG.cardName(t.cardId) + ' 本回合不能获得宽幅卡增益');
    }
  };

  // 68 话筒前级：部署时，选择一名友方单位，攻击力+1，持续至回合结束。
  E[68] = {
    targets: function (T) {
      var opts = [];
      var list = allUnitsOf(T, T.side);
      for (var i = 0; i < list.length; i++) opts.push(unitOpt(list[i], T));
      return [{ key: 'ally', label: '选择一名友方单位（+1 攻击力）', optional: true, options: opts }];
    },
    onDeploy: function (u, T, picked) {
      var t = pickedUnit(T, picked) || u;
      T.buff(t, { atk: 1, tag: 'atk' });
    }
  };

  // 69 电容麦克风：若本回合部署过宽幅卡，获得+1生命；部署时选择一名敌方单位，使其本回合受到的下一次伤害+1。
  // 使其本回合受到的下一次伤害+1。
  E[69] = {
    static: function (u, T) {
      return T.tc().playedWide[u.owner] ? { hp: 1 } : null;
    },
    targets: function (T) {
      return [{ key: 'enemy', label: '选择一名敌方单位（其下一次受到的伤害+1）', optional: true, options: foeUnitsOf(T, T.side) }];
    },
    onDeploy: function (u, T, picked) {
      // 引擎的 u.flags.dmgPlus：该单位下一次受到的伤害 +N，dealDamage 用完即清。
      var t = pickedUnit(T, picked);
      if (t) t.flags.dmgPlus = (t.flags.dmgPlus || 0) + 1;
    }
  };

  // 70 舞台返送：若所在区域有其他友方单位，获得+1生命。
  E[70] = {
    static: function (u, T) {
      return T.friends(u).length ? { hp: 1 } : null;
    }
  };

  // 71 灯光节拍：部署时，若三个攻击区域中至少有两个有友方单位，获得+1攻击力。
  E[71] = {
    onDeploy: function (u, T) {
      if (T.areasOccupied(u.owner) >= 2) T.permAtk(u, 1);
    }
  };

  // 72 开场序曲：若这是本回合部署的第一张卡，获得+1生命；部署时选择一个敌方攻击区域，该区域内单位本回合攻击力-1。
  // 区域，该区域内单位本回合攻击力-1。
  E[72] = {
    static: function (u, T) {
      return T.tc().deployCount[u.owner] === 1 ? { hp: 1 } : null;
    },
    targets: function (T) {
      var opts = [], foe = WG.foe(T.side);
      for (var a = 1; a <= 3; a++) {
        if (T.areaCount(foe, a) > 0) opts.push({ uid: 'area' + a, label: '区域' + a });
      }
      return [{ key: 'area', label: '选择一个敌方攻击区域（其单位本回合攻击力-1）', optional: true, options: opts }];
    },
    onDeploy: function (u, T, picked) {
      if (T.tc().deployCount[u.owner] !== 1) {
        // 不是本回合第一张：仍可执行区域减益
      }
      var area = pickedArea(picked, 'area');
      if (!area) return;
      var list = T.units(WG.foe(u.owner), area);
      for (var i = 0; i < list.length; i++) weaken(T, list[i], 1);
      T.log('开场序曲：区域' + area + ' 的敌方单位本回合攻击力-1');
    }
  };

  // 73 间奏：部署时，若本回合尚未部署其他单位，恢复1点能量。
  E[73] = {
    onDeploy: function (u, T) {
      // 本张已计入 deployCount，===1 表示它本回合是第一张
      if (T.tc().deployCount[u.owner] === 1) T.energy_(u.owner, 1);
    }
  };

  // 74 终曲：若己方三个攻击区域均有单位，获得+1攻击力。
  E[74] = {
    static: function (u, T) {
      return T.areasOccupied(u.owner) === 3 ? { atk: 1 } : null;
    }
  };

  // 75 安可：部署时，若本回合己方单位获得过增益，获得+1生命；否则选择一名敌方单位，使其本回合攻击力-1。
  // 使其本回合攻击力-1。
  E[75] = {
    targets: function (T) {
      return [{ key: 'enemy', label: '选择一名敌方单位（本回合攻击力-1）', optional: true, options: foeUnitsOf(T, T.side) }];
    },
    onDeploy: function (u, T, picked) {
      if (hasPositiveBuff(T, u.owner)) {
        T.permHp(u, 1);
        return;
      }
      var t = pickedUnit(T, picked);
      if (t) weaken(T, t, 1);
    }
  };

})(typeof window !== 'undefined'
  ? (window.WG = window.WG || {})
  : (global.WG = global.WG || {}));
