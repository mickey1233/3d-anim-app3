import React, { useRef, useState } from 'react';
import { Box } from 'lucide-react';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

const MCP_BASE = 'http://localhost:3011';

export function ModelPanelV2() {
  const cadFileName = useV2Store((s) => s.cadFileName);
  const inputRef = useRef<HTMLInputElement>(null);
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [showPathInput, setShowPathInput] = useState(false);
  const [localPath, setLocalPath] = useState('');

  const convertViaPath = async (filePath: string) => {
    setConverting(true);
    setConvertError(null);
    try {
      const res = await fetch(`${MCP_BASE}/convert-usd-path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      const json = await res.json() as { url?: string; fileName?: string; error?: string };
      if (!res.ok || json.error) {
        setConvertError(json.error || 'Conversion failed');
        return;
      }
      void callMcpTool('parts.set_cad_url', { url: json.url!, fileName: json.fileName! });
      setShowPathInput(false);
      setLocalPath('');
    } catch (err: any) {
      setConvertError(err?.message || 'Failed to connect to MCP server');
    } finally {
      setConverting(false);
    }
  };

  const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setConvertError(null);
    const ext = file.name.toLowerCase().split('.').pop();

    if (ext === 'usdz') {
      const url = URL.createObjectURL(file);
      void callMcpTool('parts.set_cad_url', { url, fileName: file.name });
    } else if (ext === 'usd' || ext === 'usda') {
      // Try to auto-fill from DEFAULT_USD_PATH if basename matches
      try {
        const res = await fetch(`${MCP_BASE}/default-usd-path`);
        const { path: defaultPath } = await res.json() as { path: string };
        const defaultBasename = defaultPath.split('/').pop() ?? '';
        if (defaultPath && defaultBasename === file.name) {
          // Auto-convert without showing the input
          await convertViaPath(defaultPath);
          e.target.value = '';
          return;
        }
        // Different file — show path input pre-filled with directory hint
        const defaultDir = defaultPath ? defaultPath.substring(0, defaultPath.lastIndexOf('/') + 1) : '';
        setLocalPath(defaultDir + file.name);
      } catch {
        setLocalPath('');
      }
      setShowPathInput(true);
    } else {
      const url = URL.createObjectURL(file);
      void callMcpTool('parts.set_cad_url', { url, fileName: file.name });
    }

    e.target.value = '';
  };

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => { setShowPathInput(false); inputRef.current?.click(); }}
        disabled={converting}
        className="border border-white/10 rounded p-3 flex items-center gap-3 hover:bg-white/5 transition-colors disabled:opacity-50"
      >
        <Box className="w-5 h-5 text-[var(--accent-color)]" />
        <div className="flex-1 min-w-0 text-left">
          <div className="text-xs font-medium truncate" title={cadFileName || 'Import CAD'}>
            {converting ? 'Converting USD…' : (cadFileName || 'Import CAD')}
          </div>
          <div className="text-[10px] text-[var(--text-secondary)]">
            {cadFileName ? 'Click to replace' : '.glb, .gltf, .usd, .usda, .usdz'}
          </div>
        </div>
      </button>

      {showPathInput && (
        <div className="flex flex-col gap-1 border border-white/10 rounded p-2 bg-black/30">
          <div className="text-[10px] text-[var(--text-secondary)]">
            .usd/.usda 需要旁邊的 textures/ 資料夾，請確認路徑：
          </div>
          <input
            type="text"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/absolute/path/to/spark_.usd"
            className="text-xs bg-black/40 border border-white/10 rounded px-2 py-1 text-white placeholder:text-white/30 outline-none focus:border-white/30"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && localPath.trim()) void convertViaPath(localPath.trim());
              if (e.key === 'Escape') setShowPathInput(false);
            }}
          />
          <div className="flex gap-1">
            <button
              type="button"
              disabled={!localPath.trim() || converting}
              onClick={() => void convertViaPath(localPath.trim())}
              className="flex-1 text-[10px] bg-[var(--accent-color)]/20 hover:bg-[var(--accent-color)]/40 border border-[var(--accent-color)]/40 rounded px-2 py-1 disabled:opacity-40"
            >
              {converting ? 'Converting…' : 'Convert & Load'}
            </button>
            <button
              type="button"
              onClick={() => setShowPathInput(false)}
              className="text-[10px] border border-white/10 rounded px-2 py-1 hover:bg-white/5"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {convertError && (
        <div className="text-[10px] text-red-400 px-1 break-all">{convertError}</div>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".glb,.gltf,.usd,.usda,.usdz"
        onChange={onFileChange}
      />
    </div>
  );
}
