#!/bin/bash
# Pipeline completo de actualización del dashboard de Datos Abiertos NL.
#
# 1. Vuelve a extraer catalogo_datos.csv y tabla_variables.csv del portal
#    (actualizar_datos.py).
# 2. Arma dashboard_data.json a partir de esos dos CSV (generar_dashboard_data.py).
# 3. Arma dashboard_final.html, con los datos nuevos cifrados con la misma
#    contraseña de siempre (build.js).
#
# Uso: ./actualizar_dashboard.sh [contraseña]   (por defecto: geostats2025)
set -e

PASSWORD="${1:-geostats2025}"
WORK_DIR="/home/claude/work"
DASH_DIR="$WORK_DIR/dash"

echo "== 1/3: extrayendo catálogo y diccionarios del portal =="
cd "$WORK_DIR"
python3 actualizar_datos.py

echo
echo "== 2/3: armando dashboard_data.json =="
cd "$DASH_DIR"
python3 generar_dashboard_data.py \
    --catalogo "$WORK_DIR/catalogo_datos.csv" \
    --variables "$WORK_DIR/tabla_variables.csv" \
    --salida "$DASH_DIR/dashboard_data.json"

echo
echo "== 3/3: armando dashboard_final.html =="
node build.js "$PASSWORD"

echo
echo "Listo: $DASH_DIR/dashboard_final.html"
