import React, { useEffect, useRef } from 'react';
import { Sidebar } from './components/Layout/Sidebar';
import { AnimationStudio } from './components/UI/AnimationStudio';
import { PropertyEditor } from './components/UI/PropertyEditor';
import { ChatInterface } from './components/UI/ChatInterface';
import { PanelSection } from './components/UI/PanelSection';
import { PartsList } from './components/UI/PartsList';
import { Scene } from './components/Three/Scene';
import { InteractionModeToggle } from './components/UI/InteractionModeToggle';
import { useAppStore } from './store/useAppStore';
import { Play, Pause, Box, Layers, MousePointer2, Bot, Clapperboard } from 'lucide-react';

import { mcpBridge } from './services/MCPBridge';
import { registerMcpHandlers } from './services/mcpHandlers';

function App() {
  const [windowHeight, setWindowHeight] = React.useState<number>(window.innerHeight);

  useEffect(() => {
    const onResize = () => setWindowHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isShort = windowHeight < 800;

  useEffect(() => {
     mcpBridge.connect();
     
     // Automatic State Sync for MCP Side
     const interval = setInterval(() => {
         // We can pull state directly from store instance
         // But need to cast to any to access the helper we just added if TS complains (it shouldn't if typed)
         // Actually, let's just use the store hook logic or direct access
         const state = useAppStore.getState() as any;
         if (state.getStateExport) {
             const exportData = state.getStateExport();
             if (exportData.parts.length > 0) {
                 mcpBridge.sendStateUpdate(exportData.parts, exportData.camera);
             }
         }
     }, 1000); // Sync every second

     // Register all MCP tool handlers
     registerMcpHandlers(mcpBridge);

     return () => clearInterval(interval);
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

  // Handle Asset Export
  const handleExportAsset = async () => {
      // Need cadUrl and mcpBridge
      const { cadUrl, cadFileName } = useAppStore.getState();
      if (!cadUrl || !cadFileName) {
          alert("No CAD file loaded to export!");
          return;
      }
      
      try {
          // 1. Fetch Blob from ObjectURL
          const res = await fetch(cadUrl);
          const blob = await res.blob();
          
          // 2. Convert to Base64
          const reader = new FileReader();
          reader.onloadend = () => {
              const base64data = (reader.result as string).split(',')[1];
              console.log("[App] Exporting Asset:", cadFileName);
              console.log("[App] Payload Size:", base64data.length);
              
              // 3. Send to MCP
              mcpBridge.saveAsset(
                  cadFileName, 
                  base64data, 
                  "" // Empty YAML as requested
              );
              alert("Export request sent to Backend!");
          };
          reader.readAsDataURL(blob);
          
      } catch (e) {
          console.error("Export failed:", e);
          alert("Failed to prepare export.");
      }
  };

  return (
    <div className="w-full h-screen bg-[var(--bg-color)] overflow-hidden flex flex-row relative">
      
      {/* Left Sidebar: Import */}
      <Sidebar title="Model & Parts" side="left">
        <PanelSection
          title="Model"
          icon={Box}
          defaultOpen
          rightSlot={
            <span className="text-[10px] text-[var(--text-secondary)] font-mono">
              {cadFileName ? 'Loaded' : 'Empty'}
            </span>
          }
        >
          <div className="flex flex-col gap-2">
            <div
              onClick={() => cadInputRef.current?.click()}
              className="
                border border-[rgba(255,255,255,0.1)] rounded p-3
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
                  {cadFileName ? 'Click to replace' : '.glb, .gltf, .usd, .usdz'}
                </div>
              </div>
              <input
                type="file"
                ref={cadInputRef}
                className="hidden"
                accept=".glb,.gltf,.usd,.usdz"
                onChange={handleCadUpload}
              />
            </div>

            {cadFileName ? (
              <button
                type="button"
                onClick={handleExportAsset}
                className="
                  mt-1 w-full border border-[rgba(255,255,255,0.1)] rounded px-3 py-2
                  hover:bg-[rgba(255,255,255,0.05)] transition-colors
                  text-xs font-bold text-[var(--accent-color)]
                "
              >
                EXPORT ASSET (USD + YODA MANIFEST)
              </button>
            ) : null}
          </div>
        </PanelSection>

        <PanelSection
          title="Parts"
          icon={Layers}
          defaultOpen
          rightSlot={
            <span className="text-[10px] text-[var(--text-secondary)] font-mono">
              {Object.keys(parts).length}
            </span>
          }
        >
          <PartsList />
        </PanelSection>
      </Sidebar>

      {/* Center: Canvas */}
      <div className="flex-1 relative" style={{ pointerEvents: 'auto' }}>
        <Scene />
        <InteractionModeToggle />
        
        {/* Floating Animation Control */}
        <div 
          className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
        >
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
            {isAnimationPlaying ? 'STOP ANIMATION' : 'PLAY ANIMATION'}
          </button>
        </div>
      </div>

      {/* Right Sidebar: Properties & AI */}
      <Sidebar title="Workspace" side="right" scrollable>
        <PanelSection title="Selection" icon={MousePointer2} defaultOpen contentClassName="p-2 sm:p-3">
          <PropertyEditor />
        </PanelSection>

        <PanelSection
          title="Markers & Animation"
          icon={Clapperboard}
          defaultOpen={!isShort}
          contentClassName="p-2 sm:p-3"
        >
          <AnimationStudio />
        </PanelSection>

        <PanelSection
          title="AI Assistant"
          icon={Bot}
          defaultOpen={!isShort}
          contentClassName="p-2 sm:p-3"
        >
          <div className="min-h-[200px] h-[28vh] max-h-[360px]">
            <ChatInterface />
          </div>
        </PanelSection>
      </Sidebar>

    </div>
  );
}

export default App;
