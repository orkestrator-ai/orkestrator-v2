/**
 * Sends a prompt again once the Claude login it was refused for is back.
 *
 * Claude answers a turn it has no login for with its not-logged-in notice as an
 * ordinary reply and does nothing else. This used to be recovered in the
 * renderer, from an in-memory copy of the last prompt: it worked only on the
 * device that sent it, while that tab stayed mounted. The backend now owns it:
 *
 * 1. An accepted plain prompt on an interactive Claude session is remembered
 *    in memory (`remember`), bounded in count and size. Nothing is written for
 *    the overwhelmingly common turn that was not refused.
 * 2. When that turn ends (or a client asks, `status`), the transcript's tail
 *    is read once. If the notice is still the latest exchange, the prompt is
 *    recorded durably on the session (`signInResend`). A later accepted
 *    dispatch clears it, in the same write that journals that dispatch.
 * 3. When any client finishes a Claude sign-in (`resendAll`), every held prompt
 *    whose refusal is still the session's last word is taken, exactly once
 *    under the session lease, and dispatched.
 *
 * At-most-once holds because the resend is an ordinary journaled dispatch whose
 * request id is derived from the refused one: the refused id is already
 * journaled and would be answered as a duplicate, while a fixed derivation means
 * two attempts can never become two turns. An ambiguous outcome parks like any
 * other interactive dispatch, for the user to retry or discard; it is never
 * retried here. A rejection is not retried either: the user can see their message
 * and the sign-in card asks them to resend it.
 */
import { isClaudeNotLoggedInText } from "@orkestrator/protocol/claude-login-notice";
import type { NativeAgentRuntimeProvider } from "./agent-provider-contract.js";
import { composeDraftHoldsQueue } from "./compose-draft-occupancy.js";
import type { PersistedNativeAgentSession, PersistedNativeAgentSignInResend } from "./models.js";
import {
  nativeAgentSessionStorageKey,
  type DispatchNativeAgentPromptInput,
  type EnsureNativeAgentSessionInput,
  type NativeAgentProjectionInput,
} from "./native-agent-service-shared.js";
import { sessionSignInResend } from "./storage-shared-native-sessions.js";
import type { StorageService } from "./storage.js";

/** Sessions with a remembered prompt; every entry is at most one prompt. */
const MAX_CANDIDATES = 64;
/**
 * A prompt larger than this, attachments included (one can carry its bytes as a
 * data URL), is not worth holding for a rare recovery. Its card asks for a resend.
 */
const MAX_CANDIDATE_CHARACTERS = 1_000_000;
/** The notice and the prompt it answers are always the newest rows. */
const REFUSAL_PROBE_MESSAGES = 8;

/** The derived identity of the one resend a refused request may produce. */
export function signInResendRequestId(refusedRequestId: string): string {
  return `${refusedRequestId}:after-sign-in`;
}

export interface NativeAgentSignInResendsHost {
  storage: StorageService;
  now: () => number;
  provider: (input: EnsureNativeAgentSessionInput) => Promise<NativeAgentRuntimeProvider>;
  observeProvider: (
    input: EnsureNativeAgentSessionInput,
  ) => Promise<NativeAgentRuntimeProvider | null | undefined>;
  dispatch: (input: DispatchNativeAgentPromptInput) => Promise<unknown>;
  trackScan: (task: Promise<void>) => unknown;
}

function rowText(row: Record<string, unknown>): string {
  if (typeof row.content === "string" && row.content.trim()) return row.content;
  if (!Array.isArray(row.parts)) return "";
  return row.parts
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { content?: unknown }).content ?? "")
        : "",
    )
    .join("");
}

/**
 * Whether the newest exchange in `rows` is the not-logged-in notice answering
 * the newest user message. Once anything follows it, the moment has passed.
 */
export function latestExchangeIsLoginRefusal(rows: readonly unknown[]): boolean {
  const records = rows.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  );
  const lastUser = records.findLastIndex((row) => row.role === "user");
  const lastAssistant = records.findLastIndex((row) => row.role === "assistant");
  return (
    lastUser >= 0 &&
    lastAssistant > lastUser &&
    isClaudeNotLoggedInText(rowText(records[lastAssistant]!))
  );
}

function sessionIdentity(session: PersistedNativeAgentSession): EnsureNativeAgentSessionInput {
  return {
    environmentId: session.environmentId,
    agent: session.agent,
    logicalSessionKey: session.logicalSessionKey,
  };
}

export class NativeAgentSignInResends {
  /** Insertion ordered, so the first key is the oldest. */
  private readonly candidates = new Map<string, PersistedNativeAgentSignInResend>();

  constructor(private readonly host: NativeAgentSignInResendsHost) {}

  /**
   * An accepted dispatch. `prompt` is what the provider was sent, including a
   * handoff carrier: a turn it refused never saw that history, and the journal
   * already counts it delivered, so the resend has to carry it.
   */
  remember(
    session: PersistedNativeAgentSession,
    input: DispatchNativeAgentPromptInput,
    prompt: string,
    options: { literalPrompt: boolean },
  ): void {
    this.candidates.delete(session.key);
    if (
      !options.literalPrompt ||
      session.agent !== "claude" ||
      session.origin !== "interactive-native" ||
      input.images?.length ||
      prompt.length + JSON.stringify(input.attachments ?? []).length > MAX_CANDIDATE_CHARACTERS
    ) {
      return;
    }
    this.candidates.set(session.key, {
      requestId: input.requestId,
      providerSessionId: session.providerSessionId,
      prompt,
      recordedAt: new Date(this.host.now()).toISOString(),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.fastMode === undefined ? {} : { fastMode: input.fastMode }),
      ...(input.subAgent ? { subAgent: input.subAgent } : {}),
      ...(input.includeLocalSettings === undefined
        ? {}
        : { includeLocalSettings: input.includeLocalSettings }),
      ...(input.promptSuggestions === undefined
        ? {}
        : { promptSuggestions: input.promptSuggestions }),
    });
    if (this.candidates.size > MAX_CANDIDATES) {
      const oldest = this.candidates.keys().next().value;
      if (oldest !== undefined) this.candidates.delete(oldest);
    }
  }

  /** A turn ended. Runs off the caller's path: it never delays a queue drain. */
  noteTurnEnded(session: PersistedNativeAgentSession): void {
    if (!this.candidates.has(session.key)) return;
    this.host.trackScan(
      this.settleCandidate(session).then(
        () => undefined,
        (error: unknown) => {
          console.warn(
            "[native-agent] Checking a turn for a login refusal failed:",
            error instanceof Error ? error.name : "unknown error",
          );
        },
      ),
    );
  }

  /**
   * A client's view: will this session's refused prompt be sent again after a
   * sign-in? Answering it also records a refusal the turn-end edge has not
   * reached yet, so the notice on screen and this answer cannot disagree.
   */
  async status(input: NativeAgentProjectionInput): Promise<{ pending: boolean }> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.host.storage.getNativeAgentSession(key);
    if (!session) return { pending: false };
    const held = sessionSignInResend(session);
    if (held) return { pending: this.heldIsCurrent(session, held) };
    return { pending: await this.settleCandidate(session).catch(() => false) };
  }

  private heldIsCurrent(
    session: PersistedNativeAgentSession,
    held: PersistedNativeAgentSignInResend,
  ): boolean {
    return (
      held.providerSessionId === session.providerSessionId &&
      session.dispatchedRequestIds?.at(-1) === held.requestId
    );
  }

  /** Sign-in from this backend renews what this session runs on. */
  private async signInCanReach(session: PersistedNativeAgentSession): Promise<boolean> {
    const environment = await this.host.storage.getEnvironment(session.environmentId);
    if (!environment) return false;
    if (environment.environmentType === "local") return true;
    // A container with its own isolated login is signed in from inside it.
    const config = await this.host.storage.loadConfig();
    return config.global.useHostClaudeCredentials !== false;
  }

  private async settleCandidate(session: PersistedNativeAgentSession): Promise<boolean> {
    const candidate = this.candidates.get(session.key);
    if (!candidate) return false;
    if (
      candidate.providerSessionId !== session.providerSessionId ||
      session.dispatchedRequestIds?.at(-1) !== candidate.requestId
    ) {
      // The journal write that accepts a request can land just after this read.
      if (!session.dispatchedRequestIds?.includes(candidate.requestId)) return false;
      this.candidates.delete(session.key);
      return false;
    }
    const provider = await this.host.observeProvider(sessionIdentity(session));
    if (!provider) return false;
    const rows = await provider.messages(session.providerSessionId, {
      limit: REFUSAL_PROBE_MESSAGES,
    });
    if (!latestExchangeIsLoginRefusal(rows) || !(await this.signInCanReach(session))) {
      this.candidates.delete(session.key);
      return false;
    }
    const recorded = await this.host.storage.recordNativeAgentSignInResend(session.key, candidate);
    this.candidates.delete(session.key);
    return recorded;
  }

  /** A Claude sign-in finished, from any client: send what it was refused for. */
  resendAll(): void {
    this.host.trackScan(
      this.resendHeldPrompts().then(
        () => undefined,
        (error: unknown) => {
          console.warn(
            "[native-agent] Sending refused prompts after sign-in failed:",
            error instanceof Error ? error.name : "unknown error",
          );
        },
      ),
    );
  }

  /** Answers how many prompts were dispatched; sessions are independent. */
  async resendHeldPrompts(): Promise<number> {
    // A refusal whose turn-end edge has not run yet has only its candidate.
    for (const key of Array.from(this.candidates.keys())) {
      const session = await this.host.storage.getNativeAgentSession(key);
      if (session) await this.settleCandidate(session).catch(() => false);
    }
    const sessions = await this.host.storage.listNativeAgentSessions();
    let dispatched = 0;
    for (const session of sessions) {
      const held = session.agent === "claude" ? sessionSignInResend(session) : undefined;
      if (!held) continue;
      try {
        if (await this.resendOne(session, held)) dispatched += 1;
      } catch (error) {
        // Only the error's class: a provider message can quote the prompt.
        console.warn(
          "[native-agent] A refused prompt could not be sent again after sign-in:",
          error instanceof Error ? error.name : "unknown error",
        );
      }
    }
    return dispatched;
  }

  private async resendOne(
    session: PersistedNativeAgentSession,
    held: PersistedNativeAgentSignInResend,
  ): Promise<boolean> {
    const environment = await this.host.storage.getEnvironment(session.environmentId);
    // Stopped: left for the next sign-in. The next dispatch clears it either way.
    if (environment?.status !== "running") return false;
    const superseded = async () => {
      await this.host.storage.takeNativeAgentSignInResend(session.key, held.requestId);
      return false;
    };
    if (!this.heldIsCurrent(session, held) || session.pendingDispatch || session.pendingSteer) {
      return superseded();
    }
    const identity = sessionIdentity(session);
    const provider = await this.host.provider(identity);
    const rows = await provider.messages(session.providerSessionId, {
      limit: REFUSAL_PROBE_MESSAGES,
    });
    if (!latestExchangeIsLoginRefusal(rows)) return superseded();
    // Never over a message the user has started writing since.
    const draftKey = `${session.agent}:${session.environmentId}:${encodeURIComponent(session.logicalSessionKey)}`;
    if (composeDraftHoldsQueue((await this.host.storage.getComposeDraft(draftKey))?.value)) {
      return superseded();
    }
    const taken = await this.host.storage.takeNativeAgentSignInResend(session.key, held.requestId);
    if (!taken) return false;
    await this.host.dispatch({
      ...identity,
      origin: session.origin,
      interactionPolicy: session.interactionPolicy,
      prompt: taken.prompt,
      requestId: signInResendRequestId(taken.requestId),
      ...(taken.attachments?.length ? { attachments: taken.attachments } : {}),
      ...(taken.model ? { model: taken.model } : {}),
      ...(taken.reasoningEffort ? { reasoningEffort: taken.reasoningEffort } : {}),
      ...(taken.mode ? { mode: taken.mode } : {}),
      ...(taken.fastMode === undefined ? {} : { fastMode: taken.fastMode }),
      ...(taken.subAgent ? { subAgent: taken.subAgent } : {}),
      ...(taken.includeLocalSettings === undefined
        ? {}
        : { includeLocalSettings: taken.includeLocalSettings }),
      ...(taken.promptSuggestions === undefined
        ? {}
        : { promptSuggestions: taken.promptSuggestions }),
    });
    return true;
  }
}
