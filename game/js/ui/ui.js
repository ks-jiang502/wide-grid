/* Wide-Grid · 界面层
 * 纯原生 JS，IIFE 包裹。只依赖 WG.CARDS / WG.Engine / WG.Effects，
 * 不修改引擎与数据，所有 DOM 更新走「全量重绘 + 事件委托」。
 */
(function () {
  'use strict';

  var WG = window.WG || (window.WG = {});
  var E = WG.Engine;

  var PHASE_CN = {
    start: '起始', draw: '抽牌', deploy: '部署',
    'def': '定义', combat: '战斗', end: '结束'
  };

  // ============================================================
  // 界面状态（唯一可变状态，引擎状态在 S.st）
  // ============================================================
  var S = {
    screen: 'welcome',   // welcome | builder | mulligan | table
    st: null,            // 引擎状态对象
    sel: -1,             // 选中的手牌下标
    selUid: null,        // 选中的己方单位 uid
    wideSel: 0,          // 选中的己方宽幅卡区域号
    play: null,          // 选中手牌的 canPlay 结果缓存
    pick: null,          // 目标选择面板状态
    note: '',            // 面板提示
    mull: null,          // { sel: { idx: true } }
    bcount: null,        // 自选牌组 { cardId: n }
    bmsg: '',            // 自选牌组提示
    rules: false,        // 规则浮层
    tg: {},              // 当前可攻击的敌方单位 uid 集合
    aiTimer: null,
    aiBusy: false
  };

  // ============================================================
  // 小工具
  // ============================================================
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function card(id) { return WG.cardById(id); }
  function cname(id) { return WG.cardName(id); }
  function ctext(id) {
    var c = card(id);
    return (c && c.text) ? c.text : '';
  }
  function areaOf(slot) { return Math.floor(slot / 2) + 1; }
  function phaseCN(p) {
    if (WG.PHASE_NAME && WG.PHASE_NAME[p]) return WG.PHASE_NAME[p];
    return PHASE_CN[p] || String(p);
  }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  /** 找「覆盖了 area、但自己并不占位在 area」的宽幅卡（跨区卡） */
  function coverBy(p, area) {
    for (var k in p.wides) {
      if (!p.wides.hasOwnProperty(k)) continue;
      var w = p.wides[k];
      if (!w || !w.areas) continue;
      if (w.areas.indexOf(area) >= 0 && Number(w.areas[0]) !== area) return w;
    }
    return null;
  }

  function areasText(w, own) {
    var a = (w.areas && w.areas.length) ? w.areas : [own || 1];
    var out = [];
    for (var i = 0; i < a.length; i += 1) out.push('区' + a[i]);
    return out.join('·');
  }

  function upCostOf(cardId) {
    var e = WG.Effects && WG.Effects[cardId];
    return (e && e.upgradeCost) || 0;
  }

  // 统计「本区是否还有未结算的战斗伤害」
  function pendingAreas() {
    var out = [];
    if (!S.st || !S.st.pending) return out;
    for (var a = 1; a <= 3; a += 1) if (S.st.pending[a]) out.push(a);
    return out;
  }

  function resolveAll(st) {
    for (var a = 1; a <= 3; a += 1) {
      if (st.pending && st.pending[a]) E.resolveArea(st, a);
    }
  }

  // ============================================================
  // 随机牌组：恰好 30 张、同名 ≤2、宽幅卡 4-6 张
  // ============================================================
  function randomDeck() {
    var units = [], wides = [];
    for (var i = 0; i < WG.CARDS.length; i += 1) {
      var c = WG.CARDS[i];
      if (c.type === 'wide') wides.push(c.id);
      else units.push(c.id);
    }

    var deck = [];
    var wantWide = 4 + Math.floor(Math.random() * 3); // 4 / 5 / 6
    var wpool = shuffle(wides.slice());
    var left = wantWide;
    var wi = 0;
    while (left > 0 && wi < wpool.length) {
      var n = left >= 2 ? 2 : 1;
      for (var k = 0; k < n; k += 1) deck.push(wpool[wi]);
      left -= n;
      wi += 1;
    }

    var upool = shuffle(units.slice());
    var ui = 0;
    while (deck.length < 30 && ui < upool.length) {
      var put = Math.min(2, 30 - deck.length);
      for (var m = 0; m < put; m += 1) deck.push(upool[ui]);
      ui += 1;
    }
    return deck;
  }

  // ============================================================
  // 开局
  // ============================================================
  function startMatch(myDeck) {
    var d0 = myDeck.slice();
    var d1 = randomDeck();
    var st = E.newGame({
      decks: [d0, d1],
      names: ['你', '对手'],
      seed: Date.now(),
      firstPlayer: 0
    });
    if (!st || st.error) {
      S.note = (st && st.error) || '开局失败';
      return false;
    }
    E.beginMatch(st);
    S.st = st;
    S.screen = 'mulligan';
    S.mull = { sel: {} };
    S.sel = -1;
    S.selUid = null;
    S.wideSel = 0;
    S.play = null;
    S.pick = null;
    S.note = '';
    render();
    return true;
  }

  function aiMulliganPicks(st) {
    var p = st.players[1], out = [];
    for (var i = 0; i < p.hand.length; i += 1) {
      var c = card(p.hand[i].cardId);
      if (c.cost > 5) out.push(i);
    }
    return out.slice(0, 2);
  }

  // ============================================================
  // 事件委托
  // ============================================================
  function onClick(e) {
    var el = e && e.target;
    while (el && el.getAttribute) {
      var act = el.getAttribute('data-act');
      if (act) {
        handle(act, el.getAttribute('data-arg') || '', el);
        return;
      }
      el = el.parentNode;
    }
  }

  function handle(act, arg, el) {
    var st = S.st;

    // ---- 欢迎 / 自选 ----
    if (act === 'random') { startMatch(randomDeck()); return; }
    if (act === 'builder') { openBuilder(); return; }
    if (act === 'home') {
      stopAi();
      S.screen = 'welcome'; S.st = null; S.mull = null; S.pick = null;
      render(); return;
    }
    if (act === 'bd-add') { toggleBuild(Number(arg)); return; }
    if (act === 'bd-clear') { S.bcount = {}; S.bmsg = ''; render(); return; }
    if (act === 'bd-random') {
      var rd = randomDeck();
      S.bcount = {};
      for (var i = 0; i < rd.length; i += 1) {
        S.bcount[rd[i]] = (S.bcount[rd[i]] || 0) + 1;
      }
      S.bmsg = '';
      render(); return;
    }
    if (act === 'bd-start') { startBuilderMatch(); return; }

    if (!st) return;

    // ---- 换牌 ----
    if (act === 'mull-t') {
      var mi = Number(arg);
      if (S.mull.sel[mi]) delete S.mull.sel[mi];
      else S.mull.sel[mi] = true;
      render(); return;
    }
    if (act === 'mull-ok') { submitMulligan(); return; }

    // ---- 浮层 ----
    if (act === 'rules') { S.rules = true; render(); return; }
    if (act === 'rules-close') { S.rules = false; render(); return; }
    if (act === 'restart') { S.rules = false; startMatch(randomDeck()); return; }

    // ---- 手牌 ----
    if (act === 'hand-sel') {
      var hi = Number(arg);
      if (S.sel === hi) { S.sel = -1; S.play = null; S.note = ''; }
      else {
        S.sel = hi;
        S.note = '';
        refreshPlay();
        if (S.play && !S.play.ok) S.note = S.play.reason;
      }
      render(); return;
    }

    // ---- 打出 ----
    if (act === 'play-unit') {
      if (S.sel < 0) return;
      startPlay({ slot: Number(arg) });
      return;
    }
    if (act === 'play-wide') {
      if (S.sel < 0) return;
      var parts = String(arg).split(',');
      var ws = [];
      for (var k = 0; k < parts.length; k += 1) ws.push(Number(parts[k]));
      startPlay({ wideSlots: ws });
      return;
    }

    // ---- 目标选择面板 ----
    if (act === 'pick-t') { pickSet(arg); return; }
    if (act === 'pick-cancel') { S.pick = null; S.note = '已取消'; render(); return; }

    // ---- 升级宽幅卡 ----
    if (act === 'wide-sel') { S.wideSel = Number(arg); render(); return; }
    if (act === 'wide-up') {
      var ua = Number(arg);
      var chk = E.canUpgrade(st, 0, ua);
      if (!chk.ok) { S.note = chk.reason; render(); return; }
      var r = E.upgradeWide(st, 0, ua);
      S.note = r.ok ? ('已升级为强化形态（-' + chk.cost + ' 能量）') : r.reason;
      render(); return;
    }

    // ---- 战斗 ----
    if (act === 'unit-sel') {
      var uid = Number(arg);
      var u = E.unitByUid(st, uid);
      if (!u || u.owner !== 0) return;
      if (st.phase !== 'combat') {
        S.note = '只能在战斗阶段选择单位';
        render(); return;
      }
      if (!E.canAttack(st, u)) { S.note = '该单位本回合不能攻击'; render(); return; }
      S.selUid = (S.selUid === uid) ? null : uid;
      S.note = S.selUid ? '选择攻击目标' : '';
      render(); return;
    }
    if (act === 'atk-unit') {
      if (!S.selUid) return;
      var ar = E.attack(st, 0, S.selUid, { type: 'unit', uid: Number(arg) });
      if (!ar.ok) S.note = ar.reason; else { S.selUid = null; S.note = ''; }
      render(); checkOverUi(); return;
    }
    if (act === 'atk-face') {
      if (!S.selUid) return;
      var fr = E.attack(st, 0, S.selUid, { type: 'face' });
      if (!fr.ok) S.note = fr.reason; else { S.selUid = null; S.note = ''; }
      render(); checkOverUi(); return;
    }

    // ---- 阶段推进 ----
    if (act === 'to-combat') {
      if (st.phase !== 'deploy') { S.note = '现在不在部署阶段'; render(); return; }
      E.toCombat(st, 0);
      S.sel = -1; S.play = null; S.note = '战斗阶段：点自己的单位发起攻击';
      render(); return;
    }
    if (act === 'resolve') {
      var ra = Number(arg);
      E.resolveArea(st, ra);
      S.selUid = null;
      render(); return;
    }
    if (act === 'end-turn') {
      if (st.active !== 0) return;
      resolveAll(st);
      S.sel = -1; S.selUid = null; S.play = null; S.pick = null; S.wideSel = 0;
      S.note = '';
      E.endTurn(st, 0);
      render(); return;
    }
  }

  function checkOverUi() {
    if (S.st && S.st.over) {
      S.sel = -1; S.selUid = null; S.play = null;
      stopAi();
    }
  }

  // ============================================================
  // 目标选择
  // ============================================================
  function pickSet(arg) {
    var pk = S.pick;
    if (!pk) return;
    var parts = String(arg).split('|');
    var i = Number(parts[0]);
    var k = parts[1];
    if (k === 'x') { pk.cur[i] = null; pk.done[i] = true; }
    else {
      var opt = (pk.targets[i].options || [])[Number(k)];
      if (!opt) return;
      pk.cur[i] = opt;
      pk.done[i] = true;
    }
    render();
    // 全部选完 -> 自动打出
    var ready = true;
    for (var j = 0; j < pk.targets.length; j += 1) if (!pk.done[j]) ready = false;
    if (ready) doPlay();
  }

  function startPlay(choice) {
    if (!S.play || !S.play.ok) {
      S.note = (S.play && S.play.reason) || '现在不能打出这张牌';
      render();
      return;
    }
    var tg = S.play.targets || [];
    if (tg.length) {
      S.pick = { choice: choice, targets: tg, cur: [], done: [] };
      for (var i = 0; i < tg.length; i += 1) { S.pick.cur[i] = null; S.pick.done[i] = false; }
      render();
      return;
    }
    doPlay(choice);
  }

  function doPlay(passed) {
    var pk = S.pick;
    var choice = passed || (pk ? pk.choice : null);
    var targets = [];
    if (pk) {
      for (var i = 0; i < pk.targets.length; i += 1) targets.push(pk.cur[i] || null);
    }
    var arg = { targets: targets };
    if (choice && choice.slot !== undefined) arg.slot = choice.slot;
    if (choice && choice.wideSlots) arg.wideSlots = choice.wideSlots;

    var r = E.play(S.st, 0, S.sel, arg);
    S.pick = null;
    if (!r.ok) {
      S.note = r.reason || '打不出去';
    } else {
      S.sel = -1; S.play = null; S.note = '';
    }
    render(); checkOverUi();
  }

  // ============================================================
  // AI 回合
  // ============================================================
  function stopAi() {
    if (S.aiTimer) { clearTimeout(S.aiTimer); S.aiTimer = null; }
    S.aiBusy = false;
  }

  function scheduleAi() {
    if (S.aiTimer) return;
    if (S.screen !== 'table') return;
    var st = S.st;
    if (!st || st.over || st.active !== 1) return;
    S.aiTimer = setTimeout(aiTick, 380);
  }

  function aiTick() {
    S.aiTimer = null;
    var st = S.st;
    if (!st || st.over || st.active !== 1) { S.aiBusy = false; render(); return; }
    if (S.aiBusy) return;
    S.aiBusy = true;
    var more = aiStep(st);
    S.aiBusy = false;
    if (!more && !st.over && st.active === 1) {
      resolveAll(st);
      E.endTurn(st, 1);
    }
    render();
  }

  /** 返回 true = 还有下一步可做 */
  function aiStep(st) {
    if (st.over || st.active !== 1) return false;
    var p = st.players[1];

    if (st.phase === 'deploy') {
      // 1) 手牌：先宽幅卡（增益更值），再高攻单位
      var idx = aiPickHand(st, p, 'wide');
      if (idx < 0) idx = aiPickHand(st, p, 'unit');
      if (idx >= 0) return aiPlay(st, idx);

      // 2) 升级
      for (var a = 1; a <= 3; a += 1) {
        var ck = E.canUpgrade(st, 1, a);
        if (ck.ok && E.upgradeWide(st, 1, a).ok) return true;
      }

      // 3) 进入战斗
      if (st.phase === 'deploy') E.toCombat(st, 1);
      return true;
    }

    if (st.phase === 'combat') {
      if (aiAttack(st)) return true;
      resolveAll(st);
      E.endTurn(st, 1);
      return false;
    }

    return false;
  }

  function aiPickHand(st, p, type) {
    var best = -1, bestScore = -1;
    for (var i = 0; i < p.hand.length; i += 1) {
      var c = card(p.hand[i].cardId);
      if (c.type !== type) continue;
      var r = E.canPlay(st, 1, i);
      if (!r.ok) continue;
      var score = c.cost * 10 + (type === 'wide' ? 5 : (c.atk || 0));
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function aiPlay(st, idx) {
    var p = st.players[1];
    var chk = E.canPlay(st, 1, idx);
    if (!chk.ok) return false;
    var c = card(p.hand[idx].cardId);
    var tg = aiTargets(chk.targets);
    if (c.type === 'unit') {
      var slot = aiSlot(st, chk.needSlots);
      var r = E.play(st, 1, idx, { slot: slot, targets: tg });
      return !!r.ok;
    }
    var wslots = chk.needSlots[0];
    var r2 = E.play(st, 1, idx, { wideSlots: wslots, targets: tg });
    return !!r2.ok;
  }

  // AI 默认选每项目标的第一个选项，可选目标则跳过
  function aiTargets(targets) {
    var out = [];
    if (!targets) return out;
    for (var i = 0; i < targets.length; i += 1) {
      var t = targets[i];
      var opts = t.options || [];
      out.push(opts.length ? opts[0] : null);
    }
    return out;
  }

  function aiSlot(st, slots) {
    if (!slots || !slots.length) return 0;
    var best = slots[0], bestN = -1;
    for (var i = 0; i < slots.length; i += 1) {
      var n = E.unitsInArea(st, 1, areaOf(slots[i])).length;
      if (n > bestN) { bestN = n; best = slots[i]; }
    }
    return best;
  }

  function aiAttack(st) {
    var mine = [];
    var s;
    for (s = 0; s < 6; s += 1) {
      var u = st.players[1].units[s];
      if (u && E.canAttack(st, u)) mine.push(u);
    }
    if (!mine.length) return false;

    // 1) 能一击致死的目标优先
    for (var i = 0; i < mine.length; i += 1) {
      var m = mine[i];
      var atk = E.effAtk(st, m);
      var lg = E.legalAttackTargets(st, m);
      for (var k = 0; k < lg.units.length; k += 1) {
        if (atk >= E.effHp(st, lg.units[k])) {
          if (E.attack(st, 1, m.uid, { type: 'unit', uid: lg.units[k].uid }).ok) return true;
        }
      }
    }
    // 2) 可直击就打脸
    for (var j = 0; j < mine.length; j += 1) {
      var m2 = mine[j];
      if (E.legalAttackTargets(st, m2).face) {
        if (E.attack(st, 1, m2.uid, { type: 'face' }).ok) return true;
      }
    }
    // 3) 否则互换，挑血量最低的
    for (var q = 0; q < mine.length; q += 1) {
      var m3 = mine[q];
      var lg3 = E.legalAttackTargets(st, m3);
      if (!lg3.units.length) continue;
      var t = lg3.units.slice().sort(function (a, b) {
        return E.effHp(st, a) - E.effHp(st, b);
      })[0];
      if (E.attack(st, 1, m3.uid, { type: 'unit', uid: t.uid }).ok) return true;
    }
    return false;
  }

  /** 同步跑完当前 AI 回合（测试与「快进」用） */
  function autoAiTurn() {
    var st = S.st;
    var guard = 0;
    while (st && !st.over && st.active === 1 && guard < 400) {
      guard += 1;
      var more = aiStep(st);
      if (!more) {
        if (!st.over && st.active === 1) { resolveAll(st); E.endTurn(st, 1); }
        break;
      }
    }
    if (st && st.active !== 1) { S.selUid = null; S.sel = -1; S.play = null; }
    render();
  }

  // ============================================================
  // 视图：欢迎
  // ============================================================
  function viewWelcome() {
    return '<div class="stage"><div class="screen welcome">'
      + '<h1 class="w-title">Wide–Grid</h1>'
      + '<p class="w-sub">双人对战 · 音乐卡牌</p>'
      + '<div class="w-btns">'
      + '  <button class="btn-lg" data-act="random">快速开始（随机牌组）</button>'
      + '  <button class="btn-lg btn-alt" data-act="builder">自选牌组</button>'
      + '</div>'
      + '<p class="w-note">你对战电脑对手 · 双击 game/index.html 即玩</p>'
      + (S.note ? '<p class="bd-msg">' + esc(S.note) + '</p>' : '')
      + '</div></div>';
  }

  // ============================================================
  // 视图：自选牌组
  // ============================================================
  function openBuilder() {
    S.screen = 'builder';
    if (!S.bcount) S.bcount = {};
    S.bmsg = '';
    render();
  }

  function buildTotal() {
    var n = 0;
    for (var k in S.bcount) if (S.bcount.hasOwnProperty(k)) n += S.bcount[k];
    return n;
  }

  function toggleBuild(id) {
    var n = S.bcount[id] || 0;
    var total = buildTotal();
    if (n >= 2) S.bcount[id] = 0;
    else if (total >= 30) { S.bmsg = '牌组已满 30 张'; }
    else S.bcount[id] = n + 1;
    S.bmsg = (S.bmsg === '牌组已满 30 张' && total >= 30) ? S.bmsg : '';
    render();
  }

  function startBuilderMatch() {
    var total = buildTotal();
    if (total !== 30) { S.bmsg = '还需要 ' + (30 - total) + ' 张才能开局'; render(); return; }
    var deck = [];
    for (var k in S.bcount) {
      if (!S.bcount.hasOwnProperty(k)) continue;
      var n = S.bcount[k];
      for (var i = 0; i < n; i += 1) deck.push(Number(k));
    }
    if (!startMatch(deck)) { S.screen = 'builder'; S.bmsg = S.note; render(); }
  }

  function viewBuilder() {
    var total = buildTotal();
    var cards = '';
    for (var i = 0; i < WG.CARDS.length; i += 1) {
      var c = WG.CARDS[i];
      var n = S.bcount[c.id] || 0;
      var stat = c.type === 'wide'
        ? ('宽幅 · ' + esc(c.wcat || ''))
        : ((c.atk || 0) + '/' + (c.hp || 0) + ' · ' + esc(c.cat || ''));
      cards += '<div class="bd-card' + (n ? ' on' : '') + '" data-act="bd-add" data-arg="' + c.id + '">'
        + '<span class="bc-cost">' + c.cost + ' 费</span>'
        + '<span class="bc-name">' + esc(c.name) + '</span>'
        + '<span class="bc-stat">' + stat + '</span>'
        + (n ? '<span class="bc-n">x' + n + '</span>' : '')
        + '</div>';
    }
    return '<div class="stage"><div class="screen builder">'
      + '<div class="bd-head"><h1 class="sc-title">自选牌组</h1>'
      + '<div class="bd-count">' + total + ' / 30</div></div>'
      + '<p class="sc-sub">同一张卡最多 2 张，凑满 30 张才能开局 · 再点一次已满 2 张的卡可取消</p>'
      + '<div class="bd-actions">'
      + '<button class="btn-lg" data-act="bd-random">随机填满</button>'
      + '<button class="btn-lg" data-act="bd-clear">清空</button>'
      + '<button class="btn-lg" data-act="home">返回</button>'
      + '<button class="btn-lg btn-alt" data-act="bd-start"' + (total === 30 ? '' : ' disabled') + '>开始对局</button>'
      + '</div>'
      + (S.bmsg ? '<div class="bd-msg">' + esc(S.bmsg) + '</div>' : '')
      + '<div class="bd-grid">' + cards + '</div>'
      + '</div></div>';
  }

  // ============================================================
  // 视图：换牌
  // ============================================================
  function viewMulligan() {
    var st = S.st;
    var p = st.players[0];
    var cards = '';
    for (var i = 0; i < p.hand.length; i += 1) {
      var c = card(p.hand[i].cardId);
      var on = S.mull.sel[i] ? ' on' : '';
      var stat = c.type === 'wide'
        ? ('宽幅卡 · ' + esc(c.wcat || ''))
        : ((c.atk || 0) + ' 攻击 / ' + (c.hp || 0) + ' 生命');
      cards += '<div class="mull-card' + on + '" data-act="mull-t" data-arg="' + i + '">'
        + '<div class="mc-top"><span class="mc-cost">' + c.cost + '</span>'
        + '<span class="mc-name">' + esc(c.name) + '</span></div>'
        + '<div class="mc-stat">' + stat + '</div>'
        + '<div class="mc-text">' + esc(c.text || '') + '</div>'
        + '</div>';
    }
    var n = 0;
    for (var k in S.mull.sel) if (S.mull.sel[k]) n += 1;
    return '<div class="stage"><div class="screen">'
      + '<h1 class="sc-title">起始手牌</h1>'
      + '<p class="sc-sub">点选想要换掉的手牌（可以多选，也可以不换）。换掉的牌会洗回牌库并重新抽取。</p>'
      + '<div class="mull-grid">' + cards + '</div>'
      + '<div class="sc-actions"><button class="btn-lg btn-alt" data-act="mull-ok">'
      + (n ? '确认换掉 ' + n + ' 张' : '不换，开始对局') + '</button></div>'
      + (S.note ? '<p class="bd-msg">' + esc(S.note) + '</p>' : '')
      + '</div></div>';
  }

  function submitMulligan() {
    var st = S.st;
    var idxs = [];
    for (var k in S.mull.sel) if (S.mull.sel[k]) idxs.push(Number(k));
    idxs.sort(function (a, b) { return a - b; });
    var r = E.mulligan(st, 0, idxs);
    if (!r.ok) { S.note = r.reason || '换牌失败'; render(); return; }

    var aiPicks = aiMulliganPicks(st);
    E.mulligan(st, 1, aiPicks);

    S.screen = 'table';
    S.mull = null;
    S.sel = -1;
    S.play = null;
    S.selUid = null;
    S.note = '';
    render();
  }

  // ============================================================
  // 视图：牌桌
  // ============================================================
  function viewTable() {
    var st = S.st;
    if (!st) return '<div class="stage"><div class="screen">没有进行中的对局</div></div>';
    refreshPlay();
    S.tg = attackableSet();
    var me = st.players[0];

    var h = '<div class="stage"><div class="board">';
    h += oppbar(st);
    h += '<div class="title pos">Wide–Grid</div>';
    h += defCardBox(me);
    h += defJudgeBox(me);
    h += discardBox(me);
    h += wideZone(1, me) + wideZone(2, me) + wideZone(3, me);
    for (var i = 0; i < 6; i += 1) h += slotBox(i, me);
    h += deckBox(me);
    h += handBox(me);
    h += panelBox(st, me);
    h += logBox(st);
    h += previewBox(me);
    h += pickBox();
    if (S.rules) h += rulesOverlay();
    if (st.over) h += overOverlay(st);
    h += '</div></div>';
    return h;
  }

  function refreshPlay() {
    S.play = null;
    if (!S.st || S.sel < 0) return;
    var p = S.st.players[0];
    if (!p.hand[S.sel]) { S.sel = -1; return; }
    S.play = E.canPlay(S.st, 0, S.sel);
  }

  function attackableSet() {
    var set = {};
    var st = S.st;
    if (!st || st.phase !== 'combat' || !S.selUid) return set;
    var u = E.unitByUid(st, S.selUid);
    if (!u) return set;
    var legal = E.legalAttackTargets(st, u);
    for (var i = 0; i < legal.units.length; i += 1) set[legal.units[i].uid] = true;
    return set;
  }

  // ---- 对手信息条 ----
  function oppbar(st) {
    var f = st.players[1];
    var tags = '';
    for (var a = 1; a <= 3; a += 1) {
      var w = f.wides[a];
      if (w) {
        tags += '<span class="ob-tag on">区' + a + ' ' + esc(cname(w.cardId))
          + (w.upgraded ? '·强化' : '') + '</span>';
      } else if (coverBy(f, a)) {
        tags += '<span class="ob-tag">区' + a + ' 被覆盖</span>';
      } else {
        tags += '<span class="ob-tag">区' + a + ' 空</span>';
      }
    }

    var units = '';
    for (var s = 0; s < 6; s += 1) {
      var u = f.units[s];
      var area = areaOf(s);
      if (u) {
        var cls = 'ob-unit' + (u.exhausted ? ' off' : '') + (S.tg[u.uid] ? ' target' : '');
        var act = S.tg[u.uid]
          ? ' data-act="atk-unit" data-arg="' + u.uid + '"' : '';
        units += '<div class="' + cls + '"' + act + '>'
          + '<em>' + esc(cname(u.cardId).charAt(0)) + '</em>'
          + '<i>' + E.effAtk(st, u) + '/' + E.effHp(st, u) + '</i>'
          + '<u>区' + area + '</u></div>';
      } else {
        units += '<div class="ob-unit empty"><em>—</em><u>区' + area + '</u></div>';
      }
    }

    return '<div class="oppbar pos">'
      + '<div class="ob-id">'
      + '<span class="ob-name">' + esc(f.name) + '</span>'
      + '<span class="ob-stat">生命 <b>' + f.hp + '</b></span>'
      + '<span class="ob-stat">能量 <b>' + f.energy + '/' + f.maxEnergy + '</b></span>'
      + '<span class="ob-stat">牌组 <b>' + f.deck.length + '</b></span>'
      + '<span class="ob-stat">手牌 <b>' + f.hand.length + '</b></span>'
      + '</div>'
      + '<div class="ob-wides">' + tags + '</div>'
      + '<div class="ob-units">' + units + '</div>'
      + '</div>';
  }

  // ---- 定义牌 / 定义判定 / 弃牌堆 ----
  function defCardBox(p) {
    var d = p.definition || { charge: 0, lockedAreas: [] };
    return '<div class="def-card pos flat">'
      + '<span class="flat-title">定义牌</span>'
      + '<span class="flat-big">—</span>'
      + '<span class="flat-note">本卡表没有赋予定义牌的卡牌，此位常空。</span>'
      + '<span class="flat-note">定义充能 ' + (d.charge || 0) + '</span>'
      + '</div>';
  }

  function defJudgeBox(p) {
    var d = p.definition || { charge: 0, lockedAreas: [] };
    var locked = d.lockedAreas || [];
    var txt = locked.length ? ('锁定 ' + locked.join('、') + ' 区') : '无锁定区域';
    return '<div class="def-judge pos flat">'
      + '<span class="flat-title">定义判定</span>'
      + '<span class="flat-note">' + esc(txt) + '</span>'
      + '<span class="flat-note">判定后持续 ' + (WG.DEF_LOCK_TURNS || 2) + ' 回合</span>'
      + '</div>';
  }

  function discardBox(p) {
    var d = p.discard || [];
    var last = '';
    var from = Math.max(0, d.length - 4);
    for (var i = from; i < d.length; i += 1) {
      last += esc(cname(d[i].cardId)) + '<br>';
    }
    return '<div class="discard pos flat">'
      + '<span class="flat-title">弃牌堆</span>'
      + '<span class="flat-big">' + d.length + '</span>'
      + '<div class="discard-list">' + (last || '<span class="flat-note">空</span>') + '</div>'
      + '</div>';
  }

  // ---- 增益区域 ----
  function wideZone(a, p) {
    var st = S.st;
    var w = p.wides[a];
    // 跨区宽幅卡会把同一实例挂到多个区键上：只有「主区」渲染卡面，
    // 其余被覆盖的区交给下面的 coverBy 画虚线影子。
    if (w && w.areas && Number(w.areas[0]) !== a) w = null;

    if (w) {
      var chk = E.canUpgrade(st, 0, a);
      var selCls = (S.wideSel === a) ? ' sel' : '';
      var upBtn = '';
      if (chk.ok) {
        upBtn = (S.wideSel === a)
          ? '<button class="btn btn-min btn-alt" data-act="wide-up" data-arg="' + a + '">升级（'
            + chk.cost + ' 能量）</button>'
          : '<span class="wc-up">点击卡面查看升级</span>';
      } else if (w.upgraded) {
        upBtn = '<span class="wc-up">已是强化形态</span>';
      }
      return '<div class="wide-zone pos wz' + a + '">'
        + '<div class="wide-card' + (w.upgraded ? ' up' : '') + selCls
        + '" data-act="wide-sel" data-arg="' + a + '">'
        + '<div class="wc-name">' + esc(cname(w.cardId)) + '</div>'
        + '<div class="wc-meta">' + (w.upgraded ? '强化形态' : '初始形态')
        + ' · ' + esc(card(w.cardId).wcat || '增益') + '</div>'
        + '<div class="wc-area">' + areasText(w, a) + '</div>'
        + '<div class="wc-text">' + esc(card(w.cardId).text || '') + '</div>'
        + upBtn
        + '</div></div>';
    }

    var cov = coverBy(p, a);
    if (cov) {
      return '<div class="wide-zone pos wz' + a + ' covered">'
        + '<div class="wide-shadow">区' + a + '<br>由《' + esc(cname(cov.cardId)) + '》跨区覆盖</div>'
        + '</div>';
    }

    // 空槽：宽幅卡可放？
    var cand = null;
    if (S.play && S.play.ok && S.play.type === 'wide') {
      for (var i = 0; i < S.play.needSlots.length; i += 1) {
        if (S.play.needSlots[i].indexOf(a) >= 0) { cand = S.play.needSlots[i]; break; }
      }
    }
    if (cand) {
      return '<div class="wide-zone pos wz' + a + ' placeable" data-act="play-wide" '
        + 'data-arg="' + cand.join(',') + '">'
        + '<div class="wide-empty">放' + cand.join('·') + '区</div></div>';
    }
    return '<div class="wide-zone pos wz' + a + '">'
      + '<div class="wide-empty">区' + a + '</div></div>';
  }

  // ---- 单位位 ----
  function slotBox(i, p) {
    var st = S.st;
    var u = p.units[i];
    var area = areaOf(i);
    var head = '<span class="slot-no">' + (i + 1) + '<i>区' + area + '</i></span>';

    if (u) {
      var atk = E.effAtk(st, u);
      var hp = E.effHp(st, u);
      var mx = E.effMaxHp(st, u);
      var boosted = (atk !== u.atk) || (mx !== u.maxHp);
      var cls = 'u-card'
        + (u.exhausted ? ' tapped' : '')
        + (boosted ? ' boosted' : '')
        + (S.selUid === u.uid ? ' target' : '');
      var sel = (st.phase === 'combat') ? ' data-act="unit-sel" data-arg="' + u.uid + '"' : '';
      return '<div class="slot pos s' + i + '">' + head
        + '<div class="' + cls + '"' + sel + '>'
        + '<div class="u-name">' + esc(cname(u.cardId)) + '</div>'
        + (u.exhausted ? '<div class="u-tap">已行动</div>' : '')
        + '<div class="u-txt">' + esc(ctext(u.cardId)) + '</div>'
        + '<div class="u-stats"><span class="u-atk">' + atk
        + '<i>攻</i></span>'
        + '<span class="u-hp">' + hp + '/' + mx + '<i>血</i></span></div>'
        + '</div></div>';
    }

    var placeable = !!(S.play && S.play.ok && S.play.type === 'unit'
      && S.play.needSlots.indexOf(i) >= 0);
    return '<div class="slot pos s' + i + (placeable ? ' placeable' : '') + '"'
      + (placeable ? ' data-act="play-unit" data-arg="' + i + '"' : '') + '>'
      + head
      + '<div class="slot-hint">' + (placeable ? '放置' : '空位') + '</div>'
      + '</div>';
  }

  // ---- 主牌组 ----
  function deckBox(p) {
    return '<div class="deckpile pos">'
      + '<span class="flat-title">主牌组</span>'
      + '<span class="deck-count">' + p.deck.length + '</span>'
      + '<span class="flat-note">张 · 耗尽即判负</span>'
      + '</div>';
  }

  // ---- 手牌 ----
  function handBox(p) {
    var st = S.st;
    var canPlayPhase = (st.active === 0 && st.phase === 'deploy' && !st.over);
    var rows = '';
    for (var i = 0; i < p.hand.length; i += 1) {
      var c = card(p.hand[i].cardId);
      var ok = canPlayPhase && E.canPlay(st, 0, i).ok;
      var sum = c.type === 'wide'
        ? ('宽幅 · ' + (c.wcat || '增益'))
        : ('单位 · ' + (c.atk || 0) + '/' + (c.hp || 0));
      rows += '<div class="hcard' + (ok ? ' playable' : '') + (S.sel === i ? ' sel' : '')
        + '" data-act="hand-sel" data-arg="' + i + '">'
        + '<span class="hc-cost">' + c.cost + '</span>'
        + '<div class="hc-name">' + esc(c.name) + '</div>'
        + '<div class="hc-sum">' + esc(sum) + '</div>'
        + '<div class="hc-txt">' + esc(c.text || '（无效果）') + '</div>'
        + '</div>';
    }
    if (!p.hand.length) rows = '<div class="hand-empty">手牌为空</div>';
    return '<div class="handzone pos">'
      + '<div class="hand-head"><span>手牌</span><span>' + p.hand.length + ' 张</span></div>'
      + '<div class="hand-list">' + rows + '</div>'
      + '</div>';
  }

  // ---- 玩家面板 ----
  function panelBox(st, p) {
    var mine = (st.active === 0);
    var pips = '';
    for (var i = 0; i < p.maxEnergy; i += 1) {
      pips += '<span class="' + (i < p.energy ? 'on' : '') + '"></span>';
    }
    var full = (p.energy >= p.maxEnergy);

    var btns = '';
    if (st.over) {
      btns += '<button class="btn" data-act="restart">再来一局</button>';
      btns += '<button class="btn btn-min" data-act="rules">规则</button>';
    } else if (mine && st.phase === 'deploy') {
      btns += '<button class="btn btn-alt" data-act="to-combat">进入战斗</button>';
      btns += '<button class="btn" data-act="end-turn">结束回合</button>';
      btns += '<button class="btn btn-min" data-act="rules">规则</button>';
    } else if (mine && st.phase === 'combat') {
      if (S.selUid) {
        var su = E.unitByUid(st, S.selUid);
        var lg = su ? E.legalAttackTargets(st, su) : { units: [], face: false };
        if (lg.face) btns += '<button class="btn btn-alt" data-act="atk-face">直接攻击</button>';
      }
      var pend = pendingAreas();
      for (var k = 0; k < pend.length; k += 1) {
        btns += '<button class="btn" data-act="resolve" data-arg="' + pend[k] + '">结算区'
          + pend[k] + '</button>';
      }
      btns += '<button class="btn" data-act="end-turn">结束回合</button>';
      btns += '<button class="btn btn-min" data-act="rules">规则</button>';
    } else {
      btns += '<button class="btn btn-min" data-act="rules">规则</button>';
    }

    var who = st.over ? '对局结束' : (mine ? '你的回合' : '对手回合');
    var maxHp = WG.START_HP || 15;
    var hpPct = Math.max(0, Math.min(100, Math.round(p.hp / maxHp * 100)));
    return '<div class="panel pos">'
      + '<div class="pn-row"><span class="pn-lab">回合</span>'
      + '<span class="pn-num">' + st.turnCount
      + '<small>' + esc(phaseCN(st.phase)) + '</small></span></div>'
      + '<div class="pn-row"><span class="pn-lab">生命</span>'
      + '<span class="pn-num">' + p.hp + '<small>/' + maxHp + '</small></span></div>'
      + '<span class="hpbar"><i style="width:' + hpPct + '%"></i></span>'
      + '<div class="pn-row pn-en' + (full ? ' full' : '') + '"><span class="pn-lab">能量</span>'
      + '<span class="pn-num">' + p.energy + '<small>/' + p.maxEnergy + '</small></span></div>'
      + '<div class="pips">' + pips + '</div>'
      + '<div class="pn-turn">' + who + '</div>'
      + '<div class="pn-note">' + esc(S.note) + '</div>'
      + '<div class="pn-btns">' + btns + '</div>'
      + '</div>';
  }

  // ---- 日志 ----
  function logBox(st) {
    var log = st.log || [];
    var from = Math.max(0, log.length - 30);
    var rows = '';
    for (var i = from; i < log.length; i += 1) {
      var r = log[i];
      rows += '<div class="log-row"><i class="t">T' + r.turn + '·'
        + esc(phaseCN(r.phase)) + '</i>' + esc(r.text) + '</div>';
    }
    return '<div class="logbox pos"><div class="log-inner">' + rows + '</div></div>';
  }

  // ---- 大卡预览 ----
  function previewBox(p) {
    if (S.sel < 0) return '';
    var inst = p.hand[S.sel];
    if (!inst) return '';
    var c = card(inst.cardId);
    var meta, hint = '';
    if (c.type === 'wide') {
      var covers = [];
      var e = WG.Effects && WG.Effects[c.id];
      if (e && typeof e.wideCovers === 'function') {
        try {
          covers = e.wideCovers(E._ctx(S.st, 0, c, null)) || [];
        } catch (err) { covers = []; }
      }
      meta = '宽幅卡 · ' + (c.wcat || '增益')
        + (covers.length ? (' · 覆盖 ' + covers.join('·') + ' 区') : ' · 任选一个区域');
    } else {
      meta = '单位卡 · ' + c.atk + ' 攻 / ' + c.hp + ' 生命 · ' + (c.cat || '');
    }
    if (S.play) hint = S.play.ok ? '合法位置已高亮 · 点击放置' : (S.play.reason || '');

    return '<div class="preview pos">'
      + '<div class="pv-top"><span class="pv-cost">' + c.cost + '</span>'
      + '<span class="pv-name">' + esc(c.name) + '</span>'
      + '<span class="pv-type">' + (c.type === 'wide' ? '宽幅' : '单位') + '</span></div>'
      + '<div class="pv-mid">' + esc(meta) + '</div>'
      + '<div class="pv-text">' + esc(c.text || '（无效果）') + '</div>'
      + (hint ? '<div class="pv-hint">' + esc(hint) + '</div>' : '')
      + '</div>';
  }

  // ---- 目标选择面板 ----
  function pickBox() {
    var pk = S.pick;
    if (!pk) return '';
    var rows = '';
    for (var i = 0; i < pk.targets.length; i += 1) {
      var t = pk.targets[i];
      var opts = t.options || [];
      var cur = pk.cur[i];
      var btns = '';
      for (var k = 0; k < opts.length; k += 1) {
        var o = opts[k];
        var on = (pk.done[i] && cur === o) ? ' on' : '';
        btns += '<button class="tp-opt' + on + '" data-act="pick-t" data-arg="' + i + '|' + k + '">'
          + esc(o.label || String(o.uid)) + '</button>';
      }
      if (t.optional) {
        btns += '<button class="tp-skip' + (pk.done[i] && cur === null ? ' on' : '')
          + '" data-act="pick-t" data-arg="' + i + '|x">不选择</button>';
      }
      rows += '<div class="tp-row"><div class="tp-lab">' + esc(t.label || ('目标 ' + (i + 1)))
        + '</div><div class="tp-opts">' + btns + '</div></div>';
    }
    return '<div class="tp-panel pos">'
      + '<div class="tp-head">选择目标</div>' + rows
      + '<div class="tp-foot">全部选完后会自动打出</div>'
      + '<button class="btn btn-min" data-act="pick-cancel">取消</button>'
      + '</div>';
  }

  // ---- 结算浮层 ----
  function overOverlay(st) {
    var over = st.over;
    var win = (over.loser === 1);
    return '<div class="overlay"><div class="ov-card">'
      + '<div class="ov-res">' + (win ? '你获胜' : '你落败') + '</div>'
      + '<div class="ov-reason">' + esc(over.reason || '') + '</div>'
      + '<div class="ov-btns">'
      + '<button class="btn" data-act="restart">再来一局</button>'
      + '<button class="btn" data-act="home">返回首页</button>'
      + '</div></div></div>';
  }

  // ---- 规则浮层（≤400 字）----
  function rulesOverlay() {
    return '<div class="overlay"><div class="rules-card">'
      + '<h2>规则速览</h2>'
      + '<p><b>回合六阶段</b>：起始 → 抽牌 → 部署 → 定义 → 战斗 → 结束。界面只在「部署」和「战斗」两个阶段需要你操作。</p>'
      + '<p><b>能量</b>：初始 3 点、上限随回合 +1（最高 6），每回合回满式恢复 3 点。打出卡牌、升级宽幅卡都消耗能量。</p>'
      + '<p><b>部署</b>：单位卡放进 6 个单位位（区域 1/2/3 各两格）；宽幅卡放进 3 个增益区，跨区卡会一次占住多区。</p>'
      + '<p><b>战斗</b>：点自己的单位发起攻击。敌人同区有单位则必须打单位（互相造成攻击力伤害），该区没有敌方单位才能直接打玩家；生命总和 15 点。伤害在整区结算时统一判定破坏。</p>'
      + '<p><b>宽幅卡</b>：持续给覆盖区域的友方单位加成，可在部署阶段花能量升级为强化形态。被跨区卡覆盖的格子会显示虚线。</p>'
      + '<p><b>结算</b>：谁的生命归零，或牌库抽空，谁就落败。</p>'
      + '<div class="rules-close"><button class="btn" data-act="rules-close">关闭</button></div>'
      + '</div></div>';
  }

  // ============================================================
  // 渲染入口
  // ============================================================
  function scrollLog() {
    try {
      var lb = (document.querySelector ? document.querySelector('.logbox') : null);
      if (lb && typeof lb.scrollHeight === 'number') lb.scrollTop = lb.scrollHeight;
    } catch (err) { /* 无 DOM 环境忽略 */ }
  }

  function render() {
    var app = document.getElementById('app');
    if (!app) return;
    var html;
    if (S.screen === 'welcome') html = viewWelcome();
    else if (S.screen === 'builder') html = viewBuilder();
    else if (S.screen === 'mulligan') html = viewMulligan();
    else html = viewTable();
    app.innerHTML = html;
    scrollLog();
    scheduleAi();
  }

  // ============================================================
  // 启动
  // ============================================================
  function boot() {
    if (document.addEventListener) document.addEventListener('click', onClick, false);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }

  // 暴露给测试与调试
  WG.UI = {
    render: render,
    randomDeck: randomDeck,
    startMatch: startMatch,
    submitMulligan: submitMulligan,
    handle: handle,
    autoAiTurn: autoAiTurn,
    aiStep: aiStep,
    state: S
  };
})();
