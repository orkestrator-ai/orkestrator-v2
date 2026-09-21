import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DesignStyleField } from "./DesignStyleField";
import { inspectorSections } from "./design-inspector-properties";
import type { DesignSelection } from "./DesignFrameView";

const groupedProperties = new Set(
  inspectorSections.flatMap((section) => section.properties.map((property) => property.name)),
);

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
  const styles = selection.element.styles;
  const update = (name: string, value: string) =>
    setDraft((current) => {
      const next = { ...current };
      if (value === styles[name]) delete next[name];
      else next[name] = value;
      return next;
    });
  const extraProperties = Object.keys(styles).filter((name) => !groupedProperties.has(name));
  return (
    <aside
      aria-label="Element inspector"
      className="design-inspector flex w-72 shrink-0 flex-col overflow-hidden border-l border-divider bg-background text-xs"
    >
      <div className="border-b border-divider px-3 py-2">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{selection.element.tag}</h3>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <X className="size-3" />
          </Button>
        </div>
        <p
          className="mt-1 truncate text-[11px] text-muted-foreground"
          title={selection.element.selector}
        >
          {selection.element.selector}
        </p>
      </div>
      {stale && (
        <p role="status" className="border-b border-divider px-3 py-2 text-amber-500">
          This frame changed. Select the element again before editing.
        </p>
      )}
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (stale || busy) return;
          onApply(
            Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value || null])),
          );
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <fieldset
            disabled={stale || busy}
            className="min-w-0 divide-y divide-divider disabled:opacity-60"
          >
            {inspectorSections.map((section) => {
              const properties = section.properties.filter((property) => property.name in styles);
              if (!properties.length) return null;
              return (
                <section
                  key={section.title}
                  aria-label={section.title}
                  className="space-y-2.5 px-3 py-3"
                >
                  <h4 className="font-semibold">{section.title}</h4>
                  <div className="grid grid-cols-2 gap-x-2 gap-y-2.5">
                    {properties.map((property) => (
                      <DesignStyleField
                        key={property.name}
                        property={property}
                        value={draft[property.name] ?? styles[property.name]!}
                        onChange={(value) => update(property.name, value)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            {extraProperties.length > 0 && (
              <details className="px-3 py-3">
                <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-ring">
                  More styles
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {extraProperties.map((name) => (
                    <DesignStyleField
                      key={name}
                      property={{ name, label: name, wide: true }}
                      value={draft[name] ?? styles[name]!}
                      onChange={(value) => update(name, value)}
                    />
                  ))}
                </div>
              </details>
            )}
          </fieldset>
          <details className="border-t border-divider px-3 py-3">
            <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline-ring">
              Attributes
            </summary>
            <dl className="mt-2 space-y-2 break-all">
              {Object.entries(selection.element.attributes).map(([name, value]) => (
                <div key={name}>
                  <dt className="font-medium">{name}</dt>
                  <dd className="text-muted-foreground">{value}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
        <div className="flex shrink-0 gap-2 border-t border-divider bg-background p-3">
          <Button
            size="sm"
            className="flex-1 text-xs"
            disabled={stale || busy || !Object.keys(draft).length}
            type="submit"
          >
            Apply styles
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-xs"
            disabled={busy || !Object.keys(draft).length}
            type="button"
            onClick={() => setDraft({})}
          >
            Reset
          </Button>
        </div>
      </form>
    </aside>
  );
}
