import { describe, expect, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const { resolveBrowserOpenCommand, resolveFileManagerRevealCommands } =
  await createCommandFixtures();

describe("resolveBrowserOpenCommand", () => {
  test("uses direct platform launchers without a command interpreter", () => {
    expect(resolveBrowserOpenCommand("https://example.com/a?x=1&y=2", "darwin")).toEqual({
      command: "open",
      args: ["https://example.com/a?x=1&y=2"],
    });
    expect(resolveBrowserOpenCommand("https://example.com/a?x=1&y=2", "win32")).toEqual({
      command: "explorer.exe",
      args: ["https://example.com/a?x=1&y=2"],
    });
    expect(resolveBrowserOpenCommand("http://127.0.0.1:34121/", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:34121/"],
    });
  });

  test("rejects malformed and non-web URLs", () => {
    expect(() => resolveBrowserOpenCommand("not a url", "win32")).toThrow("Invalid browser URL");
    expect(() => resolveBrowserOpenCommand("file:///tmp/secret", "win32")).toThrow(
      "Unsupported browser URL protocol",
    );
  });
});

describe("resolveFileManagerRevealCommands", () => {
  test("uses native selection commands on macOS and Windows", () => {
    expect(resolveFileManagerRevealCommands("/tmp/project/file.ts", "darwin")).toEqual([
      { command: "open", args: ["-R", "/tmp/project/file.ts"] },
    ]);
    expect(resolveFileManagerRevealCommands("C:\\project\\file.ts", "win32")).toEqual([
      { command: "explorer", args: ["/select,", "C:\\project\\file.ts"] },
    ]);
  });

  test("selects through FileManager1 on Linux with an encoded URI and parent-folder fallback", () => {
    expect(resolveFileManagerRevealCommands("/tmp/project/file, name.ts", "linux")).toEqual([
      {
        command: "dbus-send",
        args: [
          "--session",
          "--print-reply",
          "--dest=org.freedesktop.FileManager1",
          "/org/freedesktop/FileManager1",
          "org.freedesktop.FileManager1.ShowItems",
          "array:string:file:///tmp/project/file%2C%20name.ts",
          "string:",
        ],
      },
      { command: "xdg-open", args: ["/tmp/project"] },
    ]);
  });
});
