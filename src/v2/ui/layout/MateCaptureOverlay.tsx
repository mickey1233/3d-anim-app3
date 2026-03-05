import React from 'react';
import { useV2Store } from '../../store/store';

export function MateCaptureOverlay() {
  const overlay = useV2Store((s) => s.mateCaptureOverlay);
  const hideMateCaptureOverlay = useV2Store((s) => s.hideMateCaptureOverlay);

  React.useEffect(() => {
    if (!overlay.visible) return () => {};
    const delayMs = Math.max(0, overlay.expiresAt - Date.now());
    const timer = window.setTimeout(() => hideMateCaptureOverlay(), delayMs);
    return () => window.clearTimeout(timer);
  }, [overlay.visible, overlay.expiresAt, overlay.nonce, hideMateCaptureOverlay]);

  if (!overlay.visible || overlay.images.length === 0) return null;

  return (
    <div className="absolute inset-x-3 top-3 z-20 pointer-events-none" data-testid="mate-capture-overlay">
      <div className="ml-auto w-full max-w-[720px] rounded-lg border border-white/25 bg-black/60 backdrop-blur-sm p-2">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-2">
          Mate Multi-View Capture (auto-hide in 5s)
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
          {overlay.images.map((item) => (
            <div
              key={item.id}
              className="rounded border border-white/15 bg-black/30 overflow-hidden"
              data-testid="mate-capture-item"
            >
              <div className="aspect-[4/3] bg-black/40">
                <img src={item.dataUrl} alt={item.label || item.name} className="w-full h-full object-cover" />
              </div>
              <div className="px-2 py-1 text-[10px] text-[var(--text-secondary)] truncate">{item.label || item.name}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
