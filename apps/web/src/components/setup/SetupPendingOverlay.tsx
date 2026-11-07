import { useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { LiveElapsed } from "@/components/chat/LiveElapsed";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { Button } from "@/components/ui/button";
import { createOptimisticNativeMessage } from "@/lib/chat/client-only-messages";
import { cn } from "@/lib/utils";
import { useNodeScope } from "@/lib/node-scope/providers";
import { forceResolveSetupRuntime, retrySetupRuntime } from "@/lib/setup-commands";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { SetupApprovalPanel } from "./SetupApprovalPanel";
import type { Environment } from "@/types";

interface SetupPendingOverlayProps {
  environmentId: string;
  setupPhase?: Environment["setupPhase"];
  /** Short agent-specific message, e.g. "Claude will connect automatically once setup finishes" */
  subtext: string;
  /**
   * The opening prompt that will be sent once setup finishes. When present the
   * wait is drawn as a conversation that has already started: the prompt as a
   * sent user bubble, the setup status where the "is thinking" row would be.
   */
  pendingPrompt?: { text: string; createdAt: string };
}

/**
 * Shared waiting-for-setup UI with a manual "Skip setup wait" override.
 *
 * The override calls forceResolveSetupRuntime, which persists the backend
 * setup override. Use this when the normal detection path
 * (OSC marker or workspace-ready text marker) fails to fire. The button shows
 * an inline confirmation before firing because clicking it while setup is
 * genuinely still running will connect the agent against a half-initialized
 * workspace.
 */
export function SetupPendingOverlay({
  environmentId,
  setupPhase,
  subtext,
  pendingPrompt,
}: SetupPendingOverlayProps) {
  const [confirming, setConfirming] = useState(false);
  const [operation, setOperation] = useState<"retry" | "override" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const failed = setupPhase === "failed";
  // A held setup is recorded as failed; its panel replaces retry, which would
  // only hold it again.
  // The node whose environment this is: the one the selector below reads.
  const scope = useNodeScope();
  const approvalRequired = useEnvironmentStore(
    (state) =>
      state.environments.find((environment) => environment.id === environmentId)
        ?.setupApprovalRequired === true,
  );

  const runOperation = async (kind: "retry" | "override") => {
    setError(null);
    setOperation(kind);
    try {
      if (kind === "retry") {
        await retrySetupRuntime(environmentId, scope);
      } else {
        await forceResolveSetupRuntime(environmentId, scope);
        setConfirming(false);
      }
    } catch (operationError) {
      setError(
        operationError instanceof Error
          ? operationError.message
          : `Failed to ${kind === "retry" ? "retry" : "skip"} setup`,
      );
    } finally {
      setOperation(null);
    }
  };

  const statusProps = {
    failed,
    subtext,
    confirming,
    operation,
    setConfirming,
    runOperation,
    error,
  };

  if (pendingPrompt) {
    return (
      <SetupPendingTranscript
        environmentId={environmentId}
        pendingPrompt={pendingPrompt}
        showApproval={failed && approvalRequired}
        statusProps={statusProps}
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-muted-foreground">
      {failed && approvalRequired ? (
        <SetupApprovalPanel key={environmentId} environmentId={environmentId} />
      ) : (
        <SetupStatus {...statusProps} />
      )}
    </div>
  );
}

type SetupStatusProps = {
  failed: boolean;
  subtext: string;
  confirming: boolean;
  operation: "retry" | "override" | null;
  setConfirming: (confirming: boolean) => void;
  runOperation: (kind: "retry" | "override") => Promise<void>;
  error: string | null;
};

/**
 * The queued prompt as an already-sent user message, with the setup wait in
 * the transcript's status row beneath it — the same place and shimmer a normal
 * turn uses while the agent works — so the conversation reads as started.
 */
function SetupPendingTranscript({
  environmentId,
  pendingPrompt,
  showApproval,
  statusProps,
}: {
  environmentId: string;
  pendingPrompt: { text: string; createdAt: string };
  showApproval: boolean;
  statusProps: SetupStatusProps;
}) {
  const message = useMemo(
    () =>
      createOptimisticNativeMessage(
        `setup-pending-prompt:${environmentId}`,
        pendingPrompt.text,
        [],
        pendingPrompt.createdAt,
      ),
    [environmentId, pendingPrompt.createdAt, pendingPrompt.text],
  );
  const startedAt = Date.parse(pendingPrompt.createdAt);
  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-y-auto bg-background py-4">
      <div data-testid="setup-pending-prompt">
        <NativeMessage message={message} />
      </div>
      <div className="px-2 @sm:px-4">
        <div className="mx-auto max-w-3xl min-w-0">
          {showApproval ? (
            <div className="py-3">
              <SetupApprovalPanel key={environmentId} environmentId={environmentId} />
            </div>
          ) : (
            <SetupTranscriptStatus
              {...statusProps}
              startedAt={Number.isNaN(startedAt) ? undefined : startedAt}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function SetupTranscriptStatus({
  failed,
  confirming,
  operation,
  setConfirming,
  runOperation,
  error,
  startedAt,
}: SetupStatusProps & { startedAt?: number }) {
  const linkClassName =
    "rounded-sm text-xs text-muted-foreground/60 underline-offset-2 transition-colors hover:text-foreground hover:underline focus-hairline focus-hairline-outset disabled:pointer-events-none disabled:opacity-50";
  return (
    <div className="text-muted-foreground">
      <div className="chat-status-row min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {failed ? (
            <span role="status" className="flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Environment setup failed.
            </span>
          ) : (
            <>
              <span role="status" className="agent-thinking-shimmer text-xs">
                Waiting for setup scripts to complete...
              </span>
              {startedAt !== undefined ? <LiveElapsed startedAt={startedAt} /> : null}
            </>
          )}
          {!confirming ? (
            <>
              {failed ? (
                <button
                  type="button"
                  className={cn(linkClassName, "ml-1")}
                  disabled={operation !== null}
                  onClick={() => void runOperation("retry")}
                >
                  {operation === "retry" ? "Retrying setup..." : "Retry setup"}
                </button>
              ) : null}
              <button
                type="button"
                className={cn(linkClassName, "ml-1")}
                onClick={() => setConfirming(true)}
              >
                {failed ? "Skip setup" : "Skip setup wait"}
              </button>
            </>
          ) : null}
        </div>
      </div>
      {confirming ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2 text-xs">
          <span>
            Skipping may connect the agent before setup finishes. Only use this if setup detection
            appears to be stuck.
          </span>
          <span className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={operation !== null}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs"
              disabled={operation !== null}
              onClick={() => void runOperation("override")}
            >
              {operation === "override" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {operation === "override" ? "Skipping setup..." : "Skip anyway"}
            </Button>
          </span>
        </div>
      ) : null}
      {error && (
        <p role="alert" className="pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function SetupStatus({
  failed,
  subtext,
  confirming,
  operation,
  setConfirming,
  runOperation,
  error,
}: SetupStatusProps) {
  return (
    <>
      {failed ? (
        <AlertTriangle className="h-8 w-8 text-destructive" />
      ) : (
        <Loader2 className="h-8 w-8 animate-spin text-yellow-400" />
      )}
      <p className="text-sm">
        {failed ? "Environment setup failed." : "Waiting for setup scripts to complete..."}
      </p>
      <p className="text-xs">{subtext}</p>
      {failed && !confirming && (
        <Button
          variant="outline"
          size="sm"
          className="mt-2 text-xs"
          disabled={operation !== null}
          onClick={() => void runOperation("retry")}
        >
          {operation === "retry" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {operation === "retry" ? "Retrying setup..." : "Retry setup"}
        </Button>
      )}
      {confirming ? (
        <div className="mt-2 flex flex-col items-center gap-2">
          <p className="text-xs max-w-xs text-center">
            Skipping may connect the agent before setup finishes. Only use this if setup detection
            appears to be stuck.
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
              disabled={operation !== null}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="text-xs"
              disabled={operation !== null}
              onClick={() => void runOperation("override")}
            >
              {operation === "override" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {operation === "override" ? "Skipping setup..." : "Skip anyway"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 text-xs text-muted-foreground"
          onClick={() => setConfirming(true)}
        >
          {failed ? "Skip setup" : "Skip setup wait"}
        </Button>
      )}
      {error && (
        <p role="alert" className="max-w-sm text-center text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
