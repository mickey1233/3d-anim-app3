import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';

// Parse natural language into tool calls (Simulating an LLM)
async function mockLlmRouter(input: string, client: Client) {
    const lower = input.toLowerCase();

    try {
        if (lower.includes('load') && (lower.includes('demo') || lower.includes('cad'))) {
            console.log('🤖 AI: Loading Demo CAD Model...');
            await client.callTool({ name: 'load_demo_model', arguments: {} });
        }
        else if (lower.includes('reset')) {
            console.log('🤖 AI: Resetting scene...');
            await client.callTool({ name: 'reset_scene', arguments: {} });
        }
        else if (lower.startsWith('select ')) {
            const name = input.substring(7).trim();
            console.log(`🤖 AI: Selecting '${name}'...`);
            await client.callTool({ name: 'select_part', arguments: { name_or_uuid: name } });
        }
        else if (lower.includes('move') && lower.includes('to')) {
            // "move Part A bottom to Part B top"
            // Regex: move (name) (face)? to (name) (face)?
            // Faces are optional, default to center if missing (or bottom/top logic if implied?)
            // Let's try explicit regex first:
            // "move [part1] [face1] to [part2] [face2]"
            // "move [part1] to [part2]" (fallback to bottom-to-top default?)
            
            // Matches: "move lid bottom to box top"
            const match = input.match(/move\s+(.+?)(?:\s+(top|bottom|left|right|front|back|center))?\s+to\s+(.+?)(?:\s+(top|bottom|left|right|front|back|center))?$/i);
            
            if (match) {
                const sourceName = match[1]!.trim();
                const sourceFace = match[2] || 'bottom'; // Default
                const targetName = match[3]!.trim();
                const targetFace = match[4] || 'top';    // Default

                console.log(`🤖 AI: Moving '${sourceName}' (${sourceFace}) to '${targetName}' (${targetFace})...`);
                await client.callTool({ 
                    name: 'set_pose_target', 
                    arguments: { 
                        source: sourceName, 
                        target: targetName, 
                        source_face: sourceFace.toLowerCase(), 
                        target_face: targetFace.toLowerCase() 
                    } 
                });
            } else {
                console.log("⚠️ format: move <part> [face] to <part> [face]");
            }
        }
        else if (lower.includes('play') || lower.includes('run') || lower.includes('preview')) {
            console.log('🤖 AI: Playing animation...');
            await client.callTool({ name: 'preview_animation', arguments: {} });
        }
        else if (lower.includes('add') && lower.includes('step')) {
            console.log('🤖 AI: Adding to sequence...');
            await client.callTool({ name: 'add_current_step', arguments: { description: input } });
        }
        else if (lower.includes('list') || lower.includes('state')) {
            const res = await client.callTool({ name: 'get_scene_state', arguments: {} });
            console.log('Scene State:', (res as any).content[0].text);
        }
        else {
            console.log("❓ AI: I didn't understand that. Try 'move lid to box', 'play', 'reset', or 'add step'.");
        }
    } catch (e: any) {
        console.error(`❌ Error: ${e.message}`);
    }
}

async function main() {
    // Path to the server we just built
    const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
    
    console.log(`🔌 Connecting to MCP Server at ${serverPath}...`);

    const transport = new StdioClientTransport({
        command: "node",
        args: [serverPath],
    });

    const client = new Client(
        {
            name: "simple-cli-client",
            version: "1.0.0",
        },
        {
            capabilities: {},
        }
    );

    await client.connect(transport);
    console.log("✅ Connected! Type your commands below.");
    console.log("Examples:");
    console.log("  - reset");
    console.log("  - move lid to box");
    console.log("  - play");
    console.log("  - add step");
    console.log("  - exit");
    console.log("-----------------------------------------");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'You> '
    });

    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (input === 'exit') {
            rl.close();
            return;
        }
        if (input) {
            await mockLlmRouter(input, client);
        }
        rl.prompt();
    }).on('close', async () => {
        console.log('Exiting...');
        try { await client.close(); } catch {}
        process.exit(0);
    });
}

main().catch(console.error);
