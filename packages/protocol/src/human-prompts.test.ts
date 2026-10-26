import { describe, expect, test } from "bun:test";

import { detectHumanPrompt, HumanPromptScanner, normalizeTerminalText } from "./human-prompts";

/** Output captured from real runs (codes and ids are the originals' shape, not live values). */
const SAMPLES = {
  // `npm login --auth-type=web`, npm 11.19 (the 2026-10-26 release incident).
  npmWebLogin:
    "npm notice Log in on https://registry.npmjs.org/\n" +
    "npm notice npm tokens that bypass 2FA are being restricted for account changes and direct publishing. Learn how to prepare: https://gh.io/npm-gat-bypass2fa-deprecation\n" +
    "Login at:\n" +
    "https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967\n" +
    "Press ENTER to open in the browser...\n",
  // `npm publish` with web 2FA.
  npmPublishAuth:
    "npm notice Publishing to https://registry.npmjs.org/ with tag beta and public access\n" +
    "Authenticate your account at:\n" +
    "https://www.npmjs.com/auth/cli/0d6c51a1-2c8e-4c0f-9a43-3a7b0d5e2f11\n" +
    "Press ENTER to open in the browser...\n",
  // `gh auth login --web`.
  ghDevice:
    "! First copy your one-time code: 1A2B-3C4D\n" +
    "Press Enter to open https://github.com/login/device in your browser... ",
  // `ssh host` through Tailscale SSH with check mode.
  tailscaleSsh:
    "# Tailscale SSH requires an additional check.\n" +
    "# To authenticate, visit: https://login.tailscale.com/a/l7c3e9f2b1a4d\n",
  // `tailscale up`.
  tailscaleUp: "\nTo authenticate, visit:\n\n\thttps://login.tailscale.com/a/1a2b3c4d5e6f\n\n",
  sshHostKey:
    "The authenticity of host 'omarchy-hp (100.101.102.103)' can't be established.\n" +
    "ED25519 key fingerprint is SHA256:Qm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg.\n" +
    "This key is not known by any other names.\n" +
    "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
  sudo: "[sudo] password for arkaydeus: ",
  sshPassphrase: "Enter passphrase for key '/Users/arkaydeus/.ssh/id_ed25519': ",
  gitHttps: "Username for 'https://github.com': ",
  azDevice:
    "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code H7KQ2PZ9X to authenticate.\n",
};

describe("detectHumanPrompt on real output", () => {
  test("npm web login: the login link, and ENTER opens it", () => {
    expect(detectHumanPrompt(SAMPLES.npmWebLogin)).toMatchObject({
      kind: "sign-in",
      url: "https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967",
      wantsEnter: true,
    });
  });

  test("npm publish auth", () => {
    const prompt = detectHumanPrompt(SAMPLES.npmPublishAuth);
    expect(prompt).toMatchObject({
      kind: "sign-in",
      url: "https://www.npmjs.com/auth/cli/0d6c51a1-2c8e-4c0f-9a43-3a7b0d5e2f11",
    });
    expect(prompt?.code).toBeUndefined();
  });

  test("gh device flow: link and one-time code", () => {
    expect(detectHumanPrompt(SAMPLES.ghDevice)).toMatchObject({
      kind: "device-code",
      url: "https://github.com/login/device",
      code: "1A2B-3C4D",
      wantsEnter: true,
    });
  });

  test("Tailscale SSH check and tailscale up", () => {
    expect(detectHumanPrompt(SAMPLES.tailscaleSsh)).toMatchObject({
      kind: "sign-in",
      url: "https://login.tailscale.com/a/l7c3e9f2b1a4d",
      wantsEnter: false,
    });
    expect(detectHumanPrompt(SAMPLES.tailscaleUp)).toMatchObject({
      kind: "sign-in",
      url: "https://login.tailscale.com/a/1a2b3c4d5e6f",
    });
  });

  test("Azure device login: link and code from one sentence", () => {
    expect(detectHumanPrompt(SAMPLES.azDevice)).toMatchObject({
      kind: "device-code",
      url: "https://microsoft.com/devicelogin",
      code: "H7KQ2PZ9X",
    });
  });

  test("SSH host-key confirmation", () => {
    expect(detectHumanPrompt(SAMPLES.sshHostKey)).toMatchObject({
      kind: "host-key",
      text: "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
    });
  });

  test("password, passphrase and credential prompts while the command waits on them", () => {
    expect(detectHumanPrompt(SAMPLES.sudo)).toMatchObject({ kind: "secret" });
    expect(detectHumanPrompt(SAMPLES.sshPassphrase)).toMatchObject({ kind: "secret" });
    expect(detectHumanPrompt(SAMPLES.gitHttps)).toMatchObject({ kind: "secret" });
    expect(detectHumanPrompt("Password:")).toMatchObject({ kind: "secret" });
  });

  test("a prompt that was answered (followed by a newline) is not waiting", () => {
    expect(detectHumanPrompt(`${SAMPLES.sudo}\nok\n`)).toBeNull();
    expect(detectHumanPrompt(`${SAMPLES.sshHostKey}yes\nWarning: Permanently added\n`)).toBeNull();
  });

  test("a finished command is never waiting", () => {
    expect(detectHumanPrompt(SAMPLES.npmWebLogin, { final: true })).toBeNull();
  });
});

describe("detectHumanPrompt stays quiet on ordinary output", () => {
  test.each([
    ["registry notice", "npm notice Log in on https://registry.npmjs.org/\n"],
    ["docs link", "Learn more: https://docs.github.com/en/actions\n"],
    ["build URL", "Preview: https://myapp-git-feature.vercel.app\n"],
    ["PR link", "https://github.com/acme/app/pull/1304\n"],
    ["password in prose", "Rotate the password: see docs.\nDone.\n"],
    ["password mention mid-output", "Checking password policy...\nok\n"],
    ["test output", "✓ prompts for a password when missing [2ms]\n"],
    ["press enter in a finished line", "Press ENTER to continue\nContinuing\n"],
    ["code word", "Enter the code below to continue\n"],
  ])("%s", (_name, output) => {
    expect(detectHumanPrompt(output)).toBeNull();
  });

  test("the login *page* of a known host only counts on its sign-in path", () => {
    expect(detectHumanPrompt("See https://www.npmjs.com/package/orkestrator\n")).toBeNull();
    expect(detectHumanPrompt("See https://github.com/settings/tokens\n")).toBeNull();
  });
});

describe("normalizeTerminalText", () => {
  test("strips colours and hyperlinks and keeps the last carriage-return redraw", () => {
    expect(
      normalizeTerminalText(
        "\u001b[1mLogin at:\u001b[0m\n\u001b]8;;https://x\u0007link\u001b]8;;\u0007\nwait 1\rwait 2\r\n",
      ),
    ).toBe("Login at:\nlink\nwait 2\n");
  });
});

describe("HumanPromptScanner", () => {
  test("announces a prompt once across chunks and redraws, and clears on exit", () => {
    const scanner = new HumanPromptScanner();
    expect(
      scanner.push("npm notice Log in on https://registry.npmjs.org/\nLogin at:\n"),
    ).toBeNull();
    const first = scanner.push(
      "https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967\nPress ENTER",
    );
    expect(first).toMatchObject({ prompt: { kind: "sign-in" } });
    expect(scanner.push(" to open in the browser...\n")).toBeNull();
    expect(scanner.push("\n")).toBeNull();
    expect(scanner.finish()).toEqual({ cleared: true });
    expect(scanner.finish()).toBeNull();
  });

  test("a new link replaces the old one", () => {
    const scanner = new HumanPromptScanner();
    scanner.push("To authenticate, visit: https://login.tailscale.com/a/aaaaaaaa\n");
    expect(
      scanner.push("To authenticate, visit: https://login.tailscale.com/a/bbbbbbbb\n"),
    ).toMatchObject({
      prompt: { url: "https://login.tailscale.com/a/bbbbbbbb" },
    });
  });

  test("an answered password prompt clears", () => {
    const scanner = new HumanPromptScanner();
    expect(scanner.push("[sudo] password for me: ")).toMatchObject({ prompt: { kind: "secret" } });
    expect(scanner.push("\n")).toEqual({ cleared: true });
  });
});

test("alphabetic labelled codes are accepted without treating prose as codes", () => {
  for (const code of ["ABCD-EFGH", "ABCDEFGH"]) {
    expect(
      detectHumanPrompt(`Open https://github.com/login/device\nDevice code: ${code}`)?.code,
    ).toBe(code);
  }
  expect(
    detectHumanPrompt("https://github.com/login/device\nEnter the code below")?.code,
  ).toBeUndefined();
});

test("URL then ENTER updates actions while retaining notification identity", () => {
  const scanner = new HumanPromptScanner();
  const first = scanner.push("https://github.com/login/device\n");
  expect(first).toHaveProperty("prompt.wantsEnter", false);
  const key = scanner.prompt?.key;
  expect(scanner.push("Press ENTER to continue")).toHaveProperty("prompt.wantsEnter", true);
  expect(scanner.prompt?.key).toBe(key);
  expect(scanner.push("")).toBeNull();
});

test("unknown or credential-bearing hosts never become sign-in actions", () => {
  for (const url of [
    "https://unlisted.example/login",
    "https://github.com.evil.example/login/device",
    "https://evil@github.com/login/device",
  ]) {
    expect(detectHumanPrompt(`Sign in at ${url}`)).toBeNull();
    expect(detectHumanPrompt(`Sign in at ${url}\nDevice code: ABCD-EFGH\nPress ENTER`)).toBeNull();
  }
});
