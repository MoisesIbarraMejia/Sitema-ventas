/**
 * agent.js — Agente conversacional de Galvan Graph
 * Usa Groq (llama-3.1-8b-instant) con Function Calling.
 * El LLM NUNCA genera SQL. Solo invoca herramientas definidas aquí.
 */

import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import {
  dbRegistrarCliente,
  dbRegistrarVenta,
  dbConsulta
} from './tools.js';

dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─────────────────────────────────────────────
// DEFINICIÓN DE HERRAMIENTAS PARA EL LLM
// ─────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'dbRegistrarCliente',
      description: 'Registra un nuevo cliente. Úsala SOLO cuando el usuario proporcione explícitamente: nombre Y correo. Si falta alguno, pídelo antes de llamar esta herramienta.',
      parameters: {
        type: 'object',
        properties: {
          nombre:   { type: 'string' },
          telefono: { type: 'string' },
          correo:   { type: 'string' },
          rfc:      { type: 'string' }
        },
        required: ['nombre', 'correo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbRegistrarVenta',
      description: 'Registra una venta. Úsala SOLO cuando tengas: cliente_id, productos con nombre/cantidad/precio, y total. Si no tienes el ID del cliente, usa dbConsulta para buscarlo primero.',
      parameters: {
        type: 'object',
        properties: {
          cliente_id:       { type: 'integer' },
          total:            { type: 'number' },
          requiere_factura: { type: 'boolean' },
          productos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                producto_servicio: { type: 'string' },
                cantidad:          { type: 'integer' },
                precio_unitario:   { type: 'number' }
              },
              required: ['producto_servicio', 'cantidad', 'precio_unitario']
            }
          }
        },
        required: ['cliente_id', 'total', 'productos']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbConsulta',
      description: 'Ejecuta SQL sobre la base de datos. Para SELECT úsala directamente. Para INSERT/UPDATE/DELETE presenta primero al usuario un resumen en lenguaje natural y espera doble confirmación antes de ejecutar.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string' }
        },
        required: ['sql']
      }
    }
  }
];

// ─────────────────────────────────────────────
// PROMPT DEL SISTEMA
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente de gestión empresarial de Galvan Graph, empresa distribuidora de refacciones para máquinas de imprenta y artes gráficas.

ESTRUCTURA DE BASE DE DATOS:

tabla: public.clientes
  id, nombre, telefono, correo, rfc_o_tax_id, fecha_registro, razon_social,
  regimen_fiscal, uso_cfdi, codigo_postal, pais (default México), email_facturacion

tabla: public.ventas
  id, cliente_id (FK→clientes.id), fecha_venta, total, estado_pago (PAGADO|PENDIENTE|CANCELADO),
  requiere_factura (boolean), estado_factura (PENDIENTE|EMITIDA|CANCELADA), link_factures_pdf

tabla: public.detalles_ventas
  id, venta_id (FK→ventas.id), producto_servicio, cantidad, precio_unitario, subtotal

tabla: public.usuarios
  id, username, password_hash, nombre_completo, activo, fecha_creacion

REGLAS ESTRICTAS:

1. NUNCA muestres el SQL al usuario en ningún caso. Ni en respuestas, ni al pedir confirmación. Solo habla en lenguaje natural.

2. CONSULTAS SELECT: ejecuta dbConsulta directamente sin pedir permiso. Muestra los resultados de forma clara y legible.

3. ESCRITURAS (INSERT/UPDATE/DELETE via dbConsulta):
   - Paso 1: Describe en lenguaje natural exactamente qué vas a modificar y pide confirmación. Ejemplo: "Voy a marcar la venta #3 de Carlos Mendoza como CANCELADA. ¿Confirmas?"
   - Paso 2: Si el usuario confirma con sí/si/confirmar/ok, di: "Esta acción es irreversible. Escribe CONFIRMAR para proceder."
   - Paso 3: Solo ejecuta si el usuario escribe exactamente CONFIRMAR.
   - Si el usuario escribe algo diferente, cancela y avisa.

4. REGISTRO de clientes y ventas: usa dbRegistrarCliente y dbRegistrarVenta. Nunca uses dbConsulta para insertar clientes o ventas nuevas.

5. BLOQUEADO PERMANENTEMENTE: DROP, TRUNCATE, ALTER, CREATE, GRANT, REVOKE. Nunca los uses.

6. Si faltan datos obligatorios, pregunta antes de ejecutar cualquier herramienta.

7. Corrige errores ortográficos obvios. Interpreta números escritos con palabras.

8. Responde siempre en español, de forma clara y profesional.

9. Cuando muestres resultados, formatea la información de manera legible. Usa listas o tablas de texto cuando sean más de 3 registros.

10. Facturas:
    - EMITIR/TIMBRAR/CANCELAR CFDI → "módulo no disponible, usa factura.sat.gob.mx"
    - CONSULTAR pendientes → usa dbConsulta con SELECT
    - SUBIR PDF → indica que use el botón 📎 en el chat`;
    
// ─────────────────────────────────────────────
// DISPATCHER DE HERRAMIENTAS
// ─────────────────────────────────────────────

async function ejecutarHerramienta(nombre, args) {
  if (args.productos && typeof args.productos === 'string') {
    args.productos = JSON.parse(args.productos);
  }
  const mapa = {
    dbRegistrarCliente: () => dbRegistrarCliente(args.nombre, args.telefono, args.correo, args.rfc),
    dbRegistrarVenta:   () => dbRegistrarVenta(args.cliente_id, args.total, args.requiere_factura, args.productos),
    dbConsulta:         () => dbConsulta(args.sql)
  };
  const fn = mapa[nombre];
  if (!fn) throw new Error('Herramienta desconocida: ' + nombre);
  return await fn();
}

// ─────────────────────────────────────────────
// FUNCIÓN PRINCIPAL DEL AGENTE
// ─────────────────────────────────────────────

export async function procesarMensajeConIA(userMessage, historial = []) {

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historial,
    { role: 'user', content: userMessage }
  ];

  // Detectar si la pregunta es sobre facturas pendientes y forzar la herramienta
  const mensajeLower = userMessage.toLowerCase();
  const esPreguntaFacturas = 
    mensajeLower.includes('factura') || 
    mensajeLower.includes('pendiente') ||
    mensajeLower.includes('falta facturar');

  const toolChoiceConfig = esPreguntaFacturas 
    ? { type: 'function', function: { name: 'dbFacturasPendientes' } }
    : 'auto';

  // Primera llamada al LLM
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile', // Mejor razonamiento para function calling
    messages,
    tools: TOOLS,
    tool_choice: toolChoiceConfig,
    temperature: 0.1  // Baja temperatura = más determinista en decisiones
  });

  const responseMessage = response.choices[0].message;

  // Si no hay tool calls, respuesta directa
  if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
    return responseMessage.content;
  }

  // Ejecutar todas las herramientas solicitadas
  const toolResultMessages = [];

  for (const toolCall of responseMessage.tool_calls) {
    const args = JSON.parse(toolCall.function.arguments);
    let resultado;

    try {
      resultado = await ejecutarHerramienta(toolCall.function.name, args);
    } catch (err) {
      console.error(`[Tool Error] ${toolCall.function.name}:`, err); // ← agregar
      resultado = `❌ Error al ejecutar ${toolCall.function.name}: ${err.message}`;
    }
    toolResultMessages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: resultado
    });
  }

  // Segunda llamada: LLM interpreta los resultados y responde al usuario
  const finalResponse = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...historial,
      { role: 'user', content: userMessage },
      responseMessage,
      ...toolResultMessages
    ]
  });

  return finalResponse.choices[0].message.content;
}