# WhatsApp Sender - Automated Group Messaging

Sends birthday cards automatically to WhatsApp group using whatsapp-web.js.

## 🚀 Quick Deploy to Railway (1-Click)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/whatsapp-sender?referralCode=birgers)

**After deployment:**

1. Go to your Railway project → **Add Volume** → Mount path: `/data`
2. Add environment variable: `API_SECRET=birgers-secret-2026`
3. Open your Railway URL at `/qr` path (e.g., `https://your-app.up.railway.app/qr`)
4. Scan the QR code with WhatsApp → Settings → Linked Devices
5. Copy your Railway URL and add to Vercel:

```bash
cd ../BirgersEvents
vercel env add RAILWAY_URL production
# Paste: https://your-app.up.railway.app

vercel env add WHATSAPP_API_SECRET production
# Enter: birgers-secret-2026
```

Done! Birthday cards now send automatically to the group.

## 🔧 Manual Setup (if button doesn't work)

```bash
railway login
railway init
railway up
railway volume add --mount /data
railway variables set API_SECRET=birgers-secret-2026
railway open
```

## API Endpoints

- `GET /qr` - Display QR code for WhatsApp authentication
- `POST /send` - Send image to group (requires `secret` in body)

## Environment Variables

- `API_SECRET` - Authentication secret (default: birgers-secret-2026)
- `GROUP_ID` - WhatsApp group chat ID (auto-detected from invite link)
