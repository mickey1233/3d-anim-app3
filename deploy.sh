#!/bin/bash
set -e

# Deployment Script for 3D Animation App & MCP Server
# This script installs Node.js, Python, and project dependencies.

echo "=========================================="
echo "   3D Anim App - Deployment Setup"
echo "=========================================="

# 1. Update and Install System Dependencies
echo "[1/5] Installing system dependencies..."
sudo apt-get update
# Install curl, git, build-essential (for compiling some node/python modules), psmisc (for fuser)
sudo apt-get install -y curl git build-essential psmisc python3 python3-pip python3-venv

# 2. Install/Upgrade Node.js (Version 20.x LTS)
NEED_NODE=true
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    echo "[2/5] Found Node.js version $NODE_VERSION"
    if [ "$NODE_VERSION" -ge 18 ]; then
        NEED_NODE=false
        echo "      Node.js version is sufficient (>= 18)."
    else
        echo "      Node.js is too old (< 18). Upgrading to 20.x..."
    fi
fi

if [ "$NEED_NODE" = true ]; then
    echo "      Installing Node.js 20.x..."
    # Clean old nodejs massive cleanup
    sudo apt-get remove -y nodejs npm libnode-dev libnode72 || true
    sudo apt-get autoremove -y

    # Robust download of setup script
    echo "      Fetching NodeSource setup script..."
    if curl -fsSL https://deb.nodesource.com/setup_20.x -o nodesource_setup.sh; then
        echo "      Download successful (curl)."
    elif wget -qO nodesource_setup.sh https://deb.nodesource.com/setup_20.x; then
        echo "      Download successful (wget)."
    else
        echo "Error: Failed to download NodeSource setup script. Check internet connection."
        exit 1
    fi

    # Run setup
    sudo -E bash nodesource_setup.sh
    sudo apt-get install -y nodejs
    rm nodesource_setup.sh
    
    # Verify installation
    NEW_NODE_VER=$(node -v 2>/dev/null || echo "none")
    echo "      Installed Node version: $NEW_NODE_VER"
    
    if ! command -v npm &> /dev/null; then
        echo "Error: npm is missing after install. Something went wrong."
        exit 1
    fi
fi

# 3. Install Root Project Dependencies (Frontend)
echo "[3/5] Installing frontend dependencies..."
if [ -f "package.json" ]; then
    npm install
else
    echo "Error: package.json not found in current directory!"
    exit 1
fi
# 4. Install & Build MCP Server (Backend)
echo "[4/5] Setting up MCP Server..."
if [ -d "mcp-server" ]; then
    cd mcp-server
    echo "  - Installing MCP dependencies..."
    npm install
    echo "  - Building MCP Server (TypeScript)..."
    npx tsc
    cd ..
else
    echo "Warning: 'mcp-server' directory not found. Skipping backend setup."
fi

# 5. Setup Python Environment (CV Agent)
echo "[5/5] Setting up Python environment..."
# Create a virtual environment named 'venv'
if [ ! -d "venv" ]; then
    echo "  - Creating virtual environment 'venv'..."
    python3 -m venv venv
fi

# Activate and install requirements
source venv/bin/activate
echo "  - Installing Python libraries (numpy, opencv-python, scipy)..."
pip install --upgrade pip
pip install numpy opencv-python scipy

echo "=========================================="
echo "   Setup Complete!"
echo "=========================================="
echo ""
echo "To run the application:"
echo "1. Activate Python Env:  source venv/bin/activate"
echo "2. Start Frontend:       npm run dev"
echo "3. Start Backend (MCP):  node mcp-server/dist/simple-client.js (or appropriate entry point)"
echo ""
