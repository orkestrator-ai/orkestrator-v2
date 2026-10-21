/**
 * Mutations whose outcome is unknown.
 *
 * A client cannot manufacture exactly-once execution by retrying harder. When
 * a write to a machine fails in a way that does not prove it never arrived
 * (the connection dropped mid-request, a route changed underneath it), the
 * write is recorded as "outcome unknown" against its original backend and
 * is never resubmitted automatically. The user reconciles through that
 * machine's authoritative state. Records are content-free: a command name,
 * a label, an optional request key and an input fingerprint — never the
 * arguments themselves.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import type { BackendId } from "@orkestrator/protocol/federation";

export const MAX_UNKNOWN_OUTCOMES = 50;

export interface UnknownOutcome {
  id: string;
  backendId: BackendId;
  command: string;
  label: string;
  requestKey?: string;
  /** Non-reversible fingerprint of the input, for matching a later retry decision. */
  fingerprint: string;
  at: number;
}

const AMBIGUOUS_FAILURE =
  /fetch failed|failed to fetch|load failed|network|socket|econnreset|epipe|aborted|timed out|timeout|terminated|connection (lost|closed|reset)/i;

/** Errors that do not prove the request never reached the backend. */
export function isAmbiguousFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return AMBIGUOUS_FAILURE.test(message);
}

export function fingerprintInput(command: string, args: Record<string, unknown>): string {
  const text = `${command}\0${stableStringify(args)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class OutcomeUnknownError extends Error {
  readonly outcome: UnknownOutcome;

  constructor(outcome: UnknownOutcome, cause: unknown) {
    super(
      `The connection was lost while "${outcome.label}" was being sent. It may or may not have run; check the machine before trying again.`,
      { cause },
    );
    this.name = "OutcomeUnknownError";
    this.outcome = outcome;
  }
}

let nextOutcomeId = 1;

export class OperationRecovery {
  readonly store: StoreApi<{ outcomes: UnknownOutcome[] }> = createStore(() => ({
    outcomes: [] as UnknownOutcome[],
  }));

  constructor(private readonly backendId: BackendId) {}

  async run<T>(
    command: string,
    args: Record<string, unknown>,
    options: { label: string; requestKey?: string },
    send: () => Promise<T>,
  ): Promise<T> {
    try {
      return await send();
    } catch (error) {
      if (!isAmbiguousFailure(error)) throw error;
      const outcome: UnknownOutcome = {
        id: `outcome-${nextOutcomeId++}`,
        backendId: this.backendId,
        command,
        label: options.label.slice(0, 120),
        ...(options.requestKey ? { requestKey: options.requestKey } : {}),
        fingerprint: fingerprintInput(command, args),
        at: Date.now(),
      };
      this.store.setState((state) => ({
        outcomes: [outcome, ...state.outcomes].slice(0, MAX_UNKNOWN_OUTCOMES),
      }));
      throw new OutcomeUnknownError(outcome, error);
    }
  }

  dismiss(outcomeId: string): void {
    this.store.setState((state) => ({
      outcomes: state.outcomes.filter((outcome) => outcome.id !== outcomeId),
    }));
  }
}
