import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  clampRedaction,
  MAX_REDACTION_REGIONS,
  type RedactionRect,
} from "@/lib/web-annotations/redaction";

/**
 * Drag (or add and move with the keyboard) opaque rectangles over the pending
 * capture. Nothing leaves the trusted UI until Apply; the spool then keeps
 * only the redacted copy.
 */
export function RedactionEditor({
  imageDataUrl,
  imageSize,
  onApply,
  onCancel,
  busy,
}: {
  imageDataUrl: string;
  imageSize: { width: number; height: number };
  onApply: (regions: RedactionRect[]) => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [regions, setRegions] = useState<RedactionRect[]>([]);
  const [draft, setDraft] = useState<RedactionRect | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const full = regions.length >= MAX_REDACTION_REGIONS;

  const toImage = (event: PointerEvent<HTMLDivElement>) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - rect.left) / rect.width) * imageSize.width,
      y: ((event.clientY - rect.top) / rect.height) * imageSize.height,
    };
  };

  const add = (rect: RedactionRect) => {
    const clamped = clampRedaction(rect, imageSize);
    if (!clamped || full) return;
    setRegions((current) => [...current, clamped].slice(0, MAX_REDACTION_REGIONS));
  };

  const moveRegion = (index: number, event: KeyboardEvent<HTMLDivElement>) => {
    const step = Math.max(4, Math.round(Math.min(imageSize.width, imageSize.height) / 50));
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      setRegions((current) => current.filter((_, position) => position !== index));
      return;
    }
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    setRegions((current) =>
      current.map((region, position) => {
        if (position !== index) return region;
        const next = event.shiftKey
          ? { ...region, width: region.width + move[0], height: region.height + move[1] }
          : { ...region, x: region.x + move[0], y: region.y + move[1] };
        return clampRedaction(next, imageSize) ?? region;
      }),
    );
  };

  const percent = (rect: RedactionRect) => ({
    left: `${(rect.x / imageSize.width) * 100}%`,
    top: `${(rect.y / imageSize.height) * 100}%`,
    width: `${(rect.width / imageSize.width) * 100}%`,
    height: `${(rect.height / imageSize.height) * 100}%`,
  });

  return (
    <div className="space-y-2" data-redaction-editor>
      <p className="text-[11px] text-muted-foreground">
        Drag over anything that should not be sent. Or add a box, then move it with the arrow keys
        (Shift+arrows resizes, Delete removes). Applying replaces the local image; the unredacted
        version cannot be restored.
      </p>
      <div
        ref={surfaceRef}
        className="relative w-full cursor-crosshair touch-none select-none overflow-hidden rounded border border-border/70"
        onPointerDown={(event) => {
          if (full) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const point = toImage(event);
          startRef.current = point;
          setDraft({ ...point, width: 0, height: 0 });
        }}
        onPointerMove={(event) => {
          const start = startRef.current;
          if (!start) return;
          const point = toImage(event);
          setDraft({ x: start.x, y: start.y, width: point.x - start.x, height: point.y - start.y });
        }}
        onPointerUp={() => {
          if (draft) add(draft);
          startRef.current = null;
          setDraft(null);
        }}
      >
        <img
          src={imageDataUrl}
          alt="Capture being redacted"
          className="block w-full"
          draggable={false}
        />
        {regions.map((region, index) => (
          <div
            key={`${index}-${region.x}-${region.y}`}
            role="img"
            tabIndex={0}
            aria-label={`Redaction ${index + 1}`}
            onKeyDown={(event) => moveRegion(index, event)}
            className="absolute bg-black outline-none ring-offset-1 focus-visible:ring-2 focus-visible:ring-primary"
            style={percent(region)}
          />
        ))}
        {draft && (
          <div
            className="pointer-events-none absolute border border-primary bg-black/70"
            style={percent(clampRedaction(draft, imageSize) ?? { x: 0, y: 0, width: 0, height: 0 })}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          disabled={full}
          onClick={() =>
            add({
              x: imageSize.width * 0.375,
              y: imageSize.height * 0.375,
              width: imageSize.width / 4,
              height: imageSize.height / 4,
            })
          }
        >
          <Plus className="h-3 w-3" aria-hidden />
          Add box
        </Button>
        {regions.length > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => setRegions((current) => current.slice(0, -1))}
          >
            <X className="h-3 w-3" aria-hidden />
            Remove last box
          </Button>
        )}
        <span className="text-[11px] text-muted-foreground">
          {regions.length}/{MAX_REDACTION_REGIONS} boxes
        </span>
        <div className="ml-auto flex gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={regions.length === 0 || busy}
            onClick={() => onApply(regions)}
          >
            Apply redaction
          </Button>
        </div>
      </div>
    </div>
  );
}
