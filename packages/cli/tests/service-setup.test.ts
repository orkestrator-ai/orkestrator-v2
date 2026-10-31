import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { runClient } from "../src/client/main.js";
import {
  askServeArguments,
  HOSTED_WEB_ORIGINS,
  SSH_LOOPBACK_PORT,
  warnIfTailscaleOperatorNeeded,
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
  tailscaleOperatorNeeded: () => null,
  grantTailscaleOperator: () => {
    throw new Error("unexpected grant");
  },
};

/** Tailscale that does not let this user configure Serve yet. */
function operatorMissing(granted = true) {
  const grants: Array<[string, string]> = [];
  const probe: SetupProbe = {
    ...tailscaleReady,
    tailscaleOperatorNeeded: () => "arkaydeus",
    grantTailscaleOperator: (cli, user) => {
      grants.push([cli, user]);
      return granted;
    },
  };
  return { probe, grants };
}

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
    expect(args).toEqual([
      "--host",
      "127.0.0.1",
      "--allow-non-tailscale-bind",
      "--loopback-client-port",
      SSH_LOOPBACK_PORT,
    ]);
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
      probe: {
        ...tailscaleReady,
        hasTailscaleAddress: () => false,
        findTailscaleCli: () => null,
      },
    });
    expect(args).toEqual(["--tailscale-serve", "--tailscale-bin", "/opt/tailscale/bin/tailscale"]);
    expect(io.err.join("")).toContain("no Tailscale address yet");
  });

  test("offers to make this user Tailscale's operator and runs it on yes", async () => {
    const { probe, grants } = operatorMissing();
    const { io } = scripted(["1", "", "n", "n", "y"]);
    const args = await askServeArguments(io, { installCommand, probe });
    expect(args).toEqual(["--tailscale-serve"]);
    expect(grants).toEqual([["/usr/bin/tailscale", "arkaydeus"]]);
    expect(io.err.join("")).toContain("sudo /usr/bin/tailscale set --operator=arkaydeus");
    expect(io.err.join("")).not.toContain("Continuing without it");
  });

  test("declining or a failed sudo says so and still continues", async () => {
    for (const [answer, granted] of [
      ["n", true],
      ["y", false],
    ] as const) {
      const { probe, grants } = operatorMissing(granted);
      const { io } = scripted(["1", answer, "n", "n", "y"]);
      expect(await askServeArguments(io, { installCommand, probe })).toEqual(["--tailscale-serve"]);
      expect(grants).toHaveLength(answer === "y" ? 1 : 0);
      expect(io.err.join("")).toContain("Continuing without it");
    }
  });

  test("a dry run reports the missing operator without offering to change it", async () => {
    const { probe, grants } = operatorMissing();
    const { io, asked } = scripted(["1", "n", "n", "y"]);
    await askServeArguments(io, { installCommand, probe, dryRun: true });
    expect(grants).toEqual([]);
    expect(asked.join("")).not.toContain("sudo");
    expect(io.err.join("")).toContain("--operator=arkaydeus");
  });

  test("the other ways to connect never look at the operator", async () => {
    const { probe } = operatorMissing();
    const { io } = scripted(["2", "n", "y"]);
    await askServeArguments(io, { installCommand, probe });
    expect(io.err.join("")).not.toContain("--operator");
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

describe("scripted install operator warning", () => {
  test("warns for --tailscale-serve and names the executable the backend will use", () => {
    const { probe } = operatorMissing();
    const { io } = scripted([]);
    warnIfTailscaleOperatorNeeded(
      io,
      ["--tailscale-serve", "--tailscale-bin", "/opt/my tailscale"],
      probe,
    );
    expect(io.err.join("")).toContain("sudo '/opt/my tailscale' set --operator=arkaydeus");
  });

  test("stays quiet without --tailscale-serve, with an operator or without a CLI", () => {
    for (const [args, probe] of [
      [["--host", "127.0.0.1"], operatorMissing().probe],
      [["--tailscale-serve"], tailscaleReady],
      [["--tailscale-serve"], { ...operatorMissing().probe, findTailscaleCli: () => null }],
    ] as const) {
      const { io } = scripted([]);
      warnIfTailscaleOperatorNeeded(io, args, probe);
      expect(io.err.join("")).toBe("");
    }
  });
});

describe("service install interactivity", () => {
  test.each(["before setup", "between prompts", "before confirmation"])(
    "abort %s prevents installation",
    async (when) => {
      const box = await createSandbox();
      sandboxes.push(box);
      const dataDir = path.join(box.root, "data");
      const controller = new AbortController();
      const { io } = scripted(["3", "y"]);
      const question = io.question!;
      io.question = async (prompt) => {
        const answer = await question(prompt);
        if (when === "between prompts") controller.abort("SIGTERM");
        return answer;
      };
      const stderr = io.stderr;
      io.stderr = (text) => {
        stderr(text);
        if (when === "before confirmation" && text.includes("Equivalent command"))
          controller.abort("SIGTERM");
      };
      if (when === "before setup") controller.abort("SIGTERM");
      const code = await runClient(["service", "install", "--data-dir", dataDir], {
        io,
        version: "9.9.9",
        signal: controller.signal,
      });
      expect(code).toBe(143);
      expect(existsSync(dataDir)).toBe(false);
      expect(io.err.join("")).not.toContain("Installing orkestrator");
    },
  );

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

  test("the equivalent command preserves install options and quotes a data path with spaces", async () => {
    const box = await createSandbox();
    sandboxes.push(box);
    const dataDir = path.join(box.root, "data with spaces");
    const { io } = scripted(["3", "y"]);
    const result = await box.run(
      [
        "service",
        "install",
        "--data-dir",
        dataDir,
        "--release",
        "2.22.0",
        "--timeout",
        "1500ms",
        "--skip-start",
        "--dry-run",
      ],
      io,
    );
    expect(result.code).toBe(0);
    expect(result.err).toContain(
      `--data-dir '${dataDir}' --release 2.22.0 --timeout 2s --skip-start --dry-run --yes -- --host 127.0.0.1 --allow-non-tailscale-bind --loopback-client-port ${SSH_LOOPBACK_PORT}`,
    );
  });

  test("serve arguments, --yes and JSON output each skip the questions", async () => {
    for (const extra of [["--", "--tailscale-serve"], ["--yes"], ["--output", "json"]]) {
      const { result, asked } = await dryRun(extra, []);
      expect(result.code).toBe(0);
      expect(asked).toEqual([]);
    }
  });
});
