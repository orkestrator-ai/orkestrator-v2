import type { AlternativesSpec } from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import { ActionBar, RefChip, textareaClass, type KindProps } from "../shared";

interface AlternativesDraft {
  alternativeId?: string;
  rationale?: string;
}

/**
 * Feature 17: compare alternatives against the same criteria. Missing
 * measurements are "unknown", never zero; a preference is a decision, and
 * adoption only asks the agent to prepare a reviewable change of the exact
 * commit shown — nothing is merged, staged or discarded here.
 */
export function AlternativesCard({
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<AlternativesSpec>) {
  const value = (draft as AlternativesDraft | undefined) ?? {};
  const selected = spec.alternatives.find((a) => a.id === value.alternativeId);
  const rows = spec.criteria.length ? spec.criteria : [{ id: "_", text: "Measurements" }];
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm">{spec.objective}</p>
      <p className="text-xs text-muted-foreground">
        Baseline{" "}
        {spec.baseline.commit ? <code>{spec.baseline.commit.slice(0, 12)}</code> : "unrecorded"}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-xs">
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium text-muted-foreground">
                Criterion
              </th>
              {spec.alternatives.map((a) => (
                <th
                  key={a.id}
                  scope="col"
                  className={cn(
                    "px-2 py-1 text-left",
                    value.alternativeId === a.id && "bg-primary/10",
                  )}
                >
                  <label className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      name="alternative"
                      className="accent-primary"
                      disabled={disabled}
                      checked={value.alternativeId === a.id}
                      onChange={() => setDraft({ ...value, alternativeId: a.id })}
                    />
                    <span className="font-medium">{a.label}</span>
                  </label>
                  <span className="block font-normal text-muted-foreground">
                    {a.status}
                    {a.commit ? ` · ${a.commit.slice(0, 10)}` : ""}
                  </span>
                  {a.environmentLabel || a.sessionLabel ? (
                    <span className="block font-normal text-muted-foreground">
                      {[a.environmentLabel, a.sessionLabel].filter(Boolean).join(" / ")}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-border/40">
              <th scope="row" className="px-2 py-1 text-left font-normal text-muted-foreground">
                Summary
              </th>
              {spec.alternatives.map((a) => (
                <td key={a.id} className="px-2 py-1 align-top">
                  {a.summary}
                </td>
              ))}
            </tr>
            {rows.map((criterion) => (
              <tr key={criterion.id} className="border-t border-border/40">
                <th scope="row" className="px-2 py-1 text-left font-normal">
                  {criterion.text}
                </th>
                {spec.alternatives.map((a) => {
                  const ms = a.measurements.filter((m) =>
                    criterion.id === "_" ? !m.criterionId : m.criterionId === criterion.id,
                  );
                  return (
                    <td key={a.id} className="px-2 py-1 align-top">
                      {ms.length === 0 ? (
                        <span className="text-muted-foreground">unknown</span>
                      ) : (
                        ms.map((m, i) => (
                          <span key={i} className="block">
                            {m.label}:{" "}
                            {m.value === null ? (
                              <span className="text-muted-foreground">unknown</span>
                            ) : (
                              <span className="tabular-nums">
                                {m.value}
                                {m.unit ? ` ${m.unit}` : ""}
                              </span>
                            )}
                            {m.conditions ? (
                              <span className="block text-[10px] text-muted-foreground">
                                {m.conditions}
                              </span>
                            ) : null}
                          </span>
                        ))
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr className="border-t border-border/40">
              <th scope="row" className="px-2 py-1 text-left font-normal text-muted-foreground">
                Evidence and limits
              </th>
              {spec.alternatives.map((a) => (
                <td key={a.id} className="px-2 py-1 align-top">
                  <span className="flex flex-wrap gap-1">
                    {a.results.map((r, i) => (
                      <RefChip key={i} reference={r} />
                    ))}
                  </span>
                  {a.limitations.map((l) => (
                    <span key={l} className="block text-muted-foreground">
                      • {l}
                    </span>
                  ))}
                  {a.contextNote ? (
                    <span className="block text-amber-300">{a.contextNote}</span>
                  ) : null}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Rationale"
            placeholder="Why this one, or what evidence is missing?"
            value={value.rationale ?? ""}
            onChange={(e) => setDraft({ ...value, rationale: e.target.value })}
          />
          <ActionBar
            actions={actions}
            disabled={disabled}
            primaryDisabledReason={selected ? null : "Choose an alternative."}
            onAction={(a) =>
              selected &&
              act(a.id, {
                alternativeId: selected.id,
                ...(selected.commit ? { commit: selected.commit } : {}),
                ...(value.rationale?.trim() ? { rationale: value.rationale.trim() } : {}),
              })
            }
          />
        </>
      ) : null}
    </div>
  );
}
