import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import {
  askServeArguments,
  HOSTED_WEB_ORIGINS,
  SSH_LOOPBACK_PORT,
  type SetupProbe,
} from "../src/client/service-setup.js";
import { captureIo, createSandbox, type ClientSandbox } from "./support/client-harness.js";

const sandboxes: ClientSandbox[] = [];
afterEach(async () => {
  for (const box of sandboxes.splice(0)) await box.cleanup();
});

const tailscaleReady: SetupProbe = {
  hasTailscaleAddress: () => true,
  findTailscaleCli: () => "/usr/bin/tailscale",
};

/** An io whose questions are answered in order; null ends the input. */
function scripted(answers: Array<string | null>) {
  const io = captureIo({});
  const asked: string[] = [];
  io.stdinIsTty = true;
  io.question = async (prompt) => {
    asked.push(prompt);
    if (answers.length === 0) throw new Error(`unexpected question: ${prompt}`);
    return answers.shift()!;
  };
  return { io, asked };
}

const installCommand = ["bunx", "orkestrator", "service", "install", "--yes"];

describe("service setup questions", () => {
  test("the defaults choose Tailscale Serve with the hosted web client", async () => {
    const { io } = scripted(["", "", "", ""]);
    const args = await askServeArguments(io, { installCommand, probe: tailscaleReady });
    expect(args).toEqual(["--tailscale-serve", "--allowed-origins", HOSTED_WEB_ORIGINS]);
    expect(io.err.join("")).toContain(
      `bunx orkestrator service install --yes -- --tailscale-serve --allowed-origins ${HOSTED_WEB_ORIGINS}`,
    );
  });

  test("SSH only listens on the loopback client port without asking about Tailscale", async () => {
    const { io, asked } = scripted(["3", "y"]);
    const args = await askServeArguments(io, { installCommand, probe: tailscaleReady });
    expect(args).toEqual(["--loopback-client-port", SSH_LOOPBACK_PORT]);
    expect(asked).toHaveLength(2);
  });

  test("the tailnet address can add SSH as well", async () => {
    const { io } = scripted(["2", "y", "y"]);
    expect(await askServeArguments(io, { installCommand, probe: tailscaleReady })).toEqual([
      "--loopback-client-port",
      SSH_LOOPBACK_PORT,
    ]);
  });

  test("asks for the Tailscale CLI when Serve needs one that cannot be found", async () => {
    const { io } = scripted(["1", "/opt/tailscale/bin/tailscale", "n", "n", "y"]);
    const args = await askServeArguments(io, {
      installCommand,
      probe: { hasTailscaleAddress: () => false, findTailscaleCli: () => null },
    });
    expect(args).toEqual(["--tailscale-serve", "--tailscale-bin", "/opt/tailscale/bin/tailscale"]);
    expect(io.err.join("")).toContain("no Tailscale address yet");
  });

  test("re-asks an answer it does not understand", async () => {
    const { io } = scripted(["7", "2", "maybe", "n", ""]);
    expect(await askServeArguments(io, { installCommand, probe: tailscaleReady })).toEqual([]);
    expect(io.err.join("")).toContain("Enter a number from 1 to 3.");
    expect(io.err.join("")).toContain("Answer y or n.");
  });

  test("declining the summary or ending the input installs nothing", async () => {
    for (const answers of [
      ["2", "n", "n"],
      ["2", null],
    ]) {
      const { io } = scripted(answers);
      await expect(
        askServeArguments(io, { installCommand, probe: tailscaleReady }),
      ).rejects.toThrow("Setup cancelled");
    }
  });
});

describe("service install interactivity", () => {
  async function dryRun(extra: string[], answers: Array<string | null>) {
    const box = await createSandbox();
    sandboxes.push(box);
    const { io, asked } = scripted(answers);
    const dataDir = path.join(box.root, "data");
    const result = await box.run(
      ["service", "install", "--data-dir", dataDir, "--dry-run", ...extra],
      io,
    );
    return { result, asked };
  }

  test("asks in a terminal when no serve arguments were given", async () => {
    const { result, asked } = await dryRun([], ["3", ""]);
    expect(result.code).toBe(0);
    expect(asked).toHaveLength(2);
    expect(result.out).toContain(`--loopback-client-port ${SSH_LOOPBACK_PORT}`);
  });

  test("serve arguments, --yes and JSON output each skip the questions", async () => {
    for (const extra of [["--", "--tailscale-serve"], ["--yes"], ["--output", "json"]]) {
      const { result, asked } = await dryRun(extra, []);
      expect(result.code).toBe(0);
      expect(asked).toEqual([]);
    }
  });
});
