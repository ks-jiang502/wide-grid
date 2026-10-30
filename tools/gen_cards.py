# -*- coding: utf-8 -*-
"""从设计表 xlsx 生成 game/js/data/cards.js"""
import openpyxl, json, io, sys

wb = openpyxl.load_workbook('assets/src/cards.xlsx', data_only=True)
ws = wb['100种卡牌']

cards = []
for r in ws.iter_rows(min_row=2, values_only=True):
    if r[0] is None: continue
    no = int(r[0])
    ctype = str(r[1]).strip()
    name = str(r[2]).strip()
    cat = str(r[3]).strip()
    cost = int(r[4])
    atk = r[5]
    hp = r[6]
    text = str(r[7]).strip()
    pos = str(r[8]).strip() if r[8] else ''
    art = str(r[9]).strip() if r[9] else ''
    card = {
        "id": no,
        "type": "unit" if "普通单位" in ctype else "wide",
        "name": name,
        "cat": cat,
        "cost": cost,
        "text": text,
        "pos": pos,
        "art": art,
    }
    if card["type"] == "unit":
        card["atk"] = int(atk)
        card["hp"] = int(hp)
    else:
        card["wcat"] = cat   # 攻击增益 / 防护增益 / 资源辅助 / 抽牌辅助 / 牌库调整 / 跨区域协同
    cards.append(card)

assert len(cards) == 100, len(cards)
units = [c for c in cards if c["type"]=="unit"]
wides = [c for c in cards if c["type"]=="wide"]
print(f"units={len(units)} wides={len(wides)}", file=sys.stderr)

out = io.StringIO()
out.write("// 自动生成自 Wide-Grid_100种卡牌设计表.xlsx —— 请勿手改，改 tools/gen_cards.py\n")
out.write("(function (WG) {\n  'use strict';\n  WG.CARDS = ")
out.write(json.dumps(cards, ensure_ascii=False, indent=1))
out.write(";\n})(window.WG = window.WG || {});\n")
open('game/js/data/cards.js','w',encoding='utf-8').write(out.getvalue())
print("wrote game/js/data/cards.js", file=sys.stderr)
