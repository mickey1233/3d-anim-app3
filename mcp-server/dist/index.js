import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from 'ws';
import { z } from "zod";
// --- WebSocket Server (Bridge to React App) ---
const WSS_PORT = 3001;
const wss = new WebSocketServer({ port: WSS_PORT });
let activeClient = null;
const pendingRequests = new Map();
console.error(`[MCP-Server] WebSocket server listening on port ${WSS_PORT}`);
wss.on('connection', (ws) => {
    // console.error('[MCP-Server] React App Connected');
    activeClient = ws;
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            // { id, result, error }
            if (data.id && pendingRequests.has(data.id)) {
                const { resolve, reject } = pendingRequests.get(data.id);
                if (data.error)
                    reject(new Error(data.error));
                else
                    resolve(data.result);
                pendingRequests.delete(data.id);
            }
        }
        catch (e) {
            console.error('[MCP-Server] Failed to parse message from client', e);
        }
    });
    ws.on('close', () => {
        // console.error('[MCP-Server] React App Disconnected');
        activeClient = null;
    });
});
// Helper to send command to React App
async function sendToApp(command, args = {}) {
    if (!activeClient) {
        throw new Error("3D App is not connected. Please open the web app.");
    }
    const id = Math.random().toString(36).substring(7);
    return new Promise((resolve, reject) => {
        // Timeout after 10s
        const timeout = setTimeout(() => {
            if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error("Timeout waiting for App response"));
            }
        }, 10000);
        pendingRequests.set(id, {
            resolve: (val) => { clearTimeout(timeout); resolve(val); },
            reject: (err) => { clearTimeout(timeout); reject(err); }
        });
        activeClient.send(JSON.stringify({ id, command, arguments: args }));
    });
}
// --- MCP Server Definition ---
const server = new Server({
    name: "3d-anim-studio-mcp",
    version: "1.0.0",
}, {
    capabilities: {
        tools: {},
    },
});
// Define Tools
const TOOLS_LIST = [
    {
        name: "get_scene_state",
        description: "Returns a list of all 3D parts in the scene with their UUIDs and Names.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "select_part",
        description: "Selects a part in the 3D scene by Name (fuzzy match) or UUID.",
        inputSchema: {
            type: "object",
            properties: {
                name_or_uuid: { type: "string", description: "The name or UUID of the part to select" }
            },
            required: ["name_or_uuid"]
        }
    },
    {
        name: "set_pose_target",
        description: "Sets the start and end markers for animation based on semantic part alignment.",
        inputSchema: {
            type: "object",
            properties: {
                source: { type: "string", description: "Name/UUID of the object to move" },
                target: { type: "string", description: "Name/UUID of the reference object" },
                source_face: {
                    type: "string",
                    description: "Which face of the source object to align (top, bottom, left, right, front, back, center)",
                    enum: ["top", "bottom", "left", "right", "front", "back", "center"]
                },
                target_face: {
                    type: "string",
                    description: "Which face of the target object to align to (top, bottom, left, right, front, back, center)",
                    enum: ["top", "bottom", "left", "right", "front", "back", "center"]
                }
            },
            required: ["source", "target", "source_face", "target_face"]
        }
    },
    {
        name: "set_marker_manual",
        description: "Manually sets the position of the Start or End marker.",
        inputSchema: {
            type: "object",
            properties: {
                type: { type: "string", enum: ["start", "end"] },
                x: { type: "number" },
                y: { type: "number" },
                z: { type: "number" }
            },
            required: ["type", "x", "y", "z"]
        }
    },
    {
        name: "preview_animation",
        description: "Plays the current single-step animation to preview it.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "add_current_step",
        description: "Adds the currently configured animation step to the sequence.",
        inputSchema: {
            type: "object",
            properties: {
                description: { type: "string", description: "Short description of what this step does" }
            },
            required: ["description"]
        }
    },
    {
        name: "reset_scene",
        description: "Resets all parts to their original positions.",
        inputSchema: { type: "object", properties: {} }
    },
    {
        name: "load_demo_model",
        description: "Loads the default Demo CAD model (Spark.glb) into the scene.",
        inputSchema: { type: "object", properties: {} }
    }
];
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS_LIST };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        // Map MCP tools to App commands
        switch (name) {
            case "get_scene_state":
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("get_scene_state"), null, 2) }] };
            case "select_part":
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("select_part", args)) }] };
            case "set_pose_target":
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("set_pose_target", args)) }] };
            case "set_marker_manual":
                // We haven't implemented this logic in RemoteClient yet, let's assume we will or map it now.
                // Note: RemoteClient needs to implement "set_marker_manual"
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("set_marker_manual", args)) }] };
            case "preview_animation":
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("preview_animation")) }] };
            case "add_current_step":
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("add_current_step", args)) }] };
            case "reset_scene":
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("reset_scene")) }] };
            case "load_demo_model":
                return { content: [{ type: "text", text: JSON.stringify(await sendToApp("load_demo_model")) }] };
            default:
                throw new Error(`Tool ${name} not found`);
        }
    }
    catch (error) {
        return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});
async function main() {
    const transport = new StdioServerTransport();
    transport.onclose = () => {
        console.error("MCP Transport closed, exiting...");
        process.exit(0);
    };
    await server.connect(transport);
    console.error("MCP Server running on StdIO");
}
main().catch((error) => {
    console.error("Server error:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map