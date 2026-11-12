import { describe, expect, mock, test } from "bun:test";
import { restartLaunchedTerminal } from "./restart-launched-terminal";

function backend(options: {
  status?: { running: boolean } | Error;
  launch?: { sessionId?: string } | Error;
}) {
  return {
    getTerminalSession: mock(async () => {
      if (options.status instanceof Error) throw options.status;
      return options.status ?? { running: false };
    }),
    launchTerminalJob: mock(async (_input: Record<string, unknown>) => {
      if (options.launch instanceof Error) throw options.launch;
      return options.launch ?? { sessionId: "new-session" };
    }),
  };
}

const base = { environmentId: "env-1", tabId: "terminal-job-1", tabType: "plain" as const };

describe("restartLaunchedTerminal", () => {
  test("starts a shell with no command when the tab has no session left", async () => {
    const api = backend({});
    const outcome = await restartLaunchedTerminal({
      ...base,
      backend: api,
      existingSessionId: undefined,
    });

    expect(outcome).toEqual({ kind: "restarted", sessionId: "new-session" });
    expect(api.getTerminalSession).not.toHaveBeenCalled();
    const [input] = api.launchTerminalJob.mock.calls[0]!;
    expect(input).toMatchObject({ environmentId: "env-1", tabId: "terminal-job-1" });
    expect(input).not.toHaveProperty("data");
    expect(String(input.requestId)).toStartWith("restart-shell-");
  });

  test("starts a shell when the backend says the old one is not running", async () => {
    const api = backend({ status: { running: false } });
    const outcome = await restartLaunchedTerminal({
      ...base,
      backend: api,
      existingSessionId: "old-session",
    });

    expect(outcome.kind).toBe("restarted");
    expect(api.getTerminalSession).toHaveBeenCalledWith("old-session");
  });

  test("attaches to a shell that is still running", async () => {
    const api = backend({ status: { running: true } });
    const outcome = await restartLaunchedTerminal({
      ...base,
      backend: api,
      existingSessionId: "old-session",
    });

    expect(outcome).toEqual({ kind: "attach" });
    expect(api.launchTerminalJob).not.toHaveBeenCalled();
  });

  test("does not replace a shell whose state could not be read", async () => {
    const api = backend({ status: new Error("node unreachable") });
    const outcome = await restartLaunchedTerminal({
      ...base,
      backend: api,
      existingSessionId: "old-session",
    });

    expect(outcome).toEqual({ kind: "attach" });
    expect(api.launchTerminalJob).not.toHaveBeenCalled();
  });

  test("leaves tab types the job command cannot start to a plain attach", async () => {
    const api = backend({});
    const outcome = await restartLaunchedTerminal({
      ...base,
      tabType: "root",
      backend: api,
      existingSessionId: undefined,
    });

    expect(outcome).toEqual({ kind: "attach" });
    expect(api.launchTerminalJob).not.toHaveBeenCalled();
  });

  test("reports a failed launch", async () => {
    const api = backend({ launch: new Error("Environment is not running with setup complete") });
    const outcome = await restartLaunchedTerminal({
      ...base,
      backend: api,
      existingSessionId: undefined,
    });

    expect(outcome).toEqual({
      kind: "failed",
      message: "Environment is not running with setup complete",
    });
  });
});
