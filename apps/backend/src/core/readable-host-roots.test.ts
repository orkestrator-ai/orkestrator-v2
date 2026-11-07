import { registrarFrom } from "./commands-registry-contracts.js";
import { registerTranscriptArtifactCommands } from "./transcript-artifacts/commands.js";
import type { CommandHandler } from "./commands-context.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";

import type { CommandContext } from "./commands-context.js";
import { readableHostFileRoots } from "./readable-host-roots.js";
import { readFileBase64 } from "./shell.js";
import { syntheticWav } from "./transcript-artifacts/fixtures/synthetic-wav.js";
import {
  READABLE_ROOTS_STREAM_OWNER,
  TranscriptMediaStreams,
  type MediaStreamServer,
} from "./transcript-artifacts/media-stream.js";
import type { MintMediaInput } from "./transcript-artifacts/media-stream-route.js";

const WAV = syntheticWav(0.1);

let root: string;
let worktrees: string;
let dataDir: string;
let chosenFolder: string;
let customWorktree: string;
let outside: string;
let environments: Array<Record<string, unknown>>;
let streams: TranscriptMediaStreams | undefined;
let minted: MintMediaInput[];

function context(): Pick<CommandContext, "storage" | "worktreeDir"> {
  return {
    worktreeDir: worktrees,
    storage: {
      loadEnvironments: async () => environments,
      getDataDir: () => dataDir,
    } as unknown as CommandContext["storage"],
  };
}

const server: MediaStreamServer = {
  origin: () => "http://127.0.0.1:1",
  mintMedia: (input) => {
    minted.push(input);
    return {
      url: `http://127.0.0.1:1/m/${"A".repeat(43)}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      generation: `generation-${minted.length}`,
    };
  },
  revokeMedia: () => undefined,
  mediaLive: () => true,
};

function manager(withRoots = true): TranscriptMediaStreams {
  streams = new TranscriptMediaStreams({
    server: () => server,
    getEnvironment: async () => null,
    stagingRoot: path.join(root, "staging"),
    spawnContainerReader: () => {
      throw new Error("no containers in this test");
    },
    ...(withRoots ? { readableHostRoots: () => readableHostFileRoots(context()) } : {}),
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

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "readable-host-roots-")));
  worktrees = path.join(root, "worktrees");
  dataDir = path.join(root, "data");
  chosenFolder = path.join(root, "chosen");
  customWorktree = path.join(chosenFolder, "custom-worktree");
  outside = path.join(root, "outside");
  for (const directory of [
    path.join(worktrees, "env-a"),
    path.join(dataDir, "coordinator-attachments"),
    customWorktree,
    outside,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path.join(worktrees, "env-a", "clip.wav"), WAV);
  writeFileSync(path.join(customWorktree, "clip.wav"), WAV);
  writeFileSync(path.join(chosenFolder, "beside.wav"), WAV);
  writeFileSync(path.join(dataDir, "coordinator-attachments", "pasted.wav"), WAV);
  writeFileSync(path.join(outside, "secret.wav"), WAV);
  symlinkSync(path.join(outside, "secret.wav"), path.join(worktrees, "env-a", "link.wav"));
  environments = [
    {
      id: "env-custom",
      environmentType: "local",
      worktreeBaseDir: chosenFolder,
      worktreePath: customWorktree,
    },
    // A project-home environment's checkout is never a readable root.
    {
      id: "env-home",
      environmentType: "local",
      projectHome: true,
      worktreeBaseDir: outside,
      worktreePath: outside,
    },
  ];
  minted = [];
});

afterEach(async () => {
  await streams?.dispose();
  streams = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("readable host file roots", () => {
  test("are the worktree base, custom worktrees one by one, and coordinator attachments", async () => {
    expect(await readableHostFileRoots(context())).toEqual([
      worktrees,
      customWorktree,
      path.join(dataDir, "coordinator-attachments"),
    ]);
  });

  test("the readable-roots stream admits exactly what read_file_base64 admits", async () => {
    const media = manager();
    const roots = await readableHostFileRoots(context());
    const inside = [
      path.join(worktrees, "env-a", "clip.wav"),
      path.join(customWorktree, "clip.wav"),
      path.join(dataDir, "coordinator-attachments", "pasted.wav"),
    ];
    for (const filePath of inside) {
      expect(await readFileBase64(filePath, roots)).toBe(Buffer.from(WAV).toString("base64"));
      const opened = await media.open({ path: filePath });
      expect(opened).toMatchObject({ mimeType: "audio/wav", byteLength: WAV.byteLength });
    }
    expect(minted.every((input) => input.ownerKey === READABLE_ROOTS_STREAM_OWNER)).toBe(true);

    const refused = [
      path.join(outside, "secret.wav"),
      // Beside a custom worktree, in the folder the user chose: not readable.
      path.join(chosenFolder, "beside.wav"),
      // A symbolic link out of a root.
      path.join(worktrees, "env-a", "link.wav"),
      path.join(worktrees, "env-a", "..", "..", "outside", "secret.wav"),
    ];
    for (const filePath of refused) {
      await expect(readFileBase64(filePath, roots)).rejects.toThrow();
      expect(await failure(media.open({ path: filePath }))).toBe("policy_denied");
    }
    // A relative path has no environment to be relative to.
    expect(await failure(media.open({ path: "env-a/clip.wav" }))).toBe("policy_denied");
    // A container file always names its environment.
    expect(
      await failure(media.open({ path: path.join(customWorktree, "clip.wav"), containerId: "c1" })),
    ).toBe("invalid_input");
    expect(media.size()).toBe(inside.length);
  });

  test("every served request re-applies the current roots", async () => {
    const media = manager();
    await media.open({ path: path.join(customWorktree, "clip.wav") });
    const resolve = minted[0]!.resolve;
    const opened = await resolve();
    await opened.handle.close();
    // The custom worktree's environment is gone: its file is no longer readable.
    environments = [];
    await expect(resolve()).rejects.toThrow();
  });

  test("without the allowlist a stream still requires an environment", async () => {
    const media = manager(false);
    expect(await failure(media.open({ path: path.join(worktrees, "env-a", "clip.wav") }))).toBe(
      "invalid_input",
    );
  });
});

test("registered environment-less stream command uses the current readable host roots", async () => {
  const commands = new Map<string, CommandHandler>();
  registerTranscriptArtifactCommands(registrarFrom((name, handler) => commands.set(name, handler)));
  const ctx = {
    ...context(),
    transcriptArtifacts: { runtime: () => ({ contentServer: server }) },
  } as unknown as CommandContext;
  const invoke = (name: string, args: Record<string, unknown>) =>
    Promise.resolve(commands.get(name)!(args as never, ctx));
  const opened = (await invoke("transcript_media_open_stream", {
    path: path.join(customWorktree, "clip.wav"),
  })) as { streamId: string };
  try {
    expect(minted).toHaveLength(1);
    await expect(
      invoke("transcript_media_open_stream", { path: path.join(outside, "secret.wav") }),
    ).rejects.toThrow("policy_denied");
    environments = [];
    await expect(
      invoke("transcript_media_open_stream", { path: path.join(customWorktree, "clip.wav") }),
    ).rejects.toThrow("policy_denied");
  } finally {
    await invoke("transcript_media_close_stream", { streamId: opened.streamId });
  }
});
