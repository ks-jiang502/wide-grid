/* game/js/ui/audio.js —— Wide-Grid 音频系统（全实时合成，零外部资源）
 *
 * 为什么这么设计：
 *   1. 游戏以 file:// 双击打开，任何 fetch/XHR 都会失败，所以音色只能靠振荡器 + 噪声算出来。
 *   2. AudioContext 必须在用户手势里创建，否则会被自动播放策略挂起并报警告，
 *      因此 init() 之前所有入口都只做「记状态」这件事，绝不 new AudioContext。
 *   3. 音效是「一次性事件」，BGM 是「长生命周期」——两者的节点管理策略不同：
 *      音效用一个前瞻调度器把节点排进时间轴，播完在 onended 里断链；
 *      BGM 用一个 setInterval 心跳 + 0.15s 前瞻批量排音，绝不给每个音符开定时器。
 *
 * 音色总原则（避免 8-bit 廉价感）：
 *   不用裸方波。主音色是 锯齿/三角 → 低通滤波 → ADSR 包络，
 *   打击类用「噪声 burst + 低频正弦下扫」叠冲击感，纸声用带通噪声 + 极短包络。
 *   噪声 buffer 只生成一次并缓存，200 次连点也只是复用同一块 PCM。
 */
(function (global) {
  'use strict';

  var WG = global.WG || (global.WG = {});
  if (WG.Audio) { return; }   // 重复加载时不覆盖已有实例，避免第二个 AudioContext

  var AC = global.AudioContext || global.webkitAudioContext;

  var TICK_MS = 60;        // 调度器心跳：比前瞻窗口小很多，够稳又不费 CPU
  var LOOKAHEAD = 0.15;    // 前瞻窗口（秒）——只在这个范围内排音，掉帧时不会堆积
  var FADE = 0.6;          // 契约要求的轨道切换淡入淡出
  var MAX_SFX_VOICES = 48; // 音效并发上限：超过就丢新的，宁可少一声也不要糊成一片
  var DEFAULT_VOL = { master: 0.6, music: 0.35, sfx: 0.9 };

  var state = {
    ctx: null,
    master: null,
    comp: null,
    sfxBus: null,
    musicBus: null,
    noise: null,
    muted: false,
    vol: { master: DEFAULT_VOL.master, music: DEFAULT_VOL.music, sfx: DEFAULT_VOL.sfx },
    desired: 'off',   // 意图轨道：init 前记下来，init 后自动接上
    tracks: {}
  };

  // 音效并发预算。为什么用模块级变量而不是闭包参数：
  // tone/noiseBurst 被 15 个音色函数共享，逐个传参会把签名弄得很难读。
  // 三个返回值是关键：onended 是异步的，到那时 inSfx 早就复位了，
  // 所以「这一声要不要归还配额」必须在创建时就定下来并随节点带过去。
  var RES_DROP = 0;   // 超预算，丢弃
  var RES_COUNT = 1;  // 占用一个音效配额，结束后归还
  var RES_FREE = 2;   // BGM 声部，不占音效配额
  var sfxLive = 0;
  var inSfx = false;

  // ============================================================
  // 小工具
  // ============================================================

  function now() {
    return state.ctx ? state.ctx.currentTime : 0;
  }

  function clamp(v, lo, hi) {
    v = Number(v);
    if (!isFinite(v)) { return lo; }
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function later(fn, ms) {
    if (global.setTimeout) {
      try { global.setTimeout(fn, ms); return; } catch (e) {}
    }
    fn();
  }

  function makeGain(v) {
    var g = state.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  // 一次发声的终结点：到期 stop，onended 里断开整条链。
  // 断开必须放在 onended 而不是立刻做，否则声音会被掐掉。
  function kill(nodes, src, stopAt, reserved) {
    try {
      src.onended = function () {
        for (var i = 0; i < nodes.length; i++) {
          try { nodes[i].disconnect(); } catch (e) {}
        }
        if (reserved === RES_COUNT && sfxLive > 0) { sfxLive--; }
      };
    } catch (e) {}
    try { src.stop(stopAt); } catch (e) {}
  }

  function reserve() {
    if (!inSfx) { return RES_FREE; }
    if (sfxLive >= MAX_SFX_VOICES) { return RES_DROP; }
    sfxLive++;
    return RES_COUNT;
  }

  // 噪声只算一次并缓存：白噪声纹理与种子绑定，每次打开游戏听起来一致
  function getNoise() {
    if (state.noise) { return state.noise; }
    var ctx = state.ctx;
    var rate = ctx.sampleRate || 44100;
    var len = Math.floor(rate * 1.5);
    var buf = ctx.createBuffer(1, len, rate);
    var data = buf.getChannelData(0);
    var seed = 987654321;
    for (var i = 0; i < len; i++) {
      // 线性同余伪随机：不用 Math.random，保证纹理可复现
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = seed / 0x3fffffff - 1;
    }
    state.noise = buf;
    return buf;
  }

  // ============================================================
  // 发声原语
  // ============================================================

  /* 振荡器声部。
   * o = { t0, dur, type, freq, to, peak, attack, dest, detune, filter:{type,freq,to,q} }
   * 有 filter 就走「振荡器 → 低通/带通 → 包络」，这是琴弦/鼓皮物理感的来源。 */
  function tone(o) {
    var reserved = reserve();
    if (reserved === RES_DROP) { return null; }

    var ctx = state.ctx;
    var t0 = o.t0;
    var dur = Math.max(o.dur, 0.02);
    var nodes = [];

    var src = ctx.createOscillator();
    src.type = o.type || 'sine';
    src.frequency.setValueAtTime(o.freq, t0);
    if (o.to && o.to !== o.freq && o.to > 0) {
      var glide = o.glide || 1;
      src.frequency.exponentialRampToValueAtTime(o.to, t0 + dur * glide);
    }
    if (o.detune) { src.detune.setValueAtTime(o.detune, t0); }
    nodes.push(src);

    var tail = src;
    if (o.filter) {
      var bq = ctx.createBiquadFilter();
      bq.type = o.filter.type || 'lowpass';
      bq.frequency.setValueAtTime(o.filter.freq, t0);
      if (o.filter.to && o.filter.to > 0) {
        bq.frequency.exponentialRampToValueAtTime(o.filter.to, t0 + dur);
      }
      bq.Q.value = o.filter.q || 1;
      src.connect(bq);
      nodes.push(bq);
      tail = bq;
    }

    var g = ctx.createGain();
    var atk = Math.max(o.attack || 0.005, 0.001);
    var pk = Math.max(o.peak || 0.2, 0.0002);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(pk, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    tail.connect(g);
    nodes.push(g);
    g.connect(o.dest || state.sfxBus);

    src.start(t0);
    kill(nodes, src, t0 + dur + 0.03, reserved);
    return src;
  }

  /* 滤波噪声：纸声、擦弦、鼓皮、洗牌全靠它。
   * o = { t0, dur, type, freq, to, q, peak, attack, dest } */
  function noiseBurst(o) {
    var reserved = reserve();
    if (reserved === RES_DROP) { return null; }

    var ctx = state.ctx;
    var t0 = o.t0;
    var dur = Math.max(o.dur, 0.02);

    var src = ctx.createBufferSource();
    src.buffer = getNoise();
    src.loop = true;

    var bq = ctx.createBiquadFilter();
    bq.type = o.type || 'bandpass';
    bq.frequency.setValueAtTime(o.freq || 1200, t0);
    if (o.to && o.to > 0) {
      bq.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    }
    bq.Q.value = o.q || 1;

    var g = ctx.createGain();
    var atk = Math.max(o.attack || 0.004, 0.001);
    var pk = Math.max(o.peak || 0.1, 0.0002);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(pk, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(bq);
    bq.connect(g);
    g.connect(o.dest || state.sfxBus);

    src.start(t0);
    kill([src, bq, g], src, t0 + dur + 0.03, reserved);
    return src;
  }

  // ============================================================
  // 15 个音效
  // ============================================================

  var SFX = {

    // 木质轻点：只留 30ms 的中高频，按键才不吵
    click: function (t0) {
      noiseBurst({ t0: t0, dur: 0.03, freq: 2400, q: 6, peak: 0.18, attack: 0.002 });
      tone({ t0: t0, dur: 0.045, type: 'triangle', freq: 1180, to: 720, peak: 0.1, attack: 0.002 });
    },

    // 轻敲玻璃杯：一根基音 + 两个非整数倍分音（玻璃是不谐和体，整数倍会像风琴）
    select: function (t0) {
      tone({ t0: t0, dur: 0.55, type: 'sine', freq: 587.33, peak: 0.22, attack: 0.004 });
      tone({ t0: t0, dur: 0.34, type: 'sine', freq: 1621.0, peak: 0.09, attack: 0.003 });
      tone({ t0: t0, dur: 0.2, type: 'sine', freq: 3172.0, peak: 0.045, attack: 0.002 });
      noiseBurst({ t0: t0, dur: 0.05, freq: 3200, q: 1.5, peak: 0.06, attack: 0.002 });
    },

    // select 的反向：同一套分音整体下行，听感是「收回去」
    cancel: function (t0) {
      tone({ t0: t0, dur: 0.28, type: 'sine', freq: 587.33, to: 349.23, peak: 0.18, attack: 0.005 });
      tone({
        t0: t0 + 0.008, dur: 0.22, type: 'triangle', freq: 1174.66, to: 698.46,
        peak: 0.06, attack: 0.004, filter: { type: 'lowpass', freq: 2600, q: 1 }
      });
      noiseBurst({ t0: t0, dur: 0.06, freq: 2600, to: 1100, q: 2, peak: 0.05, attack: 0.002 });
    },

    // 抽牌：纸张摩擦 = 带通噪声 + 6ms 起音 + 130ms 衰减，中心频率上滑模拟抽取方向
    draw: function (t0) {
      noiseBurst({ t0: t0, dur: 0.13, freq: 1400, to: 2600, q: 1.1, peak: 0.16, attack: 0.006 });
      noiseBurst({ t0: t0 + 0.02, dur: 0.09, freq: 5200, q: 2, peak: 0.07, attack: 0.004 });
    },

    // 部署单位：165→48Hz 的正弦下扫是「落子」的重量，纸声收在尾巴上
    play: function (t0) {
      tone({ t0: t0, dur: 0.22, type: 'sine', freq: 165, to: 48, peak: 0.42, attack: 0.006 });
      noiseBurst({ t0: t0, dur: 0.07, freq: 900, q: 0.8, peak: 0.12, attack: 0.003, type: 'lowpass' });
      noiseBurst({ t0: t0 + 0.012, dur: 0.05, freq: 3200, q: 1.4, peak: 0.05, attack: 0.002 });
    },

    // 宽幅卡：比 play 更低的铺底 + 五度/八度轻和声，低通缓慢收窄做出「铺开又收拢」
    wide: function (t0) {
      tone({ t0: t0, dur: 1.1, type: 'sine', freq: 73.42, to: 55, peak: 0.34, attack: 0.02 });
      tone({
        t0: t0, dur: 1.0, type: 'triangle', freq: 110, peak: 0.12, attack: 0.06, detune: -7,
        filter: { type: 'lowpass', freq: 620, q: 0.7 }
      });
      tone({
        t0: t0, dur: 0.9, type: 'sawtooth', freq: 164.81, peak: 0.07, attack: 0.08, detune: 6,
        filter: { type: 'lowpass', freq: 900, to: 380, q: 0.8 }
      });
      noiseBurst({ t0: t0, dur: 0.1, freq: 700, q: 0.6, peak: 0.09, attack: 0.004 });
    },

    // 强化：D5 F#5 A5 三音上行，三角波经低通下滑，像拨弦而不是叮咚
    upgrade: function (t0) {
      var notes = [587.33, 739.99, 880.0];
      for (var i = 0; i < notes.length; i++) {
        var st = t0 + i * 0.085;
        tone({
          t0: st, dur: 0.42, type: 'triangle', freq: notes[i], peak: 0.16, attack: 0.006,
          filter: { type: 'lowpass', freq: 3000, to: 1200, q: 1 }
        });
        tone({ t0: st, dur: 0.3, type: 'sine', freq: notes[i] * 2, peak: 0.05, attack: 0.006 });
      }
    },

    // 攻击：弓弦刮擦 = 带通噪声从 3400 扫到 700（Q 2.6，有明显的「擦」），
    // 再叠一条低通锯齿做琴身的木质共鸣
    attack: function (t0) {
      noiseBurst({ t0: t0, dur: 0.14, freq: 3400, to: 700, q: 2.6, peak: 0.24, attack: 0.004 });
      tone({
        t0: t0, dur: 0.13, type: 'sawtooth', freq: 330, to: 180, peak: 0.16, attack: 0.005,
        filter: { type: 'lowpass', freq: 2200, to: 700, q: 2 }
      });
    },

    // 受伤：低频撞击（140→52）+ 短噪声尾，全频段覆盖但都不长
    hit: function (t0) {
      tone({ t0: t0, dur: 0.13, type: 'sine', freq: 140, to: 52, peak: 0.36, attack: 0.003 });
      noiseBurst({ t0: t0, dur: 0.1, freq: 1800, to: 900, q: 1.2, peak: 0.16, attack: 0.002 });
      noiseBurst({ t0: t0, dur: 0.16, freq: 420, q: 0.7, peak: 0.1, attack: 0.004, type: 'lowpass' });
    },

    // 阵亡：下行滑音（锯齿经 1400→300 低通）+ 噪声散开，两条都往下走
    die: function (t0) {
      tone({
        t0: t0, dur: 0.5, type: 'sawtooth', freq: 300, to: 70, peak: 0.18, attack: 0.006,
        filter: { type: 'lowpass', freq: 1400, to: 300, q: 3 }
      });
      tone({ t0: t0 + 0.02, dur: 0.46, type: 'triangle', freq: 452, to: 105, peak: 0.1, attack: 0.01, detune: -9 });
      noiseBurst({ t0: t0 + 0.04, dur: 0.42, freq: 2400, to: 320, q: 0.9, peak: 0.14, attack: 0.02 });
    },

    // 能量：两个高频正弦（A6 / E7），峰值压到 0.09 以下，只在需要时轻轻一响
    energy: function (t0) {
      tone({ t0: t0, dur: 0.36, type: 'sine', freq: 1760, peak: 0.09, attack: 0.004 });
      tone({ t0: t0 + 0.03, dur: 0.3, type: 'sine', freq: 2637, peak: 0.055, attack: 0.004 });
    },

    // 回合切换：先一声翻页（噪声），再两声间隔定音（D3-A3-D4，然后升高八度）
    turn: function (t0) {
      noiseBurst({ t0: t0, dur: 0.16, freq: 1600, to: 3400, q: 1.2, peak: 0.1, attack: 0.01 });
      var low = [146.83, 220.0, 293.66];
      var high = [293.66, 440.0, 587.33];
      var i;
      for (i = 0; i < low.length; i++) {
        tone({
          t0: t0 + 0.06, dur: 0.7, type: 'triangle', freq: low[i], peak: 0.1, attack: 0.02,
          filter: { type: 'lowpass', freq: 2000, to: 900, q: 0.8 }
        });
        tone({
          t0: t0 + 0.26, dur: 0.55, type: 'triangle', freq: high[i], peak: 0.075, attack: 0.012,
          filter: { type: 'lowpass', freq: 3200, to: 1400, q: 0.8 }
        });
      }
    },

    // 洗牌：6 次极短带通噪声，间隔不均匀（55~65ms 抖动），才不像机器吐纸
    mulligan: function (t0) {
      var offs = [0, 0.055, 0.118, 0.17, 0.238, 0.298];
      for (var i = 0; i < offs.length; i++) {
        noiseBurst({
          t0: t0 + offs[i], dur: 0.06,
          freq: 1800 + (i % 3) * 900, to: 3000 + (i % 3) * 700,
          q: 1.4, peak: 0.09 + (i % 2) * 0.03, attack: 0.003
        });
      }
    },

    // 胜利：D 大调五声上行 D E F# A B D5，每音留 1.2s 以上尾巴，最后加 146.83 托底
    win: function (t0) {
      var notes = [293.66, 329.63, 369.99, 440.0, 493.88, 587.33];
      for (var i = 0; i < notes.length; i++) {
        var st = t0 + i * 0.11;
        var dur = 1.5 - i * 0.09;
        tone({
          t0: st, dur: dur, type: 'triangle', freq: notes[i], peak: 0.16, attack: 0.01,
          filter: { type: 'lowpass', freq: 4200, to: 1800, q: 0.8 }
        });
        tone({ t0: st, dur: dur * 0.66, type: 'sine', freq: notes[i] * 2, peak: 0.06, attack: 0.012 });
      }
      tone({ t0: t0 + 0.02, dur: 1.8, type: 'sine', freq: 146.83, peak: 0.12, attack: 0.08 });
    },

    // 失败：D 小调下行 A4 G4 F4 D4 A3（F 还原是小调色彩），尾巴明显比 win 短
    lose: function (t0) {
      var notes = [440.0, 392.0, 349.23, 293.66, 220.0];
      for (var i = 0; i < notes.length; i++) {
        var st = t0 + i * 0.13;
        var dur = 0.9 - i * 0.06;
        tone({
          t0: st, dur: dur, type: 'triangle', freq: notes[i], peak: 0.14, attack: 0.012,
          filter: { type: 'lowpass', freq: 1800, to: 700, q: 1.2 }
        });
      }
      tone({
        t0: t0, dur: 0.5, type: 'sawtooth', freq: 110, to: 55, peak: 0.1, attack: 0.02,
        filter: { type: 'lowpass', freq: 500, q: 0.7 }
      });
    }
  };

  // ============================================================
  // BGM：两条轨道共用一套「心跳 + 前瞻」调度
  // ============================================================

  // 和声走向固定四和弦。main 每和弦两小节，battle 每和弦一小节。
  var CHORDS = {
    main: [
      [146.83, 185.00, 220.00, 277.18],  // Dmaj7  D3 F#3 A3 C#4
      [123.47, 146.83, 185.00, 220.00],  // Bm7    B2 D3 F#3 A3
      [98.00, 123.47, 146.83, 185.00],   // Gmaj7  G2 B2 D3 F#3
      [110.00, 138.59, 164.81, 220.00]   // A      A2 C#3 E3 A3
    ],
    battle: [
      [146.83, 185.00, 220.00, 293.66],  // 战斗版把七音换成更硬的八度/五度叠置
      [123.47, 146.83, 185.00, 246.94],
      [98.00, 123.47, 146.83, 196.00],
      [110.00, 138.59, 164.81, 220.00]
    ]
  };

  // main 的稀疏拨弦点。刻意不对称、避开强拍：听过四遍也记不住旋律
  var MAIN_PLUCK = { 2: 2, 5: 3, 13: 1, 19: 2, 22: 3, 27: 0, 30: 2 };

  // pad 长音：线性起音→保持→指数收尾，起音占 22% 时长，两小节的和弦因此衔接自然
  function padNote(dest, t0, freq, dur, peak, cutoff, type, detune) {
    var ctx = state.ctx;
    var src = ctx.createOscillator();
    src.type = type || 'triangle';
    src.frequency.setValueAtTime(freq, t0);
    if (detune) { src.detune.setValueAtTime(detune, t0); }

    var bq = ctx.createBiquadFilter();
    bq.type = 'lowpass';
    bq.frequency.setValueAtTime(cutoff, t0);
    bq.Q.value = 0.6;

    var g = ctx.createGain();
    var atk = dur * 0.22;
    var rel = dur * 0.28;
    var hold = Math.max(atk, dur - rel);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(Math.max(peak, 0.0002), t0 + atk);
    g.gain.setValueAtTime(Math.max(peak, 0.0002), t0 + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(bq);
    bq.connect(g);
    g.connect(dest);
    src.start(t0);
    kill([src, bq, g], src, t0 + dur + 0.05, RES_FREE);
  }

  // 中频拨弦：三角波经下滑低通（琴弦张力感）+ 一个八度泛音点
  function bgmPluck(dest, t0, freq, dur, peak) {
    tone({
      t0: t0, dur: dur, type: 'triangle', freq: freq, peak: peak, attack: 0.008, dest: dest,
      filter: { type: 'lowpass', freq: freq * 6, to: freq * 1.6, q: 1.2 }
    });
    tone({ t0: t0, dur: dur * 0.8, type: 'sine', freq: freq * 2, peak: peak * 0.35, attack: 0.008, dest: dest });
  }

  /* main：72 BPM，step = 四分音符，32 步 = 8 小节。
   * 三个声部：低频 pad（4 声部，两小节一换）+ 稀疏拨弦 + 极轻空气声。
   * 没有主旋律 —— 这是刻意的，铺底音乐一旦有记忆点就会在第五分钟开始烦人。 */
  function scheduleMain(t, step, at) {
    var chords = CHORDS.main;
    var ci = Math.floor(step / 8) % chords.length;
    var chord = chords[ci];
    var beat = t.stepDur;
    var i;

    if (step % 8 === 0) {
      for (i = 0; i < chord.length; i++) {
        padNote(t.gain, at, chord[i], beat * 8 * 1.02,
          i === 0 ? 0.075 : 0.045, 820,
          i === 0 ? 'triangle' : 'sawtooth', i % 2 ? 6 : -6);
      }
      // 空气声：带通 5.2k、起音 2 秒的极小声，只在频谱最上面铺一层「空间」
      noiseBurst({
        t0: at, dur: beat * 8, freq: 5200, q: 0.6,
        peak: 0.012, attack: beat * 2.4, dest: t.gain
      });
    }

    if (MAIN_PLUCK[step] !== undefined) {
      bgmPluck(t.gain, at, chord[MAIN_PLUCK[step]] * 2, 0.7, 0.055);
    }
  }

  /* battle：96 BPM，step = 十六分音符，64 步 = 4 小节（每小节一和弦）。
   * 在 main 的铺底上加了每拍一下的低频脉冲、反拍擦声、和更密的拨弦。 */
  function scheduleBattle(t, step, at) {
    var chords = CHORDS.battle;
    var ci = Math.floor(step / 16) % chords.length;
    var chord = chords[ci];
    var beat = t.stepDur * 4;
    var i;

    if (step % 16 === 0) {
      for (i = 0; i < chord.length; i++) {
        padNote(t.gain, at, chord[i], beat * 4 * 0.98,
          i === 0 ? 0.07 : 0.04, 640,
          i === 0 ? 'sawtooth' : 'triangle', i % 2 ? 5 : -5);
      }
    }

    if (step % 4 === 0) {
      // 每拍一下的心跳：62→41Hz 短下扫，只 300ms，压在低频不抢中频
      tone({ t0: at, dur: 0.3, type: 'sine', freq: 62, to: 41, peak: 0.5, attack: 0.008, dest: t.gain });
      tone({
        t0: at, dur: 0.12, type: 'triangle', freq: 124, to: 82, peak: 0.16, attack: 0.005, dest: t.gain,
        filter: { type: 'lowpass', freq: 400, q: 0.7 }
      });
    }

    if (step % 4 === 2) {
      // 反拍高频擦声，45ms 的短噪声就是节奏层里「沙」的那部分
      noiseBurst({ t0: at, dur: 0.045, freq: 8600, q: 2.2, peak: 0.05, attack: 0.002, dest: t.gain });
    }

    if (step % 8 === 6) {
      var idx = (Math.floor(step / 8) + 1) % chord.length;
      bgmPluck(t.gain, at, chord[idx] * 2, 0.45, 0.06);
    }
  }

  function startTrack(name) {
    if (!state.ctx || state.muted || state.tracks[name]) { return; }
    if (name !== 'main' && name !== 'battle') { return; }

    var t = {
      name: name,
      gain: null,
      timer: null,
      nextTime: 0,
      step: 0,
      stepDur: 0,
      loopSteps: 0
    };

    var g = makeGain(0.0001);
    var t0 = now();
    // 淡入同样 0.6s，和淡出对得上，来回切换时音量曲线对称
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(1, t0 + FADE);
    g.connect(state.musicBus);
    t.gain = g;

    if (name === 'battle') {
      t.stepDur = 60 / 96 / 4;   // 十六分音符 0.15625s
      t.loopSteps = 64;
    } else {
      t.stepDur = 60 / 72;       // 四分音符 0.8333s
      t.loopSteps = 32;
    }

    t.nextTime = t0 + 0.1;
    state.tracks[name] = t;

    // 整条轨道只有这一个定时器，音符靠 while 循环批量排进前瞻窗口
    t.timer = global.setInterval(function () { tick(t); }, TICK_MS);
    tick(t);
  }

  function tick(t) {
    if (!state.ctx || !t.gain) { return; }
    try {
      // 掉队保护：切标签页回来时 currentTime 可能已经跳很远，别一口气补几百个音符
      if (t.nextTime < now() - 1) { t.nextTime = now() + 0.05; }
      var horizon = now() + LOOKAHEAD;
      var guard = 0;
      while (t.nextTime < horizon && guard < 64) {
        if (t.name === 'battle') { scheduleBattle(t, t.step, t.nextTime); }
        else { scheduleMain(t, t.step, t.nextTime); }
        t.nextTime += t.stepDur;
        t.step = (t.step + 1) % t.loopSteps;
        guard++;
      }
    } catch (e) {
      // 单个音符排失败不该让整条轨道停掉
    }
  }

  function stopTrack(name) {
    var t = state.tracks[name];
    if (!t) { return; }
    delete state.tracks[name];
    try { global.clearInterval(t.timer); } catch (e) {}

    var g = t.gain;
    var t0 = now();
    try {
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(g.gain.value, t0);      // 从当前值开始退，避免硬切爆音
      g.gain.linearRampToValueAtTime(0.0001, t0 + FADE);
    } catch (e) {}

    // 等淡出走完再断链，正在响的长音就会自然消失在 0.6s 里
    later(function () {
      try { g.disconnect(); } catch (e) {}
    }, (FADE + 0.25) * 1000);
  }

  // ============================================================
  // 音量
  // ============================================================

  function applyGains() {
    if (!state.ctx || !state.master) { return; }
    var t0 = now();
    var target = state.muted ? 0 : state.vol.master;
    try {
      var p = state.master.gain;
      p.cancelScheduledValues(t0);
      p.setValueAtTime(p.value, t0);
      p.linearRampToValueAtTime(target, t0 + 0.08);   // 静音也别硬切，80ms 足够听不出来
    } catch (e) {
      try { state.master.gain.value = target; } catch (e2) {}
    }
    try { state.musicBus.gain.value = state.vol.music; } catch (e) {}
    try { state.sfxBus.gain.value = state.vol.sfx; } catch (e) {}
  }

  function buildGraph() {
    var ctx = state.ctx;

    // 压缩器兜底：多个音效叠在一起时由它压住峰值，比单纯调小音量更不容易糊
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 3;
    comp.attack.value = 0.006;
    comp.release.value = 0.25;

    var master = makeGain(state.vol.master);
    var sfxBus = makeGain(state.vol.sfx);
    var musicBus = makeGain(state.vol.music);

    sfxBus.connect(comp);
    musicBus.connect(comp);
    comp.connect(master);
    master.connect(ctx.destination);

    state.comp = comp;
    state.master = master;
    state.sfxBus = sfxBus;
    state.musicBus = musicBus;
  }

  // ============================================================
  // 对外接口
  // ============================================================

  WG.Audio = {

    init: function () {
      try {
        if (state.ctx) {
          if (state.ctx.resume) { state.ctx.resume(); }
          return;
        }
        if (!AC) { return; }
        var ctx = new AC();
        state.ctx = ctx;
        buildGraph();
        if (ctx.resume) { ctx.resume(); }
        // init 前调用过 bgm 的意图在这里补上，这样界面可以在加载时就定好轨道
        if (state.desired !== 'off' && !state.muted) { startTrack(state.desired); }
      } catch (e) {
        // 音频不可用：整块状态清掉，后面所有调用自动静默，游戏照常跑
        state.ctx = null;
        state.master = null;
        state.comp = null;
        state.sfxBus = null;
        state.musicBus = null;
      }
    },

    sfx: function (name) {
      try {
        if (!state.ctx || state.muted) { return; }
        var fn = SFX[name];
        if (!fn) { return; }          // 未知名静默跳过，不抛也不排队
        inSfx = true;
        try {
          fn(now() + 0.01);
        } finally {
          inSfx = false;
        }
      } catch (e) {}
    },

    bgm: function (track) {
      try {
        track = String(track || 'off');
        if (track !== 'main' && track !== 'battle') { track = 'off'; }
        state.desired = track;
        if (!state.ctx) { return; }   // init 前只记意图，不建节点
        if (track !== 'off' && state.tracks[track]) { return; }
        stopTrack('main');
        stopTrack('battle');
        if (track !== 'off') { startTrack(track); }
      } catch (e) {}
    },

    setMuted: function (v) {
      try {
        state.muted = !!v;
        applyGains();
        if (state.muted) {
          // 静音时把轨道停掉，避免后台空转排音符
          stopTrack('main');
          stopTrack('battle');
        } else if (state.desired !== 'off') {
          startTrack(state.desired);
        }
      } catch (e) {}
    },

    isMuted: function () {
      try { return state.muted; } catch (e) { return false; }
    },

    setVolume: function (v) {
      try {
        if (!v) { return; }
        if (v.master !== undefined && v.master !== null) { state.vol.master = clamp(v.master, 0, 1); }
        if (v.music !== undefined && v.music !== null) { state.vol.music = clamp(v.music, 0, 1); }
        if (v.sfx !== undefined && v.sfx !== null) { state.vol.sfx = clamp(v.sfx, 0, 1); }
        applyGains();
      } catch (e) {}
    }
  };

})(typeof window !== 'undefined' ? window : this);
