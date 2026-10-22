import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Prompt = { promptId: string; kind: string; message: string };

/**
 * Answers an OpenSSH passphrase or password prompt for a connection the
 * user just started. The answer goes straight back to the native layer for
 * that one request and is never stored here; cancelling declines it. A
 * background reconnect never asks.
 */
export function SshPromptDialog() {
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    const listen = window.orkestrator?.listen;
    if (typeof listen !== "function" || !window.orkestrator?.connections?.answerSshPrompt) return;
    const stopPrompt = listen<Prompt>("ssh-auth-prompt", (payload) => {
      if (!payload || typeof payload.promptId !== "string") return;
      setAnswer("");
      setPrompt({
        promptId: payload.promptId,
        kind: typeof payload.kind === "string" ? payload.kind : "other",
        message: typeof payload.message === "string" ? payload.message.slice(0, 512) : "",
      });
    });
    const stopSettled = listen<{ promptId?: string }>("ssh-auth-prompt-settled", (payload) => {
      setPrompt((current) => (current && current.promptId === payload?.promptId ? null : current));
      setAnswer("");
    });
    return () => {
      stopPrompt();
      stopSettled();
    };
  }, []);

  const respond = (value: string | null) => {
    if (!prompt) return;
    window.orkestrator?.connections?.answerSshPrompt?.(prompt.promptId, value);
    setPrompt(null);
    setAnswer("");
  };

  const confirmOnly = prompt?.kind === "confirm";
  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && respond(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {prompt?.kind === "passphrase"
              ? "SSH key passphrase"
              : confirmOnly
                ? "Confirm SSH"
                : "SSH sign-in"}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap break-words">
            {prompt?.message || "OpenSSH needs your input to connect."}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            respond(confirmOnly ? "yes" : answer);
          }}
          className="space-y-4"
        >
          {!confirmOnly ? (
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              aria-label={prompt?.kind === "passphrase" ? "Passphrase" : "Password"}
            />
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => respond(null)}>
              Cancel
            </Button>
            <Button type="submit">{confirmOnly ? "Continue" : "Connect"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
