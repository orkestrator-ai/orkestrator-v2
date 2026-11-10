import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DEFAULT_LINUX_BUILDER_CHECKOUT,
  DEFAULT_LINUX_BUILDER_HOST,
  parseRemoteReleaseArgs,
  REMOTE_SCRIPT_PATH,
  remoteArgs,
  runRemoteRelease,
  shellQuote,
  sshCommand,
  type RemoteRuntime,
} from "../../../scripts/release-linux-remote";
import type { ApprovalLink } from "../../../scripts/release-approval";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("parseRemoteReleaseArgs", () => {
  test("defaults to the documented builder", () => {
    expect(parseRemoteReleaseArgs(["build"], {})).toEqual({
      mode: "build",
      host: DEFAULT_LINUX_BUILDER_HOST,
      checkout: DEFAULT_LINUX_BUILDER_CHECKOUT,
      publish: true,
    });
    expect(DEFAULT_LINUX_BUILDER_HOST).toBe("omarchy-hp");
  });

  test("environment, then flags, override the builder", () => {
    const env = {
      ORKESTRATOR_RELEASE_LINUX_HOST: "arkaydeus@builder",
      ORKESTRATOR_RELEASE_LINUX_CHECKOUT: "/srv/ork",
    };
    expect(parseRemoteReleaseArgs(["check"], env)).toMatchObject({
      host: "arkaydeus@builder",
      checkout: "/srv/ork",
    });
    expect(
      parseRemoteReleaseArgs(
        ["build", "--no-publish", "--host", "other", "--checkout", "~/o"],
        env,
      ),
    ).toEqual({ mode: "build", host: "other", checkout: "~/o", publish: false });
  });

  test.each([
    [[]],
    [["publish"]],
    [["check", "--no-publish"]],
    [["build", "--host"]],
    [["build", "--force"]],
  ])("refuses %j", (args) => {
    expect(() => parseRemoteReleaseArgs(args, {})).toThrow("usage:");
  });

  test("refuses a host ssh would read as an option", () => {
    expect(() => parseRemoteReleaseArgs(["check", "--host", "-oProxyCommand=x"], {})).toThrow(
      "invalid SSH host",
    );
  });
});

test("shellQuote survives single quotes", () => {
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
});

test("the ssh command sends every argument quoted to bash -s", () => {
  const options = parseRemoteReleaseArgs(["build", "--no-publish"], {});
  const command = sshCommand(options.host, remoteArgs(options, HEAD, "2.30.0-beta"));
  expect(command.slice(0, 1)).toEqual(["ssh"]);
  expect(command).toContain("ConnectTimeout=20");
  expect(command.at(-2)).toBe("omarchy-hp");
  expect(command.at(-1)).toBe(
    `bash -s -- 'build' '~/project/apps/orkestrator-v2' '${HEAD}' '2.30.0-beta' '--no-publish'`,
  );
});

describe("runRemoteRelease", () => {
  function fakeRuntime(output: string, exitCode: number) {
    const ran: { command: string[]; script: string }[] = [];
    const approvals: ApprovalLink[] = [];
    const lines: string[] = [];
    const runtime: RemoteRuntime = {
      version: () => "2.30.0-beta",
      head: () => HEAD,
      run: async (command, script, onOutput) => {
        ran.push({ command, script });
        onOutput(output);
        return exitCode;
      },
      onApproval: (link) => approvals.push(link),
      log: (line) => lines.push(line),
    };
    return { runtime, ran, approvals, lines };
  }

  test("sends the remote script and alerts on a Tailscale check", async () => {
    const link = "https://login.tailscale.com/a/abc123";
    const { runtime, ran, approvals, lines } = fakeRuntime(
      `# Tailscale SSH requires an additional check.\n# To authenticate, visit: ${link}\n`,
      0,
    );
    expect(await runRemoteRelease(["build"], {}, runtime)).toBe(0);
    expect(ran).toHaveLength(1);
    expect(ran[0]?.script).toBe(readFileSync(REMOTE_SCRIPT_PATH, "utf8"));
    expect(approvals).toEqual([{ kind: "tailscale", url: link }]);
    expect(lines.join("\n")).toContain("Building the Linux release of v2.30.0-beta on omarchy-hp");
  });

  test("explains an unreachable builder", async () => {
    const { runtime, lines } = fakeRuntime("ssh: connect to host omarchy-hp: timed out\n", 255);
    expect(await runRemoteRelease(["check"], {}, runtime)).toBe(255);
    expect(lines.join("\n")).toContain("ORKESTRATOR_RELEASE_LINUX_HOST");
    expect(lines.join("\n")).not.toContain("attach");
  });

  test("points at attach when a started build fails", async () => {
    const { runtime, lines } = fakeRuntime(
      "[builder] started the Linux release build (pid 42)\n[builder] release-desktop build exited with 1\n",
      1,
    );
    expect(await runRemoteRelease(["build"], {}, runtime)).toBe(1);
    expect(lines.join("\n")).toContain("release:linux -- attach");
  });

  test("a build the builder refused to start does not point at attach", async () => {
    const { runtime, lines } = fakeRuntime("[builder] /home/x/ork has uncommitted changes\n", 1);
    expect(await runRemoteRelease(["build"], {}, runtime)).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("did not start the build");
    expect(text).not.toContain("release:linux -- attach");
  });

  test("a connection that drops mid-build points at attach, not at the host", async () => {
    const { runtime, lines } = fakeRuntime(
      "[builder] checked out 01234567\n[builder] started the Linux release build (pid 42)\n",
      255,
    );
    expect(await runRemoteRelease(["build"], {}, runtime)).toBe(255);
    const text = lines.join("\n");
    expect(text).toContain("dropped (exit 255)");
    expect(text).toContain("release:linux -- attach");
    expect(text).not.toContain("could not reach");
  });

  test("the start marker is found when it straddles two output chunks", async () => {
    const { runtime, lines } = fakeRuntime("", 255);
    runtime.run = async (_command, _script, onOutput) => {
      onOutput("[builder] started the Linux rel");
      onOutput("ease build (pid 42)\n");
      return 255;
    };
    await runRemoteRelease(["build"], {}, runtime);
    expect(lines.join("\n")).toContain("dropped (exit 255)");
  });

  test("an attach whose connection drops says to attach again", async () => {
    const { runtime, lines } = fakeRuntime("[builder] following x.log\n", 255);
    expect(await runRemoteRelease(["attach"], {}, runtime)).toBe(255);
    expect(lines.join("\n")).toContain("release:linux -- attach");
  });

  test("a build that never connected still mentions attach in case it started", async () => {
    const { runtime, lines } = fakeRuntime("ssh: connect to host omarchy-hp: timed out\n", 255);
    expect(await runRemoteRelease(["build"], {}, runtime)).toBe(255);
    const text = lines.join("\n");
    expect(text).toContain("could not reach omarchy-hp, or lost the connection");
    expect(text).toContain("release:linux -- attach");
  });

  test("refuses a version no channel ships", async () => {
    const { runtime } = fakeRuntime("", 0);
    runtime.version = () => "2.30.0-rc.1";
    await expect(runRemoteRelease(["build"], {}, runtime)).rejects.toThrow("no update channel");
  });
});
