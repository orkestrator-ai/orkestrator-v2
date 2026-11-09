/**
 * Per-turn permission grants on OpenCode 2.x sessions: read-only turns,
 * reviewer shell rules and workflow-result tools
 * (docs/todo/agent-engines/0008-opencode-v2.md, phase 5).
 *
 * The 1.x broker's semantics (`opencode-workflow-result-broker.ts`), on 2.x
 * session permissions:
 *
 * - **Granted under the dispatch lock, right before the prompt.** `begin`
 *   writes the turn's rules and an owner record (`orkestrator.turn`:
 *   `{ requestId, settled: false }`) into the session, reads them back, and
 *   only then may the prompt be sent. A grant that did not persist refuses
 *   the turn before anything is dispatched.
 * - **Ownership lives in OpenCode.** The owner, the session's base rules and
 *   its reviewer marker are session metadata, so a recreated provider can
 *   settle a turn, and an old request cannot revoke a newer one's grant.
 * - **Restored after.** `settle` puts the steady rules back only for the
 *   request that owns the grant, once its run has settled; `settleOwner`
 *   (abort, close) settles whichever request owns it.
 * - **Observers never write.** Reads of status and history go elsewhere.
 *
 * A turn that needs no grant (no read-only boundary, no result tool) writes
 * nothing when the session already runs its steady rules, so an interactive
 * tab's ordinary turn costs one session read.
 */
import {
  isNativeAgentExecutionPolicy,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import {
  PromptRejectedError,
  ProviderDispatchPreparationError,
} from "../agent-provider-contract.js";
import { OpenCode2RequestError, type OpenCode2Client } from "./client.js";
import {
  openCode2SteadyRules,
  openCode2TurnNeedsGrant,
  openCode2TurnRules,
  readOpenCode2Rules,
  sameOpenCode2Rules,
  type OpenCode2TurnRuleInput,
} from "./permissions.js";
import type { OpenCode2PermissionRule, OpenCode2Session } from "./types.js";

const METADATA_VERSION = 1;

/** What Orkestrator keeps under `metadata.orkestrator` on a 2.x session. */
export interface OpenCode2SessionMarker {
  phase?: string;
  label?: string;
  /** The rules the session's execution policy gives it (absent: none). */
  base?: OpenCode2PermissionRule[];
  /** Durable proof that the session is a leaf reviewer. */
  reviewer?: { version: 1; policy: NativeAgentExecutionPolicy };
  /** The request that holds the session's current grant. */
  turn?: { version: 1; requestId: string; settled: boolean };
}

export interface OpenCode2TurnGrant extends OpenCode2TurnRuleInput {
  requestId: string;
  /** The reviewer's own shell policy, resupplied on dispatch; used only for a marked reviewer. */
  reviewShellPolicy?: NativeAgentExecutionPolicy;
}

/** The metadata a session is created with. */
export function openCode2CreateMetadata(input: {
  phase: string;
  label: string;
  base: OpenCode2PermissionRule[];
  reviewerPolicy?: NativeAgentExecutionPolicy;
}): Record<string, unknown> {
  const marker: OpenCode2SessionMarker = {
    phase: input.phase.slice(0, 120),
    label: input.label.slice(0, 200),
    ...(input.base.length > 0 ? { base: input.base } : {}),
    ...(input.reviewerPolicy && input.reviewerPolicy.id !== "coordinator-read-only"
      ? { reviewer: { version: METADATA_VERSION, policy: input.reviewerPolicy } }
      : {}),
  };
  return { orkestrator: marker };
}

export class OpenCode2TurnGrants {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly client: OpenCode2Client) {}

  /**
   * Run `operation` exclusively for one session: grants, prompts and
   * settlement of the same session never interleave.
   */
  runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const tail = next.catch(() => undefined);
    this.locks.set(sessionId, tail);
    void tail.then(() => {
      if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
    });
    return next;
  }

  /** Called under the lock immediately before the prompt is written. */
  async begin(sessionId: string, turn: OpenCode2TurnGrant): Promise<void> {
    try {
      const session = await this.client.getSession(sessionId);
      const marker = readMarker(session);
      const base = marker.base ?? [];
      const reviewPolicy =
        turn.readOnly && turn.reviewShellPolicy && marker.reviewer
          ? turn.reviewShellPolicy
          : undefined;
      const input = { ...turn, ...(reviewPolicy ? { reviewPolicy } : {}) };
      if (!openCode2TurnNeedsGrant(input)) {
        // Nothing to grant: make sure an earlier grant is not still in force.
        const steady = openCode2SteadyRules(base, sessionId);
        const owned = marker.turn && !marker.turn.settled;
        if (!owned && sameOpenCode2Rules(readOpenCode2Rules(session.permissions), steady)) return;
        await this.write(session, steady, owned ? { ...marker.turn!, settled: true } : marker.turn);
        return;
      }
      const rules = openCode2TurnRules(base, sessionId, input);
      const owner = {
        version: METADATA_VERSION,
        requestId: turn.requestId,
        settled: false,
      } as const;
      await this.write(session, rules, owner);
      const persisted = await this.client.getSession(sessionId);
      const persistedOwner = readMarker(persisted).turn;
      if (
        persistedOwner?.requestId !== turn.requestId ||
        persistedOwner.settled !== false ||
        !sameOpenCode2Rules(readOpenCode2Rules(persisted.permissions), rules)
      ) {
        throw new Error("The turn's permission grant was not persisted");
      }
    } catch (error) {
      if (error instanceof OpenCode2RequestError && error.status === 404) {
        throw new PromptRejectedError("The OpenCode 2 session was not found");
      }
      throw new ProviderDispatchPreparationError("OpenCode 2 turn permissions are unavailable", {
        cause: error,
      });
    }
  }

  /** The request holding the grant, settled or not (undefined when none). */
  async owner(sessionId: string): Promise<OpenCode2SessionMarker["turn"]> {
    return readMarker(await this.client.getSession(sessionId)).turn;
  }

  /**
   * Restore the steady rules for `requestId`'s grant. The caller holds the
   * lock and has confirmed the request is terminal. A grant owned by another
   * request, or already settled, is left alone.
   */
  async settle(sessionId: string, requestId: string): Promise<void> {
    const session = await this.client.getSession(sessionId);
    const marker = readMarker(session);
    if (marker.turn?.requestId !== requestId || marker.turn.settled) return;
    await this.restore(session, marker);
  }

  /** Settle whichever request holds the grant (abort and close). The caller holds the lock. */
  async settleOwner(sessionId: string): Promise<void> {
    const session = await this.client.getSession(sessionId);
    const marker = readMarker(session);
    if (!marker.turn || marker.turn.settled) return;
    await this.restore(session, marker);
  }

  private async restore(session: OpenCode2Session, marker: OpenCode2SessionMarker): Promise<void> {
    const steady = openCode2SteadyRules(marker.base ?? [], session.id);
    await this.write(session, steady, { ...marker.turn!, settled: true });
    const persisted = readMarker(await this.client.getSession(session.id));
    if (persisted.turn?.settled !== true) {
      throw new Error("The turn's permission settlement was not persisted");
    }
  }

  private async write(
    session: OpenCode2Session,
    permissions: OpenCode2PermissionRule[],
    turn: OpenCode2SessionMarker["turn"],
  ): Promise<void> {
    const metadata = session.metadata ?? {};
    const current = asRecord(metadata.orkestrator) ?? {};
    await this.client.updateSession(session.id, {
      permissions,
      metadata: { ...metadata, orkestrator: { ...current, ...(turn ? { turn } : {}) } },
    });
  }
}

/** The validated Orkestrator marker of a session; anything malformed reads as absent. */
export function readMarker(session: Pick<OpenCode2Session, "metadata">): OpenCode2SessionMarker {
  const raw = asRecord(session.metadata?.orkestrator);
  if (!raw) return {};
  const marker: OpenCode2SessionMarker = {};
  const base = readOpenCode2Rules(raw.base);
  if (base) marker.base = base;
  const reviewer = asRecord(raw.reviewer);
  if (reviewer?.version === METADATA_VERSION && isNativeAgentExecutionPolicy(reviewer.policy)) {
    marker.reviewer = { version: METADATA_VERSION, policy: reviewer.policy };
  }
  const turn = asRecord(raw.turn);
  if (
    turn?.version === METADATA_VERSION &&
    typeof turn.requestId === "string" &&
    typeof turn.settled === "boolean"
  ) {
    marker.turn = { version: METADATA_VERSION, requestId: turn.requestId, settled: turn.settled };
  }
  return marker;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
