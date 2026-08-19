const express = require('express');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const cors = require('cors');
const puppeteer = require('puppeteer');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const API_SECRET = process.env.API_SECRET || 'birgers-secret-2026';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '07db50019cb2904b93e3d895e4a3256c';
const AUTH_ROOT = './data/auth';
const DEFAULT_SESSION = '__default__';

// sessionKey -> { sock, isReady, qrDataUrl }
const sessions = new Map();

function sessionAuthDir(sessionKey) {
  return path.join(AUTH_ROOT, sessionKey);
}

// One-time, idempotent migration: the pre-multi-session server stored auth files
// directly in AUTH_ROOT. If that flat layout is still there and __default__
// doesn't exist yet, move the files in — so the existing WhatsApp connection
// (בירגר/ששון) survives the upgrade to multi-session without a re-scan.
function migrateFlatAuthIfNeeded() {
  const legacyCreds = path.join(AUTH_ROOT, 'creds.json');
  const defaultDir = sessionAuthDir(DEFAULT_SESSION);
  if (!fs.existsSync(legacyCreds) || fs.existsSync(defaultDir)) return;

  console.log('🔄 Migrating flat auth layout to ./data/auth/__default__/ ...');
  fs.mkdirSync(defaultDir, { recursive: true });
  for (const entry of fs.readdirSync(AUTH_ROOT)) {
    const full = path.join(AUTH_ROOT, entry);
    if (fs.statSync(full).isFile()) {
      fs.renameSync(full, path.join(defaultDir, entry));
    }
  }
  console.log('✅ Migration complete — default session preserved.');
}

function listKnownSessionKeys() {
  if (!fs.existsSync(AUTH_ROOT)) return [];
  return fs.readdirSync(AUTH_ROOT).filter(entry => {
    const full = path.join(AUTH_ROOT, entry);
    return fs.statSync(full).isDirectory();
  });
}

const startingSessions = new Set();

async function startSocket(sessionKey) {
  // Guard against a concurrent second start for the same key (e.g. the QR
  // page auto-refreshing before the first call finishes its awaits) — two
  // Baileys sockets writing to the same auth folder at once would corrupt it.
  if (startingSessions.has(sessionKey)) return sessions.get(sessionKey)?.sock;
  startingSessions.add(sessionKey);
  try {
    return await startSocketInner(sessionKey);
  } finally {
    startingSessions.delete(sessionKey);
  }
}

async function startSocketInner(sessionKey) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionAuthDir(sessionKey));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['BirgersEvents', 'Chrome', '120.0.0'],
  });

  const entry = sessions.get(sessionKey) || {};
  entry.sock = sock;
  entry.isReady = false;
  entry.qrDataUrl = entry.qrDataUrl || null;
  sessions.set(sessionKey, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const s = sessions.get(sessionKey);
    if (!s) return;

    if (qr) {
      console.log(`QR received for session "${sessionKey}"`);
      s.qrDataUrl = await qrcode.toDataURL(qr);
      s.isReady = false;
    }

    if (connection === 'open') {
      console.log(`✅ WhatsApp connected: ${sessionKey}`);
      s.isReady = true;
      s.qrDataUrl = null;
      s.loggedOut = false;
    }

    if (connection === 'close') {
      s.isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`Connection closed (${sessionKey}), code:`, code);
      if (code !== DisconnectReason.loggedOut) {
        s.loggedOut = false;
        console.log(`Reconnecting ${sessionKey}...`);
        setTimeout(() => startSocket(sessionKey), 3000);
      } else {
        s.loggedOut = true;
        console.log(`Logged out (${sessionKey}) — needs a fresh QR scan.`);
      }
    }
  });

  return sock;
}

function requireSecret(req, res) {
  const secret = req.query.secret || req.body?.secret;
  if (secret !== API_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function targetToJid(target) {
  if (target.includes('@')) return target;
  const cleaned = target.replace(/[\s\-\+\(\)]/g, '');
  if (/^\d{9,15}$/.test(cleaned)) {
    const normalized = cleaned.startsWith('0') ? '972' + cleaned.slice(1) : cleaned;
    return normalized + '@s.whatsapp.net';
  }
  return null;
}

function qrPageHtml(entry) {
  if (!entry) return '<h2>⏳ ממתין לקוד QR...</h2><meta http-equiv="refresh" content="3">';
  if (entry.isReady) return '<h2>✅ WhatsApp מחובר!</h2>';
  if (!entry.qrDataUrl) return '<h2>⏳ ממתין לקוד QR...</h2><meta http-equiv="refresh" content="3">';
  return `
    <html><body style="text-align:center;font-family:sans-serif;padding:40px">
      <h2>סרוק עם WhatsApp</h2>
      <img src="${entry.qrDataUrl}" style="max-width:300px"/>
      <p>פתח WhatsApp → הגדרות → מכשירים מקושרים → קשר מכשיר</p>
      <meta http-equiv="refresh" content="5">
    </body></html>
  `;
}

// Legacy QR page — the default/shared session (דביר). No secret required,
// matches pre-multi-session behavior exactly.
app.get('/qr', (req, res) => {
  res.send(qrPageHtml(sessions.get(DEFAULT_SESSION)));
});

// Per-tenant QR page. Requires the shared API secret — the tenant-admin JWT
// check happens upstream in HebEvents' Vercel proxy before this is ever called.
app.get('/qr/:sessionKey', (req, res) => {
  if (!requireSecret(req, res)) return;
  const { sessionKey } = req.params;
  const existing = sessions.get(sessionKey);
  if (!existing) {
    startSocket(sessionKey).catch(err => console.error(`Failed to start session ${sessionKey}:`, err.message));
  } else if (existing.loggedOut) {
    // A logged-out session's old creds are permanently invalid on WhatsApp's side —
    // reusing them just reconnects-and-closes forever without ever emitting a fresh
    // QR. Wipe the stale auth folder so Baileys registers as a new device.
    console.log(`Re-pairing ${sessionKey}: clearing stale auth and requesting a fresh QR`);
    sessions.delete(sessionKey);
    fs.rmSync(sessionAuthDir(sessionKey), { recursive: true, force: true });
    startSocket(sessionKey).catch(err => console.error(`Failed to start session ${sessionKey}:`, err.message));
  }
  res.send(qrPageHtml(sessions.get(sessionKey)));
});

app.get('/status', (req, res) => {
  const s = sessions.get(DEFAULT_SESSION);
  res.json({ ready: !!s?.isReady });
});

app.get('/status/:sessionKey', (req, res) => {
  if (!requireSecret(req, res)) return;
  const s = sessions.get(req.params.sessionKey);
  res.json({ ready: !!s?.isReady, loggedOut: !!s?.loggedOut });
});

app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/version', (req, res) => {
  res.json({ version: '4.0.0', features: ['multi-session', 'render-and-send', 'puppeteer'] });
});

// Send message to targets. `tenant` selects the session; omitted = default (backward compatible).
app.post('/send', async (req, res) => {
  const { imageBase64, imageUrl, caption, targets, secret, textOnly, tenant } = req.body;

  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const sessionKey = tenant || DEFAULT_SESSION;
  const s = sessions.get(sessionKey);
  if (!s?.isReady || !s.sock) {
    return res.status(503).json({ error: 'WhatsApp not connected', session: sessionKey });
  }
  if (!textOnly && !imageBase64 && !imageUrl) {
    return res.status(400).json({ error: 'imageBase64, imageUrl, or textOnly required' });
  }
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets array required' });
  }

  const sock = s.sock;
  const results = [];
  let totalSent = 0;
  let totalFailed = 0;

  for (const target of targets) {
    try {
      const jid = targetToJid(target);
      if (!jid) {
        results.push({ target, success: false, error: 'Invalid target format' });
        totalFailed++;
        continue;
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
      console.log(`✅ Sent to: ${target} (session: ${sessionKey})`);
    } catch (err) {
      console.error(`❌ Failed to send to ${target} (session: ${sessionKey}):`, err.message);
      results.push({ target, success: false, error: err.message });
      totalFailed++;
    }
  }

  res.json({ success: true, totalSent, totalFailed, results });
});

// Render birthday card (identical to client BirthdayCard.jsx) and send as JPEG
app.post('/render-and-send', async (req, res) => {
  const { secret, targets, name, title, message, fromName, hebStr, bg, layout, tenant } = req.body;

  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const sessionKey = tenant || DEFAULT_SESSION;
  const s = sessions.get(sessionKey);
  if (!s?.isReady || !s.sock) {
    return res.status(503).json({ error: 'WhatsApp not connected', session: sessionKey });
  }
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets array required' });
  }

  try {
    const cardHtml = buildCardHtml({ name, title, message, fromName, hebStr, bg, layout });

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 500, deviceScaleFactor: 2 });
    await page.setContent(cardHtml, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.birthday-card-preview');
    const cardEl = await page.$('.birthday-card-preview');
    const jpegBuffer = await cardEl.screenshot({ type: 'jpeg', quality: 95 });
    await browser.close();

    console.log(`✅ Card rendered: ${(jpegBuffer.length / 1024).toFixed(1)} KB`);

    const sock = s.sock;
    const results = [];
    let totalSent = 0;
    let totalFailed = 0;

    for (const target of targets) {
      try {
        const jid = targetToJid(target);
        if (!jid) {
          results.push({ target, success: false, error: 'Invalid target format' });
          totalFailed++;
          continue;
        }

        const caption = `🎉 מזל טוב ${name}!\n${hebStr || ''}`;
        await sock.sendMessage(jid, { image: jpegBuffer, caption });
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

// List groups for the default/shared session (legacy — superadmin/cron only, gated in HebEvents' proxy)
app.get('/groups', async (req, res) => {
  const s = sessions.get(DEFAULT_SESSION);
  if (!s?.isReady || !s.sock) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const groups = await s.sock.groupFetchAllParticipating();
    const list = Object.values(groups)
      .filter(g => g.id && g.subject)
      .map(g => ({ id: g.id, name: g.subject }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
    res.json({ groups: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List groups for a specific tenant's own session — safe to expose to that
// tenant's admin, since it's scoped to their own WhatsApp account only.
app.get('/groups/:sessionKey', async (req, res) => {
  if (!requireSecret(req, res)) return;
  const s = sessions.get(req.params.sessionKey);
  if (!s?.isReady || !s.sock) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const groups = await s.sock.groupFetchAllParticipating();
    const list = Object.values(groups)
      .filter(g => g.id && g.subject)
      .map(g => ({ id: g.id, name: g.subject }));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'he'));
    res.json({ groups: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect and remove a tenant's session entirely (used when a tenant is deleted).
app.post('/session/:sessionKey/logout', async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { sessionKey } = req.params;
  if (sessionKey === DEFAULT_SESSION) return res.status(400).json({ error: 'Cannot remove the default session' });
  const s = sessions.get(sessionKey);
  try {
    if (s?.sock) await s.sock.logout().catch(() => {});
    sessions.delete(sessionKey);
    fs.rmSync(sessionAuthDir(sessionKey), { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leave a specific WhatsApp group on a given session (used when a tenant on
// the shared/default session is deleted — otherwise the bot's number stays
// a member of that group forever, with nothing left tracking it).
app.post('/session/:sessionKey/leave-group', async (req, res) => {
  if (!requireSecret(req, res)) return;
  const { sessionKey } = req.params;
  const { groupId } = req.body || {};
  if (!groupId) return res.status(400).json({ error: 'groupId required' });
  const s = sessions.get(sessionKey);
  if (!s?.sock) return res.status(503).json({ error: 'Session not connected' });
  try {
    await s.sock.groupLeave(groupId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('WhatsApp Sender running (Baileys, multi-session)'));

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Unhandled rejection:', err.message || err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  migrateFlatAuthIfNeeded();
  const known = new Set([DEFAULT_SESSION, ...listKnownSessionKeys()]);
  for (const key of known) {
    startSocket(key).catch(err => console.error(`Failed to start session ${key}:`, err.message));
  }
});
