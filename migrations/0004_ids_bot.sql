-- Los gastos registrados por el bot nuevo antes de este cambio no tenian ID de ticket.
-- Se les asigna TKT-<milisegundos> segun su fecha de registro, igual que el bot anterior.
UPDATE gastos
SET id_origen = 'TKT-' || (CAST(strftime('%s', creado_en) AS INTEGER) * 1000)
WHERE id_origen IS NULL AND creado_por <> 'migracion' AND creado_por NOT LIKE '%@%';
