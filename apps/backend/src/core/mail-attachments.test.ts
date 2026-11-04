import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_MAIL_MAX_ATTACHMENT_BYTES,
  AGENT_MAIL_MAX_ATTACHMENTS,
} from "@orkestrator/protocol/agent-mail";

import {
  mailAttachmentBatchId,
  mailAttachmentSpoolDir,
  outboxMailAttachmentBatch,
  parseMailAttachmentBatch,
  readOwnAttachments,
  readSpooledAttachment,
  stageMailAttachments,
  sweepStaleMailAttachmentBatches,
} from "./mail-attachments.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let root: string;
let own: string;
let other: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-mail-attachments-"));
  own = path.join(root, "c1", "own");
  other = path.join(root, "c1", "other");
  await fs.mkdir(own, { recursive: true });
  await fs.mkdir(other, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("readOwnAttachments", () => {
  test("takes the name or the absolute path it was given, and proves the type by content", async () => {
    await fs.writeFile(path.join(own, "shot.png"), PNG);
    // The extension says PNG; the bytes are what count.
    await fs.writeFile(path.join(own, "photo.png"), JPEG);
    const files = await readOwnAttachments(own, ["shot.png", path.join(own, "photo.png")]);
    expect(files.map(({ name, mediaType, bytes }) => ({ name, mediaType, bytes }))).toEqual([
      { name: "shot.png", mediaType: "image/png", bytes: PNG.length },
      { name: "photo.png", mediaType: "image/jpeg", bytes: JPEG.length },
    ]);
    expect(files[0]!.data.equals(PNG)).toBe(true);
    expect(files[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the same file named twice is one attachment", async () => {
    await fs.writeFile(path.join(own, "shot.png"), PNG);
    expect(await readOwnAttachments(own, ["shot.png", path.join(own, "shot.png")])).toHaveLength(1);
  });

  test("refuses another conversation's attachment, by path and by traversal", async () => {
    await fs.writeFile(path.join(other, "theirs.png"), PNG);
    for (const reference of [
      path.join(other, "theirs.png"),
      `${own}/../other/theirs.png`,
      "../other/theirs.png",
      "other/theirs.png",
      "..",
      "/etc/passwd",
      "theirs.png",
    ]) {
      await expect(readOwnAttachments(own, [reference])).rejects.toThrow(
        /not one of this conversation's attachments/,
      );
    }
  });

  test("a name it does not have is refused, listing what it has", async () => {
    await fs.writeFile(path.join(own, "shot.png"), PNG);
    await expect(readOwnAttachments(own, ["clipboard.png"])).rejects.toThrow(
      "this conversation has: shot.png",
    );
  });

  test("refuses a symlink, wherever it points", async () => {
    await fs.writeFile(path.join(own, "real.png"), PNG);
    await fs.writeFile(path.join(other, "theirs.png"), PNG);
    await fs.symlink(path.join(own, "real.png"), path.join(own, "inside.png"));
    await fs.symlink(path.join(other, "theirs.png"), path.join(own, "outside.png"));
    for (const reference of ["inside.png", "outside.png"]) {
      await expect(readOwnAttachments(own, [reference])).rejects.toThrow(/not a regular file/);
    }
  });

  test("refuses a symlinked attachment directory", async () => {
    const link = path.join(root, "c1", "link");
    await fs.symlink(other, link);
    await fs.writeFile(path.join(other, "theirs.png"), PNG);
    await expect(readOwnAttachments(link, ["theirs.png"])).rejects.toThrow(/not usable/);
  });

  test("refuses a directory", async () => {
    await fs.mkdir(path.join(own, "folder.png"));
    await expect(readOwnAttachments(own, ["folder.png"])).rejects.toThrow(/not a regular file/);
  });

  test("refuses a file that is not an image, whatever it is called", async () => {
    await fs.writeFile(path.join(own, "notes.txt"), "plain text");
    await fs.writeFile(path.join(own, "fake.png"), "plain text");
    await fs.writeFile(path.join(own, "empty.png"), "");
    await fs.writeFile(path.join(own, "vector.svg"), "<svg></svg>");
    for (const name of ["notes.txt", "fake.png", "empty.png", "vector.svg"]) {
      await expect(readOwnAttachments(own, [name])).rejects.toThrow(/is not an image/);
    }
  });

  test("refuses an oversized image, too many, and too many bytes together", async () => {
    const big = Buffer.alloc(AGENT_MAIL_MAX_ATTACHMENT_BYTES + 1);
    PNG.copy(big);
    await fs.writeFile(path.join(own, "big.png"), big);
    await expect(readOwnAttachments(own, ["big.png"])).rejects.toThrow(/larger than the 8 MiB/);
    await expect(
      readOwnAttachments(
        own,
        Array.from({ length: AGENT_MAIL_MAX_ATTACHMENTS + 1 }, (_, i) => `${i}.png`),
      ),
    ).rejects.toThrow(`at most ${AGENT_MAIL_MAX_ATTACHMENTS} images`);

    const full = Buffer.alloc(AGENT_MAIL_MAX_ATTACHMENT_BYTES);
    PNG.copy(full);
    const names = ["a", "b", "c", "d", "e"].map((name) => `${name}.png`);
    for (const name of names) await fs.writeFile(path.join(own, name), full);
    await expect(readOwnAttachments(own, names)).rejects.toThrow(/32 MiB limit/);
  });
});

describe("parseMailAttachmentBatch", () => {
  const batch = mailAttachmentBatchId(["c1", "conv", "req"]);
  const file = { name: "shot.png", mediaType: "image/png", bytes: 4, sha256: "a".repeat(64) };

  test("accepts what a sender describes", () => {
    expect(parseMailAttachmentBatch({ batch, files: [file] })).toEqual({ batch, files: [file] });
  });

  test("refuses anything a hostile node could use to leave the spool or the caps", () => {
    for (const value of [
      { batch: "../up", files: [file] },
      { batch, files: [] },
      { batch, files: Array.from({ length: AGENT_MAIL_MAX_ATTACHMENTS + 1 }, () => file) },
      { batch, files: [{ ...file, name: "../x.png" }] },
      { batch, files: [{ ...file, name: ".hidden.png" }] },
      { batch, files: [{ ...file, mediaType: "text/html" }] },
      { batch, files: [{ ...file, bytes: AGENT_MAIL_MAX_ATTACHMENT_BYTES + 1 }] },
      { batch, files: [{ ...file, sha256: "nope" }] },
    ]) {
      expect(() => parseMailAttachmentBatch(value)).toThrow();
    }
  });
});

describe("the spool", () => {
  const batch = mailAttachmentBatchId(["c1", "conv", "req"]);

  test("a spooled file is checked against what its sender declared", async () => {
    const [file] = await (async () => {
      await fs.writeFile(path.join(own, "shot.png"), PNG);
      return readOwnAttachments(own, ["shot.png"]);
    })();
    await stageMailAttachments(root, batch, [file!]);
    expect((await readSpooledAttachment(root, batch, file!)).equals(PNG)).toBe(true);
    await expect(
      readSpooledAttachment(root, batch, { ...file!, sha256: "b".repeat(64) }),
    ).rejects.toThrow(/did not match/);
    await fs.writeFile(path.join(mailAttachmentSpoolDir(root, batch), file!.name), "plain");
    const plain = {
      ...file!,
      bytes: 5,
      sha256: new Bun.CryptoHasher("sha256").update("plain").digest("hex"),
    };
    await expect(readSpooledAttachment(root, batch, plain)).rejects.toThrow(/is not an image/);
  });

  test("a batch name cannot leave the spool", () => {
    expect(() => mailAttachmentSpoolDir(root, "../../etc")).toThrow(/Invalid/);
  });

  test("the sweep takes abandoned batches and never a batch still in the outbox", async () => {
    const outbox = outboxMailAttachmentBatch(batch);
    const abandoned = mailAttachmentSpoolDir(root, batch);
    const waiting = mailAttachmentSpoolDir(root, outbox);
    await fs.mkdir(abandoned, { recursive: true });
    await fs.mkdir(waiting, { recursive: true });
    await sweepStaleMailAttachmentBatches(root, Date.now() + 2 * 24 * 60 * 60 * 1_000);
    await expect(fs.stat(abandoned)).rejects.toThrow();
    expect((await fs.stat(waiting)).isDirectory()).toBe(true);
  });
});
