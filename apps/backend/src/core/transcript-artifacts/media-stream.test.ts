import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";

import { CONTAINER_SAFE_BASE64_READER } from "../container-scripts.js";
import type { CommandContext, CommandHandler } from "../commands-context.js";
import { registerTranscriptArtifactCommands } from "./commands.js";
import { LoopbackArtifactContentServer } from "./content-server.js";
import { syntheticWav } from "./fixtures/synthetic-wav.js";
import {
  TranscriptMediaStreams,
  type ContainerReaderSpawner,
  type MediaStreamEnvironment,
  type TranscriptMediaStreamsOptions,
} from "./media-stream.js";

const WAV = syntheticWav(1);
const HTML = new TextEncoder().encode(
  "<!doctype html><html><body><script>alert(1)</script></body></html>",
);

let root: string;
let worktree: string;
let containerRoot: string;
let outside: string;
let content: LoopbackArtifactContentServer;
let environments: Map<string, MediaStreamEnvironment>;
let streams: TranscriptMediaStreams | undefined;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "media-stream-")));
  worktree = path.join(root, "worktree");
  containerRoot = path.join(root, "container-workspace");
  outside = path.join(root, "outside");
  for (const directory of [worktree, containerRoot, outside, path.join(worktree, "media")]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path.join(worktree, "media", "clip.wav"), WAV);
  writeFileSync(path.join(worktree, "fake.mp4"), HTML);
  writeFileSync(path.join(outside, "secret.wav"), WAV);
  symlinkSync(path.join(outside, "secret.wav"), path.join(worktree, "link.wav"));
  symlinkSync(outside, path.join(worktree, "linked-dir"));
  writeFileSync(path.join(containerRoot, "clip.wav"), WAV);
  writeFileSync(path.join(containerRoot, "fake.mp4"), HTML);
  symlinkSync(path.join(outside, "secret.wav"), path.join(containerRoot, "link.wav"));
  environments = new Map([
    ["env-local", { id: "env-local", environmentType: "local", worktreePath: worktree }],
    [
      "env-box",
      { id: "env-box", environmentType: "containerized", containerId: "c0ffee1234567890" },
    ],
  ]);
  content = await LoopbackArtifactContentServer.start({ frameAncestors: [] });
});

afterEach(async () => {
  await streams?.dispose();
  streams = undefined;
  await content.close();
  rmSync(root, { recursive: true, force: true });
});

/** Runs the real container reader locally, with `containerRoot` standing in for /workspace. */
const localReader: ContainerReaderSpawner = ({ workspacePath, maxBytes }) =>
  spawn("node", [
    "-e",
    CONTAINER_SAFE_BASE64_READER,
    "--",
    containerRoot,
    path.join(containerRoot, workspacePath.slice("/workspace/".length)),
    String(maxBytes),
    "stream",
  ]) as ChildProcessWithoutNullStreams;

function manager(overrides: Partial<TranscriptMediaStreamsOptions> = {}): TranscriptMediaStreams {
  streams = new TranscriptMediaStreams({
    server: () => content,
    getEnvironment: async (id) => environments.get(id) ?? null,
    stagingRoot: path.join(root, "staging"),
    spawnContainerReader: localReader,
    ...overrides,
  });
  return streams;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ArtifactFailure) return error.error.code;
    throw error;
  }
  throw new Error("expected a failure");
}

function get(url: string, range?: string): Promise<{ status: number; body: Buffer }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(target.port),
        path: target.pathname,
        headers: { host: target.host, ...(range ? { range } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("host media streams", () => {
  test("streams a worktree file by relative or absolute path with sniffed type", async () => {
    const media = manager();
    for (const requested of ["media/clip.wav", path.join(worktree, "media", "clip.wav")]) {
      const opened = await media.open({ environmentId: "env-local", path: requested });
      expect(opened).toMatchObject({ mimeType: "audio/wav", byteLength: WAV.byteLength });
      expect(opened.url.startsWith(`${content.origin()}/m/`)).toBe(true);
      expect(Date.parse(opened.expiresAt)).toBeGreaterThan(Date.now());
      const ranged = await get(opened.url, "bytes=0-43");
      expect(ranged.status).toBe(206);
      expect(ranged.body.equals(Buffer.from(WAV.subarray(0, 44)))).toBe(true);
    }
    expect(media.size()).toBe(2);
  });

  test("refuses paths outside the worktree, symbolic links, non-media bytes and missing files", async () => {
    const media = manager();
    const open = (requested: string) => media.open({ environmentId: "env-local", path: requested });
    expect(await failure(open(path.join(outside, "secret.wav")))).toBe("policy_denied");
    expect(await failure(open("../outside/secret.wav"))).toBe("policy_denied");
    expect(await failure(open("link.wav"))).toBe("policy_denied");
    expect(await failure(open("linked-dir/secret.wav"))).toBe("policy_denied");
    expect(await failure(open("media"))).toBe("policy_denied");
    // An HTML document named .mp4 is refused from its bytes.
    expect(await failure(open("fake.mp4"))).toBe("unsupported_kind");
    expect(await failure(open("media/missing.wav"))).toBe("not_found");
    expect(await failure(media.open({ environmentId: "env-gone", path: "media/clip.wav" }))).toBe(
      "not_found",
    );
    expect(
      await failure(
        media.open({ environmentId: "env-local", path: "media/clip.wav", containerId: "abc" }),
      ),
    ).toBe("invalid_input");
    expect(await failure(media.open({ environmentId: "env-local" }))).toBe("invalid_input");
    expect(media.size()).toBe(0);
  });

  test("re-checks the file and the environment on every request", async () => {
    const media = manager();
    const target = path.join(worktree, "media", "clip.wav");
    const first = await media.open({ environmentId: "env-local", path: "media/clip.wav" });
    // Replaced by a symbolic link to a file outside the worktree: refused.
    unlinkSync(target);
    symlinkSync(path.join(outside, "secret.wav"), target);
    expect((await get(first.url, "bytes=0-3")).status).toBe(404);

    unlinkSync(target);
    writeFileSync(target, WAV);
    const second = await media.open({ environmentId: "env-local", path: "media/clip.wav" });
    expect((await get(second.url, "bytes=0-3")).status).toBe(206);
    // The environment was deleted: the capability fails closed.
    environments.delete("env-local");
    expect((await get(second.url, "bytes=0-3")).status).toBe(404);

    environments.set("env-local", {
      id: "env-local",
      environmentType: "local",
      worktreePath: worktree,
    });
    const third = await media.open({ environmentId: "env-local", path: "media/clip.wav" });
    media.close(third.streamId);
    expect((await get(third.url, "bytes=0-3")).status).toBe(404);
    // A deleted file is an honest "gone".
    const fourth = await media.open({ environmentId: "env-local", path: "media/clip.wav" });
    unlinkSync(target);
    expect((await get(fourth.url, "bytes=0-3")).status).toBe(404);
  });

  test("without a content origin the caller is told to use the base64 path", async () => {
    const media = manager({ server: () => null });
    expect(await failure(media.open({ environmentId: "env-local", path: "media/clip.wav" }))).toBe(
      "renderer_unavailable",
    );
  });

  test("files over the host maximum are refused before minting", async () => {
    const media = manager({ limits: { maxHostBytes: 1024 } });
    expect(await failure(media.open({ environmentId: "env-local", path: "media/clip.wav" }))).toBe(
      "package_size_exceeded",
    );
  });
});

describe("container media streams", () => {
  test("copies once into staging with the container reader and serves ranges", async () => {
    const media = manager();
    const opened = await media.open({
      environmentId: "env-box",
      containerId: "c0ffee123456",
      path: "/workspace/clip.wav",
    });
    expect(opened).toMatchObject({ mimeType: "audio/wav", byteLength: WAV.byteLength });
    expect(media.stagedBytes("env-box")).toBe(WAV.byteLength);
    const tail = await get(opened.url, "bytes=-100");
    expect(tail.status).toBe(206);
    expect(tail.body.equals(Buffer.from(WAV.subarray(WAV.byteLength - 100)))).toBe(true);
    // The container file changing afterwards does not change the staged copy.
    writeFileSync(path.join(containerRoot, "clip.wav"), HTML);
    expect((await get(opened.url, "bytes=0-3")).body.toString()).toBe("RIFF");

    media.close(opened.streamId);
    expect((await get(opened.url, "bytes=0-3")).status).toBe(404);
    expect(media.stagedBytes()).toBe(0);
    await Bun.sleep(20);
    const stagingFiles = readdirSync(path.join(root, "staging"), { recursive: true }).filter(
      (entry) => String(entry).endsWith(".media"),
    );
    expect(stagingFiles).toEqual([]);
  });

  test("refuses symbolic links, escapes, non-media, oversize and foreign containers", async () => {
    const media = manager({ limits: { maxContainerBytes: 8 * 1024 } });
    const open = (requested: string, containerId?: string) =>
      media.open({
        environmentId: "env-box",
        path: requested,
        ...(containerId ? { containerId } : {}),
      });
    expect(await failure(open("link.wav"))).toBe("policy_denied");
    expect(await failure(open("../outside/secret.wav"))).toBe("policy_denied");
    expect(await failure(open("/etc/passwd"))).toBe("policy_denied");
    expect(await failure(open("fake.mp4"))).toBe("unsupported_kind");
    expect(await failure(open("clip.wav"))).toBe("package_size_exceeded");
    expect(await failure(open("missing.wav"))).toBe("not_found");
    expect(await failure(open("clip.wav", "deadbeef0000"))).toBe("policy_denied");
    expect(media.stagedBytes()).toBe(0);
    const leftovers = existsSync(path.join(root, "staging"))
      ? readdirSync(path.join(root, "staging"), { recursive: true }).filter((entry) =>
          String(entry).endsWith(".media"),
        )
      : [];
    expect(leftovers).toEqual([]);
  });

  test("the per-environment quota evicts the oldest staged stream", async () => {
    const media = manager({
      limits: { maxContainerBytes: 20_000, environmentQuotaBytes: 40_000 },
    });
    const first = await media.open({ environmentId: "env-box", path: "clip.wav" });
    const second = await media.open({ environmentId: "env-box", path: "clip.wav" });
    // A third copy needs room for a maximum-size file: the oldest is evicted.
    const third = await media.open({ environmentId: "env-box", path: "clip.wav" });
    expect((await get(first.url, "bytes=0-3")).status).toBe(404);
    expect((await get(second.url, "bytes=0-3")).status).toBe(206);
    expect((await get(third.url, "bytes=0-3")).status).toBe(206);
    expect(media.stagedBytes("env-box")).toBe(2 * WAV.byteLength);
  });

  test("a previous process's staged copies are removed when streaming starts", async () => {
    const leftover = path.join(root, "staging", "0123456789abcdef01234567", "old.media");
    mkdirSync(path.dirname(leftover), { recursive: true });
    writeFileSync(leftover, WAV);
    const media = manager();
    await media.open({ environmentId: "env-box", path: "clip.wav" });
    expect(existsSync(leftover)).toBe(false);
  });

  test("environment deletion revokes streams and the sweep removes their copies", async () => {
    const media = manager();
    const opened = await media.open({ environmentId: "env-box", path: "clip.wav" });
    environments.delete("env-box");
    expect((await get(opened.url, "bytes=0-3")).status).toBe(404);
    await media.sweep();
    expect(media.size()).toBe(0);
    expect(media.stagedBytes()).toBe(0);
  });
});

describe("media stream commands", () => {
  test("are registered and return typed errors through the command layer", async () => {
    const commands = new Map<string, CommandHandler>();
    registerTranscriptArtifactCommands((name, handler) => commands.set(name, handler));
    expect(commands.has(TRANSCRIPT_ARTIFACT_COMMANDS.openMediaStream)).toBe(true);
    expect(commands.has(TRANSCRIPT_ARTIFACT_COMMANDS.closeMediaStream)).toBe(true);
    const service = { runtime: () => ({ contentServer: content }) };
    const context = {
      transcriptArtifacts: service,
      storage: {
        getEnvironment: async (id: string) => environments.get(id) ?? null,
        getDataDir: () => root,
      },
    } as unknown as CommandContext;
    const opened = (await commands.get(TRANSCRIPT_ARTIFACT_COMMANDS.openMediaStream)!(
      { environmentId: "env-local", path: "media/clip.wav" } as never,
      context,
    )) as { url: string; streamId: string };
    expect((await get(opened.url, "bytes=0-3")).status).toBe(206);
    await commands.get(TRANSCRIPT_ARTIFACT_COMMANDS.closeMediaStream)!(
      { streamId: opened.streamId } as never,
      context,
    );
    expect((await get(opened.url, "bytes=0-3")).status).toBe(404);
    let message = "";
    try {
      await commands.get(TRANSCRIPT_ARTIFACT_COMMANDS.openMediaStream)!(
        { environmentId: "env-local", path: "fake.mp4" } as never,
        context,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(JSON.parse(message)).toMatchObject({ code: "unsupported_kind" });
  });
});
