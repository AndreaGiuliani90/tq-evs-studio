#!/usr/bin/env python3
"""MAPPO, il cartografo dello Studio: riporta nei file del Livello 3 i ritocchi fatti a mano nel suo editor della mappa
(«Ufficio di Mappo» nello Studio). Questo file lo scrive lo Studio: versione MAPPO_APPLICA 1.

La fonte è tools/mappo.json (la scrive l'editor; a mano si può, ma conviene l'editor):
  "correzioni": { "rione/id": {dx, dy, rotation, sprite, size, rimuovi} }
      oggetti dei .tmj dei rioni (arredi, aperture, recinzioni). Valori FINALI rispetto al .tmj: vanno in
      levels/rioni/index.json "correzioni" e vincono su quelli di tools/make_level3.py. Uno sprite nuovo entra anche
      nell'elenco "sprites" dell'index (così il gioco lo carica).
  "livello": [ { "lista": "targets", "id": "bici", "tipo": "bike", "da": [x, y], "a": {x, y, rotation, type, scale} } ]
      elementi di levels/level3.json spostati, girati, ingranditi, con un'altra grafica ("type") o tolti ("a": null).
      Si ritrovano per id (bersagli, persone, nascondigli, eventi, luoghi, etichette) o per tipo + posto (props,
      oggetti, luci). Chi si sposta si porta dietro il suo percorso (persone), la sua area e la sua luce (lampioni).
  "aggiunti": [ { "lista": "props", "voce": {type, x, y, centered, rotation, scale} } ]
      arredi nuovi messi da Mappo.
Idempotente: si può rilanciare quante volte si vuole; tools/make_level3.py lo rilancia alla fine, così una
rigenerazione non cancella i ritocchi.

  python3 tools/mappo_applica.py
"""
import json, math, os

FONTE = 'tools/mappo.json'
INDEX = 'levels/rioni/index.json'
LIVELLO = 'levels/level3.json'
CHIAVE = {'targets': 'id', 'citizens': 'id', 'hideouts': 'id', 'events': 'id', 'places': 'id', 'landmarks': 'nameId'}
SINGOLI = ('player', 'exit')
CAMPI = ('rotation', 'type', 'scale', 'size', 'w', 'h', 'r', 'radius')


def vicino(o, p, r=1.0):
    return p is not None and isinstance(o, dict) and 'x' in o and math.hypot(o['x'] - p[0], o['y'] - p[1]) <= r


def percorso_sprite(s):
    """Stessa regola di Rioni.spriteKey: il file dentro levels/rioni/ (None per gli sprite del gioco)."""
    if not s or s.startswith('gioco:'): return None
    if s.startswith('rs:'): s = s[3:]
    p = s[3:] if s.startswith('../') else s
    return p if p.endswith('.png') else p + '.png'


def trova(lista, e):
    k = CHIAVE.get(e['lista'])
    if k and e.get('id') is not None:
        return next((x for x in lista if x.get(k) == e['id']), None)
    a = e.get('a') or {}
    tipi = {e.get('tipo'), a.get('type')} - {None}
    for x in lista:
        if tipi and x.get('type') not in tipi: continue
        if vicino(x, e.get('da')) or ('x' in a and vicino(x, (a['x'], a['y']))): return x
    return None


def sposta(x, a, luci):
    dx, dy = a['x'] - x['x'], a['y'] - x['y']
    if abs(dx) < 1e-6 and abs(dy) < 1e-6: return
    prima = (x['x'], x['y'])
    x['x'], x['y'] = a['x'], a['y']
    if isinstance(x.get('lightAt'), dict) and vicino(x['lightAt'], prima):
        x['lightAt'] = {'x': a['x'], 'y': a['y']}
        luci.append((prima, (a['x'], a['y'])))
    giri = [x.get('waypoints') or []] + [s.get('waypoints') or [] for s in x.get('schedule') or [] if isinstance(s, dict)]
    for g in giri:
        for w in g:
            if isinstance(w, dict) and 'x' in w: w['x'] = round(w['x'] + dx, 2); w['y'] = round(w['y'] + dy, 2)
    if isinstance(x.get('effectArea'), dict):
        x['effectArea']['x'] = round(x['effectArea']['x'] + dx, 2); x['effectArea']['y'] = round(x['effectArea']['y'] + dy, 2)


def applica_livello(level, m, sprites):
    luci = []
    for e in m.get('livello') or []:
        if e['lista'] in SINGOLI:
            if e.get('a') and isinstance(level.get(e['lista']), dict): sposta(level[e['lista']], e['a'], luci)
            continue
        lista = level.get(e['lista'])
        if not isinstance(lista, list): continue
        x = trova(lista, e)
        if x is None: continue
        a = e.get('a')
        if a is None:
            lista.remove(x)
            if isinstance(x.get('lightAt'), dict): luci.append(((x['lightAt']['x'], x['lightAt']['y']), None))
            continue
        if 'x' in a: sposta(x, a, luci)
        for c in CAMPI:
            if c in a:
                if a[c] is None: x.pop(c, None)
                else: x[c] = a[c]
        if percorso_sprite(a.get('type') or '') and str(a.get('type')).startswith('rs:'): sprites.add(percorso_sprite(a['type']))
    for e in m.get('aggiunti') or []:
        lista = level.setdefault(e.get('lista', 'props'), [])
        v = e['voce']
        if not any(x.get('type') == v.get('type') and vicino(x, (v['x'], v['y'])) for x in lista):
            lista.append(dict(v))
        if str(v.get('type', '')).startswith('rs:'): sprites.add(percorso_sprite(v['type']))
    if luci:   # la luce di un lampione segue il palo (o se ne va con lui)
        nuove = []
        for l in level.get('lights') or []:
            dove = next((b for p, b in luci if vicino(l, p)), False)
            if dove is False: nuove.append(l); continue
            if dove is None: continue
            l['x'], l['y'] = dove
            nuove.append(l)
        level['lights'] = nuove


def scrivi(f, dati, prima):
    testo = json.dumps(dati, ensure_ascii=False, indent=1)
    if testo != prima:
        with open(f, 'w') as h: h.write(testo)
        return True
    return False


def main():
    if not os.path.exists(FONTE): return print('tools/mappo.json non c\'è: nessun ritocco di Mappo da applicare')
    m = json.load(open(FONTE))
    sprites = set()
    t_idx = open(INDEX).read(); idx = json.loads(t_idx)
    corr = idx.setdefault('correzioni', {})
    for k, v in (m.get('correzioni') or {}).items():
        corr[k] = v
        p = percorso_sprite((v or {}).get('sprite'))
        if p: sprites.add(p)
    t_lvl = open(LIVELLO).read(); level = json.loads(t_lvl)
    applica_livello(level, m, sprites)
    have = idx.setdefault('sprites', [])
    for p in sorted(sprites):
        if p not in have and os.path.exists(os.path.join('levels/rioni', p)): have.append(p)
    a = scrivi(INDEX, idx, t_idx); b = scrivi(LIVELLO, level, t_lvl)
    print(f"Mappo: {len(m.get('correzioni') or {})} oggetti dei rioni, {len(m.get('livello') or [])} elementi del livello, "
          f"{len(m.get('aggiunti') or [])} aggiunti{' — file aggiornati' if a or b else ' — già tutto a posto'}")


if __name__ == '__main__':
    main()
