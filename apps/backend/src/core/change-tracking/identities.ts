/**
 * Deterministic canonical identities.
 *
 * An operation id comes from durable conversation lineage and the provider's
 * documented call identity — never from the runtime epoch, transport frame or
 * receipt time — so a replayed or re-delivered call maps to the same
 * operation, while a genuine retry with its own native attempt id does not.
 * The projection layer computes the same ids to attach change resources to
 * transcript rows without a lookup.
 */

import { createHash } from "node:crypto";
import { changeResourceKey } from "@orkestrator/protocol/change-resources";

function digest(prefix: string, ...parts: readonly (string | null | undefined)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part ?? ""}\0`);
  return `${prefix}_${hash.digest("hex").slice(0, 40)}`;
}

export function operationIdFor(input: {
  environmentId: string;
  provider: string;
  conversationId: string;
  callId: string;
  attemptId?: string | null;
}): string {
  return digest(
    "op",
    input.environmentId,
    input.provider,
    input.conversationId,
    input.callId,
    input.attemptId ?? "",
  );
}

export function providerTurnIdFor(input: {
  environmentId: string;
  provider: string;
  conversationId: string;
  turnId: string;
}): string {
  return digest("pturn", input.environmentId, input.provider, input.conversationId, input.turnId);
}

export function evidenceIdFor(ownerKind: string, ownerId: string, evidenceKey: string): string {
  return digest("ev", ownerKind, ownerId, evidenceKey);
}

export function threadIdFor(environmentId: string, logicalSessionKey: string): string {
  return digest("thr", environmentId, logicalSessionKey);
}

export const toolResourceKeys = (operationId: string) => ({
  payload: changeResourceKey({
    scope: "tool-payload",
    ownerKind: "operation",
    ownerId: operationId,
    selector: "live",
  }),
  effect: changeResourceKey({
    scope: "tool-effect",
    ownerKind: "operation",
    ownerId: operationId,
    selector: "live",
  }),
  observation: changeResourceKey({
    scope: "observation-window",
    ownerKind: "operation",
    ownerId: operationId,
    selector: "live",
  }),
});

export const turnResourceKeys = (turnId: string, providerTurnId: string | null) => ({
  turnNet: changeResourceKey({
    scope: "turn-net",
    ownerKind: "turn",
    ownerId: turnId,
    selector: "live",
  }),
  providerTurnDiff: providerTurnId
    ? changeResourceKey({
        scope: "provider-turn-diff",
        ownerKind: "turn",
        ownerId: providerTurnId,
        selector: "live",
      })
    : null,
});

export const operationVolumeResourceKey = (
  ownerId: string,
  ownerKind: "turn" | "segment" = "turn",
) => changeResourceKey({ scope: "operation-volume", ownerKind, ownerId, selector: "live" });

export const threadResourceKey = (segmentId: string) =>
  changeResourceKey({
    scope: "thread-net",
    ownerKind: "segment",
    ownerId: segmentId,
    selector: "live",
  });
