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

// Initialize Gemini if key exists
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

if (!genAI) {
    console.warn("[MCP] FAST-WARNING: No GEMINI_API_KEY found in .env. AI Chat features will be limited to basic keyword matching.");
}

async function handleChatInput(input: string): Promise<string> {
    const lower = input.toLowerCase();

    // 1. Fetch Current Scene State for Context (Names/UUIDs)
    let sceneParts: any[] = [];
    try {
        const state: any = await sendToApp('get_scene_state');
        sceneParts = (state && state.parts && Array.isArray(state.parts)) ? state.parts : (Array.isArray(state) ? state : []);
    } catch (e) {
        console.warn("[MCP] Failed to fetch scene state for NLP context", e);
    }

    const partNames = sceneParts.map((p: any) => p.name);
    
    // --- STRATEGY A: LLM (If Available) ---
    if (genAI) {
        try {
            console.log("[MCP] Using Gemini LLM for chat...");
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            
            const prompt = `
            You are an AI controlling a 3D animation studio. You assist the user by converting natural language requests into specific tool commands.
            
            **Context**:
            - Current Parts in Scene: ${JSON.stringify(partNames)}
            
            **User Input**: "${input}"
            
            **Available Tools**:
            - set_pose_target(source, target, source_face, target_face)
              - Use this for "move", "align", "put X on Y".
              - faces: top, bottom, left, right, front, back, center
              - Defaults: source_face=bottom, target_face=top (unless context implies otherwise)
            - reset_scene()
              - Use this for "reset", "clear", "restart".
            - load_demo_model()
              - Use this for "load demo", "show example".
            - preview_animation()
              - Use this for "play", "start", "preview".
            - add_current_step(description)
              - Use this for "save step", "record this", "add to sequence".

            **Instructions**:
            1. **Analyze Intent**: Determine what the user wants to do.
            2. **Handle Typos**: The user input may contain typos (e.g., "mov part1", "allign block"). You MUST fuzzy-match to the intended command and part names.
            3. **Resolve Names**: Map user's words to the *exact* part names in the "Current Parts" list. E.g., if user says "lid" and list has "Part2_Lid", use "Part2_Lid".
            4. **Construct Response**: valid JSON only. No markdown.
            
            **Response Format (JSON)**:
            {
              "tool": "tool_name",
              "args": { ...arguments... }
            }
            
            Example 1:
            Input: "mov part2 to part1"
            Output: {"tool": "set_pose_target", "args": {"source": "Part2", "target": "Part1", "source_face": "bottom", "target_face": "top"}}

            Example 2:
            Input: "rest scene"
            Output: {"tool": "reset_scene", "args": {}}
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
        } catch (e) {
            console.error("[MCP] LLM Failed, falling back to heuristic:", e);
        }
    }

    // --- STRATEGY B: Robust Heuristic (Fallback) ---
    
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

// Define Tools
const TOOLS_LIST: Tool[] = [
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
