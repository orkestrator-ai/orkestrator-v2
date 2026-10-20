/**
 * Route bodies for a bridge's change-evidence spool, shared by every bridge
 * so their wire answers cannot drift apart:
 *
 * - `GET  /change-evidence?cursor=&limit=` → {@link ChangeEvidenceReadResponse}
 * - `GET  /change-evidence/body?id=`       → {@link ChangeEvidenceBodyResponse}
 * - `POST /change-evidence/ack`            → `{ released }`
 *
 * The backend reads 404/405 from these routes as "this bridge predates change
 * evidence" and falls back to legacy transcript fields, so an unknown body id
 * is answered in band (`missing`), never with a 404.
 */

import { isPlainRecord } from "../../field-validation.js";
import type {
  ChangeEvidenceAckRequest,
  ChangeEvidenceReadResponse,
} from "../../change-evidence.js";
import type { ChangeEvidenceSpool } from "./evidence-spool.js";

export const CHANGE_EVIDENCE_ROUTE = "/change-evidence";
export const CHANGE_EVIDENCE_BODY_ROUTE = "/change-evidence/body";
export const CHANGE_EVIDENCE_ACK_ROUTE = "/change-evidence/ack";

export type ChangeEvidenceBodyResponse =
  | { id: string; state: "available"; base64: string; bytes: number }
  | { id: string; state: "missing" };

type Query = (name: string) => string | null | undefined;

function boundedInteger(value: string | null | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

export function changeEvidenceReadBody(
  spool: ChangeEvidenceSpool,
  query: Query,
): ChangeEvidenceReadResponse {
  const cursor = boundedInteger(query("cursor"), 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(query("limit"), 256, 1_024);
  // A reader holding a cursor from an earlier process epoch starts over.
  const epoch = query("epoch");
  return spool.read(epoch && epoch !== spool.runtimeEpoch ? 0 : cursor, limit || 256);
}

export function changeEvidenceBodyRouteBody(
  spool: ChangeEvidenceSpool,
  query: Query,
): ChangeEvidenceBodyResponse {
  const id = query("id") ?? "";
  const bytes = id ? spool.readBody(id) : null;
  if (!bytes) return { id, state: "missing" };
  return {
    id,
    state: "available",
    base64: Buffer.from(bytes).toString("base64"),
    bytes: bytes.length,
  };
}

export function parseChangeEvidenceAck(value: unknown): ChangeEvidenceAckRequest | null {
  if (!isPlainRecord(value)) return null;
  const ids = (input: unknown) =>
    Array.isArray(input) && input.length <= 10_000 && input.every((id) => typeof id === "string")
      ? (input as string[])
      : null;
  const retained = ids(value.retainedBodyIds ?? []);
  const unavailable = ids(value.unavailableBodyIds ?? []);
  if (
    typeof value.runtimeEpoch !== "string" ||
    !Number.isSafeInteger(value.upTo) ||
    (value.upTo as number) < 0 ||
    !retained ||
    !unavailable
  ) {
    return null;
  }
  return {
    runtimeEpoch: value.runtimeEpoch,
    upTo: value.upTo as number,
    retainedBodyIds: retained,
    unavailableBodyIds: unavailable,
  };
}

export function changeEvidenceAckRouteBody(
  spool: ChangeEvidenceSpool,
  body: unknown,
): { ok: true; released: number } | { ok: false; error: "invalid-ack" } {
  const request = parseChangeEvidenceAck(body);
  if (!request) return { ok: false, error: "invalid-ack" };
  return { ok: true, ...spool.acknowledge(request) };
}
