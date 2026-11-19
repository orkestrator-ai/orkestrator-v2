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
  test("is off without a directory, and refuses a directory without its confirmation", () => {
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
    expect(first).toMatch(/^\/recordings\/pi-2026-11-19T00-00-00-000Z-[0-9a-f]{12}\.jsonl$/);
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
      { frame: { jsonrpc: "2.0", method: "session/update" } },
      { frame: "{not json" },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("RECORDING pi provider traffic");
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
  });

  test("stops at its byte bound with a notice rather than a half-written line", async () => {
    const { recorder, lines, files } = memoryRecorder({ maxBytes: 400 });
    for (let index = 0; index < 20; index += 1) {
      recorder.frame("session", { type: "message_update", delta: "x".repeat(20) });
    }
    await recorder.flush();
    const [path] = [...files.keys()];
    const written = lines(path!);
    expect(written.at(-1)).toEqual({ __recorderNotice: "recording stopped: max bytes reached" });
    expect(recorder.getStats().capped).toBe(true);
    expect(recorder.getStats().linesDropped).toBeGreaterThan(0);
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
  });

  test("a failed write drops its lines and never throws into the session", async () => {
    const { recorder } = memoryRecorder({
      appendFileImpl: async () => {
        throw new Error("disk full");
      },
    });
    recorder.frame("session", { type: "x" });
    await recorder.flush();
    expect(recorder.getStats()).toMatchObject({ writeErrors: 1, linesDropped: 2 });
    await recorder.close();
    recorder.frame("session", { type: "after close" });
    expect(recorder.getStats().linesDropped).toBe(3);
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
