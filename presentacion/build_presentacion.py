"""Arma index.html (datos reales del dashboard) y dashboard_embed.html (dashboard que se desbloquea solo).
Uso: python build_presentacion.py   (desde presentacion/; requiere que dash/dashboard_final.html exista)"""
import json, re, io
PASSWORD = "geostats2025"  # misma contraseña por defecto del pipeline (README)
d = json.load(open('../dash/dashboard_data.json', encoding='utf8'))
db = d['databases']
flags = {
  'vencida':  [1 if x['vencida'] else 0 for x in db],
  'singrupo': [1 if not x['grupos'] else 0 for x in db],
  'scorelow': [1 if x['score_completitud'] < 80 else 0 for x in db],
  'sindic':   [1 if x['diccionario'] != 'Si' else 0 for x in db],
}
from collections import Counter
orgs = Counter(x['organizacion'] for x in db).most_common(6)
vars_top = sorted(d['var_freq'].items(), key=lambda kv: -kv[1])[:8]
want = [('Municipio','municipio'),('periodo','periodo'),('sexo','sexo'),('estatus','estatus')]
sample = []
for w, _ in want:
    v = next(v for v in d['variables'] if v['nombre'] == w)
    base = v['base_datos']; base = base if len(base) < 34 else base[:32] + '…'
    tipo = v['tipo'].replace('Categorica','Categórica').replace('Numerica','Numérica')
    sample.append([v['nombre'], tipo, base, v['pct_faltante']])
data = {'flags': flags, 'orgs': [[o, n] for o, n in orgs], 'vars': [[k, n] for k, n in vars_top], 'varsample': sample}
src = open('presentacion.src.html', encoding='utf8').read()
open('index.html', 'w', encoding='utf8').write(src.replace('__DATA__', json.dumps(data, ensure_ascii=False)))

dash = open('../dash/dashboard_final.html', encoding='utf8').read()
auto = ("<script>(function(){document.documentElement.setAttribute('data-theme','light');"
        "var i=document.getElementById('lock-password'),f=document.getElementById('lock-form');"
        "i.value=%s;f.dispatchEvent(new Event('submit',{cancelable:true}));})();</script>" % json.dumps(PASSWORD))
assert '</body>' in dash
open('dashboard_embed.html', 'w', encoding='utf8').write(dash.replace('</body>', auto + '</body>'))
print('ok', {k: sum(v) for k, v in flags.items()}, orgs[:2], sample[0])
