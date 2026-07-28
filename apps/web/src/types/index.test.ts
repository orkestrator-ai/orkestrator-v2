import { describe, expectTypeOf, test } from "bun:test";
import type { AppConfig, Environment, GlobalConfig } from "./index";

describe("configuration type contract", () => {
  test("exposes the optional review instruction consistently", () => {
    expectTypeOf<GlobalConfig["reviewInstruction"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AppConfig["global"]["reviewInstruction"]>().toEqualTypeOf<string | undefined>();
  });

  test("exposes durable merge cleanup state to rehydrating clients", () => {
    expectTypeOf<Environment["cleanupAfterMergeRequestedAt"]>()
      .toEqualTypeOf<string | undefined>();
    expectTypeOf<Environment["cleanupAfterMergeError"]>()
      .toEqualTypeOf<string | undefined>();
  });
});
