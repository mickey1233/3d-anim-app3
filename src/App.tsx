import React, { useEffect, useRef } from 'react';
import { Sidebar } from './components/Layout/Sidebar';
import { AnimationStudio } from './components/UI/AnimationStudio';
import { PropertyEditor } from './components/UI/PropertyEditor';
import { Scene } from './components/Three/Scene';
import { useAppStore } from './store/useAppStore';
import { Play, Pause, Box } from 'lucide-react';

import { mcpBridge } from './services/MCPBridge';

function App() {
  useEffect(() => {
     mcpBridge.connect();
     // Cleanup optional, but effectively we want persistent connection
  }, []);

  const { 
    isAnimationPlaying, setAnimationPlaying, 
    cadFileName, setCadUrl, 
    parts
  } = useAppStore();
  
  // Note: keyframeProgress and currentImageIndex were pseudo-logic in my previous thought, 
  // currently we calculate index from `isAnimationPlaying` or just state.
  // Actually, standard `Scene` uses `keyframeProgress` calculated internally or passed?
  // Let's check Scene prop usage.
  // Scene doesn't take props, it uses store.
  // So we just need the properties used in App.tsx render.
  
  const cadInputRef = useRef<HTMLInputElement>(null);

  // Handle CAD Upload
  const handleCadUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const url = URL.createObjectURL(file);
      setCadUrl(url, file.name);
    }
  };

  return (
    <div className="w-full h-screen bg-[var(--bg-color)] overflow-hidden flex flex-row relative">
      
      {/* Left Sidebar: Import */}
      <Sidebar title="Assets & Import" side="left">
        {/* CAD Import Section */}
        <div className="mb-6">
          <h3 className="text-xs uppercase text-[var(--text-secondary)] font-bold mb-2 tracking-wider">3D Model</h3>
          <div 
            onClick={() => cadInputRef.current?.click()}
            className="
              border border-[rgba(255,255,255,0.1)] rounded p-4 
              flex items-center gap-3 cursor-pointer 
              hover:bg-[rgba(255,255,255,0.05)] transition-colors
              group
            "
          >
            <Box className="w-5 h-5 text-[var(--accent-color)] group-hover:scale-110 transition-transform" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate" title={cadFileName || 'Import CAD'}>
                 {cadFileName || 'Import CAD'}
              </div>
              <div className="text-[10px] text-[var(--text-secondary)]">
                 {cadFileName ? 'Click to replace' : '.glb, .gltf supported'}
              </div>
            </div>
            <input 
              type="file" 
              ref={cadInputRef} 
              className="hidden" 
              accept=".glb,.gltf"
              onChange={handleCadUpload}
            />
          </div>
        </div>

        {/* Animation Control */}
        <AnimationStudio />

        {/* Scene Graph */}
      </Sidebar>

      {/* Center: Canvas */}
      <div className="flex-1 relative" style={{ pointerEvents: 'auto' }}>
        <Scene />
        
        {/* Floating Animation Control */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto">
          <button
            onClick={() => setAnimationPlaying(!isAnimationPlaying)}
            className={`
              flex items-center gap-2 px-8 py-3 rounded-full 
              font-bold text-sm tracking-wide shadow-lg backdrop-blur-md
              transition-all transform hover:scale-105 active:scale-95
              ${isAnimationPlaying 
                ? 'bg-[var(--accent-color)] text-white shadow-[0_0_20px_rgba(59,130,246,0.5)]' 
                : 'bg-white text-black hover:bg-gray-200'
              }
            `}
          >
            {isAnimationPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {isAnimationPlaying ? 'STOP ANIMATION' : 'RUN ANIMATION'}
          </button>
        </div>
      </div>

      {/* Right Sidebar: Properties */}
      <Sidebar title="Properties" side="right">
        <PropertyEditor />
      </Sidebar>

    </div>
  );
}

export default App;
