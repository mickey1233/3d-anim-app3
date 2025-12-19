import React, { useEffect, useRef } from 'react';
import { Sidebar } from './components/Layout/Sidebar';
import { ImageUploader } from './components/UI/ImageUploader';
import { PropertyEditor } from './components/UI/PropertyEditor';
import { Scene } from './components/Three/Scene';
import { useAppStore } from './store/useAppStore';
import { Play, Pause, Box, Upload } from 'lucide-react';

function App() {
  const { 
    setCadUrl, 
    cadFileName,
    isAnimationPlaying, 
    setAnimationPlaying, 
    images, 
    parts
  } = useAppStore();
  
  const cadInputRef = useRef<HTMLInputElement>(null);

  // Handle CAD Upload
  const handleCadUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const url = URL.createObjectURL(file);
      setCadUrl(url, file.name);
    }
  };

  // AI Agent Simulation: Analyze Images -> Detect Parts -> Assign Coordinates
  useEffect(() => {
    const partIds = Object.keys(parts);
    if (partIds.length === 0) return;

    images.forEach(img => {
      // If this image hasn't been "analyzed" (no positions set), run analysis
      if (Object.keys(img.partPositions).length === 0) {
        
        console.log(`AI Agent: Analyzing image ${img.name}...`);
        
        // Simulate detecting ALL parts in this image and finding their coordinates
        partIds.forEach(partId => {
           // Generate a random position "detected" from the image
           // In reality, this would be data from the backend.
           // We'll use a deterministic-ish offset based on the image index? 
           // Or just random for now. 
           // Let's make them relatively close to the original part position 
           // but with some offset to simulate "movement" between images.
           
           const originalPos = parts[partId].position;
           const randomOffset = [
              (Math.random() - 0.5) * 2, // +/- 1 unit
              (Math.random() - 0.5) * 2,
              (Math.random() - 0.5) * 2
           ] as [number, number, number];
           
           // Store the "Observed Logic": Part P in Image I is at Position X
           // For the first image, maybe we ideally want it to match current pos?
           // User said: "First image is initial position". 
           // So if images.length === 1 (this is first), maybe we shouldn't change it?
           // But the "AI" detects where it IS. The user might want to drag it to fix it.
           // Let's just assign random.
           
           useAppStore.getState().updateKeyframePosition(
             img.id, 
             partId, 
             // [originalPos[0] + randomOffset[0], originalPos[1] + randomOffset[1], originalPos[2] + randomOffset[2]]
             // Let's just start with 0,0,0 relative or random so user MUST drag them?
             // Or better: Start at Part's CURRENT position so it's subtle?
             // Let's start at Current Position + Random
             [
               originalPos[0] + randomOffset[0],
               originalPos[1] + randomOffset[1],
               originalPos[2] + randomOffset[2]
             ]
           );
        });
      }
    });
  }, [images.length, Object.keys(parts).length]); // Only run when count changes to avoid loops

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

        {/* Image Import Section */}
        <ImageUploader />
      </Sidebar>

      {/* Center: Canvas */}
      <div className="flex-1 relative">
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
