import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  descriptorTrustRefusal,
  isDescriptorRefusal,
  processIsAlive,
  readDescriptor,
} from "../src/client/targets.js";
import {
  createSandbox,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
} from "./support/client-harness.js";

// Every descriptor here lives in a fresh temporary sandbox; nothing reads or
// writes the real data directory, its descriptor or its auth file.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function sandbox(): Promise<ClientSandbox> {
  const box = await createSandbox();
  cleanups.push(() => box.cleanup());
  return box;
}

async function gateway(): Promise<FakeGateway> {
  const created = await startFakeGateway();
  cleanups.push(() => created.stop());
  return created;
}

async function publishProfile(box: ClientSandbox, backend: FakeGateway, dataDir: string) {
  const runtime = path.join(box.env.ORKESTRATOR_DEV_ROOT!, "profiles", "qa", "runtime");
  await mkdir(runtime, { recursive: true });
  const statusPath = path.join(runtime, "status.json");
  await writeFile(
    statusPath,
    JSON.stringify({
      version: 1,
      profile: "qa",
      flavor: "agent-test",
      electronTitle: "x",
      rendererUrl: "http://127.0.0.1:1",
      logDir: runtime,
      statusPath,
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      processStartTimes: {},
      status: "ready",
      dataDir,
      pids: { backend: process.pid },
      browserUrl: backend.url,
      authFile: path.join(dataDir, "gateway-auth.json"),
    }),
  );
}

const posix = process.platform !== "win32";
const uid = process.getuid?.() ?? 0;

describe("descriptorTrustRefusal", () => {
  test("accepts a descriptor the current user owns with mode 0600", () => {
    expect(descriptorTrustRefusal({ uid: 501, mode: 0o100600 }, 501)).toBeNull();
    expect(descriptorTrustRefusal({ uid: 501, mode: 0o100400 }, 501)).toBeNull();
  });

  test("refuses a descriptor another user owns, whatever its mode", () => {
    const reason = descriptorTrustRefusal({ uid: 502, mode: 0o100600 }, 501);
    expect(reason).toContain("owned by another user");
    expect(reason).toContain("uid 502");
  });

  test("refuses group- or world-accessible descriptors", () => {
    for (const mode of [0o100620, 0o100602, 0o100666, 0o100640, 0o100604]) {
      const reason = descriptorTrustRefusal({ uid: 501, mode }, 501);
      expect(reason).toContain("accessible to other users");
      expect(reason).toContain("chmod 600");
    }
    expect(descriptorTrustRefusal({ uid: 501, mode: 0o100666 }, 501)).toContain("mode 0666");
  });

  test("a platform without POSIX ownership skips the check", () => {
    expect(descriptorTrustRefusal({ uid: 0, mode: 0o100666 }, undefined)).toBeNull();
  });
});

describe("processIsAlive", () => {
  test("is true for this process", () => {
    expect(processIsAlive(process.pid)).toBe(true);
  });

  test("EPERM, a pid now owned by another user, does not count as alive", () => {
    const kill = spyOn(process, "kill").mockImplementation((() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }) as typeof process.kill);
    try {
      expect(processIsAlive(4242)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  test("ESRCH is not alive", () => {
    const kill = spyOn(process, "kill").mockImplementation((() => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    }) as typeof process.kill);
    try {
      expect(processIsAlive(4242)).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });
});

describe.skipIf(!posix)("readDescriptor", () => {
  async function descriptorFile(box: ClientSandbox): Promise<string> {
    return path.join(await box.publishDescriptor(await gateway()), "backend-instance.json");
  }

  test("reads a private descriptor the current user owns", async () => {
    const box = await sandbox();
    const file = await descriptorFile(box);
    expect((await readDescriptor(file)).installationId).toBe("install-a");
  });

  test("refuses a group- or world-writable descriptor with a clear message", async () => {
    const box = await sandbox();
    const file = await descriptorFile(box);
    for (const mode of [0o620, 0o602, 0o644]) {
      await chmod(file, mode);
      const error = await readDescriptor(file).catch((caught: unknown) => caught);
      expect(isDescriptorRefusal(error)).toBe(true);
      expect((error as Error).message).toContain(
        `Refusing to use the backend instance descriptor ${file}`,
      );
      expect((error as Error).message).toContain("accessible to other users");
    }
  });

  test("refuses a descriptor owned by another user", async () => {
    const box = await sandbox();
    const file = await descriptorFile(box);
    // Creating a file owned by someone else needs root; pretend to be another
    // uid instead, which is the same comparison from the other side.
    const error = await readDescriptor(file, uid + 1).catch((caught: unknown) => caught);
    expect(isDescriptorRefusal(error)).toBe(true);
    expect((error as Error).message).toContain("owned by another user");
  });

  test.each(["stat", "readFile"] as const)(
    "refuses a failure to %s the opened descriptor",
    async (method) => {
      const box = await sandbox();
      const file = await descriptorFile(box);
      const handle = await fs.open(file, "r");
      const originalOpen = fs.open.bind(fs);
      const open = spyOn(fs, "open").mockImplementation((...args) =>
        args[0] === file ? Promise.resolve(handle) : originalOpen(...args),
      );
      const failedRead = spyOn(handle, method).mockRejectedValue(new Error("I/O failure"));
      try {
        const error = await readDescriptor(file).catch((caught: unknown) => caught);
        expect(isDescriptorRefusal(error)).toBe(true);
        expect((error as Error).message).toContain(file);
        expect((error as Error).message).toContain("could not be read");
      } finally {
        failedRead.mockRestore();
        open.mockRestore();
      }
    },
  );

  test("refuses a symlink in the descriptor's place", async () => {
    const box = await sandbox();
    const file = await descriptorFile(box);
    const target = path.join(path.dirname(file), "elsewhere.json");
    await rename(file, target);
    await symlink(target, file);
    const error = await readDescriptor(file).catch((caught: unknown) => caught);
    expect(isDescriptorRefusal(error)).toBe(true);
    expect((error as Error).message).toContain("symbolic link");
  });

  test("refuses a FIFO without blocking on it", async () => {
    const box = await sandbox();
    const dir = path.join(box.root, "fifo");
    await mkdir(dir);
    const file = path.join(dir, "backend-instance.json");
    execFileSync("mkfifo", ["-m", "600", file]);
    const error = await readDescriptor(file).catch((caught: unknown) => caught);
    expect(isDescriptorRefusal(error)).toBe(true);
    expect((error as Error).message).toContain("not a regular file");
  });

  test("a missing descriptor is not a refusal", async () => {
    const box = await sandbox();
    const error = await readDescriptor(path.join(box.root, "absent.json")).catch(
      (caught: unknown) => caught,
    );
    expect(isDescriptorRefusal(error)).toBe(false);
    expect((error as Error).message).toContain("No running backend published");
  });
});

describe.skipIf(!posix)("commands refuse an untrusted descriptor", () => {
  test("connection add refuses a world-writable descriptor and saves nothing", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    await chmod(path.join(dataDir, "backend-instance.json"), 0o666);
    const added = await box.run(["--json", "connection", "add", "local", "--data-dir", dataDir]);
    expect(added.code).toBe(4);
    const error = JSON.parse(added.out).error;
    expect(error.code).toBe("connection-failed");
    expect(error.message).toContain("accessible to other users");
    expect(backend.requests).toHaveLength(0);
    expect((await box.run(["--json", "connection", "list"])).out).not.toContain('"local"');
  });

  test("a saved connection stops using its descriptor once it turns world-writable", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    expect(
      (await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default"])).code,
    ).toBe(0);
    await chmod(path.join(dataDir, "backend-instance.json"), 0o646);
    backend.requests.length = 0;
    const result = await box.run(["--json", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.message).toContain("accessible to other users");
    expect(backend.requests).toHaveLength(0);
  });

  test("a profile with a refused descriptor does not fall back to its manifest endpoint", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    await chmod(path.join(dataDir, "backend-instance.json"), 0o622);
    await publishProfile(box, backend, dataDir);
    const result = await box.run(["--json", "--profile", "qa", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.message).toContain("accessible to other users");
    expect(backend.requests).toHaveLength(0);
  });
  test.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])(
    "%s on open refuses direct and profile connections without requests",
    async (code) => {
      const box = await sandbox();
      const backend = await gateway();
      const dataDir = await box.publishDescriptor(backend);
      const file = path.join(dataDir, "backend-instance.json");
      await publishProfile(box, backend, dataDir);
      const originalOpen = fs.open.bind(fs);
      const open = spyOn(fs, "open").mockImplementation((...args) => {
        if (args[0] === file)
          return Promise.reject(Object.assign(new Error("open failed"), { code }));
        return originalOpen(...args);
      });
      try {
        const error = await readDescriptor(file).catch((caught: unknown) => caught);
        expect(isDescriptorRefusal(error)).toBe(true);
        expect((error as Error).message).toContain(file);
        expect((error as Error).message).toContain(code);
        for (const args of [
          ["connection", "add", "local", "--data-dir", dataDir],
          ["--profile", "qa", "project", "list"],
        ]) {
          const result = await box.run(["--json", ...args]);
          expect(result.code).toBe(4);
          expect(JSON.parse(result.out).error).toMatchObject({ code: "connection-failed" });
          expect(JSON.parse(result.out).error.message).toContain(file);
          expect(JSON.parse(result.out).error.message).toContain(code);
        }
        expect(backend.requests).toHaveLength(0);
      } finally {
        open.mockRestore();
      }
    },
  );

  test("an invalid profile descriptor is refused instead of falling back", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    await publishProfile(box, backend, dataDir);
    await writeFile(path.join(dataDir, "backend-instance.json"), "{broken");
    const result = await box.run(["--json", "--profile", "qa", "project", "list"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.out).error.message).toContain("its contents are invalid");
    expect(backend.requests).toHaveLength(0);
  });

  test("ENOENT preserves legacy profile fallback to the manifest endpoint", async () => {
    const box = await sandbox();
    const backend = await gateway();
    const dataDir = await box.publishDescriptor(backend);
    await publishProfile(box, backend, dataDir);
    await rm(path.join(dataDir, "backend-instance.json"));
    const result = await box.run(["--json", "--profile", "qa", "project", "list"]);
    expect(result.code).toBe(0);
    expect(backend.requests.length).toBeGreaterThan(0);
  });
});
