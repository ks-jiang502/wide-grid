/* 卡面模块自测：覆盖 UI_ASSETS_API.md 第 1.4 节的 6 条断言。
 * 跑法：node tools/test_cardface.js
 *
 * 用 vm 沙箱按 index.html 的顺序加载 constants.js + cards.js + cardface.js，
 * 这样测的就是浏览器里真正会跑的那一份，而不是 require 出来的变体。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');

function load(rel, sandbox) {
  var p = path.join(ROOT, rel);
  var code = fs.readFileSync(p, 'utf8');
  vm.runInContext(code, sandbox, { filename: rel });
}

var sandbox = {
  console: console,
  window: {},
  Math: Math,
  isFinite: isFinite
};
sandbox.window.WG = {};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

load('game/js/engine/constants.js', sandbox);
load('game/js/data/cards.js', sandbox);
load('game/js/ui/cardface.js', sandbox);

var fails = [];
var passes = 0;

function ok(cond, msg) {
  if (cond) { passes++; return true; }
  fails.push(msg);
  return false;
}

var WG = sandbox.window.WG;
var CF = WG && WG.CardFace;

/* ── 1. 对象与方法存在 ───────────────────────────────────── */
(function () {
  ok(!!CF, 'WG.CardFace 不存在');
  if (!CF) return;
  ok(typeof CF.art === 'function', 'CardFace.art 不是函数');
  ok(typeof CF.thumb === 'function', 'CardFace.thumb 不是函数');
  ok(typeof CF.catStyle === 'function', 'CardFace.catStyle 不是函数');
})();

var CARDS = (WG && WG.CARDS) || [];
var CATS = ['演奏技法与节奏', '乐器演奏', '乐队编制与演奏岗位', '音乐理论与作曲',
  '录音、混音与电子音乐', '舞台与音乐制作'];

if (!CF) {
  console.log('致命：CardFace 缺失，后续断言跳过');
} else {

  /* ── 2. 100 张卡都能画，且不含坏值 ─────────────────────── */
  (function () {
    ok(CARDS.length === 100, '卡数据应为 100 张，实际 ' + CARDS.length);
    var bad = [];
    var badTokens = [];
    var empty = [];
    for (var i = 0; i < CARDS.length; i++) {
      var c = CARDS[i];
      var s = CF.art(c);
      if (typeof s !== 'string' || !s) { empty.push(c.id); continue; }
      if (s.indexOf('<svg') < 0) bad.push(c.id);
      if (/undefined|NaN|null/.test(s)) badTokens.push(c.id);
    }
    ok(empty.length === 0, 'art() 返回空的卡: ' + empty.join(','));
    ok(bad.length === 0, 'art() 不含 <svg 的卡: ' + bad.join(','));
    ok(badTokens.length === 0, 'art() 含 undefined/NaN/null 的卡: ' + badTokens.join(','));

    // thumb 也要能画
    var tEmpty = [];
    for (var j = 0; j < CARDS.length; j++) {
      var t = CF.thumb(CARDS[j]);
      if (typeof t !== 'string' || !t || t.indexOf('<svg') < 0 || /undefined|NaN|null/.test(t)) tEmpty.push(CARDS[j].id);
    }
    ok(tEmpty.length === 0, 'thumb() 异常的卡: ' + tEmpty.join(','));
  })();

  /* ── 3. 确定性：同一 id 两次结果完全一致 ────────────────── */
  (function () {
    var diff = [];
    for (var i = 0; i < CARDS.length; i++) {
      var c = CARDS[i];
      if (CF.art(c) !== CF.art(c)) diff.push(c.id);
      if (CF.thumb(c) !== CF.thumb(c)) diff.push('thumb' + c.id);
    }
    ok(diff.length === 0, '同一 id 两次渲染结果不同: ' + diff.join(','));
  })();

  /* ── 4. 6 个 cat 的 accent 互不相同 ────────────────────── */
  (function () {
    var seen = {}, dup = [];
    for (var i = 0; i < CATS.length; i++) {
      var st = CF.catStyle(CATS[i]);
      if (!st || typeof st.accent !== 'string') { dup.push(CATS[i] + '(缺失)'); continue; }
      if (!/^#[0-9a-fA-F]{6}$/.test(st.accent)) dup.push(CATS[i] + '(非十六进制)');
      if (seen[st.accent]) dup.push(CATS[i] + ' 与 ' + seen[st.accent] + ' 同色');
      seen[st.accent] = CATS[i];
      if (!st.deep || !st.pale || !st.motif) dup.push(CATS[i] + '(字段不全)');
    }
    ok(dup.length === 0, 'catStyle 问题: ' + dup.join('; '));
  })();

  /* ── 5. 输出长度在合理区间 ──────────────────────────────── */
  (function () {
    var tooShort = [], tooLong = [], total = 0;
    for (var i = 0; i < CARDS.length; i++) {
      var s = CF.art(CARDS[i]);
      total += s.length;
      if (s.length < 200) tooShort.push(CARDS[i].id + ':' + s.length);
      if (s.length > 20000) tooLong.push(CARDS[i].id + ':' + s.length);
    }
    ok(tooShort.length === 0, 'art() 过短(<200): ' + tooShort.join(','));
    ok(tooLong.length === 0, 'art() 过长(>20000): ' + tooLong.join(','));
    console.log('    art 平均长度 ' + Math.round(total / Math.max(1, CARDS.length)) + ' 字符');
  })();

  /* ── 6. opts 缺省 / 异常输入都不抛 ──────────────────────── */
  (function () {
    var threw = [];
    var cases = [
      function () { return CF.art(CARDS[0]); },
      function () { return CF.art(CARDS[0], undefined); },
      function () { return CF.art(CARDS[0], {}); },
      function () { return CF.art(CARDS[0], { w: 200, h: 280, variant: 'upgraded', side: 'opp' }); },
      function () { return CF.thumb(CARDS[0]); },
      function () { return CF.thumb(CARDS[0], { variant: 'upgraded' }); },
      function () { return CF.catStyle('不存在的分类'); },
      function () { return CF.art(null); },
      function () { return CF.art({}); },
      function () { return CF.art({ id: 999 }); },
      function () { return CF.art({ id: 1, cat: '未知', type: 'unit' }); },
      function () { return CF.thumb({ id: 5 }); }
    ];
    var texts = ['art()', 'art(undefined)', 'art({})', 'art(upgraded/opp)', 'thumb()',
      'thumb(upgraded)', 'catStyle(未知)', 'art(null)', 'art({})', 'art({id:999})',
      'art(未知cat)', 'thumb({id:5})'];
    for (var i = 0; i < cases.length; i++) {
      try {
        var r = cases[i]();
        // catStyle 返回对象，其余都返回 SVG 字符串
        var expect = texts[i].indexOf('catStyle') === 0 ? 'object' : 'string';
        if (typeof r !== expect) threw.push(texts[i] + ': 返回 ' + typeof r + '，应为 ' + expect);
      } catch (e) {
        threw.push(texts[i] + ': ' + e.message);
      }
    }
    ok(threw.length === 0, '缺省/异常输入出错: ' + threw.join(' | '));
  })();

  /* ── 补充自检：可区分性 ───────────────────────────────── */

  // 100 张卡的图形主体不能有重复（同 id 同图是对的，不同 id 同图是错的）
  (function () {
    var seen = {}, dup = [];
    for (var i = 0; i < CARDS.length; i++) {
      var s = CF.art(CARDS[i]);
      var key = s.replace(/<rect width="250" height="350"[^>]*\/>/, '');
      if (seen[key]) dup.push(CARDS[i].id + '==' + seen[key]);
      seen[key] = CARDS[i].id;
    }
    ok(dup.length === 0, '卡面重复: ' + dup.slice(0, 8).join(','));
  })();

  // 同一分类内部也不该撞脸（把同一张卡的两个不同结构特征当指纹）
  (function () {
    var byCat = {};
    for (var i = 0; i < CARDS.length; i++) {
      var c = CARDS[i];
      var k = c.type === 'wide' ? ('wide:' + c.wcat) : c.cat;
      (byCat[k] = byCat[k] || []).push(c);
    }
    var bad = [];
    for (var key in byCat) {
      if (!Object.prototype.hasOwnProperty.call(byCat, key)) continue;
      var list = byCat[key];
      var seen = {};
      for (var j = 0; j < list.length; j++) {
        var svg = CF.art(list[j]);
        // 只取几何数据的指纹（去掉颜色），避免"换了颜色就算不一样"
        var fp = svg.replace(/stroke="#[0-9a-f]{6}"/g, '')
          .replace(/fill="#[0-9a-f]{6}"/g, '')
          .replace(/opacity="[0-9.]+"/g, '')
          .replace(/\s+/g, '');
        if (seen[fp]) bad.push(key + ':' + list[j].id + '==' + seen[fp]);
        seen[fp] = list[j].id;
      }
    }
    ok(bad.length === 0, '同类撞脸: ' + bad.slice(0, 6).join(','));
  })();

  // 每个分类都得真的画出东西，不能有某一类空着
  (function () {
    var thin = [];
    for (var i = 0; i < CATS.length; i++) {
      var n = 0;
      for (var j = 0; j < CARDS.length; j++) if (CARDS[j].cat === CATS[i]) n++;
      if (n === 0) thin.push(CATS[i]);
    }
    ok(thin.length === 0, '分类无卡: ' + thin.join(','));
    var wideN = 0;
    for (var k = 0; k < CARDS.length; k++) if (CARDS[k].type === 'wide') wideN++;
    ok(wideN === 25, '宽幅卡应为 25 张，实际 ' + wideN);
  })();

  // 宽幅卡与单位卡的构图必须明显不同（粗基准线是宽幅卡的签名）
  (function () {
    var wideHasBar = 0, unitHasBar = 0, wideN = 0, unitN = 0;
    for (var i = 0; i < CARDS.length; i++) {
      var c = CARDS[i], s = CF.art(c);
      var bar = s.indexOf('stroke-width="2.2"') >= 0;
      if (c.type === 'wide') { wideN++; if (bar) wideHasBar++; }
      else { unitN++; if (bar) unitHasBar++; }
    }
    ok(wideN === wideHasBar, '有宽幅卡没画出贯通基准线: ' + (wideN - wideHasBar) + ' 张');
    ok(unitHasBar === 0, '单位卡误用了宽幅基准线: ' + unitHasBar + ' 张');
  })();
}

/* ── 结果 ─────────────────────────────────────────────────── */
console.log('');
if (fails.length === 0) {
  console.log('通过 ' + passes + ' 项断言');
  console.log('=== 结果：全部通过 ✓ ===');
  process.exit(0);
} else {
  console.log('失败 ' + fails.length + ' 项（通过 ' + passes + ' 项）：');
  for (var i = 0; i < fails.length; i++) console.log('  ✗ ' + fails[i]);
  console.log('=== 结果：失败 ✗ ===');
  process.exit(1);
}
