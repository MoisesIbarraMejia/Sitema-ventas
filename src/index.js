import express from 'express';
import dotenv from 'dotenv';
import pkg from 'whatsapp-web.js';
import QRCode from 'qrcode';
import { procesarMensajeConIA } from './agent.js';

const { Client, LocalAuth } = pkg;

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 7860;

let qrCodeSvg = null;
let currentStatus = "Iniciando motor de WhatsApp...";

// Inicializar el cliente sin guardar sesión persistente en disco (evita bloqueos de HF)
// Reemplaza la configuración del cliente por esta:
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "geoma_session_2026" // Forzamos un ID de cliente único para renovar el intento
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    },
    // AQUÍ EL TRUCO TRUCO: Le hacemos creer a WhatsApp que somos un Chrome de última generación en Mac
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
});

// Evento: Generando QR
client.on('qr', (qr) => {
    console.log(' [WhatsApp]: ¡Código QR recibido con éxito!');
    currentStatus = "Esperando escaneo de código QR...";
    QRCode.toString(qr, { type: 'svg' }, (err, svg) => {
        if (!err) qrCodeSvg = svg;
    });
});

// Evento: Listo / Conectado
client.on('ready', () => {
    console.log(' [WhatsApp]: ¡Conexión exitosa y vinculada!');
    currentStatus = "Conectado y Operando.";
    qrCodeSvg = null;
});

// Evento: Error de autenticación o desconexión
client.on('disconnected', (reason) => {
    console.log('[WhatsApp]: Sesión cerrada o desconectada:', reason);
    currentStatus = "Desconectado. Intentando generar nuevo QR...";
    qrCodeSvg = null;
    client.initialize();
});

// --- MOTOR PRINCIPAL: ESCUCHAR LOS MENSAJES ENTRANTES ---
// --- LISTA BLANCA DE ADMINISTRADORES AUTORIZADOS ---
// Agrega aquí los números que sí tienen permiso de interactuar con la IA.
// El formato de WhatsApp Web es: "521XXXXXXXXXX@c.us" (Código de país + número + @c.us)
// --- LISTA BLANCA DE ADMINISTRADORES AUTORIZADOS ---
const NUMEROS_AUTORIZADOS = [
    '5215569776299@c.us' 
];

// --- MOTOR PRINCIPAL: ESCUCHAR LOS MENSAJES ENTRANTES ---
client.on('message', async (msg) => {
    // 1. Evitamos responder a grupos o chats vacíos
    if (msg.from.includes('@g.us') || !msg.body) return;

    // 2. FILTRO DE SEGURIDAD CRÍTICO:
    // Comparamos si el número que escribe coincide exactamente con los autorizados
    if (!NUMEROS_AUTORIZADOS.includes(msg.from)) {
        console.log(`[Seguridad]: Intento de acceso denegado desde el número: ${msg.from}`);
        return; // Detiene la ejecución en seco para cualquiera que no seas tú
    }

    // Si pasa el filtro, el servidor sabe con certeza que eres tú
    console.log(`[Comando Autorizado de Moisés]: ${msg.body}`);

    try {
        // Enviar el texto al agente de Groq + Supabase
        const respuestaIA = await procesarMensajeConIA(msg.body);
        
        // Responder el resultado directamente a tu WhatsApp
        await msg.reply(respuestaIA);
        console.log(`[Respuesta enviada con éxito]`);
    } catch (error) {
        console.error('[Error en el Agente de IA]:', error);
        await msg.reply("Disculpa, hubo un inconveniente técnico al procesar el comando.");
    }
});

// Arrancar el motor de WhatsApp
client.initialize().catch(err => console.error("Error inicializando cliente:", err));


// --- RUTAS WEB ---
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    let htmlContent = `
      <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
        <h1>Estatus del Conector WhatsApp: ${currentStatus}</h1>
    `;
  
    if (qrCodeSvg) {
      htmlContent += `
        <p>Abre WhatsApp en tu teléfono -> Dispositivos Vinculados y escanea este código:</p>
        <div style="margin: 20px auto; width: 300px; height: 300px;">${qrCodeSvg}</div>
      `;
    } else if (currentStatus === "Conectado y Operando.") {
      htmlContent += `
        <p style="color: green; font-size: 20px;"><b>¡Todo listo! Tu IA está respondiendo mensajes en este número.</b></p>
      `;
    }
  
    htmlContent += `</div>`;
    res.send(htmlContent);
});

app.post('/webhook', async (req, res) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ success: false, error: "Falta message." });
      const resultadoIA = await procesarMensajeConIA(message);
      return res.status(200).json({ success: true, agent_response: resultadoIA });
    } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(` Servidor operativo en puerto ${PORT}`);
});