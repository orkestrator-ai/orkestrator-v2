import { useEffect, useState } from "react";
import { toast } from "sonner";
import { NODE_SSH_PROMPT_EVENT } from "@orkestrator/protocol/command-nodes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import {
  answerNodeSshPrompt,
  listNodeSshPrompts,
  nodeErrorText,
} from "@/lib/backend/command-nodes";
import { portalListenAuthoritative } from "@/lib/portal/portal-transport";

const errorText = nodeErrorText;

interface PromptEvent {
  promptId: string;
  nodeId: string;
  kind: string;
  message: string;
  state: "open" | "closed";
}

/** SSH prompts raised by this node's own tunnels to other nodes. Answers are never stored. */
export function NodeSshPromptDialog() {
  const [prompts, setPrompts] = useState<PromptEvent[]>([]);
  const prompt = prompts[0] ?? null;
  const [draft, setDraft] = useState({ promptId: "", value: "" });
  const answer = draft.promptId === prompt?.promptId ? draft.value : "";
  const setAnswer = (value: string) => setDraft({ promptId: prompt?.promptId ?? "", value });

  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    let revision = 0;
    const refresh = async (): Promise<void> => {
      const before = revision;
      const snapshot = await listNodeSshPrompts().catch(() => null);
      if (cancelled || !snapshot) return;
      if (revision !== before) {
        void refresh();
        return;
      }
      setPrompts(snapshot.filter((entry) => entry.state === "open"));
    };
    void portalListenAuthoritative<PromptEvent>(
      NODE_SSH_PROMPT_EVENT,
      ({ payload }) => {
        revision++;
        setPrompts((current) =>
          payload.state === "open"
            ? current.some((entry) => entry.promptId === payload.promptId)
              ? current
              : [...current, payload]
            : current.filter((entry) => entry.promptId !== payload.promptId),
        );
      },
      { onResync: refresh, resyncOnSubscribe: true },
    ).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const respond = (value: string | null) => {
    if (!prompt) return;
    const id = prompt.promptId;
    setPrompts((current) => current.filter((entry) => entry.promptId !== id));
    setAnswer("");
    void answerNodeSshPrompt(id, value).catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => (open ? undefined : respond(null))}>
      <DialogContent className={Z_FULLSCREEN_DIALOG} overlayClassName={Z_FULLSCREEN_DIALOG}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            respond(answer);
          }}
          className="space-y-3"
        >
          <DialogHeader>
            <DialogTitle>SSH needs your answer — {prompt?.nodeId}</DialogTitle>
            <DialogDescription>{prompt?.message}</DialogDescription>
          </DialogHeader>
          {prompt?.kind === "confirm" ? null : (
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              aria-label="SSH answer"
            />
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => respond(null)}>
              Cancel
            </Button>
            <Button type="submit">{prompt?.kind === "confirm" ? "Yes" : "Send"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
