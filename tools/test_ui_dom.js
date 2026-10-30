/* tools/test_ui_dom.js —— UI 层「防白屏」测试
 *
 * 用 node 手搓一个极简 DOM stub，把 game/index.html 里按顺序加载的脚本
 * 全部灌进 vm 沙箱跑一遍，然后断言：
 *   1. 全部脚本加载不报错
 *   2. WG.UI 入口存在，render() 不抛异常
 *   3. 随机牌组 20 次都满足「恰好 30 张、同名 ≤2、宽幅卡 4-6 张」
 *   4. 开局 → 换牌 → 牌桌 整条路径能渲染出来
 *   5. AI 回合能在一整个回合里推进完，不抛异常
 *
 * 目的只有一个：双击 index.html 时不会白屏。不追求覆盖率。
 *
 *   node tools/test_ui_dom.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');

// ============================================================
// 极简 DOM stub
// ============================================================
function makeStyle() {
  return {};
}

function makeEl(tag) {
  var el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: makeStyle(),
    innerHTML: '',
    textContent: '',
    value: '',
    className: '',
    scrollTop: 0,
    scrollHeight: 240,
    clientHeight: 240,
    offsetWidth: 300,
    offsetHeight: 300,
    parentNode: null,
    children: [],
    attrs: {},
    classList: null,
    addEventListener: null,
    removeEventListener: null,
    appendChild: null,
    removeChild: null,
    setAttribute: null,
    getAttribute: null,
    querySelector: null,
    querySelectorAll: null,
    focus: function () {},
    click: function () {}
  };

  el.classList = {
    _set: {},
    add: function (c) { el.classList._set[c] = true; },
    remove: function (c) { delete el.classList._set[c]; },
    contains: function (c) { return !!el.classList._set[c]; },
    toggle: function (c) {
      el.classList._set[c] = !el.classList._set[c];
      return el.classList._set[c];
    }
  };
  el.addEventListener = function () {};
  el.removeEventListener = function () {};
  el.appendChild = function (child) {
    if (child) { child.parentNode = el; el.children.push(child); }
    return child;
  };
  el.removeChild = function (child) {
    var i = el.children.indexOf(child);
    if (i >= 0) el.children.splice(i, 1);
    return child;
  };
  el.setAttribute = function (k, v) { el.attrs[String(k)] = String(v); };
  el.getAttribute = function (k) {
    var key = String(k);
    return Object.prototype.hasOwnProperty.call(el.attrs, key) ? el.attrs[key] : null;
  };
  el.querySelector = function () { return null; };
  el.querySelectorAll = function () { return []; };
  return el;
}

var appEl = makeEl('div');
var elCache = { app: appEl };

var documentStub = {
  readyState: 'complete',
  body: makeEl('body'),
  documentElement: makeEl('html'),
  getElementById: function (id) {
    if (!elCache[id]) elCache[id] = makeEl('div');
    return elCache[id];
  },
  createElement: function (tag) { return makeEl(tag); },
  createTextNode: function (t) { return { textContent: String(t) }; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  addEventListener: function () {},
  removeEventListener: function () {}
};

// ============================================================
// 沙箱
// ============================================================
var timerId = 0;
var timers = [];

var sandbox = { console: console };
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = documentStub;
sandbox.navigator = { userAgent: 'node-test' };
sandbox.setTimeout = function (fn, ms) {
  timerId += 1;
  timers.push({ id: timerId, fn: fn, ms: ms });
  return timerId;
};
sandbox.clearTimeout = function (id) {
  for (var i = 0; i < timers.length; i += 1) {
    if (timers[i].id === id) { timers.splice(i, 1); return; }
  }
};
sandbox.setInterval = function () { return 0; };
sandbox.clearInterval = function () {};
sandbox.requestAnimationFrame = function () { return 1; };
sandbox.cancelAnimationFrame = function () {};
sandbox.localStorage = {
  _d: {},
  getItem: function (k) { return this._d[k] === undefined ? null : this._d[k]; },
  setItem: function (k, v) { this._d[k] = String(v); },
  removeItem: function (k) { delete this._d[k]; },
  clear: function () { this._d = {}; }
};

vm.createContext(sandbox);

// ============================================================
// 断言
// ============================================================
var passes = 0;
var fails = 0;

function ok(cond, msg) {
  if (cond) {
    passes += 1;
  } else {
    fails += 1;
    console.log('  \u2717 ' + msg);
  }
}

function section(name) {
  console.log('\n' + name);
}

// ============================================================
// 1. 按 index.html 的顺序加载全部脚本
// ============================================================
var FILES = [
  'js/engine/constants.js',
  'js/data/cards.js',
  'js/engine/engine.js',
  'js/engine/effects_core.js',
  'js/engine/effects_units_a.js',
  'js/engine/effects_units_b.js',
  'js/ui/ui.js'
];

function load(rel) {
  var p = path.join(ROOT, 'game', rel);
  var code = fs.readFileSync(p, 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

section('[1] 脚本加载');

var loadError = null;
var loaded = [];
try {
  for (var fi = 0; fi < FILES.length; fi += 1) {
    load(FILES[fi]);
    loaded.push(FILES[fi]);
  }
} catch (err) {
  loadError = err;
}
ok(!loadError, '全部脚本加载不报错（已加载 ' + loaded.length + '/' + FILES.length
  + (loadError ? '：' + loadError.message : '') + '）');
if (loadError) {
  console.log('\n加载失败，后续断言跳过。\n' + (loadError.stack || ''));
  console.log('\n结果：' + passes + ' 通过 / ' + fails + ' 失败');
  process.exit(1);
}

var WG = sandbox.WG;
ok(!!WG, 'WG 命名空间存在');
ok(!!WG.Engine, 'WG.Engine 存在');
ok(!!WG.CARDS && WG.CARDS.length === 100, 'WG.CARDS 有 100 张卡');

// ============================================================
// 2. UI 入口 & 首屏渲染
// ============================================================
section('[2] UI 入口与首屏渲染');

var UI = WG.UI;
ok(!!UI, 'WG.UI 入口存在');
ok(typeof UI.render === 'function', 'WG.UI.render 是函数');
ok(typeof UI.randomDeck === 'function', 'WG.UI.randomDeck 是函数');
ok(typeof UI.autoAiTurn === 'function', 'WG.UI.autoAiTurn 是函数');

var renderError = null;
try { UI.render(); } catch (e) { renderError = e; }
ok(!renderError, 'render() 不抛异常' + (renderError ? '：' + renderError.message : ''));
ok(appEl.innerHTML.length > 0, 'render() 产出了 HTML（' + appEl.innerHTML.length + ' 字符）');
ok(appEl.innerHTML.indexOf('Wide') >= 0, '首屏包含标题 Wide');
ok(appEl.innerHTML.indexOf('\u5feb\u901f\u5f00\u59cb') >= 0, '首屏包含「快速开始」按钮');

// ============================================================
// 3. 随机牌组
// ============================================================
section('[3] 随机牌组（20 次）');

var deckErrors = 0;
var wideMin = 99;
var wideMax = -1;
for (var t = 0; t < 20; t += 1) {
  var deck = UI.randomDeck();
  if (!deck || deck.length !== 30) deckErrors += 1;

  var counts = {};
  var wides = 0;
  for (var i = 0; i < deck.length; i += 1) {
    counts[deck[i]] = (counts[deck[i]] || 0) + 1;
    var c = WG.cardById(deck[i]);
    if (!c) deckErrors += 1;
    else if (c.type === 'wide') wides += 1;
  }
  for (var id in counts) {
    if (counts[id] > 2) deckErrors += 1;
  }
  if (wides < wideMin) wideMin = wides;
  if (wides > wideMax) wideMax = wides;
}
ok(deckErrors === 0, '20 次随机牌组都恰好 30 张且同名 ≤2（异常 ' + deckErrors + ' 次）');
ok(wideMin >= 4 && wideMax <= 6, '宽幅卡张数落在 4-6（实测 ' + wideMin + '-' + wideMax + '）');

var digestErr = null;
try {
  var probe = WG.Engine.newGame({ decks: [UI.randomDeck(), UI.randomDeck()], names: ['\u4f60', '\u5bf9\u624b'], seed: 1 });
  if (!probe || probe.error) digestErr = new Error('引擎拒收随机牌组：' + (probe && probe.error));
} catch (e2) { digestErr = e2; }
ok(!digestErr, '引擎接受随机牌组' + (digestErr ? '：' + digestErr.message : ''));

// ============================================================
// 4. 开局 → 换牌 → 牌桌
// ============================================================
section('[4] 开局 → 换牌 → 牌桌');

var startErr = null;
try { UI.startMatch(UI.randomDeck()); } catch (e3) { startErr = e3; }
ok(!startErr, 'startMatch 不抛异常' + (startErr ? '：' + startErr.message : ''));

var S = UI.state;
ok(!!S.st, '引擎状态已建立');
ok(S.screen === 'mulligan', '进入换牌阶段');
ok(S.st.players[0].hand.length === 4, '起始手牌 4 张');
ok(appEl.innerHTML.indexOf('mull-card') >= 0, '换牌界面渲染出 4 张手牌');

var mullErr = null;
try {
  S.mull.sel[0] = true;
  UI.submitMulligan();
} catch (e4) { mullErr = e4; }
ok(!mullErr, '提交换牌不抛异常' + (mullErr ? '：' + mullErr.message : ''));
ok(S.screen === 'table', '换牌后进入牌桌');
ok(S.st.players[0].mulliganDone === true, '玩家换牌已标记完成');
ok(S.st.players[1].mulliganDone === true, 'AI 换牌已标记完成');
ok(appEl.innerHTML.indexOf('board') >= 0, '牌桌视图已渲染');
ok(appEl.innerHTML.indexOf('\u5b9a\u4e49\u724c') >= 0, '牌桌含「定义牌」位');
ok(appEl.innerHTML.indexOf('handzone') >= 0, '牌桌含手牌区');
ok(appEl.innerHTML.indexOf('logbox') >= 0, '牌桌含日志区');

// ---- 选牌 → 渲染高亮 不抛 ----
var selErr = null;
try {
  if (S.st.players[0].hand.length) {
    S.sel = 0;
    UI.render();
  }
} catch (e5) { selErr = e5; }
ok(!selErr, '选中手牌后重绘不抛异常' + (selErr ? '：' + selErr.message : ''));

// ============================================================
// 5. AI 回合
// ============================================================
section('[5] AI 回合');

var roundErr = null;
var rounds = 0;
try {
  for (var r = 0; r < 6; r += 1) {
    if (S.st.over) break;
    if (S.st.active !== 0) break;
    S.sel = -1;
    S.play = null;
    S.selUid = null;
    WG.Engine.endTurn(S.st, 0);
    rounds += 1;
    if (S.st.over) break;
    if (S.st.active !== 1) break;
    UI.autoAiTurn();
    if (S.st.active !== 0 && !S.st.over) break;
  }
} catch (e6) { roundErr = e6; }

ok(!roundErr, 'AI 回合推进不抛异常' + (roundErr ? '：' + (roundErr.stack || roundErr.message) : ''));
ok(rounds > 0, '至少完成 ' + rounds + ' 个回合的交接');
ok(!!S.st.over || S.st.active === 0, 'AI 回合结束后控制权回到玩家或对局结束');
ok(!!S.st.over || S.st.players[0].hp > 0, '玩家生命未被误判为零');
ok(S.st.log.length > 0, '日志有内容（' + S.st.log.length + ' 条）');

// 结束后再渲染一次（模拟结算浮层）
var overErr = null;
try { UI.render(); } catch (e7) { overErr = e7; }
ok(!overErr, '对局结束后渲染不抛异常' + (overErr ? '：' + overErr.message : ''));

// ============================================================
// 汇总
// ============================================================
console.log('\n' + (fails ? '\u2716' : '\u2714') + ' 结果：' + passes + ' 通过 / ' + fails + ' 失败');
if (fails) process.exit(1);
