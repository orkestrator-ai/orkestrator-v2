import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { groupHasLiveMember } from "@orkestrator/protocol/node/shell-process-state";
import { execWithOutput, execWithRawOutput } from "./tmux-shared.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("execWithRawOutput", () => {
  test("a success reports status 0 with both streams", async () => {
    const raw = await execWithRawOutput("sh", ["-c", "printf out; printf err >&2"]);
    expect(raw).toEqual({ status: 0, stdout: Buffer.from("out"), stderr: "err" });
  });

  test("a non-zero exit is a status, with its stdout bytes and stderr intact", async () => {
    const raw = await execWithRawOutput("sh", ["-c", "printf '\\377'; printf err >&2; exit 7"]);
    expect(raw.status).toBe(7);
    expect(raw.stdout.equals(Buffer.from([0xff]))).toBe(true);
    expect(raw.stderr).toBe("err");
  });

  test("a timeout is status -1 and names the timeout", async () => {
    const raw = await execWithRawOutput("sh", ["-c", "printf out; printf err >&2; exec sleep 30"], {
      timeoutMs: 100,
    });
    expect(raw.status).toBe(-1);
    expect(raw.stderr).toContain("Command timed out");
  });

  test("a timeout with no stderr reports only the timeout", async () => {
    const raw = await execWithRawOutput("sleep", ["30"], { timeoutMs: 100 });
    expect(raw.status).toBe(-1);
    expect(raw.stderr).toBe("Command timed out");
  });

  test("a child that ignores SIGTERM cannot outlast its timeout", async () => {
    const started = Date.now();
    const raw = await execWithRawOutput("sh", ["-c", "trap '' TERM; sleep 30 & wait; sleep 30"], {
      timeoutMs: 100,
    });
    expect(raw.status).toBe(-1);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("death by a signal is status -1", async () => {
    const raw = await execWithRawOutput("sh", ["-c", "kill -KILL $$"]);
    expect(raw.status).toBe(-1);
  });

  test("with no timeout given, a bounded default deadline is armed", async () => {
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const raw = await execWithRawOutput("sh", ["-c", "printf done"]);
      expect(raw).toEqual({ status: 0, stdout: Buffer.from("done"), stderr: "" });
      expect(timers.mock.calls.map((call) => call[1])).toContain(60_000);
    } finally {
      timers.mockRestore();
    }
  });

  test("delivers stdin and closes it, including an empty payload", async () => {
    expect((await execWithRawOutput("cat", [], { stdin: "payload" })).stdout.toString()).toBe(
      "payload",
    );
    expect((await execWithRawOutput("cat", [], { stdin: "" })).status).toBe(0);
    expect((await execWithRawOutput("cat", [])).status).toBe(0);
  });

  test("runs in cwd with the given environment", async () => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-tmux-exec-")));
    directories.push(directory);
    const raw = await execWithRawOutput("sh", ["-c", 'printf "%s %s" "$PWD" "$ORK_MARK"'], {
      cwd: directory,
      env: { ...process.env, ORK_MARK: "marked" },
    });
    expect(raw.stdout.toString()).toBe(`${directory} marked`);
  });

  test("a command that cannot start still rejects", async () => {
    await expect(execWithRawOutput("ork-no-such-command-6060", [])).rejects.toThrow();
  });

  test("a transcript tail larger than runCommand's default arrives whole", async () => {
    const bytes = 60 * 1024 * 1024;
    const raw = await execWithRawOutput("sh", ["-c", `head -c ${bytes} /dev/zero`]);
    expect(raw.status).toBe(0);
    expect(raw.stdout.length).toBe(bytes);
  });

  test("output past the limit rejects rather than returning a truncated tail", async () => {
    await expect(
      execWithRawOutput("sh", ["-c", "printf 123456"], { maxOutputBytes: 5 }),
    ).rejects.toThrow();
  });

  test("captures both streams from a descendant after the leader exits", async () => {
    const raw = await execWithRawOutput(
      "sh",
      [
        "-c",
        "(sleep 0.2; printf late; printf late-error >&2) & printf early; printf early-error >&2",
      ],
      { timeoutMs: 5000 },
    );
    expect(raw).toEqual({
      status: 0,
      stdout: Buffer.from("earlylate"),
      stderr: "early-errorlate-error",
    });
  });

  test("a descendant that outlives the deadline cannot produce success", async () => {
    const raw = await execWithRawOutput(
      "sh",
      ["-c", "(trap '' TERM; exec sleep 30) & printf early"],
      { timeoutMs: 100 },
    );
    expect(raw.status).toBe(-1);
    expect(raw.stderr).toBe("Command timed out");
  });

  test("a redirected helper delays completion until the deadline and is terminated", async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-tmux-redirected-"));
    directories.push(directory);
    const timeoutMs = 1000;
    const started = Date.now();
    const raw = await execWithRawOutput(
      "sh",
      [
        "-c",
        // The leader exits only after the helper has ignored TERM and redirected
        // both streams. It therefore leaves no inherited output pipe to wait on.
        // sleep is finite so even a broken cleanup cannot leave a permanent helper.
        `printf '%s' "$$" > "$1/group"
sh -c 'trap "" TERM; printf ready > "$1/ready"; exec sleep 30' sh "$1" >/dev/null 2>&1 &
while [ ! -f "$1/ready" ]; do sleep 0.01; done
printf early`,
        "sh",
        directory,
      ],
      { timeoutMs },
    );

    expect(await fs.readFile(path.join(directory, "ready"), "utf8")).toBe("ready");
    expect(raw).toEqual({ status: -1, stdout: Buffer.from("early"), stderr: "Command timed out" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(timeoutMs);
    const groupId = Number(await fs.readFile(path.join(directory, "group"), "utf8"));
    // Zombies can remain under a non-reaping init; only live members matter.
    const exitDeadline = Date.now() + 1000;
    while (groupHasLiveMember(groupId) && Date.now() < exitDeadline) await Bun.sleep(10);
    expect(groupHasLiveMember(groupId)).toBe(false);
  });
});

describe("execWithOutput", () => {
  test("decodes stdout and keeps the status", async () => {
    const output = await execWithOutput("sh", ["-c", "printf héllo; exit 2"]);
    expect(output).toEqual({ status: 2, stdout: "héllo", stderr: "" });
  });
});
