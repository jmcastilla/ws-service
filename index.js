const express = require('express');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Inicializar cliente de WhatsApp con persistencia de sesión
const client = new Client({
  authStrategy: new LocalAuth(), // Esto guarda la sesión
  puppeteer: {
    headless: true, // Para que funcione sin interfaz gráfica
    args: ['--no-sandbox'] // Opcional: para evitar problemas en algunos entornos
  }
});

client.on('qr', (qr) => {
  // Se muestra el QR solo si no hay sesión guardada
  console.log('Escanea este código QR para conectar WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Cliente de WhatsApp conectado y listo');
});

// Ruta para enviar mensajes
app.post('/send-whatsapp', async (req, res) => {
  const { numbers, imageUrl, caption } = req.body;

  if (!numbers || !Array.isArray(numbers) || !imageUrl) {
    return res.status(400).json({ error: 'Faltan parámetros: numbers[], imageUrl, caption' });
  }

  try {
    // Descargar la imagen desde la URL
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });

    const media = new MessageMedia(
      'image/jpeg',
      Buffer.from(response.data).toString('base64'),
      'publicidad.jpg'
    );

    // Enviar a cada número
    for (const number of numbers) {
      const chatId = `${number}@c.us`; // Ej: 573001234567@c.us
      await client.sendMessage(chatId, media, { caption });
      console.log(`✅ Enviado a: ${number}`);
    }

    res.json({ status: 'Mensajes enviados correctamente' });
  } catch (error) {
    console.error('❌ Error al enviar mensajes:', error.message);
    res.status(500).json({ error: 'Error al enviar mensajes' });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});

client.initialize();
