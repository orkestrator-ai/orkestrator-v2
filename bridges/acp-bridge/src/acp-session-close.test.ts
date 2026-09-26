import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { here, nativeFetch, spawnBridge, temporaryDirectory, waitFor } from "./acp-test-harness.js";

type Body = Record<string, unknown>;

async function close(base: string, headers: Record<string, string>, id: string) {
  const response = await nativeFetch(`${base}/session/${encodeURIComponent(id)}/close`, {
    method: "POST",
    headers,
  });
  return { status: response.status, body: (await response.json()) as Body };
}

const CLOSED = { status: 200, body: { closed: true, retained: true } };
const MISSING = { status: 200, body: { closed: true, missing: true } };
const PENDING = {
  status: 503,
  body: { closed: false, pending: true, error: "Session close did not complete" },
};
const CLOSING = { status: 409, body: { error: "Session is closing" } };

/**
 * A Grok bridge over `testing/fake-agent-close.ts`, whose sessions are real
 * (distinct ids, listed and loaded from its own store) and whose lifecycle
 * events land in `log` for ordering assertions.
 */
async function closeFixture(env: Record<string, string> = {}) {
  const directory = await temporaryDirectory();
  const log = resolve(directory, "close.log");
  const stateDirectory = resolve(directory, "state");
  const { base, headers } = await spawnBridge({
    stateDirectory,
    env: {
      ACP_PROVIDER: "grok",
      ACP_AGENT_PATH: resolve(here, "testing/fake-agent-close.ts"),
      FAKE_CLOSE_LOG: log,
      FAKE_CLOSE_STORE: resolve(directory, "store.jsonl"),
      ...env,
    },
  });
  const request = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await nativeFetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: (await response.json()) as Body };
  };
  const events = async (): Promise<Array<{ pid: string; event: string }>> => {
    const text = await fs.readFile(log, "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(" ");
        return { pid: line.slice(0, space), event: line.slice(space + 1) };
      });
  };
  const waitForEvent = (event: string, count = 1) =>
    waitFor(events, (list) => list.filter((entry) => entry.event === event).length >= count);
  const create = async (body: Body = {}) => {
    const created = await request("/session/create", { method: "POST", body });
    expect(created.status).toBe(201);
    return String(created.body.id);
  };
  const prompt = (id: string, text: string) =>
    request(`/session/${id}/prompt`, { method: "POST", body: { prompt: text } });
  const waitForStatus = (id: string, status: string) =>
    waitFor(
      () => request(`/session/${id}/status`),
      (value) => value.body.status === status,
    );
  return {
    base,
    headers,
    directory,
    stateFile: join(stateDirectory, "state.json"),
    request,
    events,
    waitForEvent,
    create,
    prompt,
    waitForStatus,
    close: (id: string) => close(base, headers, id),
  };
}

describe("POST /session/:id/close", () => {
  test("denies a parked permission, stops the agent, and keeps the conversation resumable", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "close-lifecycle.log");
    const { base, headers } = await spawnBridge({
      env: { ACP_PROVIDER: "grok", FAKE_ACP_LIFECYCLE_FILE: lifecycleFile },
    });
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };

    const prompt = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Do the work" }),
    });
    expect(prompt.status).toBe(202);
    await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 1,
    );

    expect(await close(base, headers, created.id)).toEqual(CLOSED);
    // The agent child was terminated, not left running a turn nobody owns.
    expect(await fs.readFile(lifecycleFile, "utf8")).toMatch(/stop:\d+/);
    const read = await nativeFetch(`${base}/session/${created.id}`, { headers });
    expect(read.status).toBe(404);

    // A lost response retries into an in-band confirmation.
    expect(await close(base, headers, created.id)).toEqual(MISSING);
  });

  test("answers an unknown session in band rather than 404", async () => {
    const { base, headers } = await spawnBridge({ env: { ACP_PROVIDER: "grok" } });
    expect(await close(base, headers, "never-existed")).toEqual(MISSING);
  });

  test("lists and resumes the conversation that was actually closed", async () => {
    const bridge = await closeFixture();
    const id = await bridge.create();
    expect((await bridge.prompt(id, "Remember the lighthouse")).status).toBe(202);
    await bridge.waitForStatus(id, "idle");
    const token = String((await bridge.request(`/session/${id}/status`)).body.resumableSessionId);
    expect(token).toStartWith("acp-session:");

    const titled = (listing: Body) =>
      (listing.sessions as Array<{ id: string; title?: string }>).filter(
        (session) => session.title === "Remember the lighthouse",
      );
    // While the tab is open, the listing points at the live bridge session.
    expect(titled((await bridge.request("/session/list")).body)).toEqual([
      { id, title: "Remember the lighthouse" },
    ]);

    expect(await bridge.close(id)).toEqual(CLOSED);

    // After close the same vendor conversation is listed by its resumable id.
    expect(titled((await bridge.request("/session/list")).body)).toEqual([
      { id: token, title: "Remember the lighthouse" },
    ]);
    const resumed = await bridge.request("/session/resume", {
      method: "POST",
      body: { sessionId: token },
    });
    expect(resumed.status).toBe(201);
    const resumedId = String(resumed.body.sessionId);
    expect(resumedId).not.toBe(id);
    const reopened = await bridge.request(`/session/${resumedId}`);
    expect(
      (reopened.body.messages as Array<{ role: string; content: string }>).map((message) => [
        message.role,
        message.content,
      ]),
    ).toEqual([
      ["user", "Remember the lighthouse"],
      ["assistant", "Answer to: Remember the lighthouse"],
    ]);
    expect((await bridge.request(`/session/${resumedId}/status`)).body.resumableSessionId).toBe(
      token,
    );
  });

  test("denies the parked permission, question and plan approval before stopping", async () => {
    const bridge = await closeFixture();
    const id = await bridge.create();
    expect((await bridge.prompt(id, "ASK_ALL")).status).toBe(202);
    await waitFor(
      async () => [
        (await bridge.request(`/session/${id}/approvals`)).body.approvals as unknown[],
        (await bridge.request(`/session/${id}/interactions`)).body.interactions as unknown[],
      ],
      ([approvals, interactions]) => approvals!.length === 1 && interactions!.length === 2,
    );

    expect(await bridge.close(id)).toEqual(CLOSED);

    const events = (await bridge.events()).map((entry) => entry.event);
    const replies = events.filter((event) => event.startsWith("reply:"));
    expect(replies.sort()).toEqual([
      'reply:permission:{"outcome":{"outcome":"cancelled"}}',
      'reply:plan:{"outcome":"cancelled"}',
      'reply:question:{"outcome":"cancelled"}',
    ]);
    const lastReply = Math.max(...replies.map((reply) => events.indexOf(reply)));
    expect(lastReply).toBeLessThan(events.indexOf("cancel"));
    expect(events.indexOf("cancel")).toBeLessThan(events.indexOf("stop"));
  });

  test("waits for the cancelled turn to answer before terminating the agent", async () => {
    const bridge = await closeFixture({ FAKE_CLOSE_CANCEL_DELAY_MS: "300" });
    const id = await bridge.create();
    expect((await bridge.prompt(id, "HOLD")).status).toBe(202);
    await bridge.waitForEvent("held");

    expect(await bridge.close(id)).toEqual(CLOSED);

    const events = (await bridge.events()).map((entry) => entry.event);
    expect(events.filter((event) => event !== "start")).toEqual([
      "held",
      "cancel",
      "answered-cancelled",
      "stop",
    ]);
  });

  test("terminates the agent once the cancel budget elapses without an answer", async () => {
    const bridge = await closeFixture({
      FAKE_CLOSE_IGNORE_CANCEL: "1",
      ACP_CLOSE_CANCEL_WAIT_MS: "200",
    });
    const id = await bridge.create();
    expect((await bridge.prompt(id, "HOLD")).status).toBe(202);
    await bridge.waitForEvent("held");

    expect(await bridge.close(id)).toEqual(CLOSED);
    const events = (await bridge.events()).map((entry) => entry.event);
    expect(events.filter((event) => event !== "start")).toEqual(["held", "cancel", "stop"]);
  });

  test("concurrent closes of one session share one operation", async () => {
    const bridge = await closeFixture({ FAKE_CLOSE_CANCEL_DELAY_MS: "400" });
    const id = await bridge.create();
    expect((await bridge.prompt(id, "HOLD")).status).toBe(202);
    await bridge.waitForEvent("held");

    const [first, second] = await Promise.all([bridge.close(id), bridge.close(id)]);
    // The second close joined the first: neither answered `missing`.
    expect(first).toEqual(CLOSED);
    expect(second).toEqual(CLOSED);
    const events = (await bridge.events()).map((entry) => entry.event);
    expect(events.filter((event) => event === "cancel")).toHaveLength(1);
    expect(events.filter((event) => event === "stop")).toHaveLength(1);
    expect(await bridge.close(id)).toEqual(MISSING);
  });

  test("refuses new work on a session while it is closing", async () => {
    const bridge = await closeFixture({ FAKE_CLOSE_CANCEL_DELAY_MS: "1500" });
    const id = await bridge.create({ clientSessionKey: "tab-closing" });
    expect((await bridge.prompt(id, "HOLD")).status).toBe(202);
    await bridge.waitForEvent("held");

    const closing = bridge.close(id);
    await bridge.waitForEvent("cancel");

    expect(await bridge.prompt(id, "Another turn")).toEqual(CLOSING);
    expect(await bridge.request(`/session/${id}/attach`, { method: "POST", body: {} })).toEqual(
      CLOSING,
    );
    expect(
      await bridge.request(`/session/${id}/config`, { method: "POST", body: { modeId: "plan" } }),
    ).toEqual(CLOSING);
    expect(
      await bridge.request("/session/resume", { method: "POST", body: { sessionId: id } }),
    ).toEqual(CLOSING);
    expect(
      await bridge.request("/session/create", {
        method: "POST",
        body: { clientSessionKey: "tab-closing" },
      }),
    ).toEqual(CLOSING);
    // Still registered and readable: a lookup never reads as missing mid-close.
    expect((await bridge.request(`/session/${id}`)).status).toBe(200);

    expect(await closing).toEqual(CLOSED);
    expect((await bridge.request(`/session/${id}`)).status).toBe(404);
    // Only the one agent child ever ran: nothing re-attached during the close.
    const starts = (await bridge.events()).filter((entry) => entry.event === "start");
    expect(starts).toHaveLength(1);
  });

  test("a close that outlives its attach budget stays pending and registered until retried", async () => {
    const hold = resolve(await temporaryDirectory(), "release-load");
    const bridge = await closeFixture({
      ACP_CLOSE_ATTACH_WAIT_MS: "200",
      FAKE_CLOSE_LOAD_HOLD_FILE: hold,
    });
    const id = await bridge.create();
    // Lose the child so the next attach has to spawn and `session/load`.
    expect((await bridge.prompt(id, "CRASH")).status).toBe(202);
    await bridge.waitForStatus(id, "error");
    const attaching = bridge.request(`/session/${id}/attach`, { method: "POST", body: {} });
    await bridge.waitForEvent("load");

    expect(await bridge.close(id)).toEqual(PENDING);
    // The retry reaches the same session: pending again, never `missing`.
    expect(await bridge.close(id)).toEqual(PENDING);
    expect((await bridge.request(`/session/${id}`)).status).toBe(200);
    // A pending close keeps the fence up (fail closed).
    expect(await bridge.prompt(id, "Another turn")).toEqual(CLOSING);

    await fs.writeFile(hold, "");
    // The attach finished inside a close; it is refused, not reported attached.
    expect(await attaching).toEqual(CLOSING);
    expect(await bridge.close(id)).toEqual(CLOSED);
    const late = (await bridge.events()).find((entry) => entry.event === "load")!.pid;
    expect(
      (await bridge.events()).some((entry) => entry.pid === late && entry.event === "stop"),
    ).toBe(true);
    expect(await bridge.close(id)).toEqual(MISSING);
  });

  test("a close racing an attach waits for it and terminates the late child", async () => {
    const hold = resolve(await temporaryDirectory(), "release-load");
    const bridge = await closeFixture({ FAKE_CLOSE_LOAD_HOLD_FILE: hold });
    const id = await bridge.create();
    expect((await bridge.prompt(id, "CRASH")).status).toBe(202);
    await bridge.waitForStatus(id, "error");
    const attaching = bridge.request(`/session/${id}/attach`, { method: "POST", body: {} });
    await bridge.waitForEvent("load");

    let settled = false;
    const closing = bridge.close(id).finally(() => {
      settled = true;
    });
    await Bun.sleep(150);
    // Still waiting on the attach, and still registered while it does.
    expect(settled).toBe(false);
    expect((await bridge.request(`/session/${id}`)).status).toBe(200);

    await fs.writeFile(hold, "");
    expect(await closing).toEqual(CLOSED);
    expect(await attaching).toEqual(CLOSING);
    const late = (await bridge.events()).find((entry) => entry.event === "load")!.pid;
    expect(
      (await bridge.events()).some((entry) => entry.pid === late && entry.event === "stop"),
    ).toBe(true);
    expect((await bridge.request(`/session/${id}`)).status).toBe(404);
  });

  test("a failed state-file write answers pending and keeps the session registered", async () => {
    const bridge = await closeFixture();
    const id = await bridge.create();
    expect((await bridge.prompt(id, "Keep this one")).status).toBe(202);
    await bridge.waitForStatus(id, "idle");
    // A directory where the state file belongs makes the atomic rename fail.
    await fs.rm(bridge.stateFile, { force: true });
    await fs.mkdir(bridge.stateFile);
    await fs.writeFile(join(bridge.stateFile, "occupied"), "");

    expect(await bridge.close(id)).toEqual(PENDING);
    expect((await bridge.request(`/session/${id}`)).status).toBe(200);
    // Still listed as the live bridge session, not as a closed conversation.
    const listed = (await bridge.request("/session/list")).body.sessions as Array<{ id: string }>;
    expect(listed.map((session) => session.id)).toContain(id);
    expect(await bridge.prompt(id, "Another turn")).toEqual(CLOSING);

    await fs.rm(bridge.stateFile, { recursive: true, force: true });
    expect(await bridge.close(id)).toEqual(CLOSED);
    const persisted = JSON.parse(await fs.readFile(bridge.stateFile, "utf8")) as {
      sessions: Array<{ id: string }>;
    };
    expect(persisted.sessions.map((session) => session.id)).not.toContain(id);
    expect(await bridge.close(id)).toEqual(MISSING);
  });
});

describe("POST /session/:id/cancel and /abort", () => {
  // Cancel stops the turn but keeps the session, so it must fail closed on
  // everything parked on a person exactly as close does. It used to answer
  // only the permission, leaving a question and a plan approval actionable
  // against a turn the user had already stopped.
  test.each(["cancel", "abort"])(
    "%s denies the parked permission, question and plan approval before cancelling",
    async (action) => {
      const bridge = await closeFixture({ FAKE_CLOSE_CANCEL_DELAY_MS: "0" });
      const id = await bridge.create();
      expect((await bridge.prompt(id, "ASK_ALL")).status).toBe(202);
      await waitFor(
        async () => [
          (await bridge.request(`/session/${id}/approvals`)).body.approvals as unknown[],
          (await bridge.request(`/session/${id}/interactions`)).body.interactions as unknown[],
        ],
        ([approvals, interactions]) => approvals!.length === 1 && interactions!.length === 2,
      );

      const cancelled = await bridge.request(`/session/${id}/${action}`, { method: "POST" });
      expect(cancelled).toEqual({ status: 202, body: { accepted: true } });

      // Withdrawn synchronously: nothing is left for a stale card to answer.
      expect((await bridge.request(`/session/${id}/approvals`)).body.approvals).toEqual([]);
      expect((await bridge.request(`/session/${id}/interactions`)).body.interactions).toEqual([]);
      await bridge.waitForEvent("answered-cancelled");
      const events = (await bridge.events()).map((entry) => entry.event);
      const replies = events.filter((event) => event.startsWith("reply:"));
      expect(replies.sort()).toEqual([
        'reply:permission:{"outcome":{"outcome":"cancelled"}}',
        'reply:plan:{"outcome":"cancelled"}',
        'reply:question:{"outcome":"cancelled"}',
      ]);
      const lastReply = Math.max(...replies.map((reply) => events.indexOf(reply)));
      expect(lastReply).toBeLessThan(events.indexOf("cancel"));
      // Cancel keeps the session and its agent: no stop, and it settles idle.
      expect(events).not.toContain("stop");
      await bridge.waitForStatus(id, "idle");
    },
  );
});
