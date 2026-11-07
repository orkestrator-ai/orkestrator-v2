import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RESOURCE_CHANGED_EVENT } from "../../resource-events.js";
import { canonicalJsonSchema } from "../json-schema.js";
import { EVENT_NAME_PATTERN, validateEventPayload } from "../event.js";
import {
  BACKEND_EVENTS,
  backendEventFor,
  claudeStateEvents,
  environmentAttentionEvent,
  relayedNodeEvents,
  resourceChangedEvent,
  terminalOutputEvents,
} from "./events.js";

const nameOf = (def: (typeof BACKEND_EVENTS)[number]): string =>
  def.kind === "event" ? def.name : `${def.prefix}*`;

describe("BACKEND_EVENTS", () => {
  it("names every event once, and no family prefix covers another event", () => {
    const names = BACKEND_EVENTS.map(nameOf);
    expect(new Set(names).size).toBe(names.length);
    for (const def of BACKEND_EVENTS) {
      if (def.kind === "event") {
        expect(def.name).toMatch(EVENT_NAME_PATTERN);
        expect(backendEventFor(def.name)).toBe(def);
        continue;
      }
      for (const other of BACKEND_EVENTS) {
        if (other !== def && other.kind === "event") expect(def.keyOf(other.name)).toBeNull();
        if (other !== def && other.kind === "event-family") {
          expect(other.prefix.startsWith(def.prefix)).toBe(false);
        }
      }
    }
  });

  it("every payload schema has a JSON Schema export (the manifest digests it)", () => {
    for (const def of BACKEND_EVENTS) {
      expect(() => canonicalJsonSchema(def.payload)).not.toThrow();
    }
  });

  it("resolves family members and unknown names", () => {
    expect(backendEventFor("terminal-output-abc")).toBe(terminalOutputEvents);
    expect(backendEventFor("claude-state-0123abcd")).toBe(claudeStateEvents);
    expect(backendEventFor("relayed-node-event:node-1")).toBe(relayedNodeEvents);
    expect(backendEventFor("relayed-node-event")).toBeNull();
    expect(backendEventFor("not-an-event")).toBeNull();
    expect(resourceChangedEvent.name).toBe(RESOURCE_CHANGED_EVENT);
  });
});

describe("payload schemas", () => {
  it("are tolerant readers: unknown keys pass, a newer resource kind passes", () => {
    const decoded = Schema.decodeUnknownResult(resourceChangedEvent.payload)(
      { resource: "a-kind-from-a-newer-backend", id: "x", revision: 3, extra: { y: 1 } },
      { onExcessProperty: "ignore" },
    );
    expect(Result.isSuccess(decoded)).toBe(true);
  });

  it("refuse a wrong type or a missing routing field", () => {
    expect(
      Result.isFailure(validateEventPayload(resourceChangedEvent, { resource: "kanban", id: "x" })),
    ).toBe(true);
    expect(
      Result.isFailure(
        validateEventPayload(environmentAttentionEvent, {
          attentionId: "a",
          environmentId: "e",
          projectId: "p",
          reason: "not-a-reason",
          occurredAt: "t",
        }),
      ),
    ).toBe(true);
  });

  it("accept optional fields that an emitter sets to undefined", () => {
    expect(
      Result.isSuccess(
        validateEventPayload(resourceChangedEvent, {
          resource: "kanban",
          id: "p",
          projectId: undefined,
          revision: 1,
        }),
      ),
    ).toBe(true);
  });
});
