import { useAppStore } from '../store/useAppStore';

type CommandHandler = (command: string, args: any) => Promise<any>;

class MCPBridge {
    private ws: WebSocket | null = null;
    private handlers: Map<string, CommandHandler> = new Map();
    private reconnectInterval: any = null;
    private isConnected: boolean = false;

    constructor() {
        // Auto-connect on load? Maybe better to call connect explicitely.
    }

    public connect(url: string = 'ws://localhost:3001') {
        if (this.ws) {
            this.ws.close();
        }

        console.log(`[MCPBridge] Connecting to ${url}...`);
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            console.log('[MCPBridge] Connected');
            this.isConnected = true;
            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
        };

        this.ws.onclose = () => {
            console.log('[MCPBridge] Disconnected');
            this.isConnected = false;
            // Try reconnecting every 3s
            if (!this.reconnectInterval) {
                this.reconnectInterval = setInterval(() => this.connect(url), 3000);
            }
        };

        this.ws.onmessage = async (event) => {
            try {
                const updatedData = JSON.parse(event.data);
                // Expecting { id: string, command: string, arguments: any }
                const { id, command, arguments: args } = updatedData;
                
                if (this.handlers.has(command)) {
                    try {
                        const result = await this.handlers.get(command)!(command, args);
                        this.sendResponse(id, result);
                    } catch (error: any) {
                        this.sendError(id, error.message);
                    }
                } else {
                    console.warn(`[MCPBridge] No handler for command: ${command}`);
                    this.sendError(id, `Unknown command: ${command}`);
                }
            } catch (e) {
                console.error('[MCPBridge] Failed to parse message', e);
            }
        };
    }

    public registerHandler(command: string, handler: CommandHandler) {
        this.handlers.set(command, handler);
    }

    private sendResponse(id: string, result: any) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ id, result }));
        }
    }

    private sendError(id: string, error: string) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ id, error }));
        }
    }

    public sendChatCommand(text: string) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ command: 'chat_input', text }));
        } else {
            console.warn('[MCPBridge] Cannot send chat, socket closed.');
        }
    }
}

export const mcpBridge = new MCPBridge();
