import { describe, expectTypeOf, test } from "bun:test";
import type { AppConfig, GlobalConfig } from "./index";

describe("configuration type contract", () => {
  test("exposes the optional review prompt consistently", () => {
    expectTypeOf<GlobalConfig["reviewPrompt"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<AppConfig["global"]["reviewPrompt"]>().toEqualTypeOf<string | undefined>();
  });
});
