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
// HERRAMIENTAS DE CONSULTA — CLIENTES
// ─────────────────────────────────────────────

/**
 * Busca clientes por nombre (búsqueda parcial, insensible a mayúsculas).
 * [CFDI] Devuelve RFC para precargar datos del receptor en futura emisión.
 */
export async function dbBuscarCliente(nombre) {
  const res = await pool.query(
    `SELECT id, nombre, telefono, correo, rfc_o_tax_id, fecha_registro
     FROM public.clientes
     WHERE nombre ILIKE $1
     ORDER BY nombre ASC
     LIMIT 10`,
    [`%${nombre}%`]
  );
  if (res.rows.length === 0) {
    return `No se encontró ningún cliente con el nombre "${nombre}".`;
  }
  return JSON.stringify(res.rows);
}

/**
 * Devuelve el historial de ventas de un cliente específico.
 * Incluye detalles de productos por venta.
 * [CFDI] Útil para reexpedir facturas o consultar estado_factura.
 */
export async function dbConsultarVentasCliente(cliente_id) {
  const res = await pool.query(
    `SELECT 
       v.id AS venta_id,
       v.fecha_venta,
       v.total,
       v.estado_pago,
       v.requiere_factura,
       v.estado_factura,
       json_agg(json_build_object(
         'producto', d.producto_servicio,
         'cantidad', d.cantidad,
         'precio_unitario', d.precio_unitario,
         'subtotal', d.subtotal
       ) ORDER BY d.id) AS productos
     FROM public.ventas v
     JOIN public.detalles_ventas d ON d.venta_id = v.id
     WHERE v.cliente_id = $1
     GROUP BY v.id
     ORDER BY v.fecha_venta DESC
     LIMIT 10`,
    [cliente_id]
  );
  if (res.rows.length === 0) {
    return 'Este cliente no tiene ventas registradas aún.';
  }
  return JSON.stringify(res.rows);
}

// ─────────────────────────────────────────────
// HERRAMIENTAS DE CONSULTA — VENTAS
// ─────────────────────────────────────────────

/**
 * Devuelve las últimas N ventas con nombre del cliente y productos.
 * [CFDI] Incluye estado_factura para monitorear comprobantes pendientes.
 */
export async function dbUltimasVentas(limit = 5) {
  const lim = Math.min(Math.max(parseInt(limit) || 5, 1), 50);
  const res = await pool.query(
    `SELECT 
       v.id AS venta_id,
       c.nombre AS cliente,
       v.fecha_venta,
       v.total,
       v.estado_pago,
       v.requiere_factura,
       v.estado_factura,
       json_agg(json_build_object(
         'producto', d.producto_servicio,
         'cantidad', d.cantidad,
         'subtotal', d.subtotal
       ) ORDER BY d.id) AS productos
     FROM public.ventas v
     JOIN public.clientes c ON c.id = v.cliente_id
     JOIN public.detalles_ventas d ON d.venta_id = v.id
     GROUP BY v.id, c.nombre
     ORDER BY v.fecha_venta DESC
     LIMIT $1`,
    [lim]
  );
  if (res.rows.length === 0) return 'No hay ventas registradas aún.';
  return JSON.stringify(res.rows);
}

/**
 * Resumen financiero general: total ventas, monto acumulado,
 * ticket promedio y cuántas requieren factura.
 * [CFDI] Útil para cuadrar comprobantes pendientes vs emitidos.
 */
export async function dbResumenVentas() {
  const res = await pool.query(
    `SELECT
       COUNT(v.id)::int                          AS total_ventas,
       COALESCE(SUM(v.total), 0)::numeric        AS monto_total,
       COALESCE(AVG(v.total), 0)::numeric        AS ticket_promedio,
       COUNT(CASE WHEN v.requiere_factura THEN 1 END)::int AS ventas_con_factura,
       COUNT(CASE WHEN v.estado_factura = 'PENDIENTE' THEN 1 END)::int AS facturas_pendientes
     FROM public.ventas v`
  );
  return JSON.stringify(res.rows[0]);
}

/**
 * Busca ventas que contengan un producto/servicio específico.
 * Búsqueda parcial en nombre del producto.
 * [CFDI] Permite identificar conceptos para agrupación de comprobantes.
 */
export async function dbVentasPorServicio(servicio) {
  const res = await pool.query(
    `SELECT
       v.id AS venta_id,
       c.nombre AS cliente,
       v.fecha_venta,
       d.producto_servicio,
       d.cantidad,
       d.precio_unitario,
       d.subtotal
     FROM public.detalles_ventas d
     JOIN public.ventas v ON v.id = d.venta_id
     JOIN public.clientes c ON c.id = v.cliente_id
     WHERE d.producto_servicio ILIKE $1
     ORDER BY v.fecha_venta DESC
     LIMIT 20`,
    [`%${servicio}%`]
  );
  if (res.rows.length === 0) {
    return `No se encontraron ventas con el servicio/producto "${servicio}".`;
  }
  return JSON.stringify(res.rows);
}

/**
 * Top N clientes por monto total acumulado de compras.
 * [CFDI] RFC incluido para emisión masiva de facturas a mejores clientes.
 */
export async function dbTopClientes(limit = 5) {
  const lim = Math.min(Math.max(parseInt(limit) || 5, 1), 20);
  const res = await pool.query(
    `SELECT
       c.id,
       c.nombre,
       c.correo,
       c.rfc_o_tax_id,
       COUNT(v.id)::int         AS total_compras,
       SUM(v.total)::numeric    AS monto_acumulado
     FROM public.clientes c
     JOIN public.ventas v ON v.cliente_id = c.id
     GROUP BY c.id
     ORDER BY monto_acumulado DESC
     LIMIT $1`,
    [lim]
  );
  if (res.rows.length === 0) return 'No hay datos de clientes con ventas aún.';
  return JSON.stringify(res.rows);
}

/**
 * Ventas del mes calendario actual.
 * [CFDI] Base para generación de reportes mensuales de comprobantes.
 */
export async function dbVentasDelMes() {
  const res = await pool.query(
    `SELECT
       v.id AS venta_id,
       c.nombre AS cliente,
       v.fecha_venta,
       v.total,
       v.requiere_factura,
       v.estado_factura
     FROM public.ventas v
     JOIN public.clientes c ON c.id = v.cliente_id
     WHERE DATE_TRUNC('month', v.fecha_venta) = DATE_TRUNC('month', CURRENT_DATE)
     ORDER BY v.fecha_venta DESC`
  );
  if (res.rows.length === 0) return 'No hay ventas registradas este mes.';

  const total = res.rows.reduce((s, r) => s + parseFloat(r.total), 0);
  return JSON.stringify({
    mes: new Date().toLocaleString('es-MX', { month: 'long', year: 'numeric' }),
    cantidad_ventas: res.rows.length,
    total_mes: total.toFixed(2),
    ventas: res.rows
  });
}

/**
 * Lista ventas que requieren factura y aún no tienen PDF adjunto.
 * [CFDI] Base para seguimiento de comprobantes pendientes de emisión.
 */
export async function dbFacturasPendientes() {
  const res = await pool.query(
    `SELECT
       v.id AS venta_id,
       c.nombre AS cliente,
       c.correo,
       c.rfc_o_tax_id AS rfc,
       v.fecha_venta,
       v.total,
       v.estado_factura,
       EXTRACT(DAY FROM NOW() - v.fecha_venta)::int AS dias_pendiente
     FROM public.ventas v
     JOIN public.clientes c ON c.id = v.cliente_id
     WHERE v.requiere_factura = true
       AND (v.link_factures_pdf IS NULL OR v.link_factures_pdf = '')
     ORDER BY v.fecha_venta ASC`
  );
  if (res.rows.length === 0) {
    return 'No hay facturas pendientes. Todo al corriente.';
  }
  return JSON.stringify({
    total_pendientes: res.rows.length,
    ventas: res.rows
  });
}