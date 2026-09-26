import { afterEach, describe, expect, test } from "bun:test";
import { isPublicActionResponse } from "@orkestrator/protocol/public-api";
import { classifyInvocation } from "../src/client.js";
import { parseInvocation, sniffOutputMode } from "../src/client/argv.js";
import { COMMAND_TREE } from "../src/client/main.js";
import { createSandbox, type ClientSandbox } from "./support/client-harness.js";

const sandboxes: ClientSandbox[] = [];
afterEach(async () => {
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.cleanup()));
});
async function sandbox(): Promise<ClientSandbox> {
  const created = await createSandbox();
  sandboxes.push(created);
  return created;
}

describe("service/client classification", () => {
  test("keeps every historical service form and adds explicit serve", () => {
    expect(classifyInvocation([])).toEqual({ mode: "serve", args: [] });
    expect(
      classifyInvocation(["--host", "127.0.0.1", "--port", "0", "--allow-non-tailscale-bind"]),
    ).toEqual({
      mode: "serve",
      args: ["--host", "127.0.0.1", "--port", "0", "--allow-non-tailscale-bind"],
    });
    expect(
      classifyInvocation(["--tailscale-serve", "--allowed-origins", "https://orkestrator.dev"])
        .mode,
    ).toBe("serve");
    expect(classifyInvocation(["--unsafe-allow-non-tailscale-bind"]).mode).toBe("serve");
    expect(classifyInvocation(["serve", "--data-dir", "/tmp/x"])).toEqual({
      mode: "serve",
      args: ["--data-dir", "/tmp/x"],
    });
  });

  test("routes client commands, help and version to the client", () => {
    for (const argv of [
      ["project", "list"],
      ["--json", "project", "list"],
      ["help"],
      ["version"],
      ["--version"],
      ["--help"],
      ["-h"],
      ["--profile", "qa", "environment", "list"],
    ]) {
      expect({ argv, mode: classifyInvocation(argv).mode }).toEqual({ argv, mode: "client" });
    }
    expect(classifyInvocation(["serve", "--help"])).toEqual({
      mode: "client",
      argv: ["help", "serve"],
    });
  });

  test("refuses typos, stray values and mixed forms instead of starting a service", () => {
    expect(classifyInvocation(["--prot", "5"]).mode).toBe("error");
    expect(classifyInvocation(["--port"]).mode).toBe("error");
    expect(classifyInvocation(["serve", "--json"]).mode).toBe("error");
    expect(classifyInvocation(["--data-dir", "/tmp", "--json"]).mode).toBe("error");
    expect(classifyInvocation(["projcet", "list"]).mode).toBe("error");
    const secret = classifyInvocation(["please fix the login bug in auth.ts"]);
    expect(secret.mode).toBe("error");
    expect(JSON.stringify(secret)).not.toContain("login bug");
  });
});

describe("argument parsing", () => {
  test("accepts global options anywhere before -- and both value spellings", () => {
    const parsed = parseInvocation(COMMAND_TREE, [
      "--json",
      "environment",
      "start",
      "env-1",
      "--wait=ready",
      "--timeout",
      "2m",
      "--profile",
      "qa",
    ]);
    expect(parsed.global).toMatchObject({ output: "json", profile: "qa" });
    expect(parsed.command?.positionals).toEqual({ environment: "env-1" });
    expect(parsed.command?.options).toEqual({ wait: "ready", timeout: 120_000 });
  });

  test("passes everything after -- through untouched", () => {
    const parsed = parseInvocation(COMMAND_TREE, [
      "environment",
      "exec",
      "env-1",
      "--wait",
      "--",
      "sh",
      "-c",
      "--json",
      "--profile x",
    ]);
    expect(parsed.command?.rest).toEqual(["sh", "-c", "--json", "--profile x"]);
    expect(parsed.global.output).toBe("human");
  });

  test("rejects duplicates, missing values, unknown options and conflicting selectors", () => {
    const cases: Array<[string[], string]> = [
      [["project", "get", "p", "--name", "a", "--name", "b"], "more than once"],
      [["environment", "start", "e", "--wait"], "requires a value"],
      [["project", "list", "--bogus"], "Unknown option --bogus"],
      [["--connection", "a", "--profile", "b", "project", "list"], "select different backends"],
      [["--json", "--output", "id", "project", "list"], "mutually exclusive"],
      [["project", "get", "a", "b"], "Too many arguments"],
      [["connection", "show"], "requires <name>"],
      [["project", "list", "--", "x"], "does not accept arguments after --"],
      [["connection", "show", "x", "--output", "id"], "does not support --output id"],
    ];
    for (const [argv, message] of cases) {
      expect(() => parseInvocation(COMMAND_TREE, argv)).toThrow(message);
    }
  });

  test("never echoes argument values in diagnostics", () => {
    const secret = "sk-live-SECRETVALUE";
    for (const argv of [
      ["project", "list", `--prompt=${secret}`],
      ["session", "prompt", "s", secret, "extra"],
      [secret],
      ["environment", "start", "--timeout", secret],
    ]) {
      try {
        parseInvocation(COMMAND_TREE, argv);
      } catch (error) {
        expect((error as Error).message).not.toContain(secret);
      }
    }
  });

  test("sniffs JSON mode even when the rest of the line is invalid", () => {
    expect(sniffOutputMode(["--bogus", "--json"])).toBe("json");
    expect(sniffOutputMode(["--output=id", "x"])).toBe("id");
    expect(sniffOutputMode(["--", "--json"])).toBe("human");
  });
});

describe("output contract", () => {
  test("JSON mode writes exactly one valid envelope to stdout, even for invalid input", async () => {
    const box = await sandbox();
    const result = await box.run(["--json", "project", "get", "a", "b"]);
    expect(result.code).toBe(2);
    const lines = result.out.trim().split("\n");
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]!);
    expect(isPublicActionResponse(envelope)).toBe(true);
    expect(envelope.error).toMatchObject({ code: "invalid-input", exitCode: 2 });
    expect(result.err).toBe("");
  });

  test("ID mode prints nothing on stdout for a failure", async () => {
    const box = await sandbox();
    const result = await box.run(["project", "list", "--output", "id"]);
    expect(result.code).toBe(4);
    expect(result.out).toBe("");
    expect(result.err).toContain("connection-not-configured");
  });

  test("help and version are local and exit 0", async () => {
    const box = await sandbox();
    for (const argv of [
      ["help"],
      ["--help"],
      ["help", "environment"],
      ["environment", "start", "--help"],
      ["help", "session", "interactions", "resolve"],
      ["version"],
      ["--version", "--json"],
      ["help", "serve"],
    ]) {
      const result = await box.run(argv);
      expect({ argv, code: result.code }).toEqual({ argv, code: 0 });
      expect(result.out.length).toBeGreaterThan(0);
    }
    const version = await box.run(["--version", "--json"]);
    expect(JSON.parse(version.out).result.version).toBe("9.9.9");
  });

  test("a group without a subcommand is invalid and points at the group's help", async () => {
    const box = await sandbox();
    const result = await box.run(["environment"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("orkestrator help environment");
  });
});

describe("classification with shared option names", () => {
  test("a client command whose options match service flag names stays a client command", () => {
    expect(
      classifyInvocation(["--json", "connection", "add", "x", "--data-dir", "/tmp/d"]).mode,
    ).toBe("client");
    expect(classifyInvocation(["--profile", "qa", "project", "list"]).mode).toBe("client");
    expect(classifyInvocation(["--data-dir", "project", "--port", "0"]).mode).toBe("serve");
    expect(classifyInvocation(["--json"]).mode).toBe("client");
  });
});
