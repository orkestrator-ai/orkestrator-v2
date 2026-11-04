import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bridgeLogEnvironmentExports,
  keepPreviousLogCommand,
  previousContainerLogFile,
} from "./container-log-bounds.js";

describe("bridgeLogEnvironmentExports", () => {
  test("a container bridge writes JSON lines, with no level unless the backend has one", () => {
    expect(bridgeLogEnvironmentExports({})).toBe("export ORKESTRATOR_LOG_FORMAT=json");
  });

  test("the level survives the shell whatever it holds", () => {
    const level = "warn,bridge.codex=debug'; touch /tmp/nope; '";
    const script = `${bridgeLogEnvironmentExports({ ORKESTRATOR_LOG_LEVEL: level })}
printf '%s' "$ORKESTRATOR_LOG_FORMAT|$ORKESTRATOR_LOG_LEVEL"`;
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    expect(result.stdout).toBe(`json|${level}`);
  });
});

describe("keeping the previous log across a relaunch", () => {
  const WRITER = path.resolve(import.meta.dir, "../../../../docker/orkestrator-log-writer.sh");

  function scratch(run: (directory: string, log: string, previous: string) => void): void {
    const directory = mkdtempSync(path.join(os.tmpdir(), "ork-prev-log-"));
    try {
      const log = path.join(directory, "bridge.log");
      run(directory, log, previousContainerLogFile(log));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /** The launch scripts run under bash, and the OpenCode one with `set -e`. */
  function runInScript(command: string): { status: number | null; stderr: string } {
    const result = spawnSync("bash", ["-c", `set -e\n${command}\necho reached`], {
      encoding: "utf8",
    });
    expect(result.stdout).toBe("reached\n");
    return { status: result.status, stderr: result.stderr };
  }

  test.each([
    ["/tmp/opencode-serve.log", "/tmp/opencode-serve.prev.log"],
    ["/tmp/claude-bridge.log", "/tmp/claude-bridge.prev.log"],
    ["/tmp/codex-bridge.log", "/tmp/codex-bridge.prev.log"],
    ["/tmp/cursor-bridge.log", "/tmp/cursor-bridge.prev.log"],
    ["/tmp/grok-acp-bridge.log", "/tmp/grok-acp-bridge.prev.log"],
    ["/tmp/pi-bridge.log", "/tmp/pi-bridge.prev.log"],
  ])("%s keeps its previous run in %s", (file, previous) => {
    expect(previousContainerLogFile(file)).toBe(previous);
    expect(keepPreviousLogCommand(file)).toContain(`mv -f ${file} ${previous}`);
  });

  test("a fresh start with no log does nothing and does not stop the script", () => {
    scratch((_directory, log, previous) => {
      expect(runInScript(keepPreviousLogCommand(log))).toEqual({ status: 0, stderr: "" });
      expect(existsSync(log)).toBe(false);
      expect(existsSync(previous)).toBe(false);
    });
  });

  test("the log moves with its 0600 mode, replacing the run before it", () => {
    scratch((_directory, log, previous) => {
      writeFileSync(previous, "older run\n", { mode: 0o600 });
      writeFileSync(log, "crashed run\n", { mode: 0o600 });
      expect(runInScript(keepPreviousLogCommand(log)).status).toBe(0);
      expect(readFileSync(previous, "utf8")).toBe("crashed run\n");
      expect(statSync(previous).mode & 0o777).toBe(0o600);
      expect(existsSync(log)).toBe(false);
    });
  });

  test("an empty log does not displace the run that explains a crash", () => {
    scratch((_directory, log, previous) => {
      writeFileSync(previous, "crashed run\n", { mode: 0o600 });
      writeFileSync(log, "", { mode: 0o600 });
      expect(runInScript(keepPreviousLogCommand(log)).status).toBe(0);
      expect(readFileSync(previous, "utf8")).toBe("crashed run\n");
    });
  });

  test("a move that fails still leaves the new run a clean log", () => {
    scratch((_directory, log, previous) => {
      // `mv` refuses to replace a non-empty directory of the file's own name.
      mkdirSync(path.join(previous, "bridge.log"), { recursive: true });
      writeFileSync(path.join(previous, "bridge.log", "occupied"), "x");
      writeFileSync(log, "crashed run\n", { mode: 0o600 });
      expect(runInScript(keepPreviousLogCommand(log))).toEqual({ status: 0, stderr: "" });
      expect(existsSync(log)).toBe(false);
    });
  });

  test("with the image's rotating writer, each run gets a clean 0600 log", () => {
    scratch((directory, log, previous) => {
      const launch = (line: string) => {
        const result = spawnSync(
          "bash",
          ["-c", `${keepPreviousLogCommand(log)}\nprintf '%s\\n' '${line}' | "$WRITER" "$LOG"`],
          { encoding: "utf8", cwd: directory, env: { ...process.env, WRITER, LOG: log } },
        );
        expect(result.status).toBe(0);
      };
      launch("first run");
      expect(readFileSync(log, "utf8")).toBe("first run\n");
      expect(existsSync(previous)).toBe(false);
      launch("second run");
      expect(readFileSync(log, "utf8")).toBe("second run\n");
      expect(readFileSync(previous, "utf8")).toBe("first run\n");
      expect(statSync(log).mode & 0o777).toBe(0o600);
      expect(statSync(previous).mode & 0o777).toBe(0o600);
    });
  });

  test("an image without the writer redirects to a clean log, and the old run is kept", () => {
    scratch((_directory, log, previous) => {
      writeFileSync(log, "first run\n", { mode: 0o600 });
      const script = `umask 077\n${keepPreviousLogCommand(log)}\necho 'second run' > ${log}`;
      expect(spawnSync("bash", ["-c", script]).status).toBe(0);
      expect(readFileSync(log, "utf8")).toBe("second run\n");
      expect(readFileSync(previous, "utf8")).toBe("first run\n");
      expect(statSync(previous).mode & 0o777).toBe(0o600);
    });
  });
});
