import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import { procesarMensajeConIA } from './agent.js';
import { verificarUsuario } from './auth.js';
import { subirPDFFactura } from './storage.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 7860;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF'));
  }
});

// Sesiones en memoria (sin redis, gratis)
const sesiones = new Map();

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token || !sesiones.has(token)) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  req.usuario = sesiones.get(token);
  next();
}

// LOGIN
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const usuario = await verificarUsuario(username, password);
  if (!usuario) return res.status(401).json({ error: 'Credenciales incorrectas' });
  const token = crypto.randomUUID();
  sesiones.set(token, { id: usuario.id, username: usuario.username, nombre: usuario.nombre_completo });
  // historial de conversación por sesión
  sesiones.get(token).historial = [];
  res.cookie('session', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }); // 8 horas
  res.json({ ok: true, nombre: usuario.nombre_completo });
});

// LOGOUT
app.post('/api/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) sesiones.delete(token);
  res.clearCookie('session');
  res.json({ ok: true });
});

// CHAT
app.post('/api/chat', requireAuth, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Falta message' });
  const sesion = sesiones.get(req.cookies.session);
  try {
    const respuesta = await procesarMensajeConIA(message, sesion.historial);
    // Guardar en historial de sesión
    sesion.historial.push({ role: 'user', content: message });
    sesion.historial.push({ role: 'assistant', content: respuesta });
    // Limitar historial a últimos 20 mensajes para no explotar tokens
    if (sesion.historial.length > 20) sesion.historial = sesion.historial.slice(-20);
    res.json({ respuesta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del agente' });
  }
});

// PWA: manifest
app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'Galvan Graph IA',
    short_name: 'GalvanGraph',
    description: 'Asistente de ventas Galvan Graph',
    start_url: '/',
    display: 'standalone',
    background_color: '#1a1a2e',
    theme_color: '#e94560',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  });
});

// PWA: service worker
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => clients.claim());
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
  `);
});

// FRONTEND (PWA)
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(getHTML());
});

// SUBIR PDF DE FACTURA
app.post('/api/subir-pdf/:ventaId', requireAuth, upload.single('pdf'), async (req, res) => {
  try {
    const ventaId = parseInt(req.params.ventaId);
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún PDF.' });
    if (isNaN(ventaId)) return res.status(400).json({ error: 'ID de venta inválido.' });

    const nombreArchivo = `factura-${Date.now()}.pdf`;
    const resultado = await subirPDFFactura(ventaId, req.file.buffer, nombreArchivo);

    res.json({
      ok: true,
      mensaje: `PDF subido correctamente para la venta #${ventaId} del cliente ${resultado.cliente}.`,
      url_pdf: resultado.url_pdf
    });
  } catch (err) {
    console.error('[Error subir PDF]:', err);
    res.status(500).json({ error: err.message });
  }
});



app.listen(PORT, () => console.log(`Servidor Galvan Graph en puerto ${PORT}`));

function getHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <meta name="theme-color" content="#e94560"/>
  <title>Galvan Graph IA</title>
  <link rel="manifest" href="/manifest.json"/>
  <style>
    /* Reset y variables */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #f5f6fa;
      --surface: #ffffff;
      --card: #ffffff;
      --accent: #2563eb;
      --accent2: #dbeafe;
      --text: #1e293b;
      --text2: #64748b;
      --border: #e2e8f0;
      --radius: 12px;
    }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; height: 100dvh; display: flex; flex-direction: column; }

    /* LOGIN */
    #login-screen {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; background: var(--bg);
    }
    .logo { font-size: 40px; margin-bottom: 8px; }
    .brand { font-size: 20px; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
    .brand-sub { font-size: 13px; color: var(--text2); margin-bottom: 32px; }
    .login-card {
      background: var(--surface); border-radius: var(--radius); padding: 28px 24px;
      width: 100%; max-width: 360px; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.06);
      border: 1px solid var(--border);
    }
    .login-card h2 { font-size: 17px; margin-bottom: 20px; text-align: center; color: var(--text); font-weight: 600; }
    .field { margin-bottom: 16px; }
    .field label { font-size: 12px; color: var(--text2); display: block; margin-bottom: 6px; font-weight: 500; }
    .field input {
      width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
      padding: 11px 14px; color: var(--text); font-size: 15px; outline: none; box-sizing: border-box;
    }
    .field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    .btn-primary {
      width: 100%; background: var(--accent); color: white; border: none; border-radius: 8px;
      padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 4px;
    }
    .btn-primary:active { opacity: 0.9; }
    .error-msg { color: #dc2626; font-size: 13px; text-align: center; margin-top: 12px; }

    /* CHAT */
    #chat-screen { flex: 1; display: none; flex-direction: column; height: 100dvh; background: var(--bg); }
    .topbar {
      background: var(--surface); padding: 12px 16px; display: flex; align-items: center; gap: 12px;
      border-bottom: 1px solid var(--border); box-shadow: 0 1px 3px rgba(0,0,0,0.04);
    }
    .topbar-logo { font-size: 22px; }
    .topbar-info { flex: 1; }
    .topbar-name { font-weight: 700; font-size: 15px; color: var(--text); }
    .topbar-status { font-size: 11px; color: var(--text2); }
    .btn-logout {
      background: none; border: 1px solid var(--border); border-radius: 8px;
      color: var(--text2); padding: 6px 12px; font-size: 12px; cursor: pointer;
    }
    .btn-logout:hover { border-color: #dc2626; color: #dc2626; }

    .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 82%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.55; word-break: break-word; }
    .msg.user {
      background: var(--accent); color: white; align-self: flex-end;
      border-bottom-right-radius: 4px;
    }
    .msg.bot {
      background: var(--surface); color: var(--text); align-self: flex-start;
      border-bottom-left-radius: 4px; border: 1px solid var(--border);
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .msg.bot.typing { color: var(--text2); font-style: italic; }

    .input-area {
      padding: 12px 16px; background: var(--surface); border-top: 1px solid var(--border);
      display: flex; gap: 8px; align-items: flex-end;
    }
    .btn-attach {
      background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
      padding: 10px 12px; cursor: pointer; font-size: 16px; flex-shrink: 0; line-height: 1;
    }
    .btn-attach:hover { border-color: var(--accent); }
    #msg-input {
      flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
      padding: 10px 14px; color: var(--text); font-size: 14px; resize: none; outline: none;
      max-height: 100px; font-family: inherit;
    }
    #msg-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.1); }
    .btn-send {
      background: var(--accent); border: none; border-radius: 10px; padding: 10px 14px;
      color: white; font-size: 16px; cursor: pointer; flex-shrink: 0; line-height: 1;
    }
    .btn-send:disabled { opacity: 0.4; cursor: default; }

    #login-screen.hidden, #chat-screen.hidden { display: none !important; }

    .logo img{
      width:120px;
      height:auto;
    }
  </style>
</head>
<body>

<!-- LOGIN -->
<div id="login-screen">
  <div class="logo">
    <img src="/logo.svg" alt="Galvan Graph">
  </div>
  <div class="brand">Galvan Graph</div>
  <div class="brand-sub">Sistema de control con IA</div>
  <div class="login-card">
    <h2>Iniciar sesión</h2>
    <div class="field">
      <label>Usuario</label>
      <input type="text" id="username" placeholder="usuario" autocomplete="username"/>
    </div>
    <div class="field">
      <label>Contraseña</label>
      <input type="password" id="password" placeholder="••••••••" autocomplete="current-password"/>
    </div>
    <button class="btn-primary" onclick="login()">Entrar</button>
    <div id="login-error" class="error-msg"></div>
  </div>
</div>

<!-- CHAT -->
<div id="chat-screen">
  <div class="topbar">
    <div class="topbar-logo">⚙️</div>
    <div class="topbar-info">
      <div class="topbar-name">Galvan Graph IA</div>
      <div class="topbar-status" id="user-status">Conectado</div>
    </div>
    <button class="btn-logout" onclick="logout()">Salir</button>
  </div>
  <div class="messages" id="messages">
    <div class="msg bot">¡Hola! Soy el asistente de <b>Galvan Graph</b>. Puedo registrar clientes, ventas y consultar información. ¿En qué te ayudo?</div>
  </div>
  <div class="input-area">
    <label class="btn-attach" title="Subir PDF de factura" onclick="document.getElementById('pdf-input').click()">📎</label>
    <input type="file" id="pdf-input" accept=".pdf" style="display:none" onchange="subirPDF(event)"/>
    <textarea id="msg-input" rows="1" placeholder="Escribe un mensaje..." onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
    <button class="btn-send" id="btn-send" onclick="sendMessage()">➤</button>
  </div>
</div>

<script src="/app.js"></script>
</body>
</html>`;
}