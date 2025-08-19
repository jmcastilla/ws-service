const express = require('express');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

const app = express();
app.use(express.json());

let clientReady = false;

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

function normalizeNumber(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

app.post('/send-whatsapp', async (req, res) => {
  const { numbers, imageUrl, caption } = req.body;

  if (!Array.isArray(numbers) || numbers.length === 0 || !imageUrl) {
    return res.status(400).json({ error: 'Faltan parámetros: numbers[], imageUrl, (caption opcional)' });
  }
  if (!clientReady) {
    return res.status(503).json({ error: 'El cliente de WhatsApp aún no está listo.' });
  }

  try {
    // 👉 Alternativa más robusta: que wwebjs detecte el mime por sí solo
    //    (evita problemas de content-type)
    const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });

    const results = [];
    for (const raw of numbers) {
      const normalized = normalizeNumber(raw);
      if (!normalized) {
        results.push({ number: raw, status: 'failed', reason: 'Número inválido' });
        continue;
      }

      try {
        const numberId = await client.getNumberId(normalized);
        if (!numberId) {
          results.push({ number: normalized, status: 'failed', reason: 'El número no tiene WhatsApp' });
          continue;
        }

        const chatId = numberId._serialized;

        // ✅ 1) Precargar el chat en el store antes de enviar (mitiga el bug)
        try {
          await client.getChatById(chatId);
        } catch (_) {
          // si falla, no detenemos el flujo; a veces el chat no existe aún
        }

        try {
          await client.sendMessage(chatId, media, { caption });
          console.log(`✅ Enviado a: ${normalized}`);
          results.push({ number: normalized, status: 'sent' });
        } catch (err) {
          // ✅ 2) Si es el bug de serialize/getMessageModel, lo marcamos como enviado con warning
          const msg = String(err?.message || err);
          if (msg.includes('getMessageModel') || msg.includes('serialize')) {
            console.warn(`⚠️ Enviado a ${normalized}, pero con warning de serialize (bug wwebjs)`);
            results.push({ number: normalized, status: 'sent_with_warning', warning: 'Bug de serialización en wwebjs' });
          } else {
            console.error(`❌ Error al enviar a ${normalized}:`, msg);
            results.push({ number: normalized, status: 'failed', reason: msg });
          }
        }

        // Pequeño delay opcional para dar tiempo al store a asentarse
        await new Promise(r => setTimeout(r, 150));
      } catch (err) {
        const msg = String(err?.message || err);
        console.error(`❌ Error previo a enviar a ${normalized}:`, msg);
        results.push({ number: normalized, status: 'failed', reason: msg });
      }
    }

    const sent = results.filter(r => r.status === 'sent' || r.status === 'sent_with_warning').length;
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

const PORT = 3001;
app.listen(PORT, '146.190.75.181', () => {
  console.log(`🚀 Servidor escuchando en http://146.190.75.181:${PORT}`);
});

client.initialize();
