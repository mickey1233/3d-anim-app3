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
    // Heartbeat
    const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
        }
    }, 30000);
    ws.on('pong', () => {
        // console.log('[MCP] Pong received');
    });
    ws.on('message', async (message) => {
        try {
            const msgStr = message.toString();
            if (msgStr === 'pong')
                return;
            const data = JSON.parse(msgStr);
            // Case 1: Response to a pending request { id, result, error }
            if (data.id && pendingRequests.has(data.id)) {
                const { resolve, reject } = pendingRequests.get(data.id);
                if (data.error)
                    reject(new Error(data.error));
                else
                    resolve(data.result);
                pendingRequests.delete(data.id);
                return;
            }
            // Case 2: Client-initiated command (e.g., Chat)
            if (data.command === 'chat_input') {
                console.log(`[MCP-Server] Received Chat: "${data.text}"`);
                const reply = await handleChatInput(data.text);
                // Send reply back to client (chat feedback)
                // We'll use a new command 'chat_response' to send text back to UI
                sendToApp('chat_response', { text: reply }).catch(console.error);
            }
        }
        catch (e) {
            console.error('[MCP-Server] Failed to parse message from client', e);
        }
    });
    ws.on('close', () => {
        // console.error('[MCP-Server] React App Disconnected');
        clearInterval(pingInterval);
        activeClient = null;
    });
});
// --- NLP / Chat Logic ---
// --- NLP / Chat Logic ---
import { GoogleGenerativeAI } from "@google/generative-ai";
import levenshtein from "fast-levenshtein";
// Initialize Gemini if key exists
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
async function handleChatInput(input) {
    const lower = input.toLowerCase();
    // 1. Fetch Current Scene State for Context (Names/UUIDs)
    let sceneParts = [];
    try {
        const state = await sendToApp('get_scene_state');
        sceneParts = (state && state.parts && Array.isArray(state.parts)) ? state.parts : (Array.isArray(state) ? state : []);
    }
    catch (e) {
        console.warn("[MCP] Failed to fetch scene state for NLP context", e);
    }
    const partNames = sceneParts.map((p) => p.name);
    // --- STRATEGY A: LLM (If Available) ---
    if (genAI) {
        try {
            console.log("[MCP] Using Gemini LLM for chat...");
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const prompt = `
            You are an AI controlling a 3D animation studio.
            Current Parts in Scene: ${JSON.stringify(partNames)}
            
            User Input: "${input}"
            
            Available Tools:
            - set_pose_target(source, target, source_face, target_face)
              faces: top, bottom, left, right, front, back, center
            - reset_scene()
            - load_demo_model()
            - preview_animation()
            - add_current_step(description)

            Instructions:
            1. Match user intent to a tool.
            2. If "move", map object names to optimal matches from the list. 
               Default faces if unspecified: source=bottom, target=top.
            3. Return ONLY a pure JSON object (no markdown) with "tool" and "args".
            
            Example: {"tool": "set_pose_target", "args": {"source": "Part1", "target": "Part2", "source_face": "bottom", "target_face": "top"}}
            `;
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            console.log("[MCP] LLM Response:", text);
            const cmd = JSON.parse(text);
            if (cmd.tool) {
                await sendToApp(cmd.tool, cmd.args);
                return `🤖 ${cmd.tool} executed.`;
            }
        }
        catch (e) {
            console.error("[MCP] LLM Failed, falling back to heuristic:", e);
        }
    }
    // --- STRATEGY B: Robust Heuristic (Fallback) ---
    // Helper: Find best fuzzy match for a word in partNames
    const findPart = (query) => {
        if (!query)
            return null;
        let bestMatch = null;
        let minDist = Infinity;
        for (const name of partNames) {
            const dist = levenshtein.get(query.toLowerCase(), name.toLowerCase());
            // Threshold: Allow up to 3 edits, or 40% of length
            if (dist < minDist && dist <= Math.max(3, name.length * 0.4)) {
                minDist = dist;
                bestMatch = name;
            }
        }
        return bestMatch;
    };
    try {
        if (lower.includes('load') && (lower.includes('demo') || lower.includes('cad'))) {
            await sendToApp('load_demo_model');
            return "Loading Demo CAD Model...";
        }
        else if (lower.includes('reset')) {
            await sendToApp('reset_scene');
            return "Resetting scene...";
        }
        else if (lower.startsWith('select ')) {
            const rawName = input.substring(7).trim();
            const matchedName = findPart(rawName) || rawName;
            await sendToApp('select_part', { name_or_uuid: matchedName });
            return `Selecting '${matchedName}'...`;
        }
        else if (lower.includes('move')) {
            // Flexible Parsing: Split by "to"
            // "move Part2 bottom to Part1 top"
            const parts = input.split(/\s+to\s+/i);
            if (parts.length === 2 && parts[0] && parts[1]) {
                const leftSide = parts[0].replace(/^move\s+/i, '').trim(); // "Part2 bottom"
                const rightSide = parts[1].trim(); // "Part1 top"
                // Helper to extract Name + Face
                const extractNameFace = (str) => {
                    const tokens = str.split(/\s+/);
                    if (tokens.length === 0)
                        return { name: str, face: 'center' };
                    const faces = ["top", "bottom", "left", "right", "front", "back", "center"];
                    // Check last token first (e.g. "Part1 top")
                    let face = "center"; // default? Or specific defaults.
                    let nameTokens = tokens;
                    const lastToken = tokens[tokens.length - 1]?.toLowerCase();
                    if (lastToken && faces.includes(lastToken)) {
                        face = lastToken;
                        nameTokens = tokens.slice(0, -1);
                    }
                    // If first token is face? "top of Part1" (handled by simple heuristics mostly for suffix faces)
                    const rawName = nameTokens.join(' ');
                    const matchedName = findPart(rawName) || rawName;
                    return { name: matchedName, face };
                };
                const src = extractNameFace(leftSide);
                const tgt = extractNameFace(rightSide);
                console.log(`[MCP-NLP] Parsed: Src='${src.name}'(${src.face}), Tgt='${tgt.name}'(${tgt.face})`);
                // Defaults if face not explicit
                if (leftSide.indexOf(src.face) === -1)
                    src.face = 'bottom';
                if (rightSide.indexOf(tgt.face) === -1)
                    tgt.face = 'top';
                console.log(`[MCP-NLP] Distances for '${rightSide}':`);
                partNames.forEach(n => {
                    const d = levenshtein.get(tgt.name.toLowerCase(), n.toLowerCase());
                    console.log(` - '${n}': ${d}`);
                });
                await sendToApp('set_pose_target', {
                    source: src.name,
                    target: tgt.name,
                    source_face: src.face,
                    target_face: tgt.face
                });
                return `Moving '${src.name}' (${src.face}) to '${tgt.name}' (${tgt.face})...`;
            }
        }
        else if (lower.includes('play') || lower.includes('run') || lower.includes('preview')) {
            await sendToApp('preview_animation');
            return "Playing animation...";
        }
        else if (lower.includes('add') && lower.includes('step')) {
            await sendToApp('add_current_step', { description: input });
            return "Adding to sequence...";
        }
        else if (lower.includes('list') || lower.includes('state')) {
            return `Scene Objects: ${partNames.join(', ')}`;
        }
        return "❓ I didn't understand. Try 'move <part> [face] to <target> [face]'";
    }
    catch (e) {
        console.error(`❌ Error processing chat: ${e.message}`);
        return `Error: ${e.message}`;
    }
}
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