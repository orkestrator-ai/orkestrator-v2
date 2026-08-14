import { create } from "zustand";
import type { AcpSessionSnapshot } from "@/lib/acp-client";

/**
 * An ACP session's first prompt, held locally until the bridge transcript
 * echoes it.
 *
 * Two things make this outlive the component. The dispatch is deliberately
 * delayed by an environment rename — a backend round trip that generates a
 * name and renames the git branch — so for seconds there is no row for the
 * prompt anywhere authoritative. And the tab unmounts whenever the user
 * switches environments, which must not mean "the prompt was never sent": the
 * dispatch keeps running, so a remounted tab has to be able to show what is
 * still in flight.
 */
export interface AcpPendingPrompt {
  /** Prompt text awaiting its echo in the authoritative ACP transcript. */
  text: string;
  /** Stable so re-rendering the local row does not restamp it. */
  createdAt: string;
  /** True while the environment rename is still in flight. */
  isNaming: boolean;
}

interface AcpPendingPromptState {
  /** Keyed by `sessionKey` (`env-{environmentId}:{tabId}`). */
  pending: Map<string, AcpPendingPrompt>;
  setPendingPrompt: (sessionKey: string, prompt: AcpPendingPrompt) => void;
  setPendingPromptNaming: (sessionKey: string, isNaming: boolean) => void;
  clearPendingPrompt: (sessionKey: string) => void;
}

/**
 * True once the transcript holds a user message.
 *
 * A pending prompt is only ever recorded for a session whose transcript is
 * empty at absolute index 0, and an ACP logical session belongs to exactly one
 * tab, so the first user message to appear is necessarily the dispatch this
 * prompt is waiting on. Checking for the message rather than for the dispatch
 * call returning is what makes the hand-off safe: the post-dispatch refresh
 * can be skipped entirely when a poll is already in flight.
 */
export function transcriptHasUserMessage(session: AcpSessionSnapshot | null): boolean {
  return session?.messages.some((message) => message.role === "user") === true;
}

export const useAcpPendingPromptStore = create<AcpPendingPromptState>()((set) => ({
  pending: new Map(),
  setPendingPrompt: (sessionKey, prompt) => set((state) => {
    const pending = new Map(state.pending);
    pending.set(sessionKey, prompt);
    return { pending };
  }),
  setPendingPromptNaming: (sessionKey, isNaming) => set((state) => {
    const current = state.pending.get(sessionKey);
    if (!current || current.isNaming === isNaming) return state;
    const pending = new Map(state.pending);
    pending.set(sessionKey, { ...current, isNaming });
    return { pending };
  }),
  clearPendingPrompt: (sessionKey) => set((state) => {
    if (!state.pending.has(sessionKey)) return state;
    const pending = new Map(state.pending);
    pending.delete(sessionKey);
    return { pending };
  }),
}));
