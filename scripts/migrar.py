"""Migracion del Sheet viejo a D1. Corrida en seco: no escribe en la base, solo genera data/out/.

Uso: python -I scripts/migrar.py
Lee data/<csv> y data/tickets/**/TKT-*.jpg (carpetas ignoradas por git: son datos reales).
"""
import csv, re, sys, unicodedata, collections, json
from decimal import Decimal
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DATA = RAIZ / 'data'
OUT = DATA / 'out'

CATEGORIAS_BASE = {'Super', 'Restaurante', 'Tienda de Conveniencia', 'Farmacia', 'Gasolina', 'Ropa',
                   'Entretenimiento', 'Transporte', 'Servicios', 'Otro', 'Salud'}
CAMBIO_CATEGORIA = {'Cafetería': 'Restaurante', 'Nieve': 'Restaurante', 'Doctores': 'Salud',
                    'Papeleria': 'Otro', 'Envios': 'Otro', 'Mascotas': 'Otro'}


def norm(t):
    t = unicodedata.normalize('NFKD', t or '').encode('ascii', 'ignore').decode().lower()
    return re.sub(r'\s+', ' ', t).strip()


def metodo(texto):
    """Texto libre -> nombre canonico o 'Sin clasificar'. Ante la duda no adivina."""
    t = norm(texto)
    palabras = set(re.findall(r'[a-z0-9]+', t))
    if not t or t == 'no especificado':
        return 'Sin clasificar'
    if 'vales' in palabras:
        return 'Vales'
    if t.startswith('efectivo') or t.startswith('efvo'):
        return 'Efectivo'
    if 'inbursa' in palabras and 'platinum' in palabras:
        return 'TC Inbursa Platinum'
    if 'inbursa' in palabras and 'walmart' in palabras:
        return 'TC Inbursa Walmart'
    if 'costco' in palabras:
        return 'TC Costco'
    if 'didi' in palabras:
        return 'TC Didi'
    if t.startswith('tc') and 'nu' in palabras:
        if 'oswa' in palabras:
            return 'TC Nu Oswa'
        if 'vero' in palabras:
            return 'TC Nu Vero'
        return 'Sin clasificar'  # "Tc nu" sin titular
    if t.startswith('td') or t.startswith('debito'):
        if 'vero' in palabras:
            return 'Débito Vero'
        if 'oswa' in palabras:
            return 'Débito Oswa'
    return 'Sin clasificar'


def sql(v):
    return 'NULL' if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    csvs = list(DATA.glob('*.csv'))
    if len(csvs) != 1:
        sys.exit(f'Se esperaba 1 CSV en data/, hay {len(csvs)}')
    imagenes = {p.stem for p in DATA.glob('tickets/**/TKT-*.jpg')}

    filas = list(csv.DictReader(open(csvs[0], encoding='utf-8-sig', newline='')))
    gastos, errores = [], []
    sin_clasificar = collections.Counter()
    cat_cambiadas = collections.Counter()
    usados = set()

    for n, r in enumerate(filas, start=2):  # n = numero de fila en el CSV
        try:
            mm, dd, yy = r['Fecha'].split('/')
            fecha = f'{int(yy):04d}-{int(mm):02d}-{int(dd):02d}'
            monto = int((Decimal(r['Total'].replace('$', '').replace(',', '')) * 100).to_integral_value())
        except Exception as e:
            errores.append((n, r['ID'], f'fecha/monto: {e}'))
            continue
        cat = r['Categoría'].strip()
        final = CAMBIO_CATEGORIA.get(cat, cat)
        if cat != final:
            cat_cambiadas[f'{cat} -> {final}'] += 1
        if final not in CATEGORIAS_BASE:
            errores.append((n, r['ID'], f'categoria desconocida: {cat}'))
            continue
        tid = r['ID'].strip()
        origen = tid or f'MANUAL-{n}'
        if origen in usados:
            errores.append((n, tid, 'ID duplicado'))
            continue
        usados.add(origen)
        m = metodo(r['Método de Pago'])
        if m == 'Sin clasificar':
            sin_clasificar[r['Método de Pago'] or '(vacío)'] += 1
        clave = f'tickets/{tid}.jpg' if tid in imagenes else None
        gastos.append(dict(origen=origen, fecha=fecha, monto=monto, comercio=r['Comercio'].strip() or None,
                           categoria=final, metodo=m, original=r['Método de Pago'].strip() or None, imagen=clave))

    # --- SQL ---
    OUT.mkdir(parents=True, exist_ok=True)
    lineas = []
    for g in gastos:
        lineas.append(
            'INSERT OR IGNORE INTO gastos (monto_centavos, fecha, comercio, categoria_id, metodo_pago_id, imagen_key, '
            'creado_por, id_origen, metodo_original) VALUES '
            f"({g['monto']}, {sql(g['fecha'])}, {sql(g['comercio'])}, "
            f"(SELECT id FROM categorias WHERE nombre={sql(g['categoria'])}), "
            f"(SELECT id FROM metodos_pago WHERE nombre={sql(g['metodo'])}), "
            f"{sql(g['imagen'])}, 'migracion', {sql(g['origen'])}, {sql(g['original'])});")
    (OUT / 'gastos.sql').write_text('\n'.join(lineas) + '\n', encoding='utf-8')
    (OUT / 'imagenes.txt').write_text('\n'.join(g['imagen'] for g in gastos if g['imagen']) + '\n', encoding='utf-8')

    # --- conciliacion (lo esperado por mes; se compara luego contra D1) ---
    por_mes = collections.defaultdict(lambda: [0, 0])
    for g in gastos:
        por_mes[g['fecha'][:7]][0] += 1
        por_mes[g['fecha'][:7]][1] += g['monto']
    esperado = {k: {'tickets': v[0], 'total_centavos': v[1]} for k, v in sorted(por_mes.items())}
    (OUT / 'esperado.json').write_text(json.dumps(esperado, indent=1), encoding='utf-8')

    print(f'Filas en CSV: {len(filas)} | a migrar: {len(gastos)} | con error: {len(errores)}')
    for e in errores:
        print('  ERROR', e)
    print('\nPor mes (esperado):')
    for k, v in esperado.items():
        print(f"  {k}: {v['tickets']:>3} tickets  ${v['total_centavos'] / 100:>10,.2f}")
    print(f"  TOTAL: {len(gastos)} tickets  ${sum(g['monto'] for g in gastos) / 100:,.2f}")
    print('\nCategorias reasignadas:', dict(cat_cambiadas))
    print(f"\nMetodos 'Sin clasificar': {sum(sin_clasificar.values())} filas")
    for k, v in sin_clasificar.most_common():
        print(f'  {v:>3}  {k}')
    mapeo = collections.Counter(g['metodo'] for g in gastos)
    print('\nMetodos resultantes:', dict(mapeo))
    con_img = sum(1 for g in gastos if g['imagen'])
    ids_csv = {g['origen'] for g in gastos}
    huerfanas = sorted(imagenes - ids_csv)
    print(f'\nImagenes: {con_img} emparejadas | {len(huerfanas)} en la carpeta sin fila en el CSV (no se migran)')
    print(f"Filas con ID pero sin imagen en la carpeta: {sum(1 for g in gastos if not g['imagen'] and not g['origen'].startswith('MANUAL'))}")
    print(f"Filas manuales (sin ID ni ticket): {sum(1 for g in gastos if g['origen'].startswith('MANUAL'))}")


if __name__ == '__main__':
    main()
