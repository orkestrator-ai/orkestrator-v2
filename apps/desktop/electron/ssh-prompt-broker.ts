import { randomUUID } from "node:crypto";

/**
 * Routes an OpenSSH askpass prompt to the window that started the
 * connection and waits for one answer. Prompts are request-scoped, bounded
 * and cancelled with the connection attempt; answers are never logged or
 * stored. A background reconnect never asks (the supervisor uses BatchMode
 * for unattended attempts), so prompts only follow a user action.
 */

export const SSH_PROMPT_EVENT = "ssh-auth-prompt";
export const SSH_PROMPT_SETTLED_EVENT = "ssh-auth-prompt-settled";
const MAX_PENDING_PROMPTS = 4;
const MAX_ANSWER_LENGTH = 4096;

export type SshPromptKind = "passphrase" | "password" | "confirm" | "other";

type PendingPrompt = {
  resolve(answer: string | null): void;
  ownerId: number;
};

export class SshPromptBroker {
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(
    private readonly target: () => {
      id: number;
      send(event: string, payload: unknown): void;
    } | null,
  ) {}

  prompt(request: {
    kind: SshPromptKind;
    message: string;
    signal: AbortSignal;
  }): Promise<string | null> {
    const owner = this.target();
    if (!owner || this.pending.size >= MAX_PENDING_PROMPTS) return Promise.resolve(null);
    const promptId = randomUUID();
    return new Promise<string | null>((resolve) => {
      const settle = (answer: string | null) => {
        if (!this.pending.delete(promptId)) return;
        request.signal.removeEventListener("abort", onAbort);
        owner.send(SSH_PROMPT_SETTLED_EVENT, { promptId });
        resolve(answer);
      };
      const onAbort = () => settle(null);
      this.pending.set(promptId, { resolve: settle, ownerId: owner.id });
      request.signal.addEventListener("abort", onAbort, { once: true });
      owner.send(SSH_PROMPT_EVENT, {
        promptId,
        kind: request.kind,
        // The prompt text is OpenSSH's own (e.g. "Enter passphrase for key"),
        // already bounded and sanitized by the askpass broker.
        message: request.message.slice(0, 512),
      });
    });
  }

  /** The renderer's answer; only the window that was asked may answer. */
  answer(senderId: number, promptId: unknown, answer: unknown): void {
    if (typeof promptId !== "string") throw new Error("Expected a prompt ID");
    const pending = this.pending.get(promptId);
    if (!pending || pending.ownerId !== senderId) return;
    if (answer !== null && (typeof answer !== "string" || answer.length > MAX_ANSWER_LENGTH)) {
      pending.resolve(null);
      return;
    }
    pending.resolve(answer);
  }

  /** A window closed: its unanswered prompts are cancelled, never answered. */
  cancelFor(senderId: number): void {
    for (const prompt of Array.from(this.pending.values())) {
      if (prompt.ownerId === senderId) prompt.resolve(null);
    }
  }
}
