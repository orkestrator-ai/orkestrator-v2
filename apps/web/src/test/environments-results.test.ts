import { describe, expect, test } from "bun:test";
import { decodeCommandResult } from "@orkestrator/protocol/contract/command";
import { ENVIRONMENTS_COMMANDS } from "@orkestrator/protocol/contract/domains/environments";
import * as Result from "effect/Result";
import { clientEnvironmentFixture, environmentsResultFixture } from "./environments-results";

describe("environments result fixtures", () => {
  test.each(ENVIRONMENTS_COMMANDS.map((def) => [def.name, def] as const))(
    "%s: the fixture answer decodes",
    (_name, def) => {
      const decoded = decodeCommandResult(def, environmentsResultFixture(def.name));
      expect(Result.isSuccess(decoded)).toBe(true);
    },
  );

  test("the environment fixture keeps its overrides", () => {
    expect(clientEnvironmentFixture({ id: "env-2", status: "running" })).toMatchObject({
      id: "env-2",
      status: "running",
    });
  });

  test("a command of another domain has no fixture", () => {
    expect(environmentsResultFixture("get_projects")).toBeUndefined();
  });
});
