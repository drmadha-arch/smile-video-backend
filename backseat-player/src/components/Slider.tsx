import { useRef, useState } from 'react';

interface Props {
  /** 0..1 */
  value: number;
  /** 0..1, optional secondary fill (buffered). */
  secondary?: number;
  onChange?: (v: number) => void;
  /** Called once on release (use for seeking). */
  onCommit?: (v: number) => void;
  onDragChange?: (dragging: boolean, v: number) => void;
  label: string;
  className?: string;
}

/**
 * Big-hit-area slider built on pointer events. Native range inputs are fiddly
 * with fingers on a moving car screen; this one has a 56px tall touch target.
 */
export function Slider({ value, secondary, onChange, onCommit, onDragChange, label, className = '' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const posToValue = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };

  const shown = drag ?? value;

  return (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(shown * 100)}
      className={`relative h-14 cursor-pointer touch-none select-none ${className}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const v = posToValue(e.clientX);
        setDrag(v);
        onChange?.(v);
        onDragChange?.(true, v);
      }}
      onPointerMove={(e) => {
        if (drag === null) return;
        const v = posToValue(e.clientX);
        setDrag(v);
        onChange?.(v);
        onDragChange?.(true, v);
      }}
      onPointerUp={(e) => {
        if (drag === null) return;
        const v = posToValue(e.clientX);
        setDrag(null);
        onCommit?.(v);
        onDragChange?.(false, v);
      }}
      onPointerCancel={() => {
        setDrag(null);
        onDragChange?.(false, value);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={`absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-full bg-white/20 transition-[height] ${
          drag !== null ? 'h-3.5' : 'h-2.5'
        }`}
      >
        {secondary !== undefined && (
          <div
            className="absolute inset-y-0 rounded-full bg-white/35"
            style={{ left: `${value * 100}%`, width: `${Math.max(0, Math.min(1, secondary) - value) * 100}%` }}
          />
        )}
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${shown * 100}%` }} />
      </div>
      <div
        className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-lg shadow-black/50 transition-[width,height] ${
          drag !== null ? 'h-8 w-8' : 'h-6 w-6'
        }`}
        style={{ left: `${shown * 100}%` }}
      />
    </div>
  );
}
