"""
Scraper de actualización — Datos Abiertos Nuevo León (CKAN)
=============================================================
Vuelve a generar `catalogo_datos.csv` y `tabla_variables.csv` con datos
actuales del portal https://datosabiertos.nl.gob.mx (catálogo CKAN en
http://catalogodatos.nl.gob.mx), usando la API pública de CKAN (Action API)
en vez de parsear HTML, que es más estable y mucho más rápido.

Uso:
    pip install requests pandas openpyxl
    python actualizar_datos.py

Genera dos archivos en la carpeta actual, con las mismas columnas que los
originales usados en el notebook:
    - catalogo_datos.csv   (un renglón por base de datos / dataset)
    - tabla_variables.csv  (un renglón por variable, solo para las bases que
                             tienen un recurso de "diccionario de datos")

Notas importantes:
    - El sitio corre CKAN 2.10. Su robots.txt bloquea /api/ solo para
      rastreadores web genéricos — la Action API es la forma pública y
      soportada de consumir el catálogo mediante programación (para eso
      existe), así que se usa aquí, pero con una pausa entre llamadas
      (RATE_LIMIT_SECONDS) para no saturar el servidor, por cortesía.
    - Los campos "Fuente", "Periodo de actualización" y "Próxima
      actualización" son campos libres ("extras") que cada dependencia
      captura a mano, por lo que su capitalización/acentos varían (ej.
      "Período" vs "Periodo", "Próxima Actualización" vs "proxima
      actualizacion"). Por eso se buscan por coincidencia de palabras clave
      ya normalizadas (sin acentos, en minúsculas), no por una llave fija.
    - Para "tabla_variables.csv" se descarga el recurso que tenga
      "diccionario" en su nombre (el que ya usa la propia dependencia como
      diccionario de datos) para obtener nombre/tipo/descripción
      declarados, y además se descarga el recurso de datos principal para
      calcular el % de valores faltantes y el rango o valores únicos reales
      — igual que en el análisis original. Si un recurso no se puede leer
      (por ejemplo el link ya no funciona, o no es CSV/XLSX), esa base de
      datos simplemente se omite de este archivo y se avisa por consola,
      sin detener el proceso completo.
    - Si el nombre/formato de los diccionarios de alguna dependencia no
      coincide con lo que este script espera (columnas "Nombre"/"Tipo"/
      "Descripción" o similares), esa base se salta con un aviso — revisa
      los mensajes "[omitido]" al final para saber cuáles quedaron fuera y
      por qué.
"""

import csv
import time
import unicodedata
from io import BytesIO, StringIO

import pandas as pd
import requests

# ---------------- CONFIG ----------------
BASE_URL = "http://catalogodatos.nl.gob.mx"
API_PACKAGE_SEARCH = f"{BASE_URL}/api/3/action/package_search"
ROWS_PER_PAGE = 100
RATE_LIMIT_SECONDS = 0.5  # pausa entre llamadas a la API/descargas de recursos
HEADERS = {"User-Agent": "GeoStats-ServicioSocial/1.0 (uso academico, datos abiertos NL)"}
OUT_CATALOGO = "catalogo_datos.csv"
OUT_VARIABLES = "tabla_variables.csv"


def normaliza(txt):
    """Minúsculas y sin acentos, para comparar llaves/columnas sin pelear
    con la ortografía (útil porque los campos libres del portal varían)."""
    if txt is None:
        return ""
    txt = unicodedata.normalize("NFKD", str(txt)).encode("ascii", "ignore").decode("ascii")
    return txt.lower().strip()


# ---------------- 1) METADATOS DE CADA BASE (catalogo_datos.csv) ----------------

def obtener_todos_los_paquetes():
    """Trae todos los datasets del catálogo vía package_search, paginando."""
    paquetes = []
    start = 0
    while True:
        resp = requests.get(
            API_PACKAGE_SEARCH,
            params={"rows": ROWS_PER_PAGE, "start": start},
            headers=HEADERS, timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("success"):
            raise RuntimeError(f"La API respondió success=false: {data}")
        result = data["result"]
        lote = result["results"]
        paquetes.extend(lote)
        print(f"  descargados {len(paquetes)} / {result['count']} datasets...")
        if len(lote) < ROWS_PER_PAGE or len(paquetes) >= result["count"]:
            break
        start += ROWS_PER_PAGE
        time.sleep(RATE_LIMIT_SECONDS)
    return paquetes


def buscar_extra(pkg, *palabras_clave):
    """Busca en pkg['extras'] (campos libres tipo llave/valor) una llave que
    contenga alguna de las palabras clave, sin importar acentos/mayúsculas."""
    for extra in pkg.get("extras", []) or []:
        clave = normaliza(extra.get("key"))
        if any(p in clave for p in palabras_clave):
            valor = extra.get("value")
            return valor.strip('"') if isinstance(valor, str) else valor
    return None


def tiene_diccionario(pkg):
    return recurso_diccionario(pkg) is not None


def recurso_diccionario(pkg):
    for r in pkg.get("resources", []) or []:
        texto = normaliza(r.get("name")) + " " + normaliza(r.get("description"))
        if "diccionario" in texto:
            return r
    return None


def recursos_de_datos(pkg):
    """Recursos que probablemente traen los datos reales (no el diccionario)."""
    salida = []
    for r in pkg.get("resources", []) or []:
        texto = normaliza(r.get("name")) + " " + normaliza(r.get("description"))
        if "diccionario" in texto:
            continue
        if (r.get("format") or "").lower() in {"csv", "xlsx", "xls"}:
            salida.append(r)
    return salida


def construir_catalogo(paquetes):
    filas = []
    for pkg in paquetes:
        recursos = pkg.get("resources", []) or []
        filas.append({
            "Nombre de la base de datos": pkg.get("title"),
            "Diccionario (Si/No)": "Si" if tiene_diccionario(pkg) else "No",
            "Fuente": buscar_extra(pkg, "fuente"),
            "Autor": pkg.get("author") or None,
            "Mantenedor": pkg.get("maintainer") or None,
            "Ultima actualizacion": (pkg.get("metadata_modified") or "")[:10] or None,
            "Fecha de creacion": (pkg.get("metadata_created") or "")[:10] or None,
            "Periodo de actualizacion": buscar_extra(pkg, "periodo de actualiz", "periodicidad", "frecuencia"),
            "Proxima actualizacion": buscar_extra(pkg, "proxima actualiz", "siguiente actualiz"),
            "Etiquetas": "; ".join(t.get("name", "") for t in pkg.get("tags", []) or []) or None,
            "Organizacion de origen": (pkg.get("organization") or {}).get("title"),
            "Grupos": "; ".join(g.get("title", "") for g in pkg.get("groups", []) or []) or None,
            "Formatos": "; ".join(sorted({(r.get("format") or "").upper() for r in recursos if r.get("format")})) or None,
            "Licencia": pkg.get("license_title"),
            "Descripcion de la base de datos": pkg.get("notes"),
            "_id_ckan": pkg.get("id"),
            "_metadata_modified_raw": pkg.get("metadata_modified"),
        })
    return pd.DataFrame(filas)


# ---------------- 2) DICCIONARIO DE VARIABLES POR BASE (tabla_variables.csv) ----------------

# Orden de prioridad: se recorre esta lista PALABRA POR PALABRA (no columna
# por columna), y se regresa la primera columna cuyo nombre CONTENGA esa
# palabra. Por eso manda la prioridad de la lista y no ni el orden de las
# columnas en el archivo ni si la palabra está al principio del nombre: con
# columnas "Nombre de la base y/o conjunto de datos" y "Nombre del campo",
# "campo" (prioridad 3) le gana a "nombre" (prioridad 4) aunque "campo" no
# esté al inicio de "Nombre del campo" — por eso se elige esa y no la otra.
# "columna" va al final por ser la palabra más genérica.
COLS_NOMBRE = ["etiqueta", "variable", "campo", "nombre", "columna"]
COLS_TIPO = ["tipo"]
COLS_DESC = ["descripcion", "definicion", "detalle"]
COLS_DESC_LAXO = ["desc"]  # fallback más laxo si no hay match con COLS_DESC
COLS_RANGO = ["rango", "valores unicos", "valores_unicos", "valores"]


def encontrar_columna(df, prioritarios, contiene=None):
    """Busca la columna que mejor corresponda a un campo del diccionario.

    Recorre `prioritarios` en orden y regresa la primera columna cuyo nombre
    normalizado CONTENGA esa palabra (se itera palabra por palabra, así que
    una palabra de mayor prioridad gana aunque su columna aparezca después
    en el archivo, o aunque la palabra no esté al inicio del nombre). Si
    ninguna palabra de `prioritarios` aparece en ninguna columna, cae a una
    búsqueda con `contiene` (por defecto, las mismas palabras) — por
    ejemplo, para la descripción, si nada trae "descripcion"/"definicion"/
    "detalle", se busca cualquier columna que solo contenga "desc"."""
    contiene = contiene if contiene is not None else prioritarios
    for palabra in prioritarios:
        for col in df.columns:
            if palabra in normaliza(col):
                return col
    if contiene is not prioritarios:
        for palabra in contiene:
            for col in df.columns:
                if palabra in normaliza(col):
                    return col
    return None


def _normaliza_saltos_linea(texto):
    # Algunas dependencias exportan con saltos de línea mixtos (\r solitario,
    # \r\n) que confunden al parser de CSV y producen errores de "newline
    # character seen in unquoted field"; se homogeneizan primero.
    return texto.replace("\r\n", "\n").replace("\r", "\n")


def _mejor_separador(texto, skiprows=0, header="infer"):
    """Prueba separadores y modos de comillas comunes en exportaciones de
    Excel/CKAN en español (coma, punto y coma, tab; con y sin comillas) y
    regresa el primer DataFrame con más de una columna. `header="infer"` usa
    la primera línea leída como encabezado (default de pandas); `header=None`
    la trata como dato (para cuando se quiere leer por posición, sin
    encabezado)."""
    configs = [dict(sep=s) for s in (",", ";", "\t", "|")]
    configs.append(dict(sep=None))
    # último recurso: ignorar comillas por completo (arregla comillas sueltas
    # o saltos de línea dentro de un campo sin comillas balanceadas)
    for sep in (",", ";"):
        configs.append(dict(sep=sep, quoting=csv.QUOTE_NONE, escapechar="\\"))
    for kwargs in configs:
        try:
            df = pd.read_csv(
                StringIO(texto), engine="python", on_bad_lines="skip",
                skiprows=skiprows, header=header, **kwargs,
            )
            if df.shape[1] > 1:
                return df
        except Exception:
            continue
    return None


def parsear_csv_texto(texto, skiprows=0):
    """Parsea un CSV probando varios separadores y modos de comillas
    (ver `_mejor_separador`)."""
    return _mejor_separador(_normaliza_saltos_linea(texto), skiprows=skiprows)


def leer_diccionario_fila_titulo(texto):
    """Para diccionarios con una fila de título y una fila de encabezado
    antes de los datos reales (ej. 'Diccionario_DatosOpinaRed' en la línea 1
    y 'Nombre del campo,Descripcion del campo' en la línea 2): siempre se
    saltan esas 2 primeras líneas y se empieza a leer directo en la línea 3,
    ya sin encabezado (por posición) — la primera columna es el nombre de
    variable y la segunda la descripción, y es todo; así es la estructura de
    estos casos, sin necesidad de reconocer nombres de columna."""
    texto = _normaliza_saltos_linea(texto)
    df = _mejor_separador(texto, skiprows=2, header=None)
    if df is None or df.shape[1] < 2:
        return None
    return pd.DataFrame({
        "Nombre variable": df.iloc[:, 0],
        "Descripcion": df.iloc[:, 1],
    })


def descargar_texto(url):
    """Descarga un recurso y lo regresa ya decodificado a str, probando
    varios encodings comunes en datos mexicanos; nunca falla por encoding
    gracias al último intento con errors='replace'."""
    resp = requests.get(url, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    contenido = resp.content
    for enc in ("utf-8-sig", "utf-8", "latin-1", "cp1252"):
        try:
            return contenido.decode(enc)
        except UnicodeDecodeError:
            continue
    return contenido.decode("utf-8", errors="replace")


def descargar_tabla(url):
    """Descarga un recurso CSV/XLSX y lo regresa como DataFrame."""
    if url.lower().endswith((".xlsx", ".xls")):
        resp = requests.get(url, headers=HEADERS, timeout=60)
        resp.raise_for_status()
        return pd.read_excel(BytesIO(resp.content))
    texto = descargar_texto(url)
    df = parsear_csv_texto(texto)
    if df is None:
        raise ValueError("no se pudo leer como tabla con ningun separador probado")
    return df


def infiere_tipo(serie):
    s = serie.dropna()
    if s.empty:
        return "Desconocido"
    numeros = pd.to_numeric(s, errors="coerce")
    if numeros.notna().mean() > 0.95:
        if (numeros.dropna() % 1 == 0).all():
            return "Entero (integer)"
        return "Decimal (float)"
    fechas = pd.to_datetime(s, errors="coerce", format="mixed")
    if fechas.notna().mean() > 0.8:
        return "Fecha"
    if s.nunique() <= max(20, int(len(s) * 0.05)):
        return "Categorica"
    return "Texto"


def rango_o_valores(serie):
    s = serie.dropna()
    if s.empty:
        return None
    numeros = pd.to_numeric(s, errors="coerce")
    if numeros.notna().mean() > 0.95:
        numeros = numeros.dropna()
        return f"{numeros.min():g} a {numeros.max():g}"
    unicos = sorted({str(v) for v in s.unique()})
    if len(unicos) > 60:  # demasiados valores únicos para listarlos (texto libre)
        return f"{len(unicos)} valores unicos"
    return "; ".join(unicos)


def construir_variables(paquetes):
    filas = []
    for pkg in paquetes:
        nombre_base = pkg.get("title")
        rec_dicc = recurso_diccionario(pkg)
        if rec_dicc is None or not rec_dicc.get("url"):
            continue  # esta base no tiene diccionario -> no aparece en tabla_variables

        try:
            texto_dicc = descargar_texto(rec_dicc["url"])
        except Exception as e:
            print(f"  [omitido] no se pudo descargar el diccionario de '{nombre_base}': {e}")
            continue
        time.sleep(RATE_LIMIT_SECONDS)

        dicc_df = parsear_csv_texto(texto_dicc)
        col_nombre = encontrar_columna(dicc_df, COLS_NOMBRE) if dicc_df is not None else None
        modo_posicional = False

        # Si en el primer intento no aparece ninguna columna reconocible
        # (típicamente porque la fila 1 es un título, ej. 'Diccionario_
        # DatosOpinaRed'), se prueba primero el procedimiento normal pero
        # bajando una fila (fila 2 como encabezado) — sigue buscando por
        # nombre de columna, igual que siempre.
        if col_nombre is None:
            intento_fila2 = _mejor_separador(_normaliza_saltos_linea(texto_dicc), skiprows=1)
            col_nombre_fila2 = encontrar_columna(intento_fila2, COLS_NOMBRE) if intento_fila2 is not None else None
            if col_nombre_fila2 is not None:
                dicc_df = intento_fila2
                col_nombre = col_nombre_fila2

        # Si todavía así no se encuentra nada (caso de los diccionarios de
        # OpinaRed, Solicitudes de Información y Solicitudes CODETUR, cuyo
        # encabezado real está hasta la 3ra línea), ya no se busca por
        # nombre de columna: se salta directo ahí y se toma la 1ra columna
        # como nombre de variable y la 2da como descripción, sin más.
        if col_nombre is None:
            intento_fila3 = leer_diccionario_fila_titulo(texto_dicc)
            if intento_fila3 is not None:
                dicc_df = intento_fila3
                col_nombre = "Nombre variable"
                modo_posicional = True

        if col_nombre is None:
            columnas = list(dicc_df.columns) if dicc_df is not None else "no se pudo leer"
            print(f"  [omitido] diccionario de '{nombre_base}' sin columna de nombre de variable reconocible "
                  f"(columnas encontradas: {columnas})")
            continue

        col_tipo = None if modo_posicional else encontrar_columna(dicc_df, COLS_TIPO)
        col_desc = "Descripcion" if modo_posicional else encontrar_columna(dicc_df, COLS_DESC, contiene=COLS_DESC_LAXO)
        col_rango = None if modo_posicional else encontrar_columna(dicc_df, COLS_RANGO)

        # Datos reales, para calcular % faltantes y rango. Se descargan TODOS
        # los recursos de datos de la base (puede haber varios, ej. un CSV
        # por periodo: "2026_enero_abril" y "2025_septiembre_diciembre"), no
        # solo el primero, porque una variable puede existir en unos y no en
        # otros. Si un recurso no se puede leer, se omite solo ese (se sigue
        # con los demás) en vez de tronar toda la base.
        datos_dfs = []
        for r in recursos_de_datos(pkg):
            try:
                datos_dfs.append(descargar_tabla(r["url"]))
            except Exception:
                pass
            finally:
                time.sleep(RATE_LIMIT_SECONDS)

        for _, fila_dicc in dicc_df.iterrows():
            var_nombre = str(fila_dicc[col_nombre]).strip()
            if not var_nombre or var_nombre.lower() == "nan":
                continue
            tipo = str(fila_dicc[col_tipo]).strip() if col_tipo and pd.notna(fila_dicc[col_tipo]) else None
            desc = str(fila_dicc[col_desc]).strip() if col_desc and pd.notna(fila_dicc[col_desc]) else None
            # El rango/valores únicos se toma primero del propio diccionario,
            # si la dependencia ya lo declaró ahí; solo se calcula de los
            # datos reales cuando el diccionario no trae esa columna (o la
            # trae vacía para esa variable).
            rango = str(fila_dicc[col_rango]).strip() if col_rango and pd.notna(fila_dicc[col_rango]) else None

            pct_faltantes = None
            # Si la variable aparece en más de un archivo de datos (ej. un
            # CSV por periodo), se juntan todos los valores en una sola
            # serie y las estadísticas (% faltantes, rango, tipo) se
            # calculan sobre ese conjunto completo, no solo del primer
            # archivo donde se encuentre.
            series_encontradas = []
            for datos_df in datos_dfs:
                col_datos = next((c for c in datos_df.columns if normaliza(c) == normaliza(var_nombre)), None)
                if col_datos is not None:
                    series_encontradas.append(datos_df[col_datos])

            if series_encontradas:
                serie = pd.concat(series_encontradas, ignore_index=True)
                pct_faltantes = round(serie.isna().mean() * 100, 1)
                if not rango:
                    rango = rango_o_valores(serie)
                if not tipo:
                    tipo = infiere_tipo(serie)

            filas.append({
                "Nombre variable": var_nombre,
                "Tipo de variable": tipo,
                "Base de datos de origen": nombre_base,
                "Descripcion": desc,
                "Rango o valores unicos": rango,
                "% Valores faltantes (N/A)": pct_faltantes,
            })
    return pd.DataFrame(filas)


# ---------------- MAIN ----------------

def main():
    print("Descargando metadatos de todos los datasets...")
    paquetes = obtener_todos_los_paquetes()
    print(f"Total de bases de datos encontradas: {len(paquetes)}")

    print("\nConstruyendo catalogo_datos.csv...")
    catalogo = construir_catalogo(paquetes)
    catalogo.to_csv(OUT_CATALOGO, index=False, encoding="utf-8-sig")
    print(f"  guardado en {OUT_CATALOGO} ({len(catalogo)} filas)")

    print("\nConstruyendo tabla_variables.csv (puede tardar varios minutos, "
          "descarga el diccionario y los datos de cada base)...")
    variables = construir_variables(paquetes)
    variables.to_csv(OUT_VARIABLES, index=False, encoding="utf-8-sig")
    print(f"  guardado en {OUT_VARIABLES} ({len(variables)} filas)")

    print("\nListo. Ya puedes volver a correr el notebook de análisis con estos dos archivos actualizados.")


if __name__ == "__main__":
    main()
