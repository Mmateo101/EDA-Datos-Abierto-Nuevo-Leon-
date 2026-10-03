# Datos Abiertos NL — Análisis y Dashboard (GeoStats)

Proyecto de servicio social: análisis exploratorio y dashboard interactivo
sobre el catálogo del portal de [Datos Abiertos de Nuevo León](https://datosabiertos.nl.gob.mx/).

Elaborado por **Emiliano Hervert De la Cruz**, parte de **GeoStats**, con el
apoyo del equipo de Webscraping: **Pablo Aziel Domínguez López** y
**Mateo Rodolfo Flores Torres**.

## Estructura del repositorio

```
.
├── EDA_DatosAbiertosNL.ipynb      # Notebook de análisis exploratorio (EDA)
├── actualizar_datos.py            # Scraper: extrae catálogo y diccionarios vía la API de CKAN del portal
├── catalogo_datos.csv             # Catálogo de bases de datos (salida del scraper)
├── tabla_variables.csv            # Tabla de variables por base (salida del scraper)
├── requirements.txt               # Dependencias de Python
└── dash/                          # Dashboard web
    ├── index.html                 # Esqueleto del dashboard (candado + estructura)
    ├── app.js                     # Lógica del dashboard
    ├── build.js                   # Cifra dashboard_data.json y arma dashboard_final.html
    ├── generar_dashboard_data.py  # Arma dashboard_data.json a partir de los CSV
    ├── actualizar_dashboard.sh    # Orquesta el pipeline completo (scrape → json → html)
    ├── dashboard_data.json        # Datos del dashboard (sin cifrar)
    ├── dashboard_final.html       # Dashboard final, listo para abrir en el navegador (datos cifrados, pide contraseña)
    ├── d3.local.js                # Copia local de D3.js
    ├── package.json / package-lock.json
    └── node_modules/              # (no incluido; se genera con `npm install`)
```

## Requisitos

- **Python 3** con `pandas` y `requests` (`pip install -r requirements.txt`)
- **Node.js** con las dependencias de `dash/package.json` (`crypto-js`, `d3`)

## Cómo actualizar los datos y el dashboard

El scraper (`actualizar_datos.py`) necesita acceso a internet al portal de
Datos Abiertos NL, así que este pipeline debe correrse desde una máquina con
acceso normal a internet (no desde un sandbox con salida de red restringida).

1. Instala dependencias:
   ```bash
   pip install -r requirements.txt
   cd dash && npm install && cd ..
   ```
2. Corre el pipeline completo (desde la carpeta `dash/`):
   ```bash
   cd dash
   ./actualizar_dashboard.sh [contraseña]
   ```
   Esto:
   1. Vuelve a extraer `catalogo_datos.csv` y `tabla_variables.csv` del portal (`actualizar_datos.py`).
   2. Arma `dashboard_data.json` a partir de esos CSV (`generar_dashboard_data.py`).
   3. Cifra los datos con la contraseña indicada (por defecto `geostats2025`) y genera `dashboard_final.html` (`build.js`).

3. Abre `dash/dashboard_final.html` en el navegador e ingresa la contraseña para ver el dashboard actualizado.

## Notebook de análisis

`EDA_DatosAbiertosNL.ipynb` contiene el análisis exploratorio completo:
calidad de metadatos, score de completitud por base de datos (con función de
desglose `explicar_score`), relaciones entre bases por variables
compartidas, etiquetas, vigencia de actualización, etc.

## Score de completitud

Cada base de datos recibe un score de 0 a 100, sumando 20 puntos por cada uno
de estos criterios:

- Tiene diccionario de datos
- Tiene etiquetas (tags)
- Tiene grupo asignado
- Tiene una descripción decente (más de 5 palabras)
- Está vigente (no vencida según su periodicidad de actualización)

Esta misma lógica está implementada de forma idéntica en el notebook, en
`dash/app.js` y en `dash/generar_dashboard_data.py`.
