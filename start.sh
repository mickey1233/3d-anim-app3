#!/bin/bash

# Start Script for 3D Anim App
# This starts the frontend (background) and backend client (foreground/interactive).

echo "=========================================="
echo "   Starting 3D Animation App"
echo "=========================================="

# 1. Kill any existing processes (Frontend 5173, Backend 3001)
echo "[1/3] Clearing ports 5173 and 3001..."
fuser -k 5173/tcp > /dev/null 2>&1 || true
fuser -k 3001/tcp > /dev/null 2>&1 || true

# 2. Start Frontend (Vite) in Background
echo "[2/3] Starting Frontend (Vite)..."
npm run dev -- --port 5173 > /dev/null 2>&1 &
VITE_PID=$!
echo "      Frontend running (PID: $VITE_PID). Access at http://localhost:5173"

# 3. Setup cleanup trap
trap "kill $VITE_PID" EXIT

# 4. Activate Python Environment (Optional/If needed)
if [ -d "venv" ]; then
    source venv/bin/activate
fi

# 5. Start Backend Server (MCP)
echo "------------------------------------------"
echo "Starting Backend Server (mcp-server/index.ts)..."
echo "Press Ctrl+C to stop everything."
echo "------------------------------------------"

# Ensure we use npx tsx to run the TypeScript file directly
npx tsx mcp-server/index.ts
