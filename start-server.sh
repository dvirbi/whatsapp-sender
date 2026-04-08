#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "🚀 Starting WhatsApp Sender Server..."
echo ""

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Start server in background
echo "🌐 Starting WhatsApp server on port 3000..."
export API_SECRET=birgers-secret-2026
node server.js > server.log 2>&1 &
SERVER_PID=$!

sleep 5

# Check if server is running
if ! ps -p $SERVER_PID > /dev/null; then
    echo "❌ Server failed to start. Check server.log"
    cat server.log
    exit 1
fi

echo "✅ Server started on http://localhost:3000"

# Start Cloudflare Tunnel (free, no signup)
echo "🔗 Creating public tunnel with Cloudflare..."
./cloudflared.exe tunnel --url http://localhost:3000 > tunnel.log 2>&1 &
TUNNEL_PID=$!

sleep 8

# Get tunnel URL
echo "⏳ Getting public URL..."
TUNNEL_URL=$(grep -oP 'https://[^[:space:]]+\.trycloudflare\.com' tunnel.log | head -1)

if [ -z "$TUNNEL_URL" ]; then
    echo "❌ Could not get tunnel URL. Checking logs..."
    echo "=== Server log ==="
    tail -20 server.log
    echo "=== Tunnel log ==="
    cat tunnel.log
    kill $SERVER_PID $TUNNEL_PID 2>/dev/null
    exit 1
fi

echo ""
echo "✅ Server running!"
echo "📍 Public URL: $TUNNEL_URL"
echo ""
echo "📋 Next steps:"
echo "1. Open: $TUNNEL_URL/qr"
echo "2. Scan QR with WhatsApp"
echo "3. Update Vercel:"
echo ""
echo "   cd ../BirgersEvents"
echo "   vercel env add RAILWAY_URL production"
echo "   (paste: $TUNNEL_URL)"
echo "   vercel --prod"
echo ""
echo "Server logs: server.log | tunnel.log"
echo "Press Ctrl+C to stop"
echo ""

# Save URL
echo "$TUNNEL_URL" > tunnel_url.txt

# Wait for Ctrl+C
trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo ''; echo 'Server stopped'; exit" INT

# Keep running
while true; do
    sleep 10
    if ! ps -p $SERVER_PID > /dev/null; then
        echo "Server crashed! Check server.log"
        kill $TUNNEL_PID 2>/dev/null
        exit 1
    fi
done
