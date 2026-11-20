import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { diagnosticCounts, type DiagnosticCaseStatus, type DiagnosticsSpec } from "@orkestrator/protocol/rich-interactions";
import { cn } from "@/lib/utils";
import { ActionBar, ProvenanceBadge, RefChip, inputClass, textareaClass, type KindProps } from "../shared";

interface DiagnosticsDraft {
  selected: string[];
  note?: string;
}

const STATUS_TONE: Record<DiagnosticCaseStatus, string> = {
  passed: "text-success",
  failed: "text-failure",
  skipped: "text-muted-foreground",
  incomplete: "text-amber-300",
  "not-run": "text-muted-foreground",
};

/**
 * Feature 9: structured test and build results. Counts reconcile with the
 * cases shown, the tested baseline is always visible, and an exact rerun is
 * offered only for cases with a server-held runner selector.
 */
export function DiagnosticsCard({ view, spec, draft, setDraft, act, disabled, actions }: KindProps<DiagnosticsSpec>) {
  const value = (draft as DiagnosticsDraft | undefined) ?? { selected: [] };
  const counts = diagnosticCounts(spec);
  const [status, setStatus] = useState<DiagnosticCaseStatus | "all">(counts.failed ? "failed" : "all");
  const [search, setSearch] = useState("");
  const [openCase, setOpenCase] = useState<string | null>(null);
  const visible = useMemo(
    () => spec.cases.filter((c) => (status === "all" || c.status === status) && (!search.trim() || `${c.name} ${c.suite ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()))),
    [search, spec.cases, status],
  );
  const selected = new Set(value.selected);
  const hidden = value.selected.filter((id) => !visible.some((c) => c.id === id)).length;
  const rerunnable = value.selected.every((id) => spec.cases.find((c) => c.id === id)?.rerunnable);
  const result = { runRevision: spec.runRevision, caseIds: value.selected, ...(value.note?.trim() ? { note: value.note.trim() } : {}) };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={cn("font-medium", spec.status === "failed" ? "text-failure" : spec.status === "passed" ? "text-success" : "text-muted-foreground")}>{spec.status}</span>
        <span className="text-muted-foreground">
          Run {spec.runId} · revision {spec.runRevision} · baseline {spec.baseline.commit ? <code>{spec.baseline.commit.slice(0, 12)}</code> : "unrecorded"}
          {spec.baseline.environmentLabel ? ` · ${spec.baseline.environmentLabel}` : ""}
        </span>
      </div>
      {spec.workspaceChanged ? <p className="rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">The workspace has changed since this run. A rerun tests the current workspace, not this baseline.</p> : null}
      {spec.commands.length ? (
        <ul className="flex flex-wrap gap-2 text-xs">
          {spec.commands.map((cmd) => (
            <li key={cmd.id} className="rounded border border-border/60 px-2 py-0.5">
              <span className={STATUS_TONE[cmd.status]}>{cmd.status}</span> {cmd.label}
              {cmd.exitCode !== undefined ? <span className="text-muted-foreground"> · exit {cmd.exitCode}</span> : null}
              {cmd.outputTruncated ? <span className="text-amber-300"> · output truncated</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 text-xs" role="tablist" aria-label="Filter by status">
        {(["all", "failed", "incomplete", "skipped", "passed", "not-run"] as const).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={status === s} className={cn("rounded px-2 py-0.5 focus-hairline", status === s ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-white/[0.04]")} onClick={() => setStatus(s)}>
            {s === "all" ? `All ${spec.cases.length}` : `${s} ${counts[s]}`}
          </button>
        ))}
        <input className={cn(inputClass, "ml-auto max-w-[12rem] py-0.5 text-xs")} placeholder="Search cases" aria-label="Search cases" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <ul className="max-h-80 overflow-auto rounded border border-border/60" aria-label="Cases">
        {visible.slice(0, 300).map((c) => (
          <li key={c.id} className="border-b border-border/40 last:border-b-0">
            <div className="flex items-center gap-2 px-2 py-1 text-xs">
              <input type="checkbox" className="size-4 accent-primary" aria-label={`Select ${c.name}`} disabled={disabled} checked={selected.has(c.id)} onChange={() => setDraft({ ...value, selected: selected.has(c.id) ? value.selected.filter((id) => id !== c.id) : [...value.selected, c.id] })} />
              <span className={cn("w-16 shrink-0", STATUS_TONE[c.status])}>{c.status}</span>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-1 text-left focus-hairline" aria-expanded={openCase === c.id} onClick={() => setOpenCase(openCase === c.id ? null : c.id)}>
                {openCase === c.id ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
                <span className="truncate">{c.suite ? `${c.suite} › ` : ""}{c.name}</span>
              </button>
              {c.attempt && c.attempt > 1 ? <span className="text-muted-foreground">attempt {c.attempt}</span> : null}
              <ProvenanceBadge provenance={c.provenance} />
            </div>
            {openCase === c.id ? (
              <div className="flex flex-col gap-1 px-8 pb-2 text-xs">
                {c.location ? <code className="text-muted-foreground">{c.location}</code> : null}
                {c.message ? <p>{c.message}</p> : null}
                {c.excerpt ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[11px]">{c.excerpt}</pre> : null}
                {c.evidence.length ? <div className="flex flex-wrap gap-1">{c.evidence.map((ref, i) => <RefChip key={i} reference={ref} />)}</div> : null}
                {!c.rerunnable ? <p className="text-muted-foreground">No exact rerun selector for this case.</p> : null}
              </div>
            ) : null}
          </li>
        ))}
        {visible.length > 300 ? <li className="px-2 py-1 text-xs text-muted-foreground">{visible.length - 300} more cases; narrow the filter.</li> : null}
      </ul>
      <p className="text-xs text-muted-foreground" role="status">
        {value.selected.length} selected{hidden ? ` (${hidden} hidden by the filter)` : ""}
      </p>
      {!disabled ? (
        <>
          <textarea className={textareaClass} rows={2} placeholder="Note (optional)" aria-label="Note" value={value.note ?? ""} onChange={(e) => setDraft({ ...value, note: e.target.value })} />
          <ActionBar actions={actions} only={["explain-selection", "request-fix"]} disabled={disabled} primaryDisabledReason={value.selected.length ? null : "Select one or more cases."} onAction={(a) => act(a.id, result)} />
          <ActionBar actions={actions} only={["rerun-selection"]} disabled={disabled} primaryDisabledReason={value.selected.length === 0 ? null : rerunnable ? null : "Some selected cases have no exact rerun selector."} onAction={(a) => value.selected.length && act(a.id, result)} />
        </>
      ) : null}
      {view.receipts.length ? <p className="text-[11px] text-muted-foreground">{view.receipts.length} request(s) made from this run.</p> : null}
    </div>
  );
}
