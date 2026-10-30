"""提取 PSD 图层边界，输出 assets/src/table_layers.json，供 UI 排布使用。"""
import json
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PSD = os.path.join(ROOT, 'assets', 'src', 'table.psd')
OUT = os.path.join(ROOT, 'assets', 'src', 'table_layers.json')


def walk(layer, depth=0, out=None):
    if out is None:
        out = []
    bbox = getattr(layer, 'bbox', None)
    name = getattr(layer, 'name', '')
    try:
        name = name.decode('utf-8', 'ignore') if isinstance(name, bytes) else str(name)
    except Exception:
        name = repr(name)
    out.append({
        'depth': depth,
        'name': name,
        'bbox': list(bbox) if bbox else None,
        'size': [bbox[2] - bbox[0], bbox[3] - bbox[1]] if bbox else None,
        'visible': bool(getattr(layer, 'visible', True)),
        'kind': getattr(layer, 'kind', ''),
    })
    for child in getattr(layer, '_layers', []) or []:
        walk(child, depth + 1, out)
    return out


def main():
    psd = Image.open(PSD)
    print('canvas:', psd.size)
    rows = walk(psd)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'canvas': list(psd.size), 'layers': rows}, f, ensure_ascii=False, indent=2)
    for r in rows:
        pad = '  ' * r['depth']
        print(f"{pad}[{r['kind']}] {r['name']}  bbox={r['bbox']}  size={r['size']}")
    print('\nwrote', OUT)


if __name__ == '__main__':
    main()
