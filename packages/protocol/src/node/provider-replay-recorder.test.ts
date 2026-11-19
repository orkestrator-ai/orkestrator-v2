import { mkdtemp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  PROVIDER_RECORD_CONFIRM_ENV,
  PROVIDER_RECORD_DIR_ENV,
  PROVIDER_RECORD_MAX_BYTES_ENV,
  ProviderReplayRecorder,
  createProviderReplayRecorderFromEnv,
  installedPackageVersion,
} from "./provider-replay-recorder.js";

function memoryRecorder(
  overrides: Partial<ConstructorParameters<typeof ProviderReplayRecorder>[0]> = {},
) {
  const files = new Map<string, string>();
  const warnings: string[] = [];
  const recorder = new ProviderReplayRecorder({
    bridge: "pi",
    provider: "@earendil-works/pi-coding-agent",
    providerVersion: "1.5.2",
    directory: "/recordings",
    // Flushed explicitly by each test, never by a timer.
    flushIntervalMs: 60_000,
    appendFileImpl: async (path, contents) => {
      files.set(path, (files.get(path) ?? "") + contents);
    },
    ensureDirImpl: async () => undefined,
    warnImpl: (message) => warnings.push(message),
    now: () => Date.parse("2026-11-19T00:00:00.000Z"),
    ...overrides,
  });
  const lines = (path: string) =>
    (files.get(path) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { recorder, files, warnings, lines };
}

describe("provider replay recorder", () => {
  test("is off without a directory, and refuses a directory without its confirmation", async () => {
    const warnings: string[] = [];
    const base = {
      bridge: "claude" as const,
      provider: "@anthropic-ai/claude-agent-sdk",
      providerVersion: "0.3.326",
      warnImpl: (message: string) => warnings.push(message),
    };
    expect(createProviderReplayRecorderFromEnv(base, {})).toBeNull();
    expect(warnings).toEqual([]);
    expect(
      createProviderReplayRecorderFromEnv(base, { [PROVIDER_RECORD_DIR_ENV]: "/r" }),
    ).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(PROVIDER_RECORD_CONFIRM_ENV);
    const recorder = createProviderReplayRecorderFromEnv(base, {
      [PROVIDER_RECORD_DIR_ENV]: "/r",
      [PROVIDER_RECORD_CONFIRM_ENV]: "1",
      [PROVIDER_RECORD_MAX_BYTES_ENV]: "1024",
    });
    expect(recorder).toBeInstanceOf(ProviderReplayRecorder);
    await recorder?.close();
  });

  test("writes one fixture-format file per session: header, prompt marker, frames", async () => {
    const { recorder, files, lines, warnings } = memoryRecorder();
    recorder.prompt("session-a");
    recorder.frame("session-a", { type: "message_start" });
    recorder.frame("session-b", { type: "tool_call" });
    recorder.rawLine("session-a", '{"jsonrpc":"2.0","method":"session/update"}');
    recorder.rawLine("session-a", "{not json");
    await recorder.flush();

    expect(files.size).toBe(2);
    const [first] = [...files.keys()].sort((a, b) => lines(b).length - lines(a).length);
    // The file name carries a digest of the key, never the key itself.
    expect(first).not.toContain("session-a");
    expect(first).toMatch(
      /^\/recordings\/pi-2026-11-19T00-00-00-000Z-[0-9a-f]{12}-[0-9a-f-]{36}\.jsonl$/,
    );
    expect(lines(first!)).toEqual([
      {
        replay: 1,
        bridge: "pi",
        scenario: "unclassified",
        source: "recorded",
        provider: "@earendil-works/pi-coding-agent",
        providerVersion: "1.5.2",
        description: expect.any(String),
      },
      { action: "prompt" },
      { frame: { type: "message_start" } },
      { rawLine: '{"jsonrpc":"2.0","method":"session/update"}' },
      { rawLine: "{not json" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("RECORDING pi provider traffic");
    await recorder.close();
  });

  test("reads a version function once, off the recording path, and falls back to unknown", async () => {
    let reads = 0;
    const { recorder, files, lines } = memoryRecorder({
      providerVersion: async () => {
        reads += 1;
        return reads === 1 ? "1.0.88" : "changed";
      },
    });
    recorder.frame("a", {});
    recorder.frame("b", {});
    expect(reads).toBe(0);
    await recorder.flush();
    expect(reads).toBe(1);
    expect([...files.keys()].map((path) => lines(path)[0]!.providerVersion)).toEqual([
      "1.0.88",
      "1.0.88",
    ]);

    const failing = memoryRecorder({
      providerVersion: () => {
        throw new Error("not started");
      },
    });
    failing.recorder.frame("a", {});
    await failing.recorder.flush();
    const [path] = [...failing.files.keys()];
    expect(failing.lines(path!)[0]!.providerVersion).toBe("unknown");
    await Promise.all([recorder.close(), failing.recorder.close()]);
  });

  test("stops at its byte bound on a whole line, including metadata", async () => {
    const { recorder, lines, files } = memoryRecorder({ maxBytes: 400 });
    for (let index = 0; index < 20; index += 1) {
      recorder.frame("session", { type: "message_update", delta: "x".repeat(20) });
    }
    await recorder.flush();
    const [path] = [...files.keys()];
    const written = lines(path!);
    expect(written[0]).toMatchObject({ replay: 1 });
    expect(Buffer.byteLength(files.get(path!)!)).toBeLessThanOrEqual(400);
    expect(recorder.getStats().capped).toBe(true);
    expect(recorder.getStats().linesDropped).toBeGreaterThan(0);
    await recorder.close();
  });

  test("records no more sessions than its bound and drops what it cannot serialise", async () => {
    const { recorder, files } = memoryRecorder({ maxSessions: 2 });
    recorder.frame("one", {});
    recorder.frame("two", {});
    recorder.frame("three", {});
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    recorder.frame("one", cyclic);
    await recorder.flush();
    expect(files.size).toBe(2);
    expect(recorder.getStats()).toMatchObject({ sessions: 2, linesDropped: 2 });
    await recorder.close();
  });

  test("a failed first append retires only its file and preserves other files' accounting", async () => {
    const written: string[] = [];
    let writes = 0;
    const { recorder } = memoryRecorder({
      appendFileImpl: async (_path, contents) => {
        writes += 1;
        if (writes === 2) throw new Error("disk full");
        written.push(contents);
      },
    });
    recorder.frame("healthy", { type: "first" });
    recorder.frame("failed", { type: "first" });
    await recorder.flush();
    recorder.frame("failed", { type: "never appended without a header" });
    recorder.frame("healthy", { type: "second" });
    await recorder.close();
    expect(written).toHaveLength(2);
    expect(JSON.parse(written[0]!.split("\n")[0]!)).toMatchObject({ replay: 1 });
    expect(JSON.parse(written[1]!.trim())).toEqual({ frame: { type: "second" } });
    expect(recorder.getStats()).toMatchObject({
      writeErrors: 1,
      linesDropped: 2,
      linesRecorded: 2,
      bytesRecorded: Buffer.byteLength(written.join("")),
    });
  });

  test("a directory failure can recover and the first successful batch still has its header", async () => {
    let attempts = 0;
    const { recorder, files, lines } = memoryRecorder({
      ensureDirImpl: async () => {
        if (++attempts === 1) throw new Error("not ready");
      },
    });
    recorder.frame("session", { type: "dropped" });
    await recorder.flush();
    recorder.frame("session", { type: "kept" });
    await recorder.close();
    expect(lines([...files.keys()][0]!)).toEqual([
      expect.objectContaining({ replay: 1 }),
      { frame: { type: "kept" } },
    ]);
  });

  test("graceful close drains active and queued batches in order without exceeding the cap", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const written: string[] = [];
    const { recorder } = memoryRecorder({
      maxBytes: 850,
      appendFileImpl: async (_path, contents) => {
        if (written.length === 0) {
          entered.resolve();
          await release.promise;
        }
        written.push(contents);
      },
    });
    recorder.frame("session", { type: "first", text: "a".repeat(200) });
    const flushing = recorder.flush();
    await entered.promise;
    recorder.frame("session", { type: "second" });
    recorder.frame("session", { type: "capped", text: "b".repeat(500) });
    const closing = recorder.close();
    recorder.frame("session", { type: "too late" });
    release.resolve();
    await Promise.all([flushing, closing]);
    const contents = written.join("");
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(850);
    expect(
      contents
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      expect.objectContaining({ replay: 1 }),
      { frame: { type: "first", text: "a".repeat(200) } },
      { frame: { type: "second" } },
      expect.objectContaining({ __recorderNotice: expect.any(String) }),
    ]);
    expect(recorder.getStats()).toMatchObject({ capped: true, linesDropped: 2 });
  });

  test("recorders with the same timestamp and key create separate private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-replay-modes-"));
    try {
      const directory = join(root, "capture");
      const options = {
        bridge: "acp" as const,
        provider: "fixture",
        providerVersion: "1",
        directory,
        now: () => 0,
        warnImpl: () => undefined,
      };
      const first = new ProviderReplayRecorder(options);
      const second = new ProviderReplayRecorder(options);
      first.frame("same key", "first");
      second.frame("same key", "second");
      await Promise.all([first.close(), second.close()]);
      const files = await readdir(directory);
      expect(files).toHaveLength(2);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const name of files)
        expect((await stat(join(directory, name))).mode & 0o777).toBe(0o600);

      const publicDirectory = join(root, "public");
      await mkdir(publicDirectory, { mode: 0o755 });
      const refused = new ProviderReplayRecorder({ ...options, directory: publicDirectory });
      refused.prompt("sample");
      await refused.close();
      expect(refused.getStats().writeErrors).toBe(1);
      expect(await readdir(publicDirectory)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the synchronous process exit path writes one private capture without a pending async flush", async () => {
    const root = await mkdtemp(join(tmpdir(), "provider-replay-exit-"));
    try {
      const directory = join(root, "capture");
      const moduleUrl = new URL("./provider-replay-recorder.js", import.meta.url);
      const script = `
        import { ProviderReplayRecorder } from ${JSON.stringify(moduleUrl.pathname)};
        const recorder = new ProviderReplayRecorder({
          bridge: "acp", provider: "fixture", providerVersion: "1",
          directory: ${JSON.stringify(directory)}, flushOnExit: true
        });
        recorder.rawLine("sample", '"opaque"');
        recorder.rawLine("sample", "{");
        process.exit(0);
      `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(await child.exited).toBe(0);
      const [name] = await readdir(directory);
      const file = join(directory, name!);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(
        (await readFile(file, "utf8"))
          .trimEnd()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([
        expect.objectContaining({ replay: 1 }),
        { rawLine: '"opaque"' },
        { rawLine: "{" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads an installed package's version from its own manifest", async () => {
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      dependencies: Record<string, string>;
    };
    // `effect` is pinned exactly and its exports map has no `./package.json`.
    expect(installedPackageVersion("effect", import.meta.url)).toBe(manifest.dependencies.effect);
    expect(installedPackageVersion("not-a-package-that-exists", import.meta.url)).toBeUndefined();
  });

  test("an exit flush is installed only when asked for, and close removes it", async () => {
    const before = process.listenerCount("exit");
    const { recorder } = memoryRecorder({ flushOnExit: true });
    expect(process.listenerCount("exit")).toBe(before + 1);
    await recorder.close();
    expect(process.listenerCount("exit")).toBe(before);
    memoryRecorder();
    expect(process.listenerCount("exit")).toBe(before);
  });
});
