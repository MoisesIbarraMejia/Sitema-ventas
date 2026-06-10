import { pool } from './auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 

export async function subirPDFFactura(ventaId, archivoBuffer, nombreArchivo) {

  const ventaCheck = await pool.query(
    `SELECT v.id, c.nombre AS cliente
     FROM public.ventas v
     JOIN public.clientes c ON c.id = v.cliente_id
     WHERE v.id = $1`,
    [ventaId]
  );
  if (ventaCheck.rows.length === 0) {
    throw new Error('No existe la venta con ID ' + ventaId + '.');
  }
  const cliente = ventaCheck.rows[0].cliente;

  const rutaArchivo = 'venta-' + ventaId + '/' + nombreArchivo;
  const uploadUrl = SUPABASE_URL + '/storage/v1/object/facturas/' + rutaArchivo;

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/pdf',
    'x-upsert': 'true'
    },
    body: archivoBuffer
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error('Error al subir PDF: ' + err);
  }

  const urlPublica = SUPABASE_URL + '/storage/v1/object/public/facturas/' + rutaArchivo;

  await pool.query(
    `UPDATE public.ventas
     SET link_factures_pdf = $1, estado_factura = 'EMITIDA'
     WHERE id = $2`,
    [urlPublica, ventaId]
  );

  return { ok: true, venta_id: ventaId, cliente, url_pdf: urlPublica };
}