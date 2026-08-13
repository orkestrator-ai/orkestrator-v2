import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import {
  adoptNativeAgentSession,
  awaitBridgeReady,
  dispatchNativeAgentPrompt,
  ensureNativeAgentSession,
} from "@/lib/backend";
import {
  cancelAcpPrompt,
  createAcpClient,
  getAcpMessageWindow,
  getAcpSession,
  getAcpApprovals,
  mergeAcpMessageWindow,
  resolveAcpApproval,
  type AcpClient,
  type AcpSessionSnapshot,
  type AcpApproval,
} from "@/lib/acp-client";
import type { AcpNativeData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import { useVirtuosoScrollState } from "@/hooks";
import type { NativeMessage } from "@/lib/chat/native-message-types";

interface AcpChatTabProps {
  tabId: string;
  data: AcpNativeData;
  isActive: boolean;
  initialPrompt?: string;
}

export function AcpChatTab({ tabId, data, isActive, initialPrompt }: AcpChatTabProps) {
  const [client, setClient] = useState<AcpClient | null>(null);
  const [session, setSession] = useState<AcpSessionSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [approvals, setApprovals] = useState<AcpApproval[]>([]);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the mount handshake after a failed connect. Without
  // it a transient bridge failure would leave the tab permanently dead: the
  // component stays mounted while hidden, so no later activation re-runs the
  // effect and submit is a no-op without a client and session.
  const [connectNonce, setConnectNonce] = useState(0);
  const sentInitialPrompt = useRef(false);
  const pendingManualRequest = useRef<{ prompt: string; requestId: string } | null>(null);
  const dispatchingPrompt = useRef(false);
  const updateTabNativeSessionId = usePaneLayoutStore((state) => state.updateTabNativeSessionId);
  const clearTabInitialPrompt = usePaneLayoutStore((state) => state.clearTabInitialPrompt);
  const backendOwnsStartupPrompt = useEnvironmentStore((state) => {
    if (tabId !== "startup-agent") return false;
    const environment = state.getEnvironmentById(data.environmentId);
    return environment?.pendingAgentLaunch === true
      || environment?.startupAgentSession !== undefined;
  });
  const label = data.provider === "cursor" ? "Cursor Agent" : "Grok Build";
  const sessionKey = `env-${data.environmentId}:${tabId}`;
  const { isAtBottom, scrollToBottom, virtuosoRef, scrollProps } = useVirtuosoScrollState({
    isActive,
    persistKey: sessionKey,
    environmentId: data.environmentId,
    stickToBottomOnActivation: true,
  });

  // Revision of the last snapshot whose approvals were fetched. Every state
  // change on the bridge bumps `revision`, so approvals only need re-reading
  // when it moves — which keeps the streaming poll to one small request.
  const approvalsRevision = useRef<number | null>(null);
  // The read cursor has to advance synchronously: `refresh` runs on an interval
  // and awaits, so reading it from render state would let two overlapping polls
  // request the same window and clobber each other's merge.
  const sessionRef = useRef<AcpSessionSnapshot | null>(null);
  const refreshing = useRef(false);

  const applySession = useCallback((next: AcpSessionSnapshot | null) => {
    sessionRef.current = next;
    setSession(next);
    setError(next?.error ?? null);
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        setConnecting(true);
        const ready = await awaitBridgeReady(data.environmentId, data.provider);
        if (ready.status !== "ready") throw new Error(ready.error.message);
        const nextClient = createAcpClient(`http://127.0.0.1:${ready.port}`, ready.authToken);
        const sessionInput = {
          environmentId: data.environmentId,
          agent: data.provider,
          logicalSessionKey: sessionKey,
          origin: "interactive-native" as const,
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        };
        const mapped = data.sessionId
          ? await adoptNativeAgentSession({
              ...sessionInput,
              providerSessionId: data.sessionId,
            })
          : await ensureNativeAgentSession({ ...sessionInput, title: label });
        const [nextSession, pendingApprovals] = await Promise.all([
          getAcpSession(nextClient, mapped.providerSessionId),
          getAcpApprovals(nextClient, mapped.providerSessionId),
        ]);
        if (!mounted) return;
        setClient(nextClient);
        // A full snapshot on mount is the authoritative rehydration: the tab
        // may have been unmounted for an entire turn, so live polling only ever
        // resumes from state the bridge just handed us.
        approvalsRevision.current = nextSession.revision;
        applySession(nextSession);
        setApprovals(pendingApprovals);
        updateTabNativeSessionId(tabId, nextSession.id, data.environmentId);
      } catch (caught) {
        if (mounted) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mounted) setConnecting(false);
      }
    })();
    return () => { mounted = false; };
  }, [applySession, connectNonce, data.environmentId, data.provider, data.sessionId, label, sessionKey, tabId, updateTabNativeSessionId]);

  const refresh = useCallback(async () => {
    const current = sessionRef.current;
    if (!client || !current || refreshing.current) return;
    refreshing.current = true;
    try {
      // Re-request our own last message: it is the only one that mutates as
      // chunks arrive. Everything before it is already final on the client.
      const slice = await getAcpMessageWindow(
        client,
        current.id,
        current.baseIndex + Math.max(0, current.messages.length - 1),
      );
      const latest = sessionRef.current;
      if (!latest || latest.id !== current.id) return;
      applySession({
        ...latest,
        ...mergeAcpMessageWindow(latest, slice),
        status: slice.status,
        error: slice.error,
        revision: slice.revision,
      });
      if (approvalsRevision.current !== slice.revision) {
        approvalsRevision.current = slice.revision;
        setApprovals(await getAcpApprovals(client, current.id));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      refreshing.current = false;
    }
  }, [applySession, client]);

  useEffect(() => {
    if (!client || !session) return;
    const interval = window.setInterval(() => void refresh(), session.status === "running" ? 350 : 1_500);
    return () => window.clearInterval(interval);
  }, [client, refresh, session?.status]);

  const submit = useCallback(async (text: string, fixedRequestId?: string) => {
    const prompt = text.trim();
    if (!client || !session || !prompt || session.status === "running" || dispatchingPrompt.current) return false;
    const pending = pendingManualRequest.current;
    const requestId = fixedRequestId
      ?? (pending?.prompt === prompt ? pending.requestId : crypto.randomUUID());
    if (!fixedRequestId) pendingManualRequest.current = { prompt, requestId };
    dispatchingPrompt.current = true;
    setDraft("");
    try {
      await dispatchNativeAgentPrompt({
        environmentId: data.environmentId,
        agent: data.provider,
        logicalSessionKey: sessionKey,
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        title: label,
        prompt,
        requestId,
      });
      await refresh();
      if (!fixedRequestId) pendingManualRequest.current = null;
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDraft(prompt);
      return false;
    } finally {
      dispatchingPrompt.current = false;
    }
  }, [client, data.environmentId, data.provider, label, refresh, session, sessionKey]);

  useEffect(() => {
    if (backendOwnsStartupPrompt && initialPrompt) {
      clearTabInitialPrompt(tabId, data.environmentId);
      return;
    }
    if (!client || !session || sentInitialPrompt.current || !initialPrompt?.trim()) return;
    sentInitialPrompt.current = true;
    const requestId = `initial-prompt:${data.environmentId}:${tabId}`;
    void submit(initialPrompt, requestId).then((accepted) => {
      if (accepted) clearTabInitialPrompt(tabId, data.environmentId);
      else sentInitialPrompt.current = false;
    });
  }, [
    backendOwnsStartupPrompt,
    clearTabInitialPrompt,
    client,
    data.environmentId,
    initialPrompt,
    session,
    submit,
    tabId,
  ]);

  const messages = useMemo<NativeMessage[]>(() => (session?.messages ?? []).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    parts: message.parts.map((part, index) => ({
      type: part.type === "reasoning" ? "thinking" as const : "text" as const,
      content: part.text,
      sourcePartId: `${message.id}:${index}`,
      sourceMessageId: message.id,
    })),
  })), [session?.messages]);

  const connectionState = connecting
    ? "connecting" as const
    : session
      ? "connected" as const
      : "error" as const;

  return (
    <NativeChatShell
      agentExpansionScope={data.environmentId}
      agentLabel={label}
      isActive={isActive}
      connectionState={connectionState}
      errorMessage={error}
      onRetry={() => setConnectNonce((nonce) => nonce + 1)}
      messages={messages}
      isLoading={session?.status === "running"}
      elapsedSeconds={null}
      finalElapsedSeconds={null}
      centerCompose={false}
      emptyStateMessage={`Ask ${label} to work on this repository.`}
      isAtBottom={isAtBottom}
      scrollToBottom={scrollToBottom}
      scrollProps={scrollProps}
      virtuosoRef={virtuosoRef}
      blockingCards={approvals.map((approval) => (
        <div key={approval.id} className="rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
          <p className="font-medium text-amber-100">{approval.title}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {approval.options.map((option) => (
              <Button
                key={option.optionId}
                size="sm"
                variant={option.kind === "reject_once" || option.kind === "reject_always" ? "outline" : "default"}
                onClick={() => client && session && void resolveAcpApproval(client, session.id, approval.id, option.optionId).then(refresh)}
              >
                {option.name}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => client && session && void resolveAcpApproval(client, session.id, approval.id).then(refresh)}>Deny</Button>
          </div>
        </div>
      ))}
      pinnedAccessory={session && error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      composer={
        <div className="mx-auto mb-4 mt-2 w-[calc(100%_-_0.75rem)] shrink-0 rounded-2xl border border-border/70 bg-zinc-900/90 p-3 shadow-xl shadow-black/20 sm:w-[min(calc(100%_-_2rem),56rem)]">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit(draft);
              }
            }}
            placeholder={`Message ${label}`}
            className="min-h-14 resize-none border-0 bg-transparent px-1 py-2 shadow-none focus-visible:ring-0"
            disabled={!session}
          />
          <div className="flex items-center justify-end pt-1">
            {session?.status === "running" ? (
              <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full bg-destructive/10 text-destructive hover:bg-destructive/20" aria-label="Stop" onClick={() => client && void cancelAcpPrompt(client, session.id)}><Square className="h-4 w-4 fill-current" /></Button>
            ) : (
              <Button size="icon" variant="ghost" className="h-8 w-8 rounded-full bg-muted hover:bg-muted/80" aria-label="Send" disabled={!draft.trim() || !session} onClick={() => void submit(draft)}><ArrowUp className="h-4 w-4" /></Button>
            )}
          </div>
        </div>
      }
    />
  );
}
