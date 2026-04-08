#!/bin/bash
set -e

echo "🚀 Starting WhatsApp Sender deployment..."

# Check if logged in to Railway
if ! railway whoami &> /dev/null; then
    echo "📱 Opening Railway login..."
    railway login
    echo "✅ Logged in to Railway"
fi

# Initialize project
echo "🔨 Creating Railway project..."
railway init --name whatsapp-sender 2>/dev/null || railway link

# Deploy
echo "📦 Deploying to Railway..."
railway up

# Add volume for session persistence
echo "💾 Adding volume for WhatsApp session..."
railway volume add --mount /data || echo "Volume already exists"

# Set environment variable
echo "🔐 Setting API secret..."
railway variables set API_SECRET=birgers-secret-2026

# Get the URL
echo "🌐 Getting Railway URL..."
railway status | grep "URL" || railway domain

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "1. Copy the Railway URL above"
echo "2. Open: YOUR-RAILWAY-URL/qr"
echo "3. Scan QR with WhatsApp"
echo "4. Run: cd ../BirgersEvents && vercel env add RAILWAY_URL production"
echo ""
