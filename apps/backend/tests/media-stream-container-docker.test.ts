/**
 * Streamed file reads for a container environment through a real
 * `docker exec` (to-do 5800 task 1).
 *
 * `media-stream.test.ts` runs the container safe reader locally with a
 * directory standing in for `/workspace`. This starts the real
 * `spawnDockerMediaReader` against a container of the environment image, so
 * the image's own Node runs the reader: a PNG over the 8 MiB range cap (what
 * the file viewer's image tab opens with `containerId`) and a WAV are copied
 * into staging, served from the real content listener with ranges, refused
 * outside `/workspace`, through a symbolic link or for another container, and
 * revoked on close.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * The container has no network and runs no agent.
 */
import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { ArtifactFailure } from "@orkestrator/protocol/transcript-artifacts";
import { dockerOwnerNamespace } from "../src/core/docker-ownership.js";
import { runCommand } from "../src/core/shell.js";
import { LoopbackArtifactContentServer } from "../src/core/transcript-artifacts/content-server.js";
import { syntheticWav } from "../src/core/transcript-artifacts/fixtures/synthetic-wav.js";
import { spawnDockerMediaReader } from "../src/core/transcript-artifacts/media-stream-container.js";
import { TranscriptMediaStreams } from "../src/core/transcript-artifacts/media-stream.js";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);

/** The content listener's default range response cap (8 MiB). */
const RANGE_CAP = 8 * 1024 * 1024;

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid random-pixel RGB PNG, stored uncompressed so it stays over the range cap. */
function randomPng(side: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = side * 3 + 1;
  const pixels = randomBytes(row * side);
  for (let y = 0; y < side; y += 1) pixels[y * row] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ArtifactFailure) return error.error.code;
    throw error;
  }
  throw new Error("expected a failure");
}

test.skipIf(!enabled)(
  "a container environment's file streams from the content origin through docker exec",
  async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "ork-media-stream-docker-")));
    let containerId: string | undefined;
    let content: LoopbackArtifactContentServer | undefined;
    let streams: TranscriptMediaStreams | undefined;
    const docker = async (args: string[], timeoutMs = 120_000) =>
      (await runCommand("docker", args, { timeoutMs })).stdout.trim();
    try {
      const png = randomPng(1750);
      expect(png.byteLength).toBeGreaterThan(RANGE_CAP);
      const wav = Buffer.from(syntheticWav(1));
      await writeFile(join(dir, "shot.png"), png);
      await writeFile(join(dir, "tone.wav"), wav);
      await writeFile(join(dir, "page.html"), "<!doctype html><script>alert(1)</script>");

      containerId = await docker([
        "run",
        "--detach",
        "--label",
        "app=orkestrator-v2",
        "--label",
        `orkestrator-owner=${dockerOwnerNamespace(dir)}`,
        "--network",
        "none",
        "--user",
        "node",
        "--entrypoint",
        "sleep",
        image!,
        "infinity",
      ]);
      await docker(["exec", containerId, "mkdir", "-p", "/workspace/qa-media"]);
      for (const name of ["shot.png", "tone.wav", "page.html"]) {
        await docker(["cp", join(dir, name), `${containerId}:/workspace/qa-media/${name}`]);
      }
      await docker([
        "exec",
        containerId,
        "sh",
        "-c",
        "printf secret > /tmp/outside.wav && ln -s /tmp/outside.wav /workspace/qa-media/link.wav",
      ]);

      content = await LoopbackArtifactContentServer.start({ frameAncestors: [] });
      const server = content;
      const environment = {
        id: "env-box",
        environmentType: "containerized",
        containerId,
      };
      streams = new TranscriptMediaStreams({
        server: () => server,
        getEnvironment: async (id) => (id === environment.id ? environment : null),
        stagingRoot: join(dir, "staging"),
        spawnContainerReader: spawnDockerMediaReader,
      });
      const open = (path: string, requestedContainer: string = containerId!) =>
        streams!.open({ environmentId: environment.id, path, containerId: requestedContainer });

      // The file viewer passes the short id it shows; the image tab's PNG.
      const openStarted = performance.now();
      const opened = await open("qa-media/shot.png", containerId.slice(0, 12));
      const openMs = performance.now() - openStarted;
      expect(opened).toMatchObject({ mimeType: "image/png", byteLength: png.byteLength });
      expect(new URL(opened.url).origin).toBe(server.origin()!);
      expect(new URL(opened.url).hostname).toBe("localhost");
      expect(streams.stagedBytes(environment.id)).toBe(png.byteLength);

      const whole = await fetch(opened.url);
      expect(whole.status).toBe(200);
      const wholeBytes = new Uint8Array(await whole.arrayBuffer());
      expect(wholeBytes.byteLength).toBe(png.byteLength);
      expect(sha256(wholeBytes)).toBe(sha256(png));

      const head = await fetch(opened.url, { headers: { range: "bytes=0-99" } });
      expect(head.status).toBe(206);
      expect(head.headers.get("content-range")).toBe(`bytes 0-99/${png.byteLength}`);
      expect(Buffer.from(await head.arrayBuffer()).equals(png.subarray(0, 100))).toBe(true);

      const openEnded = await fetch(opened.url, { headers: { range: "bytes=0-" } });
      expect(openEnded.status).toBe(206);
      expect(openEnded.headers.get("content-range")).toBe(
        `bytes 0-${RANGE_CAP - 1}/${png.byteLength}`,
      );
      expect((await openEnded.arrayBuffer()).byteLength).toBe(RANGE_CAP);

      // An absolute /workspace path names the same file.
      const tone = await open("/workspace/qa-media/tone.wav");
      expect(tone).toMatchObject({ mimeType: "audio/wav", byteLength: wav.byteLength });
      const toneHead = await fetch(tone.url, { headers: { range: "bytes=0-43" } });
      expect(toneHead.status).toBe(206);
      expect(Buffer.from(await toneHead.arrayBuffer()).equals(wav.subarray(0, 44))).toBe(true);

      // The reader's confinement holds inside the real container.
      expect(await failure(open("qa-media/link.wav"))).toBe("policy_denied");
      expect(await failure(open("../tmp/outside.wav"))).toBe("policy_denied");
      expect(await failure(open("qa-media/page.html"))).toBe("unsupported_kind");
      expect(await failure(open("qa-media/missing.png"))).toBe("not_found");
      expect(await failure(open("qa-media/shot.png", "f00dfeedbeef"))).toBe("policy_denied");

      // Closing the tab revokes the capability and releases the staged copy.
      streams.close(opened.streamId);
      expect((await fetch(opened.url)).status).toBe(404);
      expect(streams.stagedBytes(environment.id)).toBe(wav.byteLength);
      streams.close(tone.streamId);
      expect(streams.size()).toBe(0);
      expect(streams.stagedBytes()).toBe(0);
      process.stderr.write(
        `media-stream-container-docker: ${png.byteLength}-byte PNG staged from the container in ${openMs.toFixed(0)} ms and served whole, 0-99 and capped open-ended; WAV ${wav.byteLength} bytes\n`,
      );
    } finally {
      await streams?.dispose();
      await content?.close();
      if (containerId) await docker(["rm", "--force", containerId]);
      await rm(dir, { recursive: true, force: true });
    }
  },
  240_000,
);
