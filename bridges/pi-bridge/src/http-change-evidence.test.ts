/**
 * The change-evidence routes over the real Pi router: read, body fetch and
 * acknowledgment, behind the same bridge token as the transcript routes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { ChangeEvidenceReadResponse } from "@orkestrator/protocol/change-evidence";

// `config.ts` reads its environment once, at import; load the router after.
process.env.PORT = "0";
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { authToken: TOKEN } = await import("./config.js");
const { newSessionState } = await import("./agent-session.js");
const { recordToolResult, setChangeEvidenceForTests } = await import("./change-evidence.js");
const { nativeFetch } = await import("./testing/native-fetch.js");

let origin: string;

beforeAll(async () => {
  await start(0);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setChangeEvidenceForTests(undefined);
  await shutdown();
});

beforeEach(() => {
  setChangeEvidenceForTests({});
});

function call(path: string, init: RequestInit = {}, token = TOKEN): Promise<Response> {
  return nativeFetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

const PATCH = "--- a.ts\n+++ a.ts\n@@ -1 +1 @@\n-x\n+y\n";

function recordEdit(): void {
  recordToolResult(newSessionState(), {
    toolCallId: "edit-1",
    toolName: "edit",
    input: { path: "a.ts" },
    details: { patch: PATCH },
    isError: false,
  });
}

describe("change-evidence routes", () => {
  test("require the bridge token", async () => {
    expect((await call("/change-evidence", {}, "wrong")).status).toBe(401);
    expect((await call("/change-evidence/body?id=x", {}, "wrong")).status).toBe(401);
    expect(
      (await call("/change-evidence/ack", { method: "POST", body: "{}" }, "wrong")).status,
    ).toBe(401);
  });

  test("serve entries and bodies, and release them only on acknowledgment", async () => {
    recordEdit();
    const read = (await (
      await call("/change-evidence?cursor=0")
    ).json()) as ChangeEvidenceReadResponse;
    expect(read.entries).toHaveLength(1);
    expect(read.capabilities[0]?.beforeTool).toBe("awaited");
    const entry = read.entries[0]!;
    if (entry.type !== "frame" || entry.frame.event.kind !== "tool")
      throw new Error("expected a tool frame");
    const update = entry.frame.event.evidence[0]!;
    if (update.kind !== "replace" || update.evidence.kind !== "patch")
      throw new Error("expected a patch");
    const bodyId = update.evidence.body.id;

    const body = (await (
      await call(`/change-evidence/body?id=${encodeURIComponent(bodyId)}`)
    ).json()) as {
      state: string;
      base64: string;
    };
    expect(body.state).toBe("available");
    expect(Buffer.from(body.base64, "base64").toString("utf8")).toBe(PATCH);

    // A read is not an acknowledgment.
    const again = (await (
      await call("/change-evidence?cursor=0")
    ).json()) as ChangeEvidenceReadResponse;
    expect(again.entries).toHaveLength(1);

    // A stale epoch releases nothing.
    const stale = await call("/change-evidence/ack", {
      method: "POST",
      body: JSON.stringify({
        runtimeEpoch: "other",
        upTo: read.nextCursor,
        retainedBodyIds: [bodyId],
      }),
    });
    expect(await stale.json()).toEqual({ released: 0 });

    const ack = await call("/change-evidence/ack", {
      method: "POST",
      body: JSON.stringify({
        runtimeEpoch: read.runtimeEpoch,
        upTo: read.nextCursor,
        retainedBodyIds: [bodyId],
        unavailableBodyIds: [],
      }),
    });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ released: 1 });

    const after = (await (
      await call(`/change-evidence?cursor=${read.nextCursor}`)
    ).json()) as ChangeEvidenceReadResponse;
    expect(after.entries).toHaveLength(0);
    const missing = await (
      await call(`/change-evidence/body?id=${encodeURIComponent(bodyId)}`)
    ).json();
    expect(missing).toEqual({ id: bodyId, state: "missing" });
  });

  test("answer an unknown body in band and refuse a malformed ack", async () => {
    const missing = await call("/change-evidence/body?id=sha256:nope");
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ id: "sha256:nope", state: "missing" });

    const bad = await call("/change-evidence/ack", {
      method: "POST",
      body: JSON.stringify({ upTo: -1 }),
    });
    expect(bad.status).toBe(400);
  });
});
