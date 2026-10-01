import { useState } from "react";
import { Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { writeText } from "@/lib/native/clipboard";
import { openInBrowser, submitAgentAccountLoginCode } from "@/lib/backend";
import type { AgentAccountLoginProgress } from "@orkestrator/protocol/agent-accounts";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The browser step of a backend-driven sign-in: the link to open and, for
 * Claude, the field the code the page shows is pasted into. Shared by
 * Settings (adding an account) and the recovery card (signing the active
 * account in again).
 */
export function AgentAccountLoginPanel({
  progress,
  onCancel,
  onError,
}: {
  progress: AgentAccountLoginProgress;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const url = progress.url;
  const renewing = progress.mode === "reauthenticate";

  const submit = async () => {
    setSubmitting(true);
    try {
      await submitAgentAccountLoginCode(code);
      setCode("");
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (value: string) => {
    try {
      await writeText(value);
      setCopied(true);
    } catch (cause) {
      onError(messageOf(cause));
    }
  };

  const instruction = renewing
    ? progress.needsCode
      ? "Sign in in your browser, then paste the code the page shows."
      : "Open the page, sign in and enter this code:"
    : progress.needsCode
      ? "Sign in with the account you want to add, then paste the code the page shows."
      : "Open the page, sign in with the account you want to add and enter this code:";

  return (
    <div
      aria-label="Account sign-in"
      className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3"
    >
      {!url ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Starting sign-in…
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{instruction}</p>
          {progress.userCode ? (
            <div className="flex items-center gap-2">
              <code className="rounded bg-zinc-900 px-2 py-1 font-mono text-sm tracking-widest text-foreground">
                {progress.userCode}
              </code>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="Copy code"
                onClick={() => void copy(progress.userCode!)}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void openInBrowser(url)}
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open sign-in page
            </Button>
            {progress.needsCode ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void copy(url)}>
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {copied ? "Link copied" : "Copy link"}
              </Button>
            ) : null}
          </div>
          {progress.needsCode ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Input
                aria-label="Sign-in code"
                placeholder="Paste code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="h-8 text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="submit"
                size="sm"
                disabled={submitting || !code.trim() || progress.codeSubmitted}
              >
                {submitting || progress.codeSubmitted ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Continue
              </Button>
            </form>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for you to approve the sign-in…
            </p>
          )}
        </>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel sign-in
      </Button>
    </div>
  );
}
