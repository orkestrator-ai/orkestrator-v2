import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Send, Square } from "lucide-react";
import { awaitBridgeReady, ensureNativeAgentSession } from "@/lib/backend";
import {
  cancelAcpPrompt,
  createAcpClient,
  getAcpSession,
  getAcpApprovals,
  resolveAcpApproval,
  sendAcpPrompt,
  type AcpClient,
  type AcpSessionSnapshot,
  type AcpApproval,
} from "@/lib/acp-client";
import type { AcpNativeData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CursorAgentIcon, GrokBuildIcon } from "@/components/icons/AgentIcons";
import { cn } from "@/lib/utils";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { INTERACTIVE_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";

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
  const sentInitialPrompt = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const updateTabNativeSessionId = usePaneLayoutStore((state) => state.updateTabNativeSessionId);
  const label = data.provider === "cursor" ? "Cursor Agent" : "Grok Build";
  const Icon = data.provider === "cursor" ? CursorAgentIcon : GrokBuildIcon;

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        setConnecting(true);
        const ready = await awaitBridgeReady(data.environmentId, data.provider);
        if (ready.status !== "ready") throw new Error(ready.error.message);
        const nextClient = createAcpClient(`http://127.0.0.1:${ready.port}`, ready.authToken);
        const mapped = await ensureNativeAgentSession({
          environmentId: data.environmentId,
          agent: data.provider,
          logicalSessionKey: `env-${data.environmentId}:${tabId}`,
          origin: "interactive-native",
          interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
          title: label,
        });
        const nextSession = await getAcpSession(nextClient, mapped.providerSessionId);
        if (!mounted) return;
        setClient(nextClient);
        setSession(nextSession);
        setError(null);
        updateTabNativeSessionId(tabId, nextSession.id, data.environmentId);
      } catch (caught) {
        if (mounted) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (mounted) setConnecting(false);
      }
    })();
    return () => { mounted = false; };
  }, [data.environmentId, data.provider, data.sessionId, tabId, updateTabNativeSessionId]);

  const refresh = useCallback(async () => {
    if (!client || !session) return;
    try {
      const [next, pendingApprovals] = await Promise.all([
        getAcpSession(client, session.id),
        getAcpApprovals(client, session.id),
      ]);
      setSession(next);
      setApprovals(pendingApprovals);
      setError(next.error ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [client, session?.id]);

  useEffect(() => {
    if (!client || !session) return;
    const interval = window.setInterval(() => void refresh(), session.status === "running" ? 350 : 1_500);
    return () => window.clearInterval(interval);
  }, [client, refresh, session?.status]);

  const submit = useCallback(async (text: string) => {
    const prompt = text.trim();
    if (!client || !session || !prompt || session.status === "running") return;
    setDraft("");
    try {
      await sendAcpPrompt(client, session.id, prompt);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setDraft(prompt);
    }
  }, [client, refresh, session]);

  useEffect(() => {
    if (!client || !session || sentInitialPrompt.current || !initialPrompt?.trim()) return;
    sentInitialPrompt.current = true;
    void submit(initialPrompt);
  }, [client, initialPrompt, session, submit]);

  useEffect(() => {
    if (isActive) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [isActive, session?.revision]);

  if (connecting) {
    return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Connecting to {label}…</div>;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2 text-sm font-medium">
        <Icon className="h-4 w-4" />
        {label}
        <span className={cn("ml-auto text-xs", session?.status === "error" ? "text-destructive" : "text-muted-foreground")}>
          {session?.status ?? "disconnected"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {!session?.messages.length && !error && (
            <div className="py-20 text-center text-sm text-muted-foreground">Ask {label} to work on this repository.</div>
          )}
          {session?.messages.map((message) => (
            <div key={message.id} className={cn("max-w-[88%] rounded-xl px-4 py-3 text-sm", message.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "mr-auto border bg-card")}>
              {message.parts.map((part, index) => part.type === "reasoning" ? (
                <details key={index} className="mb-2 text-muted-foreground"><summary className="cursor-pointer text-xs">Reasoning</summary><pre className="mt-2 whitespace-pre-wrap font-sans">{part.text}</pre></details>
              ) : <div key={index} className="whitespace-pre-wrap">{part.text}</div>)}
            </div>
          ))}
          {approvals.map((approval) => (
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
          {session?.status === "running" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          {error && <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</div>}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
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
            className="min-h-11 resize-none"
            disabled={!session}
          />
          {session?.status === "running" ? (
            <Button size="icon" variant="outline" aria-label="Stop" onClick={() => client && void cancelAcpPrompt(client, session.id)}><Square className="h-4 w-4" /></Button>
          ) : (
            <Button size="icon" aria-label="Send" disabled={!draft.trim() || !session} onClick={() => void submit(draft)}><Send className="h-4 w-4" /></Button>
          )}
        </div>
      </div>
    </div>
  );
}
