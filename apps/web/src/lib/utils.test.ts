import { describe, expect, test } from "bun:test";
import { createSessionKey, getEnvironmentIdFromSessionKey } from "./utils";

describe("createSessionKey / getEnvironmentIdFromSessionKey", () => {
  test("round-trips an environment id through a session key", () => {
    const envId = "a33f9026-8cfe-4077-aefd-4db2c2637dcc";
    const key = createSessionKey(envId, "default");
    expect(getEnvironmentIdFromSessionKey(key)).toBe(envId);
  });

  test("returns null for keys without the env- prefix", () => {
    expect(getEnvironmentIdFromSessionKey("some-other:tab")).toBeNull();
  });

  test("returns null for keys without a colon separator", () => {
    expect(getEnvironmentIdFromSessionKey("env-only")).toBeNull();
  });

  test("returns null when the environment id segment is empty", () => {
    expect(getEnvironmentIdFromSessionKey("env-:tab")).toBeNull();
  });
});
