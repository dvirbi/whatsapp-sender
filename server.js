const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const GROUP_NAME = 'תזכורות - טווח קצר';
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

  // Debug: Print all group names
  const groups = chats.filter(c => c.isGroup);
  console.log(`Found ${groups.length} groups:`);
  groups.forEach(g => console.log(`  - "${g.name}"`));

  const group = chats.find(c => c.isGroup && c.name === GROUP_NAME);
  if (group) {
    groupId = group.id._serialized;
    console.log(`✅ Found target group: ${GROUP_NAME} → ${groupId}`);
  } else {
    console.warn(`❌ Group "${GROUP_NAME}" not found!`);
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

// Send image to multiple targets (groups or contacts)
app.post('/send', async (req, res) => {
  const { imageBase64, imageUrl, caption, targets, secret } = req.body;

  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isReady) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  if (!imageBase64 && !imageUrl) {
    return res.status(400).json({ error: 'imageBase64 or imageUrl required' });
  }
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets array required' });
  }

  try {
    // Get all chats once
    const chats = await client.getChats();

    // Create media from base64 or URL
    let media;
    if (imageUrl) {
      media = await MessageMedia.fromUrl(imageUrl);
    } else {
      // Upload to ImgBB first to avoid base64 corruption issues
      const IMGBB_API_KEY = '07db50019cb2904b93e3d895e4a3256c';
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

      console.log('📤 Uploading to ImgBB... (base64 length:', base64Data.length, ')');

      const formData = new URLSearchParams();
      formData.append('image', base64Data);

      const uploadRes = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
        method: 'POST',
        body: formData,
      });

      const uploadData = await uploadRes.json();
      if (!uploadRes.ok || !uploadData.success) {
        const errorMsg = uploadData.error?.message || uploadData.error || 'Upload failed';
        throw new Error(`ImgBB upload failed: ${errorMsg}`);
      }

      const uploadedUrl = uploadData.data.url;
      console.log('✅ Uploaded to ImgBB:', uploadedUrl);

      // Use the uploaded URL instead of base64
      media = await MessageMedia.fromUrl(uploadedUrl);
    }

    const results = [];
    let totalSent = 0;
    let totalFailed = 0;

    // Send to each target
    for (const targetName of targets) {
      try {
        // Find chat by name (group or contact)
        const chat = chats.find(c => c.name === targetName);

        if (!chat) {
          results.push({
            target: targetName,
            success: false,
            error: 'לא נמצא ברשימת אנשי הקשר/קבוצות',
          });
          totalFailed++;
          continue;
        }

        // Send message
        await client.sendMessage(chat.id._serialized, media, { caption: caption || '' });
        results.push({
          target: targetName,
          success: true,
        });
        totalSent++;
        console.log(`✅ Sent to: ${targetName}`);
      } catch (err) {
        console.error(`❌ Failed to send to ${targetName}:`, err.message);
        results.push({
          target: targetName,
          success: false,
          error: err.message,
        });
        totalFailed++;
      }
    }

    res.json({
      success: true,
      totalSent,
      totalFailed,
      results,
    });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('WhatsApp Sender running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

client.initialize();
