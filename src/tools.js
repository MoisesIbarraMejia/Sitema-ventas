/**
 * tools.js — Capa de acceso a datos para el agente de Galvan Graph
 * Todas las consultas son parametrizadas. El LLM NUNCA genera SQL libre.
 * 
 * ARQUITECTURA CFDI FUTURA:
 * Cada función está documentada con los campos necesarios para
 * integración con facturación electrónica SAT/CFDI 4.0.
 * Buscar etiquetas [CFDI] en los comentarios.
 */

import { pool } from './auth.js';

// ─────────────────────────────────────────────
// HERRAMIENTAS DE REGISTRO
// ─────────────────────────────────────────────

/**
 * Registra un nuevo cliente en la base de datos.
 * [CFDI] nombre → Nombre o Razón Social del receptor
 * [CFDI] rfc_o_tax_id → RFC receptor (requerido para factura)
 * [CFDI] correo → Email para envío de CFDI
 */
export async function dbRegistrarCliente(nombre, telefono, correo, rfc) {
  const query = `
    INSERT INTO public.clientes (nombre, telefono, correo, rfc_o_tax_id)
    VALUES ($1, $2, $3, $4)
    RETURNING id, nombre;
  `;
  const result = await pool.query(query, [
    nombre,
    telefono || null,
    correo,
    rfc ? rfc.toUpperCase() : null
  ]);
  return `Cliente registrado correctamente con ID ${result.rows[0].id}: ${result.rows[0].nombre}.`;
}

/**
 * Registra una venta completa con sus detalles en transacción atómica.
 * [CFDI] requiere_factura → Disparador para emisión de CFDI
 * [CFDI] total → Monto total del comprobante
 * [CFDI] productos[].producto_servicio → Descripción del concepto CFDI
 * [CFDI] productos[].precio_unitario → Valor unitario del concepto
 * [CFDI] productos[].cantidad → Cantidad del concepto
 */
export async function dbRegistrarVenta(cliente_id, total, requiere_factura, productos) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verificar que el cliente existe antes de registrar
    const clienteCheck = await client.query(
      'SELECT id, nombre FROM public.clientes WHERE id = $1',
      [cliente_id]
    );
    if (clienteCheck.rows.length === 0) {
      throw new Error(`No existe ningún cliente con ID ${cliente_id}.`);
    }

    const ventaQuery = `
      INSERT INTO public.ventas (cliente_id, total, requiere_factura, estado_pago, estado_factura)
      VALUES ($1, $2, $3, 'PAGADO', $4)
      RETURNING id;
    `;
    const estadoFactura = requiere_factura ? 'PENDIENTE' : null;
    const ventaRes = await client.query(ventaQuery, [
      cliente_id, total, requiere_factura || false, estadoFactura
    ]);
    const ventaId = ventaRes.rows[0].id;

    const detalleQuery = `
      INSERT INTO public.detalles_ventas
        (venta_id, producto_servicio, cantidad, precio_unitario, subtotal)
      VALUES ($1, $2, $3, $4, $5);
    `;
    for (const prod of productos) {
      const subtotal = prod.cantidad * prod.precio_unitario;
      await client.query(detalleQuery, [
        ventaId,
        prod.producto_servicio,
        prod.cantidad,
        prod.precio_unitario,
        subtotal
      ]);
    }

    await client.query('COMMIT');

    const clienteNombre = clienteCheck.rows[0].nombre;
    const facturaMsg = requiere_factura ? ' |  Factura pendiente de emisión.' : '';
    return `Venta #${ventaId} registrada para ${clienteNombre} por $${total}.${facturaMsg}`;

  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}


// ─────────────────────────────────────────────
// HERRAMIENTAS DE CONSULTA — VENTAS
// ─────────────────────────────────────────────


/**
 * Ejecuta SQL libre generado por el LLM.
 * SELECT: se ejecuta directamente.
 * INSERT/UPDATE/DELETE: requiere confirmación doble del usuario (manejada en el agente).
 * DROP/TRUNCATE/ALTER: bloqueados permanentemente.
 */
export async function dbConsulta(sql) {
  const sqlLimpio = sql.trim().toUpperCase();

  // Bloqueo absoluto — nunca pasan
  const bloqueados = ['DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE'];
  for (const cmd of bloqueados) {
    if (sqlLimpio.startsWith(cmd) || sqlLimpio.includes(' ' + cmd + ' ')) {
      throw new Error('Operacion no permitida: ' + cmd + '. Esta accion esta bloqueada permanentemente.');
    }
  }

  // Detectar si es escritura
  const esEscritura = ['INSERT', 'UPDATE', 'DELETE'].some(cmd =>
    sqlLimpio.startsWith(cmd) || sqlLimpio.includes(' ' + cmd + ' ')
  );

  const res = await pool.query(sql);

  return JSON.stringify({
    es_escritura: esEscritura,
    filas_afectadas: res.rowCount,
    datos: res.rows
  });
}