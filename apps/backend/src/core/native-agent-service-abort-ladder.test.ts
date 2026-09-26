/**
 * The backend's stop ladder against Pi's cancel acknowledgement (INC-05).
 *
 * Pi's `/abort` answers 202 `{ cancelled: false, pending: true }` when the
 * cancel is recorded but not yet proven — a prompt still starting, Pi's
 * preflight, or a provider abort that hangs or was refused. The ladder must
 * not read that body as a stop: it polls the authoritative `/status` (which the
 * bridge keeps `running` while a prompt claim exists) and escalates to
 * `/hard-abort` when the grace period passes. These cases drive the real HTTP
 * bridge provider against a scripted Pi bridge, so the request sequence is the
 * one the backend actually sends.
 */
import { describe, expect, test } from "bun:test";

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { httpProvider, piConnection } from "./agent-provider-test-support.js";
import { NativeAgentService } from "./native-agent-service.js";
import {
  addEnvironment,
  createStorage,
  refusingInvoke,
} from "./native-agent-service-projection-test-support.js";

const identity = {
  environmentId: "env-1",
  agent: "pi" as const,
  logicalSessionKey: "env-env-1:tab-pi-stop",
};

/**
 * A scripted Pi bridge. `/abort` always acknowledges as pending; `/status`
 * answers whatever `status()` says for the current poll; `/hard-abort` is
 * recorded and passed to `statusForPoll`, so a case decides when it settles.
 */
function scriptedPi(options: {
  statusForPoll: (poll: number, hardAborted: boolean) => "running" | "idle";
}) {
  const calls: string[] = [];
  let polls = 0;
  let hardAborted = false;
  const { provider } = httpProvider(
    (url, init) => {
      const method = init.method ?? "GET";
      const route = new URL(url).pathname;
      if (route === "/session/create" && method === "POST") {
        return Response.json({ sessionId: "pi-session" });
      }
      if (route === "/session/pi-session/abort" && method === "POST") {
        calls.push("abort");
        return Response.json({ cancelled: false, pending: true }, { status: 202 });
      }
      if (route === "/session/pi-session/hard-abort" && method === "POST") {
        calls.push("hard-abort");
        hardAborted = true;
        return Response.json({ cancelled: false, pending: true }, { status: 202 });
      }
      if (route === "/session/pi-session/status" && method === "GET") {
        polls += 1;
        calls.push("status");
        return Response.json({
          status: options.statusForPoll(polls, hardAborted),
          revision: polls,
          composer: { models: [], modes: [] },
        });
      }
      if (route.endsWith("/approvals") || route.endsWith("/interactions")) {
        return new Response("not found", { status: 404 });
      }
      if (route.endsWith("/runtime-health")) return Response.json({ summary: {} });
      // Transcript and other reads: an empty window that defers to `/status`.
      return Response.json({ messages: [] });
    },
    { ...piConnection, requestTimeoutMs: 1_000 },
  );
  return {
    provider,
    calls,
    /** Forget what session setup asked, so a case sees only the stop ladder. */
    reset: () => {
      calls.length = 0;
      polls = 0;
    },
  };
}

async function withPiService(
  prefix: string,
  provider: ReturnType<typeof scriptedPi>["provider"],
  abortGraceMs: number,
  run: (service: NativeAgentService) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), prefix));
  const storage = await createStorage(dataDir);
  await addEnvironment(storage);
  const service = new NativeAgentService(storage, refusingInvoke, {
    provider: async () => provider,
    abortGraceMs,
  });
  try {
    await run(service);
  } finally {
    await service.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function stopNotice(projection: { messages?: unknown[] } | null): string | undefined {
  const notices = (projection?.messages ?? []) as { content?: unknown }[];
  return notices
    .map((message) => message.content)
    .find(
      (content): content is string => typeof content === "string" && content.startsWith("The turn"),
    );
}

describe("Pi stop ladder", () => {
  test("a pending acknowledgement is polled, not trusted, and escalates to a hard abort", async () => {
    // Recorded but never proven within the grace period: still running on
    // every poll until the hard abort lands.
    const pi = scriptedPi({
      statusForPoll: (_poll, hardAborted) => (hardAborted ? "idle" : "running"),
    });
    await withPiService("orkestrator-pi-stop-escalates-", pi.provider, 250, async (service) => {
      await service.ensureSession(identity);
      pi.reset();

      const projection = await service.stopProjectionSession(identity);

      const ladder = pi.calls.filter((call) => call !== "status");
      expect(ladder).toEqual(["abort", "hard-abort"]);
      // Polled between the pending acknowledgement and the escalation.
      const firstHard = pi.calls.indexOf("hard-abort");
      expect(pi.calls.slice(1, firstHard).length).toBeGreaterThanOrEqual(2);
      expect(pi.calls.slice(1, firstHard).every((call) => call === "status")).toBe(true);
      expect(stopNotice(projection)).toBe(
        "The turn did not stop within the grace period and a force-stop was requested.",
      );
    });
  });

  test("a pending acknowledgement that settles within the grace period needs no escalation", async () => {
    // The recorded cancel is applied (e.g. at Pi's acceptance) and the bridge
    // reports idle on a later poll.
    const pi = scriptedPi({ statusForPoll: (poll) => (poll >= 2 ? "idle" : "running") });
    await withPiService("orkestrator-pi-stop-graceful-", pi.provider, 5_000, async (service) => {
      await service.ensureSession(identity);
      pi.reset();

      const projection = await service.stopProjectionSession(identity);

      expect(pi.calls.filter((call) => call !== "status")).toEqual(["abort"]);
      expect(pi.calls.filter((call) => call === "status").length).toBeGreaterThanOrEqual(2);
      expect(stopNotice(projection)).toBe("The turn stopped after a graceful interrupt.");
    });
  });
});
