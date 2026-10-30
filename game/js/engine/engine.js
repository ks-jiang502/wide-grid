/* Wide-Grid · 核心规则引擎（纯逻辑，不依赖 DOM）
 * 严格实现《具体游戏流程｜测试版 V0.2》
 *
 * 生命模型：单位只有 maxHp（有效最大生命）与 wounds（累计伤害）。
 *   有效最大生命 = base.maxHp + staticHp + buffHp
 *   当前生命     = 有效最大生命 - wounds
 * 因此「+1生命」= maxHp 提升 = 当前生命同步提升；「受到N伤害」= wounds += N。
 *   伤害在回合结束时清除（wounds 归零），对应文档「本测试暂定」条。
 */
(function (WG) {
  'use strict';

  var C = WG.C;

  var uidSeq = 1;
  function nextUid() { return uidSeq++; }

  // ============================================================
  // 实例构造
  // ============================================================
  function makeUnit(st, side, cardId, slot) {
    var card = WG.cardById(cardId);
    return {
      uid: nextUid(),
      kind: 'unit',
      cardId: cardId,
      owner: side,
      slot: slot,
      atk: card.atk,          // 基础攻击力（含永久加成）
      maxHp: card.hp,         // 基础最大生命（含永久加成）
      wounds: 0,              // 累计伤害
      exhausted: false,       // 横置/疲惫
      attacked: false,        // 本回合已攻击
      buffs: [],              // {atk,hp,until:'turnEnd',tag,src}
      staticAtk: 0,           // 由静态效果推导
      staticHp: 0,
      flags: {},              // 每回合重置的临时标记
      deployedTurn: st.turnCount,
      name: card.name
    };
  }

  function makeWide(st, side, cardId, slotList) {
    var card = WG.cardById(cardId);
    return {
      uid: nextUid(),
      kind: 'wide',
      cardId: cardId,
      owner: side,
      slots: slotList.slice(),   // 占据的增益槽
      areas: slotList.slice(),   // 生效区域（当前：槽号 == 区域号）
      locked: false,             // 被定义牌锁定 -> 不提供增益
      upgraded: false,           // 强化形态
      flags: {},
      deployedTurn: st.turnCount,
      name: card.name
    };
  }

  // ============================================================
  // 数值读取
  // ============================================================
  function sumBuffs(u, key) {
    var s = 0;
    for (var i = 0; i < u.buffs.length; i++) s += (u.buffs[i][key] || 0);
    return s;
  }

  function effAtk(st, u) {
    if (!u || u.kind !== 'unit') return 0;
    return Math.max(0, u.atk + u.staticAtk + sumBuffs(u, 'atk') + wideAtkFor(st, u));
  }

  /** 不含宽幅卡加成的基础攻击力。
   *  宽幅卡效果里要比较攻击力时用这个 —— 否则「攻击力最高的单位」会和
   *  宽幅卡加成互相指涉，形成无限递归（effAtk → wide → topAtk → effAtk → …）。
   */
  function bAtk(u) {
    if (!u || u.kind !== 'unit') return 0;
    return Math.max(0, u.atk + u.staticAtk + sumBuffs(u, 'atk'));
  }

  function bMaxHp(u) {
    if (!u || u.kind !== 'unit') return 0;
    return Math.max(0, u.maxHp + u.staticHp + sumBuffs(u, 'hp'));
  }

  function effMaxHp(st, u) {
    if (!u || u.kind !== 'unit') return 0;
    return Math.max(0, u.maxHp + u.staticHp + sumBuffs(u, 'hp') + wideHpFor(st, u));
  }

  function effHp(st, u) {
    if (!u) return 0;
    return Math.max(0, effMaxHp(st, u) - u.wounds);
  }

  function isAlive(st, u) { return effHp(st, u) > 0; }

  /** 单位所在区域某方所有单位 */
  function unitsInArea(st, side, area) {
    var out = [];
    var p = st.players[side];
    for (var i = 0; i < C.UNIT_SLOTS; i++) {
      var u = p.units[i];
      if (u && WG.areaOfSlot(u.slot) === area) out.push(u);
    }
    return out;
  }

  function unitByUid(st, uid) {
    for (var s = 0; s < 2; s++) {
      var arr = st.players[s].units;
      for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].uid === uid) return arr[i];
    }
    return null;
  }

  function allUnits(st) {
    var out = [];
    for (var s = 0; s < 2; s++) {
      var arr = st.players[s].units;
      for (var i = 0; i < arr.length; i++) if (arr[i]) out.push(arr[i]);
    }
    return out;
  }

  /** 作用于某区域的宽幅卡（该方） */
  function widesInArea(st, side, area) {
    var out = [];
    var w = st.players[side].wides;
    for (var k = 1; k <= C.AREAS; k++) {
      var wide = w[k];
      if (wide && wide.areas.indexOf(area) >= 0 && !wide.locked) out.push(wide);
    }
    // 去重（跨区卡占多槽）
    var seen = {}, uniq = [];
    for (var i = 0; i < out.length; i++) {
      if (!seen[out[i].uid]) { seen[out[i].uid] = 1; uniq.push(out[i]); }
    }
    return uniq;
  }

  /** 宽幅卡加成计算的递归深度。
   *  宽幅卡的 wide() 里若读了 effAtk/effMaxHp，会重新进入这里；
   *  这个计数器让第二层起直接返回 0，把递归掐断（否则栈溢出）。
   */
  var wideDepth = 0;

  /** 宽幅卡提供的攻击力加成（由 effects 定义；默认 0） */
  function wideAtkFor(st, u) {
    // 卡 67 监听耳机等：本回合被禁止获得宽幅卡增益
    if (u.flags && u.flags.noWide) return 0;
    if (wideDepth > 0) return 0;
    wideDepth++;
    try {
      return wideAtkSum(st, u);
    } finally {
      wideDepth--;
    }
  }

  function wideAtkSum(st, u) {
    var list = widesInArea(st, u.owner, WG.areaOfSlot(u.slot));
    var s = 0;
    for (var i = 0; i < list.length; i++) {
      var e = WG.Effects[list[i].cardId];
      if (e && typeof e.wide === 'function') {
        var r = e.wide(u, ctx(st, list[i].owner, list[i], list[i])) || null;
        if (r) s += (r.atk || 0);
      }
    }
    return s;
  }

  function wideHpFor(st, u) {
    if (u.flags && u.flags.noWide) return 0;
    if (wideDepth > 0) return 0;
    wideDepth++;
    try {
      return wideHpSum(st, u);
    } finally {
      wideDepth--;
    }
  }

  function wideHpSum(st, u) {
    var list = widesInArea(st, u.owner, WG.areaOfSlot(u.slot));
    var s = 0;
    for (var i = 0; i < list.length; i++) {
      var e = WG.Effects[list[i].cardId];
      if (e && typeof e.wide === 'function') {
        var r = e.wide(u, ctx(st, list[i].owner, list[i], list[i])) || null;
        if (r) s += (r.hp || 0);
      }
    }
    return s;
  }

  /** 该单位是否吃到任何宽幅卡增益（供卡牌条件判断） */
  function hasWideBuff(st, u) {
    return wideAtkFor(st, u) !== 0 || wideHpFor(st, u) !== 0;
  }

  // ============================================================
  // 静态效果重算
  // ============================================================
  function applyStatics(st) {
    var list = allUnits(st);
    // 1) 每个单位自己的 static
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      var e = WG.Effects[u.cardId];
      var atk = 0, hp = 0;
      if (e && typeof e.static === 'function') {
        var r = e.static(u, ctx(st, u.owner, u, u));
        if (r) { atk = r.atk || 0; hp = r.hp || 0; }
      }
      u.staticAtk = atk;
      u.staticHp = hp;
    }
    // 2) 同区域光环（aura）：别人给我加，我自己不吃自己的光环
    for (var k = 0; k < list.length; k++) {
      var t = list[k];
      var mates = unitsInArea(st, t.owner, WG.areaOfSlot(t.slot));
      for (var j = 0; j < mates.length; j++) {
        var m = mates[j];
        if (m.uid === t.uid) continue;
        var em = WG.Effects[m.cardId];
        if (em && typeof em.aura === 'function') {
          var ra = em.aura(t, m, ctx(st, m.owner, m, m));
          if (ra) { t.staticAtk += (ra.atk || 0); t.staticHp += (ra.hp || 0); }
        }
      }
    }
  }

  /** 状态同步：重算静态 + 清理已死亡单位以外的收尾 */
  function sync(st) { applyStatics(st); }

  // ============================================================
  // 效果上下文（供 effects.js 使用）
  // ============================================================
  function ctx(st, side, card, self) {
    var E = {
      st: st,
      side: side,
      card: card,
      self: self,
      // --- 读 ---
      area: function (u) { return WG.areaOfSlot(u.slot); },
      units: function (s, area) { return unitsInArea(st, s, area); },
      myArea: function (u) { return unitsInArea(st, u.owner, WG.areaOfSlot(u.slot)); },
      friends: function (u) {
        var out = unitsInArea(st, u.owner, WG.areaOfSlot(u.slot)).filter(function (x) { return x.uid !== u.uid; });
        return out;
      },
      enemies: function (u) {
        return unitsInArea(st, WG.foe(u.owner), WG.areaOfSlot(u.slot));
      },
      enemyOf: function (s) { return st.players[WG.foe(s)]; },
      energy: function (s) { return st.players[s].energy; },
      hp: function (s) { return st.players[s].hp; },
      effAtk: function (u) { return effAtk(st, u); },
      effHp: function (u) { return effHp(st, u); },
      hasWide: function (u) { return hasWideBuff(st, u); },
      wideCount: function (s, area) { return widesInArea(st, s, area).length; },
      areaCount: function (s, area) { return unitsInArea(st, s, area).length; },
      areasOccupied: function (s) {
        var n = 0;
        for (var a = 1; a <= C.AREAS; a++) if (unitsInArea(st, s, a).length) n++;
        return n;
      },
      tc: function () { return st.turnCtx; },
      // --- 写 ---
      /** 临时增益（持续至回合结束）
       *  u.flags.gainModAtk：一次性修饰「下一次攻击增益」的数值（卡 60 延迟效果器），
       *  施加后立即清除。只作用于增益事件，不影响宽幅卡的实时加成。
       */
      buff: function (u, o) {
        if (!u || !isAlive(st, u)) return;
        var atk = o.atk || 0;
        var hp = o.hp || 0;
        if (atk > 0 && u.flags && u.flags.gainModAtk) {
          atk = Math.max(0, atk + u.flags.gainModAtk);
          delete u.flags.gainModAtk;
        }
        u.buffs.push({ atk: atk, hp: hp, until: 'turnEnd', tag: o.tag || 'card', src: u.uid });
        if (atk) st.turnCtx.buffEvents.push({ side: u.owner, tag: o.tag || 'atk', atk: atk });
        if (hp) st.turnCtx.buffEvents.push({ side: u.owner, tag: o.tag || 'hp', hp: hp });
        applyStatics(st);
      },
      /** 永久攻击力 */
      permAtk: function (u, n) { if (u) { u.atk += n; applyStatics(st); } },
      /** 永久生命（当前与上限同步上升） */
      permHp: function (u, n) { if (u) { u.maxHp += n; applyStatics(st); } },
      /** 治疗：减少累计伤害 */
      heal: function (u, n) { if (u) { u.wounds = Math.max(0, u.wounds - n); } },
      /** 直接造成伤害（走伤害减免） */
      hurt: function (u, n) { dealDamage(st, u, n, {}); },
      /** 获得能量 */
      energy_: function (s, n) {
        var p = st.players[s];
        var before = p.energy;
        p.energy = Math.min(p.maxEnergy, p.energy + n);
        if (p.energy > before) st.turnCtx.energyGained[s] = true;
      },
      /** 抽牌 */
      draw: function (s, n) { drawCards(st, s, n); },
      log: function (m) { addLog(st, m); },
      // --- 便捷 ---
      firstTime: function (u, key) {
        if (u.flags[key]) return false;
        u.flags[key] = true;
        return true;
      }
    };
    return E;
  }

  // ============================================================
  // 伤害
  // ============================================================
  function dealDamage(st, u, n, opts) {
    if (!u || n <= 0) return 0;
    var reduce = 0;
    var e = WG.Effects[u.cardId];
    // 单位自身的伤害削减（每回合第一次受到伤害时 -N）
    if (e && typeof e.onBeforeDamage === 'function') {
      var r = e.onBeforeDamage(u, n, ctx(st, u.owner, u, u));
      if (r && r.reduce) reduce += r.reduce;
    }
    // 同区域友方单位的「保护他人」效果（如 连音线 / 低音声部）
    var friends = unitsInArea(st, u.owner, WG.areaOfSlot(u.slot));
    for (var fi = 0; fi < friends.length; fi++) {
      var f = friends[fi];
      if (f.uid === u.uid) continue;
      var ef = WG.Effects[f.cardId];
      if (ef && typeof ef.protect === 'function') {
        var pr = ef.protect(f, u, ctx(st, f.owner, f, f));
        if (pr && pr.reduce) reduce += pr.reduce;
      }
    }
    // 宽幅卡的伤害削减（如 延长记号 / 柔音记号）
    var wl = widesInArea(st, u.owner, WG.areaOfSlot(u.slot));
    for (var wi = 0; wi < wl.length; wi++) {
      var ew = WG.Effects[wl[wi].cardId];
      if (ew && typeof ew.wideProtect === 'function') {
        var wr = ew.wideProtect(wl[wi], u, ctx(st, wl[wi].owner, wl[wi], wl[wi]));
        if (wr && wr.reduce) reduce += wr.reduce;
      }
    }
    var final = Math.max(0, n - reduce);
    // 一次性「下一次受到伤害 +N」（卡 69 电容麦克风），在减免之后追加，用完即清
    if (u.flags && u.flags.dmgPlus) {
      final += u.flags.dmgPlus;
      delete u.flags.dmgPlus;
    }
    u.wounds += final;
    addLog(st, WG.cardName(u.cardId) + ' 受到 ' + final + ' 点伤害');
    if (e && typeof e.onDamaged === 'function') e.onDamaged(u, final, ctx(st, u.owner, u, u));
    return final;
  }

  // ============================================================
  // 抽牌 / 牌库
  // ============================================================
  function drawCards(st, side, n) {
    var p = st.players[side];
    for (var i = 0; i < n; i++) {
      if (p.deck.length === 0) {
        // 文档：牌库不足以抽牌时，抽牌失败的玩家立即判负
        st.over = { loser: side, reason: '牌库耗尽，抽牌失败' };
        addLog(st, p.name + ' 牌库耗尽，抽牌失败 —— 判负');
        return false;
      }
      var card = p.deck.pop();
      p.hand.push(card);
      addLog(st, p.name + ' 抽到 ' + WG.cardName(card.cardId));
    }
    return true;
  }

  // ============================================================
  // 日志
  // ============================================================
  function addLog(st, msg) {
    st.log.push({ turn: st.turnCount, phase: st.phase, side: st.active, text: msg });
    if (st.log.length > 400) st.log.shift();
  }

  // ============================================================
  // 部署
  // ============================================================
  function validUnitSlots(st, side) {
    var out = [];
    for (var i = 0; i < C.UNIT_SLOTS; i++) if (!st.players[side].units[i]) out.push(i);
    return out;
  }

  /** 卡牌占据的增益槽集合（宽幅卡） */
  function wideAreaSet(st, side, cardId) {
    var e = WG.Effects[cardId];
    if (e && typeof e.wideAreas === 'function') return e.wideAreas(ctx(st, side, WG.cardById(cardId), null));
    return [1, 2, 3];   // 默认三区都可
  }

  /** 合法增益槽：返回可选的槽位数组（每个候选是一组槽） */
  function validWideSlots(st, side, cardId) {
    var card = WG.cardById(cardId);
    var e = WG.Effects[cardId];
    var w = st.players[side].wides;
    var out = [];
    // 跨区卡：由 effects 指定覆盖区域集合
    if (e && typeof e.wideCovers === 'function') {
      var cover = e.wideCovers(ctx(st, side, card, null));  // [1,2] 等
      var allFree = true;
      for (var i = 0; i < cover.length; i++) if (w[cover[i]]) allFree = false;
      if (allFree) out.push(cover.slice());
      return out;
    }
    // 单区卡：任选一个空槽
    for (var a = 1; a <= C.AREAS; a++) if (!w[a]) out.push([a]);
    return out;
  }

  function canUpgrade(st, side, area) {
    var wide = st.players[side].wides[area];
    if (!wide) return { ok: false, reason: '该区域没有宽幅卡' };
    if (wide.upgraded) return { ok: false, reason: '已是强化形态' };
    var e = WG.Effects[wide.cardId];
    if (!e || !e.upgradeCost) return { ok: false, reason: '该卡不可升级' };
    if (st.players[side].energy < e.upgradeCost) return { ok: false, reason: '能量不足' };
    return { ok: true, cost: e.upgradeCost };
  }

  /**
   * 检查手牌是否可打出。
   * 返回 { ok, reason, needSlots, targets }
   *   needSlots: 合法位置数组（unit: [slot...]；wide: [[areas]...]）
   *   targets:   需要玩家选择的目标声明数组
   */
  function canPlay(st, side, handIdx) {
    if (st.over) return { ok: false, reason: '对局已结束' };
    if (st.active !== side) return { ok: false, reason: '不是你的回合' };
    if (st.phase !== 'deploy') return { ok: false, reason: '只在部署阶段可以打出卡牌' };
    var p = st.players[side];
    var inst = p.hand[handIdx];
    if (!inst) return { ok: false, reason: '手牌不存在' };
    var card = WG.cardById(inst.cardId);
    if (p.energy < card.cost) return { ok: false, reason: '能量不足（需要 ' + card.cost + '）' };

    if (card.type === 'unit') {
      var slots = validUnitSlots(st, side);
      if (!slots.length) return { ok: false, reason: '没有空余的单位位置' };
      var e = WG.Effects[card.id] || {};
      var tg = (typeof e.targets === 'function') ? e.targets(ctx(st, side, card, null)) : [];
      // 过滤：目标可选集合为空则该卡不能打
      for (var i = 0; i < tg.length; i++) {
        if (!tg[i].optional && (!tg[i].options || tg[i].options.length === 0)) {
          return { ok: false, reason: '没有合法目标：' + (tg[i].label || '') };
        }
      }
      return { ok: true, needSlots: slots, targets: tg, type: 'unit' };
    }

    // 宽幅卡
    var wslots = validWideSlots(st, side, card.id);
    if (!wslots.length) return { ok: false, reason: '没有空余的增益位置' };
    var ew = WG.Effects[card.id] || {};
    var tw = (typeof ew.targets === 'function') ? ew.targets(ctx(st, side, card, null)) : [];
    for (var j = 0; j < tw.length; j++) {
      if (!tw[j].optional && (!tw[j].options || tw[j].options.length === 0)) {
        return { ok: false, reason: '没有合法目标：' + (tw[j].label || '') };
      }
    }
    return { ok: true, needSlots: wslots, targets: tw, type: 'wide' };
  }

  /**
   * 打出卡牌。
   * choice = { slot: number, wideSlots: [areas], targets: [value...] }
   */
  function play(st, side, handIdx, choice) {
    var chk = canPlay(st, side, handIdx);
    if (!chk.ok) return chk;
    choice = choice || {};
    var p = st.players[side];
    var inst = p.hand[handIdx];
    var card = WG.cardById(inst.cardId);

    // 校验位置
    if (card.type === 'unit') {
      if (choice.slot === undefined || chk.needSlots.indexOf(choice.slot) < 0) {
        return { ok: false, reason: '非法单位位置' };
      }
    } else {
      var ws = choice.wideSlots || chk.needSlots[0];
      var found = null;
      for (var i = 0; i < chk.needSlots.length; i++) {
        if (chk.needSlots[i].join(',') === (ws || []).join(',')) { found = ws; break; }
      }
      if (!found) return { ok: false, reason: '非法增益位置' };
      choice.wideSlots = found;
    }

    // 支付费用
    p.energy -= card.cost;
    p.hand.splice(handIdx, 1);

    var E = ctx(st, side, card, null);

    if (card.type === 'unit') {
      var u = makeUnit(st, side, card.id, choice.slot);
      p.units[choice.slot] = u;
      E.self = u;
      applyStatics(st);
      st.turnCtx.deployCount[side] += 1;
      addLog(st, p.name + ' 部署 ' + card.name + '（区域' + WG.areaOfSlot(choice.slot) + '）');
      var e = WG.Effects[card.id];
      if (e && typeof e.onDeploy === 'function') {
        e.onDeploy(u, E, choice.targets || []);
        applyStatics(st);
      }
      // 部署后清理死亡
      cleanupDead(st);
      sync(st);
      return { ok: true, unit: u };
    }

    // 宽幅卡
    var wide = makeWide(st, side, card.id, choice.wideSlots);
    for (var k = 0; k < choice.wideSlots.length; k++) st.players[side].wides[choice.wideSlots[k]] = wide;
    E.self = wide;
    st.turnCtx.playedWide[side] = true;
    st.turnCtx.playedWideIds[side].push(card.id);
    addLog(st, p.name + ' 部署宽幅卡 ' + card.name + '（区域' + choice.wideSlots.join('+') + '）');
    var ew = WG.Effects[card.id];
    if (ew && typeof ew.onDeploy === 'function') {
      ew.onDeploy(wide, E, choice.targets || []);
    }
    sync(st);
    return { ok: true, wide: wide };
  }

  // ============================================================
  // 战斗
  // ============================================================
  function canAttack(st, u) {
    if (!u || u.kind !== 'unit') return false;
    if (st.active !== u.owner) return false;
    if (st.phase !== 'combat') return false;
    if (u.attacked || u.exhausted) return false;
    if (!isAlive(st, u)) return false;
    return true;
  }

  /**
   * 合法攻击目标。
   * v0.3 规则变更：直击玩家的条件从「本攻击区没有敌方单位」收紧为
   * 「对方六个普通单位位置全部为空」。对方只要在任意一区还留着单位，
   * 就不能绕过它去打血——清空对面场面成了直击的前置目标。
   * 同区有敌方单位时正常互击；同区空但别区有单位时，本单位本回合无合法目标。
   */
  function legalAttackTargets(st, u) {
    var area = WG.areaOfSlot(u.slot);
    var foeSide = WG.foe(u.owner);
    var foes = unitsInArea(st, foeSide, area);
    var foeTotal = 0;
    for (var a = 1; a <= WG.C.AREAS; a++) foeTotal += unitsInArea(st, foeSide, a).length;
    return { units: foes, face: foeTotal === 0, area: area };
  }

  /**
   * 本次攻击实际造成的伤害（含一次性修饰）。
   * u.flags.atkDmgMod：下一次攻击造成的伤害 ±N，用完即清（卡 54 的「使其下次攻击伤害-1」）。
   */
  function attackDamage(st, u) {
    var n = effAtk(st, u);
    if (u.flags && u.flags.atkDmgMod) {
      n = Math.max(0, n + u.flags.atkDmgMod);
      delete u.flags.atkDmgMod;
    }
    return n;
  }

  /**
   * 发起一次攻击。伤害只记录到 pending，区域结算时才统一判定破坏。
   * target = { type:'unit', uid } | { type:'face' }
   */
  function attack(st, side, uid, target) {
    if (st.over) return { ok: false, reason: '对局已结束' };
    var u = unitByUid(st, uid);
    if (!u || u.owner !== side) return { ok: false, reason: '单位不存在' };
    if (!canAttack(st, u)) return { ok: false, reason: '该单位本回合不能攻击' };
    var area = WG.areaOfSlot(u.slot);
    var legal = legalAttackTargets(st, u);
    var pd = st.pending[area] || (st.pending[area] = { damage: {}, face: {} });

    if (legal.face) {
      if (target && target.type === 'unit') return { ok: false, reason: '对方主卡区域已空，只能直接攻击玩家' };
      var fa = attackDamage(st, u);
      pd.face[u.owner] = (pd.face[u.owner] || 0) + fa;
      addLog(st, WG.cardName(u.cardId) + ' 直击 ' + st.players[WG.foe(side)].name + '（' + fa + ' 点）');
    } else {
      if (!target || target.type !== 'unit') {
        return {
          ok: false,
          reason: legal.units.length
            ? '必须选择该区域的敌方单位'
            : '对方主卡区域仍有单位，本区域没有可攻击目标'
        };
      }
      var t = unitByUid(st, target.uid);
      if (!t || legal.units.indexOf(t) < 0) return { ok: false, reason: '非法目标' };
      var a1 = attackDamage(st, u), a2 = effAtk(st, t);
      pd.damage[t.uid] = (pd.damage[t.uid] || 0) + a1;
      pd.damage[u.uid] = (pd.damage[u.uid] || 0) + a2;
      addLog(st, WG.cardName(u.cardId) + ' 攻击 ' + WG.cardName(t.cardId) + '（互击 ' + a1 + ' / ' + a2 + '）');
    }

    u.attacked = true;
    u.exhausted = true;

    // 攻击方效果
    var e = WG.Effects[u.cardId];
    if (e && typeof e.onAttack === 'function') e.onAttack(u, ctx(st, u.owner, u, u));

    st.turnCtx.attacked[side] = true;
    st.turnCtx.combatHappened = true;

    // 该区域己方若已无可攻击单位，自动结算该区域
    var remain = unitsInArea(st, side, area).filter(function (x) { return !x.attacked && isAlive(st, x); });
    if (!remain.length) resolveArea(st, area);
    return { ok: true };
  }

  /** 结算某区域：统一应用伤害并处理破坏 */
  function resolveArea(st, area) {
    var pd = st.pending[area];
    if (!pd) return;
    st.pending[area] = null;

    // 1) 玩家伤害（生命值下限 0，不显示负数）
    for (var s = 0; s < 2; s++) {
      var faceDmg = pd.face[s];
      if (faceDmg) {
        var victim = st.players[WG.foe(s)];
        victim.hp = Math.max(0, victim.hp - faceDmg);
        addLog(st, victim.name + ' 生命 -' + faceDmg);
      }
    }
    // 2) 单位伤害（同时结算）
    var deadList = [];
    for (var uid in pd.damage) {
      var u = unitByUid(st, +uid);
      if (!u) continue;
      dealDamage(st, u, pd.damage[uid], { batch: true });
    }
    // 3) 统一检查破坏
    var list = allUnits(st);
    for (var i = 0; i < list.length; i++) {
      if (effHp(st, list[i]) <= 0) deadList.push(list[i]);
    }
    for (var j = 0; j < deadList.length; j++) destroyUnit(st, deadList[j]);
    sync(st);
    checkOver(st);
  }

  function destroyUnit(st, u) {
    var p = st.players[u.owner];
    if (p.units[u.slot] !== u) return;
    p.units[u.slot] = null;
    p.discard.push({ cardId: u.cardId });
    addLog(st, '💀 ' + WG.cardName(u.cardId) + ' 被破坏离场');
    var e = WG.Effects[u.cardId];
    if (e && typeof e.onDestroy === 'function') e.onDestroy(u, ctx(st, u.owner, u, u));
  }

  function cleanupDead(st) {
    var list = allUnits(st);
    for (var i = 0; i < list.length; i++) {
      if (effHp(st, list[i]) <= 0) destroyUnit(st, list[i]);
    }
    checkOver(st);
  }

  // ============================================================
  // 位置移动 / 牌库操作（供 滑音、转调、监听耳机、乐句分隔线 使用）
  // ============================================================
  /** 把单位移动到另一个空的己方单位位置 */
  function moveUnit(st, u, newSlot) {
    if (!u || u.kind !== 'unit') return { ok: false, reason: '非单位' };
    var p = st.players[u.owner];
    if (newSlot < 0 || newSlot >= C.UNIT_SLOTS) return { ok: false, reason: '非法位置' };
    if (p.units[newSlot]) return { ok: false, reason: '目标位置已被占据' };
    var old = u.slot;
    p.units[old] = null;
    u.slot = newSlot;
    p.units[newSlot] = u;
    applyStatics(st);
    return { ok: true, from: old, to: newSlot };
  }

  /** 查看牌库顶 n 张（返回卡牌实例数组，不改动牌库） */
  function peekTop(st, side, n) {
    var p = st.players[side];
    var out = [];
    for (var i = 0; i < n && i < p.deck.length; i++) out.push(p.deck[p.deck.length - 1 - i]);
    return out;
  }

  /** 把牌库顶第 offset 张放到牌库底 */
  function putBottom(st, side, offset) {
    var p = st.players[side];
    var idx = p.deck.length - 1 - (offset || 0);
    if (idx < 0 || idx >= p.deck.length) return null;
    var card = p.deck.splice(idx, 1)[0];
    p.deck.unshift(card);   // 牌库 0 位为底，末尾为顶
    return card;
  }

  /** 升级宽幅卡为强化形态 */
  function upgradeWide(st, side, area) {
    var chk = canUpgrade(st, side, area);
    if (!chk.ok) return chk;
    if (st.phase !== 'deploy') return { ok: false, reason: '升级只能在自己的部署阶段进行' };
    var wide = st.players[side].wides[area];
    st.players[side].energy -= chk.cost;
    wide.upgraded = true;
    addLog(st, st.players[side].name + ' 将 ' + WG.cardName(wide.cardId) + ' 升级为强化形态（-' + chk.cost + ' 能量）');
    var e = WG.Effects[wide.cardId];
    if (e && typeof e.upgrade === 'function') e.upgrade(wide, ctx(st, side, wide, wide));
    sync(st);
    return { ok: true };
  }


  /**
   * 胜负检查。
   * v0.3：双方在同一时点同时满足失败条件时判平局（不额外指定胜方）。
   */
  /**
   * v0.3 新增：升级后的宽幅卡可以在自己的部署阶段移动。
   * 只列出「覆盖集合大小与当前相同、且目标区全部空着」的组合；
   * 移动后按新位置重新计算增益范围，覆盖区没有友方单位时仍留场但不生效。
   */
  function wideMoveTargets(st, side, fromArea) {
    var p = st.players[side];
    var w = p.wides[fromArea];
    if (!w) return [];
    var size = (w.areas && w.areas.length) ? w.areas.length : 1;
    var combos = size === 1 ? [[1], [2], [3]]
      : size === 2 ? [[1, 2], [2, 3], [1, 3]]
        : [[1, 2, 3]];
    var out = [];
    for (var i = 0; i < combos.length; i++) {
      var c = combos[i];
      var same = (w.areas && w.areas.length === c.length && c.every(function (x) { return w.areas.indexOf(x) >= 0; }));
      if (same) continue;
      var free = true;
      for (var j = 0; j < c.length; j++) {
        var occ = p.wides[c[j]];
        if (occ && occ !== w) free = false;
      }
      if (free) out.push(c);
    }
    return out;
  }

  function canMoveWide(st, side, fromArea) {
    if (st.over) return { ok: false, reason: '对局已结束' };
    if (st.active !== side) return { ok: false, reason: '不是你的回合' };
    if (st.phase !== 'deploy') return { ok: false, reason: '只能在部署阶段移动' };
    var w = st.players[side].wides[fromArea];
    if (!w) return { ok: false, reason: '该位置没有宽幅卡' };
    if (!w.upgraded) return { ok: false, reason: '只有升级后的宽幅卡可以移动' };
    if (w.movedTurn === st.turnCount) return { ok: false, reason: '这张卡本回合已经移动过' };
    var targets = wideMoveTargets(st, side, fromArea);
    if (!targets.length) return { ok: false, reason: '没有可以移动过去的空位置' };
    return { ok: true, targets: targets };
  }

  function moveWide(st, side, fromArea, toAreas) {
    var chk = canMoveWide(st, side, fromArea);
    if (!chk.ok) return chk;
    var p = st.players[side];
    var w = p.wides[fromArea];
    var ok = false;
    for (var i = 0; i < chk.targets.length; i++) {
      var t = chk.targets[i];
      if (t.length === toAreas.length && t.every(function (x) { return toAreas.indexOf(x) >= 0; })) { ok = true; break; }
    }
    if (!ok) return { ok: false, reason: '非法移动目标' };
    for (var a = 1; a <= C.AREAS; a++) if (p.wides[a] === w) p.wides[a] = null;
    for (var k = 0; k < toAreas.length; k++) p.wides[toAreas[k]] = w;
    w.areas = toAreas.slice();
    w.movedTurn = st.turnCount;
    addLog(st, p.name + ' 移动 ' + WG.cardName(w.cardId) + ' 到区域 ' + toAreas.join('、'));
    sync(st);
    return { ok: true };
  }

  function checkOver(st) {
    if (st.over) return;
    var dead = [];
    for (var s = 0; s < 2; s++) if (st.players[s].hp <= 0) dead.push(s);
    if (dead.length === 2) {
      st.over = { draw: true, reason: '双方生命值同时归零' };
      addLog(st, '双方生命同时归零 —— 平局');
      return;
    }
    if (dead.length === 1) {
      st.over = { loser: dead[0], reason: '生命值归零' };
      addLog(st, st.players[dead[0]].name + ' 生命归零 —— ' + st.players[WG.foe(dead[0])].name + ' 获胜');
    }
  }

  /** 投降：确认后立即结束对局，对手获胜 */
  function surrender(st, side) {
    if (st.over) return { ok: false, reason: '对局已结束' };
    st.over = { loser: side, reason: '投降' };
    addLog(st, st.players[side].name + ' 投降 —— ' + st.players[WG.foe(side)].name + ' 获胜');
    return { ok: true };
  }

  // ============================================================
  // 回合流程
  // ============================================================
  function newTurnCtx(side) {
    return {
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

  function startTurn(st, side) {
    st.active = side;
    st.turnCount++;
    st.turnCtx = newTurnCtx(side);
    st.pending = { 1: null, 2: null, 3: null };
    var p = st.players[side];
    st.phase = 'start';

    // 1) 能量上限成长（从自己的第二个回合开始）
    if (p.turnsTaken >= 1) {
      if (p.maxEnergy < C.MAX_ENERGY_CAP) p.maxEnergy += 1;
    }
    // 2) 恢复 3，不超过上限
    var before = p.energy;
    p.energy = Math.min(p.maxEnergy, p.energy + C.ENERGY_REGEN);
    addLog(st, '—— ' + p.name + ' 回合开始（能量 ' + before + '→' + p.energy + ' / 上限 ' + p.maxEnergy + '）');

    // 3) 重置横置
    for (var i = 0; i < C.UNIT_SLOTS; i++) {
      var u = p.units[i];
      if (u) { u.exhausted = false; u.attacked = false; u.flags = {}; }
    }
    // 4) 回合开始触发
    var myUnits = unitsInArea(st, side, 1).concat(unitsInArea(st, side, 2), unitsInArea(st, side, 3));
    for (var k = 0; k < myUnits.length; k++) {
      var e = WG.Effects[myUnits[k].cardId];
      if (e && typeof e.onTurnStart === 'function') {
        e.onTurnStart(myUnits[k], ctx(st, side, myUnits[k], myUnits[k]));
      }
    }
    // 宽幅卡回合开始
    for (var a = 1; a <= C.AREAS; a++) {
      var w = p.wides[a];
      if (w) {
        var ew = WG.Effects[w.cardId];
        if (ew && typeof ew.onTurnStart === 'function') ew.onTurnStart(w, ctx(st, side, w, w));
      }
    }
    sync(st);

    // 2. 抽牌阶段
    st.phase = 'draw';
    var isFirstTurn = p.turnsTaken === 0;
    if (!(isFirstTurn && side === st.firstPlayer)) {
      drawCards(st, side, 1);
    } else {
      addLog(st, '先手第一回合跳过抽牌');
    }
    if (st.over) return;

    // 3. 部署阶段
    st.phase = 'deploy';
    checkOver(st);
  }

  /** 部署阶段结束 -> 定义牌阶段 -> 战斗阶段 */
  function toCombat(st, side) {
    if (st.phase !== 'deploy') return { ok: false, reason: '当前不是部署阶段' };
    st.phase = 'def';
    // 定义牌阶段：本卡表中没有卡能赋予定义牌内容，自动结束
    var defRes = tryDefinition(st, side);
    st.phase = 'combat';
    return { ok: true, defRes: defRes };
  }

  /**
   * 定义牌机制。
   * 文档：定义牌保持空白，不预设名称/费用/效果，只有其他卡牌明确赋予定义后才能使用。
   * 本卡表（100 张）中不存在可赋予定义的卡 -> 定义牌永远无法发动。
   * 机制完整实现，等待未来卡池接入。
   */
  function tryDefinition(st, side) {
    var p = st.players[side];
    var d = p.definition;
    if (!d || !d.charge) {
      return { ok: false, reason: '定义牌为空白：本卡表中没有卡牌能赋予其定义' };
    }
    return { ok: false, reason: '定义牌条件未满足' };
  }

  function endTurn(st, side) {
    if (st.over) return { ok: false, reason: '对局已结束' };
    if (st.active !== side) return { ok: false, reason: '不是你的回合' };
    st.phase = 'end';
    var p = st.players[side];

    // 回合结束触发
    var myUnits = unitsInArea(st, side, 1).concat(unitsInArea(st, side, 2), unitsInArea(st, side, 3));
    for (var i = 0; i < myUnits.length; i++) {
      var e = WG.Effects[myUnits[i].cardId];
      if (e && typeof e.onTurnEnd === 'function') {
        e.onTurnEnd(myUnits[i], ctx(st, side, myUnits[i], myUnits[i]));
      }
    }

    // 减少/清除「持续至回合结束」的临时状态
    for (var s = 0; s < 2; s++) {
      var arr = st.players[s].units;
      for (var k = 0; k < arr.length; k++) {
        if (!arr[k]) continue;
        arr[k].buffs = arr[k].buffs.filter(function (b) { return b.until !== 'turnEnd'; });
      }
    }
    // 伤害在回合结束时清除
    var list = allUnits(st);
    for (var m = 0; m < list.length; m++) list[m].wounds = 0;

    p.turnsTaken += 1;
    sync(st);
    checkOver(st);
    if (st.over) return { ok: true };

    // 交给对手
    startTurn(st, WG.foe(side));
    return { ok: true };
  }

  // ============================================================
  // 建局
  // ============================================================
  function buildDeck(st, side, cardIds) {
    // cardIds: 30 个 id，同名 <= 2
    var counts = {};
    var deck = [];
    for (var i = 0; i < cardIds.length; i++) {
      var id = cardIds[i];
      counts[id] = (counts[id] || 0) + 1;
      if (counts[id] > C.MAX_COPIES) return { ok: false, reason: '同名卡超过 ' + C.MAX_COPIES + ' 张：' + WG.cardName(id) };
      deck.push({ uid: nextUid(), cardId: id });
    }
    if (deck.length !== C.DECK_SIZE) return { ok: false, reason: '牌组必须恰好 ' + C.DECK_SIZE + ' 张（当前 ' + deck.length + '）' };
    st.players[side].deck = deck;
    return { ok: true };
  }

  /**
   * 建立对局。
   * opts = { decks: [30 ids, 30 ids], names:[..], firstPlayer: 0|1, seed }
   */
  function newGame(opts) {
    opts = opts || {};
    uidSeq = 1;
    var st = {
      turnCount: 0,
      active: 0,
      phase: 'deploy',
      log: [],
      pending: { 1: null, 2: null, 3: null },
      turnCtx: newTurnCtx(0),
      players: [],
      over: null,
      firstPlayer: opts.firstPlayer === 1 ? 1 : 0,
      rngState: opts.seed || 123456789
    };
    for (var s = 0; s < 2; s++) {
      st.players.push({
        idx: s,
        name: (opts.names && opts.names[s]) || (s === 0 ? '你' : '对手'),
        hp: C.START_HP,
        energy: C.START_ENERGY,
        maxEnergy: C.START_MAX_ENERGY,
        deck: [],
        hand: [],
        discard: [],
        units: [null, null, null, null, null, null],
        wides: { 1: null, 2: null, 3: null },
        definition: { cardId: null, charge: null, lock: null, lastLockedArea: null },
        turnsTaken: 0,
        mulliganDone: false
      });
    }
    if (opts.decks) {
      var r0 = buildDeck(st, 0, opts.decks[0]);
      if (!r0.ok) return { error: r0.reason };
      var r1 = buildDeck(st, 1, opts.decks[1]);
      if (!r1.ok) return { error: r1.reason };
    }
    applyStatics(st);
    return st;
  }

  /** 开局：洗牌 + 发起始手牌 */
  function beginMatch(st) {
    shuffle(st, st.players[0].deck);
    shuffle(st, st.players[1].deck);
    for (var s = 0; s < 2; s++) {
      for (var i = 0; i < C.START_HAND; i++) {
        var p = st.players[s];
        if (p.deck.length) p.hand.push(p.deck.pop());
      }
    }
    startTurn(st, st.firstPlayer);
    return st;
  }

  /** mulberry32 洗牌（确定性） */
  function shuffle(st, arr) {
    var a = st.rngState >>> 0;
    function rnd() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    st.rngState = a;
    return arr;
  }

  /** 换牌（mulligan）：把选中的手牌换掉 */
  function mulligan(st, side, handIndices) {
    var p = st.players[side];
    if (p.mulliganDone) return { ok: false, reason: '已经换过牌了' };
    if (!handIndices || !handIndices.length) { p.mulliganDone = true; return { ok: true }; }
    var idxs = handIndices.slice().sort(function (a, b) { return b - a; });
    var setAside = [];
    for (var i = 0; i < idxs.length; i++) {
      setAside.push(p.hand.splice(idxs[i], 1)[0]);
    }
    for (var k = 0; k < setAside.length; k++) {
      if (p.deck.length) p.hand.push(p.deck.pop());
    }
    // 放回牌库并洗
    for (var m = 0; m < setAside.length; m++) p.deck.push(setAside[m]);
    shuffle(st, p.deck);
    p.mulliganDone = true;
    return { ok: true };
  }

  // ============================================================
  // 导出
  // ============================================================
  WG.Engine = {
    newGame: newGame,
    beginMatch: beginMatch,
    mulligan: mulligan,
    // 数值
    effAtk: effAtk,
    effMaxHp: effMaxHp,
    effHp: effHp,
    bAtk: bAtk,
    bMaxHp: bMaxHp,
    isAlive: isAlive,
    hasWideBuff: hasWideBuff,
    // 查询
    unitsInArea: unitsInArea,
    widesInArea: widesInArea,
    unitByUid: unitByUid,
    allUnits: allUnits,
    validUnitSlots: validUnitSlots,
    validWideSlots: validWideSlots,
    canPlay: canPlay,
    canAttack: canAttack,
    canUpgrade: canUpgrade,
    legalAttackTargets: legalAttackTargets,
    // 动作
    play: play,
    attack: attack,
    resolveArea: resolveArea,
    toCombat: toCombat,
    endTurn: endTurn,
    tryDefinition: tryDefinition,
    drawCards: drawCards,
    moveUnit: moveUnit,
    peekTop: peekTop,
    putBottom: putBottom,
    upgradeWide: upgradeWide,
    canMoveWide: canMoveWide,
    moveWide: moveWide,
    wideMoveTargets: wideMoveTargets,
    surrender: surrender,
    // 内部（供 UI/AI 用）
    _sync: sync,
    _ctx: ctx,
    _addLog: addLog,
    _destroyUnit: destroyUnit
  };

})(typeof window !== 'undefined'
  ? (window.WG = window.WG || {})
  : (global.WG = global.WG || {}));
