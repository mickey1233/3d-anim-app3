import React, { useEffect, useState, useRef } from 'react';
import { Send, Bot, User } from 'lucide-react';
import { mcpBridge } from '../../services/MCPBridge';

interface ChatMessage {
    id: string;
    sender: 'user' | 'bot';
    text: string;
    timestamp: number;
}

export const ChatInterface: React.FC = () => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [inputValue, setInputValue] = useState('');
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        // Register handler for server responses (AI replies)
        mcpBridge.registerHandler('chat_response', async (_cmd, args: { text: string }) => {
            addMessage('bot', args.text);
            return { success: true };
        });

        // Initial welcome message
        if (messages.length === 0) {
            addMessage('bot', 'Ready. Type a command like "move Part1 bottom to Part2 top".');
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

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleSend();
        }
    };

    return (
        <div className="bg-black/40 backdrop-blur-md rounded-lg border border-white/10 flex flex-col h-[300px] text-xs">
            <div className="p-3 border-b border-white/10 flex items-center gap-2">
                <Bot className="w-4 h-4 text-purple-400" />
                <span className="font-bold text-white uppercase tracking-wider">AI Assistant</span>
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
