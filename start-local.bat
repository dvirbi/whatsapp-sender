@echo off
echo Starting WhatsApp Sender locally...
echo.

REM Check if node_modules exists
if not exist node_modules (
    echo Installing dependencies...
    call npm install
)

REM Start the server
echo.
echo Starting server on http://localhost:3000
echo.
echo Next steps:
echo 1. Open http://localhost:3000/qr and scan QR
echo 2. Install ngrok: https://ngrok.com/download
echo 3. Run: ngrok http 3000
echo 4. Copy ngrok URL and set RAILWAY_URL in Vercel
echo.

set API_SECRET=birgers-secret-2026
node index.js
