import { useMemo, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import {
  compareCollectionCells,
  type CollectionCell,
  type CollectionResult,
  type CollectionSpec,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActionBar, inputClass, textareaClass, type KindProps } from "../shared";

interface CollectionDraft {
  selected: string[];
  allRecords?: boolean;
  edits: Record<string, Record<string, CollectionCell>>;
  note?: string;
}

const PAGE = 100;

/**
 * Feature 4: selectable tables. Sorting and filtering are local presentation
 * over the exact source revision; selection is by stable row id and survives
 * both. Hidden selections and the scope of "select all" are always stated.
 * Edits stay proposals until a declared operation applies them.
 */
export function CollectionCard({ view, spec, draft, setDraft, act, disabled, actions }: KindProps<CollectionSpec>) {
  const value = (draft as CollectionDraft | undefined) ?? { selected: [], edits: {} };
  const [sort, setSort] = useState<{ column: string; direction: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const selected = new Set(value.selected);
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = needle ? spec.rows.filter((row) => Object.values(row.cells).some((cell) => cell !== null && String(cell).toLowerCase().includes(needle))) : [...spec.rows];
    if (sort) {
      const column = spec.columns.find((c) => c.id === sort.column)!;
      rows.sort((a, b) => sort.direction * compareCollectionCells(column.type, a.cells[sort.column] ?? null, b.cells[sort.column] ?? null));
    }
    return rows;
  }, [filter, sort, spec.columns, spec.rows]);
  const visibleIds = new Set(visible.map((r) => r.id));
  const hiddenSelected = value.allRecords ? 0 : value.selected.filter((id) => !visibleIds.has(id)).length;
  const update = (next: Partial<CollectionDraft>) => setDraft({ ...value, ...next });
  const toggle = (rowId: string) =>
    update({ allRecords: false, selected: selected.has(rowId) ? value.selected.filter((id) => id !== rowId) : [...value.selected, rowId] });
  const editsList = Object.entries(value.edits).flatMap(([rowId, fields]) => Object.entries(fields).map(([field, v]) => ({ rowId, field, value: v })));
  const result = (): CollectionResult => ({
    sourceRevision: spec.sourceRevision,
    selection: value.allRecords ? { mode: "all-records" } : { mode: "explicit", rowIds: value.selected },
    edits: editsList,
    ...(value.note?.trim() ? { note: value.note.trim() } : {}),
  });
  const count = value.allRecords ? spec.rows.length : value.selected.length;
  const tooMany = spec.maxSelection !== undefined && count > spec.maxSelection;
  const last = view.receipts.at(-1);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input className={cn(inputClass, "max-w-xs")} placeholder="Filter rows" aria-label="Filter rows" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="text-xs text-muted-foreground" role="status">
          {count} selected{hiddenSelected ? ` (${hiddenSelected} hidden by the filter)` : ""} · {visible.length} shown of {spec.rows.length}
          {spec.complete ? "" : ` loaded (${spec.totalRows ?? "more"} in total — unloaded records are not selectable)`}
        </span>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => update({ allRecords: false, selected: [...new Set([...value.selected, ...visible.map((r) => r.id)])] })}>
            Select visible
          </Button>
          {spec.complete ? (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={disabled} onClick={() => update({ allRecords: true, selected: spec.rows.map((r) => r.id) })}>
              Select all {spec.rows.length} records
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" disabled={disabled || count === 0} onClick={() => update({ allRecords: false, selected: [] })}>
            Clear
          </Button>
        </div>
      </div>
      <div className="max-h-96 overflow-auto rounded border border-border/60">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-zinc-900">
            <tr>
              <th scope="col" className="w-8 px-2 py-1.5">
                <span className="sr-only">Select</span>
              </th>
              {spec.columns.map((column) => (
                <th key={column.id} scope="col" className="px-2 py-1.5 text-left font-medium" aria-sort={sort?.column === column.id ? (sort.direction === 1 ? "ascending" : "descending") : "none"}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 focus-hairline"
                    onClick={() => setSort((current) => (current?.column === column.id ? (current.direction === 1 ? { column: column.id, direction: -1 } : null) : { column: column.id, direction: 1 }))}
                  >
                    {column.label}
                    {column.unit ? <span className="font-normal text-muted-foreground">({column.unit})</span> : null}
                    <ArrowDownUp className="size-3 text-muted-foreground" aria-hidden />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, shown).map((row) => (
              <tr key={row.id} className={cn("border-t border-border/40", selected.has(row.id) && "bg-primary/10")}>
                <td className="px-2 py-1">
                  <input type="checkbox" className="size-4 accent-primary" aria-label={`Select row ${row.id}`} checked={selected.has(row.id)} disabled={disabled} onChange={() => toggle(row.id)} />
                </td>
                {spec.columns.map((column) => {
                  const edited = value.edits[row.id]?.[column.id];
                  const cell = edited !== undefined ? edited : (row.cells[column.id] ?? null);
                  return (
                    <td key={column.id} className={cn("px-2 py-1 align-top", column.type === "number" && "text-right tabular-nums", edited !== undefined && "text-primary")}>
                      {column.editable && !disabled ? (
                        column.type === "enum" ? (
                          <select
                            className="rounded border border-border/60 bg-transparent px-1 text-xs"
                            aria-label={`${column.label} for ${row.id}`}
                            value={cell === null ? "" : String(cell)}
                            onChange={(e) => update({ edits: { ...value.edits, [row.id]: { ...value.edits[row.id], [column.id]: e.target.value === "" ? null : e.target.value } } })}
                          >
                            <option value="">—</option>
                            {column.options?.map((o) => (
                              <option key={o} value={o}>
                                {o}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            className="w-full rounded border border-border/60 bg-transparent px-1 text-xs"
                            aria-label={`${column.label} for ${row.id}`}
                            value={cell === null ? "" : String(cell)}
                            onChange={(e) => update({ edits: { ...value.edits, [row.id]: { ...value.edits[row.id], [column.id]: column.type === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value } } })}
                          />
                        )
                      ) : cell === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : typeof cell === "boolean" ? (
                        cell ? "Yes" : "No"
                      ) : (
                        String(cell)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length > shown ? (
          <Button size="sm" variant="ghost" className="w-full text-xs" onClick={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, visible.length - shown)} more rows
          </Button>
        ) : null}
      </div>
      {editsList.length ? <p className="text-xs text-muted-foreground">{editsList.length} proposed edit(s). They are sent with your request and are not applied to the source.</p> : null}
      {!disabled ? (
        <>
          <textarea className={textareaClass} rows={2} placeholder="Note for the agent (optional)" aria-label="Note" value={value.note ?? ""} onChange={(e) => update({ note: e.target.value })} />
          <ActionBar
            actions={actions}
            disabled={disabled}
            primaryDisabledReason={count === 0 ? "Select at least one row." : tooMany ? `Select at most ${spec.maxSelection} rows.` : null}
            onAction={(a) => act(a.id, result())}
          />
        </>
      ) : last ? (
        <p className="text-xs text-muted-foreground">Last request: {last.actionLabel}</p>
      ) : null}
    </div>
  );
}
