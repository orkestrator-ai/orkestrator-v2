import { beforeEach, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { getContainerServerLog } from "./docker-skills";

const workspace = invoke as unknown as ReturnType<typeof mock>;
beforeEach(() => workspace.mockReset());

test("every container server's log is readable, and its previous run on request", async () => {
  for (const provider of ["opencode", "claude", "codex", "cursor", "grok", "pi"] as const) {
    await getContainerServerLog(provider, "container-a");
    await getContainerServerLog(provider, "container-a", { previous: true });
  }
  expect(workspace.mock.calls.slice(6, 10)).toEqual([
    ["get_cursor_server_log", { containerId: "container-a" }],
    ["get_cursor_server_log", { containerId: "container-a", previous: true }],
    ["get_grok_server_log", { containerId: "container-a" }],
    ["get_grok_server_log", { containerId: "container-a", previous: true }],
  ]);
  expect(workspace.mock.calls.at(-1)).toEqual([
    "get_pi_server_log",
    { containerId: "container-a", previous: true },
  ]);
  expect(workspace).toHaveBeenCalledTimes(12);
});

test("without previous, the active log is read", async () => {
  await getContainerServerLog("opencode", "container-a");
  await getContainerServerLog("codex", "container-a", { previous: false });
  expect(workspace.mock.calls).toEqual([
    ["get_opencode_server_log", { containerId: "container-a" }],
    ["get_codex_server_log", { containerId: "container-a" }],
  ]);
});
