import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { DesignSelection } from "./DesignFrameView";

export function DesignInspector({
  selection,
  stale,
  busy,
  onApply,
  onClose,
}: {
  selection: DesignSelection;
  stale: boolean;
  busy: boolean;
  onApply: (styles: Record<string, string | null>) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  return (
    <aside
      aria-label="Element inspector"
      className="design-inspector w-56 shrink-0 overflow-y-auto border-l bg-background p-3 text-xs"
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold">{selection.element.tag}</h3>
        <button aria-label="Close inspector" onClick={onClose}>
          ×
        </button>
      </div>
      <p className="mb-3 break-all text-muted-foreground">{selection.element.selector}</p>
      {stale && (
        <p role="status" className="mb-3 text-amber-500">
          This frame changed. Select the element again before editing.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onApply(
            Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value || null])),
          );
        }}
      >
        {Object.entries(selection.element.styles).map(([key, value]) => (
          <label key={key} className="mb-2 grid gap-1">
            <span className="text-muted-foreground">{key}</span>
            <input
              className="w-full rounded border bg-background px-2 py-1"
              value={draft[key] ?? value}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [key]: event.target.value }))
              }
            />
          </label>
        ))}
        <Button
          size="sm"
          className="my-2 w-full"
          disabled={stale || busy || !Object.keys(draft).length}
          type="submit"
        >
          Apply styles
        </Button>
      </form>
      <details className="mt-3">
        <summary>Attributes</summary>
        <dl className="mt-2 space-y-2 break-all">
          {Object.entries(selection.element.attributes).map(([name, value]) => (
            <div key={name}>
              <dt className="font-medium">{name}</dt>
              <dd className="text-muted-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </aside>
  );
}
