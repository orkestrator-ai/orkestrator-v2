import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquarePlus, Pin, PinOff, PlusSquare } from "lucide-react";
import type { RichDeliverableRecord } from "@orkestrator/protocol/contract/domains/rich-interactions";
import type { AnchorLocation } from "@orkestrator/protocol/rich-interactions";
import type { ArtifactPublicationView } from "@orkestrator/protocol/transcript-artifact-commands";
import { Button } from "@/components/ui/button";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { richInteractionErrorMessage } from "@/lib/backend/rich-interactions";
import { newIdempotencyKey, useRichInteractionList } from "@/lib/chat/rich-interactions";
import { useNodeScope } from "@/lib/node-scope/providers";
import { onResourceChanged } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { contextTrayKey, contextTrayStore } from "@/stores/contextTrayStore";
import { RichInteractionCard } from "../RichInteractionCard";
import {
  ContentRefPreview,
  inputClass,
  textareaClass,
  useConversationPublications,
} from "../shared";
import { newContextItemId } from "./composer-shared";

interface DeliverableGroup {
  artifactId: string;
  publications: ArtifactPublicationView[];
  meta: RichDeliverableRecord | undefined;
}

/**
 * Feature 13: the session deliverables panel. The list is the authoritative
 * publication ledger; pins, labels, groups and the selected revision are the
 * person's own metadata on top, and the accepted revision comes from a result
 * review. Latest, selected and accepted revisions stay visibly distinct, and
 * discussing an item names its exact revision. Open interactions are listed
 * too, answerable here whatever the transcript has scrolled away.
 */
export function DeliverablesPanel({
  environmentId,
  logicalSessionKey,
}: {
  environmentId: string;
  logicalSessionKey: string;
}) {
  const backend = useScopeBackend();
  const scope = useNodeScope();
  const { publications, loaded } = useConversationPublications();
  const { views } = useRichInteractionList(environmentId, logicalSessionKey);
  const [meta, setMeta] = useState<RichDeliverableRecord[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [commenting, setCommenting] = useState<{ artifactId: string; revision: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const readMeta = useCallback(() => {
    void backend
      .listRichDeliverables({ environmentId, logicalSessionKey })
      .then(setMeta)
      .catch(() => undefined);
  }, [backend, environmentId, logicalSessionKey]);
  useEffect(() => {
    const initial = setTimeout(readMeta, 0);
    const off = onResourceChanged("rich-interaction", (change) => {
      if (!change.id || change.id === environmentId) readMeta();
    });
    return () => {
      clearTimeout(initial);
      off();
    };
  }, [environmentId, readMeta]);

  const groups = useMemo<DeliverableGroup[]>(() => {
    const byArtifact = new Map<string, ArtifactPublicationView[]>();
    for (const publication of publications) {
      const list = byArtifact.get(publication.ref.artifactId) ?? [];
      list.push(publication);
      byArtifact.set(publication.ref.artifactId, list);
    }
    const needle = query.trim().toLowerCase();
    return [...byArtifact.entries()]
      .map(([artifactId, list]) => ({
        artifactId,
        publications: list.sort((a, b) => b.ref.revision - a.ref.revision),
        meta: meta.find((m) => m.artifactId === artifactId),
      }))
      .filter(
        (group) =>
          !needle ||
          `${group.meta?.userLabel ?? ""} ${group.publications[0]!.ref.title} ${group.publications[0]!.ref.kind}`
            .toLowerCase()
            .includes(needle),
      )
      .sort(
        (a, b) =>
          Number(b.meta?.pinned ?? false) - Number(a.meta?.pinned ?? false) ||
          b.publications[0]!.conversationSequence - a.publications[0]!.conversationSequence,
      );
  }, [meta, publications, query]);

  const update = async (
    group: DeliverableGroup,
    patch: { pinned?: boolean; userLabel?: string | null; selectedRevision?: number | null },
  ) => {
    setError(null);
    try {
      const next = await backend.updateRichDeliverable({
        environmentId,
        logicalSessionKey,
        artifactId: group.artifactId,
        expectedRevision: group.meta?.revision ?? 0,
        ...patch,
      });
      setMeta((current) => [...current.filter((m) => m.artifactId !== next.artifactId), next]);
    } catch (cause) {
      setError(richInteractionErrorMessage(cause));
      readMeta();
    }
  };
  const addToTray = (artifactId: string, revision: number, title: string) =>
    scope
      .store(contextTrayStore)
      .getState()
      .add(contextTrayKey(environmentId, logicalSessionKey), {
        itemId: newContextItemId(),
        kind: "artifact",
        source: { kind: "artifact", artifactId, revision, label: title.slice(0, 120) },
        label: `${title.slice(0, 60)} (rev ${revision})`,
        included: true,
        freeze: "frozen",
      });
  const open = views.filter((view) => view.open && view.request.origin === "agent");

  return (
    <div className="flex flex-col gap-4">
      {open.length ? (
        <section aria-label="Open interactions" className="flex flex-col gap-1">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Waiting for you ({open.length})
          </h3>
          {open.map((view) => (
            <RichInteractionCard
              key={view.request.interactionId}
              interactionId={view.request.interactionId}
              environmentId={environmentId}
            />
          ))}
        </section>
      ) : null}
      <section aria-label="Deliverables" className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Deliverables
          </h3>
          <input
            className={cn(inputClass, "ml-auto max-w-[14rem] py-1 text-xs")}
            placeholder="Search"
            aria-label="Search deliverables"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {error ? (
          <p className="text-xs text-failure" role="alert">
            {error}
          </p>
        ) : null}
        {!loaded ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No published outputs in this conversation yet.
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {groups.map((group) => {
            const latest = group.publications[0]!;
            const shownRevision = group.meta?.selectedRevision ?? latest.ref.revision;
            const shown =
              group.publications.find((p) => p.ref.revision === shownRevision) ?? latest;
            const isOpen = selected === group.artifactId;
            return (
              <li key={group.artifactId} className="rounded border border-border/60">
                <div className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium focus-hairline"
                    aria-expanded={isOpen}
                    onClick={() => setSelected(isOpen ? null : group.artifactId)}
                  >
                    {group.meta?.userLabel ?? latest.ref.title}
                    {group.meta?.userLabel ? (
                      <span className="ml-1 font-normal text-muted-foreground">
                        ({latest.ref.title})
                      </span>
                    ) : null}
                  </button>
                  <span className="text-muted-foreground">{latest.ref.kind}</span>
                  <span className="text-muted-foreground">latest rev {latest.ref.revision}</span>
                  {group.meta?.selectedRevision !== undefined &&
                  group.meta.selectedRevision !== latest.ref.revision ? (
                    <span className="text-primary">showing rev {group.meta.selectedRevision}</span>
                  ) : null}
                  {group.meta?.acceptedRevision !== undefined ? (
                    <span className="rounded bg-emerald-500/15 px-1 text-emerald-300">
                      accepted rev {group.meta.acceptedRevision}
                    </span>
                  ) : null}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    aria-label={group.meta?.pinned ? "Unpin" : "Pin"}
                    aria-pressed={group.meta?.pinned ?? false}
                    onClick={() => void update(group, { pinned: !group.meta?.pinned })}
                  >
                    {group.meta?.pinned ? (
                      <PinOff className="size-3" />
                    ) : (
                      <Pin className="size-3" />
                    )}
                  </Button>
                </div>
                {isOpen ? (
                  <div className="flex flex-col gap-2 border-t border-border/40 p-2">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <label className="flex items-center gap-1">
                        Version
                        <select
                          className="rounded border border-border/60 bg-transparent px-1"
                          value={shownRevision}
                          onChange={(e) =>
                            void update(group, {
                              selectedRevision:
                                Number(e.target.value) === latest.ref.revision
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                        >
                          {group.publications.map((p) => (
                            <option key={p.ref.revision} value={p.ref.revision}>
                              rev {p.ref.revision}
                              {p.ref.revision === latest.ref.revision ? " (latest)" : ""}
                              {p.ref.revision === group.meta?.acceptedRevision ? " (accepted)" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                      <LabelEditor
                        value={group.meta?.userLabel ?? ""}
                        onSave={(label) => void update(group, { userLabel: label || null })}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() =>
                          addToTray(group.artifactId, shown.ref.revision, shown.ref.title)
                        }
                      >
                        <PlusSquare className="size-3.5" aria-hidden />
                        Discuss this version
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() =>
                          setCommenting({
                            artifactId: group.artifactId,
                            revision: shown.ref.revision,
                          })
                        }
                      >
                        <MessageSquarePlus className="size-3.5" aria-hidden />
                        Comment
                      </Button>
                    </div>
                    <ContentRefPreview
                      reference={{
                        kind: "artifact",
                        artifactId: group.artifactId,
                        revision: shown.ref.revision,
                      }}
                      description={shown.ref.summary}
                      compact
                    />
                    {commenting?.artifactId === group.artifactId ? (
                      <CommentComposer
                        environmentId={environmentId}
                        logicalSessionKey={logicalSessionKey}
                        target={commenting}
                        title={shown.ref.title}
                        onDone={() => setCommenting(null)}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
      <ThreadsSection environmentId={environmentId} logicalSessionKey={logicalSessionKey} />
    </div>
  );
}

function LabelEditor({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <span className="flex items-center gap-1">
      <input
        className="w-36 rounded border border-border/60 bg-transparent px-1 py-0.5"
        aria-label="Your label"
        placeholder="Your label"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSave(text.trim())}
      />
      {text.trim() !== value ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => onSave(text.trim())}
        >
          Save label
        </Button>
      ) : null}
    </span>
  );
}

/** Persistent comment threads of this conversation (feature 6). */
function ThreadsSection({
  environmentId,
  logicalSessionKey,
}: {
  environmentId: string;
  logicalSessionKey: string;
}) {
  const { views } = useRichInteractionList(environmentId, logicalSessionKey);
  const [showResolved, setShowResolved] = useState(false);
  const threads = views.filter(
    (view) =>
      view.request.kind === "feedback" &&
      (showResolved || !(view.request.spec as { resolved?: boolean }).resolved),
  );
  if (!views.some((view) => view.request.kind === "feedback")) return null;
  return (
    <section aria-label="Comment threads" className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Comment threads
        </h3>
        <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="accent-primary"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>
      {threads.map((view) => (
        <RichInteractionCard
          key={view.request.interactionId}
          interactionId={view.request.interactionId}
          environmentId={environmentId}
        />
      ))}
    </section>
  );
}

/**
 * Creates a durable comment thread on an exact artifact revision: the whole
 * item, a quoted passage, or (for images) a normalized region drawn on it.
 * "Save note" starts no agent; "Discuss" delivers to this conversation.
 */
export function CommentComposer({
  environmentId,
  logicalSessionKey,
  target,
  title,
  onDone,
}: {
  environmentId: string;
  logicalSessionKey: string;
  target: { artifactId: string; revision: number };
  title: string;
  onDone: () => void;
}) {
  const backend = useScopeBackend();
  const [mode, setMode] = useState<"whole" | "quote">("whole");
  const [quote, setQuote] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key] = useState(() => newIdempotencyKey());
  const location: AnchorLocation =
    mode === "quote" && quote.trim()
      ? { kind: "text-range", quote: quote.trim() }
      : { kind: "whole" };
  const send = async (actionId: "save-note" | "discuss") => {
    setBusy(true);
    setError(null);
    try {
      await backend.composeRichInteraction({
        environmentId,
        tabId: logicalSessionKey.slice(logicalSessionKey.indexOf(":") + 1),
        kind: "feedback",
        title: `Comment on ${title}`.slice(0, 200),
        spec: {
          target: {
            source: { kind: "artifact", artifactId: target.artifactId, revision: target.revision },
            location,
          },
          entries: [],
          resolved: false,
          ...(mode === "quote" && quote.trim() ? { excerpt: quote.trim() } : {}),
        },
        actionId,
        idempotencyKey: `${key}-${actionId}`,
        result: { body: body.trim() },
      });
      onDone();
    } catch (cause) {
      setError(richInteractionErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="flex flex-col gap-2 rounded border border-primary/30 bg-primary/[0.04] p-2 text-xs"
      role="group"
      aria-label="New comment"
    >
      <p>
        Comment on revision {target.revision} of {title}
      </p>
      <div className="flex gap-1" role="radiogroup" aria-label="Comment target">
        {(["whole", "quote"] as const).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={mode === m ? "default" : "outline"}
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
          >
            {m === "whole" ? "Whole item" : "A quoted passage"}
          </Button>
        ))}
      </div>
      {mode === "quote" ? (
        <textarea
          className={textareaClass}
          rows={2}
          aria-label="Quoted passage"
          placeholder="Paste the exact passage you mean"
          value={quote}
          onChange={(e) => setQuote(e.target.value)}
        />
      ) : null}
      <textarea
        className={textareaClass}
        rows={2}
        aria-label="Comment"
        placeholder="Your comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!body.trim() || busy}
          onClick={() => void send("save-note")}
        >
          Save note
        </Button>
        <Button size="sm" disabled={!body.trim() || busy} onClick={() => void send("discuss")}>
          Discuss
        </Button>
      </div>
      {error ? (
        <p className="text-failure" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
