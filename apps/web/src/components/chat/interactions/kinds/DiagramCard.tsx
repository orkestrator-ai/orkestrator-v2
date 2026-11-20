import type { DiagramSpec } from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import { MermaidBlock } from "../../rich/MermaidBlock";
import { ActionBar, RefChip, textareaClass, type KindProps } from "../shared";

interface DiagramDraft {
  objectIds: string[];
  question?: string;
}

/**
 * Feature 11: diagrams with object actions. The picture is the sanitized,
 * read-only Mermaid render; actions come only from the backend-validated
 * object manifest, selected in an accessible list, so no generated SVG link or
 * click directive can reach an application action.
 */
export function DiagramCard({
  view,
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<DiagramSpec>) {
  const value = (draft as DiagramDraft | undefined) ?? { objectIds: [] };
  const toggle = (id: string) =>
    setDraft({
      ...value,
      objectIds: value.objectIds.includes(id)
        ? value.objectIds.filter((x) => x !== id)
        : [...value.objectIds, id],
    });
  const nodes = spec.objects.filter((o) => o.type === "node");
  const edges = spec.objects.filter((o) => o.type === "edge");
  const label = (id?: string) => spec.objects.find((o) => o.id === id)?.label ?? id;
  return (
    <div className="flex flex-col gap-2">
      {spec.mermaid ? (
        <MermaidBlock
          source={spec.mermaid}
          closed
          blockKey={`interaction:${view.request.interactionId}`}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        Objects are agent-supplied architecture (inferred) unless marked observed. Select them below
        to ask about them.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {(
          [
            ["Components", nodes],
            ["Connections", edges],
          ] as const
        ).map(([title, list]) =>
          list.length ? (
            <fieldset
              key={title}
              className="flex flex-col gap-1 rounded border border-border/60 p-2"
              disabled={disabled}
            >
              <legend className="px-1 text-xs font-medium">{title}</legend>
              {list.map((object) => (
                <label
                  key={object.id}
                  className={cn(
                    "flex items-start gap-2 rounded px-1 py-0.5 text-xs",
                    value.objectIds.includes(object.id) && "bg-primary/10",
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 accent-primary"
                    checked={value.objectIds.includes(object.id)}
                    onChange={() => toggle(object.id)}
                  />
                  <span className="min-w-0">
                    <span className="font-medium">{object.label}</span>
                    {object.type === "edge" ? (
                      <span className="text-muted-foreground">
                        {" "}
                        {label(object.from)} → {label(object.to)}
                      </span>
                    ) : null}
                    <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                      {object.provenance}
                    </span>
                    {object.description ? (
                      <span className="block text-muted-foreground">{object.description}</span>
                    ) : null}
                    {object.sourceRefs.length ? (
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {object.sourceRefs.map((ref, i) => (
                          <RefChip key={i} reference={ref} />
                        ))}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null,
        )}
      </div>
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Question"
            placeholder="Your question (optional)"
            value={value.question ?? ""}
            onChange={(e) => setDraft({ ...value, question: e.target.value })}
          />
          <ActionBar
            actions={actions}
            disabled={disabled}
            primaryDisabledReason={
              value.objectIds.length ? null : "Select a component or connection."
            }
            onAction={(a) =>
              act(a.id, {
                objectIds: value.objectIds,
                ...(value.question?.trim() ? { question: value.question.trim() } : {}),
              })
            }
          />
        </>
      ) : null}
    </div>
  );
}
