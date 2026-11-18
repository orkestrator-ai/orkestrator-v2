import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readReadableHostFile,
  validateRelativeFilePath,
} from "../../apps/backend/src/core/path-safety";
import { newSessionState } from "../../bridges/cursor-bridge/src/agent-session";
import { applyInteractionUpdate } from "../../bridges/cursor-bridge/src/translate";
import type { NativeMessage } from "../../apps/web/src/lib/chat/native-message-types";

installFatalRejectionGuard({ label: "[cursor-recording-fixture]" });

const origin = process.env.RECORDING_FIXTURE_RENDERER_ORIGIN;
if (!origin) throw new Error("Recording fixture requires a renderer origin.");

const workspace = path.join(os.tmpdir(), "allowed-workspace");
const outside = path.join(os.tmpdir(), "outside-workspace", "settings.mp4");
const localPath = path.join(workspace, " shots.png", "run#2", "checkout.png.mp4");
const containerPath = " shots.png/run?3/settings.mp4";

// One second of synthetic color bars, encoded as H.264 for Chromium playback.
for (const destination of [localPath, path.join(workspace, containerPath), outside]) {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(import.meta.dirname, "cursor-recording-sample.mp4"), destination);
}

function recordingRows(recordingPath: string, outsidePath: string): NativeMessage[] {
  const state = newSessionState();
  state.status = "running";
  for (const [index, { mode, value }] of [
    { mode: "START_RECORDING", value: {} },
    { mode: "SAVE_RECORDING", value: { path: recordingPath, recordingDurationMs: 1000 } },
    { mode: "SAVE_RECORDING", value: { path: outsidePath, recordingDurationMs: 1000 } },
    { mode: "DISCARD_RECORDING", value: { path: recordingPath } },
  ].entries()) {
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      modelCallId: "recording-step",
      callId: `rec-${index}`,
      toolCall: { type: "recordScreen", args: { mode }, result: { status: "success", value } },
    });
  }
  return state.messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => part.type === "tool-invocation" || part.type === "file"),
  }));
}

const localRows = recordingRows(localPath, outside);
const containerRows = recordingRows(
  `/workspace/${containerPath}`,
  "/home/node/.cursor/outside.mp4",
);
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Credentials": "true",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (request.method === "OPTIONS") return new Response(null, { headers, status: 204 });
    if (pathname !== "/__orkestrator/invoke" || request.method !== "POST") {
      return new Response(null, { headers, status: 404 });
    }
    const { command, args } = (await request.json()) as {
      command: string;
      args: { filePath?: string; containerId?: string; container?: boolean };
    };
    if (command === "cursor_recording_fixture") {
      return Response.json({ result: args.container ? containerRows : localRows }, { headers });
    }
    try {
      let filePath = args.filePath;
      if (
        command === "read_container_file_base64" &&
        args.containerId === "fixture-container" &&
        filePath
      ) {
        // Map the simulated container's /workspace to disposable storage.
        filePath = path.join(workspace, validateRelativeFilePath(filePath));
      } else if (command !== "read_file_base64" || !filePath) {
        throw new Error("Unexpected recording fixture command");
      }
      const bytes = await readReadableHostFile(filePath, [workspace]);
      return Response.json({ result: bytes.toString("base64") }, { headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { headers, status: 400 });
    }
  },
});
process.once("SIGTERM", () => void server.stop(true));
process.stdout.write(`INTERACTION_FIXTURE_READY:${server.port}\n`);
