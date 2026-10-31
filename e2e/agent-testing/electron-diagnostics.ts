import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ElectronApplication, Page, TestInfo } from "@playwright/test";

/**
 * What an Electron spec heard from the processes it started: the renderer's
 * Vite server, Electron's main process, and every window's console errors,
 * page errors and crashes. A failing test gets the latest lines attached.
 *
 * Without it a renderer that never leaves index.html's title fails as a bare
 * title timeout: Vite's output was discarded and the renderer's never read, so
 * load and a real startup error looked the same (review validation,
 * 2026-10-31). The buffer spans the worker, not one test, because some specs
 * start Electron in `beforeAll`; each test start is marked in it.
 */
const MAX_LINES = 150;
const MAX_LINE_CHARS = 400;
let lines: string[] = [];

function record(source: string, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines.push(
      `[${source}] ${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`,
    );
  }
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
}

/** Collects a helper process's output; spawn it with piped stdout and stderr. */
export function recordProcessOutput(source: string, child: ChildProcess): void {
  child.stdout?.on("data", (chunk: Buffer) => record(source, chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => record(source, chunk.toString("utf8")));
  child.once("exit", (code, signal) =>
    record(source, `exited (code ${code ?? "none"}, signal ${signal ?? "none"})`),
  );
}

/** Collects Electron's main-process output and what each of its windows reports. */
export function recordElectronDiagnostics(app: ElectronApplication): void {
  recordProcessOutput("electron", app.process());
  const watch = (page: Page) => {
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        record(`renderer ${message.type()}`, message.text());
      }
    });
    page.on("pageerror", (error) => record("renderer pageerror", error.stack ?? error.message));
    page.on("crash", () => record("renderer", "crashed"));
  };
  for (const page of app.windows()) watch(page);
  app.on("window", watch);
}

export function markTestStart(title: string): void {
  record("test", `--- ${title} ---`);
}

/** Saves complete diagnostics; the line reporter prints the attachment path. */
export async function attachElectronDiagnostics(testInfo: TestInfo): Promise<void> {
  if (lines.length === 0) return;
  const diagnosticsPath = testInfo.outputPath("electron-diagnostics.txt");
  await mkdir(dirname(diagnosticsPath), { recursive: true });
  await writeFile(diagnosticsPath, lines.join("\n"), { mode: 0o600 });
  await testInfo.attach("electron-diagnostics", {
    path: diagnosticsPath,
    contentType: "text/plain",
  });
}

/**
 * For startup in `beforeAll`, where no test fixture runs: a failure carries the
 * collected lines in its own message.
 */
export async function withElectronDiagnostics<T>(start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    if (error instanceof Error && lines.length > 0) {
      error.message = `${error.message}\n\nElectron diagnostics:\n${lines.join("\n")}`;
    }
    throw error;
  }
}
