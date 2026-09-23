import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ABSENT_REVISION, McpSourceStore } from "./source-store.js";

let root: string;
let store: McpSourceStore;
const policy = { createMode: 0o600, maxBytes: 1024 };

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "mcp-store-"));
  store = new McpSourceStore({
    keyFile: path.join(root, "data", "key"),
    lockDir: path.join(root, "locks"),
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("McpSourceStore", () => {
  test("reports absent files with the absent revision and creates them privately", async () => {
    const file = path.join(root, "home", ".cursor", "mcp.json");
    const snapshot = await store.read(file, policy);
    expect(snapshot.state).toBe("absent");
    expect(snapshot.revision).toBe(ABSENT_REVISION);
    await store.withLock(file, () =>
      store.commit(snapshot, ABSENT_REVISION, '{"mcpServers":{}}\n', policy),
    );
    expect(readFileSync(file, "utf8")).toBe('{"mcpServers":{}}\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("revisions change with content, are opaque, and survive a new store instance", async () => {
    const file = path.join(root, "a.json");
    writeFileSync(file, '{"a":1}');
    const first = (await store.read(file, policy)).revision!;
    expect(first.startsWith("r1.")).toBe(true);
    expect(first).not.toContain(Buffer.from('{"a":1}').toString("base64url"));
    const again = new McpSourceStore({ keyFile: path.join(root, "data", "key") });
    expect((await again.read(file, policy)).revision).toBe(first);
    writeFileSync(file, '{"a":2}');
    expect((await store.read(file, policy)).revision).not.toBe(first);
  });

  test("refuses to commit when the file changed after it was read, leaving it intact", async () => {
    const file = path.join(root, "a.json");
    writeFileSync(file, '{"a":1}');
    const snapshot = await store.read(file, policy);
    writeFileSync(file, '{"a":"external"}');
    await expect(
      store.withLock(file, () => store.commit(snapshot, snapshot.revision!, '{"a":3}', policy)),
    ).rejects.toThrow("revision-conflict");
    expect(readFileSync(file, "utf8")).toBe('{"a":"external"}');
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("keeps the existing file mode on replacement", async () => {
    const file = path.join(root, "a.json");
    writeFileSync(file, "{}", { mode: 0o640 });
    const snapshot = await store.read(file, policy);
    await store.withLock(file, () => store.commit(snapshot, snapshot.revision!, '{"b":1}', policy));
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test("oversized sources are read-only and never parsed", async () => {
    const file = path.join(root, "big.json");
    writeFileSync(file, "x".repeat(2048));
    const snapshot = await store.read(file, policy);
    expect(snapshot.state).toBe("oversized");
    expect(snapshot.text).toBeNull();
  });

  test("a project file linking outside the worktree is readable but not writable", async () => {
    const worktree = path.join(root, "worktree");
    const outside = path.join(root, "outside");
    mkdirSync(worktree);
    mkdirSync(outside);
    writeFileSync(path.join(outside, "mcp.json"), "{}");
    symlinkSync(path.join(outside, "mcp.json"), path.join(worktree, ".mcp.json"));
    const snapshot = await store.read(path.join(worktree, ".mcp.json"), {
      ...policy,
      allowedRoot: worktree,
    });
    expect(snapshot.state).toBe("ok");
    expect(snapshot.writeBlock).toContain("outside the worktree");
    await expect(
      store.commit(snapshot, snapshot.revision!, '{"x":1}', { ...policy, allowedRoot: worktree }),
    ).rejects.toThrow("read-only-source");
    // A symlinked parent directory is caught too.
    symlinkSync(outside, path.join(worktree, ".cursor"));
    const viaParent = await store.read(path.join(worktree, ".cursor", "mcp.json"), {
      ...policy,
      allowedRoot: worktree,
    });
    expect(viaParent.writeBlock).toBeDefined();
    const absentViaParent = await store.read(path.join(worktree, ".cursor", "new.json"), {
      ...policy,
      allowedRoot: worktree,
    });
    expect(absentViaParent.writeBlock).toBeDefined();
  });

  test("a user file symlinked to a dotfiles repository is written at its target", async () => {
    const dotfiles = path.join(root, "dotfiles");
    mkdirSync(dotfiles);
    writeFileSync(path.join(dotfiles, "claude.json"), "{}");
    const link = path.join(root, ".claude.json");
    symlinkSync(path.join(dotfiles, "claude.json"), link);
    const snapshot = await store.read(link, policy);
    await store.withLock(link, () =>
      store.commit(snapshot, snapshot.revision!, '{"ok":true}', policy),
    );
    expect(readFileSync(path.join(dotfiles, "claude.json"), "utf8")).toBe('{"ok":true}');
    expect(statSync(link, { throwIfNoEntry: false })).toBeDefined();
  });

  test("serializes concurrent work on one file", async () => {
    const file = path.join(root, "a.json");
    const order: string[] = [];
    await Promise.all(
      ["one", "two", "three"].map((label) =>
        store.withLock(file, async () => {
          order.push(`${label}:start`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          order.push(`${label}:end`);
        }),
      ),
    );
    for (let index = 0; index < order.length; index += 2) {
      expect(order[index]!.split(":")[0]).toBe(order[index + 1]!.split(":")[0]!);
    }
  });

  test("takes over a lock left by a dead process but not one held by a live process", async () => {
    const file = path.join(root, "a.json");
    const other = new McpSourceStore({
      keyFile: path.join(root, "data", "key"),
      lockDir: path.join(root, "locks"),
    });
    // Hold the lock from a second store instance (same process = live pid).
    let release!: () => void;
    const held = other.withLock(file, () => new Promise<void>((resolve) => (release = resolve)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lockFile = readdirSync(path.join(root, "locks"))[0]!;
    expect(lockFile.endsWith(".lock")).toBe(true);
    let acquired = false;
    const waiting = store.withLock(file, async () => {
      acquired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(acquired).toBe(false);
    release();
    await held;
    await waiting;
    expect(acquired).toBe(true);

    // A lock whose pid no longer exists is stale.
    writeFileSync(
      path.join(root, "locks", lockFile),
      JSON.stringify({ pid: 2 ** 22 + 12345, start: "1", token: "t", at: Date.now() }),
    );
    await store.withLock(file, async () => undefined);
  });
});
