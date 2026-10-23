import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD, harness, thread } from "./app-server-engine-test-harness.js";
import type { EngineTurnConfig } from "./types.js";

const DENIED: EngineTurnConfig = {
  ...BUILD,
  networkAccessEnabled: false,
  policy: {
    id: "pipeline",
    sandbox: "provider",
    approvals: "auto-approve",
    projectResources: false,
    networkAccess: "restricted",
    capabilityPolicy: { deny: ["network"] },
  },
};

const record = (type: string, payload: unknown) => `${JSON.stringify({ type, payload })}\n`;
const declaration = record("response_item", {
  type: "additional_tools",
  tools: [{ name: "web__run" }],
});

describe("tool history configuration lock", () => {
  for (const operation of ["start", "resume", "fork"] as const) {
    test.each([true, undefined, null, "false", 0])(
      `refuses ${operation} unless incremental_tools is explicitly false (%s)`,
      async (value) => {
        const h = harness({
          "config/read": () => ({ config: { features: { incremental_tools: value } } }),
        });
        try {
          const pending =
            operation === "start"
              ? h.engine.startThread({ config: DENIED })
              : operation === "resume"
                ? h.engine.resumeThread("existing", { config: DENIED })
                : h.engine.forkThread("existing", DENIED);
          await expect(pending).rejects.toThrow("tool declarations stay out of thread history");
          expect(h.child().requests.filter((r) => r.method.startsWith("thread/"))).toEqual([]);
        } finally {
          await h.engine.stop();
        }
      },
    );
  }

  test("an unreadable configuration refuses work and does not cache verification", async () => {
    let unreadable = true;
    const h = harness({
      "config/read": () => {
        if (unreadable) throw new Error("config unavailable");
        return { config: { features: { incremental_tools: false } } };
      },
      "thread/start": () => ({ thread: thread("fresh") }),
    });
    try {
      await expect(h.engine.startThread({ config: DENIED })).rejects.toThrow("config unavailable");
      expect(h.child().requests.some((r) => r.method === "thread/start")).toBe(false);
      unreadable = false;
      await h.engine.startThread({ config: DENIED });
      expect(h.child().requests.filter((r) => r.method === "config/read")).toHaveLength(2);
    } finally {
      await h.engine.stop();
    }
  });

  test("generation death during config read refuses dispatch into a replacement", async () => {
    const h = harness();
    const supervisor = h.engine.getSupervisor();
    const request = supervisor.requestOnGeneration.bind(supervisor);
    const spy = spyOn(supervisor, "requestOnGeneration").mockImplementation(
      async (generation, method, params, options) => {
        const result = await request(generation, method, params, options);
        if (method === "config/read") h.child().exit(1);
        return result;
      },
    );
    try {
      await expect(h.engine.startThread({ config: DENIED })).rejects.toThrow(
        "tool history verification",
      );
      expect(h.children).toHaveLength(1);
      expect(h.child().requests.some((r) => r.method.startsWith("thread/"))).toBe(false);
    } finally {
      spy.mockRestore();
      await h.engine.stop();
    }
  });

  test("verifies once per generation and rechecks after replacement", async () => {
    let locked = true;
    const h = harness({
      "config/read": () => ({ config: { features: { incremental_tools: !locked } } }),
      "thread/start": () => ({ thread: thread("fresh") }),
      "thread/resume": () => ({ thread: thread("existing") }),
      "thread/fork": () => ({ thread: thread("forked") }),
    });
    try {
      await h.engine.startThread({ config: DENIED });
      await h.engine.resumeThread("existing", { config: DENIED });
      await h.engine.forkThread("existing", DENIED);
      const first = h.child();
      expect(first.requests.filter((r) => r.method === "config/read")).toHaveLength(1);
      first.exit(1);
      locked = false;
      await expect(h.engine.startThread({ config: DENIED })).rejects.toThrow(
        "tool declarations stay out",
      );
      expect(h.child()).not.toBe(first);
      expect(h.child().requests.filter((r) => r.method === "config/read")).toHaveLength(1);
      expect(h.child().requests.some((r) => r.method.startsWith("thread/"))).toBe(false);
    } finally {
      await h.engine.stop();
    }
  });
});

describe("production tool history reader", () => {
  for (const source of ["reported path", "discovered path"] as const) {
    test.each([
      "clean",
      "declares",
      "ancestor declares",
      "missing ancestor",
      "missing rollout",
    ] as const)(`${source}: %s`, async (verdict) => {
      const root = await mkdtemp(join(tmpdir(), "engine-tool-history-"));
      const home = join(root, "home");
      const sessions = join(home, "sessions");
      await mkdir(sessions, { recursive: true });
      const id = `thread-${root.split("/").at(-1)}`;
      const parentId = `parent-${id}`;
      // Reported paths live outside the home, so discovery cannot rescue a
      // failure to retain the app-server's thread.path.
      const path = join(source === "reported path" ? root : sessions, `${id}.jsonl`);
      const parent = join(sessions, `${parentId}.jsonl`);
      const inherited = verdict === "ancestor declares" || verdict === "missing ancestor";
      const meta = record("session_meta", {
        id,
        ...(inherited ? { history_base: { thread_id: parentId } } : {}),
      });
      if (verdict !== "missing rollout")
        await writeFile(path, meta + (verdict === "declares" ? declaration : ""));
      if (verdict === "ancestor declares")
        await writeFile(parent, record("session_meta", { id: parentId }) + declaration);
      const h = harness(
        {
          "thread/resume": () => ({
            thread: thread(id, source === "reported path" ? { path } : {}),
          }),
          "thread/unsubscribe": () => ({ status: "unsubscribed" }),
          "thread/fork": () => ({ thread: thread(`fork-${id}`) }),
        },
        { codexHome: home, toolHistoryVerdict: undefined },
      );
      try {
        const resumed = h.engine.resumeThread(id, { config: DENIED });
        if (verdict === "clean") {
          expect((await resumed).id).toBe(id);
          await h.engine.forkThread(id, DENIED);
          expect(h.child().requests.some((r) => r.method === "thread/fork")).toBe(true);
        } else {
          await expect(resumed).rejects.toThrow(
            verdict.includes("missing") ? "Could not confirm" : "still declares",
          );
          expect(h.child().requests.at(-1)?.method).toBe("thread/unsubscribe");
          await expect(h.engine.forkThread(id, DENIED)).rejects.toThrow("web search off");
          expect(h.child().requests.some((r) => r.method === "thread/fork")).toBe(false);
        }
      } finally {
        await h.engine.stop();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
