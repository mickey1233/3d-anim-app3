import 'dotenv/config'; // Load .env
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, WebSocket } from 'ws';
import { z } from "zod";
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// --- WebSocket Server (Bridge to React App) ---
const WSS_PORT = 3001;
const wss = new WebSocketServer({ port: WSS_PORT });

let activeClient: WebSocket | null = null;
const pendingRequests = new Map<string, { resolve: (val: any) => void, reject: (err: any) => void }>();

console.error(`[MCP-Server] WebSocket server listening on port ${WSS_PORT}`);

wss.on('connection', (ws) => {
    // console.error('[MCP-Server] React App Connected');
    activeClient = ws;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message.toString());
            
            // Case 1: Response to a pending request { id, result, error }
            if (data.id && pendingRequests.has(data.id)) {
                const { resolve, reject } = pendingRequests.get(data.id)!;
                if (data.error) reject(new Error(data.error));
                else resolve(data.result);
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

// Helper to call Ollama
async function callOllama(prompt: string, images: any[] = []): Promise<string> {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'qwen3-vl:32b';
    
    try { // Added try-catch block as in original
        const body: any = {
            model,
            prompt,
            stream: false,
            options: {
                temperature: 0, // CRITICAL: Deterministic output
                num_predict: 100 // Keep it short
            }
        };

        if (images.length > 0) {
            body.images = images.map(img => img.data); // base64
        }

        const res = await fetch(`${host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) throw new Error(`Ollama Error: ${res.statusText}`);
        const json = await res.json();
        return json.response;

    } catch (e: any) {
        throw new Error(`Failed to connect to Ollama at ${host}. Is it running? (Error: ${e.message})`);
    }
}

// ... existing code ...

            // Case 3: Image Analysis (VLM)
            if (data.command === 'analyze_images') {
                const images = data.arguments?.images || []; 
                const partNames = data.arguments?.partNames || [];
                const partDetails = data.arguments?.partDetails || [];
                let responseText = "";
                
                // Build dynamic prompt constraint
                let promptSuffix = "";
                if (partDetails.length > 0) {
                     // Filter out generic white/black if they don't help, or use them if valid.
                     // The logs showed all #ffffff. Let's only use color if it's NOT #ffffff.
                     const usefulDetails = partDetails.filter((d:any) => d.color && d.color !== '#ffffff');
                     
                     if (usefulDetails.length > 0) {
                        promptSuffix = `Use ONLY these part names (matching these colors): ${usefulDetails.map((d: any) => `'${d.name}' (${d.color})`).join(', ')}.`;
                     } else {
                        // Fallback to just names if colors are useless
                        promptSuffix = `Use ONLY these part names: ${partDetails.map((d: any) => `'${d.name}'`).join(', ')}.`;
                     }
                }
                else if (partNames.length > 0) {
                    promptSuffix = `Use ONLY these part names from the scene: ${partNames.map((n: string) => `'${n}'`).join(', ')}.`;
                } else {
                    promptSuffix = "Use part names like 'Part1', 'Part2'.";
                }

                console.log("[MCP-VLM Debug] Prompt Suffix:", promptSuffix);

                // Determine Provider: Env Var > Gemini Key > Mock
                const provider = process.env.VLM_PROVIDER || (genAI ? 'gemini' : 'mock');

                if (provider === 'mock') {
                    console.log("[MCP] Using Mock VLM Logic");
                    const names = images.map((img: any) => img.name);
                    
                    if (names.some((n:string) => n.includes('Spark1.png')) && names.some((n:string) => n.includes('Spark2.png'))) {
                         const moveCmd = "Move Part2 bottom to Part1 top";
                         responseText = `👀 **Visual Analysis (Mock)**:\nI see the screen component moving to the tray.\n\n🚀 **Auto-Executing**:\n\`${moveCmd}\`\n\`Add Step\``;
                         
                         await handleChatInput(moveCmd);
                         await new Promise(r => setTimeout(r, 500)); 
                         await handleChatInput("Add Step: Initial Placement");

                    } else if (names.some((n:string) => n.includes('Spark3.png')) || names.some((n:string) => n.includes('Spark4.png'))) {
                         const cmd = "Add Step: Close Lid";
                         responseText = `👀 **Visual Analysis (Mock)**:\nTray cover closing.\n\n🚀 **Auto-Executing**:\n\`${cmd}\``;
                         await handleChatInput("Add Step: Close Lid");
                    } else {
                        responseText = `👀 I see ${images.length} images. (Mock Mode)\n\nTip: Set \`VLM_PROVIDER=ollama\` for local AI, or add \`GEMINI_API_KEY\` for cloud AI.`;
                    }
                } 
                else if (provider === 'ollama') {
                     try {
                        console.log(`[MCP] Analyzing with Local Ollama (${process.env.OLLAMA_MODEL || 'llava'})...`);
                        let combinedResult = "";
                        
                        const stepsToanalyze = images.length > 1 ? images.length - 1 : 1;
                        
                        for (let i = 0; i < stepsToanalyze; i++) {
                            const imagePair = images.length > 1 ? [images[i], images[i+1]] : images;
                            console.log(`[MCP] Analyzing Pair ${i+1}/${stepsToanalyze}...`);

                            // Chain of Thought Prompt
                            const prompt = `Compare these two images (Start -> End).
                            First, describe the visual change.
                            Then, provide a PRECISE command using Part Names and Face Directions.
                            
                            Required Format: "COMMAND: Move [Source] [Face] to [Target] [Face]"
                            Valid Faces: top, bottom, left, right, front, back, center
                            ${promptSuffix}
                            
                            Example: "COMMAND: Move Part3 bottom to Part2 top"
                            If no movement, output "COMMAND: None"`;
                            
                            const generatedText = await callOllama(prompt, imagePair);
                            console.log(`[MCP] Raw VLM Output (Step ${i+1}): "${generatedText}"`); 

                            // Extract Command via Robust Regex
                            // Matches: Move PartA (optional face) to PartB (optional face)
                            // Groups: 1=Source, 2=SourceFace, 3=Target, 4=TargetFace
                            const cmdRegex = /COMMAND:\s*Move\s+([^\s]+)(?:\s+(top|bottom|left|right|front|back|center))?\s+to\s+([^\s]+)(?:\s+(top|bottom|left|right|front|back|center))?/i;
                            const match = generatedText.match(cmdRegex);
                            
                            let cleanCmd = "None";
                            if (match) {
                                const source = match[1];
                                const sFace = match[2] || 'bottom'; // Default if missing
                                const target = match[3];
                                const tFace = match[4] || 'top';    // Default if missing
                                cleanCmd = `Move ${source} ${sFace} to ${target} ${tFace}`;
                            } else if (/COMMAND:\s*None/i.test(generatedText)) {
                                cleanCmd = "None";
                            }
                            
                            combinedResult += `Step ${i+1}: ${cleanCmd}\n`;
                             
                            if (cleanCmd !== 'None') {
                                // Execute normalized command
                                const res = await handleChatInput(cleanCmd);
                                combinedResult += `   (Exec: ${res})\n`;
                            }
                        }

                        responseText = `🦙 **Sequential Analysis**:\n${combinedResult}\n✅ **Analysis Complete**`;

                     } catch (e: any) {
                         responseText = "❌ Local AI Error: " + e.message + "\n\nMake sure Ollama is running: `ollama run llava`";
                     }
                }
                else {
                    // Gemini (Refactored to Sequential too for consistency?)
                    // For now, let's keep Gemini logic simple or also loop. User is focused on Local.
                    // But to be safe, I'll allow Gemini to handle "bulk" since it's smarter, but actually sequential is safer for "Move X then Move Y".
                    // Let's implement sequential for Gemini too to ensure "1 by 1" behavior.
                    try {
                        console.log(`[MCP] Analyzing with Gemini (structure-aware)...`);
                        const model = genAI!.getGenerativeModel({ model: "gemini-1.5-flash" });
                        
                        let combinedResult = "";
                        const stepsToanalyze = images.length > 1 ? images.length - 1 : 1;

                        for (let i = 0; i < stepsToanalyze; i++) {
                            const imagePair = images.length > 1 ? [images[i], images[i+1]] : images;
                             const imageParts = imagePair.map((img: any) => ({
                                inlineData: { data: img.data, mimeType: img.mime || "image/png" }
                            }));

                            const prompt = `Compare these two images (Start state -> End state). Identify the single part movement. Return a NATURAL LANGUAGE command like 'Move PartA to PartB'. Use ONLY these part names: ${partNames.length > 0 ? partNames.map((n: string) => `'${n}'`).join(', ') : "'Part1', 'Part2'"}. Output JUST the command text.`;
                            
                            const result = await model.generateContent([prompt, ...imageParts]);
                            const generatedCmd = result.response.text().trim();
                             
                            combinedResult += `Step ${i+1}: "${generatedCmd}"\n`;
                            await handleChatInput(generatedCmd);
                        }
                        
                        responseText = `🧠 **Gemini Sequential Analysis**:\n${combinedResult}\n✅ **Execution Complete**`;

                    } catch (e: any) {
                        responseText = "❌ Gemini Error: " + e.message;
                    }
                }

                sendToApp('chat_response', { text: responseText }).catch(console.error);
            }

            // Case 4: Save Asset
            if (data.command === 'save_asset') {
                const { fileName, fileData, yamlData } = data.arguments;
                fs.appendFileSync('server_debug.log', `[${new Date().toISOString()}] Export Request: ${fileName}\n`);
                console.log(`[MCP] Saving Asset: ${fileName}`);
                
                try {
                     // 1. Ensure Directories
                    const assetsDir = path.resolve(process.cwd(), 'assets');
                    fs.appendFileSync('server_debug.log', `[DEBUG] Assets Dir: ${assetsDir}\n`);

                    const cadDir = path.join(assetsDir, '3d_cad');
                    const yamlDir = path.join(assetsDir, 'yaml');
                    
                    if (!fs.existsSync(cadDir)) fs.mkdirSync(cadDir, { recursive: true });
                    if (!fs.existsSync(yamlDir)) fs.mkdirSync(yamlDir, { recursive: true });
                    
                    // 2. Write Original File
                    const filePath = path.join(cadDir, fileName);
                    const buffer = Buffer.from(fileData, 'base64');
                    fs.writeFileSync(filePath, buffer);
                    
                    let message = `Saved ${fileName} to ${cadDir}`;
                    
                    // 3. Convert to USD if needed
                    const ext = path.extname(fileName).toLowerCase();
                    if (ext === '.glb' || ext === '.gltf') {
                        const usdName = path.basename(fileName, ext) + '.usdz';
                        const usdPath = path.join(cadDir, usdName);
                        
                        try {
                            fs.appendFileSync('server_debug.log', `[DEBUG] Converting to ${usdPath}\n`);
                            console.log(`[MCP] Converting ${fileName} to ${usdName}...`);
                            const scriptPath = path.join(process.cwd(), 'mcp-server', 'convert_to_usd.py');
                            
                            // Check if script exists
                            if (!fs.existsSync(scriptPath)) {
                                 // Fallback if not in subdirectory?
                                 throw new Error(`Script not found at ${scriptPath}`);
                            }

                            // Use python3 ? Or python?
                            const cmd = `python3 ${scriptPath} "${filePath}" "${usdPath}"`;
                            fs.appendFileSync('server_debug.log', `[DEBUG] Command: ${cmd}\n`);
                            
                            const output = await execAsync(cmd);
                            fs.appendFileSync('server_debug.log', `[DEBUG] Success: ${output.stdout}\n`);

                            message += `\nConverted to ${usdName}`;
                        } catch (e: any) {
                            console.error("Conversion Failed:", e);
                            fs.appendFileSync('server_debug.log', `[ERROR] Conversion Failed: ${e.message}\nStderr: ${e.stderr || ''}\n`);
                            message += `\nWarning: USD conversion failed (${e.message})`;
                        }
                    }
                    
                    // 4. Write YAML
                    const yamlName = path.basename(fileName, ext) + '.yaml';
                    const yamlPath = path.join(yamlDir, yamlName);
                    fs.writeFileSync(yamlPath, yamlData || ""); 
                    message += `\nSaved ${yamlName} to ${yamlDir}`;

                    sendToApp('chat_response', { text: `✅ Asset Export Complete:\n${message}` }).catch(console.error);

                } catch (e: any) {
                    console.error("Save Asset Error:", e);
                    fs.appendFileSync('server_debug.log', `[FATAL] Save Failed: ${e.message}\n`);
                    sendToApp('chat_response', { text: `❌ Save Failed: ${e.message}` }).catch(console.error);
                }
            }

        } catch (e) {
            console.error('[MCP-Server] Failed to parse message from client', e);
        }
    });

    ws.on('close', () => {
        // Only clear activeClient if THIS socket was the active one
        if (activeClient === ws) {
            // console.error('[MCP-Server] React App Disconnected (Active Client)');
            activeClient = null;
        }
    });
});

// --- NLP / Chat Logic ---
import { GoogleGenerativeAI } from "@google/generative-ai";
import levenshtein from "fast-levenshtein";
import { routeIntent } from "./intentRouter.js";
import { executeToolCalls, fuzzyMatchPart } from "./errorRecovery.js";

// Initialize Gemini if key exists
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

if (!genAI) {
    console.warn("[MCP] FAST-WARNING: No GEMINI_API_KEY found in .env. AI Chat features will be limited to basic keyword matching.");
}

/** Generate a conversational reply for CHAT intents (no tool calls). */
async function generateChatReply(input: string, partNames: string[]): Promise<string> {
    const lower = input.toLowerCase().trim();

    // Simple built-in responses
    if (/^(hi|hello|hey|你好)\b/.test(lower)) {
        return `Hello! I'm your 3D assembly assistant. I can move, rotate, mate parts, and create animations. Try "move Part1 to Part2" or "undo". Currently ${partNames.length} part(s) in the scene.`;
    }
    if (/^(thanks|thank you|謝謝)\b/.test(lower)) {
        return "You're welcome! Let me know if you need anything else.";
    }
    if (/\b(help|how|what can)\b/.test(lower)) {
        return `Here's what I can do:\n- Move/rotate parts: "move Part1 up by 2"\n- Mate faces: "put Part1 on Part2"\n- Twist: "twist Part1 45 degrees"\n- Animation: "add step", "play animation"\n- History: "undo", "redo"\n- Scene: "reset scene", "load demo"\n- Mode: "switch to rotate mode"\n\nCurrently ${partNames.length} part(s) in the scene: ${partNames.slice(0, 5).join(', ')}${partNames.length > 5 ? '...' : ''}`;
    }
    if (/\b(list|show|what)\b.*\b(parts?|scene)\b/.test(lower)) {
        if (partNames.length === 0) return "No parts in the scene. Load a model first with 'load demo'.";
        return `Scene has ${partNames.length} part(s):\n${partNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}`;
    }

    // Try LLM for open-ended chat if available
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(
                `You are a helpful 3D assembly studio assistant. The scene has parts: ${JSON.stringify(partNames)}. Respond briefly to: "${input}"`,
            );
            return result.response.text().trim();
        } catch { /* ignore */ }
    }

    return "I can help with moving, rotating, and mating 3D parts. Try 'move Part1 to Part2' or type 'help' for more options.";
}

async function handleChatInput(input: string): Promise<string> {
    // 1. Fetch current scene state for context
    let sceneParts: any[] = [];
    try {
        const state: any = await sendToApp('get_scene_state');
        sceneParts = (state && state.parts && Array.isArray(state.parts)) ? state.parts : (Array.isArray(state) ? state : []);
    } catch (e) {
        console.warn("[MCP] Failed to fetch scene state for NLP context", e);
    }

    const partNames = sceneParts.map((p: any) => p.name);

    // 2. Two-phase intent routing
    try {
        const intent = await routeIntent(input, partNames, genAI);
        console.log(`[MCP] Intent: ${intent.class} (${intent.confidence}), ${intent.tool_calls.length} tool call(s)`);

        // Handle based on intent class
        switch (intent.class) {
            case 'CHAT':
                return intent.chat_response || await generateChatReply(input, partNames);

            case 'TOOL_CALL': {
                if (intent.tool_calls.length === 0) {
                    return intent.chat_response || "I understood you want to do something but couldn't determine the action. Could you be more specific?";
                }
                const { summary } = await executeToolCalls(intent.tool_calls, sendToApp, partNames);
                return summary;
            }

            case 'MIXED': {
                // Execute tools then append chat response
                let reply = '';
                if (intent.tool_calls.length > 0) {
                    const { summary } = await executeToolCalls(intent.tool_calls, sendToApp, partNames);
                    reply = summary;
                }
                if (intent.chat_response) {
                    reply += (reply ? '\n' : '') + intent.chat_response;
                }
                return reply || "Done.";
            }

            case 'CLARIFY':
                return intent.clarification || intent.chat_response || "Could you clarify what you'd like to do?";

            default:
                return "I didn't understand that. Try 'move Part1 to Part2', 'undo', 'reset', or ask me about the scene.";
        }
    } catch (e: any) {
        console.error(`[MCP] Intent routing failed: ${e.message}`);
        // Fall through to legacy heuristic below
    }

    // --- STRATEGY B: Robust Heuristic (Fallback) ---
    const lower = input.toLowerCase();

    // Helper: Find best fuzzy match from a list of strings
    const fuzzyMatch = (query: string, candidates: string[], thresholdRatio = 0.4): string | null => {
        if (!query) return null;
        let bestMatch = null;
        let minDist = Infinity;
        
        for (const cand of candidates) {
            const dist = levenshtein.get(query.toLowerCase(), cand.toLowerCase());
            // Allow errors relative to length
            const maxEdits = Math.max(1, cand.length * thresholdRatio); 
            if (dist < minDist && dist <= maxEdits) {
                minDist = dist;
                bestMatch = cand;
            }
        }
        return bestMatch; 
    };

    // Helper: Check if input string contains a fuzzy match of keyword
    const hasKeyword = (text: string, keyword: string): boolean => {
        const words = text.split(/\s+/);
        return words.some(w => fuzzyMatch(w, [keyword], 0.3) === keyword);
    };

    try {
        const isMatch = (keys: string[]) => keys.some(k => hasKeyword(lower, k));
        
        // Priority 1: High Specificity Commands (Load, Reset, Preview, Add Step)
        // These must be checked BEFORE "Move" because "Step" fuzzy-matches "Set" in the move logic.

        // LOAD
        if (isMatch(['load', 'open', 'import']) && isMatch(['demo', 'example', 'cad', 'template'])) {
            await sendToApp('load_demo_model');
            return "Loading Demo CAD Model...";
        }
        
        // RESET
        else if (isMatch(['reset', 'clear', 'wipe', 'restart'])) {
            await sendToApp('reset_scene');
            return "Resetting scene...";
        }

        // PREVIEW / PLAY
        else if (isMatch(['play', 'preview', 'run', 'test', 'animate'])) {
            await sendToApp('preview_animation');
            return "Playing animation...";
        }

        // ADD STEP
        else if (isMatch(['add', 'insert', 'save', 'record', 'append', 'create', 'include', 'introduce', 'new', 'plus']) && isMatch(['step', 'frame', 'keyframe', 'snapshot'])) {
             // Extract description if possible? For now, use full input.
            await sendToApp('add_current_step', { description: input });
            return "Adding to sequence...";
        }
        
        // SELECT
        else if (lower.startsWith('select ')) { 
            const rawName = input.substring(7).trim();
            const matchedName = fuzzyMatch(rawName, partNames) || rawName;
            await sendToApp('select_part', { name_or_uuid: matchedName });
            return `Selecting '${matchedName}'...`;
        }

        // LIST
        else if (hasKeyword(lower, 'list') || hasKeyword(lower, 'state') || hasKeyword(lower, 'show') && hasKeyword(lower, 'parts')) {
            return `Scene Objects: ${partNames.join(', ')}`;
        }

        // Priority 2: Broad "Move/Relocate" logic (The Catch-All)
        // Checked LAST to avoid capturing other commands.
        else if (hasKeyword(lower, 'move') || hasKeyword(lower, 'align') || hasKeyword(lower, 'put') || hasKeyword(lower, 'set') || hasKeyword(lower, 'relocate') || hasKeyword(lower, 'shift') || hasKeyword(lower, 'translate') || hasKeyword(lower, 'reposition') || hasKeyword(lower, 'place') || hasKeyword(lower, 'bring') || hasKeyword(lower, 'attach') || hasKeyword(lower, 'position') || hasKeyword(lower, 'arrange')) {
            // Advanced Parsing v3: "Proximity-Based" Matching
            // Solves "Relocate Part1 to Part2" (Role Inversion) and "Part1 bottom to Part2 top" (Face Inaccuracy)
            
            const faces = ["top", "bottom", "left", "right", "front", "back", "center"];
            const sourceMarkers = ['source', 'start', 'from', 'base', 'move', 'relocate', 'shift', 'translate', 'put', 'set', 'reposition', 'place', 'bring', 'attach', 'position', 'arrange'];
            const targetMarkers = ['target', 'end', 'to', 'destination', 'final', 'into', 'onto', 'on', 'at'];

            // 1. Find all mentions of known parts (Part-First Regex)
            const mentionedParts: { partName: string, index: number, end: number, score: number }[] = [];
            const sortedParts = [...partNames].sort((a, b) => b.length - a.length);

            let tempInput = lower;
            for (const pName of sortedParts) {
                const escaped = pName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
                const charSequence = escaped.split('').join('\\s*');
                const regex = new RegExp(`\\b${charSequence}\\b`, 'i');
                
                const match = regex.exec(tempInput);
                if (match) {
                    mentionedParts.push({
                        partName: pName,
                        index: match.index,
                        end: match.index + match[0].length,
                        score: 0
                    });
                    tempInput = tempInput.substring(0, match.index) + ' '.repeat(match[0].length) + tempInput.substring(match.index + match[0].length);
                }
            }

            if (mentionedParts.length === 0) {
                 return "❓ I understood the command but couldn't identify which parts to move.";
            }

            // 2. Identify Roles (Source vs Target) using Distance Weighted Scoring
            // Score = Sum( 1 / (distance + 1) ) * weight
            let rawSource: any = null;
            let rawTarget: any = null;

            for (const p of mentionedParts) {
                let scoreSource = 0;
                let scoreTarget = 0;

                const scanAndScore = (markers: string[], isSourceBoost: boolean) => {
                    let score = 0;
                    for (const m of markers) {
                        // Find all instances of marker in string
                        let searchIdx = 0;
                        while (true) {
                            const idx = lower.indexOf(m, searchIdx);
                            if (idx === -1) break;
                            
                            // Distance to part (min distance to start or end)
                            // If marker is BEFORE part: distance = p.index - (idx + m.length)
                            // If marker is AFTER part: distance = idx - p.end
                            let dist = 0;
                            if (idx + m.length <= p.index) {
                                dist = p.index - (idx + m.length); // Marker is before
                            } else if (idx >= p.end) {
                                dist = idx - p.end; // Marker is after
                            } else {
                                dist = 0; // Overlap? shouldn't happen with simpler logic
                            }
                            
                            // Only count if within reasonable range (e.g. 30 chars), but decay heavily
                            if (dist < 35) {
                                // Decay: 10 / (dist + 1)
                                let val = 20 / (dist + 1);
                                
                                // INVERSION LOGIC:
                                // If marker is AFTER the part (dist calculated from p.end), 
                                // "Part1 to Part2" -> "to" is AFTER Part1. implies Part1 is Source.
                                if (idx >= p.end) {
                                    if (targetMarkers.includes(m)) {
                                         // "To" after part -> Part is Source
                                         if (isSourceBoost) score += val; 
                                    } else if (sourceMarkers.includes(m)) {
                                         // "From" after part -> Part is Target? (Rare: "Move Part1 from Part2")
                                         if (!isSourceBoost) score += val;
                                    }
                                } else {
                                    // Marker is BEFORE the part
                                    if (sourceMarkers.includes(m)) {
                                        // "From" before part -> Part is Source
                                        if (isSourceBoost) score += val;
                                    } else if (targetMarkers.includes(m)) {
                                        // "To" before part -> Part is Target
                                        if (!isSourceBoost) score += val;
                                    }
                                }
                            }
                            searchIdx = idx + 1;
                        }
                    }
                    return score;
                };

                scoreSource += scanAndScore(sourceMarkers, true);
                scoreSource += scanAndScore(targetMarkers, true); // We verify inside if it boosts source
                
                scoreTarget += scanAndScore(sourceMarkers, false);
                scoreTarget += scanAndScore(targetMarkers, false);

                if (scoreSource > scoreTarget) {
                    if (!rawSource || scoreSource > rawSource.score) rawSource = { ...p, score: scoreSource };
                } else if (scoreTarget > scoreSource) {
                     if (!rawTarget || scoreTarget > rawTarget.score) rawTarget = { ...p, score: scoreTarget };
                }
            }

            // Fallback: Order (Source -> Target)
            mentionedParts.sort((a, b) => a.index - b.index);

            if (!rawSource && !rawTarget && mentionedParts.length >= 2) {
                rawSource = { ...mentionedParts[0], score: 0 };
                rawTarget = { ...mentionedParts[1], score: 0 };
            } else if (rawSource && !rawTarget && mentionedParts.length >= 2) {
                const found = mentionedParts.find(p => p.partName !== rawSource.partName);
                if (found) rawTarget = { ...found, score: 0 };
            } else if (!rawSource && rawTarget && mentionedParts.length >= 2) {
                 const found = mentionedParts.find(p => p.partName !== rawTarget.partName);
                 if (found) rawSource = { ...found, score: 0 };
            }

             if (!rawSource || !rawTarget) {
                 return `❓ Found parts (${mentionedParts.map(p => p.partName).join(', ')}), but couldn't distinguish Source vs Target. Try adding 'to' or 'from'.`;
            }

            // 3. Extract Faces (Proximity Based with Ownership)
            // Find NEAREST face keyword, but ONLY if this part is the closest part to that keyword.
            const getFace = (part: any) => {
                if (!part) return 'center';
                const range = 60; 
                const startSearch = Math.max(0, part.index - range);
                const endSearch = Math.min(lower.length, part.end + range);
                const context = lower.substring(startSearch, endSearch);
                
                let bestFace = 'center';
                let minDist = Infinity;

                for (const face of faces) {
                    let searchIdx = 0;
                    while (true) {
                         const idx = context.indexOf(face, searchIdx);
                         if (idx === -1) break;
                         
                         const absIdx = startSearch + idx;
                         
                         // Check distance to THIS part
                         let dist = 0;
                         let isBefore = false;
                         if (absIdx < part.index) {
                             dist = part.index - (absIdx + face.length);
                             isBefore = true;
                         } else {
                             dist = absIdx - part.end;
                         }
                         
                         // "OF" BINDING LOGIC:
                         // If "of" appears between face and part, boost significance (reduce distance).
                         // e.g. "Bottom >edge OF< Part1"
                         if (isBefore) {
                             // Check text between face end match and part start
                             const between = lower.substring(absIdx + face.length, part.index);
                             if (/\bof\b/.test(between)) {
                                 dist = 0.1; // Massive boost for "Of" binding
                             }
                         }

                         // OWNERSHIP CHECK: Is this face closer to another part?
                         let closestOtherDist = Infinity;
                         for (const otherPart of mentionedParts) {
                             if (otherPart.partName === part.partName) continue;
                             
                             let d = 0;
                             let otherIsBefore = false;
                             if (absIdx < otherPart.index) {
                                 d = otherPart.index - (absIdx + face.length);
                                 otherIsBefore = true;
                             } else {
                                 d = absIdx - otherPart.end;
                             }

                             // Apply same "OF" logic to the competitor
                             if (otherIsBefore) {
                                const bet = lower.substring(absIdx + face.length, otherPart.index);
                                if (/\bof\b/.test(bet)) d = 0.1;
                             }

                             if (d < closestOtherDist) closestOtherDist = d;
                         }

                         // Only valid if WE are the closest part (or equal distance)
                         if (dist <= closestOtherDist) {
                             if (dist < minDist) {
                                 minDist = dist;
                                 bestFace = face;
                             }
                         }
                         
                         searchIdx = idx + 1;
                    }
                }
                
                if (minDist > 55) return 'center';

                return bestFace;
            };

            const sourceFace = getFace(rawSource);
            const targetFace = getFace(rawTarget);

            const finalSourceFace = (sourceFace === 'center') ? 'bottom' : sourceFace;
            const finalTargetFace = (targetFace === 'center') ? 'top' : targetFace;

            await sendToApp('set_pose_target', { 
                source: rawSource.partName, 
                target: rawTarget.partName, 
                source_face: finalSourceFace, 
                target_face: finalTargetFace 
            });
            
            return `Moving '${rawSource.partName}' (${finalSourceFace}) to '${rawTarget.partName}' (${finalTargetFace})...`;
        }
        
        if (hasKeyword(lower, 'step')) {
             return "❓ I didn't understand. To add a step, try starting with 'Add step', 'Insert step', or 'Record step'.";
        }
        return "❓ I didn't understand. Try 'move <part> [face] to <target> [face]', or 'Add step'.";

    } catch (e: any) {
        console.error(`❌ Error processing chat: ${e.message}`);
        return `Error: ${e.message}`;
    }
}

// Helper to send command to React App
async function sendToApp(command: string, args: any = {}): Promise<any> {
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

        activeClient!.send(JSON.stringify({ id, command, arguments: args }));
    });
}


// --- MCP Server Definition ---
const server = new Server(
  {
    name: "3d-anim-studio-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ── Tool Definitions (all 21 + legacy tools) ──
// JSON Schema format required by MCP SDK.
// The React app handles execution; the server is a thin proxy.

const FACE_ENUM = ["top", "bottom", "left", "right", "front", "back", "center"];
const MATE_ENUM = ["flush", "insert", "edge_to_edge", "axis_to_axis", "point_to_point", "planar_slide"];
const VEC3 = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 } as const;
const QUAT = { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 } as const;

const TOOLS_LIST: Tool[] = [
    // ── Selection ──
    { name: "select_part", description: "Select a part by name (fuzzy match) or UUID.", inputSchema: { type: "object", properties: { name_or_uuid: { type: "string" } }, required: ["name_or_uuid"] } },
    { name: "select_face", description: "Select a semantic face on a part. Returns face coordinate frame.", inputSchema: { type: "object", properties: { part: { type: "string" }, face: { type: "string", enum: FACE_ENUM } }, required: ["part", "face"] } },
    { name: "get_selection", description: "Query current selection: selected part, faces, interaction mode.", inputSchema: { type: "object", properties: {} } },

    // ── Query ──
    { name: "get_scene_state", description: "List all parts with transforms, bounding boxes, camera, UI state.", inputSchema: { type: "object", properties: {} } },
    { name: "get_face_info", description: "Get coordinate frame for a face. Returns available mate modes.", inputSchema: { type: "object", properties: { part: { type: "string" }, face: { type: "string", enum: FACE_ENUM } }, required: ["part", "face"] } },
    { name: "get_part_transform", description: "Get full transform (position, rotation, quaternion, bbox) for a part.", inputSchema: { type: "object", properties: { part: { type: "string" } }, required: ["part"] } },

    // ── Transform ──
    { name: "translate_part", description: "Move a part. relative=add delta, absolute=set position.", inputSchema: { type: "object", properties: { part: { type: "string" }, mode: { type: "string", enum: ["absolute", "relative"] }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, preview: { type: "boolean" } }, required: ["part", "x", "y", "z"] } },
    { name: "rotate_part", description: "Rotate a part around an axis by angle (degrees).", inputSchema: { type: "object", properties: { part: { type: "string" }, axis: { oneOf: [{ type: "string", enum: ["x","y","z"] }, VEC3] }, angle: { type: "number" }, pivot: VEC3, absolute: { type: "boolean" }, preview: { type: "boolean" } }, required: ["part", "axis", "angle"] } },
    { name: "align_faces", description: "Core mate: align source face to target face with specified mode.", inputSchema: { type: "object", properties: { source_part: { type: "string" }, source_face: { type: "string", enum: FACE_ENUM }, target_part: { type: "string" }, target_face: { type: "string", enum: FACE_ENUM }, mode: { type: "string", enum: MATE_ENUM }, offset: { type: "number" }, flip: { type: "boolean" }, twist_angle: { type: "number" }, preview: { type: "boolean" } }, required: ["source_part", "source_face", "target_part", "target_face", "mode"] } },

    // ── Compute (pure math, no side-effects) ──
    { name: "compute_mate", description: "Calculate mate transform without applying. Returns transform + debug + arc path.", inputSchema: { type: "object", properties: { source_part: { type: "string" }, source_face: { type: "string", enum: FACE_ENUM }, target_part: { type: "string" }, target_face: { type: "string", enum: FACE_ENUM }, mode: { type: "string", enum: MATE_ENUM }, offset: { type: "number" }, flip: { type: "boolean" }, twist_angle: { type: "number" } }, required: ["source_part", "source_face", "target_part", "target_face", "mode"] } },
    { name: "compute_twist", description: "Compute twist rotation. Supports arbitrary angles, snap, auto-alignment.", inputSchema: { type: "object", properties: { part: { type: "string" }, axis: { oneOf: [{ type: "string", enum: ["x","y","z","face_normal"] }, VEC3] }, angle: { type: "number" }, reference_face: { type: "string", enum: FACE_ENUM }, snap_increment: { type: "number" } }, required: ["part"] } },

    // ── Preview & Commit ──
    { name: "preview_transform", description: "Show ghosted preview. Supports single pose or animated path.", inputSchema: { type: "object", properties: { part: { type: "string" }, position: VEC3, rotation: VEC3, quaternion: QUAT, path: { type: "array", items: { type: "object" } }, duration: { type: "number" } }, required: ["part"] } },
    { name: "commit_transform", description: "Apply previewed transform. Pushes to undo history.", inputSchema: { type: "object", properties: { part: { type: "string" }, position: VEC3, rotation: VEC3, quaternion: QUAT, add_to_sequence: { type: "boolean" }, step_description: { type: "string" } }, required: ["part"] } },
    { name: "cancel_preview", description: "Cancel active preview, restore original transform.", inputSchema: { type: "object", properties: { part: { type: "string" } } } },

    // ── History ──
    { name: "undo", description: "Undo the last committed transform.", inputSchema: { type: "object", properties: {} } },
    { name: "redo", description: "Redo the last undone transform.", inputSchema: { type: "object", properties: {} } },

    // ── Mode ──
    { name: "set_interaction_mode", description: "Set 3D interaction mode: move, rotate, mate.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["move", "rotate", "mate"] } }, required: ["mode"] } },

    // ── Animation / Sequence ──
    { name: "add_animation_step", description: "Add animation step to assembly sequence.", inputSchema: { type: "object", properties: { part: { type: "string" }, target_position: VEC3, target_quaternion: QUAT, duration: { type: "number" }, easing: { type: "string", enum: ["linear","easeIn","easeOut","easeInOut"] }, path: { type: "array", items: { type: "object" } }, description: { type: "string" } }, required: ["part", "description"] } },
    { name: "play_animation", description: "Play assembly animation sequence or single step.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["sequence","single_step"] }, step_index: { type: "number" } } } },
    { name: "stop_animation", description: "Stop currently playing animation.", inputSchema: { type: "object", properties: {} } },

    // ── Scene ──
    { name: "reset_scene", description: "Reset all parts to initial positions.", inputSchema: { type: "object", properties: {} } },
    { name: "reset_part", description: "Reset a specific part to its initial position.", inputSchema: { type: "object", properties: { part: { type: "string" } }, required: ["part"] } },
    { name: "load_model", description: "Load a 3D model (GLB/GLTF/USD).", inputSchema: { type: "object", properties: { url: { type: "string" }, filename: { type: "string" } }, required: ["url"] } },

    // ── UI ──
    { name: "get_ui_state", description: "Get current UI state: mode, preview, animation, undo/redo.", inputSchema: { type: "object", properties: {} } },
    { name: "set_environment", description: "Change 3D environment preset and floor style.", inputSchema: { type: "object", properties: { preset: { type: "string", enum: ["warehouse","city","sunset","studio","night","apartment","forest","dawn","lobby","park"] }, floor: { type: "string", enum: ["grid","reflective","none"] } } } },

    // ── Legacy (kept for backward compatibility) ──
    { name: "set_pose_target", description: "[Legacy] Set start/end markers for animation.", inputSchema: { type: "object", properties: { source: { type: "string" }, target: { type: "string" }, source_face: { type: "string", enum: FACE_ENUM }, target_face: { type: "string", enum: FACE_ENUM } }, required: ["source", "target", "source_face", "target_face"] } },
    { name: "set_marker_manual", description: "[Legacy] Manually set marker position.", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["start","end"] }, x: { type: "number" }, y: { type: "number" }, z: { type: "number" } }, required: ["type", "x", "y", "z"] } },
    { name: "preview_animation", description: "[Legacy] Play single-step animation preview.", inputSchema: { type: "object", properties: {} } },
    { name: "add_current_step", description: "[Legacy] Add current animation config as step.", inputSchema: { type: "object", properties: { description: { type: "string" } }, required: ["description"] } },
    { name: "load_demo_model", description: "[Legacy] Load demo model.", inputSchema: { type: "object", properties: {} } },
    { name: "play_assembly", description: "[Legacy] Play full assembly sequence.", inputSchema: { type: "object", properties: {} } },
    { name: "save_asset", description: "Save CAD model + YAML to assets folder.", inputSchema: { type: "object", properties: { fileName: { type: "string" }, fileData: { type: "string" }, yamlData: { type: "string" } }, required: ["fileName", "fileData", "yamlData"] } },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS_LIST };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
      // ── Server-side tools (file I/O, not forwarded) ──
      if (name === "save_asset") {
          const { fileName, fileData, yamlData } = args as any;
          const assetsDir = path.resolve(process.cwd(), 'assets');
          const cadDir = path.join(assetsDir, '3d_cad');
          const yamlDir = path.join(assetsDir, 'yaml');
          if (!fs.existsSync(cadDir)) fs.mkdirSync(cadDir, { recursive: true });
          if (!fs.existsSync(yamlDir)) fs.mkdirSync(yamlDir, { recursive: true });

          const filePath = path.join(cadDir, fileName);
          const buffer = Buffer.from(fileData, 'base64');
          fs.writeFileSync(filePath, buffer);
          let message = `Saved ${fileName} to ${cadDir}`;

          const ext = path.extname(fileName).toLowerCase();
          if (ext === '.glb' || ext === '.gltf') {
              const usdName = path.basename(fileName, ext) + '.usd';
              const usdPath = path.join(cadDir, usdName);
              try {
                  const scriptPath = path.join(process.cwd(), 'convert_to_usd.py');
                  await execAsync(`python3 ${scriptPath} "${filePath}" "${usdPath}"`);
                  message += `\nConverted to ${usdName}`;
              } catch (e: any) {
                  message += `\nWarning: USD conversion failed (${e.message})`;
              }
          }

          const yamlName = path.basename(fileName, ext) + '.yaml';
          const yamlPath = path.join(yamlDir, yamlName);
          fs.writeFileSync(yamlPath, yamlData || "");
          message += `\nSaved ${yamlName} to ${yamlDir}`;
          return { content: [{ type: "text", text: message }] };
      }

      // ── All other tools: forward to React app via WebSocket ──
      // Legacy name mapping for backward compatibility
      const commandMap: Record<string, string> = {
          play_assembly: 'play_sequence',
          reset_selected_part: 'reset_selected_part',
      };
      const command = commandMap[name] || name;
      const result = await sendToApp(command, args);
      const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };

  } catch (error: any) {
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
