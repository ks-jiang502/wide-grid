# -*- coding: utf-8 -*-
"""解析 v0.3 测试要求 docx 与 卡牌桌面设计(4).psd，输出 UTF-8 文本 + 合成图 + 图层表。

用法：python tools/parse_v03.py
输出：assets/src/v03_req.txt / v03_table.png / v03_layers.json
"""
import io
import json
import os
import sys

SRC = r"C:/Users/20306/Documents/xwechat_files/wxid_6rai0s298oc212_9f4e/msg/file/2026-10"
DOCX = os.path.join(SRC, "v0.3测试要求(1).docx")
PSD = os.path.join(SRC, "卡牌桌面设计(4).psd")
OUT = r"D:/Workspace/baioom/assets/src"


def parse_docx():
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = Document(DOCX)
    lines = []

    def walk(parent, indent=0):
        body = parent.element.body if hasattr(parent, "element") else parent._tc
        for child in body.iterchildren():
            if child.tag.endswith("}p"):
                p = Paragraph(child, parent)
                t = p.text.strip()
                if t:
                    lines.append("  " * indent + t)
            elif child.tag.endswith("}tbl"):
                tbl = Table(child, parent)
                for row in tbl.rows:
                    cells = []
                    for c in row.cells:
                        cells.append(" ".join(x.strip() for x in c.text.split("\n") if x.strip()))
                    # 去掉横向合并造成的重复
                    out = []
                    for c in cells:
                        if not out or out[-1] != c:
                            out.append(c)
                    lines.append("  " * indent + "| " + " | ".join(out) + " |")
                lines.append("")

    walk(doc)
    return "\n".join(lines)


def parse_psd():
    from PIL import Image

    im = Image.open(PSD)
    info = {
        "size": list(im.size),
        "mode": im.mode,
        "layers": [],
    }
    # 合成图
    im.convert("RGB").save(os.path.join(OUT, "v03_table.png"))

    try:
        layers = list(getattr(im, "layers", []) or getattr(im, "layers", []))
    except Exception:
        layers = []

    for lyr in layers:
        try:
            name, mode, bbox, tiles = lyr
        except Exception:
            try:
                name, bbox = lyr.name, lyr.bbox
                mode = getattr(lyr, "mode", "")
            except Exception:
                continue
        # 图层名是 GBK 被当 latin1 解码，尝试还原
        if isinstance(name, bytes):
            name_b = name
        else:
            try:
                name_b = name.encode("latin1")
            except Exception:
                name_b = str(name).encode("utf-8")
        for enc in ("gbk", "gb18030", "utf-8"):
            try:
                name_s = name_b.decode(enc)
                break
            except Exception:
                name_s = repr(name_b)
        if isinstance(bbox, dict):
            bbox = [bbox.get(k) for k in ("left", "top", "right", "bottom")]
        info["layers"].append({"name": name_s, "mode": str(mode), "bbox": list(bbox) if bbox else None})
    return info


def main():
    os.makedirs(OUT, exist_ok=True)
    try:
        txt = parse_docx()
        with open(os.path.join(OUT, "v03_req.txt"), "w", encoding="utf-8") as f:
            f.write(txt)
        print("docx ok, chars=", len(txt))
    except Exception as e:
        print("docx FAIL:", type(e).__name__, e)

    try:
        info = parse_psd()
        with open(os.path.join(OUT, "v03_layers.json"), "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False, indent=1)
        print("psd ok, size=", info["size"], "layers=", len(info["layers"]))
    except Exception as e:
        print("psd FAIL:", type(e).__name__, e)


if __name__ == "__main__":
    main()
