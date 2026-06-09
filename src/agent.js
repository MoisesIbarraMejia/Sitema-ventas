import Groq from 'groq-sdk';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// 1. Configuración de la base de datos Supabase
const pool = new pg.Pool({
  host: 'aws-1-us-west-2.pooler.supabase.com',
  port: 6543,
  user: 'postgres.fibjlqgznlpptlfzuwvl',
  password: process.env.SUPABASE_DB_PASSWORD, 
  database: 'postgres',
  ssl: { rejectUnauthorized: false }
});

// 2. Inicializar cliente oficial de Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- HERRAMIENTAS DE BASE DE DATOS (POSTGRESQL) ---

// Herramienta 1: Registrar Cliente
async function dbRegistrarCliente(nombre, telefono, correo, rfc) {
  const query = `
    INSERT INTO public.clientes (nombre, telefono, correo, rfc_o_tax_id) 
    VALUES ($1, $2, $3, $4) 
    RETURNING id, nombre;
  `;
  const result = await pool.query(query, [nombre, telefono || null, correo, rfc || null]);
  return `Éxito: Cliente registrado con ID ${result.rows[0].id}.`;
}

// Herramienta 2: Registrar Venta y sus Detalles (Transaccional)
async function dbRegistrarVenta(cliente_id, total, requiere_factura, productos) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Iniciamos transacción para no dejar datos huérfanos

    // A) Insertar en la tabla ventas
    const ventaQuery = `
      INSERT INTO public.ventas (cliente_id, total, requiere_factura, estado_pago)
      VALUES ($1, $2, $3, 'PAGADO')
      RETURNING id;
    `;
    const ventaRes = await client.query(ventaQuery, [cliente_id, total, requiere_factura || false]);
    const ventaId = ventaRes.rows[0].id;

    // B) Insertar cada producto en detalles_ventas
    const detalleQuery = `
      INSERT INTO public.detalles_ventas (venta_id, producto_servicio, cantidad, precio_unitario)
      VALUES ($1, $2, $3, $4);
    `;
    
    for (const prod of productos) {
      await client.query(detalleQuery, [ventaId, prod.producto_servicio, prod.cantidad, prod.precio_unitario]);
    }

    await client.query('COMMIT'); // Confirmamos los cambios en la BD
    return `Éxito: Venta registrada con ID ${ventaId} asociada al cliente ${cliente_id}.`;

  } catch (error) {
    await client.query('ROLLBACK'); // Si algo falla, deshacemos todo
    throw error;
  } finally {
    client.release();
  }
}

// --- LÓGICA PRINCIPAL DEL AGENTE ---
export async function procesarMensajeConIA(userMessage) {
  
  // Definición de las herramientas para Groq
  const tools = [
    {
      type: 'function',
      function: {
        name: 'dbRegistrarCliente',
        description: 'Registra un nuevo cliente cuando el usuario da datos de contacto.',
        parameters: {
          type: 'object',
          properties: {
            nombre: { type: 'string', description: 'Nombre completo.' },
            telefono: { type: 'string', description: 'Teléfono (opcional).' },
            correo: { type: 'string', description: 'Correo electrónico.' },
            rfc: { type: 'string', description: 'RFC (opcional).' }
          },
          required: ['nombre', 'correo']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'dbRegistrarVenta',
        description: 'Registra una venta financiera con su desglose de artículos.',
        parameters: {
          type: 'object',
          properties: {
            cliente_id: { type: 'integer', description: 'El ID numérico del cliente que compra.' },
            total: { type: 'number', description: 'Monto total acumulado de la venta.' },
            requiere_factura: { type: 'boolean', description: 'Si el cliente pidió factura o no.' },
            productos: {
              type: 'array',
              description: 'Lista de artículos comprados.',
              items: {
                type: 'object',
                properties: {
                  producto_servicio: { type: 'string', description: 'Nombre del artículo.' },
                  cantidad: { type: 'integer', description: 'Unidades compradas.' },
                  precio_unitario: { type: 'number', description: 'Precio por unidad.' }
                },
                required: ['producto_servicio', 'cantidad', 'precio_unitario']
              }
            }
          },
          required: ['cliente_id', 'total', 'productos']
        }
      }
    }
  ];

  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      { role: 'system', content: 'Eres un administrador de negocio inteligente. Ejecutas acciones de base de datos analizando los textos del usuario. Si detectas una venta, extrae minuciosamente la lista de productos, sus precios y calcula el total si el usuario no lo da explícito.' },
      { role: 'user', content: userMessage }
    ],
    tools: tools,
    tool_choice: 'auto'
  });

  const responseMessage = response.choices[0].message;

  if (responseMessage.tool_calls) {
    for (const toolCall of responseMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);
      
      if (toolCall.function.name === 'dbRegistrarCliente') {
        return await dbRegistrarCliente(args.nombre, args.telefono, args.correo, args.rfc);
      }
      
      if (toolCall.function.name === 'dbRegistrarVenta') {
        // --- PARCHE DE SEGURIDAD ---
        // Si la IA mandó los productos como un string de texto, lo parseamos a Array nativo
        let productosCorregidos = args.productos;
        if (typeof productosCorregidos === 'string') {
          productosCorregidos = JSON.parse(productosCorregidos);
        }
        
        // Enviamos los datos limpios a la base de datos
        return await dbRegistrarVenta(args.cliente_id, args.total, args.requiere_factura, productosCorregidos);
      }
    }
  }

  return responseMessage.content;
}