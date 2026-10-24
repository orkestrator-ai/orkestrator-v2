import type {
  DesignSessionLink,
  DesignSessionLinkState,
  DesignSessionLinkStates,
  DesignSessionResumeResult,
} from "@orkestrator/protocol/design-operations";
import type { CreatableTabType, CreateTabOptions } from "@/contexts/TerminalContext";
import { failureOf } from "@/lib/design-client";

/**
 * Link state for the "Ask agent" dialog, and Resume.
 *
 * Whether a link's tab is open is this client's pane layout to answer.
 * Whether a closed one can be resumed is the backend's: closing a tab retains
 * its conversation, tab teardown records the session on the link, and
 * `design_session_link_states` reads the durable native-session mappings of
 * tabs still open (storage only, asked once per dialog open or Retry, never
 * polled).
 */
export type DesignLinkStatus =
  /** The pane layout, or the backend's answer, is not in yet. */
  | "checking"
  /** The tab is open in this client. */
  | "open"
  /** Still mapped by the backend; adopt the existing tab without provider resume. */
  | "retained"
  /** The tab is closed and its native session can be reopened. */
  | "resumable"
  /** The tab is closed and no session is known for it: it never started, or closed before links kept sessions. */
  | "missing"
  /** The tab is closed and the backend could not be asked. */
  | "unavailable"
  /** The tab is closed on a backend that cannot report sessions, or for an agent without resume. */
  | "closed";

export type DesignLinkCheck =
  | { kind: "pending" }
  | { kind: "ready"; states: ReadonlyMap<string, DesignSessionLinkState["session"]> }
  /** A backend older than session-link states. */
  | { kind: "unsupported" }
  | { kind: "failed"; message: string };

/** How long the dialog waits for the backend's answer before offering Retry. */
export const DESIGN_LINK_CHECK_DEADLINE_MS = 8_000;

export const DESIGN_LINK_CHECK_TIMED_OUT: DesignLinkCheck = {
  kind: "failed",
  message: "The backend did not answer",
};

export function designLinkCheckFrom(result: DesignSessionLinkStates): DesignLinkCheck {
  return {
    kind: "ready",
    states: new Map(result.states.map((state) => [state.linkId, state.session])),
  };
}

export function designLinkCheckFailure(error: unknown): DesignLinkCheck {
  const failure = failureOf(error);
  if (failure.code === "unsupported") return { kind: "unsupported" };
  return { kind: "failed", message: failure.message };
}

export function designLinkStatus(
  link: DesignSessionLink,
  input: { hydrated: boolean; tabOpen: boolean; canResume: boolean; check: DesignLinkCheck },
): DesignLinkStatus {
  if (!input.hydrated) return "checking";
  if (input.tabOpen) return "open";
  if (!input.canResume) return "closed";
  const { check } = input;
  if (check.kind === "pending") return "checking";
  if (check.kind === "failed") return "unavailable";
  if (check.kind === "unsupported") return "closed";
  const state = check.states.get(link.id);
  if (state === "retained") return "retained";
  if (state !== "missing") return "unavailable";
  return link.sessionId?.trim() ? "resumable" : "missing";
}

/** 32-bit FNV-1a, enough to keep successive resume tab ids distinct. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The tab a link's conversation is resumed in, derived only from the link.
 *
 * Every client reading the same link state computes the same id, the way the
 * one-shot environment launch uses a stable tab id: two clients resuming
 * together converge on one tab id, one native session mapping and one link,
 * rather than each minting its own. It changes with `link.tabId`, so a
 * conversation closed again after a resume gets a fresh tab next time.
 */
export function designResumeTabId(link: Pick<DesignSessionLink, "id" | "tabId">): string {
  return `design-resume-${link.id}-${shortHash(link.tabId)}`;
}

export interface ResumeDesignLinkInput {
  environmentId: string;
  canvasId: string;
  link: DesignSessionLink;
  /** `design_session_resume`: reopens the session for `tabId` and moves the link there. */
  claim: (input: {
    linkId: string;
    expectedTabId: string;
    tabId: string;
  }) => Promise<DesignSessionResumeResult>;
  /** Adopt the retained mapping in its current tab. */
  retainTab?: boolean;
  /** Preserve the claimed tab for recovery even when local tab creation fails. */
  onClaimed?: (link: DesignSessionLink) => void;
  hasTab: (tabId: string) => boolean;
  createTab: (type: CreatableTabType, options: CreateTabOptions) => boolean;
  focus: (tabId: string) => boolean;
}

export interface ResumedDesignLink {
  link: DesignSessionLink;
  tabId: string;
  /** False when the tab was already open (another click, dialog or client). */
  created: boolean;
}

/**
 * A resumer with its own in-flight table: one per client (this renderer uses
 * {@link resumeDesignLink}); tests make one per simulated client.
 */
export function createDesignLinkResumer(): (
  input: ResumeDesignLinkInput,
) => Promise<ResumedDesignLink> {
  const inFlight = new Map<string, Promise<ResumedDesignLink>>();
  return (input) => {
    const key = `${input.environmentId}\0${input.canvasId}\0${input.link.id}\0${input.link.tabId}`;
    const running = inFlight.get(key);
    if (running) return running;
    const attempt = runResume(input).finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return attempt;
  };
}

/**
 * Reopen a linked conversation in a tab of its own.
 *
 * The backend resumes the recorded session through the ordinary native-agent
 * API for the new tab and moves the link there, or reports that the agent no
 * longer has it; it never starts a replacement. The tab then adopts that live
 * session with `requireExistingResumeSession`. Nothing is dispatched: there is
 * no initial prompt, so the design's opening prompt is never sent again.
 * Concurrent calls for one link in this client share one attempt.
 */
export const resumeDesignLink = createDesignLinkResumer();

async function runResume(input: ResumeDesignLinkInput): Promise<ResumedDesignLink> {
  const { link } = input;
  if (link.platform !== "claude" && link.platform !== "codex")
    throw new Error("This conversation's agent cannot be resumed from a design.");
  const tabId = input.retainTab ? link.tabId : designResumeTabId(link);
  const { link: claimed, providerSessionId } = await input.claim({
    linkId: link.id,
    expectedTabId: link.tabId,
    tabId,
  });
  if (claimed.tabId !== tabId)
    throw new Error("This conversation was reopened elsewhere. Close the dialog and try again.");
  input.onClaimed?.(claimed);
  if (input.hasTab(tabId)) {
    input.focus(tabId);
    return { link: claimed, tabId, created: false };
  }
  const created = input.createTab(link.platform, {
    tabId,
    agentLaunchMode: "native",
    displayTitle:
      claimed.label ?? (claimed.role === "implementation" ? "Implement design" : "Design chat"),
    resumeSessionId: providerSessionId,
    requireExistingResumeSession: true,
  });
  if (!created || !input.hasTab(tabId))
    throw new Error("Could not reopen the conversation. Close a tab or pane and try again.");
  input.focus(tabId);
  return { link: claimed, tabId, created: true };
}
