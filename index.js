const express = require('express');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const app = express();
app.use(express.json()); // body-parser integrado

let clientReady = false;

// Inicializar cliente de WhatsApp con persistencia de sesión
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('Escanea este código QR para conectar WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  clientReady = true;
  console.log('✅ Cliente de WhatsApp conectado y listo');
});

client.on('disconnected', (reason) => {
  clientReady = false;
  console.error('⚠️ Cliente desconectado:', reason);
});

// Normaliza números: solo dígitos, debe incluir código de país (e.g. 57 + número en CO)
function normalizeNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

// Ruta para enviar mensajes
app.post('/send-whatsapp', async (req, res) => {
  const { numbers, imageUrl, caption } = req.body;

  if (!Array.isArray(numbers) || numbers.length === 0 || !imageUrl) {
    return res.status(400).json({ error: 'Faltan parámetros: numbers[], imageUrl, (caption opcional)' });
  }

  if (!clientReady) {
    return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo. Intenta de nuevo en unos segundos.' });
  }

  try {
    // Descargar la imagen desde la URL
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    const ext = contentType.split('/')[1] || 'jpg';

    const media = new MessageMedia(
      contentType,
      Buffer.from(response.data).toString('base64'),
      `publicidad.${ext}`
    );

    const results = [];
    for (const raw of numbers) {
      const normalized = normalizeNumber(raw);
      if (!normalized) {
        results.push({ number: raw, status: 'failed', reason: 'Número inválido' });
        continue;
      }

      try {
        // Verifica si el número tiene WhatsApp y obtén el ID correcto
        const numberId = await client.getNumberId(normalized);
        if (!numberId) {
          results.push({ number: normalized, status: 'failed', reason: 'El número no tiene WhatsApp' });
          continue;
        }

        await client.sendMessage(numberId._serialized, media, { caption });
        console.log(`✅ Enviado a: ${normalized}`);
        results.push({ number: normalized, status: 'sent' });
      } catch (err) {
        console.error(`❌ Error al enviar a ${normalized}:`, err.message);
        results.push({ number: normalized, status: 'failed', reason: err.message });
      }
    }

    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed');

    res.json({
      status: `Mensajes enviados: ${sent}, fallidos: ${failed.length}`,
      detail: results
    });
  } catch (error) {
    console.error('❌ Error general al enviar mensajes:', error.message);
    res.status(500).json({ error: 'Error al preparar o enviar los mensajes', detail: error.message });
  }
});

// Iniciar servidor (corrige paréntesis/coma)
const PORT = 3001;
// Si realmente necesitas atar a una IP específica:
app.listen(PORT, '146.190.75.181', () => {
  console.log(`🚀 Servidor escuchando en http://146.190.75.181:${PORT}`);
});
// O simplemente: app.listen(PORT, () => { console.log(`http://localhost:${PORT}`) });

client.initialize();
