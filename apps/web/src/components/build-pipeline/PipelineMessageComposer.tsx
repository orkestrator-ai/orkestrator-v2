import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  type PipelineQueuedSteerDelivery,
} from "@orkestrator/protocol/build-pipeline";
import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  SESSION_ACTION_SLASH_COMMANDS,
  parseLeadingSlashCommand,
} from "@orkestrator/protocol/agent-slash-commands";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import type * as backend from "@/lib/backend";
import { COMPOSER_OCCUPIED_MESSAGE } from "@/lib/prompt-queue-errors";
import {
  QueuedPromptStack,
  type NativeComposeQueueState,
  type QueuedPromptStackHandle,
} from "@/components/chat/QueuedPromptStack";
import { shouldAutoSteer } from "@/components/native-agent/auto-steer";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useBuildPipelineStore,
  type BuildPipeline,
  type PipelineSession,
} from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/**
 * A slash or `$` command. The pipeline has no command catalogue to classify one
 * against, so anything shaped like a command waits for the agent's next turn
 * rather than being folded into this one as plain text.
 */
function looksLikeCommand(text: string): boolean {
  return parseLeadingSlashCommand(text) !== null || /^\$\S/.test(text.trim());
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type QueuedSteerNotice = { tone: "success" | "info" | "error"; message: string };

/**
 * What to tell the user after steering a queued message. A failed Steer click is
 * an error, because it was asked for directly. Auto-steer failing is only
 * information: the message is safe in the queue, as it would be with the
 * setting off.
 */
export function queuedSteerNotice(
  result: { delivery: PipelineQueuedSteerDelivery; notice?: string },
  label: string,
  source: "auto-steer" | "steer-button",
): QueuedSteerNotice {
  const auto = source === "auto-steer";
  switch (result.delivery) {
    case "steered":
      return { tone: "success", message: `Steered the active ${label} turn` };
    case "unconfirmed":
      return {
        tone: "error",
        message: result.notice ?? "Delivery could not be confirmed. Check the transcript.",
      };
    case "next-turn":
      return {
        tone: "info",
        message: `${label} has finished its turn, so your message will be sent as a new turn.`,
      };
    case "gone":
      return auto
        ? {
            tone: "info",
            message: `${label} finished the turn first, so your message was sent as the next turn.`,
          }
        : {
            tone: "error",
            message: "This message already left the queue, so it was not used to steer.",
          };
    default: {
      const reason = result.notice ?? "The running turn could not be steered.";
      return auto
        ? { tone: "info", message: `${reason} Your message was queued instead.` }
        : { tone: "error", message: `${reason} The message is still queued.` };
    }
  }
}

function showNotice(notice: QueuedSteerNotice): void {
  if (notice.tone === "success") toast.success(notice.message);
  else if (notice.tone === "info") toast.info(notice.message);
  else toast.error(notice.message);
}

export interface PipelineComposerState {
  draft: string;
  setDraft: (draft: string) => void;
  sendPending: boolean;
  messageBlocked: boolean;
  recoveredTexts: string[];
  backgroundMessageRefusal?: string;
  send: () => Promise<void>;
  sendTitle: string;
  queue: NativeComposeQueueState;
}

/**
 * The message box's state and actions, held by the transcript rather than by
 * the box so a draft survives while the box is hidden behind another view.
 *
 * Mirrors the native agent tab: with Auto-steer on, a plain message sent while a
 * turn runs is queued and then steered out of the queue, the same path as the
 * queue's own Steer button, so anything short of a delivered steer leaves it
 * queued. With it off, the message waits in the queue with a Steer button.
 */
export function usePipelineMessageComposer({
  pipeline,
  session,
  agent,
  agentLabel,
}: {
  pipeline: BuildPipeline;
  session: PipelineSession | undefined;
  /** The harness the session runs on, which may differ from the pipeline's build agent. */
  agent: string | undefined;
  agentLabel: string;
}): PipelineComposerState {
  const nodeBackend = useScopeBackend();
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  const autoSteerEnabled = useConfigStore((state) => state.config.global.autoSteer === true);
  const [draft, updateDraft] = useState("");
  const draftRef = useRef("");
  const setDraft = (text: string) => {
    draftRef.current = text;
    updateDraft(text);
  };
  const [recoveredTexts, setRecoveredTexts] = useState<string[]>([]);
  const retainText = (text: string) => {
    if (!draftRef.current.trim()) setDraft(text);
    else setRecoveredTexts((current) => (current.includes(text) ? current : [...current, text]));
  };
  const messageBlocked = Boolean(pipeline.validationRun && !pipeline.reviewPackage);
  const [sendPending, setSendPending] = useState(false);

  // A session waiting on background work stays `running`, but its turn is over:
  // a message goes out as a new turn and there is nothing to steer.
  const turnRunning =
    !["paused", "complete", "failed"].includes(pipeline.phase) &&
    session?.status === "running" &&
    !session.awaitingBackgroundWork;
  // The same gate the backend applies before it steers. A bridge that turns out
  // not to support steering is reported by the backend, and the message stays queued.
  const steerAvailable =
    !messageBlocked &&
    turnRunning &&
    !pipeline.pendingPromptAttempt &&
    isAgentPlatform(agent) &&
    nativeAgentCapabilities(agent).actions?.steer === true;
  const willAutoSteer = (text: string) =>
    shouldAutoSteer({
      enabled: autoSteerEnabled,
      steerAvailable,
      command: looksLikeCommand(text),
      preparedPrompt: false,
      text,
      attachments: [],
      pendingHandoff: false,
    });

  /** A message that may already be with the agent goes back in the box, not the queue. */
  const applySteerResult = (
    result: Awaited<ReturnType<typeof backend.steerQueuedBuildPipelineMessage>>,
    text: string,
    source: "auto-steer" | "steer-button",
  ) => {
    replacePipeline(result.pipeline);
    showNotice(queuedSteerNotice(result, agentLabel, source));
    if (result.delivery === "unconfirmed") {
      retainText(text);
    }
  };

  const queueThenSteer = async (text: string): Promise<void> => {
    const queued = await nodeBackend.sendBuildPipelineMessage(pipeline.id, text);
    // The backend owns the message from here on, so whatever happens to the steer
    // it must not also stay in the box to be sent again.
    setDraft("");
    const priorIds = new Set(pipeline.pendingUserMessages?.map((entry) => entry.id));
    const message = queued.pendingUserMessages?.findLast(
      (entry) => entry.text === text && !priorIds.has(entry.id),
    );
    if (!message) {
      replacePipeline(queued);
      showNotice(queuedSteerNotice({ delivery: "gone" }, agentLabel, "auto-steer"));
      return;
    }
    try {
      const result = await nodeBackend.steerQueuedBuildPipelineMessage(pipeline.id, message.id);
      applySteerResult(result, text, "auto-steer");
    } catch (error) {
      replacePipeline(queued);
      toast.error(
        `Your message was saved to the queue, but steering could not be confirmed. Check the queue before sending it again. ${errorText(error)}`,
      );
    }
  };

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sendPending || messageBlocked) return;
    // `/steer` reaches the turn the agent is running now. Queueing it like a
    // message would hold it until the agent goes idle, which in a pipeline is
    // when the stage ends and the work moves on to review.
    const command = parseLeadingSlashCommand(text);
    const steer = command?.name === "/steer";
    if (steer && !command.arguments?.trim()) {
      toast.error(SESSION_ACTION_SLASH_COMMANDS["/steer"]!.requiresArguments);
      return;
    }
    setSendPending(true);
    try {
      if (steer) {
        const result = await nodeBackend.steerBuildPipeline(pipeline.id, command.arguments!.trim());
        replacePipeline(result.pipeline);
        if (result.delivery === "steered") {
          toast.success("Sent to the active turn");
        } else {
          toast.info("Could not steer the live turn, so the message was queued.");
        }
      } else if (willAutoSteer(text)) {
        await queueThenSteer(text);
        return;
      } else {
        replacePipeline(await nodeBackend.sendBuildPipelineMessage(pipeline.id, text));
      }
      // Cleared only after the backend has durably queued it, so a failed send
      // leaves the user's text in the box to retry rather than losing it.
      setDraft("");
    } catch (error) {
      toast.error("Failed to send the message", { description: errorText(error) });
    } finally {
      setSendPending(false);
    }
  };

  const steerQueued = async (message: { id: string; text: string }) => {
    try {
      const result = await nodeBackend.steerQueuedBuildPipelineMessage(pipeline.id, message.id);
      applySteerResult(result, message.text, "steer-button");
    } catch (error) {
      toast.error(`Could not steer the running turn: ${errorText(error)}`);
    }
  };

  const removeQueued = async (messageId: string): Promise<boolean> => {
    try {
      const result = await nodeBackend.removeQueuedBuildPipelineMessage(pipeline.id, messageId);
      replacePipeline(result.pipeline);
      if (!result.removed) {
        toast.error("This message already left the queue, so it can no longer be changed.");
      }
      return result.removed;
    } catch (error) {
      toast.error("Failed to update the queue", { description: errorText(error) });
      return false;
    }
  };

  const editQueued = async (message: { id: string; text: string }) => {
    // Loading it into the box would destroy anything already there.
    if (draft.trim()) {
      toast.error(COMPOSER_OCCUPIED_MESSAGE);
      return;
    }
    if (await removeQueued(message.id)) retainText(message.text);
  };

  const queued = pipeline.pendingUserMessages ?? [];
  const command = parseLeadingSlashCommand(draft);
  return {
    backgroundMessageRefusal: queued.length ? session?.backgroundMessageRefusal : undefined,
    draft,
    setDraft,
    sendPending,
    messageBlocked,
    recoveredTexts: Array.from(
      new Set([
        ...(pipeline.pendingUserSteers ?? []).map((entry) => entry.text),
        ...recoveredTexts,
      ]),
    ),
    send,
    sendTitle: messageBlocked
      ? "Validation is running against a fixed snapshot"
      : !turnRunning
        ? "Send message"
        : command?.name === "/steer"
          ? `Send to the current ${agentLabel} turn`
          : willAutoSteer(draft)
            ? `Steer the current ${agentLabel} turn`
            : "Add to queue",
    queue: {
      length: queued.length,
      items: queued.map((message) => ({
        id: message.id,
        text: message.text,
        onSteer:
          steerAvailable && !looksLikeCommand(message.text)
            ? () => steerQueued(message)
            : undefined,
        onEdit: () => editQueued(message),
        onRemove: () => removeQueued(message.id).then(() => undefined),
      })),
    },
  };
}

/**
 * The floating message box under a stage's transcript. The native tabs dock
 * their composer as a card rather than a bordered footer strip, so this matches
 * that shape, with the same queued-prompt strips on top of it.
 */
export function PipelineMessageComposer({ state }: { state: PipelineComposerState }) {
  const { draft, setDraft, sendPending, send, sendTitle, queue, messageBlocked, recoveredTexts } =
    state;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const queueStackRef = useRef<QueuedPromptStackHandle>(null);
  // Where the caret was when ArrowUp moved focus to the queued messages.
  const queueReturnCaretRef = useRef<number | null>(null);

  const returnFromQueue = (caret: "restore" | "end") => {
    const input = inputRef.current;
    if (!input) return;
    const offset = (caret === "restore" ? queueReturnCaretRef.current : null) ?? input.value.length;
    queueReturnCaretRef.current = null;
    input.focus();
    input.setSelectionRange(offset, offset);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "ArrowUp" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      const { selectionStart, selectionEnd, value } = event.currentTarget;
      if (
        selectionStart === selectionEnd &&
        !value.slice(0, selectionStart).includes("\n") &&
        queueStackRef.current?.enter()
      ) {
        event.preventDefault();
        queueReturnCaretRef.current = selectionStart;
      }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="mx-auto w-full max-w-[56rem]">
      {recoveredTexts.map((text) => (
        <details key={text} className="mb-2 rounded-lg border border-border bg-input-surface p-3">
          <summary>Retained message — check the transcript before sending again</summary>
          <p className="mt-2 whitespace-pre-wrap break-words select-text">{text}</p>
        </details>
      ))}
      {state.backgroundMessageRefusal && (
        <p role="status" className="mb-2 text-sm text-muted-foreground">
          Message queued: {state.backgroundMessageRefusal}. Waiting for background work to finish or
          stop.
        </p>
      )}
      <QueuedPromptStack ref={queueStackRef} queue={queue} onExit={returnFromQueue} />
      <div className="rounded-2xl border border-border/70 bg-input-surface p-3 shadow-xl shadow-black/20">
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={draft}
            disabled={messageBlocked}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={MAX_PIPELINE_USER_MESSAGE_LENGTH}
            rows={2}
            className="min-h-0 resize-none border-none bg-transparent px-1 py-1 shadow-none focus-visible:outline-none"
            placeholder="Send a message to the agent..."
            aria-label="Send a message to the agent"
            onKeyDown={handleKeyDown}
          />
          <Button
            type="button"
            size="icon"
            className="h-7 w-7 rounded-lg transition-colors"
            title={sendTitle}
            aria-label="Send message"
            disabled={messageBlocked || sendPending || draft.trim().length === 0}
            onClick={() => void send()}
          >
            {sendPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
