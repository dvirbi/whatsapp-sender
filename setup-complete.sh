#!/bin/bash
set -e

echo "🚀 Complete WhatsApp Sender Setup"
echo "=================================="
echo ""

# Step 1: Railway login
if ! railway whoami &> /dev/null; then
    echo "Step 1: Railway Login"
    echo "  → A browser window will open"
    echo "  → Click 'Authorize'"
    read -p "Press Enter to continue..."
    railway login
fi

# Step 2: Deploy to Railway
echo ""
echo "Step 2: Deploying to Railway..."
cd "$(dirname "$0")"
railway init --name whatsapp-sender 2>/dev/null || railway link
railway up

# Step 3: Configure Railway
echo ""
echo "Step 3: Configuring Railway..."
railway volume add --mount /data 2>/dev/null || echo "  ✓ Volume already exists"
railway variables set API_SECRET=birgers-secret-2026

# Step 4: Get Railway URL
echo ""
echo "Step 4: Getting Railway URL..."
RAILWAY_URL=$(railway status --json 2>/dev/null | grep -o '"url":"[^"]*"' | cut -d'"' -f4 || railway domain 2>&1 | grep "https" | head -1 | awk '{print $1}')

if [ -z "$RAILWAY_URL" ]; then
    echo "⚠️  Could not auto-detect Railway URL"
    echo "Please run: railway domain"
    echo "And enter the URL below:"
    read -p "Railway URL: " RAILWAY_URL
fi

echo "  ✓ Railway URL: $RAILWAY_URL"

# Step 5: Update Vercel
echo ""
echo "Step 5: Updating Vercel..."
cd ../BirgersEvents
echo "$RAILWAY_URL" | vercel env add RAILWAY_URL production
echo "birgers-secret-2026" | vercel env add WHATSAPP_API_SECRET production

# Trigger redeploy
echo ""
echo "Step 6: Redeploying Vercel..."
vercel --prod

echo ""
echo "✅ Setup Complete!"
echo ""
echo "📋 Final Steps:"
echo "1. Open: $RAILWAY_URL/qr"
echo "2. Scan QR code with WhatsApp → Settings → Linked Devices"
echo "3. Test by sending a birthday card from: https://birgersevents.vercel.app"
echo ""
echo "Done! Birthday cards now send automatically to the group 🎉"
