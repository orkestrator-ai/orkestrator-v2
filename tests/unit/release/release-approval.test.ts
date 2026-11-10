import { describe, expect, test } from "bun:test";
import {
  alertApproval,
  ApprovalWatcher,
  findApprovalLinks,
  notificationCommand,
  openBrowserCommand,
  teeStream,
  type ApprovalAlertRuntime,
  type ApprovalLink,
} from "../../../scripts/release-approval";

const NPM = "https://www.npmjs.com/auth/cli/0b6c6a31-5f05-4f43-9d6b-d3b4d9a0c2e7";
const TAILSCALE = "https://login.tailscale.com/a/1a2b3c4d5e6f";

describe("findApprovalLinks", () => {
  test("finds npm and Tailscale links in output order", () => {
    const text = `# To authenticate, visit:\n#   ${TAILSCALE}\nAuthenticate your account at:\n${NPM}\n`;
    expect(findApprovalLinks(text)).toEqual([
      { kind: "tailscale", url: TAILSCALE },
      { kind: "npm", url: NPM },
    ]);
  });

  test("ignores a link that may still be arriving", () => {
    expect(findApprovalLinks(`Authenticate your account at:\n${NPM}`)).toEqual([]);
  });

  test("ignores other npm and Tailscale pages", () => {
    expect(
      findApprovalLinks(
        "https://www.npmjs.com/package/orkestrator https://login.tailscale.com/admin\n",
      ),
    ).toEqual([]);
  });
});

describe("ApprovalWatcher", () => {
  test("reports a link split across chunks once, when it is complete", () => {
    const seen: ApprovalLink[] = [];
    const watcher = new ApprovalWatcher((link) => seen.push(link));
    watcher.push("Authenticate your account at:\n");
    watcher.push(NPM.slice(0, 30));
    expect(seen).toEqual([]);
    watcher.push(`${NPM.slice(30)}\nwaiting...\n`);
    watcher.push(`${NPM}\n`);
    expect(seen).toEqual([{ kind: "npm", url: NPM }]);
    expect(watcher.links()).toEqual([{ kind: "npm", url: NPM }]);
  });

  test("keeps finding links after a lot of unrelated output", () => {
    const seen: ApprovalLink[] = [];
    const watcher = new ApprovalWatcher((link) => seen.push(link));
    for (let index = 0; index < 100; index++) watcher.push(`${"x".repeat(1000)}\n`);
    watcher.push(`${TAILSCALE}\n`);
    expect(seen).toEqual([{ kind: "tailscale", url: TAILSCALE }]);
  });
});

describe("notifications", () => {
  test("macOS passes the text as arguments to osascript", () => {
    const command = notificationCommand("darwin", 'Title "quoted"', "Message; rm -rf /");
    expect(command?.[0]).toBe("osascript");
    expect(command?.slice(-2)).toEqual(['Title "quoted"', "Message; rm -rf /"]);
    expect(command?.join(" ")).toContain("item 2 of argv");
  });

  test("Linux uses notify-send", () => {
    expect(notificationCommand("linux", "T", "M")).toEqual([
      "notify-send",
      "--urgency=critical",
      "--app-name=Orkestrator release",
      "T",
      "M",
    ]);
  });

  test("other platforms have none", () => {
    expect(notificationCommand("win32", "T", "M")).toBeNull();
  });

  test("the browser opens by default on macOS only, and can be switched", () => {
    expect(openBrowserCommand("darwin", NPM, {})).toEqual(["open", NPM]);
    expect(
      openBrowserCommand("darwin", NPM, { ORKESTRATOR_RELEASE_OPEN_APPROVAL: "0" }),
    ).toBeNull();
    expect(openBrowserCommand("linux", NPM, {})).toBeNull();
    expect(openBrowserCommand("linux", NPM, { ORKESTRATOR_RELEASE_OPEN_APPROVAL: "1" })).toEqual([
      "xdg-open",
      NPM,
    ]);
  });

  test("alertApproval rings, prints the link, notifies and opens it", () => {
    const launched: string[][] = [];
    let written = "";
    const runtime: ApprovalAlertRuntime = {
      platform: "darwin",
      env: {},
      launch: (command) => launched.push(command),
      write: (text) => {
        written += text;
      },
    };
    alertApproval({ kind: "npm", url: NPM }, runtime);
    expect(written).toContain("\u0007");
    expect(written).toContain(NPM);
    expect(written).toContain("five minutes");
    expect(launched.map((command) => command[0])).toEqual(["osascript", "open"]);
  });
});

test("teeStream copies bytes through and decodes text split mid-character", async () => {
  const bytes = new TextEncoder().encode(`é ${NPM}\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
  const copied: Uint8Array[] = [];
  let text = "";
  await teeStream(stream, { write: (chunk) => copied.push(chunk) }, (part) => {
    text += part;
  });
  expect(Buffer.concat(copied).toString()).toBe(`é ${NPM}\n`);
  expect(text).toBe(`é ${NPM}\n`);
});
