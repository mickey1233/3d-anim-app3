# Base image with Node.js 20
FROM node:20-bookworm

# 1. Install System Dependencies (Python + OpenCV libs)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# 2. Setup Python Environment
COPY requirements.txt .
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
RUN pip install --no-cache-dir --default-timeout=1000 -r requirements.txt

# 3. Install Node Dependencies
# Copy package files first for caching
COPY package.json package-lock.json ./
COPY mcp-server/package.json mcp-server/package-lock.json ./mcp-server/

# Install root deps
RUN npm install

# Install backend deps
WORKDIR /app/mcp-server
RUN npm install
WORKDIR /app

# 4. Copy Source Code
COPY . .

# 5. Build Backend (TypeScript)
WORKDIR /app/mcp-server
RUN npx tsc
WORKDIR /app

# 6. Expose Ports
# 5173: Frontend (Vite)
# 3001: Backend (MCP WebSocket)
EXPOSE 5173 3001

# 7. Create Entrypoint Script
RUN echo '#!/bin/bash\n\
# Activate venv explicitly (though ENV PATH handles it)\n\
source /opt/venv/bin/activate\n\
\n\
echo "Starting 3D Anim App in Docker..."\n\
\n\
# Start Frontend in background\n\
npm run dev -- --host 0.0.0.0 --port 5173 > /var/log/frontend.log 2>&1 &\n\
FRONTEND_PID=$!\n\
echo "Frontend started (PID $FRONTEND_PID). Logs in /var/log/frontend.log"\n\
\n\
# Start Backend Client (Interactive if TTY, otherwise just run)\n\
# Using exec to pass signals\n\
exec node mcp-server/dist/simple-client.js\n\
' > /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

# Start
ENTRYPOINT ["/app/docker-entrypoint.sh"]
