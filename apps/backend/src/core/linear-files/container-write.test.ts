import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { runCommand } from "../command-capture.js";
import { writeContainerLinearFile } from "./container-write.js";

const bytes = Buffer.from("synthetic attachment");
const staged = "LINEAR_FILE_STAGED\n";

function writeWithTransport(
  script: string,
  options?: { controller?: AbortController; ms?: number },
) {
  const controller = options?.controller ?? new AbortController();
  return writeContainerLinearFile(
    "fixture",
    "linear-files",
    "example.zip",
    bytes,
    controller.signal,
    Date.now() + (options?.ms ?? 5_000),
    (_command, _args, options) => spawn(process.execPath, ["-e", script], options),
  );
}

test("waits for the complete staged marker and sends the publish line", async () => {
  await expect(
    writeWithTransport(`
    let data = "";
    process.stdin.on("data", (chunk) => {
      data += chunk;
      if (data === ${JSON.stringify(bytes.toString("base64") + "\n")}) {
        process.stdout.write("LINEAR_FILE_");
        setImmediate(() => process.stdout.write("STAGED\\n"));
      }
    });
    process.stdin.on("end", () => {
      if (!data.endsWith("\\npublish\\n")) process.exitCode = 7;
    });
  `),
  ).resolves.toBeUndefined();
});

test("rejects a nonzero exit even after authorizing publication", async () => {
  await expect(
    writeWithTransport(`
    process.stdin.once("data", () => process.stdout.write(${JSON.stringify(staged)}));
    process.stdin.on("end", () => process.exit(7));
  `),
  ).rejects.toThrow("stopped before publication");
});

test("rejects an invalid staged marker and closes the input", async () => {
  await expect(
    writeWithTransport(`
    process.stdin.once("data", () => process.stdout.write("WRONG\\n"));
    process.stdin.on("end", () => process.exit(0));
  `),
  ).rejects.toThrow("stopped before publication");
});

test("the watchdog terminates an unresponsive transport", async () => {
  await expect(writeWithTransport("setInterval(() => {}, 1000)", { ms: 1 })).rejects.toThrow(
    "stopped before publication",
  );
});

test.skipIf(process.env.ORKESTRATOR_LINEAR_FILE_DOCKER_TEST !== "1")(
  "publishes exact bytes through Docker exec and discards a revoked staged write",
  async () => {
    const { stdout } = await runCommand(
      "docker",
      [
        "run",
        "--pull=never",
        "--rm",
        "--network=none",
        "--tmpfs",
        "/workspace:uid=1000,gid=1000",
        "--user",
        "node",
        "-d",
        "node:24-slim",
        "sleep",
        "60",
      ],
      { timeoutMs: 10_000 },
    );
    const id = stdout.trim();
    try {
      await runCommand("docker", ["exec", id, "test", "-d", "/workspace"], { timeoutMs: 5_000 });
      const ready = new AbortController();
      const deadline = () => Date.now() + 10_000;
      const folder = ".orkestrator/linear-files/ENG-1";
      const name = "plan (v2).zip";
      await writeContainerLinearFile(id, folder, name, bytes, ready.signal, deadline());
      const published = await runCommand(
        "docker",
        ["exec", id, "cat", `/workspace/${folder}/${name}`],
        {
          timeoutMs: 5_000,
        },
      );
      expect(published.stdout).toBe(bytes.toString());

      const revoked = new AbortController();
      let output = "";
      await expect(
        writeContainerLinearFile(
          id,
          folder,
          "revoked.zip",
          bytes,
          revoked.signal,
          deadline(),
          (command, args, options) => {
            const child = spawn(command, args, options);
            child.stdout.prependListener("data", (chunk: Buffer) => {
              output += chunk.toString();
              if (output === staged) revoked.abort();
            });
            return child;
          },
        ),
      ).rejects.toThrow("stopped before publication");
      expect(revoked.signal.aborted).toBe(true);
      const listing = await runCommand("docker", ["exec", id, "ls", "-A", `/workspace/${folder}`], {
        timeoutMs: 5_000,
      });
      expect(listing.stdout.trim()).toBe(name);
    } finally {
      await runCommand("docker", ["rm", "-f", id], { timeoutMs: 10_000 });
    }
  },
  35_000,
);
