import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { defineDomain } from "./domain.js";
import {
  InvalidEventPayloadError,
  decodeEventPayload,
  defineEvent,
  isEventDef,
  validateEventPayload,
  type PayloadOf,
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
    for (const name of ["Renamed", "renamed_event", "", "-x"]) {
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
