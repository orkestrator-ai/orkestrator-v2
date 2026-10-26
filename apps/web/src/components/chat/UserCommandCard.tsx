import { useEffect, useRef, useState } from "react";
import { CornerDownLeft, Loader2, Square, TerminalSquare } from "lucide-react";
import { toast } from "sonner";

import { HumanPromptActions, humanPromptHeadline } from "@/components/chat/HumanPromptActions";
import { Button } from "@/components/ui/button";
import { cancelUserCommand, writeUserCommandInput } from "@/lib/backend";
import { cn } from "@/lib/utils";
import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";

const TARGET_LABELS: Record<UserCommandRecord["target"], string> = {
  worktree: "worktree",
  container: "container",
  "project-checkout": "project checkout",
};

function statusLabel(command: UserCommandRecord): { text: string; className: string } {
  switch (command.status) {
    case "running":
      return { text: "Running", className: "border-sky-500/40 text-sky-300" };
    case "cancelled":
      return { text: "Cancelled", className: "border-border text-muted-foreground" };
    case "failed":
      return { text: "Failed to run", className: "border-destructive/50 text-destructive" };
    case "exited":
      return command.exitCode === 0
        ? { text: "Exit 0", className: "border-emerald-500/40 text-emerald-300" }
        : {
            text: `Exit ${command.exitCode ?? "?"}`,
            className: "border-amber-500/40 text-amber-300",
          };
  }
}

/**
 * A shell command the user ran with `!`: live output, the prompt it is
 * waiting on (link, code, ENTER), a line of input, and cancel. All state is
 * the backend's (`list_user_commands`); this only renders and sends.
 */
export function UserCommandCard({ command }: { command: UserCommandRecord }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const running = command.status === "running";
  const status = statusLabel(command);
  const secret = command.prompt?.kind === "secret";

  // Follow the output's end, as a terminal does.
  useEffect(() => {
    const element = outputRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [command.output]);

  const send = async (text: string) => {
    setBusy(true);
    try {
      await writeUserCommandInput(command.id, text);
      setInput("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send input");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overflow-hidden rounded-lg border border-border/70 bg-zinc-900/90 shadow-sm shadow-black/15"
      data-user-command-id={command.id}
      data-user-command-status={command.status}
    >
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-300" />
        ) : (
          <TerminalSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm text-foreground"
          title={command.command}
        >
          <span className="text-muted-foreground">! </span>
          {command.command}
        </span>
        <span className="shrink-0 text-muted-foreground" title={command.cwd}>
          {TARGET_LABELS[command.target]}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            status.className,
          )}
        >
          {status.text}
        </span>
        {running ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs"
            onClick={() => {
              void cancelUserCommand(command.id).catch((error: unknown) =>
                toast.error(error instanceof Error ? error.message : "Could not cancel"),
              );
            }}
          >
            <Square className="h-3 w-3" />
            Cancel
          </Button>
        ) : null}
      </div>

      {command.prompt && running ? (
        <div
          role="status"
          className="border-t border-amber-500/30 bg-amber-500/10 px-3 py-2"
          data-human-prompt-kind={command.prompt.kind}
        >
          <div className="mb-1.5 text-xs font-medium text-amber-200">
            {humanPromptHeadline(command.prompt)}
          </div>
          <HumanPromptActions prompt={command.prompt} onEnter={() => void send("")} />
        </div>
      ) : null}

      {command.output || command.error ? (
        <pre
          ref={outputRef}
          className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border/40 px-3 py-2 font-mono text-xs text-foreground/90"
        >
          {command.outputTruncated ? (
            <span className="text-muted-foreground">[earlier output omitted]{"\n"}</span>
          ) : null}
          {command.output}
          {command.error ? <span className="text-destructive">{command.error}</span> : null}
        </pre>
      ) : null}

      {running ? (
        <form
          className="flex items-center gap-2 border-t border-border/40 px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
        >
          <input
            type={secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={
              secret
                ? "Type it here; it is sent to the command, not the agent"
                : "Send a line to the command"
            }
            aria-label="Input for the running command"
            className="min-w-0 flex-1 rounded-md border border-border/60 bg-background/40 px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            disabled={busy}
          >
            <CornerDownLeft className="h-3.5 w-3.5" />
            {input ? "Send" : "ENTER"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
