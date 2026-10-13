CREATE TABLE categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  alias TEXT,
  presupuesto_centavos INTEGER,
  activa INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE metodos_pago (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  alias TEXT,
  activo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE gastos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monto_centavos INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  comercio TEXT,
  categoria_id INTEGER REFERENCES categorias(id),
  metodo_pago_id INTEGER REFERENCES metodos_pago(id),
  imagen_key TEXT,
  estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','archivado')),
  devolucion_de INTEGER REFERENCES gastos(id),
  creado_por TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now')),
  id_origen TEXT UNIQUE
);
CREATE INDEX idx_gastos_fecha ON gastos(fecha);
CREATE INDEX idx_gastos_categoria ON gastos(categoria_id);

CREATE TABLE cambios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gasto_id INTEGER,
  accion TEXT NOT NULL,
  detalle TEXT,
  autor TEXT,
  fecha TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE consumo_ia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha TEXT NOT NULL DEFAULT (datetime('now')),
  proveedor TEXT NOT NULL,
  modelo TEXT,
  tokens_entrada INTEGER,
  tokens_salida INTEGER,
  chat TEXT
);

CREATE TABLE tickets_pendientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  imagen_key TEXT NOT NULL,
  datos_json TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO categorias (nombre, alias) VALUES
 ('Super','mandado'),
 ('Restaurante','comida para llevar'),
 ('Tienda de Conveniencia',NULL),('Farmacia',NULL),('Gasolina',NULL),('Ropa',NULL),
 ('Entretenimiento',NULL),('Transporte',NULL),('Servicios',NULL),('Otro',NULL);

INSERT INTO metodos_pago (nombre) VALUES
 ('TC Nu Vero'),('TC Nu Oswa'),('TC Didi'),('TC Inbursa Platinum'),('TC Inbursa Walmart'),
 ('TC Costco'),('Débito Vero'),('Débito Oswa'),('Efectivo'),('Vales');
