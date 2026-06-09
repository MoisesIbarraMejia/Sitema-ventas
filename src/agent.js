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
  dbBuscarCliente,
  dbConsultarVentasCliente,
  dbUltimasVentas,
  dbResumenVentas,
  dbVentasPorServicio,
  dbTopClientes,
  dbVentasDelMes
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
          nombre:   { type: 'string', description: 'Nombre completo del cliente.' },
          telefono: { type: 'string', description: 'Teléfono (opcional).' },
          correo:   { type: 'string', description: 'Correo electrónico (obligatorio).' },
          rfc:      { type: 'string', description: 'RFC o Tax ID (opcional, en mayúsculas).' }
        },
        required: ['nombre', 'correo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbRegistrarVenta',
      description: 'Registra una venta. Úsala SOLO cuando tengas: cliente_id numérico, lista de productos con nombre/cantidad/precio, y el total. Si falta el ID del cliente, usa primero dbBuscarCliente. Si faltan precios o cantidades, pregúntalos.',
      parameters: {
        type: 'object',
        properties: {
          cliente_id:       { type: 'integer', description: 'ID numérico del cliente (obtenido de dbBuscarCliente).' },
          total:            { type: 'number',  description: 'Monto total de la venta.' },
          requiere_factura: { type: 'boolean', description: 'true si el cliente pidió factura.' },
          productos: {
            type: 'array',
            description: 'Lista de productos/servicios vendidos.',
            items: {
              type: 'object',
              properties: {
                producto_servicio: { type: 'string',  description: 'Nombre del producto o servicio.' },
                cantidad:          { type: 'integer', description: 'Unidades vendidas.' },
                precio_unitario:   { type: 'number',  description: 'Precio por unidad.' }
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
      name: 'dbBuscarCliente',
      description: 'Busca clientes por nombre. Úsala antes de registrar una venta si no tienes el ID, o cuando el usuario pregunte por un cliente.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre o parte del nombre a buscar.' }
        },
        required: ['nombre']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbConsultarVentasCliente',
      description: 'Muestra el historial de ventas de un cliente específico usando su ID.',
      parameters: {
        type: 'object',
        properties: {
          cliente_id: { type: 'integer', description: 'ID numérico del cliente.' }
        },
        required: ['cliente_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbUltimasVentas',
      description: 'Lista las últimas N ventas registradas. Usa cuando el usuario pida "últimas ventas", "ventas recientes" o similar.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Cuántas ventas mostrar (máx 50, default 5).' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbResumenVentas',
      description: 'Resumen financiero general: total de ventas, monto acumulado, ticket promedio y facturas pendientes.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbVentasPorServicio',
      description: 'Busca ventas que incluyan un producto o servicio específico. Usa cuando pregunten "¿quién compró X?" o "¿cuánto se ha vendido de X?".',
      parameters: {
        type: 'object',
        properties: {
          servicio: { type: 'string', description: 'Nombre o parte del nombre del producto/servicio.' }
        },
        required: ['servicio']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbTopClientes',
      description: 'Lista los N mejores clientes por monto total de compras.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Cuántos clientes mostrar (máx 20, default 5).' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'dbVentasDelMes',
      description: 'Muestra todas las ventas del mes actual con total acumulado.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
];

// ─────────────────────────────────────────────
// PROMPT DEL SISTEMA
// ─────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres el asistente de gestión empresarial de Galvan Graph, empresa distribuidora de refacciones para máquinas de imprenta y artes gráficas.

REGLAS ESTRICTAS:
1. SIEMPRE usa herramientas cuando la información esté en la base de datos. NUNCA respondas "no tengo acceso" si existe una herramienta disponible.
2. Para registrar una venta: si no tienes el ID del cliente, usa primero dbBuscarCliente. Nunca inventes un ID.
3. Para registrar clientes o ventas: si faltan datos obligatorios (correo para cliente / precio o cantidad para venta), PREGUNTA antes de llamar la herramienta. Nunca inventes datos.
4. Corrige errores ortográficos obvios en nombres de productos o clientes antes de buscar.
5. Interpreta números en palabras: "cinco", "diez", "cincuenta" → 5, 10, 50.
6. Normaliza nombres similares: "análisis espacial" y "Análisis Espacial" son el mismo servicio.
7. Responde siempre en español, de forma clara y profesional.
8. Cuando muestres resultados de consultas, formatea la información de manera legible con emojis de soporte visual.
9. Si el usuario da un nombre de cliente para una venta, busca primero con dbBuscarCliente y confirma con el usuario antes de registrar si hay múltiples resultados.
10. NUNCA ejecutes operaciones de modificación o borrado fuera de las herramientas disponibles.
11. Si el usuario pregunta sobre facturas, CFDI, timbrado, cancelación de facturas o cualquier tema de facturación electrónica, responde EXACTAMENTE esto: "Por el momento el módulo de facturación no está disponible. Sin embargo el sistema ya registra si una venta requiere factura para cuando esté listo. Para facturas urgentes, puedes generarlas manualmente en factura.sat.gob.mx de forma gratuita." No ofrezcas alternativas adicionales ni intentes ejecutar ninguna herramienta relacionada.`;

// ─────────────────────────────────────────────
// DISPATCHER DE HERRAMIENTAS
// ─────────────────────────────────────────────

async function ejecutarHerramienta(nombre, args) {
  // Normalizar productos si vienen como string (bug conocido de algunos LLMs)
  if (args.productos && typeof args.productos === 'string') {
    args.productos = JSON.parse(args.productos);
  }

  const mapa = {
    dbRegistrarCliente:      () => dbRegistrarCliente(args.nombre, args.telefono, args.correo, args.rfc),
    dbRegistrarVenta:        () => dbRegistrarVenta(args.cliente_id, args.total, args.requiere_factura, args.productos),
    dbBuscarCliente:         () => dbBuscarCliente(args.nombre),
    dbConsultarVentasCliente:() => dbConsultarVentasCliente(args.cliente_id),
    dbUltimasVentas:         () => dbUltimasVentas(args.limit),
    dbResumenVentas:         () => dbResumenVentas(),
    dbVentasPorServicio:     () => dbVentasPorServicio(args.servicio),
    dbTopClientes:           () => dbTopClientes(args.limit),
    dbVentasDelMes:          () => dbVentasDelMes()
  };

  const fn = mapa[nombre];
  if (!fn) throw new Error(`Herramienta desconocida: ${nombre}`);
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

  // Primera llamada al LLM
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile', // Mejor razonamiento para function calling
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0.2  // Baja temperatura = más determinista en decisiones
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
      resultado = `Error al ejecutar ${toolCall.function.name}: ${err.message}`;
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