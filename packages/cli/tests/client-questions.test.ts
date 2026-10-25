import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import path from "node:path";
import { terminalQuestions } from "../src/client/questions.js";
import { createSandbox } from "./support/client-harness.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(terminal = false) {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), { isTTY: terminal });
  const controller = new AbortController();
  const questions = terminalQuestions(input, output, () => controller.abort("SIGINT"));
  cleanups.push(() => {
    questions.close();
    input.destroy();
    output.destroy();
  });
  return { input, output, questions, controller };
}

test("real readline sequences questions and releases stream listeners", async () => {
  const { input, questions } = fixture();
  const baseline = input.listenerCount("data");
  const first = questions.question("First? ");
  input.write("one\n");
  expect(await first).toBe("one");
  const second = questions.question("Second? ");
  input.write("two\n");
  expect(await second).toBe("two");
  questions.close();
  expect(input.listenerCount("data")).toBe(baseline);
  expect(await questions.question("Closed? ")).toBeNull();
});

test("EOF settles the pending question and stays closed", async () => {
  const { input, questions } = fixture();
  const answer = questions.question("Answer? ");
  input.end();
  expect(await answer).toBeNull();
  expect(await questions.question("Again? ")).toBeNull();
});

test.each(["SIGINT", "SIGTERM"])(
  "AbortSignal %s settles pending readline and removes listeners",
  async (name) => {
    const { input, questions, controller } = fixture();
    const pending = questions.question("Answer? ", controller.signal);
    controller.abort(name);
    await expect(pending).rejects.toMatchObject({ code: "observation-interrupted" });
    expect(input.listenerCount("data")).toBe(0);
    await expect(questions.question("Again? ", controller.signal)).rejects.toMatchObject({
      code: "observation-interrupted",
    });
  },
);

test("terminal Ctrl-C aborts the question", async () => {
  const { input, questions, controller } = fixture(true);
  const pending = questions.question("Answer? ", controller.signal);
  input.write("\u0003");
  await expect(pending).rejects.toMatchObject({ code: "observation-interrupted" });
  expect(controller.signal.reason).toBe("SIGINT");
});

test.each(["SIGINT", "SIGTERM"])(
  "process %s at a setup prompt exits without installation",
  async (name) => {
    const box = await createSandbox();
    const dataDir = path.join(box.root, "data");
    const entry = path.resolve(import.meta.dir, "../src/client/main.ts");
    const script = `import { runClientProcess } from ${JSON.stringify(entry)}; process.stdin.isTTY = true; process.exitCode = await runClientProcess(["service", "install", "--data-dir", ${JSON.stringify(dataDir)}], "9.9.9");`;
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: box.root },
    });
    let stderr = "";
    let stdout = "";
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    const prompted = new Promise<void>((resolve) => {
      child.stderr.on("data", (data) => {
        stderr += data.toString();
        if (stderr.includes("Choose 1-3")) resolve();
      });
    });
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 4000);
    try {
      await Promise.race([
        prompted,
        exit.then(() => {
          throw new Error("Exited before prompt");
        }),
      ]);
      child.kill(name as "SIGINT" | "SIGTERM");
      expect(await exit).toBe(name === "SIGINT" ? 130 : 143);
      expect(stderr).not.toContain("Installing orkestrator");
      expect(stdout).not.toContain("service is running");
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
      await box.cleanup();
    }
  },
);
