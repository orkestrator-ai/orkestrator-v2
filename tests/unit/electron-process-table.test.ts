import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { electronProcessTree } from "../../e2e/agent-testing/design-electron-cleanup";

const app = { process: () => ({ pid: 100 }) as ChildProcess };

function windowsTree(stdout: string, status: number | null = 0) {
  return electronProcessTree(app, "win32", (command, args, options) => {
    expect(command).toBe("powershell.exe");
    expect(args).toContain("-NonInteractive");
    expect(args.at(-1)).toContain("Get-CimInstance Win32_Process");
    expect(args.at(-1)).toContain("$ErrorActionPreference = 'Stop'");
    expect(options.timeout).toBe(30_000);
    return { stdout, status };
  });
}

describe("Windows Electron process ownership", () => {
  test("parses CRLF output and walks an unordered multilevel tree", () => {
    expect(
      windowsTree(
        "300 200 133000000000000030\r\n200 100 133000000000000020\r\n" +
          "100 50 133000000000000000\r\n400 50 133000000000000040\r\n\r\n",
      ),
    ).toEqual([100, 200, 300]);
  });

  test("excludes an older child and its descendants after parent PID reuse", () => {
    expect(windowsTree("100 50 300\n200 100 200\n300 200 400\n400 100 400\n500 400 500\n")).toEqual(
      [100, 400, 500],
    );
  });

  test("applies the creation-time check at every level", () => {
    expect(windowsTree("100 50 100\n200 100 300\n300 200 200\n400 300 400\n")).toEqual([100, 200]);
  });

  test.each(["0", "", "invalid"])(
    "does not claim a child without a usable creation date (%s)",
    (missing) => {
      expect(windowsTree(`100 50 100\n200 100 ${missing}\n300 200 300\n`)).toEqual([100]);
      expect(windowsTree(`100 50 ${missing}\n200 100 200\n`)).toEqual([100]);
    },
  );

  test("a missing root row cannot establish Windows descendant ownership", () => {
    expect(windowsTree("200 100 200\n300 200 300\n")).toEqual([100]);
  });

  test.each([1, null])("enumeration failure (%s) rejects partial output", (status) => {
    expect(() => windowsTree("100 50 100\n200 100 200\n", status)).toThrow(
      "Could not enumerate Electron descendants",
    );
  });

  test("an unavailable enumeration command propagates its error", () => {
    const failure = new Error("PowerShell unavailable");
    expect(() =>
      electronProcessTree(app, "win32", () => {
        throw failure;
      }),
    ).toThrow(failure);
  });

  test("Unix parent links do not require creation dates", () => {
    expect(
      electronProcessTree(app, "linux", (command) => {
        expect(command).toBe("ps");
        return { stdout: "300 200\n100 50\n200 100\n", status: 0 };
      }),
    ).toEqual([100, 200, 300]);
  });
});
