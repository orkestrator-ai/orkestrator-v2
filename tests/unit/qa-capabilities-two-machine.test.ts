import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CapabilityLibrary } from "@orkestrator/protocol/capability-resources-api";

import {
  openTunnel,
  RemoteCapabilityRun,
  runOwned,
  skillCopiesScript,
  waitForTunnel,
  type ssh,
} from "../../scripts/two-node/capability-remote";
import {
  copiesMatchRevision,
  hasHandedOverPackage,
  runCapabilityQualification,
} from "../../scripts/two-node/capability-qualification";
import { SetupError } from "../../scripts/two-node/harness";
import { watchChild } from "../../scripts/two-node/owned-process";

const id = () => randomBytes(16).toString("hex");
const deadline = () => AbortSignal.timeout(5_000);

/** Execute the received script, with a lock stub since these fixture calls are serialized. */
const fakeSsh: typeof ssh = async (_host, command, input) => {
  if (command !== "bash -s") throw new Error("Unexpected command");
  const shell = "flock() { return 0; }\n";
  return (await runOwned("bash", ["-s"], { input: shell + input, timeoutMs: 5_000 })).toString();
};

test.each(["lost", "malformed"])(
  "%s allocation replies clean only the locally named run",
  async (reply) => {
    const sentinel = `/tmp/ork-capabilities-2m-${id()}`;
    const unexpected = path.join(sentinel, "different-run");
    const pidFile = path.join(unexpected, "backend.pid");
    await mkdir(unexpected, { recursive: true });
    await writeFile(pidFile, "leave this file alone");
    const run = new RemoteCapabilityRun("fixture", id(), async (...args) => {
      const result = await fakeSsh(...args);
      if (!result.trim().startsWith("/tmp/")) return result;
      if (reply === "lost") throw new SetupError("Connection closed after the allocation");
      return unexpected;
    });
    try {
      const errors: string[] = [];
      const status = await runCapabilityQualification(
        async (signal) => {
          await run.allocate(signal);
          return true;
        },
        async () => {
          expect(await run.cleanup(false)).toBe("removed");
        },
        (label) => errors.push(label),
      );
      expect(status).toBe(2);
      expect(errors).toEqual(["SETUP"]);
      expect(await run.cleanup(false)).toBe("absent");
      expect(await readFile(pidFile, "utf8")).toBe("leave this file alone");
    } finally {
      await run.cleanup(false);
      await rm(sentinel, { recursive: true });
    }
  },
);

test("cleanup refuses a run with a different owner before reading its PID file", async () => {
  const runId = id();
  const owner = new RemoteCapabilityRun("fixture", runId, fakeSsh);
  const other = new RemoteCapabilityRun("fixture", runId, fakeSsh);
  await owner.allocate();
  const pidFile = path.join(owner.root, "backend.pid");
  try {
    // A linked PID would fail for the owner too. The foreign attempt must stop
    // at the earlier ownership check and leave the directory available to its owner.
    await writeFile(pidFile, "leave this file alone");
    await expect(other.cleanup(false)).rejects.toThrow("ownership could not be verified");
    expect(await readFile(pidFile, "utf8")).toBe("leave this file alone");
  } finally {
    await rm(pidFile, { force: true });
    await owner.cleanup(false);
  }
});

test("--keep removes the token, preserves the directory, and a missing capability home has no copies", async () => {
  const run = new RemoteCapabilityRun("fixture", id(), fakeSsh);
  await run.allocate();
  const token = path.join(run.root, "token");
  try {
    await writeFile(token, "fixture-token");
    expect(await run.run(skillCopiesScript("review"))).toBe("");
    expect(await run.cleanup(true)).toBe("kept");
    await expect(readFile(token)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run.cleanup(false)).toBe("removed");
  } finally {
    await run.cleanup(false);
  }
});

test.each(["SSH lost", "worker still alive"])(
  "cleanup retries a transient failure and reports a persistent %s failure",
  async (message) => {
    let attempts = 0;
    const remote = new RemoteCapabilityRun("fixture", id(), async () => {
      attempts++;
      if (attempts === 3) return "removed";
      throw new SetupError(message);
    });
    expect(await remote.cleanup(false)).toBe("removed");
    expect(attempts).toBe(3);
    const broken = new RemoteCapabilityRun("fixture", id(), async () => {
      throw new SetupError(message);
    });
    const errors: string[] = [];
    expect(
      await runCapabilityQualification(
        async () => true,
        async () => {
          await broken.cleanup(false);
        },
        (label, error) => errors.push(`${label}: ${String(error)}`),
      ),
    ).toBe(1);
    expect(errors[0]).toContain(`fixture:${broken.root}`);
    expect(errors[0]).toContain(message);
  },
);

test("forward spawn errors reach cleanup with a nonzero exit, with multiplexing and backgrounding disabled", async () => {
  let args: string[] = [];
  const failures: string[] = [];
  const cleanup: string[] = [];
  expect(
    await runCapabilityQualification(
      async (signal) => {
        const tunnel = openTunnel(10001, 10002, "fixture", (argv) => {
          args = argv;
          return spawn("/nonexistent-orkestrator-ssh", [], { stdio: "ignore" });
        });
        try {
          await waitForTunnel(
            tunnel,
            (abort) =>
              new Promise((_, reject) => {
                abort.addEventListener("abort", () => reject(abort.reason), { once: true });
              }),
            signal,
          );
        } finally {
          await tunnel.stop();
          cleanup.push("forward");
        }
        return true;
      },
      async () => {
        cleanup.push("backends");
      },
      (label) => failures.push(label),
    ),
  ).toBe(2);
  expect(args).toEqual(
    expect.arrayContaining([
      "ControlPath=none",
      "ControlMaster=no",
      "ControlPersist=no",
      "ForkAfterAuthentication=no",
    ]),
  );
  expect(failures).toEqual(["SETUP"]);
  expect(cleanup).toEqual(["forward", "backends"]);
});

test.each([
  ["SIGINT", 130, "install"],
  ["SIGTERM", 143, "offline"],
  ["SIGHUP", 129, "offline"],
] as const)(
  "%s during %s exits at its signal status after one cleanup",
  async (signal, status, phase) => {
    const module = path.resolve(
      import.meta.dir,
      "../../scripts/two-node/capability-qualification.ts",
    );
    const script = `
    import { runCapabilityQualification } from ${JSON.stringify(module)};
    process.exitCode = await runCapabilityQualification(async (signal) => {
      console.log(${JSON.stringify(phase)});
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      return true;
    }, async () => console.log("cleaned"), () => {});
  `;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const owned = watchChild(child);
    let sent = false;
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (!sent && output.includes(phase)) {
        sent = true;
        child.kill(signal);
      }
    });
    try {
      await expect(
        Promise.race([
          owned.done,
          new Promise<never>((_, reject) => {
            const timeout = deadline();
            timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
          }),
        ]),
      ).resolves.toMatchObject({ code: status });
      expect(output.trim().split("\n")).toEqual([phase, "cleaned"]);
    } finally {
      await owned.stop();
    }
  },
);

test("catch-up requires convergence of all copies; a middle-only or mixed snapshot is still pending", () => {
  for (const copies of [[], ["Version two."], ["Version two.", "Version three."]]) {
    expect(copiesMatchRevision(copies, "Version three.")).toBe(false);
  }
  expect(copiesMatchRevision(["Version three.", "Version three."], "Version three.")).toBe(true);
});

test("handover rejects stale digests or assignments even at epoch 2", () => {
  const expected = { id: "review", artifactDigest: "third", assignedSetupIds: ["my-setup", "qa"] };
  const library = (epoch: number, pkg: typeof expected) =>
    ({ epoch, packages: [pkg] }) as CapabilityLibrary;
  expect(hasHandedOverPackage(library(1, expected), expected)).toBe(false);
  expect(hasHandedOverPackage(library(2, { ...expected, artifactDigest: "first" }), expected)).toBe(
    false,
  );
  expect(
    hasHandedOverPackage(library(2, { ...expected, assignedSetupIds: ["my-setup"] }), expected),
  ).toBe(false);
  expect(
    hasHandedOverPackage(
      library(2, { ...expected, assignedSetupIds: ["qa", "my-setup"] }),
      expected,
    ),
  ).toBe(true);
});
