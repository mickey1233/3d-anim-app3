import React, { useEffect, useState, useRef } from 'react';
import { Send, Bot, User, Eye, Loader2 } from 'lucide-react';
import { mcpBridge } from '../../services/MCPBridge';
import { useAppStore } from '../../store/useAppStore';

interface ChatMessage {
    id: string;
    sender: 'user' | 'bot';
    text: string;
    timestamp: number;
}

export const ChatInterface: React.FC = () => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const { images, parts } = useAppStore();

    useEffect(() => {
        // Register handler for server responses (AI replies)
        mcpBridge.registerHandler('chat_response', async (_cmd, args: { text: string }) => {
            addMessage('bot', args.text);
            setIsAnalyzing(false);
            return { success: true };
        });

        // Initial welcome message
        if (messages.length === 0) {
            addMessage('bot', 'Ready. Type a command or click "Analyze" to inspect uploaded images.');
        }
    }, []);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const addMessage = (sender: 'user' | 'bot', text: string) => {
        setMessages(prev => [...prev, {
            id: Math.random().toString(36).substring(7),
            sender,
            text,
            timestamp: Date.now()
        }]);
    };

    const handleSend = () => {
        if (!inputValue.trim()) return;
        
        const text = inputValue.trim();
        addMessage('user', text);
        mcpBridge.sendChatCommand(text);
        setInputValue('');
    };

    const handleAnalyze = async () => {
        if (images.length === 0) {
            addMessage('bot', "⚠️ No images found. Please upload images in the 'Image Uploader' tab first.");
            return;
        }

        setIsAnalyzing(true);
        addMessage('user', `Analyze ${images.length} images...`);

        try {
            const payload = await Promise.all(images.map(async (img) => {
                // Fetch blob data from blob: URL
                const blob = await fetch(img.url).then(r => r.blob());
                return new Promise<{ name: string, data: string, mime: string }>((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const base64 = (reader.result as string).split(',')[1];
                        resolve({
                            name: img.name,
                            data: base64,
                            mime: blob.type
                        });
                    };
                    reader.readAsDataURL(blob);
                });
            }));

            // Extract Part Details (Name + Color)
            const partDetails = Object.values(parts).map(p => ({
                name: p.name,
                color: p.color || "unknown"
            }));
            console.log("Transmitting Part Details:", partDetails);

            mcpBridge.sendImageAnalysis(payload, partDetails);

        } catch (e) {
            console.error("Analysis Failed:", e);
            setIsAnalyzing(false);
            addMessage('bot', "❌ Failed to prepare images for analysis.");
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSend();
        }
    };

    return (
        <div className="bg-black/40 backdrop-blur-md rounded-lg border border-white/10 flex flex-col h-full text-xs">
            <div className="p-3 border-b border-white/10 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <Bot className="w-4 h-4 text-purple-400" />
                    <span className="font-bold text-white uppercase tracking-wider">AI Assistant</span>
                </div>
                <button 
                    onClick={handleAnalyze} 
                    disabled={isAnalyzing}
                    className="flex items-center gap-1.5 px-2 py-1 bg-white/10 hover:bg-white/20 rounded text-[10px] text-[var(--accent-color)] border border-white/10 transition-colors disabled:opacity-50"
                    title="Analyze uploaded images to auto-generate commands"
                >
                    {isAnalyzing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />}
                    <span>{isAnalyzing ? 'Thinking...' : 'Analyze Scene'}</span>
                </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2 custom-scrollbar">
                {messages.map(msg => (
                    <div key={msg.id} className={`flex gap-2 ${msg.sender === 'user' ? 'flex-row-reverse' : ''}`}>
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${msg.sender === 'user' ? 'bg-blue-500' : 'bg-purple-600'}`}>
                            {msg.sender === 'user' ? <User size={12} /> : <Bot size={12} />}
                        </div>
                        <div className={`p-2 rounded max-w-[85%] ${msg.sender === 'user' ? 'bg-blue-500/20 text-blue-100' : 'bg-white/10 text-gray-200'}`}>
                            {msg.text}
                        </div>
                    </div>
                ))}
                <div ref={messagesEndRef} />
            </div>

            <div className="p-2 border-t border-white/10 flex gap-2">
                <input 
                    type="text" 
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a command..." 
                    className="flex-1 bg-black/50 border border-white/10 rounded px-3 py-1.5 text-white outline-none focus:border-purple-500 transition-colors"
                />
                <button 
                    onClick={handleSend}
                    className="p-1.5 bg-purple-600 hover:bg-purple-500 rounded text-white transition-colors"
                >
                    <Send size={14} />
                </button>
            </div>
        </div>
    );
};
