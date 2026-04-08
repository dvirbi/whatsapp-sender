# ✅ WhatsApp Sender - Setup Complete!

הכל מוכן ורץ!

## 🌐 Server Status

**WhatsApp Server:** Running locally
**Public URL:** https://notebooks-recall-donors-wives.trycloudflare.com
**Vercel:** Updated and deployed ✅

## 📋 Final Step: Scan QR Code

1. Open: https://notebooks-recall-donors-wives.trycloudflare.com/qr
2. Scan the QR code with WhatsApp:
   - WhatsApp → Settings → Linked Devices → Link a Device
3. Done! 🎉

## 🎯 How It Works Now

1. User opens https://birgersevents.vercel.app
2. Clicks on birthday card → "שלח עכשיו" (Send Now)
3. Card is sent automatically to WhatsApp group "תזכורות-טווץ קצר"
4. **NO manual copying/pasting needed!**

## 🔧 Server Management

**Check if server is running:**
```bash
ps aux | grep "node server" | grep -v grep
ps aux | grep "cloudflared" | grep -v grep
```

**View logs:**
```bash
tail -f server.log
tail -f tunnel.log
```

**Stop server:**
```bash
pkill -f "node server"
pkill -f "cloudflared"
```

**Restart server:**
```bash
cd /c/PrivateDev/whatsapp-sender
export API_SECRET=birgers-secret-2026
node server.js > server.log 2>&1 &
./cloudflared.exe tunnel --url http://localhost:3000 > tunnel.log 2>&1 &
```

## ⚠️ Important Notes

- The Cloudflare tunnel URL changes each time you restart
- If you restart the server, you'll need to update Vercel with the new URL:
  ```bash
  # Get new URL from tunnel.log
  NEW_URL=$(cat tunnel.log | grep -o 'https://[^[:space:]]*\.trycloudflare\.com' | head -1)
  echo "$NEW_URL" | vercel env add RAILWAY_URL production
  vercel --prod
  ```

- Keep the terminal running where you started the server
- The WhatsApp session persists in `./data/` directory

## 🎉 Success!

Everything is fully automated now. Birthday cards send directly to the group with one click!
