#!/usr/bin/env bash
# Sube a R2 las imagenes listadas en data/out/imagenes.txt (requiere wrangler autenticado).
set -u
cd "$(dirname "$0")/.."
SRC="data/tickets/Tickets Gastos Jorge Vero"
subir() {
  key="$1"; f="$SRC/$(basename "$key")"
  if npx --yes wrangler@4 r2 object put "gastos-tickets/$key" --file "$f" --content-type image/jpeg --remote >/dev/null 2>&1; then
    echo "ok $key"
  else
    echo "FALLO $key"
  fi
}
export -f subir; export SRC
tr -d '\r' < data/out/imagenes.txt | grep . | xargs -P 4 -I{} bash -c 'subir "$@"' _ {}
