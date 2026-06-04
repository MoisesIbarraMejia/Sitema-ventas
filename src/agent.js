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

// --- FUNCIONES PURAS DE JAVASCRIPT (HERRAMIENTAS) ---

async function dbRegistrarCliente(nombre, telefono, correo, rfc) {
  const query = `
    INSERT INTO public.clientes (nombre, telefono, correo, rfc_o_tax_id) 
    VALUES ($1, $2, $3, $4) 
    RETURNING id, nombre, correo;
  `;
  const result = await pool.query(query, [nombre, telefono || null, correo, rfc || null]);
  return `Éxito: Cliente registrado con ID ${result.rows[0].id}.`;
}

// --- LOGICA PRINCIPAL DEL AGENTE ---
export async function procesarMensajeConIA(userMessage) {
  
  // Definición de las herramientas que entiende Llama 3
  const tools = [{
    type: 'function',
    function: {
      name: 'dbRegistrarCliente',
      description: 'Registra un nuevo cliente en la base de datos de Supabase cuando el usuario proporciona sus datos como nombre y correo.',
      parameters: {
        type: 'object',
        properties: {
          nombre: { type: 'string', description: 'Nombre completo del cliente.' },
          telefono: { type: 'string', description: 'Número de teléfono (opcional).' },
          correo: { type: 'string', description: 'Correo electrónico del cliente.' },
          rfc: { type: 'string', description: 'RFC o Tax ID del cliente (opcional).' }
        },
        required: ['nombre', 'correo']
      }
    }
  }];

  // Primera llamada a Groq para analizar la intención del usuario
  const response = await groq.chat.completions.create({
    model: 'llama3-70b-8192',
    messages: [
      { role: 'system', content: 'Eres un asistente administrativo experto. Tu objetivo es ayudar a registrar clientes o ventas usando las herramientas provistas. Si faltan datos obligatorios como el correo del cliente, pídelos amablemente.' },
      { role: 'user', content: userMessage }
    ],
    tools: tools,
    tool_choice: 'auto'
  });

  const responseMessage = response.choices[0].message;

  // Verificar si la IA decidió ejecutar una herramienta
  if (responseMessage.tool_calls) {
    for (const toolCall of responseMessage.tool_calls) {
      if (toolCall.function.name === 'dbRegistrarCliente') {
        const args = JSON.parse(toolCall.function.arguments);
        
        // Ejecutamos la inserción real en Supabase
        const resultadoSQL = await dbRegistrarCliente(args.nombre, args.telefono, args.correo, args.rfc);
        
        // Respondemos confirmando la acción
        return `${resultadoSQL} Nombre: ${args.nombre}, Correo: ${args.correo}.`;
      }
    }
  }

  // Si la IA no ejecutó herramientas (ej. sólo saludó), devolvemos su respuesta textual
  return responseMessage.content;
}