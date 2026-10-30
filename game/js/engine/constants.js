/* Wide-Grid · 常量与共享工具
 * 严格对应《具体游戏流程｜测试版 V0.2》
 */
(function (WG) {
  'use strict';

  WG.C = {
    // ---- 对局准备 ----
    START_HP: 15,
    DECK_SIZE: 30,
    MAX_COPIES: 2,          // 同名卡最多 2 张
    START_HAND: 4,
    START_ENERGY: 3,
    START_MAX_ENERGY: 3,
    MAX_ENERGY_CAP: 6,      // 上限最高 6
    ENERGY_REGEN: 3,        // 回合开始固定恢复 3，不是回满

    // ---- 战场 ----
    UNIT_SLOTS: 6,          // 6 个普通单位位置
    AREAS: 3,               // 3 个攻击区域
    SLOTS_PER_AREA: 2,      // 每区 2 个位置

    // ---- 阶段 ----
    PHASES: ['start', 'draw', 'deploy', 'def', 'combat', 'end'],
    PHASE_NAME: {
      start: '回合开始',
      draw: '抽牌',
      deploy: '部署',
      def: '定义牌',
      combat: '战斗',
      end: '回合结束'
    },

    // 定义牌占位时长（文档：定义牌占位持续至卡面规定的占位时长结束）
    DEF_LOCK_TURNS: 2
  };

  /** 槽位 -> 攻击区域（1 起）。槽 0,1 -> 区域1；槽 2,3 -> 区域2；槽 4,5 -> 区域3 */
  WG.areaOfSlot = function (slot) {
    return Math.floor(slot / WG.C.SLOTS_PER_AREA) + 1;
  };

  /** 攻击区域 -> 该区的槽位数组 */
  WG.slotsOfArea = function (area) {
    var s = [];
    for (var i = 0; i < WG.C.UNIT_SLOTS; i++) {
      if (WG.areaOfSlot(i) === area) s.push(i);
    }
    return s;
  };

  /** 邻接区域（区域 1<->2<->3 链式相邻，无环） */
  WG.isAdjacentArea = function (a, b) {
    return Math.abs(a - b) === 1;
  };

  /** 两侧的对手下标 */
  WG.foe = function (side) { return side === 0 ? 1 : 0; };

  /** 按 id 取卡牌定义 */
  WG.cardById = function (id) {
    return WG.CARDS[id - 1] || null;
  };

  /** 卡牌简称（日志用） */
  WG.cardName = function (id) {
    var c = WG.cardById(id);
    return c ? c.name : ('#' + id);
  };

  /** 战斗区域顺序 1,2,3 */
  WG.COMBAT_ORDER = [1, 2, 3];
})(window.WG = window.WG || {});
