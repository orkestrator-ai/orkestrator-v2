import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  DesignContextReference,
  DesignSessionLink,
} from "@orkestrator/protocol/design-operations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import { Textarea } from "@/components/ui/textarea";
import { createUniqueTabId } from "@/components/terminal/TerminalContainer.helpers";
import { useOptionalTerminalContext } from "@/contexts/TerminalContext";
import { createSessionKey } from "@/lib/utils";
import type { DesignProjection } from "@/stores/designStore";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";
import { designApi, failureOf } from "./design-client";
import {
  boundDesignContextReference,
  buildDesignContextAnnotation,
  buildDesignHandoffDraft,
  defaultDesignRequest,
  designContextSummaryLines,
  designRoleForScope,
  DESIGN_HANDOFF_MAX_FRAMES,
  DESIGN_SESSION_LINK_LIMIT,
  orderDesignSessionLinks,
  planDesignDraft,
  type DesignContextPayload,
  type DesignContextScope,
  type DesignDraftAddition,
} from "./design-agent-context";

type AgentChoice = "claude" | "codex";
type LinkStatus = "open" | "closed" | "checking";
type Destination = { kind: "link"; linkId: string } | { kind: "new" };

const SCOPE_OPTIONS = [
  { value: "discuss" as const, label: "Discuss" },
  { value: "revise" as const, label: "Revise" },
  { value: "implement" as const, label: "Implement" },
];
const AGENT_OPTIONS = [
  { value: "claude" as const, label: "Claude" },
  { value: "codex" as const, label: "Codex" },
];

function platformLabel(platform: string): string {
  if (platform === "claude") return "Claude";
  if (platform === "codex") return "Codex";
  return platform;
}

function linkTitle(link: DesignSessionLink, tab: TabInfo | undefined): string {
  return (
    tab?.displayTitle ??
    link.label ??
    `${platformLabel(link.platform)} ${link.role === "implementation" ? "implementation" : "design"} conversation`
  );
}

function focusTab(environmentId: string, tabId: string): boolean {
  const store = usePaneLayoutStore.getState();
  const pane = store.findPaneWithTab(tabId, environmentId);
  if (!pane) return false;
  store.setActivePane(pane.id, environmentId);
  store.setActiveTab(pane.id, tabId, environmentId);
  return true;
}

function messageOf(error: unknown): string {
  return failureOf(error).message;
}

export interface DesignAgentDialogProps {
  context: DesignContextReference | null;
  projection: DesignProjection | null | undefined;
  onOpenChange: (open: boolean) => void;
  /** Called after a link is created or removed so the owner can resynchronize. */
  onLinksChanged?: () => void;
}

/**
 * "Ask agent about this design": attaches a revisioned, bounded design
 * reference to an ordinary native conversation's unsent draft, or prepares an
 * implementation handoff. Nothing is ever submitted from here.
 */
export function DesignAgentDialog({
  context,
  projection,
  onOpenChange,
  onLinksChanged,
}: DesignAgentDialogProps) {
  return (
    <Dialog open={context !== null} onOpenChange={onOpenChange}>
      {context ? (
        <DesignAgentDialogBody
          key={`${context.canvasId}:${context.frameId ?? ""}:${context.scope}:${context.checkpointId ?? ""}:${context.canvasRevision}`}
          context={context}
          projection={projection}
          onClose={() => onOpenChange(false)}
          onLinksChanged={onLinksChanged}
        />
      ) : null}
    </Dialog>
  );
}

function DesignAgentDialogBody({
  context,
  projection,
  onClose,
  onLinksChanged,
}: {
  context: DesignContextReference;
  projection: DesignProjection | null | undefined;
  onClose: () => void;
  onLinksChanged?: () => void;
}) {
  const environmentId = context.environmentId;
  const terminal = useOptionalTerminalContext();
  const createTab = terminal?.createTab ?? null;
  const updateDraft = useNativeComposeStore((state) => state.updateDraft);
  const paneEnvironment = usePaneLayoutStore((state) => state.environments.get(environmentId));
  const hydrated = usePaneLayoutStore((state) => state.hydration.get(environmentId) === "done");

  const [scope, setScope] = useState<DesignContextScope>(context.scope);
  const [note, setNote] = useState("");
  const [brief, setBrief] = useState("");
  const [agent, setAgent] = useState<AgentChoice>("claude");
  const [replaceId, setReplaceId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [addedLinks, setAddedLinks] = useState<DesignSessionLink[]>([]);
  const [removedLinks, setRemovedLinks] = useState<ReadonlySet<string>>(new Set());
  const [revisionChoice, setRevisionChoice] = useState<"current" | "checkpoint">(
    context.checkpointId ? "checkpoint" : "current",
  );
  const [checkpoint, setCheckpoint] = useState<{ revision: number; label: string } | null>(null);

  const frames = useMemo(() => projection?.canvas?.frames ?? [], [projection?.canvas?.frames]);
  const [selectedFrames, setSelectedFrames] = useState<ReadonlySet<string>>(() => {
    const initial = context.frameId ?? projection?.canvas?.frames[0]?.id;
    return new Set(initial ? [initial] : []);
  });
  const currentRevision = projection?.revision ?? context.canvasRevision;

  // Best effort: label the checkpoint with the revision it depicts. Absence is
  // stated in the draft instead of guessed.
  useEffect(() => {
    const checkpointId = context.checkpointId;
    if (!checkpointId) return;
    let cancelled = false;
    designApi
      .history(environmentId, context.canvasId, 0, 50)
      .then((page) => {
        const entry = page?.entries?.find((candidate) => candidate.id === checkpointId);
        if (!cancelled && entry) {
          setCheckpoint({ revision: entry.canvasRevisionAfter, label: entry.label });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [context.canvasId, context.checkpointId, environmentId]);

  const tabs = useMemo(() => {
    const map = new Map<string, TabInfo>();
    if (!paneEnvironment) return map;
    for (const tab of usePaneLayoutStore.getState().getAllTabs(environmentId)) map.set(tab.id, tab);
    return map;
  }, [environmentId, paneEnvironment]);

  const links = useMemo(() => {
    const byId = new Map<string, DesignSessionLink>();
    for (const link of projection?.workspace?.sessions ?? []) byId.set(link.id, link);
    for (const link of addedLinks) if (!byId.has(link.id)) byId.set(link.id, link);
    return orderDesignSessionLinks([...byId.values()].filter((link) => !removedLinks.has(link.id)));
  }, [addedLinks, projection?.workspace?.sessions, removedLinks]);

  const statusOf = (link: DesignSessionLink): LinkStatus => {
    if (!hydrated) return "checking";
    return tabs.get(link.tabId)?.type === "agent-native" ? "open" : "closed";
  };
  const openLinks = links.filter((link) => statusOf(link) === "open");
  const [destination, setDestination] = useState<Destination>(() =>
    openLinks[0] ? { kind: "link", linkId: openLinks[0].id } : { kind: "new" },
  );
  const destinationLink =
    destination.kind === "link"
      ? openLinks.find((link) => link.id === destination.linkId)
      : undefined;
  const effectiveDestination: Destination =
    destination.kind === "link" && !destinationLink ? { kind: "new" } : destination;
  const linksFull = links.length >= DESIGN_SESSION_LINK_LIMIT;
  const needsReplacement = effectiveDestination.kind === "new" && linksFull;
  const replacement = needsReplacement ? links.find((link) => link.id === replaceId) : undefined;

  const reference: DesignContextPayload = useMemo(
    () =>
      boundDesignContextReference({
        ...context,
        scope,
        ...(context.checkpointId && checkpoint ? { checkpointRevision: checkpoint.revision } : {}),
      }),
    [checkpoint, context, scope],
  );
  const handoff = scope === "implement";
  const chosenFrames = frames.filter((frame) => selectedFrames.has(frame.id));
  const stale = currentRevision !== context.canvasRevision;

  const canSubmit =
    !pending &&
    (!handoff || chosenFrames.length > 0) &&
    (!needsReplacement || replacement !== undefined) &&
    (effectiveDestination.kind === "link" ? destinationLink !== undefined : createTab !== null);

  const buildAddition = (): DesignDraftAddition => {
    const id = createUniqueTabId("design-context");
    if (!handoff) {
      return {
        annotation: buildDesignContextAnnotation({ id, reference, note }),
        requestText: defaultDesignRequest(reference),
      };
    }
    const draft = buildDesignHandoffDraft({
      id,
      canvasId: context.canvasId,
      canvasName: context.canvasName,
      environmentId,
      frames: chosenFrames.map((frame) => ({
        frameId: frame.id,
        name: frame.name,
        revision: frame.revision,
        width: frame.width,
        height: frame.height,
      })),
      revision:
        revisionChoice === "checkpoint" && context.checkpointId
          ? {
              kind: "checkpoint",
              checkpointId: context.checkpointId,
              ...(checkpoint
                ? { canvasRevision: checkpoint.revision, label: checkpoint.label }
                : {}),
            }
          : { kind: "current", canvasRevision: currentRevision },
      brief,
    });
    return { annotation: draft.annotation, appendText: draft.text };
  };

  /** Returns false when the draft could not be changed. */
  const applyDraft = (
    tabId: string,
    addition: DesignDraftAddition,
    inlineText: boolean,
  ): boolean => {
    const sessionKey = createSessionKey(environmentId, tabId);
    const current = nativeComposeDraft(useNativeComposeStore.getState(), sessionKey);
    const plan = planDesignDraft(current, addition, { inlineText });
    if (!plan.ok) {
      setError(
        "That conversation's composer already has the maximum number of attachments. Send or remove some first.",
      );
      return false;
    }
    if (Object.keys(plan.patch).length > 0) updateDraft(sessionKey, plan.patch);
    return true;
  };

  const addToExisting = (link: DesignSessionLink) => {
    const tab = usePaneLayoutStore
      .getState()
      .getAllTabs(environmentId)
      .find((candidate) => candidate.id === link.tabId);
    if (!tab || tab.type !== "agent-native") {
      setError("That conversation has ended. Start a new conversation instead.");
      return;
    }
    // A conversation whose provider is not chosen yet sends text only.
    const inlineText = !tab.nativeAgentData?.platform;
    if (!applyDraft(link.tabId, buildAddition(), inlineText)) return;
    focusTab(environmentId, link.tabId);
    toast.success(
      handoff
        ? "Handoff draft added — review it before sending"
        : "Design context added to the composer",
    );
    onClose();
  };

  const startNew = async () => {
    if (!createTab) {
      setError("Open this design in the active environment to start a conversation.");
      return;
    }
    const addition = buildAddition();
    const tabId = createUniqueTabId("design-chat");
    const role = designRoleForScope(scope);
    const title = role === "implementation" ? "Implement design" : "Design chat";
    // No initial prompt: the design context becomes a reviewable draft.
    const created = createTab(agent, { tabId, agentLaunchMode: "native", displayTitle: title });
    if (!created || !usePaneLayoutStore.getState().findPaneWithTab(tabId, environmentId)) {
      setError("Could not open a new conversation. Close a tab or pane and try again.");
      return;
    }
    applyDraft(tabId, addition, true);
    try {
      const link = await designApi.linkSession(
        environmentId,
        context.canvasId,
        {
          tabId,
          platform: agent,
          role,
          label: title,
          ...(handoff && revisionChoice === "checkpoint" && context.checkpointId
            ? { checkpointId: context.checkpointId }
            : {}),
        },
        replacement?.id,
      );
      setAddedLinks((current) => [...current, link]);
      if (replacement) setRemovedLinks((current) => new Set([...current, replacement.id]));
      onLinksChanged?.();
      toast.success(
        handoff
          ? "Handoff draft ready — review it before sending"
          : "New conversation ready with design context",
      );
    } catch (reason) {
      // The tab and its draft stay usable; only the association is missing.
      toast.error("Conversation opened, but it could not be linked to this design", {
        description: messageOf(reason),
      });
    }
    focusTab(environmentId, tabId);
    onClose();
  };

  const submit = async () => {
    if (pendingRef.current || !canSubmit) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (effectiveDestination.kind === "link" && destinationLink) addToExisting(destinationLink);
      else await startNew();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const removeLink = async (link: DesignSessionLink) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await designApi.unlinkSession(environmentId, context.canvasId, link.id);
      setRemovedLinks((current) => new Set([...current, link.id]));
      onLinksChanged?.();
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const summary = designContextSummaryLines(reference);
  const actionLabel =
    effectiveDestination.kind === "new"
      ? "Start a new conversation"
      : handoff
        ? "Add handoff to composer"
        : "Add to composer";

  return (
    <DialogContent className="max-h-[min(90vh,48rem)] overflow-y-auto sm:max-w-[min(40rem,calc(100%-2rem))]">
      <DialogHeader>
        <DialogTitle>
          {handoff ? "Hand off design for implementation" : "Ask agent about this design"}
        </DialogTitle>
        <DialogDescription>
          Context is added to a conversation&apos;s unsent draft. Review it and press Send yourself.
        </DialogDescription>
      </DialogHeader>

      <section aria-label="Design context" className="space-y-2 text-sm">
        <div
          data-testid="design-context-chip"
          className="rounded-md border border-blue-400/30 bg-blue-500/10 px-3 py-2 text-xs"
        >
          <p className="font-medium text-blue-100">Design context</p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {summary.map((line) => (
              <li key={line} className="break-words">
                {line}
              </li>
            ))}
          </ul>
        </div>
        {stale ? (
          <p className="text-xs text-amber-300" role="status">
            The design is now at revision {currentRevision}. This context states revision{" "}
            {context.canvasRevision}; the agent is asked to re-read the current design.
          </p>
        ) : null}
        <SegmentedSelector
          ariaLabel="Scope"
          value={scope}
          options={SCOPE_OPTIONS}
          onValueChange={setScope}
          disabled={pending}
        />
      </section>

      {handoff ? (
        <section aria-label="Handoff" className="space-y-3 text-sm">
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-muted-foreground">
              Frames (up to {DESIGN_HANDOFF_MAX_FRAMES})
            </legend>
            {frames.length === 0 ? (
              <p className="text-xs text-muted-foreground">This design has no frames.</p>
            ) : null}
            {frames.map((frame) => {
              const checked = selectedFrames.has(frame.id);
              const atLimit = !checked && selectedFrames.size >= DESIGN_HANDOFF_MAX_FRAMES;
              return (
                <label key={frame.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={pending || atLimit}
                    onChange={() =>
                      setSelectedFrames((current) => {
                        const next = new Set(current);
                        if (next.has(frame.id)) next.delete(frame.id);
                        else if (next.size < DESIGN_HANDOFF_MAX_FRAMES) next.add(frame.id);
                        return next;
                      })
                    }
                  />
                  <span className="truncate">{frame.name}</span>
                </label>
              );
            })}
          </fieldset>
          {context.checkpointId ? (
            <fieldset className="space-y-1">
              <legend className="text-xs font-medium text-muted-foreground">Revision</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="design-handoff-revision"
                  checked={revisionChoice === "checkpoint"}
                  onChange={() => setRevisionChoice("checkpoint")}
                  disabled={pending}
                />
                <span>
                  Checkpoint
                  {checkpoint ? ` — ${checkpoint.label} (revision ${checkpoint.revision})` : ""}
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="design-handoff-revision"
                  checked={revisionChoice === "current"}
                  onChange={() => setRevisionChoice("current")}
                  disabled={pending}
                />
                <span>Current (revision {currentRevision})</span>
              </label>
            </fieldset>
          ) : null}
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Brief (optional)</span>
            <Textarea
              value={brief}
              maxLength={4_000}
              onChange={(event) => setBrief(event.target.value)}
              placeholder="What should be built, and where?"
              disabled={pending}
            />
          </label>
        </section>
      ) : (
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            Note for the agent (optional)
          </span>
          <Textarea
            value={note}
            maxLength={2_000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What would you like to know or change?"
            disabled={pending}
          />
        </label>
      )}

      <section aria-label="Linked conversations" className="space-y-2 text-sm">
        <h3 className="text-xs font-medium text-muted-foreground">Linked conversations</h3>
        {links.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No conversations are linked to this design yet.
          </p>
        ) : (
          <ul className="space-y-1">
            {links.map((link) => {
              const status = statusOf(link);
              const tab = tabs.get(link.tabId);
              const title = linkTitle(link, tab);
              return (
                <li
                  key={link.id}
                  data-testid={`design-link-${link.id}`}
                  className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
                >
                  {status === "open" ? (
                    <input
                      type="radio"
                      name="design-agent-destination"
                      aria-label={`Send to ${title}`}
                      checked={
                        effectiveDestination.kind === "link" &&
                        effectiveDestination.linkId === link.id
                      }
                      onChange={() => setDestination({ kind: "link", linkId: link.id })}
                      disabled={pending}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{title}</p>
                    <p className="text-xs text-muted-foreground">
                      {platformLabel(link.platform)} ·{" "}
                      {link.role === "implementation" ? "Implementation" : "Design"}
                      {status === "closed" ? " · Closed — conversation ended" : ""}
                      {status === "checking" ? " · Checking…" : ""}
                    </p>
                  </div>
                  {status === "open" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        if (focusTab(environmentId, link.tabId)) onClose();
                      }}
                    >
                      Open
                    </Button>
                  ) : null}
                  {status === "closed" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      aria-label={`Remove link to ${title}`}
                      onClick={() => void removeLink(link)}
                    >
                      Remove link
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-2 py-1.5">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="design-agent-destination"
              checked={effectiveDestination.kind === "new"}
              onChange={() => setDestination({ kind: "new" })}
              disabled={pending}
            />
            <span>New conversation</span>
          </label>
          <SegmentedSelector
            ariaLabel="Agent"
            value={agent}
            options={AGENT_OPTIONS}
            onValueChange={(value) => {
              setAgent(value);
              setDestination({ kind: "new" });
            }}
            disabled={pending}
          />
        </div>
        {needsReplacement ? (
          <fieldset className="space-y-1" aria-label="Replace a linked conversation">
            <legend className="text-xs text-amber-300">
              This design already links {DESIGN_SESSION_LINK_LIMIT} conversations. Choose one link
              to replace (its conversation is not closed).
            </legend>
            {links.map((link) => (
              <label key={link.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="design-link-replace"
                  checked={replaceId === link.id}
                  onChange={() => setReplaceId(link.id)}
                  disabled={pending}
                />
                <span className="truncate">
                  {linkTitle(link, tabs.get(link.tabId))}
                  {statusOf(link) === "closed" ? " (closed)" : ""}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={!canSubmit}>
          {actionLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
