#!/bin/bash

# Start Script for 3D Anim App
# This starts the frontend (background) and backend client (foreground/interactive).

echo "=========================================="
echo "   Starting 3D Animation App"
echo "=========================================="

# 1. Kill any existing processes on port 5173 (Vite default)
echo "[1/3] Clearing port 5173..."
fuser -k 5173/tcp > /dev/null 2>&1 || true

# 2. Start Frontend (Vite) in Background
echo "[2/3] Starting Frontend (Vite)..."
npm run dev -- --port 5173 > /dev/null 2>&1 &
VITE_PID=$!
echo "      Frontend running (PID: $VITE_PID). Access at http://localhost:5173"

# 3. Setup cleanup trap to kill frontend when script exits
trap "kill $VITE_PID" EXIT

# 4. Activate Python Environment (needed for backend tools)
if [ -d "venv" ]; then
    echo "[3/3] Activating Python Environment..."
    source venv/bin/activate
else
    echo "Warning: 'venv' not found. Please run ./deploy.sh first."
fi

# 5. Start Backend Client (Interactive)
echo "------------------------------------------"
echo "Backend Client started. You can type commands here."
echo "Press Ctrl+C to stop everything."
echo "------------------------------------------"

node mcp-server/dist/simple-client.js
