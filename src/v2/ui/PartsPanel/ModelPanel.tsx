import React, { useRef } from 'react';
import { Box } from 'lucide-react';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

export function ModelPanelV2() {
  const cadFileName = useV2Store((s) => s.cadFileName);
  const inputRef = useRef<HTMLInputElement>(null);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      const url = URL.createObjectURL(file);
      void callMcpTool('parts.set_cad_url', { url, fileName: file.name });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="border border-white/10 rounded p-3 flex items-center gap-3 hover:bg-white/5 transition-colors"
      >
        <Box className="w-5 h-5 text-[var(--accent-color)]" />
        <div className="flex-1 min-w-0 text-left">
          <div className="text-xs font-medium truncate" title={cadFileName || 'Import CAD'}>
            {cadFileName || 'Import CAD'}
          </div>
          <div className="text-[10px] text-[var(--text-secondary)]">
            {cadFileName ? 'Click to replace' : '.glb, .gltf, .usd, .usdz'}
          </div>
        </div>
      </button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".glb,.gltf,.usd,.usdz"
        onChange={onFileChange}
      />
    </div>
  );
}
