import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { openInBrowser } from "@/lib/backend";
import { writeText } from "@/lib/native/clipboard";
import { cn } from "@/lib/utils";
import type { HumanPrompt } from "@orkestrator/protocol/human-prompts";

/** What the prompt wants, in a few words. */
export function humanPromptHeadline(prompt: HumanPrompt): string {
  switch (prompt.kind) {
    case "host-key":
      return "Confirm the SSH host key";
    case "secret":
      return "Waiting for a password or passphrase";
    case "device-code":
      return "Sign in and enter the code";
    case "sign-in":
      return "Sign in to continue";
    case "press-enter":
      return "Waiting for ENTER";
  }
}

/**
 * The actionable part of a prompt that needs the user: open the link, copy
 * the code, and (when the caller can answer the command) press ENTER.
 */
export function HumanPromptActions({
  prompt,
  onEnter,
  className,
}: {
  prompt: HumanPrompt;
  /** Sends ENTER to the command, when it is the user's own. */
  onEnter?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {prompt.url ? (
        <Button
          size="sm"
          className="h-7 gap-1.5"
          onClick={() => {
            void openInBrowser(prompt.url!).catch(() => toast.error("Could not open the link"));
          }}
          title={prompt.url}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open link
        </Button>
      ) : null}
      {prompt.code ? (
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 font-mono"
          onClick={() => {
            void writeText(prompt.code!)
              .then(() => toast.success("Code copied"))
              .catch(() => toast.error("Could not copy the code"));
          }}
          title="Copy the code"
        >
          <Copy className="h-3.5 w-3.5" />
          {prompt.code}
        </Button>
      ) : null}
      {onEnter && prompt.wantsEnter ? (
        <Button size="sm" variant="outline" className="h-7 gap-1.5" onClick={onEnter}>
          <KeyRound className="h-3.5 w-3.5" />
          Press ENTER
        </Button>
      ) : null}
      {prompt.url ? (
        <span
          className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
          title={prompt.url}
        >
          {prompt.url}
        </span>
      ) : null}
    </div>
  );
}
