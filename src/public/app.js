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
    if (!r.ok) { errEl.textContent = d.error || 'Error al iniciar sesion.'; return; }
    nombreUsuario = d.nombre || username;
    document.getElementById('user-status').textContent = nombreUsuario;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('chat-screen').style.display = 'flex';
  } catch(e) { errEl.textContent = 'Error de conexion.'; }
}

async function logout() {
  await fetch('/api/logout', {method:'POST'});
  document.getElementById('chat-screen').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('messages').innerHTML = '<div class="msg bot">Hola! Soy el asistente de <b>Galvan Graph</b>. En que te ayudo?</div>';
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
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({message: msg})
    });
    const d = await r.json();
    typing.remove();
    if (r.status === 401) { logout(); return; }
    addMsg(d.respuesta || d.error || 'Sin respuesta', 'bot');
  } catch(e) {
    typing.remove();
    addMsg('Error de conexion. Intenta de nuevo.', 'bot');
  }
  btn.disabled = false;
  input.focus();
}

function addMsg(text, cls) {
  const div = document.createElement('div');
  div.className = 'msg ' + cls;
  div.innerHTML = text.replace(/\n/g, '<br>');
  document.getElementById('messages').appendChild(div);
  div.scrollIntoView({behavior: 'smooth'});
  return div;
}

async function subirPDF(event) {
  const file = event.target.files[0];
  if (!file) return;
  event.target.value = '';

  const loadingMsg = addMsg('Buscando ventas con factura pendiente...', 'bot typing');

  let pendientes = [];
  try {
    const r = await fetch('/api/facturas-pendientes');
    pendientes = await r.json();
  } catch(e) {
    loadingMsg.remove();
    addMsg('Error al obtener facturas pendientes.', 'bot');
    return;
  }
  loadingMsg.remove();

  if (pendientes.length === 0) {
    addMsg('No hay ventas con factura pendiente. El PDF no fue subido.', 'bot');
    return;
  }

  let opcionesHTML = '';
  for (let i = 0; i < pendientes.length; i++) {
    const v = pendientes[i];
    const fecha = new Date(v.fecha_venta).toLocaleDateString('es-MX');
    opcionesHTML += '<button onclick="confirmarSubidaPDF(' + v.venta_id + ', \'' + v.cliente + '\', this)" ' +
      'style="display:block;width:100%;text-align:left;background:var(--surface);' +
      'border:1px solid #2a2a4a;border-radius:8px;padding:10px 12px;' +
      'margin-bottom:8px;color:var(--text);cursor:pointer;font-size:13px;">' +
      '<b>#' + v.venta_id + '</b> — ' + v.cliente + '<br>' +
      '<span style="color:var(--text2);font-size:12px;">$' + v.total + ' · ' + fecha + ' · ' + v.dias_pendiente + ' dias pendiente</span>' +
      '</button>';
  }

  const selectorMsg = addMsg(
    '<b>A que venta corresponde este PDF?</b><br><br>' + opcionesHTML +
    '<button onclick="this.closest(\'.msg\').remove()" ' +
    'style="background:none;border:none;color:var(--text2);font-size:12px;cursor:pointer;margin-top:4px;">' +
    'Cancelar</button>',
    'bot'
  );

  window._pdfPendiente = { file: file, selectorMsg: selectorMsg };
}

async function confirmarSubidaPDF(ventaId, clienteNombre, btnEl) {
  const pending = window._pdfPendiente;
  if (!pending || !pending.file) return;

  const file = pending.file;
  const selectorMsg = pending.selectorMsg;

  selectorMsg.remove();
  delete window._pdfPendiente;

  const uploadMsg = addMsg('Subiendo PDF para venta #' + ventaId + ' de ' + clienteNombre + '...', 'bot typing');

  const formData = new FormData();
  formData.append('pdf', file);

  try {
    const r = await fetch('/api/subir-pdf/' + ventaId, {
      method: 'POST',
      body: formData
    });
    const d = await r.json();
    uploadMsg.remove();

    if (!r.ok) {
      addMsg('Error: ' + d.error, 'bot');
    } else {
      addMsg(
        d.mensaje + '<br><br>Ver PDF: <a href="' + d.url_pdf + '" target="_blank" style="color:var(--accent)">' + d.url_pdf + '</a>',
        'bot'
      );
    }
  } catch(e) {
    uploadMsg.remove();
    addMsg('Error de conexion al subir el PDF.', 'bot');
  }
}

document.addEventListener('DOMContentLoaded', function() {
  document.getElementById('password').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') login();
  });
});