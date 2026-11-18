// The requests one Claude CLI process holds open on this bridge: tool
// permissions (`can_use_tool`, which also carries AskUserQuestion and
// ExitPlanMode) and MCP elicitations.
//
// The CLI can deliver the same request more than once. A rejoin re-reads its
// initialize inventory (`reinitializeLiveClaude`), and the SDK redelivers every
// permission the CLI still lists to `canUseTool`; the SDK documents that the
// same request id may also arrive as a live or replayed frame. The SDK skips
// a redelivery only while its first delivery is still being answered. One
// that lands after the bridge answered (the answer and the re-read crossed on
// the wire) would otherwise raise a second card for a request the CLI has
// already resolved. This ledger is what makes each request actionable once:
//
// - a request id still being answered shares that answer;
// - a request id already answered is refused, never shown again;
// - once the process has ended, every open request is withdrawn and any later
//   one refused, so nothing a dead CLI asked can be approved.
//
// Request ids are per process, so there is one ledger per runtime.

/** Bound on remembered answered ids. Past it the oldest go first. */
export const MAX_SETTLED_CLAUDE_CONTROL_REQUESTS = 1_024;

/** Why a delivery was refused rather than answered. */
export type ClaudeControlRequestRefusal = "already-answered" | "process-ended";

interface OpenRequest {
  readonly answer: Promise<unknown>;
  readonly withdraw: AbortController;
}

export class ClaudeControlRequests {
  private readonly open = new Map<string, OpenRequest>();
  /** Answers with no request id: still withdrawn when the process ends. */
  private readonly anonymous = new Set<AbortController>();
  private readonly settled = new Set<string>();
  private isEnded = false;

  /** True once the process that raised these requests has ended. */
  get ended(): boolean {
    return this.isEnded;
  }

  /** Requests currently waiting on an answer from this bridge. */
  get openCount(): number {
    return this.open.size + this.anonymous.size;
  }

  /** Whether `requestId` is waiting on an answer from this bridge. */
  isOpen(requestId: string): boolean {
    return this.open.has(requestId);
  }

  /** Whether `requestId` has already been answered by this bridge. */
  isSettled(requestId: string): boolean {
    return this.settled.has(requestId);
  }

  /**
   * Answer a delivery of `requestId` once.
   *
   * `answer` receives a signal that aborts when the CLI withdraws the request
   * (the SDK's own `signal`) or the process ends; a card must withdraw itself
   * on it. A delivery that cannot be answered gets `refuse(reason)`, which must
   * fail closed: a denial or a cancelled elicitation.
   */
  answerOnce<T>(
    requestId: string | undefined,
    sdkSignal: AbortSignal | undefined,
    refuse: (reason: ClaudeControlRequestRefusal) => T,
    answer: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.isEnded) return Promise.resolve(refuse("process-ended"));
    if (requestId) {
      const open = this.open.get(requestId);
      if (open) return open.answer as Promise<T>;
      if (this.settled.has(requestId)) return Promise.resolve(refuse("already-answered"));
    }
    const withdraw = new AbortController();
    const onWithdrawn = () => withdraw.abort();
    if (sdkSignal?.aborted) withdraw.abort();
    else sdkSignal?.addEventListener("abort", onWithdrawn, { once: true });
    const settle = () => {
      sdkSignal?.removeEventListener("abort", onWithdrawn);
      if (!requestId) {
        this.anonymous.delete(withdraw);
        return;
      }
      if (this.open.get(requestId)?.withdraw === withdraw) this.open.delete(requestId);
      this.remember(requestId);
    };
    const pending = (async () => {
      try {
        return await answer(withdraw.signal);
      } finally {
        settle();
      }
    })();
    if (requestId) this.open.set(requestId, { answer: pending, withdraw });
    else this.anonymous.add(withdraw);
    return pending;
  }

  /**
   * The process has ended: withdraw every open request and refuse any later
   * delivery. Idempotent.
   */
  end(): void {
    if (this.isEnded) return;
    this.isEnded = true;
    for (const open of Array.from(this.open.values())) open.withdraw.abort();
    for (const withdraw of Array.from(this.anonymous)) withdraw.abort();
  }

  private remember(requestId: string): void {
    this.settled.delete(requestId);
    this.settled.add(requestId);
    while (this.settled.size > MAX_SETTLED_CLAUDE_CONTROL_REQUESTS) {
      const oldest = this.settled.values().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }
}
