import React from 'react';

export function ScrubbableNumber({
  value,
  step = 0.01,
  precision = 4,
  disabled,
  onChange,
  className,
  testId,
}: {
  value: number | null;
  step?: number;
  precision?: number;
  disabled?: boolean;
  onChange?: (value: number) => void;
  className?: string;
  testId?: string;
}) {
  const startRef = React.useRef<{ x: number; value: number; steps: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || value === null) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startRef.current = { x: e.clientX, value, steps: 0 };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start || disabled || value === null || !onChange) return;
    const deltaX = e.clientX - start.x;
    const stepCount = Math.trunc(deltaX);
    if (stepCount !== start.steps) {
      start.steps = stepCount;
      onChange(start.value + stepCount * step);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (startRef.current) {
      startRef.current = null;
    }
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  const display = value === null ? '—' : value.toFixed(precision);

  return (
    <div
      className={`bg-black/40 border border-white/10 rounded px-2 py-1 select-none cursor-ew-resize ${
        disabled ? 'opacity-50 cursor-not-allowed' : ''
      } ${className || ''}`}
      data-testid={testId}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {display}
    </div>
  );
}
