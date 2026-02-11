import React from 'react';

export function StatusPill({ label, tone }: { label: string; tone: 'ok' | 'warning' | 'error' }) {
  const toneClass =
    tone === 'ok'
      ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/40'
      : tone === 'warning'
      ? 'bg-yellow-500/20 text-yellow-200 border-yellow-500/40'
      : 'bg-red-500/20 text-red-200 border-red-500/40';

  return (
    <span className={`px-2 py-1 text-[10px] uppercase font-bold border rounded ${toneClass}`}>
      {label}
    </span>
  );
}

