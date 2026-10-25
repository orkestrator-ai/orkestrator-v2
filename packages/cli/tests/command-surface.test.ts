import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PUBLIC_API_LIMITS,
  publicErrorEnvelope,
  publicSuccessEnvelope,
} from "@orkestrator/protocol/public-api";
import type { PublicSessionCommandList } from "@orkestrator/protocol/public-api-resources";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import { completionScript, completionTable } from "../src/client/commands/completion.js";
import { CLIENT_COMMANDS } from "../src/client/main.js";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
  type RecordedRequest,
} from "./support/client-harness.js";

/**
 * The client side of the command surface added after the first release:
 * selected slash commands, --literal, --enqueue, --attach, project init,
 * cascade removal and shell completion. A fake gateway records exactly what
 * reaches `public_action`.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const RECEIPT = PUBLIC_API_FIXTURES.runCompleted.receipt!;

async function fixture(): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const gateway = await startFakeGateway((request) => {
    const action = String(request.body.args.action);
    if (action === "session.commands") {
      const list: PublicSessionCommandList = {
        sessionId: "ses_eA",
        agent: "claude",
        catalogue: { status: "ready", revision: 3, fetchedAt: null, error: null },
        commands: [
          {
            id: "claude:/review",
            name: "/review",
            aliases: [],
            description: "Review code",
            argumentHint: null,
            source: "project",
            bindingRevision: "rev-1",
            available: true,
            unavailableReason: null,
            arguments: "optional",
            busy: null,
          },
        ],
      };
      return envelope(publicSuccessEnvelope(action, list));
    }
    if (action === "run.get") {
      return envelope(publicSuccessEnvelope(action, null, RECEIPT));
    }
    if (action === "project.init") {
      return envelope(
        publicSuccessEnvelope(
          action,
          {
            project: {
              id: "p-1",
              name: "scratch",
              remote: "/srv/scratch",
              localPath: "/srv/scratch",
              environmentCount: 0,
            },
            remote: null,
          },
          { ...RECEIPT, action: "project.init" },
        ),
      );
    }
    if (
      action === "session.prompt" ||
      action === "session.command" ||
      action === "session.start" ||
      action === "project.remove"
    ) {
      return envelope(
        publicSuccessEnvelope(
          action,
          { runId: RECEIPT.operationId, sessionId: "ses_eA", tabId: "t" },
          { ...RECEIPT, action },
        ),
      );
    }
    return defaultResponder()(request);
  });
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  const added = await box.run([
    "connection",
    "add",
    "local",
    "--data-dir",
    dataDir,
    "--default",
    "--no-check",
  ]);
  expect(added.code).toBe(0);
  gateway.requests.length = 0;
  return { box, gateway };
}

function inputOf(gateway: FakeGateway, action: string): Record<string, unknown> {
  const request = gateway.requests.find(
    (candidate: RecordedRequest) => candidate.body.args.action === action,
  );
  if (!request) throw new Error(`${action} was not sent`);
  return request.body.args.input as Record<string, unknown>;
}

describe("selected slash commands", () => {
  test("session commands lists IDs; session command sends the selection and its arguments", async () => {
    const { box, gateway } = await fixture();
    const listed = await box.run(["session", "commands", "ses_eA", "--output", "id"]);
    expect(listed.code).toBe(0);
    expect(listed.out.trim()).toBe("claude:/review");
    const sent = await box.run([
      "--json",
      "session",
      "command",
      "ses_eA",
      "--command",
      "/review",
      "--expected-binding-revision",
      "rev-1",
      "--enqueue",
      "--wait",
      "--",
      "the",
      "open diff",
    ]);
    expect(sent.code).toBe(0);
    expect(gateway.requests.some((request) => request.body.args.action === "run.get")).toBe(true);
    expect(inputOf(gateway, "session.command")).toEqual({
      sessionId: "ses_eA",
      command: "/review",
      arguments: "the open diff",
      expectedBindingRevision: "rev-1",
      enqueue: true,
    });
  });

  test("session command requires --command and sends no arguments when none are given", async () => {
    const { box, gateway } = await fixture();
    const missing = await box.run(["--json", "session", "command", "ses_eA"]);
    expect(missing.code).toBe(2);
    const bare = await box.run(["--json", "session", "command", "ses_eA", "--command", "/compact"]);
    expect(bare.code).toBe(0);
    expect(inputOf(gateway, "session.command")).toEqual({
      sessionId: "ses_eA",
      command: "/compact",
    });
  });
});

describe("prompt delivery flags", () => {
  test("--literal, --enqueue and --attach reach session.prompt; only file names travel", async () => {
    const { box, gateway } = await fixture();
    const file = path.join(box.root, "local", "notes.txt");
    await Bun.write(file, "hello\n");
    const result = await box.run([
      "--json",
      "session",
      "prompt",
      "ses_eA",
      "--prompt",
      "/review is text",
      "--literal",
      "--enqueue",
      "--attach",
      file,
    ]);
    expect(result.code).toBe(0);
    expect(inputOf(gateway, "session.prompt")).toEqual({
      sessionId: "ses_eA",
      prompt: "/review is text",
      literal: true,
      enqueue: true,
      attachments: [{ name: "notes.txt", dataBase64: Buffer.from("hello\n").toString("base64") }],
    });
    expect(JSON.stringify(gateway.requests)).not.toContain(box.root);
  });

  test("session start accepts --literal and --attach", async () => {
    const { box, gateway } = await fixture();
    const file = path.join(box.root, "a.png");
    await writeFile(file, Buffer.from("89504e470d0a1a0a", "hex"));
    const result = await box.run([
      "--json",
      "session",
      "start",
      "--environment",
      "env-1",
      "--agent",
      "claude",
      "--prompt",
      "hi",
      "--literal",
      "--attach",
      file,
    ]);
    expect(result.code).toBe(0);
    expect(inputOf(gateway, "session.start")).toMatchObject({
      literal: true,
      attachments: [{ name: "a.png" }],
    });
  });

  test("oversize, too many and duplicate-name attachments fail before any prompt is sent", async () => {
    const { box, gateway } = await fixture();
    const big = path.join(box.root, "big.bin");
    await writeFile(big, Buffer.alloc(PUBLIC_API_LIMITS.promptAttachmentsMaxBytes + 1));
    const small = path.join(box.root, "one", "same.txt");
    const other = path.join(box.root, "two", "same.txt");
    await Bun.write(small, "1");
    await Bun.write(other, "2");
    const cases: Array<[string[], number]> = [
      [["--attach", big], 2],
      [Array.from({ length: 9 }, () => ["--attach", small]).flat(), 2],
      [["--attach", small, "--attach", other], 2],
      [["--attach", path.join(box.root, "missing.txt")], 2],
    ];
    for (const [flags, code] of cases) {
      const result = await box.run([
        "--json",
        "session",
        "prompt",
        "ses_eA",
        "--prompt",
        "x",
        ...flags,
      ]);
      expect(result.code).toBe(code);
    }
    expect(
      gateway.requests.filter((request) => request.body.args.action === "session.prompt"),
    ).toHaveLength(0);
  });
});

describe("projects", () => {
  test("project init sends only the backend path", async () => {
    const { box, gateway } = await fixture();
    const result = await box.run(["--json", "project", "init", "--path", "/srv/scratch"]);
    expect(result.code).toBe(0);
    expect(inputOf(gateway, "project.init")).toEqual({ path: "/srv/scratch" });
  });

  test("project remove sends cascade only when asked", async () => {
    const { box, gateway } = await fixture();
    expect((await box.run(["--json", "project", "remove", "p-1"])).code).toBe(0);
    expect(inputOf(gateway, "project.remove")).toEqual({ projectId: "p-1" });
    gateway.requests.length = 0;
    expect((await box.run(["--json", "project", "remove", "p-1", "--cascade"])).code).toBe(0);
    expect(inputOf(gateway, "project.remove")).toEqual({ projectId: "p-1", cascade: true });
    const timeoutAlone = await box.run(["--json", "project", "remove", "p-1", "--timeout", "1m"]);
    expect(timeoutAlone.code).toBe(2);
  });
});

describe("shell completion", () => {
  test("the table covers every command path and its flags", () => {
    const table = completionTable(CLIENT_COMMANDS);
    expect(table.next.get("")).toEqual(
      expect.arrayContaining(["session", "project", "completion"]),
    );
    expect(table.next.get("session")).toEqual(expect.arrayContaining(["commands", "command"]));
    expect(table.flags.get("session prompt")).toEqual(
      expect.arrayContaining(["--literal", "--enqueue", "--attach"]),
    );
    expect(table.flags.get("project remove")).toContain("--cascade");
    expect(table.globals).toContain("--json");
    expect(table.globals).toContain("-h");
  });

  test("bash completion completes command words across IDs and flags per command", () => {
    const script = completionScript("bash", CLIENT_COMMANDS);
    const run = (words: string[]) => {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `${script}\nCOMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")}); COMP_CWORD=${words.length - 1}; _orkestrator; echo "\${COMPREPLY[*]}"`,
        ],
        { encoding: "utf8" },
      );
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim().split(/\s+/);
    };
    expect(run(["orkestrator", "session", "comm"])).toEqual(["commands", "command"]);
    for (const option of ["--profile", "--connection"]) {
      expect(run(["orkestrator", option, "project", "session", "comm"])).toEqual([
        "commands",
        "command",
      ]);
      expect(run(["orkestrator", `${option}=project`, "session", "comm"])).toEqual([
        "commands",
        "command",
      ]);
    }
    expect(run(["orkestrator", "--profile", "=", "project", "session", "comm"])).toEqual([
      "commands",
      "command",
    ]);
    expect(run(["orkestrator", "session", "--profile", "command", "comm"])).toEqual([
      "commands",
      "command",
    ]);
    expect(run(["orkestrator", "-h"])).toContain("-h");
    expect(run(["orkestrator", "--profile", "pro"])).toEqual([""]);
    expect(run(["orkestrator", "project", "remove", "p-1", "--cas"])).toEqual(["--cascade"]);
    expect(run(["orkestrator", "--json", "session", "prompt", "ses_1", "--enq"])).toEqual([
      "--enqueue",
    ]);
  });

  test("completion is local and refuses an unknown shell", async () => {
    const box = await createSandbox();
    cleanups.push(() => box.cleanup());
    const ok = await box.run(["completion", "zsh"]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("#compdef orkestrator");
    const bad = await box.run(["--json", "completion", "tcsh"]);
    expect(bad.code).toBe(2);
  });
});

// CI installs zsh and fish (`.github/workflows/ci.yml`), so both run there;
// a host without one skips it.
describe("native shell completion execution", () => {
  test.skipIf(!Bun.which("zsh"))(
    "zsh bashcompinit parses option values and offers short flags",
    () => {
      const script = completionScript("zsh", CLIENT_COMMANDS);
      for (const args of [
        ["--profile", "project", "session", "comm"],
        ["--connection=session", "project", "rem"],
        ["session", "-h"],
      ]) {
        const run = spawnSync(
          "zsh",
          [
            "-f",
            "-c",
            // `-u` skips compinit's security audit, which aborts without a
            // terminal when it finds a completion directory it considers
            // insecure, as on the GitHub Ubuntu runner.
            `autoload -Uz compinit; compinit -u -D
${script}
COMP_WORDS=(orkestrator ${args.map((word) => `'${word}'`).join(" ")})
COMP_CWORD=${args.length}
_orkestrator
print -l -- \${COMPREPLY[@]}`,
          ],
          { encoding: "utf8" },
        );
        expect(run.status).toBe(0);
        expect(run.stderr).toBe("");
        expect(run.stdout.trim().split(/\s+/)).toEqual(
          args.at(-1) === "comm"
            ? ["commands", "command"]
            : args.at(-1) === "rem"
              ? ["remove"]
              : ["-h"],
        );
      }
    },
  );

  test.skipIf(!Bun.which("fish"))(
    "fish parses collisions, equals forms, list/duration values and short flags",
    () => {
      const script = completionScript("fish", CLIENT_COMMANDS);
      const complete = (line: string) => {
        const run = spawnSync("fish", ["-c", `${script}\ncomplete -C '${line}'`], {
          encoding: "utf8",
        });
        expect(run.status).toBe(0);
        expect(run.stderr).toBe("");
        return run.stdout
          .trim()
          .split("\n")
          .map((row) => row.split("\t")[0])
          .sort();
      };
      for (const [line, expected] of [
        ["orkestrator --profile project session comm", ["command", "commands"]],
        ["orkestrator --connection=session project rem", ["remove"]],
        ["orkestrator session --profile command comm", ["command", "commands"]],
        ["orkestrator session prompt --attach project --enq", ["--enqueue"]],
        ["orkestrator project remove --timeout session --cas", ["--cascade"]],
      ] as const) {
        expect(complete(line)).toEqual([...expected].sort());
      }
      // The short flag is offered beside its long form. Completing a finished
      // `-h` is version-dependent (fish 4 offers `--help`, Ubuntu 24.04's fish
      // 3.7 offers nothing), so ask for the options of a bare `-`.
      expect(complete("orkestrator session -")).toEqual(expect.arrayContaining(["-h", "--help"]));
    },
  );
});

describe("cascade final CLI results", () => {
  for (const partial of [false, true]) {
    test(`--wait and run observation expose ${partial ? "partial" : "successful"} environment outcomes`, async () => {
      const { box, gateway } = await fixture();
      const original = gateway.respond;
      const result = {
        environments: {
          total: 2,
          deleted: partial ? 1 : 2,
          failed: partial ? 1 : 0,
          results: [
            { environmentId: "env-first", state: "deleted" },
            partial
              ? { environmentId: "env-second", state: "failed", error: "cleanup refused" }
              : { environmentId: "env-second", state: "deleted" },
          ],
          truncated: false,
        },
      };
      const final = {
        ...RECEIPT,
        action: "project.remove" as const,
        state: partial ? ("partial" as const) : ("succeeded" as const),
        result,
        ...(partial
          ? { error: { code: "partial-failure" as const, message: "cleanup failed" } }
          : {}),
      };
      let reads = 0;
      gateway.respond = (request) => {
        const action = String(request.body.args.action);
        if (action === "project.remove")
          return envelope(
            publicSuccessEnvelope(
              action,
              { environments: { total: 2, deleted: 0, failed: 0, results: [] } },
              {
                ...final,
                result: undefined,
                state: "running",
                completedAt: undefined,
                error: undefined,
              },
            ),
          );
        if (action === "run.get") {
          reads++;
          return envelope(publicSuccessEnvelope(action, result, final));
        }
        return original(request);
      };
      const waited = await box.run(["--json", "project", "remove", "p-1", "--cascade", "--wait"]);
      expect(waited.code).toBe(partial ? 1 : 0);
      const output = JSON.parse(waited.out);
      expect(output.receipt.result).toEqual(result);
      if (!partial) expect(output.result).toEqual(result);
      expect(reads).toBeGreaterThan(0);
      const read = await box.run(["--json", "run", "get", final.operationId]);
      expect(read.code).toBe(0);
      expect(JSON.parse(read.out).result).toEqual(result);
      const observed = await box.run(["--json", "run", "wait", final.operationId]);
      expect(observed.code).toBe(partial ? 1 : 0);
      expect(JSON.parse(observed.out).receipt.result).toEqual(result);
      // A partial mutation replay also carries its retained summary in the error receipt.
      if (partial) {
        gateway.respond = (request) =>
          request.body.args.action === "project.remove"
            ? envelope(
                publicErrorEnvelope("project.remove", final.error!, { ...final, replayed: true }),
              )
            : original(request);
        const replay = await box.run(["--json", "project", "remove", "p-1", "--cascade"]);
        expect(replay.code).toBe(1);
        expect(JSON.parse(replay.out).receipt.result).toEqual(result);
      }
    });
  }
});
