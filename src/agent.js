import Groq from 'groq-sdk';
import dotenv from 'dotenv';
import { pool } from './auth.js';  // ← CAMBIO: importar pool compartido
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- HERRAMIENTAS (las 2 actuales se quedan igual, se agregan 2 nuevas) ---

async function dbRegistrarCliente(nombre, telefono, correo, rfc) {
  // igual que antes...
}

async function dbRegistrarVenta(cliente_id, total, requiere_factura, productos) {
  // igual que antes...
}

// NUEVA herramienta 3
async function dbConsultarCliente(nombre) {
  const res = await pool.query(
    `SELECT id, nombre, telefono, correo FROM public.clientes 
     WHERE nombre ILIKE $1 LIMIT 5`,
    [`%${nombre}%`]
  );
  if (res.rows.length === 0) return 'No se encontró ningún cliente con ese nombre.';
  return JSON.stringify(res.rows);
}

// NUEVA herramienta 4
async function dbConsultarVentas(cliente_id) {
  const res = await pool.query(
    `SELECT v.id, v.fecha_venta, v.total, v.estado_pago, v.requiere_factura
     FROM public.ventas v WHERE v.cliente_id = $1 ORDER BY v.fecha_venta DESC LIMIT 10`,
    [cliente_id]
  );
  if (res.rows.length === 0) return 'Este cliente no tiene ventas registradas.';
  return JSON.stringify(res.rows);
}

// CAMBIO PRINCIPAL: recibe historial[]
export async function procesarMensajeConIA(userMessage, historial = []) {
  
  const tools = [
    // ... las 2 herramientas actuales igual ...
    {
      type: 'function',
      function: {
        name: 'dbConsultarCliente',
        description: 'Busca clientes por nombre para obtener su ID.',
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
        name: 'dbConsultarVentas',
        description: 'Consulta el historial de ventas de un cliente por su ID.',
        parameters: {
          type: 'object',
          properties: {
            cliente_id: { type: 'integer', description: 'ID numérico del cliente.' }
          },
          required: ['cliente_id']
        }
      }
    }
  ];

  // CAMBIO: historial se inyecta entre system y user
  const messages = [
    { 
      role: 'system', 
      content: `Eres el asistente inteligente de Galvan Graph, empresa de refacciones para máquinas de imprenta y artes gráficas. 
      Ayudas a registrar clientes, ventas y consultar información. 
      Siempre responde en español. Sé amable y profesional.
      Si necesitas el ID de un cliente para registrar una venta, usa primero dbConsultarCliente.` 
    },
    ...historial,  // ← mensajes previos de la sesión
    { role: 'user', content: userMessage }
  ];

  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages,
    tools,
    tool_choice: 'auto'
  });

  const responseMessage = response.choices[0].message;

  if (responseMessage.tool_calls) {
    const toolResults = [];
    for (const toolCall of responseMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      let resultado;
      if (toolCall.function.name === 'dbRegistrarCliente')
        resultado = await dbRegistrarCliente(args.nombre, args.telefono, args.correo, args.rfc);
      if (toolCall.function.name === 'dbRegistrarVenta') {
        let productos = args.productos;
        if (typeof productos === 'string') productos = JSON.parse(productos);
        resultado = await dbRegistrarVenta(args.cliente_id, args.total, args.requiere_factura, productos);
      }
      if (toolCall.function.name === 'dbConsultarCliente')
        resultado = await dbConsultarCliente(args.nombre);
      if (toolCall.function.name === 'dbConsultarVentas')
        resultado = await dbConsultarVentas(args.cliente_id);
      toolResults.push({ tool_call_id: toolCall.id, resultado });
    }
    // Segunda llamada con resultados de tools
    const finalResponse = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        ...messages,
        responseMessage,
        ...toolResults.map(t => ({
          role: 'tool',
          tool_call_id: t.tool_call_id,
          content: t.resultado
        }))
      ]
    });
    return finalResponse.choices[0].message.content;
  }

  return responseMessage.content;
}