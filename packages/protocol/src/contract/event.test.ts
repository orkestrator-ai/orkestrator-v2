import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineDomain } from "./domain.js";
import {
  InvalidEventPayloadError,
  decodeEventPayload,
  defineEvent,
  defineEventFamily,
  hasValidEventKey,
  isEventDef,
  isEventFamilyDef,
  listenEvent,
  validateEventPayload,
  type PayloadOf,
  type RawEventSource,
} from "./event.js";

const environments = defineDomain({ name: "environments", version: 1 });

const environmentRenamed = defineEvent({
  domain: environments,
  name: "environment-renamed",
  payload: Schema.Struct({ environmentId: Schema.String, name: Schema.String }),
});

type Assert<T extends true> = T;
export type PayloadPin = Assert<
  PayloadOf<typeof environmentRenamed> extends {
    readonly environmentId: string;
    readonly name: string;
  }
    ? true
    : false
>;

describe("defineEvent", () => {
  it("returns a frozen definition and refuses invalid names", () => {
    expect(isEventDef(environmentRenamed)).toBe(true);
    expect(Object.isFrozen(environmentRenamed)).toBe(true);
    for (const name of ["Renamed", "renamed_event", "", "-x", "a:b:c", "a:", "a.b"]) {
      expect(() => defineEvent({ domain: environments, name, payload: Schema.Null })).toThrow(
        /event name/,
      );
    }
  });

  it("decodes payloads tolerantly and validates emitted ones", () => {
    const decoded = decodeEventPayload(environmentRenamed, {
      environmentId: "e1",
      name: "n",
      newer: true,
    });
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({
      environmentId: "e1",
      name: "n",
    });
    const bad = validateEventPayload(environmentRenamed, { environmentId: "e1" });
    expect(Result.isFailure(bad)).toBe(true);
    if (Result.isFailure(bad)) {
      expect(bad.failure).toBeInstanceOf(InvalidEventPayloadError);
      expect(bad.failure.event).toBe("environment-renamed");
    }
  });
});

describe("event names", () => {
  it("accepts one colon-separated kebab suffix", () => {
    expect(
      defineEvent({ domain: environments, name: "claude-tmux:event", payload: Schema.Null }).name,
    ).toBe("claude-tmux:event");
  });
});

const terminals = defineDomain({ name: "terminals", version: 1 });
const output = defineEventFamily({
  domain: terminals,
  prefix: "terminal-output-",
  payload: Schema.Struct({ text: Schema.String }),
});

export type FamilyPayloadPin = Assert<
  PayloadOf<ReturnType<typeof output.at>> extends { readonly text: string } ? true : false
>;

describe("defineEventFamily", () => {
  it("names members by key and recognises them", () => {
    expect(isEventFamilyDef(output)).toBe(true);
    expect(Object.isFrozen(output)).toBe(true);
    const member = output.at("abc-1");
    expect(isEventDef(member)).toBe(true);
    expect(member.name).toBe("terminal-output-abc-1");
    expect(member.family).toBe(output);
    expect(member.payload).toBe(output.payload);
    expect(output.keyOf("terminal-output-abc-1")).toBe("abc-1");
    expect(output.keyOf("terminal-output-")).toBeNull();
    expect(output.keyOf("resource-changed")).toBeNull();
  });

  it("checks member keys against the key pattern", () => {
    expect(hasValidEventKey(output.at("abc_1.2:3"))).toBe(true);
    expect(hasValidEventKey(output.at("bad key"))).toBe(false);
    expect(hasValidEventKey(output.at("-leading"))).toBe(false);
    expect(hasValidEventKey(environmentRenamed)).toBe(true);
  });

  it("refuses invalid prefixes and unanchored key patterns", () => {
    for (const prefix of ["terminal-output", "Terminal-", "", "a_b-"]) {
      expect(() => defineEventFamily({ domain: terminals, prefix, payload: Schema.Null })).toThrow(
        /prefix/,
      );
    }
    expect(() =>
      defineEventFamily({ domain: terminals, prefix: "x-", key: /[a-z]+/u, payload: Schema.Null }),
    ).toThrow(/anchored/);
    expect(() =>
      defineEventFamily({
        domain: terminals,
        prefix: "x-",
        key: /^[a-z]+$/gu,
        payload: Schema.Null,
      }),
    ).toThrow(/anchored/);
  });
});

function fakeSource(): RawEventSource & {
  deliver(event: string, payload: unknown): void;
  names(): string[];
} {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    listenRaw(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    deliver(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    names: () => Array.from(handlers.keys()),
  };
}

describe("listenEvent", () => {
  it("delivers decodable payloads as sent and refuses the rest", () => {
    const source = fakeSource();
    const received: unknown[] = [];
    const invalid: InvalidEventPayloadError[] = [];
    const stop = listenEvent(source, environmentRenamed, (payload) => received.push(payload), {
      onInvalid: (error) => invalid.push(error),
    });
    expect(source.names()).toEqual(["environment-renamed"]);
    const sent = { environmentId: "e1", name: "n", newer: 1 };
    source.deliver("environment-renamed", sent);
    source.deliver("environment-renamed", { environmentId: 1 });
    expect(received).toEqual([sent]);
    expect(received[0]).toBe(sent);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.event).toBe("environment-renamed");
    stop();
    source.deliver("environment-renamed", sent);
    expect(received).toHaveLength(1);
  });

  it("drops an invalid payload without onInvalid, and listens to family members", () => {
    const source = fakeSource();
    const received: string[] = [];
    listenEvent(source, output.at("s1"), (payload) => received.push(payload.text));
    source.deliver("terminal-output-s1", { text: "hi", revision: 1 });
    source.deliver("terminal-output-s1", { text: 5 });
    expect(received).toEqual(["hi"]);
  });
});
