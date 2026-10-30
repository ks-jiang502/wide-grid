/* Wide-Grid · 卡面渲染（纯 SVG，零外部资源）
 *
 * 100 张卡没有任何美术素材，全部由这段代码现算。三条基本判断：
 *
 * 1. 按 cat 分 6 套「图形语言」而不是 6 套配色。卡缩到 60px 宽塞在场上时，
 *    颜色几乎看不出差别，能一眼归类的只有构成方式：横线密度、柱状、弧状、网格。
 *    所以六个分类的骨架分别是 节奏刻度轴 / 乐器线稿 / 站位矩阵 / 五线谱音级 /
 *    频谱柱 / 同心弧，配色只是第二层区分。
 *
 * 2. 一切随机都以 card.id 为种子。同一张卡在手牌、场上、预览、对手那边必须是同一幅画，
 *    用 Math.random 会让卡面每次重绘都在变，那就不像「一张牌」了。
 *
 * 3. 视觉语汇统一收在「乐谱纸 + 细墨线」里：米白底、1.0 上下的线、大量留白。
 *    不做渐变、发光、卡通描边 —— 这是项目现有的调子，卡面不能比它更响。
 *
 * 宽幅卡另有一套语言：一条贯穿全幅的粗基准线 + 一排重复单元 + 一层笼罩弧，
 * 说的是「一片区域被整片影响」，跟单位卡那种居中一个主体的构图必须一眼分得开。
 *
 * 文字一律不进 SVG：中文字体在 file:// 下不可控，字宽一错整幅构图就塌。
 */
(function (WG) {
  'use strict';

  if (!WG) return;

  var PAPER = '#f4f2ed';
  var INK = '#1b1a17';
  var SOFT = '#b8b1a3';

  /* 六个分类的主色。挑色标准：色相在环上均匀分开（红/赭/橄榄/绿/靛/紫），
     但饱和度压到 30% 上下 —— 像旧唱片封套上印的那一层墨，不能抢墨线。 */
  var CATS = {
    '演奏技法与节奏': { accent: '#9c2b22', deep: '#5e1a14', pale: '#efe0dc', motif: '节奏刻度' },
    '乐器演奏': { accent: '#8a5a2b', deep: '#513316', pale: '#efe4d6', motif: '乐器线稿' },
    '乐队编制与演奏岗位': { accent: '#6b6b28', deep: '#41411a', pale: '#eae8d6', motif: '站位点阵' },
    '音乐理论与作曲': { accent: '#5b4a7a', deep: '#352a4a', pale: '#e6e2ee', motif: '谱线音级' },
    '录音、混音与电子音乐': { accent: '#2f6d5e', deep: '#1b4137', pale: '#dfe9e4', motif: '频谱波形' },
    '舞台与音乐制作': { accent: '#34506b', deep: '#1e3040', pale: '#dee5ec', motif: '声场同心弧' }
  };

  /* 宽幅卡按 wcat 借一套色，图形语言另算（见 motifWide） */
  var WCATS = {
    '攻击增益': CATS['演奏技法与节奏'],
    '防护增益': CATS['舞台与音乐制作'],
    '资源辅助': CATS['乐队编制与演奏岗位'],
    '抽牌辅助': CATS['乐器演奏'],
    '牌库调整': CATS['录音、混音与电子音乐'],
    '跨区域协同': CATS['音乐理论与作曲']
  };

  var FALLBACK = CATS['演奏技法与节奏'];

  /* ─────────────────────────── 基础工具 ─────────────────────────── */

  /** 数值 → 短字符串。四舍五入到 2 位，顺手挡掉 NaN/Infinity 这种会毒化整串 SVG 的值 */
  function f(n) {
    if (!isFinite(n)) return '0';
    var v = Math.round(n * 100) / 100;
    return String(v);
  }

  /** 以 id 为种子的 xorshift32。返回可反复调用的 [0,1) 生成器 */
  function seeded(id) {
    var s = ((id | 0) * 2654435761) >>> 0;
    if (s === 0) s = 40503;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function rng(R, a, b) { return a + R() * (b - a); }

  function rint(R, a, b) {
    if (b < a) { var t = a; a = b; b = t; }
    if (b === a) return a;
    return a + Math.floor(R() * (b - a + 1));
  }

  /** 吸附到格。乐谱上的东西都在格上，这一手比任何随机都更「像手画的谱」 */
  function snap(v, g) { return Math.round(v / g) * g; }

  /** 圆弧路径。同心弧和宽幅卡拱罩都靠它 */
  function arcPath(cx, cy, r, a0, a1) {
    var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    var large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
    var sweep = a1 > a0 ? 1 : 0;
    return 'M' + f(x0) + ' ' + f(y0) + 'A' + f(r) + ' ' + f(r) + ' 0 ' + large + ' ' + sweep +
      ' ' + f(x1) + ' ' + f(y1);
  }

  function line(x1, y1, x2, y2, col, w, op) {
    return '<line x1="' + f(x1) + '" y1="' + f(y1) + '" x2="' + f(x2) + '" y2="' + f(y2) +
      '" stroke="' + col + '" stroke-width="' + f(w) + '"' +
      (op === undefined ? '' : ' opacity="' + f(op) + '"') + '/>';
  }

  function circle(cx, cy, r, fill, stroke, w, op) {
    return '<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(r) + '" fill="' + fill +
      '" stroke="' + (stroke || 'none') + '" stroke-width="' + f(w === undefined ? 0 : w) + '"' +
      (op === undefined ? '' : ' opacity="' + f(op) + '"') + '/>';
  }

  function rect(x, y, w, h, fill, stroke, sw, op) {
    return '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
      '" fill="' + (fill || 'none') + '" stroke="' + (stroke || 'none') + '" stroke-width="' +
      f(sw === undefined ? 0 : sw) + '"' + (op === undefined ? '' : ' opacity="' + f(op) + '"') + '/>';
  }

  /** 圆角矩形：电吉他那类方肩乐器靠它跟拨弦类的圆轮廓拉开 */
  function rrect(x, y, w, h, r, fill, stroke, sw, op) {
    return '<rect x="' + f(x) + '" y="' + f(y) + '" width="' + f(w) + '" height="' + f(h) +
      '" rx="' + f(r) + '" ry="' + f(r) + '" fill="' + (fill || 'none') + '" stroke="' +
      (stroke || 'none') + '" stroke-width="' + f(sw === undefined ? 0 : sw) + '"' +
      (op === undefined ? '' : ' opacity="' + f(op) + '"') + '/>';
  }

  function ellipse(cx, cy, rx, ry, fill, stroke, sw, op) {
    return '<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(rx) + '" ry="' + f(ry) +
      '" fill="' + (fill || 'none') + '" stroke="' + (stroke || 'none') + '" stroke-width="' +
      f(sw === undefined ? 0 : sw) + '"' + (op === undefined ? '' : ' opacity="' + f(op) + '"') + '/>';
  }

  /** 首尾相连的折线 */
  function poly(pts, col, w, op) {
    var d = [], i;
    for (i = 0; i < pts.length; i++) d.push((i ? 'L' : 'M') + f(pts[i][0]) + ' ' + f(pts[i][1]));
    return '<path d="' + d.join('') + '" fill="none" stroke="' + col + '" stroke-width="' + f(w) +
      '"' + (op === undefined ? '' : ' opacity="' + f(op) + '"') + '/>';
  }

  /* 全页共用的 defs：一块裁切（防止弧线画到纸外）和一张点阵底纹。
     id 固定，是因为同一页会有上百个 svg 各自定义一遍，内容相同就不会打架。 */
  function defs() {
    return '<defs>' +
      '<clipPath id="wgcfClip"><rect x="0" y="0" width="250" height="350"/></clipPath>' +
      '<pattern id="wgcfDot" width="9" height="9" patternUnits="userSpaceOnUse">' +
      '<circle cx="1.3" cy="1.3" r="0.62" fill="' + INK + '" opacity="0.3"/>' +
      '</pattern>' +
      '</defs>';
  }

  /* ───────────────────── 1. 演奏技法与节奏 · 节奏刻度 ───────────────────── */

  /* 一条时间轴 + 拍点刻度 + 一条节奏型。轴上方挂符头、符干、连梁和连音弧。
     子构型（单行/上下两声部/渐密）来自卡名本身的逻辑：断奏、轮指、渐强都是密度问题。 */
  function motifRhythm(R, st) {
    var g = [];
    var dp = st.deep, ac = st.accent;
    var x0 = 32, x1 = 218;
    var axisY = 206;
    var v = rint(R, 0, 2);
    var i;

    g.push(line(x0, axisY, x1, axisY, dp, 1.1, 0.92));

    var n = v === 2 ? rint(R, 11, 15) : rint(R, 9, 13);
    var xs = [];
    for (i = 0; i < n; i++) {
      var t = n > 1 ? i / (n - 1) : 0;
      if (v === 2) t = Math.pow(t, 1.5);       // 渐密：后半段越挤越急
      xs.push(x0 + (x1 - x0) * t);
    }

    // 拍点刻度：每四拍一根长的，像小节线
    for (i = 0; i < n; i++) {
      var tl = (i % 4 === 0) ? 7 : 4;
      g.push(line(xs[i], axisY, xs[i], axisY + tl, dp, 0.8, 0.7));
    }

    var accentIdx = rint(R, 0, n - 1);
    var rows = (v === 1) ? 1 : 0;

    for (var r = 0; r <= rows; r++) {
      var notes = [], k;
      var count = n;
      var topSpan = rows ? [16, 52] : [18, 66];
      for (k = 0; k < count; k++) {
        if (k > 0 && R() < 0.16) continue;
        var yy;
        if (rows && r === 1) {
          yy = axisY + rng(R, 20, 46);          // 下声部：低音
        } else {
          yy = axisY - rng(R, topSpan[0], topSpan[1]);
        }
        yy = snap(yy, 4);
        var rr = v === 2 ? 3.2 + 2.4 * (k / count) : rng(R, 3.4, 5);
        notes.push({
          x: xs[Math.min(xs.length - 1, k)],
          y: yy,
          r: rr,
          hole: R() < 0.32,
          stem: R() < 0.9,
          up: yy < axisY
        });
      }

      for (k = 0; k < notes.length; k++) {
        var o = notes[k];
        var hot = (r === 0 && k === accentIdx);
        var col = hot ? ac : dp;
        g.push(circle(o.x, o.y, o.r, o.hole ? PAPER : col, col, 1));
        if (o.stem) {
          var sx = o.x + (o.r - 0.5);
          g.push(line(sx, o.y, sx, o.y + (o.up ? -27 : 27), col, 1));
        }
      }

      // 连梁：相邻两个符干末端靠得够近就连上，这是「八分音符成组」的唯一视觉线索
      for (k = 0; k + 1 < notes.length; k++) {
        var a = notes[k], b = notes[k + 1];
        if (!a.stem || !b.stem || a.up !== b.up) continue;
        if (Math.abs(a.y - b.y) > 14) continue;
        if (R() < 0.35) continue;
        g.push('<path d="M' + f(a.x + a.r - 0.5) + ' ' + f(a.y + (a.up ? -27 : 27)) +
          'L' + f(b.x + b.r - 0.5) + ' ' + f(b.y + (b.up ? -27 : 27)) +
          '" stroke="' + dp + '" stroke-width="2.6" stroke-linecap="round" opacity="0.92"/>');
      }

      // 连音弧：挑两个不相邻的音符跨过去
      if (notes.length >= 4 && r === 0) {
        var ai = rint(R, 0, notes.length - 3);
        var bi = Math.min(notes.length - 1, ai + rint(R, 2, 3));
        if (bi > ai + 1) {
          var p = notes[ai], q = notes[bi];
          var mx = (p.x + q.x) / 2;
          var my = Math.min(p.y, q.y) - rng(R, 18, 30);
          g.push('<path d="M' + f(p.x) + ' ' + f(p.y - 5) + 'Q' + f(mx) + ' ' + f(my) + ' ' +
            f(q.x) + ' ' + f(q.y - 5) + '" fill="none" stroke="' + ac +
            '" stroke-width="0.9" opacity="0.85"/>');
        }
      }
    }

    // 左侧起点标记：两根渐短的竖线，替代谱号（不画具象符号）
    g.push(line(x0 - 9, axisY - 22, x0 - 9, axisY + 4, dp, 1.2, 0.8));
    g.push(line(x0 - 4.5, axisY - 14, x0 - 4.5, axisY + 4, dp, 0.9, 0.55));

    return g.join('');
  }

  /* ───────────────────── 2. 乐器演奏 · 极简线稿 ───────────────────── */

  /* 三组母题：键盘 / 拨弦 / 弓弦。都用 3~6 笔，且一定不闭合 ——
     闭合轮廓一多就变成卡通图标了，留个缺口才像速写。
     每件乐器都斜一点：手稿里的乐器没有一件是正着摆的，倾角也是相邻 id 最易拉开差别的地方。

     辨识度靠轮廓而不是靠细节：电吉他是方肩、原声是圆腰、贝斯更瘦长、
     提琴的腰更窄且一定配一根弓。缩到 60px 时细节全糊掉，只有轮廓还活着。 */
  function motifInstrument(R, st, id) {
    var g = [];
    var dp = st.deep, ac = st.accent;
    var tilt = rng(R, -5.5, 5.5);
    var i, j;
    g.push('<g transform="rotate(' + f(tilt) + ' 125 178)">');

    /* 键盘组 16-22：这 7 张若都按「键盘 + 面板」画，就只剩键数在变。
       所以每张给一个不同的琴体语言：正视图 / 俯视三角 / 立式箱 / 扁电钢 /
       合成器面板 / 接线合成器 / 模块机架。键数只是最后那点微差。 */
    if (id <= 22) {
      var kx0 = 32 + rng(R, -3, 3), kx1 = 218 + rng(R, -3, 3);
      var phase = rint(R, 0, 6);
      var pat = [1, 1, 0, 1, 1, 1, 0];

      var keys = function (tb, bb, hb, w0, w1, n) {
        var out = '';
        var ww = (w1 - w0) / n;
        var q, q2;
        out += rect(w0, tb, w1 - w0, bb - tb, PAPER, dp, 1.2);
        for (q = 0; q <= n; q++) out += line(w0 + q * ww, tb, w0 + q * ww, bb, dp, 0.8, 0.75);
        for (q2 = 0; q2 < n - 1; q2++) {
          if (!pat[(q2 + phase) % 7]) continue;
          out += rect(w0 + (q2 + 1) * ww - ww * 0.31, tb, ww * 0.62, hb - tb, dp, 'none', 0, 0.95);
        }
        return out;
      };

      if (id === 16) {
        // 钢琴独奏：正视键盘 + 谱架 + 三个踏瓣。一架琴、一个人，正对着你
        var kt = 176, kb = 236;
        g.push(keys(kt, kb, kt + (kb - kt) * 0.44, kx0, kx1, rint(R, 8, 12)));
        g.push(line(kx0 - 6, kb + 6, kx1 + 6, kb + 6, dp, 1.2, 0.85));
        var sy = 108 + rng(R, -8, 8);
        g.push(line(kx0 + 34, kt - 4, kx0 + 52, sy, dp, 0.9, 0.8));
        g.push(line(kx1 - 34, kt - 4, kx1 - 52, sy, dp, 0.9, 0.8));
        g.push(rect(kx0 + 46, sy - 16, (kx1 - kx0) - 92, 16, 'none', dp, 1, 0.9));
        for (i = 0; i < 3; i++) g.push(rect(110 + i * 15, kb + 18, 9, 7, dp, 'none', 0, 0.85));
      } else if (id === 17) {
        // 三角钢琴：俯视的等腰三角 + 内侧折线 + 三条腿，全组最张扬的一张
        var ty0 = 118 + rng(R, -6, 6), ty1 = 250;
        var wid = kx1 - kx0;
        g.push('<path d="M' + f(kx0) + ' ' + f(ty0) + 'L' + f(kx0 + wid * 0.6) + ' ' + f(ty0) +
          'Q' + f(kx0 + wid * 0.97) + ' ' + f(ty0 + 4) + ' ' + f(kx0 + wid * 0.9) + ' ' + f(ty0 + 48) +
          'L' + f(kx0 + wid * 0.64) + ' ' + f(ty1) + 'L' + f(kx0) + ' ' + f(ty1) +
          '" fill="' + PAPER + '" stroke="' + dp + '" stroke-width="1.3"/>');
        g.push('<path d="M' + f(kx0 + 8) + ' ' + f(ty0 + 14) + 'Q' + f(kx0 + wid * 0.48) + ' ' +
          f(ty0 + 22) + ' ' + f(kx0 + wid * 0.6) + ' ' + f(ty1 - 14) +
          '" fill="none" stroke="' + dp + '" stroke-width="0.8" opacity="0.6"/>');
        g.push(rect(kx0 + 4, ty1 - 32, wid * 0.58, 26, PAPER, dp, 1.1));
        for (i = 1; i < 8; i++) g.push(line(kx0 + 4 + i * wid * 0.0725, ty1 - 32, kx0 + 4 + i * wid * 0.0725, ty1 - 6, dp, 0.7, 0.7));
        for (i = 0; i < 3; i++) {
          g.push(line(kx0 + 22 + i * 34, ty1, kx0 + 22 + i * 34, ty1 + 16, dp, 1.1, 0.8));
          g.push(circle(kx0 + 22 + i * 34, ty1 + 18, 2, dp, 'none', 0));
        }
      } else if (id === 18) {
        // 立式钢琴：高箱体 + 上部谱架横板 + 键盘在中下 + 两条前腿
        var bx0 = kx0 - 6, bx1 = kx1 + 6;
        g.push(rect(bx0, 128, bx1 - bx0, 116, 'none', dp, 1.3, 0.95));
        g.push(rect(bx0 + 10, 140, bx1 - bx0 - 20, 12, 'none', dp, 0.8, 0.7));
        g.push(keys(196, 232, 212, bx0 + 12, bx1 - 12, rint(R, 9, 12)));
        g.push(line(bx0 + 4, 180, bx1 - 4, 180, dp, 0.9, 0.6));
        g.push(line(bx0 + 14, 244, bx0 + 14, 272, dp, 1.3, 0.85));
        g.push(line(bx1 - 14, 244, bx1 - 14, 272, dp, 1.3, 0.85));
      } else if (id === 19) {
        // 电钢琴：扁长箱体 + 两侧木边 + X 支架，重心比立式低一截
        var ex0 = kx0 - 4, ex1 = kx1 + 4;
        g.push(rect(ex0, 168, ex1 - ex0, 50, 'none', dp, 1.2, 0.95));
        g.push(line(ex0 + 8, 168, ex0 + 8, 218, dp, 1.6, 0.85));
        g.push(line(ex1 - 8, 168, ex1 - 8, 218, dp, 1.6, 0.85));
        g.push(keys(178, 208, 192, ex0 + 14, ex1 - 14, rint(R, 9, 12)));
        g.push(line(ex0 + 34, 218, ex1 - 62, 270, dp, 1.1, 0.8));
        g.push(line(ex1 - 34, 218, ex0 + 62, 270, dp, 1.1, 0.8));
      } else if (id === 20) {
        // 合成器：面板 + 一排旋钮，指针角度全部随机
        var py = 104 + rng(R, -6, 6), ph = 50 + rng(R, -6, 8);
        g.push(rect(kx0, py, kx1 - kx0, ph, 'none', dp, 1, 0.9));
        var kn = rint(R, 4, 6);
        for (i = 0; i < kn; i++) {
          var cx = kx0 + (kx1 - kx0) * (i + 0.5) / kn;
          var cy = py + ph * 0.55;
          var kr = rng(R, 5.5, 8);
          g.push(circle(cx, cy, kr, 'none', dp, 0.9, 0.9));
          var ka = rng(R, -2.6, -0.4);
          g.push(line(cx, cy, cx + kr * 0.82 * Math.cos(ka), cy + kr * 0.82 * Math.sin(ka), ac, 1, 1));
        }
        g.push(keys(186, 238, 202, kx0, kx1, rint(R, 9, 13)));
      } else if (id === 21) {
        // 模拟合成器：面板 + 三条甩出去的接线（patch cord），这是它独有的特征
        var ay = 104 + rng(R, -4, 4);
        g.push(rect(kx0, ay, kx1 - kx0, 44, 'none', dp, 1, 0.9));
        for (i = 0; i < 3; i++) {
          var px0 = kx0 + 26 + i * 40, px1 = kx0 + 100 + i * 28;
          g.push('<path d="M' + f(px0) + ' ' + f(ay + 38) + 'C' + f(px0 - 8) + ' ' + f(ay + 82) +
            ' ' + f(px1 + 26) + ' ' + f(ay + 90) + ' ' + f(px1) + ' ' + f(ay + 8) +
            '" fill="none" stroke="' + ac + '" stroke-width="1.1" opacity="0.85"/>');
          g.push(circle(px0, ay + 38, 2.2, ac, 'none', 0, 0.9));
          g.push(circle(px1, ay + 8, 2.2, ac, 'none', 0, 0.9));
        }
        for (i = 0; i < 3; i++) g.push(circle(kx0 + 30 + i * 38, ay + 18, rng(R, 4.5, 6.5), 'none', dp, 0.9, 0.9));
        g.push(keys(188, 238, 204, kx0, kx1, rint(R, 9, 12)));
      } else {
        // 模块合成器：4×3 模块格子，每格旋钮 + 一格跳线孔 —— 一整面机架
        var mx0 = kx0, mw = (kx1 - kx0) / 4;
        var my0 = 94 + rng(R, -6, 6), mh = 34 + rng(R, -4, 4);
        for (j = 0; j < 3; j++) {
          for (i = 0; i < 4; i++) {
            var gx = mx0 + i * mw, gy = my0 + j * mh;
            g.push(rect(gx + 1.5, gy + 1.5, mw - 3, mh - 3, 'none', dp, 0.85, 0.85));
            g.push(circle(gx + mw * 0.3, gy + mh * 0.42, 3.2, 'none', dp, 0.7, 0.8));
            g.push(circle(gx + mw * 0.66, gy + mh * 0.42, 2.2, R() < 0.5 ? ac : PAPER, dp, 0.6, 0.8));
            g.push(line(gx + mw * 0.22, gy + mh * 0.76, gx + mw * 0.74, gy + mh * 0.76, dp, 0.6, 0.5));
          }
        }
        g.push(keys(202, 246, 218, kx0, kx1, rint(R, 9, 12)));
      }
      g.push('</g>');
      return g.join('');
    }

    /* 拨弦组 23-26：轮廓就得分得开 ——
       23 方肩电吉他（圆角矩形）、24 圆腰原声（双椭圆 + 大音孔）、
       25 瘦长贝斯（无音孔，长拾音器）、26 五弦贝斯（更瘦更长颈，双拾音器）。 */
    if (id <= 26) {
      var elec = (id === 23);
      var cxg = 125 + rng(R, -3, 3);
      var rxb = rng(R, 44, 52) * (id === 26 ? 0.66 : (id === 25 ? 0.82 : 1));
      var ryb = rng(R, 50, 60) * (id === 26 ? 1.08 : (id === 25 ? 0.98 : 1));
      var upy = 148 + rng(R, -8, 8);
      var boty = 220 + rng(R, -6, 6);
      var ns = id === 26 ? 5 : (id === 25 ? 4 : 6);
      var neckTop = id === 26 ? rng(R, 26, 36) : (id === 25 ? rng(R, 46, 58) : rng(R, 64, 82));
      var nw = rng(R, 12, 15) * (id >= 25 ? 0.92 : 1);

      if (elec) {
        var bw1 = rxb * 1.62, bh1 = ryb * 1.46;
        g.push(rrect(cxg - bw1 / 2, boty - bh1 / 2, bw1, bh1, rng(R, 12, 20), PAPER, dp, 1.2));
        var bw2 = rxb * 1.34, bh2 = ryb * 1.5;
        g.push(rrect(cxg - bw2 / 2, upy - bh2 / 2 + 8, bw2, bh2, rng(R, 10, 16), PAPER, dp, 1.2));
        g.push(rrect(cxg - bw1 * 0.22, boty - 10, bw1 * 0.44, 26, 3, 'none', ac, 0.7, 0.6));
        g.push(rect(cxg - bw2 * 0.26, upy + 14, bw2 * 0.52, 7, dp, 'none', 0, 0.85));
        g.push(rect(cxg - bw2 * 0.26, upy + 28, bw2 * 0.52, 7, dp, 'none', 0, 0.85));
        g.push('<path d="M' + f(cxg + bw1 * 0.26) + ' ' + f(boty + 6) + 'q16 -4 22 -18' +
          '" fill="none" stroke="' + dp + '" stroke-width="1" opacity="0.85"/>');
        g.push(circle(cxg + bw1 * 0.26, boty + 6, 2, dp, 'none', 0));
      } else {
        g.push(ellipse(cxg, boty, rxb, ryb, PAPER, dp, 1.2));
        g.push(ellipse(cxg, upy, rxb * 0.72, rng(R, 38, 50), PAPER, dp, 1.2));
        if (id === 24) {
          // 原声：大音孔 + 护板弧（唯一的圆孔）
          var holeR = rng(R, 10, 14);
          g.push(circle(cxg, boty - rng(R, 4, 18), holeR, PAPER, dp, 1));
          g.push(circle(cxg, holeR > 0 ? boty - 10 : boty, holeR + 4, 'none', ac, 0.6, 0.5));
          g.push('<path d="' + arcPath(cxg, boty - 10, holeR + 14, 0.35, 2.25) +
            '" fill="none" stroke="' + ac + '" stroke-width="0.65" opacity="0.65"/>');
        } else {
          // 贝斯：无音孔，改长条拾音器（26 两条）
          g.push(rect(cxg - rxb * 0.34, boty + ryb * 0.36, rxb * 0.68, 6, dp, 'none', 0, 0.9));
          if (id === 26) g.push(rect(cxg - rxb * 0.34, boty + ryb * 0.16, rxb * 0.68, 6, dp, 'none', 0, 0.9));
        }
      }

      // 琴颈 + 品丝 + 弦轴箱 + 弦
      g.push(rect(cxg - nw / 2, neckTop, nw, (elec ? upy - 16 : upy - 10) - neckTop, 'none', dp, 1));
      var fret = rint(R, 3, 7);
      for (i = 1; i <= fret; i++) {
        var fy = neckTop + 5 + ((elec ? upy - 24 : upy - 18) - neckTop) * i / (fret + 1);
        g.push(line(cxg - nw / 2, fy, cxg + nw / 2, fy, dp, 0.6, 0.55));
      }
      g.push(rrect(cxg - nw * 0.82, neckTop - 17, nw * 1.64, 17, 2, 'none', dp, 0.95, 0.95));
      for (i = 0; i < ns; i++) {
        var tx = cxg - nw * 0.66 + (nw * 1.32) * (ns === 1 ? 0.5 : i / (ns - 1));
        g.push(circle(tx, neckTop - 9, 1.7, dp, 'none', 0));
      }
      var bridgeY = boty + ryb * 0.44;
      for (i = 0; i < ns; i++) {
        var sx2 = cxg - nw * 0.3 + (nw * 0.6) * (ns === 1 ? 0.5 : i / (ns - 1));
        g.push(line(sx2, neckTop - 2, sx2, bridgeY, dp, 0.55, 0.8));
      }
      g.push(line(cxg - rxb * 0.5, bridgeY, cxg + rxb * 0.5, bridgeY, dp, 1.3, 0.9));
      g.push('</g>');
      return g.join('');
    }

    /* 弓弦组 27-30：用 C 形收腰的闭合轮廓 —— 双椭圆做不出琴腰，
       而琴腰正是提琴和吉他轮廓上最大的一处不同。再加一根长弓。 */
    var cxs = 125 + rng(R, -3, 3);
    var big = (id === 30) ? 1.14 : 1;
    var topY = ((id === 30) ? 92 : 112) + rng(R, -6, 6);
    var botY = ((id === 30) ? 266 : 246) + rng(R, -6, 6);
    var midY = (topY + botY) / 2 + rng(R, -5, 5);
    var hw = rng(R, 29, 34) * big;
    var waist = hw * rng(R, 0.5, 0.6);
    var hB = hw * rng(R, 1.0, 1.1);
    var halfMid = (midY - topY) * 0.6;
    var halfMid2 = (botY - midY) * 0.44;

    g.push('<path d="M' + f(cxs) + ' ' + f(topY) +
      'C' + f(cxs - hw * 1.08) + ' ' + f(topY) + ' ' + f(cxs - hw) + ' ' + f(topY + halfMid) + ' ' + f(cxs - waist) + ' ' + f(midY) +
      'C' + f(cxs - hw) + ' ' + f(midY + halfMid2) + ' ' + f(cxs - hB * 1.08) + ' ' + f(botY) + ' ' + f(cxs) + ' ' + f(botY) +
      'C' + f(cxs + hB * 1.08) + ' ' + f(botY) + ' ' + f(cxs + hw) + ' ' + f(midY + halfMid2) + ' ' + f(cxs + waist) + ' ' + f(midY) +
      'C' + f(cxs + hw) + ' ' + f(topY + halfMid) + ' ' + f(cxs + hw * 1.08) + ' ' + f(topY) + ' ' + f(cxs) + ' ' + f(topY) + 'Z' +
      '" fill="' + PAPER + '" stroke="' + dp + '" stroke-width="1.3"/>');

    // 一对 f 孔：写在收腰以下的两侧，是最认得出来的提琴细节
    var fy0 = midY + (botY - midY) * rng(R, 0.16, 0.3);
    var fyl = (botY - midY) * rng(R, 0.34, 0.44);
    var fdx = waist * rng(R, 1.05, 1.28);
    g.push('<path d="M' + f(cxs - fdx) + ' ' + f(fy0) + 'C' + f(cxs - fdx - 8) + ' ' + f(fy0 + fyl * 0.35) +
      ' ' + f(cxs - fdx + 5) + ' ' + f(fy0 + fyl * 0.55) + ' ' + f(cxs - fdx - 1) + ' ' + f(fy0 + fyl) +
      '" fill="none" stroke="' + dp + '" stroke-width="1.3" stroke-linecap="round"/>');
    g.push('<path d="M' + f(cxs + fdx) + ' ' + f(fy0) + 'C' + f(cxs + fdx + 8) + ' ' + f(fy0 + fyl * 0.35) +
      ' ' + f(cxs + fdx - 5) + ' ' + f(fy0 + fyl * 0.55) + ' ' + f(cxs + fdx + 1) + ' ' + f(fy0 + fyl) +
      '" fill="none" stroke="' + dp + '" stroke-width="1.3" stroke-linecap="round"/>');
    g.push(circle(cxs - fdx, fy0, 1.8, dp, 'none', 0));
    g.push(circle(cxs + fdx, fy0, 1.8, dp, 'none', 0));

    // 琴马 + 尾板三角 + 细颈 + 涡卷琴头
    g.push(line(cxs - 13, midY + (botY - midY) * 0.52, cxs + 13, midY + (botY - midY) * 0.52, dp, 1.7, 0.92));
    g.push('<path d="M' + f(cxs - 7) + ' ' + f(botY - 8) + 'l7 12 7 -12z' +
      '" fill="none" stroke="' + dp + '" stroke-width="1" opacity="0.9"/>');
    var nws = rng(R, 6, 8);
    var nts = topY - rng(R, 40, 56);
    g.push(rect(cxs - nws / 2, nts, nws, topY - nts, 'none', dp, 1));
    g.push(rrect(cxs - nws * 0.95, nts - 15, nws * 1.9, 15, 2, 'none', dp, 1, 0.95));
    g.push('<path d="M' + f(cxs + nws * 0.95) + ' ' + f(nts - 13) + 'a7 7 0 1 1 -9 -6' +
      '" fill="none" stroke="' + dp + '" stroke-width="1.2" opacity="0.95"/>');
    for (i = 0; i < 4; i++) {
      var qx = cxs - nws * 0.34 + (nws * 0.68) * i / 3;
      g.push(line(qx, nts + 3, qx, midY + (botY - midY) * 0.52, dp, 0.55, 0.8));
    }
    if (id === 30) {
      g.push(line(cxs, botY - 2, cxs, 300, dp, 1.4, 0.9));
      g.push(line(cxs - 9, 300, cxs + 9, 300, dp, 1.4, 0.9));
    }

    // 弓：一根长直线斜跨整件乐器，弓根一个短块 —— 与拨弦组最强的区别
    var abx = 34 + rng(R, -6, 6), aby = 274 + rng(R, -10, 10);
    g.push(line(abx, aby, abx + 196, aby - 158, dp, 1.15, 0.85));
    g.push(line(abx + 8, aby - 6, abx + 186, aby - 148, dp, 0.5, 0.5));
    g.push(rrect(abx - 4, aby - 8, 12, 13, 1.5, dp, 'none', 0, 0.9));
    g.push('</g>');
    return g.join('');
  }
  /* ─────────────────── 3. 乐队编制与演奏岗位 · 站位点阵 ─────────────────── */

  /* 3 列 × 2 行的格子，正好是游戏的 3 个攻击区域 × 每区 2 个槽位。
     被占的格子里放实心记号，其余留空描边 —— 空位本身也是信息。
     三列之间留出更宽的间隔并画一条区域分隔刻度，让「区域」这一层读得出来。 */
  function motifBoard(R, st) {
    var g = [];
    var dp = st.deep, ac = st.accent, pa = st.pale;
    var cols = 3, rows = 2;
    var cw = 42 + rng(R, -3, 3), ch = 42 + rng(R, -3, 3), gx = 26, gy = 30;
    var x0 = (250 - (cols * cw + (cols - 1) * gx)) / 2;
    var y0 = 128;
    var shape = rint(R, 0, 4);
    var i, j, cells = [];

    // 区域中线：三组之间的分隔，比格子淡一档
    for (i = 1; i < cols; i++) {
      var sx = x0 + i * (cw + gx) - gx / 2;
      g.push(line(sx, y0 - 12, sx, y0 + rows * ch + (rows - 1) * gy + 12, SOFT, 0.8, 0.9));
    }

    for (j = 0; j < rows; j++) {
      for (i = 0; i < cols; i++) {
        var cx = x0 + i * (cw + gx), cy = y0 + j * (ch + gy);
        g.push(rect(cx, cy, cw, ch, 'none', dp, 0.95, 0.85));
        g.push(line(cx + 4, cy + 4, cx + 4, cy + 10, dp, 0.7, 0.45));
        cells.push({ x: cx, y: cy, cx: cx + cw / 2, cy: cy + ch / 2, on: false });
      }
    }

    var k = rint(R, 2, 5);
    for (i = 0; i < k; i++) {
      var idx = rint(R, 0, cells.length - 1);
      if (cells[idx].on) continue;
      cells[idx].on = true;
      var c = cells[idx];
      if (shape === 0) {
        g.push(rect(c.cx - 9, c.cy - 9, 18, 18, dp, 'none', 0));
      } else if (shape === 1) {
        g.push(circle(c.cx, c.cy, 10, pa, ac, 1.1));
        g.push(circle(c.cx, c.cy, 3.4, ac, 'none', 0));
      } else if (shape === 2) {
        for (j = -1; j <= 1; j++) g.push(line(c.cx - 12, c.cy + j * 6, c.cx + 12, c.cy + j * 6, dp, 1.8, 0.92));
      } else if (shape === 3) {
        g.push(line(c.cx - 10, c.cy, c.cx + 10, c.cy, dp, 1.8, 0.9));
        g.push(line(c.cx, c.cy - 10, c.cx, c.cy + 10, dp, 1.8, 0.9));
        g.push(circle(c.cx, c.cy, 3, ac, 'none', 0));
      } else {
        // 第五种：上下两条短杠，像谱面上的「同音反复」
        g.push(line(c.cx - 8, c.cy - 5, c.cx + 8, c.cy - 5, dp, 2.4, 0.92));
        g.push(line(c.cx - 8, c.cy + 5, c.cx + 8, c.cy + 5, dp, 2.4, 0.92));
        g.push(circle(c.cx, c.cy, 2.6, ac, 'none', 0));
      }
    }

    // 协同虚线：把两个被占的格子连起来，表示声部之间的关系
    var has = [];
    for (i = 0; i < cells.length; i++) if (cells[i].on) has.push(cells[i]);
    if (has.length >= 2 && R() < 0.8) {
      var p = has[0], q = has[has.length - 1];
      g.push('<path d="M' + f(p.cx) + ' ' + f(p.cy) + 'L' + f(q.cx) + ' ' + f(q.cy) +
        '" stroke="' + ac + '" stroke-width="0.8" stroke-dasharray="3.5 4" opacity="0.8" fill="none"/>');
    }

    // 底线：所有「岗位」站在同一条线上
    var by2 = y0 + rows * ch + (rows - 1) * gy + 26;
    g.push(line(x0 - 8, by2, x0 + cols * cw + (cols - 1) * gx + 8, by2, dp, 1.3, 0.85));

    return g.join('');
  }

  /* ─────────────────── 4. 音乐理论与作曲 · 谱线音级 ─────────────────── */

  /* 五线谱骨架 + 吸附到线/间的音级点。三种子构型：叠置和弦、单声部进行、五度圈。 */
  function motifTheory(R, st) {
    var g = [];
    var dp = st.deep, ac = st.accent;
    var v = rint(R, 0, 2);
    var i, k;

    if (v === 2) {
      // 五度圈：外圈 12 个音级，内圈同数量的关系小调，几条半径指出被用到的音
      var cx = 125, cy = 176, r = 78;
      g.push(circle(cx, cy, r, 'none', dp, 1.1));
      g.push(circle(cx, cy, 46, 'none', dp, 0.8, 0.7));
      var hot = [];
      for (i = 0; i < 12; i++) hot.push(R() < 0.3);
      for (i = 0; i < 12; i++) {
        var a = -Math.PI / 2 + i * Math.PI / 6;
        var px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
        g.push(circle(px, py, hot[i] ? 3.8 : 2.2, hot[i] ? ac : PAPER, dp, 0.85));
        var ix = cx + 46 * Math.cos(a), iy = cy + 46 * Math.sin(a);
        g.push(circle(ix, iy, hot[i] ? 2 : 1.2, hot[i] ? dp : PAPER, dp, 0.6, 0.85));
        if (hot[i]) g.push(line(ix, iy, px, py, ac, 0.7, 0.6));
      }
      g.push(circle(cx, cy, 2.6, dp, 'none', 0));
      return g.join('');
    }

    // 五线谱：5 条线，间距 14
    var lx0 = 30, lx1 = 220, ly0 = 146, step = 14;
    for (i = 0; i < 5; i++) {
      g.push(line(lx0, ly0 + i * step, lx1, ly0 + i * step, dp, 1, 0.85));
    }
    // 左侧起始刻度，替代谱号
    g.push(line(lx0 - 7, ly0 - 7, lx0 - 7, ly0 + 4 * step + 7, dp, 1.2, 0.75));

    // 小节线：让这块纸读起来像谱面而不是几条横杠
    var bars = rint(R, 2, 3);
    for (i = 1; i <= bars; i++) {
      var bx = lx0 + (lx1 - lx0) * i / (bars + 1);
      g.push(line(bx, ly0 - 2, bx, ly0 + 4 * step + 2, dp, 0.7, 0.45));
    }

    if (v === 0) {
      // 叠置和弦：几个位置上竖直堆点
      var pos = rint(R, 4, 5);
      for (k = 0; k < pos; k++) {
        var cxp = lx0 + 16 + (lx1 - lx0 - 32) * (pos === 1 ? 0.5 : k / (pos - 1));
        var lowK = rint(R, 0, 4);
        var stack = rint(R, 2, 3);
        for (i = 0; i < stack; i++) {
          var kk = Math.min(8, lowK + i * 2);
          var yy = ly0 + kk * (step / 2);
          var hollow = i === stack - 1;
          g.push(circle(cxp, yy, 4.2, hollow ? PAPER : dp, dp, 1));
        }
        if (R() < 0.55) g.push(line(cxp, ly0 - 16, cxp, ly0 - 6, dp, 0.8, 0.6));
      }
    } else {
      // 单声部进行：横向游走的音级，细线标出音高轨迹
      var n = rint(R, 7, 10);
      var cur = rint(R, 1, 7);
      var pts = [];
      for (i = 0; i < n; i++) {
        var x = lx0 + 10 + (lx1 - lx0 - 20) * (i / (n - 1));
        cur = Math.max(0, Math.min(8, cur + rint(R, -4, 4)));
        pts.push([x, ly0 + cur * (step / 2)]);
      }
      g.push(poly(pts, SOFT, 1, 1));
      for (i = 0; i < pts.length; i++) {
        var solid = R() < 0.55;
        g.push(circle(pts[i][0], pts[i][1], 4.2, solid ? dp : PAPER, dp, 1));
      }
      // 一处加高亮环，避免整条线全是同一种重量
      var hj = rint(R, 1, pts.length - 2);
      g.push(circle(pts[hj][0], pts[hj][1], 7, 'none', ac, 0.8, 0.9));
    }
    return g.join('');
  }

  /* ─────────────── 5. 录音、混音与电子音乐 · 频谱波形 ─────────────── */

  /* 点阵底噪 + 一条包络调制的频谱柱列 + 上方一条波形曲线。
     包络用指数衰减或双正弦叠加 —— 有包络才有「录音」的样子，纯随机就是噪点。 */
  function motifSpectrum(R, st) {
    var g = [];
    var dp = st.deep, ac = st.accent;
    var x0 = 28, x1 = 222, baseY = 250, topY = 92;
    var mode = rint(R, 0, 2);
    var ph = rng(R, 0, 6.28), ph2 = rng(R, 0, 6.28), ph3 = rng(R, 0, 6.28);
    var n = rint(R, 20, 30);
    var bw = (x1 - x0) / n;
    var i;

    g.push('<rect x="' + f(x0) + '" y="' + f(topY) + '" width="' + f(x1 - x0) +
      '" height="' + f(baseY - topY) + '" fill="url(#wgcfDot)"/>');

    g.push(line(x0, baseY, x1, baseY, dp, 1.3, 0.9));

    for (i = 0; i < n; i++) {
      var t = i / (n - 1);
      var env;
      if (mode === 0) env = Math.exp(-t * 2.1) * (0.55 + 0.45 * Math.abs(Math.sin(t * 9 + ph)));
      else if (mode === 1) env = 0.3 + 0.62 * Math.abs(Math.sin(t * 5.5 + ph)) * Math.abs(Math.cos(t * 2.1 + ph2));
      else env = 0.22 + 0.72 * Math.abs(Math.sin(t * 11.5 + ph)) * (0.55 + 0.45 * Math.sin(t * 3.2 + ph3));
      var h = 14 + 108 * Math.max(0.03, env) * (0.9 + 0.2 * R());
      var cxx = x0 + bw * (i + 0.5);
      var hot = (i % 6 === 3);
      g.push('<line x1="' + f(cxx) + '" y1="' + f(baseY) + '" x2="' + f(cxx) + '" y2="' + f(baseY - h) +
        '" stroke="' + (hot ? ac : dp) + '" stroke-width="' + f(bw * 0.62) +
        '" opacity="' + f(hot ? 0.95 : 0.8) + '"/>');
    }

    // 波形：一条被包络压扁的正弦，跨在上方
    var wy = 124, amp = 24, m = 44, d = [];
    var kf = 3 + Math.floor(R() * 4);
    for (i = 0; i <= m; i++) {
      var u = i / m;
      var yv = wy + Math.sin(u * kf * Math.PI * 2 + ph) * amp * (0.35 + 0.65 * Math.sin(u * Math.PI));
      d.push((i ? 'L' : 'M') + f(x0 + (x1 - x0) * u) + ' ' + f(yv));
    }
    g.push('<path d="' + d.join('') + '" fill="none" stroke="' + dp + '" stroke-width="1" opacity="0.8"/>');

    // 门限线：压缩/限幅类卡的语义，画成一条虚线
    if (R() < 0.65) {
      var ly = baseY - (46 + R() * 74);
      g.push('<line x1="' + f(x0) + '" y1="' + f(ly) + '" x2="' + f(x1) + '" y2="' + f(ly) +
        '" stroke="' + ac + '" stroke-width="0.7" stroke-dasharray="5 4" opacity="0.7"/>');
    }
    g.push(rect(x0, topY, x1 - x0, baseY - topY, 'none', SOFT, 0.7, 0.6));
    return g.join('');
  }

  /* ─────────────────── 6. 舞台与音乐制作 · 同心弧 ─────────────────── */

  /* 从一个角或一条边发散的同心情弧 = 声场。光斑落在弧之间，像灯具打出来的圈。
     再补一组从弧心射出的射线 —— 声波本来就是弧 + 射线的组合。
     4 种弧心只有 4 种可能，10 张卡光靠它就必然撞脸，所以再加一条「台口线」：
     位置/刻度数/有无都由 id 决定，10 张立刻拉开。 */
  function motifStage(R, st, id) {
    var g = [];
    var dp = st.deep, ac = st.accent;
    var mode = rint(R, 0, 3);
    var cx, cy, a0, a1;
    if (mode === 0) { cx = 30; cy = 300; a0 = -1.56; a1 = -0.1; }
    else if (mode === 1) { cx = 220; cy = 300; a0 = Math.PI + 0.1; a1 = Math.PI + 1.56; }
    else if (mode === 2) { cx = 125; cy = 84; a0 = 0.58; a1 = 2.56; }
    else { cx = 125; cy = 306; a0 = -2.66; a1 = -0.48; }

    var rings = rint(R, 5, 7);
    var r0 = rng(R, 34, 52);
    var dr = rng(R, 24, 34);
    var i;
    for (i = 0; i < rings; i++) {
      var r = r0 + i * dr;
      g.push('<path d="' + arcPath(cx, cy, r, a0, a1) + '" fill="none" stroke="' + dp +
        '" stroke-width="' + f(1.2 - 0.08 * i / rings) +
        '" opacity="' + f(0.95 - 0.5 * i / rings) + '"/>');
    }

    // 射线：把张角标定出来，顺带补上弧之间的密度
    var rays = rint(R, 3, 6);
    for (i = 0; i <= rays; i++) {
      var a = a0 + (a1 - a0) * (rays === 0 ? 0.5 : i / rays);
      var rr = (i === 0 || i === rays) ? (r0 + rings * dr) : (r0 + rng(R, 0, rings * dr * 0.8));
      g.push(line(cx, cy, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, dp, 0.75,
        (i === 0 || i === rays) ? 0.62 : 0.38));
    }

    // 光斑：落在某两条弧之间的某个角度上
    var spots = rint(R, 2, 4);
    for (i = 0; i < spots; i++) {
      var sr2 = r0 + rng(R, 0, rings - 1) * dr;
      var aa = rng(R, Math.min(a0, a1), Math.max(a0, a1));
      var sx = cx + Math.cos(aa) * sr2, sy = cy + Math.sin(aa) * sr2;
      var srad = rng(R, 2.2, 5.6);
      if (R() < 0.45) {
        g.push(circle(sx, sy, srad, ac, 'none', 0, 0.8));
      } else {
        g.push(circle(sx, sy, srad, 'none', ac, 0.9, 0.95));
        g.push(circle(sx, sy, srad * 1.9, 'none', ac, 0.6, 0.35));
      }
    }

    // 台口线：一条水平线加一组等距短刻度，位置随 id 漂移
    if (id % 4 !== 1 || R() < 0.5) {
      var ty = 84 + rng(R, 0, 40) + (id % 3) * 62;
      if (ty < 292) {
        g.push(line(28, ty, 222, ty, dp, 1, 0.6));
        var tk = rint(R, 5, 9);
        for (i = 0; i <= tk; i++) {
          var tx = 28 + (194 * i) / tk;
          g.push(line(tx, ty, tx, ty + (i % 3 === 0 ? 9 : 5), dp, 0.7, 0.45));
        }
      }
    }

    g.push(circle(cx, cy, 2.4, dp, 'none', 0));
    return g.join('');
  }

  /* ───────────────────── 宽幅卡 · 覆盖带 ───────────────────── */

  /* 单位卡是竖构图、居中一个主体；宽幅卡要一句话说清「一整片区域被整片影响」，
     所以换成：一条贯穿全幅的粗基准线 + 基线上等距排开的一串重复单元 +
     从两端罩住整片的一层大弧。重复单元本身的长短、数量、间隔都由 id 决定。 */
  function motifWide(R, st, id, wcat) {
    var g = [];
    var dp = st.deep, ac = st.accent, pa = st.pale;
    var bx0 = 18, bx1 = 232, by = 216;
    var kind = wcat || '';
    var i;

    // 覆盖带：把「影响范围」先铺成一条极淡的横带
    var bandH = rng(R, 92, 116);
    g.push('<rect x="' + f(bx0) + '" y="' + f(by - bandH) + '" width="' + f(bx1 - bx0) +
      '" height="' + f(bandH) + '" fill="' + ac + '" opacity="0.075"/>');
    g.push(line(bx0, by - bandH, bx1, by - bandH, SOFT, 0.7, 0.85));

    if (kind !== '防护增益') {
      // 笼罩弧：从一端罩到另一端，说明这是一整片（防护类另用层叠护线，见下）
      var domeH = rng(R, bandH + 14, bandH + 52);
      g.push('<path d="M' + f(bx0) + ' ' + f(by) + 'C' + f(bx0 + 30) + ' ' + f(by - domeH) + ' ' +
        f(bx1 - 30) + ' ' + f(by - domeH) + ' ' + f(bx1) + ' ' + f(by) +
        '" fill="none" stroke="' + dp + '" stroke-width="0.9" opacity="0.62"/>');
    }

    // 粗基准线：宽幅卡的签名，任何一张都必须有
    g.push(line(bx0, by, bx1, by, INK, 2.2, 0.95));
    g.push(line(bx0, by - 11, bx0, by + 11, INK, 1.6, 0.95));
    g.push(line(bx1, by - 11, bx1, by + 11, INK, 1.6, 0.95));

    // 一串重复单元：这是「一片区域里有很多个目标」最直白的写法
    var n = rint(R, 7, 11);
    var gutter = (bx1 - bx0 - 20) / (n - 1);
    var x0c = bx0 + 10;

    if (kind === '攻击增益') {
      // 一排向上的箭头，长度按位置递变
      for (i = 0; i < n; i++) {
        var cx = x0c + i * gutter;
        var hh = rng(R, 26, 44) + i * rng(R, 2, 6);
        g.push(line(cx, by, cx, by - hh, dp, 1.1, 0.9));
        g.push('<path d="M' + f(cx) + ' ' + f(by - hh) + 'l-4.5 9 9 0z" fill="' + (i % 2 ? ac : dp) + '"/>');
      }
    } else if (kind === '防护增益') {
      /* 防护不用「一排拱」（那样跟跨区域协同的弧太近），改成层叠护罩：
         2-3 层横跨全幅的微弧 + 若干根竖向支柱。整片被罩住的感觉比垛口强得多。 */
      var layers = rint(R, 2, 3);
      for (i = 0; i < layers; i++) {
        var ly = by - 26 - i * rng(R, 20, 30);
        var bul = rng(R, 3, 9) * (i + 1);
        g.push('<path d="M' + f(bx0) + ' ' + f(ly) + 'Q125 ' + f(ly - bul) + ' ' + f(bx1) + ' ' + f(ly) +
          '" fill="none" stroke="' + (i === layers - 1 ? ac : dp) + '" stroke-width="' +
          f(1.1 - 0.1 * i) + '" opacity="' + f(0.92 - 0.16 * i) + '"/>');
      }
      var struts = rint(R, 3, 5);
      for (i = 0; i < struts; i++) {
        var stx = x0c + (i + rng(R, 0.2, 0.8)) * gutter;
        g.push(line(stx, by, stx, by - 26 - (layers - 1) * 24, dp, 0.75, 0.6));
        g.push(circle(stx, by - 26 - (layers - 1) * 24, 1.9, ac, 'none', 0, 0.85));
      }
    } else if (kind === '资源辅助') {
      // 一排长短交错的标尺毛
      for (i = 0; i < n * 2; i++) {
        var cx3 = x0c + (i * gutter) / 2;
        var tl = (i % 2 === 0) ? rng(R, 22, 30) : rng(R, 9, 15);
        g.push(line(cx3, by - tl, cx3, by, dp, (i % 2 === 0) ? 1.2 : 0.7, (i % 2 === 0) ? 0.9 : 0.55));
      }
      g.push('<path d="M' + f(x0c + ((n - 1) * gutter) / 2) + ' ' + f(by + 28) + 'l8 -10 -16 0z" fill="' +
        ac + '" opacity="0.85"/>');
    } else if (kind === '抽牌辅助') {
      // 一排小卡片的叠影
      var cw2 = gutter * rng(R, 0.5, 0.66), chh = rng(R, 30, 44);
      for (i = 0; i < n; i++) {
        var cx4 = x0c + i * gutter - cw2 / 2;
        g.push(rect(cx4, by - chh - 4, cw2, chh, PAPER, dp, 1, 0.9));
        g.push(rect(cx4 + 3, by - chh - 10, cw2, chh, 'none', dp, 0.7, 0.4));
      }
    } else if (kind === '牌库调整') {
      // 一排刻度，其中几个被搬到别处，虚线标出原位置
      for (i = 0; i < n; i++) {
        var cx5 = x0c + i * gutter;
        g.push(line(cx5, by - 16, cx5, by + 16, dp, 0.8, 0.7));
        if (R() < 0.4) {
          var off = rng(R, -12, 12);
          g.push(line(cx5 + off, by + 16, cx5 + off, by + 34, ac, 0.7, 0.8));
          g.push('<path d="M' + f(cx5) + ' ' + f(by + 16) + 'q' + f(off / 2) + ' 16 ' + f(off) + ' 18' +
            '" fill="none" stroke="' + ac + '" stroke-width="0.6" stroke-dasharray="3 3" opacity="0.7"/>');
        }
      }
    } else {
      /* 跨区域协同：三段节点网络。三个区域各放一串节点，区域内连成折线，
         再横跨两处分隔把三段串起来 —— 跟「一排拱」「一排标尺」都不一样。 */
      var seg = (bx1 - bx0) / 3;
      var nets = [];
      for (i = 0; i < 3; i++) {
        var sn = rint(R, 2, 3);
        var gx0 = bx0 + seg * i + seg * 0.12;
        var gx1 = bx0 + seg * (i + 1) - seg * 0.12;
        var pts = [];
        for (var q = 0; q < sn; q++) {
          var nx = gx0 + (gx1 - gx0) * (sn === 1 ? 0.5 : q / (sn - 1));
          var ny = by - rng(R, 20, 58);
          pts.push([nx, ny]);
          g.push(circle(nx, ny, 3.2, q === 0 ? ac : PAPER, dp, 0.9));
        }
        if (pts.length > 1) g.push(poly(pts, dp, 0.9, 0.7));
        nets.push(pts[pts.length - 1]);
        g.push(line(gx0 - 6, by, gx0 - 6, by - 70, SOFT, 0.7, 0.7));
      }
      g.push(poly(nets, ac, 0.8, 0.55));
    }

    // 三个区域标记：主线上的三处加粗，对应游戏的 3 个攻击区域
    var inner = rng(R, 34, 50);
    var marks = [bx0 + inner, 125, bx1 - inner];
    for (i = 0; i < 3; i++) {
      g.push(line(marks[i], by - 15, marks[i], by + 3, INK, 1.4, 0.9));
      g.push(circle(marks[i], by + 3, 2.4, INK, 'none', 0));
    }

    return g.join('');
  }

  /* ───────────────────────── 组装 ───────────────────────── */

  function norm(card) {
    var c = card || {};
    var id = c.id | 0;
    if (!id || id < 1) id = 1;
    if (id > 100) id = 100;
    return {
      id: id,
      type: c.type === 'wide' ? 'wide' : 'unit',
      cat: typeof c.cat === 'string' ? c.cat : '',
      wcat: typeof c.wcat === 'string' ? c.wcat : '',
      cost: c.cost | 0,
      atk: c.atk | 0,
      hp: c.hp | 0
    };
  }

  function styleOf(c) {
    return CATS[c.cat] || WCATS[c.cat] || WCATS[c.wcat] || FALLBACK;
  }

  /** 图形主体。坐标固定 250×350，不含背景，art/thumb 共用 */
  function body(card, st) {
    var R = seeded(card.id);
    if (card.type === 'wide') return motifWide(R, st, card.id, card.wcat || card.cat);
    var key = card.cat;
    if (key === '乐器演奏') return motifInstrument(R, st, card.id);
    if (key === '乐队编制与演奏岗位') return motifBoard(R, st);
    if (key === '音乐理论与作曲') return motifTheory(R, st);
    if (key === '录音、混音与电子音乐') return motifSpectrum(R, st);
    if (key === '舞台与音乐制作') return motifStage(R, st, card.id);
    return motifRhythm(R, st);
  }

  /** 印刷套准标记。两个角各一个，是所有卡共用的一层「系列感」 */
  function regMarks() {
    return '<g stroke="' + INK + '" stroke-width="0.6" opacity="0.45">' +
      '<line x1="9" y1="26" x2="16" y2="26"/><line x1="12.5" y1="22.5" x2="12.5" y2="29.5"/>' +
      '<line x1="234" y1="330" x2="241" y2="330"/><line x1="237.5" y1="326.5" x2="237.5" y2="333.5"/>' +
      '</g>';
  }

  function upFrame(st) {
    return '<g fill="none" stroke="' + st.deep + '">' +
      '<rect x="5" y="5" width="240" height="340" stroke-width="0.8" opacity="0.85"/>' +
      '<rect x="9" y="9" width="232" height="332" stroke-width="0.5" opacity="0.45"/>' +
      '</g>';
  }

  function bailout() {
    // 兜底：一张几乎不画东西的卡，也比让 UI 报错白屏强
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350" ' +
      'preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:100%">' +
      '<rect width="250" height="350" fill="' + PAPER + '"/>' +
      '<rect x="40" y="174" width="170" height="1.2" fill="' + INK + '" opacity="0.5"/></svg>';
  }

  var SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 350" ' +
    'preserveAspectRatio="xMidYMid meet" style="display:block;width:100%;height:100%">';

  var Art = {
    /**
     * 卡面插画区。尺寸完全交给 viewBox，容器多宽就多宽。
     * opts: { w, h, variant:'normal'|'upgraded', side:'me'|'opp' }
     */
    art: function (card, opts) {
      try {
        opts = opts || {};
        var c = norm(card);
        var st0 = styleOf(c);
        var up = opts.variant === 'upgraded';
        // 强化后把 accent 压成 deep：整张卡变重，但不加发光
        var st = up ? { accent: st0.deep, deep: st0.deep, pale: st0.pale, motif: st0.motif } : st0;

        var g = [];
        g.push(SVG_OPEN);
        g.push(defs());
        g.push('<rect width="250" height="350" fill="' + PAPER + '"/>');
        g.push('<g clip-path="url(#wgcfClip)">');
        g.push(body(c, st));
        g.push('</g>');
        if (up) g.push(upFrame(st));
        g.push(regMarks());
        g.push('</svg>');

        var s = g.join('');
        if (s.indexOf('NaN') >= 0 || s.indexOf('undefined') >= 0 || s.indexOf('null') >= 0) return bailout();
        return s;
      } catch (e) {
        return '';
      }
    },

    /**
     * 场上卡牌用的整张缩略图（viewBox 250×350）：边框 + 缩小的插画 + 底部一条数值行。
     * 底部符号全是几何形 —— 缩略图上文字根本看不清，只能靠方块个数和长短条传达费用/攻/血。
     */
    thumb: function (card, opts) {
      try {
        opts = opts || {};
        var c = norm(card);
        var st0 = styleOf(c);
        var up = opts.variant === 'upgraded';
        var st = up ? { accent: st0.deep, deep: st0.deep, pale: st0.pale, motif: st0.motif } : st0;

        var g = [];
        g.push(SVG_OPEN);
        g.push(defs());
        g.push(rect(0.8, 0.8, 248.4, 348.4, PAPER, INK, 1.4, 1));

        // 插画等比缩进 250×350 里，给底部数值行让出位置
        g.push('<g transform="translate(19,7) scale(0.85)" clip-path="url(#wgcfClip)">');
        g.push(body(c, st));
        g.push('</g>');

        g.push(line(14, 306, 236, 306, INK, 0.7, 0.5));

        // 费用：几块小方块
        var i, n = Math.min(6, Math.max(0, c.cost));
        for (i = 0; i < n; i++) g.push(rect(15 + i * 9, 313, 6, 6, st.deep, 'none', 0));

        // 攻击 / 生命：一条两段的仪表，左段实、右段用 accent
        var barY = 330, mid = 105;
        g.push(line(15, barY, 235, barY, SOFT, 1.5, 0.9));
        var aw = Math.min(1, Math.max(0, c.atk / 10)) * mid;
        var hw = Math.min(1, Math.max(0, c.hp / 10)) * mid;
        if (aw > 0) g.push(line(15 + mid - aw, barY, 15 + mid, barY, st.deep, 2.6, 0.95));
        if (hw > 0) g.push(line(15 + mid, barY, 15 + mid + hw, barY, st.accent, 2.6, 0.95));
        g.push(line(15 + mid, barY - 6, 15 + mid, barY + 6, INK, 0.9, 0.75));

        if (up) g.push(upFrame(st));
        g.push('</svg>');

        var s = g.join('');
        if (s.indexOf('NaN') >= 0 || s.indexOf('undefined') >= 0 || s.indexOf('null') >= 0) return bailout();
        return s;
      } catch (e) {
        return '';
      }
    },

    /** 分类配色。传 cat 或 wcat 都认；认不出就给演奏技法那一套 */
    catStyle: function (cat) {
      try {
        var s = CATS[cat] || WCATS[cat] || FALLBACK;
        return { accent: s.accent, deep: s.deep, pale: s.pale, motif: s.motif };
      } catch (e) {
        return { accent: FALLBACK.accent, deep: FALLBACK.deep, pale: FALLBACK.pale, motif: FALLBACK.motif };
      }
    }
  };

  WG.CardFace = Art;
})(window.WG = window.WG || {});
