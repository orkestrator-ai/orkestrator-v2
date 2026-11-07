/**
 * Typed backend events (plan item 7011, report §11.1-§11.2).
 *
 * The backend emits only contract definitions: `emit(def, payload)` with
 * `def` from `@orkestrator/protocol/contract/domains/events` and `payload`
 * typed by its schema. Dynamic names are event families
 * (`terminalOutputEvents.at(sessionId)`). The transport underneath (the
 * gateway's SSE fan-out, a test's recorder) is a {@link BackendEventSink}
 * that still sees `(name, payload)`.
 *
 * In development and tests every emit is checked: the payload against the
 * definition's schema, a family member's key against its pattern, and the
 * definition against `BACKEND_EVENTS` (so the manifest lists every event).
 * Tests throw `InvalidEventPayloadError`; development logs and still
 * delivers, so a schema slip never takes a dev backend's background loop down.
 * Production does no checking: the payload is passed through unchanged.
 */
import {
  InvalidEventPayloadError,
  hasValidEventKey,
  validateEventPayload,
  type AnyEventDef,
  type PayloadOf,
} from "@orkestrator/protocol/contract/event";
import { BACKEND_EVENTS } from "@orkestrator/protocol/contract/domains/events";
import { createLogger } from "@orkestrator/protocol/logger";
import * as Result from "effect/Result";

const log = createLogger("contract");

/** The transport an emitter writes to: the event's wire name and its payload. */
export type BackendEventSink = (event: string, payload: unknown) => void;

/** Emits one defined backend event. */
export type BackendEmit = <E extends AnyEventDef>(def: E, payload: PayloadOf<E>) => void;

/** What a development or test emit does with a payload that fails its checks. */
export type BackendEventValidation = "throw" | "log" | "off";

/** `throw` under tests, `log` in development, `off` otherwise (production). */
export function backendEventValidationDefault(
  env: { readonly NODE_ENV?: string | undefined } = process.env,
): BackendEventValidation {
  if (env.NODE_ENV === "test") return "throw";
  if (env.NODE_ENV === "development") return "log";
  return "off";
}

const LISTED: ReadonlySet<unknown> = new Set(BACKEND_EVENTS);

function isListed(def: AnyEventDef): boolean {
  return LISTED.has(def.family ?? def);
}

/** The first problem with an emit, or `null`. Values never appear in the message. */
function emitProblem(def: AnyEventDef, payload: unknown): InvalidEventPayloadError | Error | null {
  if (!isListed(def)) {
    return new Error(
      `Event ${def.family ? `${def.family.prefix}*` : def.name} is not listed in BACKEND_EVENTS.`,
    );
  }
  if (!hasValidEventKey(def)) return new Error(`Invalid key in event name ${def.name}.`);
  const validated = validateEventPayload(def, payload);
  return Result.isFailure(validated) ? validated.failure : null;
}

/**
 * The typed emitter over `sink`. `validation` defaults from `NODE_ENV`
 * ({@link backendEventValidationDefault}).
 */
export function createBackendEmit(
  sink: BackendEventSink,
  options: { readonly validation?: BackendEventValidation } = {},
): BackendEmit {
  const validation = options.validation ?? backendEventValidationDefault();
  if (validation === "off") return (def, payload) => sink(def.name, payload);
  return (def, payload) => {
    const problem = emitProblem(def, payload);
    if (problem) {
      if (validation === "throw") throw problem;
      log.error("event.invalid", {
        event: def.family ? `${def.family.prefix}*` : def.name,
        error: problem instanceof InvalidEventPayloadError ? "payload" : problem.message,
      });
    }
    sink(def.name, payload);
  };
}

/**
 * A test's recorder or a fixture's sink as a {@link BackendEmit}: emits reach
 * `sink` by name, checked as in tests. Use it wherever a fixture hands the
 * backend an `emit`, so assertions keep comparing event names.
 */
export function eventSink(sink: BackendEventSink): BackendEmit {
  return createBackendEmit(sink);
}
