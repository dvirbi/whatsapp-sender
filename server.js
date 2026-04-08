const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const GROUP_NAME = 'תזכורות-טווח קצר';
const API_SECRET = process.env.API_SECRET || 'birgers-secret-2026';

let qrDataUrl = null;
let isReady = false;
let groupId = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './data/.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-extensions',
    ],
  },
});

client.on('qr', async (qr) => {
  console.log('QR received — scan it at /qr');
  qrDataUrl = await qrcode.toDataURL(qr);
  isReady = false;
});

client.on('ready', async () => {
  console.log('WhatsApp client ready!');
  isReady = true;
  qrDataUrl = null;

  // Find the group ID once
  const chats = await client.getChats();
  const group = chats.find(c => c.isGroup && c.name === GROUP_NAME);
  if (group) {
    groupId = group.id._serialized;
    console.log(`Found group: ${GROUP_NAME} → ${groupId}`);
  } else {
    console.warn(`Group "${GROUP_NAME}" not found!`);
  }
});

client.on('disconnected', () => {
  console.log('WhatsApp disconnected');
  isReady = false;
});

// QR code page — scan this once to connect
app.get('/qr', (req, res) => {
  if (isReady) return res.send('<h2>✅ WhatsApp מחובר!</h2>');
  if (!qrDataUrl) return res.send('<h2>⏳ ממתין לקוד QR...</h2><meta http-equiv="refresh" content="3">');
  res.send(`
    <html><body style="text-align:center;font-family:sans-serif;padding:40px">
      <h2>סרוק עם WhatsApp</h2>
      <img src="${qrDataUrl}" style="max-width:300px"/>
      <p>פתח WhatsApp → הגדרות → מכשירים מקושרים → קשר מכשיר</p>
      <meta http-equiv="refresh" content="5">
    </body></html>
  `);
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({ ready: isReady, groupFound: !!groupId });
});

// Send image to group
app.post('/send', async (req, res) => {
  const { imageBase64, caption, secret } = req.body;

  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  if (!groupId) {
    return res.status(404).json({ error: `Group "${GROUP_NAME}" not found` });
  }
  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 required' });
  }

  try {
    // Strip data URL prefix if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const media = new MessageMedia('image/jpeg', base64Data, 'mazal-tov.jpg');
    await client.sendMessage(groupId, media, { caption: caption || '' });
    res.json({ success: true });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('WhatsApp Sender running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

client.initialize();
