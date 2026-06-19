import { beforeEach, describe, expect, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { getSetupCommands, runEnvironmentSetup, setEnvironmentSetupComplete } from "./backend";

const invokeMock = invoke as unknown as {
  mockReset: () => void;
  mockResolvedValue: (value: unknown) => void;
  mock: { calls: unknown[][] };
};

describe("backend setup wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  test("calls the setup-complete Electron command with the expected payload", async () => {
    await setEnvironmentSetupComplete("env-1", true);

    expect(invokeMock.mock.calls).toEqual([
      ["set_environment_setup_complete", { environmentId: "env-1", complete: true }],
    ]);
  });

  test("calls the get-setup-commands Electron command with the environment id", async () => {
    invokeMock.mockResolvedValue(["bun install"]);

    const commands = await getSetupCommands("env-1");

    expect(commands).toEqual(["bun install"]);
    expect(invokeMock.mock.calls).toEqual([
      ["get_setup_commands", { environmentId: "env-1" }],
    ]);
  });

  test("calls the run-environment-setup Electron command with the environment id", async () => {
    await runEnvironmentSetup("env-1");

    expect(invokeMock.mock.calls).toEqual([
      ["run_environment_setup", { environmentId: "env-1" }],
    ]);
  });
});
