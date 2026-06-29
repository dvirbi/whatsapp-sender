const express = require('express');
const qrcode = require('qrcode');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const API_SECRET = process.env.API_SECRET || 'birgers-secret-2026';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '07db50019cb2904b93e3d895e4a3256c';
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
  res.json({ version: '3.0.0', features: ['render-and-send', 'puppeteer'] });
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
        const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        await sock.sendMessage(jid, { image: buffer, caption: caption || '' });
      } else if (imageUrl) {
        await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' });
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

// Render birthday card (identical to client BirthdayCard.jsx) and send as JPEG
app.post('/render-and-send', async (req, res) => {
  const { secret, targets, name, title, message, fromName, hebStr, bg, layout } = req.body;

  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isReady || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets array required' });
  }

  try {
    // Build card HTML — identical to BirthdayCard.jsx with same CSS
    const cardHtml = buildCardHtml({ name, title, message, fromName, hebStr, bg, layout });

    // Render with Puppeteer → JPEG
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 500 });
    await page.setContent(cardHtml, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.birthday-card-preview');
    const cardEl = await page.$('.birthday-card-preview');
    const jpegBuffer = await cardEl.screenshot({ type: 'jpeg', quality: 90 });
    await browser.close();

    console.log(`✅ Card rendered: ${(jpegBuffer.length / 1024).toFixed(1)} KB`);

    // Upload to ImgBB
    const formBody = new URLSearchParams();
    formBody.append('key', IMGBB_API_KEY);
    formBody.append('image', jpegBuffer.toString('base64'));

    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });
    const imgbbData = await imgbbRes.json();
    if (!imgbbData.success) throw new Error('ImgBB upload failed');
    const imageUrl = imgbbData.data.url;
    console.log(`✅ Uploaded: ${imageUrl}`);

    // Send to WhatsApp targets (same as /send with imageUrl)
    const results = [];
    let totalSent = 0;
    let totalFailed = 0;

    for (const target of targets) {
      try {
        let jid;
        if (target.includes('@')) {
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

        const caption = `🎉 מזל טוב ${name}!\n${hebStr || ''}`;
        await sock.sendMessage(jid, { image: { url: imageUrl }, caption });
        results.push({ target, success: true });
        totalSent++;
        console.log(`✅ Sent to: ${target}`);
      } catch (err) {
        console.error(`❌ Failed to send to ${target}:`, err.message);
        results.push({ target, success: false, error: err.message });
        totalFailed++;
      }
    }

    res.json({ success: true, totalSent, totalFailed, results, imageUrl });
  } catch (err) {
    console.error('Render-and-send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Build HTML card — exact replica of BirthdayCard.jsx with same CSS classes
function buildCardHtml({ name, title, message, fromName, hebStr, bg, layout }) {
  const pennantColors = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#ef4444','#f97316','#eab308'];

  const layouts = {
    balloons: {
      topRow: `<div class="bc-pennant-row">${pennantColors.map(c => `<div class="bc-pennant" style="border-top-color:${c}"></div>`).join('')}</div>`,
      sides: `<div class="bc-sides"><div class="bc-balloon-group"><span style="font-size:2.2rem">🎈</span><span style="font-size:1.8rem">🎈</span></div><div class="bc-balloon-group"><span style="font-size:2.2rem">🎈</span><span style="font-size:1.8rem">🎈</span></div></div>`,
      starsTop: '✦ &nbsp; ✦ &nbsp; ✦',
      starsMid: '⭐ ⭐ ⭐',
    },
    flowers: {
      topRow: '<div class="bc-deco-row">🌸 🌺 🌷 🌻 🌸 🌺 🌷</div>',
      sides: `<div class="bc-sides"><div class="bc-balloon-group"><span style="font-size:2rem">🌹</span><span style="font-size:1.6rem">🌼</span></div><div class="bc-balloon-group"><span style="font-size:2rem">🌷</span><span style="font-size:1.6rem">🌻</span></div></div>`,
      starsTop: '❀ &nbsp; ❀ &nbsp; ❀',
      starsMid: '🌺 🌺 🌺',
    },
    stars: {
      topRow: '<div class="bc-deco-row">⭐ ✨ 💫 ⭐ ✨ 💫 ⭐</div>',
      sides: `<div class="bc-sides"><div class="bc-balloon-group"><span style="font-size:2rem">🌟</span><span style="font-size:1.6rem">✨</span></div><div class="bc-balloon-group"><span style="font-size:2rem">🌟</span><span style="font-size:1.6rem">✨</span></div></div>`,
      starsTop: '★ &nbsp; ★ &nbsp; ★',
      starsMid: '💫 💫 💫',
    },
    gifts: {
      topRow: '<div class="bc-deco-row">🎁 🎀 🎊 🎉 🎁 🎀 🎊</div>',
      sides: `<div class="bc-sides"><div class="bc-balloon-group"><span style="font-size:2rem">🎁</span><span style="font-size:1.6rem">🎀</span></div><div class="bc-balloon-group"><span style="font-size:2rem">🎉</span><span style="font-size:1.6rem">🎊</span></div></div>`,
      starsTop: '❖ &nbsp; ❖ &nbsp; ❖',
      starsMid: '🎀 🎀 🎀',
    },
    butterflies: {
      topRow: '<div class="bc-deco-row">🦋 🌸 🦋 🌸 🦋 🌸 🦋</div>',
      sides: `<div class="bc-sides"><div class="bc-balloon-group"><span style="font-size:2rem">🦋</span><span style="font-size:1.6rem">🌿</span></div><div class="bc-balloon-group"><span style="font-size:2rem">🦋</span><span style="font-size:1.6rem">🌿</span></div></div>`,
      starsTop: '❦ &nbsp; ❦ &nbsp; ❦',
      starsMid: '🦋 🦋 🦋',
    },
  };

  const l = layouts[layout] || layouts.balloons;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;700;800&display=swap" rel="stylesheet">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Heebo', sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: transparent; }
.birthday-card-preview {
  border-radius: 18px;
  padding: 24px 20px 20px;
  text-align: center;
  direction: rtl;
  position: relative;
  overflow: hidden;
  width: 500px;
  min-height: 350px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.1);
}
.bc-pennant-row { display: flex; justify-content: center; gap: 0; margin-bottom: 10px; margin-left: -20px; margin-right: -20px; margin-top: -24px; overflow: hidden; }
.bc-pennant { width: 0; height: 0; border-left: 18px solid transparent; border-right: 18px solid transparent; border-top: 28px solid #ef4444; flex-shrink: 0; }
.bc-deco-row { text-align: center; font-size: 1.4rem; letter-spacing: 2px; margin-bottom: 10px; margin-top: -16px; }
.bc-sides { display: flex; justify-content: space-between; position: absolute; top: 44px; left: 8px; right: 8px; pointer-events: none; }
.bc-balloon-group { display: flex; flex-direction: column; gap: 2px; line-height: 1; }
.bc-stars-top { font-size: 1rem; letter-spacing: 6px; color: #c68a00; margin-bottom: 6px; margin-top: 8px; }
.bc-date { font-size: 1.1rem; font-weight: 700; color: #3d2b00; margin-bottom: 8px; margin-top: 4px; }
.bc-mazal { font-size: 2.4rem; font-weight: 800; color: #2d1a00; line-height: 1.1; font-family: 'Heebo', sans-serif; }
.bc-name { font-size: 2rem; font-weight: 800; color: #2d1a00; margin: 4px 0 8px; font-family: 'Heebo', sans-serif; }
.bc-stars-mid { font-size: 1rem; letter-spacing: 6px; margin: 6px 0 8px; }
.bc-blessing-label { font-size: 0.85rem; font-weight: 700; color: #7a5500; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 6px; }
.bc-blessing { font-size: 0.95rem; color: #4a3000; line-height: 1.7; white-space: pre-line; }
.bc-from { font-size: 0.9rem; font-weight: 600; color: #4a3800; margin-top: 10px; }
</style>
</head>
<body>
<div class="birthday-card-preview" style="background: ${bg || '#f5e3b8'}">
  ${l.topRow}
  ${l.sides}
  <div class="bc-stars-top">${l.starsTop}</div>
  ${hebStr ? `<div class="bc-date">${hebStr}</div>` : ''}
  <div class="bc-mazal">${title}</div>
  <div class="bc-name">${name}</div>
  <div class="bc-stars-mid">${l.starsMid}</div>
  <div class="bc-blessing-label">מאחלים</div>
  <div class="bc-blessing">${message}</div>
  <div class="bc-from">${fromName}</div>
</div>
</body>
</html>`;
}

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
