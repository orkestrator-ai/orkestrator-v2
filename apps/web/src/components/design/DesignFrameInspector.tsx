import { useId, useState } from "react";
import { X } from "lucide-react";
import {
  DESIGN_MAX_COORDINATE,
  DESIGN_MAX_FRAME_SIZE,
  DESIGN_MIN_FRAME_SIZE,
  type DesignFrame,
} from "@orkestrator/protocol/design-canvas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FRAME_PRESETS } from "./design-viewport";

export type FrameField = "name" | "x" | "y" | "width" | "height";
export type FramePatch = Partial<Pick<DesignFrame, FrameField>>;

const FIELDS: Array<{ field: FrameField; label: string }> = [
  { field: "name", label: "Name" },
  { field: "x", label: "X" },
  { field: "y", label: "Y" },
  { field: "width", label: "Width" },
  { field: "height", label: "Height" },
];

const LABELS: Record<FrameField, string> = {
  name: "Rename frame",
  x: "Move frame",
  y: "Move frame",
  width: "Resize frame",
  height: "Resize frame",
};

export const FRAME_NAME_MAX = 120;

/** Parses one field; returns the absolute value or an error message. */
export function parseFrameField(
  field: FrameField,
  raw: string,
): { ok: true; value: string | number } | { ok: false; error: string } {
  if (field === "name") {
    const name = raw.trim();
    if (!name) return { ok: false, error: "Enter a name" };
    if (name.length > FRAME_NAME_MAX)
      return { ok: false, error: `Use at most ${FRAME_NAME_MAX} characters` };
    return { ok: true, value: name };
  }
  const text = raw.trim();
  if (!/^[-+]?\d+$/.test(text)) return { ok: false, error: "Enter a whole number" };
  const value = Number(text);
  if (field === "width" || field === "height") {
    if (value < DESIGN_MIN_FRAME_SIZE || value > DESIGN_MAX_FRAME_SIZE)
      return {
        ok: false,
        error: `Use ${DESIGN_MIN_FRAME_SIZE}–${DESIGN_MAX_FRAME_SIZE} pixels`,
      };
  } else if (Math.abs(value) > DESIGN_MAX_COORDINATE)
    return {
      ok: false,
      error: `Use −${DESIGN_MAX_COORDINATE.toLocaleString("en-US")} to ${DESIGN_MAX_COORDINATE.toLocaleString("en-US")}`,
    };
  return { ok: true, value };
}

function differs(a: DesignFrame, b: DesignFrame) {
  return (
    a.name !== b.name || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height
  );
}

export function DesignFrameInspector({
  frame,
  committed,
  onSubmit,
  onClose,
}: {
  /** Projected frame, including pending previews. */
  frame: DesignFrame;
  /** Authoritative frame. */
  committed: DesignFrame;
  onSubmit: (patch: FramePatch, label: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [drafts, setDrafts] = useState<Partial<Record<FrameField, string>>>({});
  const pending = differs(frame, committed);
  const shown = (field: FrameField) => drafts[field] ?? String(frame[field]);
  const errors: Partial<Record<FrameField, string>> = {};
  for (const { field } of FIELDS) {
    const draft = drafts[field];
    if (draft === undefined) continue;
    const parsed = parseFrameField(field, draft);
    if (!parsed.ok) errors[field] = parsed.error;
  }

  const clear = (fields: FrameField[]) =>
    setDrafts((current) => {
      const next = { ...current };
      for (const field of fields) delete next[field];
      return next;
    });

  /** Valid, changed draft values as an absolute patch. */
  const patchFor = (fields: FrameField[]) => {
    const patch: FramePatch = {};
    const submitted: FrameField[] = [];
    for (const field of fields) {
      const draft = drafts[field];
      if (draft === undefined) continue;
      const parsed = parseFrameField(field, draft);
      if (!parsed.ok) continue;
      submitted.push(field);
      if (parsed.value === frame[field]) continue;
      (patch as Record<FrameField, string | number>)[field] = parsed.value;
    }
    return { patch, submitted };
  };

  const submit = (fields: FrameField[], label?: string) => {
    const { patch, submitted } = patchFor(fields);
    clear(submitted);
    const changed = Object.keys(patch) as FrameField[];
    if (!changed.length) return;
    const labels = new Set(changed.map((field) => LABELS[field]));
    onSubmit(patch, label ?? (labels.size === 1 ? [...labels][0]! : "Edit frame properties"));
  };

  const dirty = (Object.keys(drafts) as FrameField[]).some(
    (field) => drafts[field] !== String(frame[field]),
  );
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <aside
      aria-label="Frame properties"
      className="design-inspector flex w-72 shrink-0 flex-col overflow-hidden border-l border-divider bg-background text-xs"
    >
      <div className="flex items-center gap-1 border-b border-divider px-3 py-2">
        <h3 className="min-w-0 flex-1 truncate font-semibold" title={committed.name}>
          {committed.name}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Close frame properties"
          onClick={onClose}
        >
          <X className="size-3" />
        </Button>
      </div>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (hasErrors) return;
          submit(FIELDS.map(({ field }) => field));
        }}
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
            {FIELDS.map(({ field, label }) => {
              const fieldId = `${id}-${field}`;
              const errorId = `${fieldId}-error`;
              const changed = drafts[field] !== undefined && drafts[field] !== String(frame[field]);
              return (
                <div
                  key={field}
                  className={`min-w-0 space-y-1 ${field === "name" ? "col-span-2" : ""}`}
                >
                  <label htmlFor={fieldId} className="block text-[11px] text-muted-foreground">
                    {label}
                  </label>
                  <Input
                    id={fieldId}
                    type={field === "name" ? "text" : "number"}
                    inputMode={field === "name" ? undefined : "numeric"}
                    step={field === "name" ? undefined : 1}
                    className={`h-7 px-2 text-xs md:text-xs ${changed ? "border-primary ring-1 ring-primary/40" : ""}`}
                    value={shown(field)}
                    maxLength={field === "name" ? FRAME_NAME_MAX + 20 : undefined}
                    aria-invalid={errors[field] ? true : undefined}
                    aria-describedby={errors[field] ? errorId : undefined}
                    data-changed={changed ? "true" : undefined}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [field]: event.target.value }))
                    }
                    onBlur={() => {
                      if (!errors[field]) submit([field]);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && drafts[field] !== undefined) {
                        event.preventDefault();
                        event.stopPropagation();
                        clear([field]);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        if (!errors[field]) submit([field]);
                      }
                    }}
                  />
                  {errors[field] && (
                    <p id={errorId} className="text-[10px] text-destructive">
                      {errors[field]}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <section aria-label="Device presets" className="space-y-1.5">
            <h4 className="font-semibold">Device presets</h4>
            <div className="flex flex-wrap gap-1.5">
              {FRAME_PRESETS.map((preset) => {
                const active = frame.width === preset.width && frame.height === preset.height;
                return (
                  <Button
                    key={preset.label}
                    type="button"
                    size="sm"
                    variant={active ? "secondary" : "outline"}
                    className="h-6 px-2 text-[11px]"
                    aria-pressed={active}
                    title={`${preset.width} × ${preset.height}`}
                    onClick={() => {
                      if (active) return;
                      clear(["width", "height"]);
                      onSubmit(
                        { width: preset.width, height: preset.height },
                        `Resize frame to ${preset.label}`,
                      );
                    }}
                  >
                    {preset.label}
                  </Button>
                );
              })}
            </div>
          </section>
        </div>
        <div className="shrink-0 space-y-2 border-t border-divider bg-background p-3">
          {pending && (
            <p role="status" className="text-muted-foreground">
              Saving frame changes…
            </p>
          )}
          <Button size="sm" className="w-full text-xs" type="submit" disabled={!dirty || hasErrors}>
            Apply
          </Button>
        </div>
      </form>
    </aside>
  );
}
