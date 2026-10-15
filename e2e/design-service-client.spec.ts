import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignServiceClient, startDesignServiceHost } from "./design-service-client";

test.describe("design service host lifecycle", () => {
  test.setTimeout(10_000);

  function fixture(mode: string, timeoutMs = 1000) {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "fixtures/design-service-host.mjs"), mode],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    return { child, client: createDesignServiceClient(child, timeoutMs) };
  }

  for (const mode of ["hang-close", "hang-exit"]) {
    test(`kills a host that ${mode === "hang-close" ? "never replies to close" : "replies but never exits"}`, async () => {
      const { child, client } = fixture(mode, 100);
      try {
        await expect(client.invoke("ready", {})).resolves.toBe("ready");
        const start = Date.now();
        const close = client.close();
        expect(client.close()).toBe(close);
        await expect(client.invoke("late-request", {})).rejects.toThrow("host is closing");
        await close;
        expect(Date.now() - start).toBeLessThan(2000);
        expect(child.signalCode).toBe("SIGKILL");
        expect(child.pid).toBeDefined();
        expect(() => process.kill(child.pid!, 0)).toThrow();
      } finally {
        child.kill("SIGKILL");
        await client.close();
      }
    });
  }

  test("preserves a spawn error and closes promptly without an exit event", async () => {
    const child = spawn(join(tmpdir(), "missing-design-host-executable"), [], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const client = createDesignServiceClient(child, 100);
    let sawExit = false;
    child.on("exit", () => {
      sawExit = true;
    });
    await expect(client.invoke("ready", {})).rejects.toThrow("ENOENT");
    const start = Date.now();
    await client.close();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(sawExit).toBe(false);
    await expect(client.invoke("later", {})).rejects.toThrow("ENOENT");
  });

  test("closes a healthy host without killing it", async () => {
    const { child, client } = fixture("normal");
    try {
      await expect(client.invoke("ready", {})).resolves.toBe("ready");
      await client.close();
      expect(child.exitCode).toBe(0);
      expect(child.signalCode).toBeNull();
    } finally {
      await client.close();
    }
  });

  test("rejects pending requests on stdin failure and still terminates the host", async () => {
    const { child, client } = fixture("hang-close", 100);
    try {
      await expect(client.invoke("ready", {})).resolves.toBe("ready");
      const pending = expect(client.invoke("one", {})).rejects.toThrow("fixture stdin failure");
      child.stdin.destroy(new Error("fixture stdin failure"));
      await pending;
      await client.close();
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      child.kill("SIGKILL");
      await client.close();
    }
  });

  test("rejects every pending and future request when the host crashes", async () => {
    const { client } = fixture("crash");
    try {
      const results = await Promise.allSettled([
        client.invoke("one", {}),
        client.action("two", {}),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason.message).toContain("exited (23)");
      }
      await expect(client.invoke("later", {})).rejects.toThrow("exited (23)");
    } finally {
      await client.close();
    }
  });

  for (const mode of ["malformed", "invalid-shape"]) {
    test(`rejects ${mode} protocol replies without an uncaught exception`, async () => {
      const { client } = fixture(mode);
      try {
        await expect(client.invoke("one", {})).rejects.toThrow(
          "Malformed design service host reply",
        );
      } finally {
        await client.close();
      }
    });
  }

  test("ignores logs, non-prefixed JSON, and replies for unknown request IDs", async () => {
    const { client } = fixture("noise");
    try {
      await expect(client.invoke("one", { value: 1 })).resolves.toEqual([{ value: 1 }]);
      await expect(client.action("two", { value: 2 })).resolves.toEqual([{ value: 2 }]);
    } finally {
      await client.close();
    }
  });

  test("delivers concurrent large requests across stdin backpressure", async () => {
    const { child, client } = fixture("backpressure");
    try {
      const payload = "x".repeat(1024 * 1024);
      const first = client.invoke("one", { payload });
      const second = client.action("two", { payload });
      expect(child.stdin.writableNeedDrain).toBe(true);
      const results = await Promise.all([first, second]);
      expect(results).toEqual([[{ payload }], [{ payload }]]);
    } finally {
      await client.close();
    }
  });

  test("propagates real host command errors and remains usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "design-client-"));
    const client = startDesignServiceHost(root, root);
    try {
      await expect(client.invoke("unknown-design-command", {})).rejects.toThrow(
        "Unknown backend command: unknown-design-command",
      );
      await expect(client.action("unknown-design-action", {})).rejects.toThrow(
        "Unknown design action",
      );
      await expect(client.invoke("another-unknown-command", {})).rejects.toThrow(
        "Unknown backend command: another-unknown-command",
      );
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
