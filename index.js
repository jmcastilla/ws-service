/**
 * WhatsApp Sender API — versión robusta
 * -------------------------------------
 * - Reintentos con backoff exponencial en getNumberId y sendMessage
 * - Autorecuperación al desconectarse (re-initialize con backoff)
 * - Endpoints /health y /status
 * - Validación de payload y normalización de números con prefijo de país opcional
 * - Fallback de media: si MessageMedia.fromUrl falla, descarga con axios y construye el media manualmente
 * - Manejo de señales (SIGINT/SIGTERM) para cierre limpio
 * - Manejo de errores no controlados para evitar caídas
 * - Logs con timestamps
 *
 * Requisitos mínimos:
 *   Node.js 18+
 *   npm i express whatsapp-web.js qrcode-terminal axios
 *
 * Variables de entorno útiles (opcionales):
 *   PORT=3001
 *   HOST=0.0.0.0
 *   DEFAULT_COUNTRY_CODE=57            // Prefijo por defecto (Colombia = 57)
 *   WWEBJS_CACHE_MODE=local            // 'local' (default) o 'none' (desactiva cache de versiones)
 *   WWEBJS_HEADLESS=true               // "true" o "false"
 */

const express = require('express');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const os = require('os');

// ---------------------- Configuración ----------------------
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_COUNTRY_CODE = (process.env.DEFAULT_COUNTRY_CODE || '').replace(/\D/g, ''); // ej. "57"
const HEADLESS = String(process.env.WWEBJS_HEADLESS || 'true').toLowerCase() === 'true';
const WEB_CACHE_MODE = (process.env.WWEBJS_CACHE_MODE || 'local').toLowerCase();

// Reintentos
const MAX_RETRIES = 3; // Intentos totales por operación
const RETRY_BASE_MS = 500; // backoff base en ms

// Timeouts
const FROM_URL_TIMEOUT_MS = 20_000; // Timeout para descarga de media

// Estado del cliente
let clientReady = false;
let clientState = 'INIT';
let reconnectTimer = null;
let lastQr = null;
let lastQrAt = null;
let initializing = false;

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[${ts}]`, ...args);
}
function warn(...args) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}]`, ...args);
}
function error(...args) {
  const ts = new Date().toISOString();
  console.error(`[${ts}]`, ...args);
}

// ---------------------- Utilidades ----------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function backoffDelay(attempt) { return RETRY_BASE_MS * Math.pow(2, attempt); }

/**
 * Normaliza un número:
 * - Deja solo dígitos
 * - Si no tiene prefijo de país y DEFAULT_COUNTRY_CODE está definido, lo agrega
 * - Devuelve null si es muy corto (< 8 dígitos)
 */
function normalizeNumber(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  // Si ya parece tener prefijo (>= 11 dígitos típico internacional), usar tal cual
  if (digits.length >= 11) return digits;

  // Si es 8-10 dígitos y tenemos country code por defecto, lo anteponemos
  if (digits.length >= 8 && digits.length <= 10 && DEFAULT_COUNTRY_CODE) {
    digits = DEFAULT_COUNTRY_CODE + digits;
  }

  return digits.length >= 8 ? digits : null;
}

/**
 * Intenta construir MessageMedia desde URL.
 * Primero usa MessageMedia.fromUrl (rápido y cómodo). Si falla, intenta descarga manual con axios.
 */
async function buildMediaFromUrl(imageUrl) {
  // 1) Intento directo con wwebjs
  try {
    const media = await MessageMedia.fromUrl(imageUrl, {
      unsafeMime: true,
      timeout: FROM_URL_TIMEOUT_MS
    });
    return media;
  } catch (err) {
    warn('fromUrl falló, usando fallback manual:', String(err && err.message || err));
  }

  // 2) Fallback manual con axios
  try {
    const resp = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: FROM_URL_TIMEOUT_MS,
      maxContentLength: 25 * 1024 * 1024, // 25MB
      headers: { 'User-Agent': `whatsapp-sender/${os.hostname()}` }
    });
    const contentType = resp.headers['content-type'] || 'image/jpeg';
    const base64 = Buffer.from(resp.data).toString('base64');
    const filename = imageUrl.split('/').pop().split('?')[0] || 'image';
    return new MessageMedia(contentType, base64, filename);
  } catch (err) {
    throw new Error(`No se pudo descargar la imagen: ${String(err && err.message || err)}`);
  }
}

/** Ejecuta una función asíncrona con reintentos */
async function withRetries(fn, label = 'op') {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message || err);
      const d = backoffDelay(attempt);
      warn(`Fallo en ${label} (intento ${attempt + 1}/${MAX_RETRIES}): ${msg}. Reintentando en ${d}ms...`);
      await sleep(d);
    }
  }
  throw lastErr;
}

// ---------------------- Cliente de WhatsApp ----------------------
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process'
    ]
  },
  // Cache de versión del webapp para mayor estabilidad (evita desajustes frecuentes)
  webVersionCache: WEB_CACHE_MODE === 'local' ? { type: 'local' } : undefined
});

async function scheduleReconnect() {
  if (reconnectTimer) return; // ya hay uno programado
  let retries = 0;
  reconnectTimer = setInterval(async () => {
    if (clientReady || initializing) return;
    retries += 1;
    const delay = Math.min(30_000, backoffDelay(retries));
    warn(`Intentando reconectar (reintento #${retries}) en ${delay}ms...`);
    await sleep(delay);
    try {
      await initClient();
    } catch (err) {
      warn('Reintento de init falló:', String(err && err.message || err));
    }
  }, 35_000);
}

async function initClient() {
  if (initializing) return; // evita dobles inicializaciones
  initializing = true;
  try {
    log('Inicializando cliente de WhatsApp...');
    await client.initialize();
  } finally {
    // El flag se baja en ready / auth_failure / disconnected
  }
}

// Eventos del cliente
client.on('qr', (qr) => {
  lastQr = qr;
  lastQrAt = new Date();
  log('Escanea este código QR para conectar WhatsApp (se muestra en consola):');
  qrcode.generate(qr, { small: true });
});

client.on('loading_screen', (percent, message) => {
  log(`Cargando ${percent}%: ${message}`);
});

client.on('change_state', (state) => {
  clientState = state || 'UNKNOWN';
  log('Estado de WhatsApp:', clientState);
});

client.on('ready', () => {
  clientReady = true;
  initializing = false;
  if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
  log('✅ Cliente de WhatsApp conectado y listo');
});

client.on('authenticated', () => {
  log('Autenticado ✅');
});

client.on('auth_failure', (msg) => {
  clientReady = false;
  initializing = false;
  error('❌ Falla de autenticación:', msg);
  scheduleReconnect();
});

client.on('disconnected', (reason) => {
  clientReady = false;
  initializing = false;
  error('⚠️ Cliente desconectado:', reason);
  scheduleReconnect();
});

// ---------------------- Servidor HTTP ----------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), ready: clientReady });
});

app.get('/status', (req, res) => {
  res.json({
    ready: clientReady,
    state: clientState,
    lastQrAt: lastQrAt ? lastQrAt.toISOString() : null,
    host: os.hostname(),
  });
});

// (Opcional) Obtener el último QR crudo (útil si quieres renderizarlo en otro lado)
app.get('/qr', (req, res) => {
  if (!lastQr) return res.status(404).json({ error: 'No hay QR disponible por ahora.' });
  res.json({ qr: lastQr, lastQrAt: lastQrAt ? lastQrAt.toISOString() : null });
});

/**
 * POST /send-whatsapp
 * body: {
 *   numbers: string[],            // requerido
 *   imageUrl?: string,            // opcional si envías texto
 *   caption?: string,             // opcional (pie de foto)
 *   text?: string                 // opcional (si no hay imageUrl)
 * }
 */
app.post('/send-whatsapp', async (req, res) => {
  const { numbers, imageUrl, caption, text } = req.body || {};

  if (!Array.isArray(numbers) || numbers.length === 0) {
    return res.status(400).json({ error: 'Faltan parámetros: numbers[]' });
  }
  if (!clientReady) {
    return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
  }
  if (!imageUrl && !text) {
    return res.status(400).json({ error: 'Debes enviar imageUrl o text.' });
  }

  let media = null;
  if (imageUrl) {
    try {
      media = await withRetries(() => buildMediaFromUrl(imageUrl), 'buildMediaFromUrl');
    } catch (err) {
      return res.status(400).json({ error: 'No se pudo preparar la imagen', detail: String(err && err.message || err) });
    }
  }

  const results = [];

  // Secuencial por estabilidad (evita saturar el store/browser)
  for (const raw of numbers) {
    const normalized = normalizeNumber(raw);
    if (!normalized) {
      results.push({ number: raw, status: 'failed', reason: 'Número inválido' });
      continue;
    }

    try {
      // getNumberId con reintentos
      const numberId = await withRetries(() => client.getNumberId(normalized), 'getNumberId');
      if (!numberId) {
        results.push({ number: normalized, status: 'failed', reason: 'El número no tiene WhatsApp' });
        continue;
      }

      const chatId = numberId._serialized; // ej. "57300...@c.us"

      // Precargar el chat en el store (mitiga bug)
      try { await client.getChatById(chatId); } catch (_) {}

      try {
        if (media) {
          await withRetries(() => client.sendMessage(chatId, media, { caption }), 'sendMessage(media)');
        } else if (text) {
          await withRetries(() => client.sendMessage(chatId, String(text)), 'sendMessage(text)');
        }
        log(`✅ Enviado a: ${normalized}`);
        results.push({ number: normalized, status: 'sent' });
      } catch (err) {
        const msg = String(err && err.message || err);
        if (msg.includes('getMessageModel') || msg.includes('serialize')) {
          warn(`⚠️ Enviado a ${normalized}, pero con warning de serialize (bug wwebjs)`);
          results.push({ number: normalized, status: 'sent_with_warning', warning: 'Bug de serialización en wwebjs' });
        } else {
          error(`❌ Error al enviar a ${normalized}:`, msg);
          results.push({ number: normalized, status: 'failed', reason: msg });
        }
      }

      // Pequeño delay entre envíos
      await sleep(150);
    } catch (err) {
      const msg = String(err && err.message || err);
      error(`❌ Error previo a enviar a ${normalized}:`, msg);
      results.push({ number: normalized, status: 'failed', reason: msg });
    }
  }

  const sent = results.filter(r => r.status === 'sent' || r.status === 'sent_with_warning').length;
  const failed = results.filter(r => r.status === 'failed');

  res.json({
    status: `Mensajes enviados: ${sent}, fallidos: ${failed.length}`,
    detail: results
  });
});

// ---------------------- Arranque y señales ----------------------
const server = app.listen(PORT, HOST, () => {
  log(`🚀 Servidor escuchando en http://${HOST}:${PORT}`);
});

initClient().catch(err => {
  initializing = false;
  error('Fallo al inicializar el cliente:', String(err && err.message || err));
  scheduleReconnect();
});

async function gracefulShutdown(signal) {
  try {
    log(`Recibida señal ${signal}. Cerrando limpiamente...`);
    server && server.close(() => log('HTTP server cerrado'));
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
  } catch (err) {
    error('Error en shutdown:', String(err && err.message || err));
    process.exit(1);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  error('unhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
  error('uncaughtException:', err);
  // No forzamos exit inmediato; intentamos seguir vivos. Ajusta si prefieres reiniciar con PM2.
});
