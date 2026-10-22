import { randomUUID } from "node:crypto";

import { NODE_SSH_PROMPT_EVENT } from "@orkestrator/protocol/command-nodes";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { SshAskpassPrompt } from "@orkestrator/protocol/node/ssh/askpass";

/**
 * SSH prompts raised by the command node's own tunnels (passphrase,
 * password, confirmation), relayed to the user through the portal.
 *
 * Only user-initiated connects are interactive; background reconnects run
 * ssh in batch mode and never prompt. A prompt ends when it is answered,
 * cancelled, or when ssh gives up (its signal aborts). Answers are handed to
 * ssh and never logged, stored or included in an event.
 */

export interface NodeSshPromptView {
  promptId: string;
  nodeId: BackendId;
  kind: SshAskpassPrompt["kind"];
  message: string;
  state: "open" | "closed";
}

interface PendingPrompt {
  view: NodeSshPromptView;
  resolve(answer: string | null): void;
}

export class NodeSshPrompts {
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(private readonly emit: (event: string, payload: unknown) => void) {}

  ask(nodeId: BackendId, prompt: SshAskpassPrompt): Promise<string | null> {
    if (prompt.signal.aborted) return Promise.resolve(null);
    const promptId = randomUUID();
    const view: NodeSshPromptView = {
      promptId,
      nodeId,
      kind: prompt.kind,
      message: prompt.message,
      state: "open",
    };
    return new Promise<string | null>((resolve) => {
      const finish = (answer: string | null) => {
        if (!this.pending.delete(promptId)) return;
        prompt.signal.removeEventListener("abort", abort);
        this.emit(NODE_SSH_PROMPT_EVENT, { ...view, state: "closed" });
        resolve(answer);
      };
      const abort = () => finish(null);
      prompt.signal.addEventListener("abort", abort, { once: true });
      this.pending.set(promptId, { view, resolve: finish });
      this.emit(NODE_SSH_PROMPT_EVENT, view);
    });
  }

  /** `answer: null` cancels. Returns false for an unknown or finished prompt. */
  answer(promptId: string, answer: string | null): boolean {
    const pending = this.pending.get(promptId);
    if (!pending) return false;
    pending.resolve(answer);
    return true;
  }

  list(): NodeSshPromptView[] {
    return [...this.pending.values()].map((entry) => ({ ...entry.view }));
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) entry.resolve(null);
  }
}
