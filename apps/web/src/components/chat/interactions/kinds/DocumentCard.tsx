import { useMemo, useState } from "react";
import { Download, Lock, LockOpen, PanelRightOpen } from "lucide-react";
import {
  applyDocumentOps,
  documentBlockHash,
  documentToMarkdown,
  type DocumentBlock,
  type DocumentOp,
  type DocumentSpec,
} from "@orkestrator/protocol/rich-interactions";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ActionBar, ContentRefPreview, textareaClass, type KindProps } from "../shared";

interface DocumentDraft {
  ops: DocumentOp[];
  selected: string[];
  instruction?: string;
}

/**
 * Feature 8: the collaborative document canvas. The transcript shows a compact
 * summary; the canvas opens beside the session (full screen on narrow
 * layouts). Edits are block operations carrying the hash of the block they
 * were made on, so a concurrent agent revision of the same block is refused
 * rather than overwritten; preserved blocks cannot be changed by the agent.
 */
export function DocumentCard(props: KindProps<DocumentSpec>) {
  const { spec, view } = props;
  const [open, setOpen] = useState(false);
  const words = spec.blocks.reduce((n, b) => n + (b.text?.split(/\s+/u).filter(Boolean).length ?? 0) + (b.items?.join(" ").split(/\s+/u).length ?? 0), 0);
  const preserved = spec.blocks.filter((b) => b.preserved).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{spec.title}</span>
        <span className="text-xs text-muted-foreground">
          revision {view.request.revision} · {spec.blocks.length} blocks · ~{words} words{preserved ? ` · ${preserved} preserved` : ""}
        </span>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => setOpen(true)}>
          <PanelRightOpen className="size-3.5" aria-hidden />
          Open document
        </Button>
      </div>
      <ol className="text-xs text-muted-foreground">
        {spec.blocks.filter((b) => b.type === "heading").slice(0, 8).map((b) => (
          <li key={b.id} style={{ paddingLeft: `${((b.level ?? 2) - 1) * 12}px` }}>
            {b.text}
          </li>
        ))}
      </ol>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full max-w-none overflow-y-auto px-5 py-4 sm:max-w-2xl">
          <SheetTitle>{spec.title}</SheetTitle>
          <SheetDescription>
            Revision {view.request.revision}, last changed by {view.request.revisionAuthor === "user" ? "you" : "the agent"}.
          </SheetDescription>
          <DocumentCanvas {...props} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function DocumentCanvas({ view, spec, draft, setDraft, act, disabled, actions }: KindProps<DocumentSpec>) {
  const value = (draft as DocumentDraft | undefined) ?? { ops: [], selected: [] };
  const current = useMemo(() => applyDocumentOps(spec, value.ops), [spec, value.ops]);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const editedIds = new Set(value.ops.flatMap((op) => ("blockId" in op ? [op.blockId] : op.op === "insert-after" ? [op.block.id] : [])));
  const replaceBlock = (block: DocumentBlock, next: DocumentBlock) => {
    const original = spec.blocks.find((b) => b.id === block.id);
    if (!original) {
      // A block added in this draft: rewrite its insertion instead.
      setDraft({ ...value, ops: value.ops.map((op) => (op.op === "insert-after" && op.block.id === block.id ? { ...op, block: next } : op)) });
      return;
    }
    const ops = value.ops.filter((op) => !(op.op === "replace-block" && op.blockId === block.id));
    setDraft({ ...value, ops: [...ops, { op: "replace-block", blockId: block.id, expectedBlockHash: documentBlockHash(original), replacement: next }] });
  };
  const exportMarkdown = () => {
    const blob = new Blob([documentToMarkdown(current)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${spec.title.replace(/[^\w.-]+/gu, "-").slice(0, 60) || "document"}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{value.ops.length ? `${value.ops.length} unsaved edit(s)` : "No unsaved edits"}</span>
        {value.selected.length ? <span className="text-primary">{value.selected.length} section(s) selected for revision</span> : null}
        <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={exportMarkdown}>
          <Download className="size-3.5" aria-hidden />
          Export Markdown
        </Button>
      </div>
      <article className="flex flex-col gap-2">
        {current.blocks.map((block) => {
          const selected = value.selected.includes(block.id);
          const isEditing = editing === block.id;
          return (
            <div key={block.id} className={cn("group relative rounded border px-3 py-2", selected ? "border-primary/50 bg-primary/[0.05]" : "border-transparent hover:border-border/60", editedIds.has(block.id) && "border-l-2 border-l-primary")}>
              <div className="absolute top-1 right-1 flex gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                {!disabled && spec.blocks.some((b) => b.id === block.id) ? (
                  <button
                    type="button"
                    className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-hairline"
                    aria-pressed={selected}
                    onClick={() => setDraft({ ...value, selected: selected ? value.selected.filter((id) => id !== block.id) : [...value.selected, block.id] })}
                  >
                    {selected ? "Selected" : "Select"}
                  </button>
                ) : null}
                {!disabled && spec.blocks.some((b) => b.id === block.id) ? (
                  <button
                    type="button"
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-hairline"
                    aria-label={block.preserved ? "Release preserved block" : "Preserve block"}
                    title={block.preserved ? "Preserved: the agent cannot change it" : "Preserve this block"}
                    onClick={() => setDraft({ ...value, ops: [...value.ops, { op: "set-preserved", blockId: block.id, value: !block.preserved }] })}
                  >
                    {block.preserved ? <Lock className="size-3" /> : <LockOpen className="size-3" />}
                  </button>
                ) : null}
                {!disabled && block.type !== "table" && block.type !== "artifact-ref" ? (
                  <button
                    type="button"
                    className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-hairline"
                    onClick={() => {
                      setEditing(block.id);
                      setText(block.type === "list" ? (block.items ?? []).join("\n") : (block.text ?? ""));
                    }}
                  >
                    Edit
                  </button>
                ) : null}
              </div>
              {isEditing ? (
                <div className="flex flex-col gap-2">
                  <textarea className={cn(textareaClass, block.type === "code" && "font-mono text-xs")} rows={Math.min(14, Math.max(3, text.split("\n").length + 1))} aria-label="Edit block" value={text} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        const { preserved: _p, author: _a, ...rest } = block;
                        replaceBlock(block, block.type === "list" ? { ...rest, items: text.split("\n").filter((l) => l.trim()) } : { ...rest, text });
                        setEditing(null);
                      }}
                    >
                      Keep edit
                    </Button>
                  </div>
                </div>
              ) : (
                <BlockView block={block} />
              )}
              {block.preserved ? <span className="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"><Lock className="size-2.5" />preserved</span> : null}
            </div>
          );
        })}
      </article>
      {!disabled ? (
        <>
          <ActionBar actions={actions} only={["save"]} disabled={disabled} primaryDisabledReason={value.ops.length ? null : "No edits to save."} onAction={(a) => act(a.id, { baseRevision: view.request.revision, ops: value.ops, blockIds: [] })} />
          <textarea className={textareaClass} rows={2} aria-label="Revision instruction" placeholder="Ask the agent to revise the selected sections…" value={value.instruction ?? ""} onChange={(e) => setDraft({ ...value, instruction: e.target.value })} />
          <ActionBar
            actions={actions}
            only={["ask-revise"]}
            disabled={disabled}
            primaryDisabledReason={value.ops.length ? "Save your edits first." : value.instruction?.trim() ? null : "Describe the revision you want."}
            onAction={(a) => act(a.id, { baseRevision: view.request.revision, ops: [], blockIds: value.selected, instruction: value.instruction?.trim() ?? "" })}
          />
        </>
      ) : null}
    </div>
  );
}

function BlockView({ block }: { block: DocumentBlock }) {
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? "text-lg" : block.level === 2 ? "text-base" : "text-sm";
      return <p className={cn("font-semibold", size)} role="heading" aria-level={(block.level ?? 2) + 1}>{block.text}</p>;
    }
    case "paragraph":
      return <p className="whitespace-pre-wrap text-sm leading-relaxed">{block.text}</p>;
    case "quote":
      return <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground whitespace-pre-wrap">{block.text}</blockquote>;
    case "code":
      return <pre className="overflow-auto rounded bg-muted/30 p-2 font-mono text-xs">{block.text}</pre>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return <Tag className={cn("pl-5 text-sm", block.ordered ? "list-decimal" : "list-disc")}>{block.items?.map((item, i) => <li key={i}>{item}</li>)}</Tag>;
    }
    case "table": {
      const [head = [], ...rows] = block.rows ?? [];
      return (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>{head.map((cell, i) => <th key={i} scope="col" className="border-b border-border px-2 py-1 text-left">{cell}</th>)}</tr>
          </thead>
          <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} className="border-b border-border/40 px-2 py-1">{cell}</td>)}</tr>)}</tbody>
        </table>
      );
    }
    case "artifact-ref":
      return block.ref ? <ContentRefPreview reference={block.ref} description={block.text ?? "Embedded reference"} compact /> : null;
  }
}
