"""
Genera dashboard_data.json a partir de catalogo_datos.csv y tabla_variables.csv
================================================================================
Este es el paso que faltaba entre `actualizar_datos.py` (que vuelve a extraer
los CSV del portal) y el dashboard: toma esos dos CSV y arma el único archivo
JSON que el dashboard necesita (catálogo con score calculado, diccionario de
variables, red de etiquetas, red de variables compartidas entre bases).

Uso:
    pip install pandas
    python generar_dashboard_data.py
    # lee catalogo_datos.csv y tabla_variables.csv de la carpeta actual
    # (o de --catalogo/--variables si están en otro lado)
    # escribe dashboard_data.json en la carpeta actual

Para que el score de "vigente" se calcule contra la fecha de hoy (y no una
fecha fija), FECHA_REFERENCIA se toma del día en que se corre el script, a
menos que se pase --fecha-referencia AAAA-MM-DD.

Es el mismo cálculo de score que el notebook de análisis (score_completitud,
0-100, 5 criterios de 20 puntos cada uno: diccionario, etiquetas, grupo,
descripción >5 palabras, vigente).
"""

import argparse
import json
import unicodedata
from datetime import datetime
from itertools import combinations

import pandas as pd


def normaliza(txt):
    if txt is None or (isinstance(txt, float) and pd.isna(txt)):
        return ""
    txt = unicodedata.normalize("NFKD", str(txt)).encode("ascii", "ignore").decode("ascii")
    return txt.lower().strip()


def clave_var(nombre):
    """Normaliza un nombre de variable para agrupar/comparar entre bases:
    solo minúsculas y espacios recortados (SIN quitar acentos, para no
    fusionar por accidente variables distintas, ej. 'numero' vs 'número')."""
    return str(nombre).strip().lower()


def txt(valor):
    """None si es NaN; si no, el string recortado de espacios/saltos de
    línea sobrantes (varios campos libres del portal traen \\r\\n o espacios
    finales por cómo cada dependencia los captura)."""
    if valor is None or (isinstance(valor, float) and pd.isna(valor)):
        return None
    s = str(valor).strip()
    return s if s else None


def lista_desde_csv(valor):
    """'Educación; Salud' -> ['Educación', 'Salud']; NaN/None -> []"""
    if valor is None or (isinstance(valor, float) and pd.isna(valor)):
        return []
    partes = [p.strip() for p in str(valor).split(";")]
    return [p for p in partes if p]


# ---------------- 1) SCORE DE COMPLETITUD (igual que el notebook) ----------------

PERIODO_A_OFFSET = {
    "cuatrimestral": pd.DateOffset(months=4),
    "mensual": pd.DateOffset(months=1),
    "semanal": pd.Timedelta(weeks=1),
    "anual": pd.DateOffset(years=1),
    "semestral": pd.DateOffset(months=6),
    "trimestral": pd.DateOffset(months=3),
    "bimestral": pd.DateOffset(months=2),
}


def calcular_proxima_actualizacion(ultima_actualizacion, periodo):
    if pd.isna(ultima_actualizacion) or not periodo:
        return pd.NaT
    periodo = str(periodo).strip().lower()
    if periodo == "documento único" or periodo not in PERIODO_A_OFFSET:
        return pd.NaT
    return ultima_actualizacion + PERIODO_A_OFFSET[periodo]


def calcular_scores(catalogo, fecha_referencia):
    """Agrega a `catalogo` las columnas score_completitud, vencida y
    expected_next_update, con la misma lógica de 5 criterios x 20 puntos que
    usa el notebook de análisis."""
    df = catalogo.copy()
    df["_ultima_actualizacion_dt"] = pd.to_datetime(df["Ultima actualizacion"], errors="coerce")
    df["_periodo_lower"] = df["Periodo de actualizacion"].astype(str).str.strip().str.lower()

    df["expected_next_update"] = df.apply(
        lambda r: calcular_proxima_actualizacion(r["_ultima_actualizacion_dt"], r["_periodo_lower"]), axis=1
    )
    df["vencida"] = (df["expected_next_update"].notna()) & (df["expected_next_update"] < fecha_referencia)

    tiene_diccionario = (df["Diccionario (Si/No)"] == "Si").astype(int)
    tiene_etiquetas = df["Etiquetas"].notna().astype(int)
    tiene_grupo = df["Grupos"].notna().astype(int)
    desc_words = df["Descripcion de la base de datos"].fillna("").astype(str).str.split().str.len()
    descripcion_decente = (desc_words > 5).astype(int)
    vigente = (~df["vencida"]).astype(int)

    df["score_completitud"] = (
        tiene_diccionario + tiene_etiquetas + tiene_grupo + descripcion_decente + vigente
    ) * 20
    return df


# ---------------- 2) ARMAR databases / variables / tag_graph / edges ----------------

def construir_databases(catalogo_scored, variables_por_base):
    bases = []
    for _, fila in catalogo_scored.iterrows():
        nombre = fila["Nombre de la base de datos"]
        # Se busca por nombre recortado de espacios: el catálogo y el
        # diccionario de variables vienen de descargas separadas y alguno de
        # los dos puede traer espacios/saltos de línea sobrantes al final.
        vars_de_esta_base = variables_por_base.get(txt(nombre), pd.DataFrame())
        cuenta_variables = len(vars_de_esta_base)
        # 0 variables encontradas se deja como None (no aplica/no se pudo
        # leer su diccionario), no como "0" — que daría a entender que la
        # base no tiene ninguna variable cuando en realidad es que no se
        # pudo emparejar.
        num_variables = cuenta_variables or None
        avg_pct_nulls = (
            round(float(vars_de_esta_base["% Valores faltantes (N/A)"].mean()), 2)
            if cuenta_variables and "% Valores faltantes (N/A)" in vars_de_esta_base
            and vars_de_esta_base["% Valores faltantes (N/A)"].notna().any()
            else None
        )
        prox = fila["expected_next_update"]
        periodo = txt(fila["Periodo de actualizacion"])
        bases.append({
            "id": fila["_id_ckan"],
            "nombre": txt(nombre),
            "diccionario": txt(fila["Diccionario (Si/No)"]),
            "fuente": txt(fila["Fuente"]),
            "autor": txt(fila["Autor"]),
            "mantenedor": txt(fila["Mantenedor"]),
            "ultima_actualizacion": txt(fila["Ultima actualizacion"]),
            "fecha_creacion": txt(fila["Fecha de creacion"]),
            "periodo_actualizacion": periodo.lower() if periodo else None,
            "proxima_actualizacion": txt(fila["Proxima actualizacion"]),
            "etiquetas": lista_desde_csv(fila["Etiquetas"]),
            "organizacion": txt(fila["Organizacion de origen"]),
            "grupos": lista_desde_csv(fila["Grupos"]),
            "formatos": txt(fila["Formatos"]),
            "licencia": txt(fila["Licencia"]),
            "descripcion": txt(fila["Descripcion de la base de datos"]),
            "num_variables": num_variables,
            "avg_pct_nulls": avg_pct_nulls,
            "score_completitud": int(fila["score_completitud"]),
            "vencida": bool(fila["vencida"]),
            "expected_next_update": prox.strftime("%Y-%m-%d") if pd.notna(prox) else None,
        })
    return bases


def construir_variables(tabla_variables):
    variables = []
    for i, fila in tabla_variables.reset_index(drop=True).iterrows():
        pct = fila.get("% Valores faltantes (N/A)")
        variables.append({
            "id": f"var_{i}",
            "nombre": txt(fila["Nombre variable"]),
            "tipo": txt(fila.get("Tipo de variable")),
            "base_datos": txt(fila["Base de datos de origen"]),
            "descripcion": txt(fila.get("Descripcion")),
            "rango": txt(fila.get("Rango o valores unicos")),
            "pct_faltante": float(pct) if pd.notna(pct) else None,
        })
    return variables


def construir_tag_graph(databases):
    # Las etiquetas se normalizan a minúsculas al agrupar (cada dependencia
    # las captura con su propia capitalización — "Salud" y "salud" son la
    # misma etiqueta).
    tags = {}
    for db in databases:
        for tag in db["etiquetas"]:
            clave = tag.strip().lower()
            tags.setdefault(clave, []).append(db["id"])
    return [{"tag": t, "dbs": dbs, "count": len(dbs)} for t, dbs in tags.items()]


def construir_shared_var_edges(databases, variables):
    nombre_a_id = {db["nombre"]: db["id"] for db in databases}
    vars_por_base = {}  # id de base -> lista ORDENADA de nombres de variable normalizados (sin duplicar)
    for v in variables:
        if not v["nombre"]:
            continue
        db_id = nombre_a_id.get(v["base_datos"])
        if db_id is None:
            continue
        clave = clave_var(v["nombre"])
        vistos = vars_por_base.setdefault(db_id, {"orden": [], "set": set()})
        if clave not in vistos["set"]:
            vistos["set"].add(clave)
            vistos["orden"].append(clave)

    ids = sorted(vars_por_base.keys())
    edges = []
    for a, b in combinations(ids, 2):
        compartidas = vars_por_base[a]["set"] & vars_por_base[b]["set"]
        if not compartidas:
            continue
        # se listan en el orden en que aparecen en la base 'a', para que la
        # lista sea estable y no dependa del orden de un set
        vars_ordenadas = [v for v in vars_por_base[a]["orden"] if v in compartidas]
        edges.append({"source": a, "target": b, "weight": len(compartidas), "vars": vars_ordenadas})
    return edges


def construir_var_freq(variables):
    freq = {}
    vistos_por_base = {}  # (base, nombre_normalizado) -> True, para no contar 2 veces la misma base
    for v in variables:
        if not v["nombre"]:
            continue
        clave = clave_var(v["nombre"])
        par = (v["base_datos"], clave)
        if par in vistos_por_base:
            continue
        vistos_por_base[par] = True
        freq[clave] = freq.get(clave, 0) + 1
    return freq


# ---------------- MAIN ----------------

def generar(catalogo_path, variables_path, salida_path, fecha_referencia=None):
    try:
        catalogo = pd.read_csv(catalogo_path, encoding="utf-8-sig")
    except UnicodeDecodeError:
        catalogo = pd.read_csv(catalogo_path, encoding="latin-1")
    try:
        tabla_variables = pd.read_csv(variables_path, encoding="utf-8-sig")
    except UnicodeDecodeError:
        tabla_variables = pd.read_csv(variables_path, encoding="latin-1")

    fecha_referencia = pd.Timestamp(fecha_referencia) if fecha_referencia else pd.Timestamp(datetime.now().date())

    catalogo_scored = calcular_scores(catalogo, fecha_referencia)
    tabla_variables = tabla_variables.copy()
    tabla_variables["Base de datos de origen"] = tabla_variables["Base de datos de origen"].map(txt)
    variables_por_base = {
        nombre: grupo for nombre, grupo in tabla_variables.groupby("Base de datos de origen")
    }

    databases = construir_databases(catalogo_scored, variables_por_base)
    variables = construir_variables(tabla_variables)
    tag_graph = construir_tag_graph(databases)
    shared_var_edges = construir_shared_var_edges(databases, variables)
    var_freq = construir_var_freq(variables)

    data = {
        "meta": {
            "fecha_referencia": fecha_referencia.strftime("%Y-%m-%d"),
            "total_bases": len(databases),
            "total_variables": len(variables),
            "total_organizaciones": len({d["organizacion"] for d in databases if d["organizacion"]}),
            "total_grupos": len({g for d in databases for g in d["grupos"]}),
            "total_etiquetas": len(tag_graph),
            "sin_diccionario": sum(1 for d in databases if d["diccionario"] != "Si"),
            "vencidas": sum(1 for d in databases if d["vencida"]),
        },
        "databases": databases,
        "variables": variables,
        "tag_graph": tag_graph,
        "shared_var_edges": shared_var_edges,
        "var_freq": var_freq,
    }

    with open(salida_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"{salida_path} generado: {len(databases)} bases, {len(variables)} variables, "
          f"{len(tag_graph)} etiquetas, {len(shared_var_edges)} conexiones entre bases.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalogo", default="catalogo_datos.csv")
    ap.add_argument("--variables", default="tabla_variables.csv")
    ap.add_argument("--salida", default="dashboard_data.json")
    ap.add_argument("--fecha-referencia", default=None, help="AAAA-MM-DD; por defecto, hoy")
    args = ap.parse_args()
    generar(args.catalogo, args.variables, args.salida, args.fecha_referencia)
