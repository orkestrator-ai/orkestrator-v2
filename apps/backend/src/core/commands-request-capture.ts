import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  assertOnlyKeys,
  asNonBlankString,
  peekLocalAgentBridge,
  peekContainerAgentBridge,
} from "./commands-helpers.js";
import { boundedJson } from "./http-bridge-transport.js";

/** Reach only an existing bridge belonging to the selected environment. */
export function registerRequestCaptureCommands(register: CommandRegistrar): void {
  register("claude_request_capture", async (args, context) => {
    assertOnlyKeys(args, ["environmentId", "enabled", "name"], "arguments");
    if (args.enabled !== undefined && args.name !== undefined)
      throw new Error("Choose a setting change or a capture file");
    const environmentId = asNonBlankString(args.environmentId, "environmentId");
    const environment = (await context.storage.loadEnvironments()).find(
      (item) => item.id === environmentId,
    );
    if (!environment) throw new Error("Environment not found");
    const bridge =
      environment.environmentType === "local"
        ? await peekLocalAgentBridge(environmentId, context, "claude")
        : environment.containerId
          ? await peekContainerAgentBridge(environment.containerId, "claude")
          : null;
    if (!bridge) throw new Error("Start a Claude session in this environment first.");
    if (args.enabled !== undefined && typeof args.enabled !== "boolean")
      throw new Error("Expected enabled boolean");
    if (
      args.name !== undefined &&
      (typeof args.name !== "string" ||
        !/^[a-zA-Z0-9_-]+\.(request|response)\.json$/.test(args.name))
    )
      throw new Error("Invalid capture file");
    const port = "port" in bridge ? bridge.port : bridge.hostPort;
    const response = await fetch(
      `http://127.0.0.1:${port}/debug/request-capture${args.name ? `/${args.name}` : ""}`,
      {
        method: args.enabled === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${bridge.authToken}`,
          "Content-Type": "application/json",
        },
        ...(args.enabled === undefined ? {} : { body: JSON.stringify({ enabled: args.enabled }) }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        response.status === 404
          ? "Capture unavailable; update the environment's Claude bridge or refresh the list."
          : "Could not read Claude captures.",
      );
    }
    return boundedJson(response, "request capture", { remaining: 32 * 1024 * 1024 });
  });
}
