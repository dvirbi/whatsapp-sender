const express = require('express');
const qrcode = require('qrcode');
const cors = require('cors');
const sharp = require('sharp');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const API_SECRET = process.env.API_SECRET || 'birgers-secret-2026';
const AUTH_DIR = './data/auth';

let qrDataUrl = null;
let isReady = false;
let sock = null;

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['BirgersEvents', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('QR received — scan at /qr');
      qrDataUrl = await qrcode.toDataURL(qr);
      isReady = false;
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      isReady = true;
      qrDataUrl = null;
    }

    if (connection === 'close') {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed, code:', code);
      if (code !== DisconnectReason.loggedOut) {
        console.log('Reconnecting...');
        setTimeout(startSocket, 3000);
      } else {
        console.log('Logged out — delete auth and restart to re-scan QR');
      }
    }
  });
}

// QR code page
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
  res.json({ ready: isReady });
});

// Health check for Railway
app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// Version check (to verify deployments)
app.get('/version', (req, res) => {
  res.json({ version: '2.1.0', features: ['sharp-jpeg-convert'] });
});

// Send message to targets
app.post('/send', async (req, res) => {
  const { imageBase64, imageUrl, caption, targets, secret, textOnly } = req.body;

  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isReady || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  if (!textOnly && !imageBase64 && !imageUrl) {
    return res.status(400).json({ error: 'imageBase64, imageUrl, or textOnly required' });
  }
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets array required' });
  }

  const results = [];
  let totalSent = 0;
  let totalFailed = 0;

  for (const target of targets) {
    try {
      // Convert target to WhatsApp JID
      let jid;
      if (target.includes('@')) {
        // Already a JID (e.g. group ID like 120363...@g.us)
        jid = target;
      } else {
        const cleaned = target.replace(/[\s\-\+\(\)]/g, '');
        if (/^\d{9,15}$/.test(cleaned)) {
          const normalized = cleaned.startsWith('0') ? '972' + cleaned.slice(1) : cleaned;
          jid = normalized + '@s.whatsapp.net';
        } else {
          results.push({ target, success: false, error: 'Invalid target format' });
          totalFailed++;
          continue;
        }
      }

      if (textOnly || (!imageBase64 && !imageUrl)) {
        await sock.sendMessage(jid, { text: caption || '' });
      } else if (imageBase64) {
        const rawBuffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const jpegBuffer = await sharp(rawBuffer).jpeg({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { image: jpegBuffer, caption: caption || '', mimetype: 'image/jpeg' });
      } else if (imageUrl) {
        const response = await fetch(imageUrl);
        const rawBuffer = Buffer.from(await response.arrayBuffer());
        const jpegBuffer = await sharp(rawBuffer).jpeg({ quality: 90 }).toBuffer();
        await sock.sendMessage(jid, { image: jpegBuffer, caption: caption || '', mimetype: 'image/jpeg' });
      }

      results.push({ target, success: true });
      totalSent++;
      console.log(`✅ Sent to: ${target}`);
    } catch (err) {
      console.error(`❌ Failed to send to ${target}:`, err.message);
      results.push({ target, success: false, error: err.message });
      totalFailed++;
    }
  }

  res.json({ success: true, totalSent, totalFailed, results });
});

// List groups
app.get('/groups', async (req, res) => {
  if (!isReady || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups)
      .filter(g => g.id && g.subject)
      .map(g => ({ id: g.id, name: g.subject }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
    res.json({ groups: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('WhatsApp Sender running (Baileys)'));

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection:', err.message || err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  startSocket();
});
