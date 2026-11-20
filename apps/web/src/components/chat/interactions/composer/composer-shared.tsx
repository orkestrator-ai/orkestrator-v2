import { useState, type ReactNode } from "react";
import type { NormalizedRect } from "@orkestrator/protocol/rich-interactions";
import { newIdempotencyKey } from "@/lib/chat/rich-interactions";

/** A new tray item id (stable for the item's life in the tray). */
export function newContextItemId(): string {
  return `ctx-${newIdempotencyKey().slice(3, 15)}`;
}

/**
 * Draws a normalized region on an image (feature 6 image anchors). Keyboard
 * users can type the region as percentages; the region is in the original
 * image's coordinate space, so zoom never changes what it names.
 */
export function ImageRegionPicker({ children, initial, onChange }: { children: ReactNode; initial?: NormalizedRect; onChange: (rect: NormalizedRect | null) => void }) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<NormalizedRect | null>(initial ?? null);
  const point = (event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)), y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height)) };
  };
  const commit = (next: NormalizedRect | null) => {
    setRect(next);
    onChange(next && next.width > 0.005 && next.height > 0.005 ? next : null);
  };
  return (
    <div className="flex flex-col gap-1">
      <div
        className="relative inline-block cursor-crosshair select-none"
        onPointerDown={(e) => setStart(point(e))}
        onPointerMove={(e) => {
          if (!start) return;
          const p = point(e);
          setRect({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) });
        }}
        onPointerUp={() => {
          setStart(null);
          commit(rect);
        }}
      >
        <div className="pointer-events-none">{children}</div>
        {rect ? <div className="pointer-events-none absolute border-2 border-primary bg-primary/10" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} /> : null}
      </div>
      <div className="flex flex-wrap gap-1 text-[11px]" aria-label="Region as percentages">
        {(["x", "y", "width", "height"] as const).map((field) => (
          <label key={field} className="flex items-center gap-0.5">
            {field}
            <input
              type="number"
              min={0}
              max={100}
              className="w-14 rounded border border-border/60 bg-transparent px-1"
              value={rect ? Math.round(rect[field] * 100) : ""}
              onChange={(e) => commit({ ...(rect ?? { x: 0, y: 0, width: 0.1, height: 0.1 }), [field]: Math.min(1, Math.max(0, Number(e.target.value) / 100)) })}
            />
            %
          </label>
        ))}
      </div>
    </div>
  );
}
