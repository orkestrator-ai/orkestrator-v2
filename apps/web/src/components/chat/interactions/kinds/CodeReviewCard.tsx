import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react";
import type { CodeReviewItem, CodeReviewSpec } from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActionBar, textareaClass, type KindProps } from "../shared";

interface ReviewDraft {
  items: CodeReviewItem[];
  summary?: string;
}

type Disposition = CodeReviewItem["disposition"];

/**
 * Feature 5: inline code review over the backend-prepared change. Comments
 * anchor to a file, a hunk, or a line range on one side of the diff; a
 * keep/revise/explain decision is review intent only and never runs Git.
 */
export function CodeReviewCard({
  view,
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<CodeReviewSpec>) {
  const value = (draft as ReviewDraft | undefined) ?? { items: [] };
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(spec.files.slice(0, 3).map((f) => [f.path, true])),
  );
  const [composer, setComposer] = useState<Omit<
    CodeReviewItem,
    "itemId" | "disposition" | "comment"
  > | null>(null);
  const [disposition, setDisposition] = useState<Disposition>("revise");
  const [comment, setComment] = useState("");
  const add = () => {
    if (!composer) return;
    const item: CodeReviewItem = {
      ...composer,
      itemId: `c${Date.now().toString(36)}${value.items.length}`,
      disposition,
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    };
    setDraft({ ...value, items: [...value.items, item] });
    setComposer(null);
    setComment("");
  };
  const itemsFor = (
    file: string,
    hunkId?: string,
    line?: { side: "before" | "after"; n: number },
  ) =>
    value.items.filter(
      (i) =>
        i.file === file &&
        (hunkId === undefined || i.hunkId === hunkId) &&
        (!line ||
          (i.side === line.side && line.n >= (i.startLine ?? 0) && line.n <= (i.endLine ?? 0))),
    );

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Change {spec.changeRef} · {spec.files.length} file(s). Keep, revise and explain are review
        decisions only; nothing is staged or discarded.
      </p>
      {spec.summary ? <p className="text-sm">{spec.summary}</p> : null}
      {spec.files.map((file) => (
        <div key={file.path} className="overflow-hidden rounded border border-border/60">
          <div className="flex items-center gap-2 bg-white/[0.02] px-2 py-1.5">
            <button
              type="button"
              className="flex min-w-0 items-center gap-1 text-left text-xs font-medium focus-hairline"
              aria-expanded={open[file.path] ?? false}
              onClick={() => setOpen((o) => ({ ...o, [file.path]: !o[file.path] }))}
            >
              {open[file.path] ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <span className="truncate font-mono">{file.path}</span>
              <span className="text-muted-foreground">{file.status}</span>
            </button>
            {!disabled ? (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-xs"
                onClick={() => setComposer({ file: file.path, scope: "file" })}
              >
                Comment on file
              </Button>
            ) : null}
          </div>
          {itemsFor(file.path)
            .filter((i) => i.scope === "file")
            .map((i) => (
              <ItemNote
                key={i.itemId}
                item={i}
                onRemove={
                  disabled
                    ? undefined
                    : () =>
                        setDraft({
                          ...value,
                          items: value.items.filter((x) => x.itemId !== i.itemId),
                        })
                }
              />
            ))}
          {open[file.path]
            ? file.hunks.map((hunk) => (
                <div key={hunk.id} className="border-t border-border/40">
                  <div className="flex items-center gap-2 bg-muted/20 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                    <span className="truncate">{hunk.header}</span>
                    {hunk.trimmed ? (
                      <span className="rounded bg-amber-500/15 px-1 text-amber-300">
                        trimmed: line comments unavailable
                      </span>
                    ) : null}
                    {!disabled ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto h-5 px-1.5 text-[11px]"
                        onClick={() =>
                          setComposer({ file: file.path, scope: "hunk", hunkId: hunk.id })
                        }
                      >
                        Comment on hunk
                      </Button>
                    ) : null}
                  </div>
                  <table className="w-full border-collapse font-mono text-[11px]">
                    <tbody>
                      {hunk.lines.map((line, index) => {
                        const side = line.type === "del" ? "before" : "after";
                        const n = side === "before" ? line.before : line.after;
                        const noted =
                          n !== undefined && itemsFor(file.path, hunk.id, { side, n }).length > 0;
                        return (
                          <tr
                            key={index}
                            className={cn(
                              line.type === "add" && "bg-emerald-500/10",
                              line.type === "del" && "bg-red-500/10",
                              noted && "outline outline-1 outline-primary/40",
                            )}
                          >
                            <td className="w-10 select-none px-1 text-right text-muted-foreground">
                              {line.before ?? ""}
                            </td>
                            <td className="w-10 select-none px-1 text-right text-muted-foreground">
                              {line.after ?? ""}
                            </td>
                            <td className="w-6">
                              {!disabled && !hunk.trimmed && n !== undefined ? (
                                <button
                                  type="button"
                                  className="text-muted-foreground opacity-60 hover:opacity-100 focus-hairline"
                                  aria-label={`Comment on ${side} line ${n}`}
                                  onClick={() =>
                                    setComposer({
                                      file: file.path,
                                      scope: "lines",
                                      hunkId: hunk.id,
                                      side,
                                      startLine: n,
                                      endLine: n,
                                    })
                                  }
                                >
                                  <MessageSquarePlus className="size-3" />
                                </button>
                              ) : null}
                            </td>
                            <td className="whitespace-pre-wrap break-all pr-2">
                              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                              {line.text}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {itemsFor(file.path, hunk.id)
                    .filter((i) => i.scope !== "file")
                    .map((i) => (
                      <ItemNote
                        key={i.itemId}
                        item={i}
                        onRemove={
                          disabled
                            ? undefined
                            : () =>
                                setDraft({
                                  ...value,
                                  items: value.items.filter((x) => x.itemId !== i.itemId),
                                })
                        }
                      />
                    ))}
                </div>
              ))
            : null}
        </div>
      ))}
      {composer ? (
        <div
          className="flex flex-col gap-2 rounded border border-primary/30 bg-primary/[0.04] p-2"
          role="group"
          aria-label="New review comment"
        >
          <p className="text-xs text-muted-foreground">
            {composer.file}
            {composer.scope === "lines"
              ? ` · ${composer.side} line${composer.startLine === composer.endLine ? "" : "s"} ${composer.startLine}${composer.endLine !== composer.startLine ? `-${composer.endLine}` : ""}`
              : composer.scope === "hunk"
                ? " · hunk"
                : " · whole file"}
          </p>
          {composer.scope === "lines" ? (
            <label className="flex items-center gap-2 text-xs">
              Through line
              <input
                type="number"
                className="w-20 rounded border border-border/60 bg-transparent px-1"
                min={composer.startLine}
                value={composer.endLine}
                onChange={(e) =>
                  setComposer({
                    ...composer,
                    endLine: Math.max(composer.startLine ?? 1, Number(e.target.value)),
                  })
                }
              />
            </label>
          ) : null}
          <div className="flex gap-1" role="radiogroup" aria-label="Decision">
            {(["keep", "revise", "explain"] as const).map((d) => (
              <Button
                key={d}
                size="sm"
                variant={disposition === d ? "default" : "outline"}
                role="radio"
                aria-checked={disposition === d}
                onClick={() => setDisposition(d)}
              >
                {d === "keep" ? "Keep" : d === "revise" ? "Revise" : "Explain"}
              </Button>
            ))}
          </div>
          <textarea
            className={textareaClass}
            rows={2}
            aria-label="Comment"
            placeholder={
              disposition === "keep"
                ? "Comment (optional)"
                : "What should change, or what needs explaining?"
            }
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setComposer(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={disposition !== "keep" && !comment.trim()} onClick={add}>
              Add to review
            </Button>
          </div>
        </div>
      ) : null}
      {!disabled ? (
        <>
          <textarea
            className={textareaClass}
            rows={2}
            placeholder="Overall review comment (optional)"
            aria-label="Overall review comment"
            value={value.summary ?? ""}
            onChange={(e) => setDraft({ ...value, summary: e.target.value })}
          />
          <ActionBar
            actions={actions}
            disabled={disabled}
            primaryDisabledReason={
              value.items.length === 0 ? "Add at least one decision or comment." : null
            }
            onAction={(a) =>
              act(a.id, {
                items: value.items,
                ...(value.summary?.trim() ? { summary: value.summary.trim() } : {}),
              })
            }
          />
        </>
      ) : null}
      {view.receipts.length ? (
        <p className="text-xs text-muted-foreground">{view.receipts.length} review(s) sent.</p>
      ) : null}
    </div>
  );
}

function ItemNote({ item, onRemove }: { item: CodeReviewItem; onRemove?: () => void }) {
  return (
    <div className="flex items-start gap-2 border-t border-border/40 bg-primary/[0.04] px-2 py-1 text-xs">
      <span
        className={cn(
          "rounded px-1 text-[10px] font-medium uppercase",
          item.disposition === "keep"
            ? "bg-emerald-500/15 text-emerald-300"
            : item.disposition === "revise"
              ? "bg-amber-500/15 text-amber-300"
              : "bg-sky-500/15 text-sky-300",
        )}
      >
        {item.disposition}
      </span>
      <span className="flex-1">
        {item.scope === "lines" ? (
          <span className="text-muted-foreground">
            {item.side} {item.startLine}
            {item.endLine !== item.startLine ? `-${item.endLine}` : ""}:{" "}
          </span>
        ) : null}
        {item.comment ?? ""}
      </span>
      {onRemove ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground focus-hairline"
          onClick={onRemove}
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}
