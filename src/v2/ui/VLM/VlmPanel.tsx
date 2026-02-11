import React from 'react';
import { ArrowDown, ArrowUp, Trash2, Upload, Sparkles } from 'lucide-react';
import { useV2Store } from '../../store/store';
import { callMcpTool } from '../../network/mcpToolsClient';

const fileToBase64 = (file: File) =>
  new Promise<{ name: string; data: string; mime: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve({ name: file.name, data: base64, mime: file.type || 'image/png' });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

export function VlmPanel() {
  const images = useV2Store((s) => s.vlm.images);
  const analyzing = useV2Store((s) => s.vlm.analyzing);
  const result = useV2Store((s) => s.vlm.result);

  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleAnalyze = async () => {
    if (images.length === 0) return;
    await callMcpTool('vlm.analyze', {});
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">VLM (multi-image)</div>

      <button
        type="button"
        className="border border-dashed border-white/20 rounded p-3 flex items-center gap-2 text-xs hover:bg-white/5"
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="w-4 h-4 text-[var(--accent-color)]" />
        Upload images
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={async (e) => {
          if (!e.target.files) return;
          const files = Array.from(e.target.files);
          if (files.length === 0) return;
          const payload = await Promise.all(files.map((file) => fileToBase64(file)));
          void callMcpTool('vlm.add_images', {
            images: payload.map((img) => ({ name: img.name, mime: img.mime, dataBase64: img.data })),
          });
        }}
      />

      <div className="flex flex-col gap-2 max-h-[28vh] overflow-y-auto custom-scrollbar pr-1">
        {images.map((img, idx) => (
          <div key={img.id} className="flex items-center gap-2 bg-black/30 border border-white/10 rounded p-2">
            <img src={img.url} className="w-10 h-10 object-cover rounded" />
            <div className="flex-1 min-w-0">
              <div className="text-xs truncate">
                {idx + 1}. {img.name}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  void callMcpTool('vlm.move_image', { imageId: img.id, delta: -1 });
                }}
                className="p-1 hover:bg-white/10 rounded"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  void callMcpTool('vlm.move_image', { imageId: img.id, delta: 1 });
                }}
                className="p-1 hover:bg-white/10 rounded"
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  void callMcpTool('vlm.remove_image', { imageId: img.id });
                }}
                className="p-1 hover:bg-white/10 rounded text-red-400"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="mt-1 py-2 rounded bg-[var(--accent-color)] text-xs font-bold flex items-center justify-center gap-2 disabled:opacity-40"
        disabled={analyzing || images.length === 0}
        onClick={handleAnalyze}
      >
        <Sparkles className="w-3.5 h-3.5" />
        {analyzing ? 'Analyzing...' : 'Analyze'}
      </button>

      {result ? (
        <div className="text-[10px] text-[var(--text-secondary)]">
          Result: {result.steps?.length || 0} steps / {result.objects?.length || 0} objects
        </div>
      ) : null}
    </div>
  );
}
