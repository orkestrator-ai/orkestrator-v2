import { describe, expectTypeOf, test } from "bun:test";
import type { AppConfig, GlobalConfig } from "./index";

describe("configuration type contract", () => {
  test("exposes the optional review instruction consistently", () => {
    expectTypeOf<GlobalConfig["reviewInstruction"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AppConfig["global"]["reviewInstruction"]>().toEqualTypeOf<string | undefined>();
  });
});
