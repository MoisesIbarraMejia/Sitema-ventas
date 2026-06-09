import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import { procesarMensajeConIA } from './agent.js';
import { verificarUsuario } from './auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 7860;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());
app.use(cookieParser());

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
      --bg: #0f0f1a;
      --surface: #1a1a2e;
      --card: #16213e;
      --accent: #e94560;
      --accent2: #0f3460;
      --text: #eaeaea;
      --text2: #a0a0b0;
      --radius: 14px;
    }
    body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; height: 100dvh; display: flex; flex-direction: column; }

    /* LOGIN */
    #login-screen {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px;
    }
    .logo { font-size: 48px; margin-bottom: 8px; }
    .brand { font-size: 22px; font-weight: 700; color: var(--accent); margin-bottom: 4px; }
    .brand-sub { font-size: 13px; color: var(--text2); margin-bottom: 32px; }
    .login-card {
      background: var(--card); border-radius: var(--radius); padding: 28px 24px; width: 100%; max-width: 360px;
      box-shadow: 0 8px 32px rgba(233,69,96,0.15);
    }
    .login-card h2 { font-size: 18px; margin-bottom: 20px; text-align: center; }
    .field { margin-bottom: 16px; }
    .field label { font-size: 12px; color: var(--text2); display: block; margin-bottom: 6px; }
    .field input {
      width: 100%; background: var(--surface); border: 1px solid #2a2a4a; border-radius: 8px;
      padding: 12px 14px; color: var(--text); font-size: 15px; outline: none;
    }
    .field input:focus { border-color: var(--accent); }
    .btn-primary {
      width: 100%; background: var(--accent); color: white; border: none; border-radius: 8px;
      padding: 13px; font-size: 15px; font-weight: 600; cursor: pointer; margin-top: 4px;
    }
    .btn-primary:active { opacity: 0.85; }
    .error-msg { color: var(--accent); font-size: 13px; text-align: center; margin-top: 12px; }

    /* CHAT */
    #chat-screen { flex: 1; display: none; flex-direction: column; height: 100dvh; }
    .topbar {
      background: var(--card); padding: 12px 16px; display: flex; align-items: center; gap: 12px;
      border-bottom: 1px solid #2a2a4a;
    }
    .topbar-logo { font-size: 24px; }
    .topbar-info { flex: 1; }
    .topbar-name { font-weight: 700; font-size: 15px; color: var(--accent); }
    .topbar-status { font-size: 11px; color: var(--text2); }
    .btn-logout { background: none; border: 1px solid #2a2a4a; border-radius: 8px; color: var(--text2); padding: 6px 12px; font-size: 12px; cursor: pointer; }

    .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 85%; padding: 10px 14px; border-radius: 14px; font-size: 14px; line-height: 1.5; word-break: break-word; }
    .msg.user { background: var(--accent2); align-self: flex-end; border-bottom-right-radius: 4px; }
    .msg.bot { background: var(--card); align-self: flex-start; border-bottom-left-radius: 4px; }
    .msg.bot.typing { color: var(--text2); font-style: italic; }

    .input-area {
      padding: 12px 16px; background: var(--surface); border-top: 1px solid #2a2a4a;
      display: flex; gap: 10px; align-items: flex-end;
    }
    #msg-input {
      flex: 1; background: var(--card); border: 1px solid #2a2a4a; border-radius: 10px;
      padding: 10px 14px; color: var(--text); font-size: 14px; resize: none; outline: none;
      max-height: 100px; font-family: inherit;
    }
    #msg-input:focus { border-color: var(--accent); }
    .btn-send {
      background: var(--accent); border: none; border-radius: 10px; padding: 10px 14px;
      color: white; font-size: 18px; cursor: pointer; flex-shrink: 0;
    }
    .btn-send:disabled { opacity: 0.5; cursor: default; }

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
    <textarea id="msg-input" rows="1" placeholder="Escribe un mensaje..." onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
    <button class="btn-send" id="btn-send" onclick="sendMessage()">➤</button>
  </div>
</div>

<script>
  // Registrar PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }

  let nombreUsuario = '';

  async function login() {
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    if (!username || !password) { errEl.textContent = 'Completa los campos.'; return; }
    try {
      const r = await fetch('/api/login', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({username, password})
      });
      const d = await r.json();
      if (!r.ok) { errEl.textContent = d.error || 'Error al iniciar sesión.'; return; }
      nombreUsuario = d.nombre || username;
      document.getElementById('user-status').textContent = nombreUsuario;
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('chat-screen').style.display = 'flex';
    } catch(e) { errEl.textContent = 'Error de conexión.'; }
  }

  async function logout() {
    await fetch('/api/logout', {method:'POST'});
    document.getElementById('chat-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('messages').innerHTML = '<div class="msg bot">¡Hola! Soy el asistente de <b>Galvan Graph</b>. ¿En qué te ayudo?</div>';
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  }

  async function sendMessage() {
    const input = document.getElementById('msg-input');
    const msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    input.style.height = 'auto';
    addMsg(msg, 'user');
    const btn = document.getElementById('btn-send');
    btn.disabled = true;
    const typing = addMsg('Escribiendo...', 'bot typing');
    try {
      const r = await fetch('/api/chat', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({message: msg})
      });
      const d = await r.json();
      typing.remove();
      if (r.status === 401) { logout(); return; }
      addMsg(d.respuesta || d.error || 'Sin respuesta', 'bot');
    } catch(e) {
      typing.remove();
      addMsg('Error de conexión. Intenta de nuevo.', 'bot');
    }
    btn.disabled = false;
    input.focus();
  }

  function addMsg(text, cls) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.innerHTML = text.replace(/\\n/g,'<br>');
    document.getElementById('messages').appendChild(div);
    div.scrollIntoView({behavior:'smooth'});
    return div;
  }

  // Enter en login
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('password').addEventListener('keydown', e => {
      if (e.key === 'Enter') login();
    });
  });
</script>
</body>
</html>`;
}