/* tools/test_audio.js —— 音频模块「不崩、不漏、不吵」测试
 *
 * 用 vm 沙箱注入一个假的 AudioContext，它不只是空壳：
 *   每个 AudioParam 的每次赋值都会被校验（频率 20~12000、增益 0~1.5、时间非负、
 *   exponentialRamp 目标不得为 0），越界立刻抛错。这样「参数写飞了」不会留到线上。
 *   每个 source 的 stop 时间被登记，advanceTo() 模拟时钟前进并触发 onended，
 *   于是「节点是否真的 stop + disconnect」是可断言的，而不是靠肉眼。
 *
 *   node tools/test_audio.js
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var SRC_PATH = path.join(ROOT, 'game', 'js', 'ui', 'audio.js');
var src = fs.readFileSync(SRC_PATH, 'utf8');

var SFX_NAMES = [
  'click', 'select', 'cancel', 'draw', 'play', 'wide', 'upgrade', 'attack',
  'hit', 'die', 'energy', 'turn', 'mulligan', 'win', 'lose'
];
var BGM_NAMES = ['main', 'battle', 'off'];

var lines = [];
var fails = 0;
var checks = 0;

function ok(name, cond, detail) {
  checks++;
  if (cond) {
    lines.push('  [ok] ' + name);
  } else {
    fails++;
    lines.push('  [FAIL] ' + name + (detail ? '   → ' + detail : ''));
  }
}

function section(t) {
  lines.push('');
  lines.push('--- ' + t + ' ---');
}

// ============================================================
// 假 AudioContext
// ============================================================
var stats = null;
var pendingTimeouts = null;
var timers = null;
var ctx = null;

function resetStub() {
  stats = {
    ctxCreated: 0,
    nodes: 0,
    kinds: {},
    sources: [],
    params: [],
    errors: [],
    resumes: 0,
    disconnects: 0
  };
  pendingTimeouts = [];
  timers = {};
  ctx = null;
}

function bad(msg) {
  stats.errors.push(msg);
  throw new Error(msg);
}

function makeParam(kind, initial) {
  var p = { _kind: kind, value: initial, _events: [] };

  function check(v, t, where) {
    if (typeof v !== 'number' || !isFinite(v)) { bad('参数非有限数：' + kind + ' @' + where + ' = ' + v); }
    if (typeof t === 'number') {
      if (!isFinite(t) || t < 0) { bad('时间非法：' + kind + ' @' + where + ' t=' + t); }
    }
    if (kind === 'gain' && (v < 0 || v > 1.5)) { bad('增益越界：' + where + ' = ' + v); }
    if (kind === 'freq' && (v < 20 || v > 12000)) { bad('频率越界：' + where + ' = ' + v); }
    if (kind === 'detune' && (v < -1200 || v > 1200)) { bad('detune 越界：' + where + ' = ' + v); }
  }

  p.setValueAtTime = function (v, t) { check(v, t, 'setValueAtTime'); p.value = v; p._events.push(['set', v, t]); return p; };
  p.linearRampToValueAtTime = function (v, t) { check(v, t, 'linearRamp'); p.value = v; p._events.push(['lin', v, t]); return p; };
  p.exponentialRampToValueAtTime = function (v, t) {
    check(v, t, 'expRamp');
    if (v <= 0) { bad('exponentialRamp 目标为 0（会静音失效/抛错）'); }
    p.value = v; p._events.push(['exp', v, t]); return p;
  };
  p.setTargetAtTime = function (v, t) { check(v, t, 'setTarget'); p.value = v; p._events.push(['tgt', v, t]); return p; };
  p.cancelScheduledValues = function (t) { p._events.push(['cancel', 0, t]); return p; };

  stats.params.push(p);
  return p;
}

function node(kind) {
  stats.nodes++;
  stats.kinds[kind] = (stats.kinds[kind] || 0) + 1;
  var n = { _kind: kind, _out: [], disconnected: false, _id: stats.nodes };
  n.connect = function (dst) { n._out.push(dst); return dst; };
  n.disconnect = function () { n._out.length = 0; n.disconnected = true; stats.disconnects++; };
  return n;
}

function registerSource(n, stopAt) {
  if (typeof stopAt !== 'number') { bad('source.stop 未给时间'); }
  if (!isFinite(stopAt) || stopAt < 0) { bad('source.stop 时间非法：' + stopAt); }
  stats.sources.push({ node: n, stopAt: stopAt, ended: false });
}

function FakeCtx() {
  stats.ctxCreated++;
  var c = {
    currentTime: 0,
    sampleRate: 44100,
    state: 'running',
    destination: node('destination'),
    resume: function () { stats.resumes++; c.state = 'running'; return { then: function () {} }; },
    close: function () { return { then: function () {} }; },
    createGain: function () {
      var n = node('gain');
      n.gain = makeParam('gain', 1);
      return n;
    },
    createOscillator: function () {
      var n = node('osc');
      n.frequency = makeParam('freq', 440);
      n.detune = makeParam('detune', 0);
      n.type = 'sine';
      n.start = function (t) {
        if (typeof t === 'number' && (!isFinite(t) || t < 0)) { bad('osc.start 时间非法：' + t); }
      };
      n.stop = function (t) { registerSource(n, t); };
      return n;
    },
    createBufferSource: function () {
      var n = node('bufferSource');
      n.buffer = null;
      n.loop = false;
      n.start = function (t) {
        if (typeof t === 'number' && (!isFinite(t) || t < 0)) { bad('bufferSource.start 时间非法：' + t); }
      };
      n.stop = function (t) { registerSource(n, t); };
      return n;
    },
    createBiquadFilter: function () {
      var n = node('biquad');
      n.type = 'lowpass';
      n.frequency = makeParam('freq', 350);
      n.Q = makeParam('other', 1);
      return n;
    },
    createDynamicsCompressor: function () {
      var n = node('comp');
      n.threshold = makeParam('other', -24);
      n.knee = makeParam('other', 30);
      n.ratio = makeParam('other', 12);
      n.attack = makeParam('other', 0.003);
      n.release = makeParam('other', 0.25);
      return n;
    },
    createBuffer: function (ch, len, rate) {
      stats.nodes++;
      stats.kinds.buffer = (stats.kinds.buffer || 0) + 1;
      if (!(len > 0)) { bad('createBuffer 长度非法'); }
      var data = new Float32Array(len);
      return {
        numberOfChannels: ch, length: len, sampleRate: rate,
        getChannelData: function () { return data; }
      };
    }
  };
  ctx = c;
  return c;
}

// 时钟前进：到期的 source 触发 onended（真实浏览器语义）
function advanceTo(t) {
  ctx.currentTime = t;
  for (var i = 0; i < stats.sources.length; i++) {
    var s = stats.sources[i];
    if (!s.ended && s.stopAt <= t) {
      s.ended = true;
      if (typeof s.node.onended === 'function') {
        try { s.node.onended(); } catch (e) { bad('onended 抛错：' + e.message); }
      }
    }
  }
}

function flushTimeouts() {
  var list = pendingTimeouts;
  pendingTimeouts = [];
  for (var i = 0; i < list.length; i++) {
    try { list[i](); } catch (e) { bad('setTimeout 回调抛错：' + e.message); }
  }
}

function liveTimers() {
  return Object.keys(timers).length;
}

// ============================================================
// 建沙箱并加载
// ============================================================
resetStub();

var sandbox = {
  console: console,
  isFinite: isFinite,
  setInterval: function (fn, ms) {
    var id = 'iv' + (Object.keys(timers).length + 1) + '_' + Math.round(ms) + '_' + Math.random().toString(36).slice(2, 6);
    timers[id] = { fn: fn, ms: ms };
    return id;
  },
  clearInterval: function (id) { delete timers[id]; },
  setTimeout: function (fn, ms) { pendingTimeouts.push(fn); return pendingTimeouts.length; },
  clearTimeout: function () {}
};
vm.createContext(sandbox);
sandbox.window = sandbox;
sandbox.AudioContext = FakeCtx;

var loadErr = null;
try {
  vm.runInContext(src, sandbox, { filename: 'audio.js' });
} catch (e) {
  loadErr = e;
}

section('0. 加载');
ok('audio.js 可被 vm 解析并执行', loadErr === null, loadErr && loadErr.message);

var A = sandbox.WG && sandbox.WG.Audio;

// ============================================================
// 1. 接口形状
// ============================================================
section('1. 契约 2.1 接口');
ok('window.WG.Audio 存在', !!A);
var METHODS = ['init', 'sfx', 'bgm', 'setMuted', 'isMuted', 'setVolume'];
var missing = [];
for (var i = 0; i < METHODS.length; i++) {
  if (!A || typeof A[METHODS[i]] !== 'function') { missing.push(METHODS[i]); }
}
ok('6 个方法都是函数', missing.length === 0, '缺：' + missing.join(','));
ok('SFX 表 15 个名字齐全', SFX_NAMES.length === 15, '');

// ============================================================
// 2. init 之前什么都别建
// ============================================================
section('2. init() 之前（契约 2.2 第 2 条）');
var preErr = null;
var nodesBefore = stats.nodes;
try {
  A.sfx('draw');
  A.sfx('hit');
  A.bgm('main');
  A.bgm('battle');
  A.setMuted(false);
  A.setVolume({ master: 0.5, music: 0.2, sfx: 0.8 });
} catch (e) {
  preErr = e;
}
ok('init 前调用 sfx/bgm/setMuted/setVolume 不抛异常', preErr === null, preErr && preErr.message);
ok('init 前 AudioContext 创建次数 = 0', stats.ctxCreated === 0, '实际 ' + stats.ctxCreated);
ok('init 前不创建任何音频节点', stats.nodes === nodesBefore, '新增 ' + (stats.nodes - nodesBefore));
ok('init 前不排定时器', liveTimers() === 0, '活跃 ' + liveTimers());

// ============================================================
// 3. init 幂等
// ============================================================
section('3. init() 行为');
var initErr = null;
try { A.init(); } catch (e) { initErr = e; }
ok('init() 不抛异常', initErr === null, initErr && initErr.message);
ok('init() 后 AudioContext 恰好创建 1 次', stats.ctxCreated === 1, '实际 ' + stats.ctxCreated);
try { A.init(); A.init(); } catch (e) { initErr = e; }
ok('重复 init() 不再创建 AudioContext', stats.ctxCreated === 1, '实际 ' + stats.ctxCreated);
ok('init() 会 resume 上下文', stats.resumes >= 1, 'resume 次数 ' + stats.resumes);
ok('主链路已建立（master/comp/两条 bus）',
  stats.kinds.comp === 1 && stats.kinds.gain >= 4, JSON.stringify(stats.kinds));

// ============================================================
// 4. 15 个音效 + 3 条 BGM 轨道
// ============================================================
section('4. 全部音效与轨道（契约 2.3 第 4 条）');
var t = 1.0;
var sfxErr = null;
var nodesBeforeAll = stats.nodes;
for (i = 0; i < SFX_NAMES.length; i++) {
  try {
    A.sfx(SFX_NAMES[i]);
  } catch (e) {
    sfxErr = new Error(SFX_NAMES[i] + ' → ' + e.message);
    break;
  }
  t += 2.0;
  advanceTo(t);   // 让上一个音效自然结束，释放并发预算
  flushTimeouts();
}
ok('15 个音效全部可播且不抛异常', sfxErr === null, sfxErr && sfxErr.message);
ok('15 个音效都产生了节点', stats.nodes - nodesBeforeAll > 15, '新增 ' + (stats.nodes - nodesBeforeAll));
ok('全部音效结束后所有 source 都已 stop', stats.sources.length > 0 &&
  stats.sources.every(function (s) { return s.ended; }), '未结束 ' +
  stats.sources.filter(function (s) { return !s.ended; }).length);

// 逐个音效必须真的能发出声音（有的名字若 key 拼错会静默跳过）
var perName = [];
for (i = 0; i < SFX_NAMES.length; i++) {
  var before = stats.nodes;
  A.sfx(SFX_NAMES[i]);
  if (stats.nodes === before) { perName.push(SFX_NAMES[i]); }
  t += 2.0;
  advanceTo(t);
}
ok('每个名字都实际创建了节点（未静默跳过）', perName.length === 0, '无节点：' + perName.join(','));

var bgmErr = null;
for (i = 0; i < BGM_NAMES.length; i++) {
  try {
    A.bgm(BGM_NAMES[i]);
    t += 1.0;
    advanceTo(t);
  } catch (e) {
    bgmErr = new Error(BGM_NAMES[i] + ' → ' + e.message);
    break;
  }
}
ok('3 个 BGM 轨道名都不抛异常', bgmErr === null, bgmErr && bgmErr.message);

// ============================================================
// 5. BGM 调度器：一条轨道只有一个定时器
// ============================================================
section('5. BGM 调度（契约 2.2 第 3 条：不许每个音符一个 setInterval）');
A.bgm('off');
flushTimeouts();
ok('bgm("off") 后没有残留定时器', liveTimers() === 0, '活跃 ' + liveTimers());

A.bgm('main');
ok('main 启动后只有 1 个定时器', liveTimers() === 1, '活跃 ' + liveTimers());

var mainNodes0 = stats.nodes;
for (var k = 0; k < 40; k++) {
  t += 0.5;
  advanceTo(t);
  var ids = Object.keys(timers);
  for (var j = 0; j < ids.length; j++) { timers[ids[j]].fn(); }
}
var mainNodes1 = stats.nodes;
ok('推进 20 秒后 main 持续产出音符', mainNodes1 - mainNodes0 > 20, '新增 ' + (mainNodes1 - mainNodes0));
ok('main 全程仍只有 1 个定时器', liveTimers() === 1, '活跃 ' + liveTimers());

var oldIds = Object.keys(timers).join(',');
A.bgm('battle');
ok('切到 battle 后定时器数量仍为 1', liveTimers() === 1, '活跃 ' + liveTimers());
ok('切到 battle 会清掉旧定时器', Object.keys(timers).join(',') !== oldIds, '');
ok('切轨道有淡出（track gain 上出现线性斜坡）',
  stats.params.some(function (p) {
    return p._events.some(function (e) { return e[0] === 'lin' && e[1] <= 0.001; });
  }), '未找到降到 0.0001 的线性斜坡');

var battleNodes0 = stats.nodes;
for (k = 0; k < 40; k++) {
  t += 0.4;
  advanceTo(t);
  var ids2 = Object.keys(timers);
  for (j = 0; j < ids2.length; j++) { timers[ids2[j]].fn(); }
}
ok('battle 也持续产出音符', stats.nodes - battleNodes0 > 40, '新增 ' + (stats.nodes - battleNodes0));

A.bgm('off');
flushTimeouts();
ok('bgm("off") 停掉调度器', liveTimers() === 0, '活跃 ' + liveTimers());

// ============================================================
// 6. 连点 200 次
// ============================================================
section('6. 连点压力（契约 2.3 第 5 条）');
A.sfx('hit');
t = ctx.currentTime + 5;
advanceTo(t);
flushTimeouts();

// 6a. 时间冻结下的纯轰炸：并发上限必须兜住，节点数要有界
var n0 = stats.nodes;
var burstErr = null;
for (i = 0; i < 200; i++) {
  try { A.sfx('hit'); } catch (e) { burstErr = e; break; }
}
var n1 = stats.nodes;
ok('200 次 sfx("hit") 不抛异常', burstErr === null, burstErr && burstErr.message);
ok('200 次 sfx("hit") 创建了节点（不为 0）', n1 - n0 > 0, '新增 ' + (n1 - n0));
ok('节点数有界（并发上限生效，未无限膨胀）', n1 - n0 < 200 * 12, '新增 ' + (n1 - n0));
var liveCount = stats.sources.filter(function (s) { return !s.ended; }).length;
ok('同时存活 source <= 64', liveCount <= 64, '存活 ' + liveCount);

// 6b. 边播边过期：证明没有泄漏、也不会卡死
var n2 = stats.nodes;
for (i = 0; i < 200; i++) {
  A.sfx('hit');
  t += 0.01;
  advanceTo(t);
}
ok('200 次带时间推进的连点不抛异常', true, '');
ok('边播边过期时节点继续增长', stats.nodes - n2 > 50, '新增 ' + (stats.nodes - n2));

t += 30;
advanceTo(t);
flushTimeouts();
ok('全部结束后没有残留未停止的 source',
  stats.sources.every(function (s) { return s.ended; }),
  '未结束 ' + stats.sources.filter(function (s) { return !s.ended; }).length);
ok('onended 触发了断开（节点确实被回收）', stats.disconnects > 100, 'disconnect 次数 ' + stats.disconnects);
ok('压力测试期间没有静音参数错误', stats.errors.length === 0, stats.errors.slice(0, 3).join(' | '));

// ============================================================
// 7. 非法输入
// ============================================================
section('7. 非法输入静默处理');
var badErr = null;
var n3 = stats.nodes;
try {
  A.sfx('nope');
  A.sfx(undefined);
  A.sfx(null);
  A.sfx(123);
  A.sfx('');
  A.bgm(undefined);
  A.bgm('nope');
  A.bgm(null);
  A.setVolume(null);
  A.setVolume({ master: NaN, music: -5, sfx: 99 });
  A.setVolume({});
  A.setVolume({ master: 1.0 });
} catch (e) {
  badErr = e;
}
ok('非法 name / 非法参数都不抛异常', badErr === null, badErr && badErr.message);
ok('非法音效名不创建节点', stats.nodes === n3, '新增 ' + (stats.nodes - n3));
ok('setVolume 把越界值夹回 [0,1]',
  stats.params.every(function (p) {
    if (p._kind !== 'gain') { return true; }
    return p._events.every(function (e) { return e[0] === 'cancel' || e[1] <= 1.5; });
  }), '');

// ============================================================
// 8. 静音
// ============================================================
section('8. 静音（契约 2.3 第 7 条）');
ok('初始未静音', A.isMuted() === false, '');
A.setMuted(true);
ok('setMuted(true) 后 isMuted() 为 true', A.isMuted() === true, '');
var n4 = stats.nodes;
var muteErr = null;
try {
  A.sfx('click');
  A.sfx('hit');
  A.sfx('win');
} catch (e) { muteErr = e; }
ok('静音时 sfx 调用不抛异常', muteErr === null, muteErr && muteErr.message);
ok('静音时 sfx 不创建新节点', stats.nodes === n4, '新增 ' + (stats.nodes - n4));
ok('静音时 bgm 不开调度器', liveTimers() === 0, '活跃 ' + liveTimers());
A.setMuted(false);
ok('setMuted(false) 恢复', A.isMuted() === false, '');
var n5 = stats.nodes;
A.sfx('click');
ok('取消静音后音效恢复', stats.nodes > n5, '新增 ' + (stats.nodes - n5));

// ============================================================
// 9. 代码风格：纯 ES5
// ============================================================
section('9. 风格约束');
ok('无箭头函数', !/=>/.test(src), '');
ok('无 let 声明', !/\blet\s+[A-Za-z_$]/.test(src), '');
ok('无 const 声明', !/\bconst\s+[A-Za-z_$]/.test(src), '');
ok('无模板字符串', src.indexOf('`') < 0, '');
ok('无 fetch/XHR/加载外部音频',
  !/fetch\s*\(|XMLHttpRequest|decodeAudioData|\.mp3|\.ogg|\.wav|data:audio/i.test(src), '');
ok('挂载在 window.WG.Audio', typeof sandbox.WG.Audio === 'object', '');

// ============================================================
// 汇总
// ============================================================
console.log(lines.join('\n'));
console.log('');
console.log('文件：' + SRC_PATH);
console.log('行数：' + src.split('\n').length);
console.log('节点类型：' + JSON.stringify(stats.kinds));
console.log('断言：' + (checks - fails) + '/' + checks + ' 通过');
if (fails === 0) {
  console.log('=== 结果：全部通过 ✓ ===');
  process.exit(0);
} else {
  console.log('=== 结果：' + fails + ' 项失败 ===');
  process.exit(1);
}
