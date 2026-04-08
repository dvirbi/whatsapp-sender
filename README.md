# WhatsApp Sender - Automated Group Messaging

Sends birthday cards automatically to WhatsApp group "תזכורות-טווח קצר" using whatsapp-web.js.

## 🚀 One-Command Setup

```bash
./setup-complete.sh
```

This script will:
1. Login to Railway (opens browser once)
2. Deploy the WhatsApp server
3. Configure environment variables
4. Update Vercel with Railway URL
5. Redeploy production

After running the script:
- Open the Railway URL at `/qr`
- Scan QR code with WhatsApp
- Done! Birthday cards now send automatically 🎉

## 📦 Manual Setup (if needed)

<details>
<summary>Click to expand manual steps</summary>

### 1. Deploy to Railway

```bash
railway login
railway init --name whatsapp-sender
railway up
railway volume add --mount /data
railway variables set API_SECRET=birgers-secret-2026
```

### 2. Get Railway URL

```bash
railway domain
# Copy the URL (e.g., https://whatsapp-sender.up.railway.app)
```

### 3. Update Vercel

```bash
cd ../BirgersEvents
vercel env add RAILWAY_URL production
# Paste the Railway URL

vercel env add WHATSAPP_API_SECRET production
# Enter: birgers-secret-2026

vercel --prod
```

### 4. Authenticate WhatsApp

1. Open: `https://YOUR-RAILWAY-URL/qr`
2. Scan QR with WhatsApp → Settings → Linked Devices
3. Done!

</details>

## 🔧 How It Works

1. User clicks "שלח עכשיו" on birthday card
2. Vercel forwards image to Railway server
3. Railway server sends via WhatsApp Web to group
4. Group receives birthday card automatically

## 📡 API Endpoints

- `GET /` - Health check
- `GET /qr` - Display QR code for WhatsApp authentication  
- `POST /send` - Send image to group (requires API_SECRET)

## 🔐 Environment Variables

- `API_SECRET` - Authentication secret (default: birgers-secret-2026)
- Group ID is auto-detected from invite link in code

## 📝 Architecture

```
[Vercel Frontend] 
    ↓ POST /api/send-birthday-card
[Vercel Serverless] 
    ↓ POST /send + image + caption
[Railway WhatsApp Server] 
    ↓ whatsapp-web.js
[WhatsApp Group: תזכורות-טווץ קצר]
```
