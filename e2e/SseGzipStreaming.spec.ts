import { spawn } from "node:child_process";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Session cookies and one-shot bootstrap links must never enter traces.
test.use({ trace: "off" });

async function streamingStarted(page: Page, url: string): Promise<number> {
  const response = await page.request.get(`${url}/__orkestrator/metrics`);
  expect(response.ok()).toBe(true);
  return (await response.json()).compression.streamingStarted as number;
}

/**
 * The backend tests read the wire bytes with their own decoder. This shows a
 * browser's own decoder also hands over each sync-flushed frame at once, through
 * both ways the web client reads the stream, and that `gateway.keepalive` is
 * visible to an `EventSource` on a compressed stream.
 */
test("a real browser decodes gzip SSE frame by frame", async ({ page }) => {
  test.setTimeout(60_000);
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "fixture/sse-gzip-gateway-server.ts")],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exited = new Promise<void>((resolve, reject) =>
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Disposable gateway failed")),
    ),
  );
  void exited.catch(() => undefined);
  try {
    const manifest = await new Promise<{ url: string; login: string }>((resolve, reject) => {
      let text = "";
      const timer = setTimeout(
        () => reject(new Error("Disposable gateway startup timed out")),
        10_000,
      );
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Gateway exited during startup"));
      });
      child.stdout.on("data", (chunk) => {
        text += String(chunk);
        if (!text.includes("\n")) return;
        clearTimeout(timer);
        resolve(JSON.parse(text.split("\n")[0]!));
      });
    });
    await page.goto(manifest.login);
    await page.goto(`${manifest.url}/`);
    expect(await streamingStarted(page, manifest.url)).toBe(0);

    const eventSource = await page.evaluate(async () => {
      const emit = (id: string) =>
        fetch("/__orkestrator/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "emit_frame", args: { id } }),
        });
      const source = new EventSource("/__orkestrator/events?keepaliveEvents=1");
      const frames: string[] = [];
      let keepalives = 0;
      let wake = () => {};
      source.onmessage = (event) => {
        frames.push(event.data);
        wake();
      };
      source.addEventListener("gateway.keepalive", () => {
        keepalives += 1;
        wake();
      });
      const until = async (done: () => boolean) => {
        const deadline = Date.now() + 10_000;
        while (!done()) {
          if (Date.now() > deadline) throw new Error("A frame did not reach the EventSource");
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 100);
          });
        }
      };
      await until(() => keepalives >= 1);
      const inLockstep: string[] = [];
      for (const id of ["es-0", "es-1", "es-2"]) {
        await emit(id);
        await until(() => frames.some((frame) => frame.includes(`"${id}"`)));
        inLockstep.push(id);
      }
      const before = keepalives;
      await until(() => keepalives >= before + 2);
      source.close();
      return { inLockstep, keepalivesAfterFrames: keepalives - before };
    });
    expect(eventSource.inLockstep).toEqual(["es-0", "es-1", "es-2"]);
    expect(eventSource.keepalivesAfterFrames).toBeGreaterThanOrEqual(2);
    // The compressor metric is the proof the EventSource negotiated gzip: its
    // response headers are not readable from the page.
    expect(await streamingStarted(page, manifest.url)).toBe(1);

    const fetchStream = await page.evaluate(async () => {
      const emit = (id: string) =>
        fetch("/__orkestrator/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command: "emit_frame", args: { id } }),
        });
      const response = await fetch("/__orkestrator/events");
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let text = "";
      const readUntil = async (marker: string) => {
        while (!text.includes(marker)) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`The stream ended before ${marker}`);
          text += value;
        }
      };
      await readUntil(": connected");
      const inLockstep: string[] = [];
      for (const id of ["fetch-0", "fetch-1", "fetch-2"]) {
        await emit(id);
        await readUntil(`"${id}"`);
        inLockstep.push(id);
      }
      await readUntil(": keepalive");
      await reader.cancel();
      return {
        inLockstep,
        contentEncoding: response.headers.get("content-encoding"),
        vary: response.headers.get("vary"),
      };
    });
    expect(fetchStream).toEqual({
      inLockstep: ["fetch-0", "fetch-1", "fetch-2"],
      contentEncoding: "gzip",
      vary: "Accept-Encoding",
    });
    expect(await streamingStarted(page, manifest.url)).toBe(2);
  } finally {
    child.stdin.end();
    await exited.catch(() => undefined);
  }
});
