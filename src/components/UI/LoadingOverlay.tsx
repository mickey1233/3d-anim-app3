import React from 'react';
import { Html, useProgress } from '@react-three/drei';

export const LoadingOverlay = () => {
  const { progress, active, item } = useProgress();

  if (!active && progress === 100) return null;

  return (
    <Html center zIndexRange={[100, 0]}>
      <div className="flex flex-col items-center justify-center p-6 bg-black/80 rounded-xl backdrop-blur-md border border-white/10 shadow-2xl min-w-[200px]">
        <div className="w-8 h-8 border-4 border-[var(--accent-color)] border-t-transparent rounded-full animate-spin mb-4" />
        <div className="text-xl font-bold font-mono tracking-wider">{progress.toFixed(0)}%</div>
        <div className="text-xs text-[var(--text-secondary)] mt-2 text-center max-w-[200px] truncate">
            {item ? `Loading: ${item}` : 'Processing...'}
        </div>
      </div>
    </Html>
  );
};
