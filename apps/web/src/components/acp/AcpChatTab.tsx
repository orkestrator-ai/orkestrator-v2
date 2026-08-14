import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { NativeAgentData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import { NativeComposeBar } from "@/components/chat/NativeComposeBar";
import type { MentionableInputRef } from "@/components/chat/MentionableInput";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { NativeChatShell } from "@/components/chat/NativeChatShell";
import { useVirtuosoScrollState } from "@/hooks";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { normalizeNativeMessages } from "@/lib/chat/native-message-adapters";
import type { FileMention } from "@/types";

// A reconnect runs the full readiness handshake, which for a container
// environment performs Docker work in the backend. The first failure recovers
// immediately — that is the common stale-generation case — but a bridge that
// keeps failing must not drive one handshake per poll.
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8_000;

function reconnectDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1),
    RECONNECT_MAX_DELAY_MS,
  );
}

interface AcpChatTabProps {
  tabId: string;
  data: NativeAgentData & { platform: "cursor" | "grok" };
  isActive: boolean;
  initialPrompt?: string;
}

export function AcpChatTab({ tabId, data, isActive, initialPrompt }: AcpChatTabProps) {
  const [client, setClient] = useState<AcpClient | null>(null);
  const [session, setSession] = useState<AcpSessionSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [mentions, setMentions] = useState<FileMention[]>([]);
  const [dispatching, setDispatching] = useState(false);
  const [approvals, setApprovals] = useState<AcpApproval[]>([]);
  const [connecting, setConnecting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the mount handshake after a failed connect. Without
  // it a transient bridge failure would leave the tab permanently dead: the
  // component stays mounted while hidden, so no later activation re-runs the
  // effect and submit is a no-op without a client and session.
  const [connectNonce, setConnectNonce] = useState(0);
  // A bridge restart changes its port and/or bearer credential. Direct ACP
  // polling is intentionally renderer-owned, so a failed request must retire
  // that client and re-run the authoritative backend readiness handshake.
  const reconnecting = useRef(false);
  // Consecutive reconnects since the last poll that actually succeeded. A
  // successful handshake does not reset it: the failure mode this bounds is a
  // bridge that hands out working coordinates and then fails every read.
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const sentInitialPrompt = useRef(false);
  const pendingManualRequest = useRef<{ prompt: string; requestId: string } | null>(null);
  const dispatchingPrompt = useRef(false);
  const inputRef = useRef<MentionableInputRef>(null);
  const inputContainerRef = useRef<HTMLDivElement>(null);
  const updateTabNativeSessionId = usePaneLayoutStore((state) => state.updateTabNativeSessionId);
  const clearTabInitialPrompt = usePaneLayoutStore((state) => state.clearTabInitialPrompt);
  const backendOwnsStartupPrompt = useEnvironmentStore((state) => {
    if (tabId !== "startup-agent") return false;
    const environment = state.getEnvironmentById(data.environmentId);
    return environment?.pendingAgentLaunch === true
      || environment?.startupAgentSession !== undefined;
  });
  const label = data.platform === "cursor" ? "Cursor Agent" : "Grok Build";
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

  // A pending reconnect must not outlive the tab. Unmount is the one case
  // where dropping the retry is correct: there is no component left to
  // rehydrate, and the backend keeps the session running regardless.
  useEffect(() => () => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  const applySession = useCallback((next: AcpSessionSnapshot | null) => {
    sessionRef.current = next;
    setSession(next);
    setError(next?.error ?? null);
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        reconnecting.current = true;
        setConnecting(true);
        const ready = await awaitBridgeReady(data.environmentId, data.platform);
        if (ready.status !== "ready") throw new Error(ready.error.message);
        const nextClient = createAcpClient(`http://127.0.0.1:${ready.port}`, ready.authToken);
        const sessionInput = {
          environmentId: data.environmentId,
          agent: data.platform,
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
        if (mounted) {
          reconnecting.current = false;
          setConnecting(false);
        }
      }
    })();
    return () => { mounted = false; };
  }, [applySession, connectNonce, data.environmentId, data.platform, data.sessionId, label, sessionKey, tabId, updateTabNativeSessionId]);

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
      reconnectAttempts.current = 0;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      if (!reconnecting.current) {
        reconnecting.current = true;
        // Removing the stale client also stops the polling effect before the
        // replacement handshake starts. Keep the last session snapshot in
        // memory so the successful handshake can replace it atomically.
        setClient(null);
        setConnecting(true);
        const delay = reconnectDelayMs(reconnectAttempts.current);
        reconnectAttempts.current += 1;
        if (reconnectTimer.current !== null) {
          window.clearTimeout(reconnectTimer.current);
        }
        reconnectTimer.current = window.setTimeout(() => {
          reconnectTimer.current = null;
          setConnectNonce((nonce) => nonce + 1);
        }, delay);
      }
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
    setDispatching(true);
    setDraft("");
    setMentions([]);
    try {
      await dispatchNativeAgentPrompt({
        environmentId: data.environmentId,
        agent: data.platform,
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
      setDispatching(false);
    }
  }, [client, data.environmentId, data.platform, label, refresh, session, sessionKey]);

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

  const messages = useMemo<NativeMessage[]>(
    () => normalizeNativeMessages(session?.messages ?? []),
    [data.platform, session?.messages],
  );

  // An explicit retry is a fresh start: drop any backed-off attempt so the
  // user's click reconnects now rather than waiting out the current delay,
  // and do not let that pending timer fire a second handshake behind it.
  const retry = useCallback(() => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    reconnectAttempts.current = 0;
    setConnectNonce((nonce) => nonce + 1);
  }, []);

  const connectionState = connecting
    ? "connecting" as const
    : client && session
      ? "connected" as const
      : "error" as const;

  return (
    <NativeChatShell
      agentExpansionScope={data.environmentId}
      agentLabel={label}
      isActive={isActive}
      connectionState={connectionState}
      errorMessage={error}
      onRetry={retry}
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
        <NativeComposeBar
          testId="acp-native-compose-bar"
          attachments={[]}
          onRemoveAttachment={() => undefined}
          inputRef={inputRef}
          inputContainerRef={inputContainerRef}
          text={draft}
          mentions={mentions}
          onTextAndMentionsChange={(text, nextMentions) => {
            setDraft(text);
            setMentions(nextMentions);
          }}
          onCursorPositionChange={() => undefined}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter"
              || event.shiftKey
              || event.nativeEvent.isComposing
            ) return;
            event.preventDefault();
            void submit(draft);
          }}
          placeholder={`Message ${label}`}
          disabled={!session}
          isSending={dispatching}
          isLoading={session?.status === "running"}
          primaryControls={null}
          onStop={() => client && session
            ? cancelAcpPrompt(client, session.id)
            : undefined}
          showSendButton={session?.status !== "running"}
          sendDisabled={!session || dispatching || !draft.trim()}
          sendTitle="Send"
          onSend={() => void submit(draft)}
        />
      }
    />
  );
}
