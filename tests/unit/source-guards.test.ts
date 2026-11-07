import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BASELINE_PATH,
  REGENERATE_COMMAND,
  baselineFromFindings,
  compareWithBaseline,
  formatRegressions,
  formatStale,
  parseBaseline,
  serializeBaseline,
  type Baseline,
} from "../source-guards/baseline";
import {
  DIRECT_TRANSPORT_ROOTS,
  directTransportImport,
} from "../source-guards/direct-transport-import";
import { GUARD_IDS, type GuardId, type SourceGuard } from "../source-guards/guard";
import { releasedPortRebind } from "../source-guards/released-port-rebind";
import {
  SOURCE_GUARDS,
  baselineKey,
  emptyFindings,
  listProductionSources,
  listTestSources,
  scanRepository,
  scanSource,
  type Findings,
} from "../source-guards/scan";
import { sleepBeforeNegativeAssertion } from "../source-guards/sleep-before-negative-assertion";
import { smallFakePid } from "../source-guards/small-fake-pid";
import { subprocessWithoutBudget } from "../source-guards/subprocess-without-budget";
import {
  LibBackendShimResolver,
  createLibBackendCommandDefaultGuard,
} from "../source-guards/lib-backend-command-default";
import { mergeBaseline, selectedGuards, subjectTotals } from "../source-guards/update-baseline";
import { moduleIdOfFile, repositoryModules, resolveWebModule } from "../source-guards/web-modules";
import { WINDOW_STORES } from "../source-guards/window-stores";
import {
  WINDOW_ORKESTRATOR_ROOTS,
  transportAccesses,
  windowOrkestratorDirect,
} from "../source-guards/window-orkestrator-direct";
import { parseSync } from "oxc-parser";

const ROOT = path.resolve(import.meta.dir, "../..");
const ADVICE = Object.fromEntries(SOURCE_GUARDS.map((guard) => [guard.id, guard.advice])) as Record<
  GuardId,
  string
>;

/** Lines the guard reports for a snippet, as a scan of that one file would. */
function lines(guard: SourceGuard, source: string, file = "fixture.test.ts"): number[] {
  return scanSource({ path: file, source, isBunTest: /\.test\./.test(file) }, [guard]).map(
    (finding) => finding.line,
  );
}

describe("source guards over the repository", () => {
  test("no file has more findings than the baseline allows, and the baseline is not stale", () => {
    const findings = scanRepository(ROOT);
    const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
    const { regressions, stale } = compareWithBaseline(findings, baseline);
    expect(formatRegressions(regressions, ADVICE)).toBe("");
    expect(formatStale(stale)).toBe("");
  }, 30_000);

  test("the committed baseline is in the regenerated form", () => {
    const text = readFileSync(BASELINE_PATH, "utf8");
    expect(serializeBaseline(parseBaseline(text))).toBe(text);
  });
});

describe("the source walk", () => {
  test("reads test files and test-support modules once, skipping dependencies and symlinks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "source-guards-walk-"));
    try {
      const included = [
        "apps/web/src/thing.test.tsx",
        "bridges/example/src/thing.spec.ts",
        "packages/protocol/src/testing/helper.ts",
        "apps/backend/tests/command-fixtures.ts",
        "bridges/example/src/app-test-harness.ts",
        "apps/backend/src/core/public-api/test-support.ts",
        "scripts/thing.test.ts",
        "e2e/agent-testing/thing.spec.ts",
        "tests/helpers/anything.ts",
      ];
      const excluded = [
        "apps/web/src/thing.ts",
        "apps/web/node_modules/dependency/thing.test.ts",
        "bridges/example/dist/thing.test.ts",
        "tests/.git/thing.test.ts",
        "tests/types.d.ts",
        "tests/fixtures/data.json",
        "tests/source-guards/fixtures/offender.test.ts",
        "docs/thing.test.ts",
      ];
      for (const file of [...included, ...excluded]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "export {};\n");
      }
      symlinkSync(path.join(root, "apps/web/src"), path.join(root, "apps/linked"), "dir");
      expect(listTestSources(root)).toEqual([...included].sort());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads production sources under the given roots only, skipping tests and declarations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "source-guards-production-"));
    try {
      const included = ["apps/web/src/App.tsx", "apps/web/src/lib/thing.ts"];
      const excluded = [
        "apps/web/src/App.test.tsx",
        "apps/web/src/lib/thing-test-support.ts",
        "apps/web/src/vite-env.d.ts",
        "apps/web/src/styles.css",
        "apps/web/node_modules/dependency/index.ts",
        "apps/web/src/node_modules/dependency/index.ts",
        "apps/backend/src/thing.ts",
      ];
      for (const file of [...included, ...excluded]) {
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), "export {};\n");
      }
      expect(listProductionSources(root, ["apps/web/src", "apps/web/src"])).toEqual(included);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a candidate file that does not parse fails the scan instead of passing", () => {
    expect(() =>
      scanSource(
        {
          path: "broken.test.ts",
          source: "await Bun.sleep(5); expect(x).toBe(0); const = ;",
          isBunTest: true,
        },
        [sleepBeforeNegativeAssertion],
      ),
    ).toThrow("broken.test.ts:");
  });
});

describe("sleep-before-negative-assertion", () => {
  const guard = sleepBeforeNegativeAssertion;

  test("flags a fixed sleep followed by a negative or exact-count assertion", () => {
    const source = [
      "// é — non-ASCII text before a finding must not shift its line",
      "test('a', async () => {",
      "  await Bun.sleep(50);",
      "  expect(spy).not.toHaveBeenCalled();",
      "  await new Promise((resolve) => setTimeout(resolve, 20));",
      "  expect(items).toHaveLength(0);",
      "  await sleep(10);",
      "  expect(count).toBe(0);",
      "  await delay(10);",
      "  expect(calls).toEqual([]);",
      "  await wait(5);",
      "  expect(value).toBeUndefined();",
      "  await page.waitForTimeout(500);",
      "  await expect(page.getByText('x')).not.toBeVisible();",
      "  await setTimeout(30);",
      "  expect(done).toBe(false);",
      "  await new Promise((resolve) => { setTimeout(resolve, 15); });",
      "  expect(handle).toBeNull();",
      "  await Bun.sleep(5);",
      "  expect(started).toBe(true);",
      "  const total = calls.length;",
      "  expect(fn).toHaveBeenCalledTimes(1);",
      "});",
    ].join("\n");
    expect(lines(guard, source)).toEqual([3, 5, 7, 9, 11, 13, 15, 17, 19]);
  });

  test("follows local helpers that sleep and sleeps inside act", () => {
    const source = [
      "const realTick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));",
      "async function settle(ms: number) { await Bun.sleep(ms + 30); }",
      "const flushTimers = () => new Promise((resolve) => setTimeout(resolve, 25));",
      "const pause = (ms: number) => realTick(ms);",
      "test('b', async () => {",
      "  await realTick(30);",
      "  expect(fn).toHaveBeenCalledTimes(2);",
      "  await settle(10);",
      "  expect(x).toBeFalsy();",
      "  await flushTimers();",
      "  expect(y).toBeNull();",
      "  await act(() => new Promise((resolve) => setTimeout(resolve, 40)));",
      "  expect(z).toEqual([]);",
      "  await act(async () => { await Bun.sleep(10); });",
      "  expect(w).not.toContain('a');",
      "  await pause(5);",
      "  expect(v).toBe(0);",
      "});",
    ].join("\n");
    expect(lines(guard, source)).toEqual([6, 8, 10, 12, 14, 16]);
  });

  test("does not flag positive assertions, awaited events, zero or named delays, or other blocks", () => {
    const source = [
      "const wait = mock(async (_ms: number) => {});",
      "test('positive assertions', async () => {",
      "  await Bun.sleep(50);",
      "  expect(spy).toHaveBeenCalled();",
      "  expect(count).toBe(1);",
      "});",
      "test('an awaited event in between', async () => {",
      "  await Bun.sleep(50);",
      "  await waitFor(() => expect(row).toBeTruthy());",
      "  expect(spy).not.toHaveBeenCalled();",
      "});",
      "test('a zero delay yields, it does not wait', async () => {",
      "  await new Promise((resolve) => setTimeout(resolve, 0));",
      "  expect(items).toHaveLength(0);",
      "});",
      "test('a named delay', async () => {",
      "  await Bun.sleep(SETTLE_MS);",
      "  expect(items).toHaveLength(0);",
      "});",
      "test('a local wait that is not a sleep', async () => {",
      "  await wait(5);",
      "  expect(items).toHaveLength(0);",
      "});",
      "test('an assertion in another block', async () => {",
      "  await Bun.sleep(5);",
      "  if (flag) { expect(items).toHaveLength(0); }",
      "});",
      "test('a timer that is not awaited', () => {",
      "  setTimeout(() => { done = true; }, 50);",
      "  expect(done).toBe(false);",
      "});",
      "test('controlled time', () => {",
      "  timer.advance();",
      "  expect(spy).not.toHaveBeenCalled();",
      "});",
    ].join("\n");
    expect(lines(guard, source)).toEqual([]);
  });
});

describe("released-port-rebind", () => {
  const guard = releasedPortRebind;

  test("flags helpers that bind port 0, read the port and release it", () => {
    const source = [
      "import net from 'node:net';",
      "function getPortFromProbe(): Promise<number> {",
      "  return new Promise((resolve) => {",
      "    const server = net.createServer();",
      "    server.listen(0, '127.0.0.1', () => {",
      "      const { port } = server.address() as AddressInfo;",
      "      server.close(() => resolve(port));",
      "    });",
      "  });",
      "}",
      "function bunPort(): number {",
      "  const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });",
      "  const port = probe.port;",
      "  probe.stop(true);",
      "  return port;",
      "}",
      "test('refused', async () => {",
      "  const closed = createServer();",
      "  const port = await new Promise<number>((resolve) =>",
      "    closed.listen({ host: '127.0.0.1', port: 0 }, () => resolve(closed.address().port)),",
      "  );",
      "  await new Promise<void>((resolve) => closed.close(() => resolve()));",
      "  await connect(port);",
      "});",
    ].join("\n");
    expect(lines(guard, source)).toEqual([5, 12, 20]);
  });

  test("flags calls to free-port helpers by name and the free-port packages", () => {
    const source = [
      "import getPort from 'get-port';",
      "const a = await getFreePort();",
      "const b = await findFreePort();",
      "const [c, d] = await reserveLoopbackPorts(2);",
      "const e = await fixtures.reserveFreePort();",
      "const f = await getPort();",
      "const g = await freePort();",
      "const h = await getAvailablePort();",
      "const i = await pickPort();",
    ].join("\n");
    expect(lines(guard, source)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test("does not flag a port 0 server that stays bound, closes only in cleanup or errors, or retries", () => {
    const source = [
      "test('bound', async () => {",
      "  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });",
      "  const port = server.port;",
      "  const url = `http://127.0.0.1:${server.port}/`;",
      "  try { await fetch(url); await fetch(`http://127.0.0.1:${port}`); } finally { server.stop(); }",
      "  expect(url).toContain('127.0.0.1');",
      "});",
      "test('cleanup', async () => {",
      "  const other = createServer();",
      "  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));",
      "  const port = (other.address() as AddressInfo).port;",
      "  cleanups.push(() => other.close());",
      "  afterEach(() => other.close());",
      "  await probe(port);",
      "});",
      "async function listenEphemeral(server = createServer()) {",
      "  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));",
      "  const address = server.address();",
      "  if (!address || typeof address === 'string') { server.close(); throw new Error('no port'); }",
      "  return { server, port: address.port };",
      "}",
      "test('retry', async () => {",
      "  let port = 0;",
      "  await retryOnAddressInUse(() => {",
      "    const probe = Bun.serve({ port: 0, fetch: () => new Response('x') });",
      "    port = probe.port;",
      "    probe.stop(true);",
      "    return start(port);",
      "  });",
      "});",
      "const fixed = createServer().listen(3000);",
      "const owned = server.getPort();",
    ].join("\n");
    expect(lines(guard, source)).toEqual([]);
  });
});

describe("subprocess-without-budget", () => {
  const guard = subprocessWithoutBudget;

  test("flags a test file that starts real processes with no budget, at the first one", () => {
    const cases: Array<[string, number]> = [
      ["test('a', () => {\n  Bun.spawnSync(['git', 'status']);\n});", 2],
      [
        "import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nconst run = promisify(execFile);",
        3,
      ],
      ["import { $ } from 'bun';\ntest('a', async () => {\n  await $`git status`;\n});", 3],
      [
        "import * as cp from 'node:child_process';\ntest('a', () => {\n  cp.spawnSync('ls');\n});",
        3,
      ],
      ["import { git } from './test-support';\ntest('a', () => {\n  git(repo, 'init');\n});", 3],
      ["import { spawn as run } from 'child_process';\ntest('a', () => {\n  run('ls');\n});", 3],
    ];
    for (const [source, line] of cases)
      expect([source, lines(guard, source)]).toEqual([source, [line]]);
  });

  test("accepts setDefaultTimeout or any explicit test or hook budget", () => {
    const spawn = "Bun.spawnSync(['git', 'status']);";
    const cases = [
      `import { setDefaultTimeout } from 'bun:test';\nsetDefaultTimeout(30_000);\ntest('a', () => { ${spawn} });`,
      `test('a', () => { ${spawn} }, 30_000);`,
      `test('a', async () => { ${spawn} }, { timeout: TIMEOUT_MS });`,
      `beforeAll(() => { ${spawn} }, 60_000);\ntest('a', () => {});`,
      `test.each([1, 2])('a %d', () => { ${spawn} }, 20_000);`,
      `test.if(posix)('a', () => { ${spawn} }, 20_000);`,
    ];
    for (const source of cases) expect([source, lines(guard, source)]).toEqual([source, []]);
  });

  test("ignores type-only imports, local fakes, non-test modules and Playwright specs", () => {
    const source = [
      "import type { ChildProcess } from 'node:child_process';",
      "import { type SpawnOptions, spawnSync as unused } from 'node:child_process';",
      "const git = mock(() => '');",
      "const spawn = mock(() => fakeChild);",
      "test('a', () => { git('status'); spawn('ls'); });",
    ].join("\n");
    expect(lines(guard, source)).toEqual([]);
    const spawning = "test('a', () => { Bun.spawnSync(['ls']); });";
    expect(lines(guard, spawning, "tests/helpers/support.ts")).toEqual([]);
    expect(lines(guard, spawning, "e2e/thing.spec.ts")).toEqual([]);
  });
});

describe("small-fake-pid", () => {
  const guard = smallFakePid;

  test("flags plausible pids given to child-process-shaped fakes", () => {
    const source = [
      "const a = new FakeChild(4242);",
      "const b = new ScriptedChild(2000 + index, options);",
      "const c = new FakeProcess({ pid: 1 });",
      "const d = new FakeChild(behaviour.pid ?? 1000 + spawnIndex);",
      "class FakeSubprocess {",
      "  pid = 1234;",
      "  constructor(readonly other = 1) { this.pid = 0; }",
      "}",
      "class StubChild { constructor(public pid = 77) {} }",
      "const e = { pid: 123, kill() {}, stdout: stream() };",
      "const f = Object.assign(new EventEmitter(), { pid: 123_456, kill: mock(() => true) });",
      "child.pid = 999;",
      "const g = { pid: -1, exitCode: null, once: () => {} };",
    ].join("\n");
    expect(lines(guard, source)).toEqual([1, 2, 3, 4, 6, 7, 9, 10, 11, 12, 13]);
  });

  test("does not flag safe pids, process tables, log fields, injected functions or finished results", () => {
    const source = [
      "const a = new FakeChild(FAKE_PID_BASE + index);",
      "const b = new FakeChild(fakePid(1));",
      "const c = new FakeChild(2_100_000_000);",
      "const d = new ScriptedChild(UNMAPPED_PID - 1_000 - spawnIndex, merged);",
      "const table = [{ pid: 123, ppid: 1, command: 'node' }];",
      "log({ event: 'spawned', pid: 42 });",
      "const options = { isProcessAlive: (pid: number) => pid === 4242 };",
      "signalPidFileProcess(4242);",
      "const result = { status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null };",
      "class ProcessTable { rows = [{ pid: 1 }]; }",
      "const record = { pid: 4242, bridgePid: 3131, cwd: '/tmp' };",
    ].join("\n");
    expect(lines(guard, source)).toEqual([]);
  });
});

describe("window-orkestrator-direct", () => {
  const guard = windowOrkestratorDirect;
  const file = "apps/web/src/components/Thing.tsx";

  test("flags every read of the host global, optional, computed or destructured", () => {
    const source = [
      "const a = window.orkestrator?.clipboard.readText();",
      "if (!window.orkestrator) throw new Error();",
      "window.orkestrator.listen('x', () => {});",
      'const b = window["orkestrator"];',
      "const c = globalThis.orkestrator;",
      "const { orkestrator } = window;",
      "const d = (window as Window).orkestrator!.invoke('get_config');",
    ].join("\n");
    expect(lines(guard, source, file)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("ignores the other page globals, types, comments, injected windows and strings", () => {
    const source = [
      "// window.orkestrator.invoke is not called here",
      "const a = window.orkestratorGateway?.baseUrl;",
      "const b = window.orkestratorWorkspaceTarget?.nodeId;",
      'type Api = NonNullable<Window["orkestrator"]>;',
      "const c = targetWindow.orkestrator;",
      "const d = 'window.orkestrator';",
      "const { orkestratorPortal } = window;",
    ].join("\n");
    expect(lines(guard, source, file)).toEqual([]);
  });

  test("applies to renderer production sources outside the scope adapters and test helpers", () => {
    const applies = (candidate: string) =>
      guard.appliesTo({ path: candidate, source: "", isBunTest: false });
    expect(guard.productionRoots).toEqual(WINDOW_ORKESTRATOR_ROOTS);
    expect(applies("apps/web/src/App.tsx")).toBe(true);
    expect(applies("apps/web/src/lib/native/clipboard.ts")).toBe(true);
    expect(applies("apps/web/src/lib/node-scope/command-client.ts")).toBe(false);
    expect(applies("apps/web/src/test/render-in-node-scope.tsx")).toBe(false);
    expect(applies("apps/backend/src/index.ts")).toBe(false);
  });

  test("a test-source guard never reads production files, and this guard never reads tests", () => {
    const findings = scanRepository(ROOT, [windowOrkestratorDirect]);
    const files = Object.keys(findings["window-orkestrator-direct"]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((candidate) => /\.(?:test|spec)\./.test(candidate))).toEqual([]);
  }, 30_000);

  test("no renderer file reads a transport member off window.orkestrator", () => {
    const offenders: string[] = [];
    for (const relative of listProductionSources(ROOT, WINDOW_ORKESTRATOR_ROOTS)) {
      if (!guard.appliesTo({ path: relative, source: "", isBunTest: false })) continue;
      const source = readFileSync(path.join(ROOT, relative), "utf8");
      if (!guard.mayOffend(source)) continue;
      const { program } = parseSync(relative, source, { astType: "js" });
      for (const offset of transportAccesses(program as never)) {
        const line = source.slice(0, offset).split("\n").length;
        offenders.push(`${relative}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 30_000);

  test("finds the transport members in a snippet", () => {
    const source = [
      "window.orkestrator?.invoke('a');",
      "const listen = window.orkestrator?.listen;",
      "window.orkestrator.eventStreamConnection?.state();",
      "window.orkestrator?.node?.('bk_a');",
      "window.orkestrator?.clipboard.writeText('x');",
    ].join("\n");
    const { program } = parseSync("fixture.ts", source, { astType: "js" });
    const found = transportAccesses(program as never).map(
      (offset) => source.slice(0, offset).split("\n").length,
    );
    expect(found).toEqual([1, 2, 3, 4]);
  });
});

describe("direct-transport-import", () => {
  const guard = directTransportImport;
  const file = "apps/web/src/components/chat/Thing.tsx";

  test("flags value imports, re-exports and import() of a transport, by alias or relative path", () => {
    const source = [
      'import { invoke } from "@/lib/native/backend";',
      'import { listen, type UnlistenFn } from "../../lib/native/events";',
      'import { listenAuthoritative } from "@/lib/native/authoritative-events.ts";',
      'import { createNodeTransport } from "@/lib/native/node-transport";',
      'export { invoke as call } from "@/lib/native/backend";',
      'export * from "@/lib/native/events";',
      'import "@/lib/native/backend";',
      'const lazy = () => import("@/lib/native/events");',
    ].join("\n");
    expect(lines(guard, source, file)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("ignores type-only imports, the typed clients, other native wrappers and lookalikes", () => {
    const source = [
      'import type { UnlistenFn } from "@/lib/native/events";',
      'import { type NodeTransport } from "@/lib/native/node-transport";',
      'export type { InvokeOptions } from "@/lib/native/backend";',
      'import { getConfig } from "@/lib/backend";',
      'import { getEnvironment } from "@/lib/backend/environments";',
      'import { writeText } from "@/lib/native/clipboard";',
      'import { createWebGatewayApi } from "@/lib/native/web-gateway";',
      'import { thing } from "@/lib/native/events-helpers";',
      'import { other } from "./native/backend-shape";',
      "const label = 'native/backend';",
    ].join("\n");
    expect(lines(guard, source, file)).toEqual([]);
  });

  test("applies to renderer production sources outside the scope, client and adapter layers", () => {
    const applies = (candidate: string) =>
      guard.appliesTo({ path: candidate, source: "", isBunTest: false });
    expect(guard.productionRoots).toEqual(DIRECT_TRANSPORT_ROOTS);
    expect(applies("apps/web/src/App.tsx")).toBe(true);
    expect(applies("apps/web/src/stores/environmentStore.ts")).toBe(true);
    expect(applies("apps/web/src/lib/node-scope/command-client.ts")).toBe(false);
    expect(applies("apps/web/src/lib/backend/environments.ts")).toBe(false);
    expect(applies("apps/web/src/lib/native/authoritative-events.ts")).toBe(false);
    expect(applies("apps/web/src/test/render-in-node-scope.tsx")).toBe(false);
    expect(applies("apps/desktop/electron/ipc.ts")).toBe(false);
  });

  test("a new direct import fails the committed baseline", () => {
    const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
    const findings = emptyFindings();
    for (const finding of scanSource(
      {
        path: "apps/web/src/components/chat/NewThing.tsx",
        source: 'import { invoke } from "@/lib/native/backend";\nvoid invoke;',
        isBunTest: false,
      },
      [guard],
    ))
      (findings[finding.guard][finding.file] ??= []).push(finding);
    const { regressions } = compareWithBaseline(findings, baseline);
    expect(regressions.map(({ guard: id, file: name }) => [id, name])).toEqual([
      ["direct-transport-import", "apps/web/src/components/chat/NewThing.tsx"],
    ]);
    expect(formatRegressions(regressions, ADVICE)).toContain("useNodeScope()");
  });

  test("an existing importer may not add a second one", () => {
    const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
    const [known, allowed] = Object.entries(baseline["direct-transport-import"])[0]!;
    const findings = emptyFindings();
    findings["direct-transport-import"][known] = Array.from({ length: allowed + 1 }, (_, line) => ({
      guard: "direct-transport-import" as const,
      file: known,
      line: line + 1,
    }));
    expect(compareWithBaseline(findings, baseline).regressions).toHaveLength(1);
  });

  test("reads production sources only", () => {
    const findings = scanRepository(ROOT, [directTransportImport]);
    const files = Object.keys(findings["direct-transport-import"]);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((candidate) => /\.(?:test|spec)\./.test(candidate))).toEqual([]);
  }, 30_000);
});

describe("renderer module resolution", () => {
  test("resolves the @ alias and relative paths to module ids, and leaves packages alone", () => {
    expect(resolveWebModule("apps/web/src/App.tsx", "@/stores")).toBe("apps/web/src/stores");
    expect(resolveWebModule("apps/web/src/App.tsx", "@/stores/index.ts")).toBe(
      "apps/web/src/stores",
    );
    expect(resolveWebModule("apps/web/src/components/chat/A.tsx", "../../stores/uiStore")).toBe(
      "apps/web/src/stores/uiStore",
    );
    expect(resolveWebModule("apps/web/src/stores/index.ts", "./claudeOptionsStore")).toBe(
      "apps/web/src/stores/claudeOptionsStore",
    );
    expect(resolveWebModule("apps/web/src/App.tsx", "zustand")).toBeNull();
    expect(resolveWebModule("apps/web/src/App.tsx", "@orkestrator/protocol/federation")).toBeNull();
    expect(moduleIdOfFile("apps/web/src/stores/index.ts")).toBe("apps/web/src/stores");
  });
});

describe("subject totals", () => {
  test("totals per subject for the regeneration summary", () => {
    expect(
      subjectTotals({
        "[options] apps/web/src/A.tsx": 2,
        "[options] apps/web/src/B.tsx": 1,
        "[config] apps/web/src/A.tsx": 4,
        "apps/web/src/plain.ts": 9,
      }),
    ).toEqual([
      ["config", 4],
      ["options", 3],
    ]);
  });
});

describe("renderer store registry (plan items 4004 and 3018)", () => {
  const storesDir = path.join(ROOT, "apps/web/src/stores");
  const storeModules = readdirSync(storesDir)
    .filter((file) => file.endsWith(".ts") && !file.includes(".test.") && file !== "index.ts")
    .map((file) => ({
      module: `stores/${file.replace(/\.ts$/u, "")}`,
      source: readFileSync(path.join(storesDir, file), "utf8"),
    }));

  test("every store module is a per-node store or a listed window store", () => {
    const perNode = storeModules.filter(({ source }) => source.includes("defineScopedStore"));
    const windowModules = storeModules
      .filter(({ source }) => !source.includes("defineScopedStore"))
      .map(({ module }) => module)
      .sort();
    expect(perNode.length).toBeGreaterThan(30);
    expect(WINDOW_STORES.map((entry) => entry.module).sort()).toEqual(windowModules);
    for (const entry of WINDOW_STORES)
      expect(existsSync(path.join(ROOT, "apps/web/src", `${entry.module}.ts`))).toBe(true);
  });

  test("a per-node store exports its hook through scopedStoreHook, which has no statics", () => {
    for (const { module, source } of storeModules) {
      if (!source.includes("defineScopedStore")) continue;
      expect([module, /export const use\w+ = scopedStoreHook\(\w+\);/u.test(source)]).toEqual([
        module,
        true,
      ]);
      expect([module, source.includes('from "@/lib/node-scope/scoped-store"')]).toEqual([
        module,
        true,
      ]);
    }
    // The command-scope shim (plan item 3001) is gone, so no hook can fall back or carry statics.
    expect(existsSync(path.join(ROOT, "apps/web/src/lib/node-scope/scoped-store-shim.ts"))).toBe(
      false,
    );
  });
});

describe("lib-backend-command-default", () => {
  /** An in-memory renderer: the `@/lib/backend` barrel and three of its files. */
  const modules: Record<string, { file: string; source: string }> = {
    "apps/web/src/lib/backend": {
      file: "apps/web/src/lib/backend.ts",
      source: [
        'export * from "./backend/kanban";',
        'export * from "./backend/agent-accounts";',
      ].join("\n"),
    },
    "apps/web/src/lib/backend/kanban": {
      file: "apps/web/src/lib/backend/kanban.ts",
      source: [
        'import { clientInvoke, commandBackendClient, type BackendClient } from "./client";',
        "export type KanbanStatus = 'done';",
        "export function isDone(status: string) { return status === 'done'; }",
        "export function createKanbanApi(client: BackendClient) {",
        "  const invoke = clientInvoke(client);",
        "  const listTasks = () => invoke('list_tasks');",
        "  const moveTask = (id: string) => invoke('move_task', { id });",
        "  return { listTasks, moveTask };",
        "}",
        "export const { listTasks, moveTask } = createKanbanApi(commandBackendClient);",
      ].join("\n"),
    },
    "apps/web/src/lib/backend/agent-accounts": {
      file: "apps/web/src/lib/backend/agent-accounts.ts",
      source: "export const machineInvoke = machineInvoker(commandBackendClient);",
    },
    "apps/web/src/lib/backend/command-nodes": {
      file: "apps/web/src/lib/backend/command-nodes.ts",
      source: "export const { getNodeStatus } = createCommandNodesApi(portalBackendClient);",
    },
  };
  const guard = createLibBackendCommandDefaultGuard({
    readModule: (moduleId) => modules[moduleId] ?? null,
  });
  const file = "apps/web/src/stores/kanbanStore.ts";
  const scoped = "export const kanbanStore = defineScopedStore<State>('kanban', () => () => ({}));";
  const found = (source: string, path = file) =>
    scanSource({ path, source, isBunTest: /\.test\./.test(path) }, [guard]).map(
      ({ line, subject }) => [line, subject],
    );

  test("counts command-bound uses through the barrel, a file, an alias and a namespace", () => {
    const source = [
      'import { listTasks, machineInvoke } from "@/lib/backend";',
      'import { moveTask as move } from "@/lib/backend/kanban";',
      'import * as backend from "@/lib/backend";',
      'import { getNodeStatus } from "../lib/backend/command-nodes";',
      scoped,
      "await listTasks();",
      "await move('a');",
      "await backend.moveTask('b');",
      "const calls = { listTasks, status: getNodeStatus };",
      "await machineInvoke(null, 'x');",
    ].join("\n");
    expect(found(source)).toEqual([
      [6, "kanban"],
      [7, "kanban"],
      [8, "kanban"],
      [9, "kanban"],
      [9, "command-nodes"],
      [10, "agent-accounts"],
    ]);
  });

  test("ignores factories, types, helpers, key names and the scoped fallback", () => {
    const source = [
      'import { createKanbanApi, isDone, listTasks, type KanbanStatus } from "@/lib/backend";',
      'import { backendApiForScope, scopeBackendClient } from "@/lib/backend/client";',
      'import { moveTask } from "@/lib/elsewhere";',
      scoped,
      "const api = createKanbanApi(scopeBackendClient(scope));",
      "await api.listTasks();",
      "const done: KanbanStatus = 'done'; isDone(done);",
      "type Lister = typeof listTasks;",
      "const keyed = { listTasks: 1 };",
      "await backendApiForScope(scope, createKanbanApi, { listTasks }).listTasks();",
      "await moveTask('a');",
    ].join("\n");
    expect(found(source)).toEqual([]);
  });

  test("counts only modules that hold per-node state, outside tests", () => {
    const uses = 'import { listTasks } from "@/lib/backend";\nawait listTasks();';
    expect(found(uses)).toEqual([]);
    for (const definition of [
      scoped,
      "export const sync = defineScopedService('sync', () => ({ stop() {} }));",
      "const slot = defineScopedSlot('caps', () => ({}));",
    ])
      expect(found(`${uses}\n${definition}`)).toEqual([[2, "kanban"]]);
    const store = `${uses}\n${scoped}`;
    expect(found(store, "apps/web/src/stores/kanbanStore.test.ts")).toEqual([]);
    expect(found(store, "apps/web/src/stores/kanban-test-support.ts")).toEqual([]);
    expect(found(store, "apps/web/src/test/render-in-node-scope.tsx")).toEqual([]);
    expect(found(store, "apps/web/src/lib/node-scope/thing.ts")).toEqual([]);
  });

  test("keys the baseline per lib/backend file and module", () => {
    const findings = emptyFindings();
    const source = `import { listTasks } from "@/lib/backend";\n${scoped}\nlistTasks();`;
    for (const finding of scanSource({ path: file, source, isBunTest: false }, [guard]))
      (findings[finding.guard][baselineKey(finding)] ??= []).push(finding);
    const key = `[kanban] ${file}`;
    expect(Object.keys(findings["lib-backend-command-default"])).toEqual([key]);
    const { regressions } = compareWithBaseline(findings, baselineFromFindings(emptyFindings()));
    expect(formatRegressions(regressions, ADVICE)).toContain("createXApi(scope.client)");
  });

  test("reads the real shim: every lib/backend factory's named exports, not its factory", () => {
    const resolver = new LibBackendShimResolver(repositoryModules(ROOT));
    expect(resolver.shimOf("apps/web/src/lib/backend", "readFileBase64")).toBe("kanban");
    expect(resolver.shimOf("apps/web/src/lib/backend", "getNativeAgentSyncCapabilities")).toBe(
      "workflows",
    );
    expect(resolver.shimOf("apps/web/src/lib/backend", "machineInvoke")).toBe("agent-accounts");
    expect(resolver.shimOf("apps/web/src/lib/backend/command-nodes", "getNodeStatus")).toBe(
      "command-nodes",
    );
    expect(resolver.shimOf("apps/web/src/lib/backend", "createKanbanApi")).toBeNull();
    // Sent through the desktop host, not a command: not part of the shim.
    expect(resolver.shimOf("apps/web/src/lib/backend", "getWebClientStatus")).toBeNull();
  });
});

describe("regenerating one guard", () => {
  test("--guard selects guards and rejects anything else", () => {
    expect(selectedGuards([])).toBeNull();
    expect(selectedGuards(["--guard", "window-orkestrator-direct"])).toEqual([
      "window-orkestrator-direct",
    ]);
    expect(() => selectedGuards(["--guard", "nope"])).toThrow("--guard takes one of");
    expect(() => selectedGuards(["--all"])).toThrow("Unknown argument");
  });

  test("keeps every other guard's committed entries as they were", () => {
    const committed = baselineFromFindings(emptyFindings());
    committed["small-fake-pid"]["kept.test.ts"] = 2;
    committed["window-orkestrator-direct"]["apps/web/src/old.ts"] = 4;
    const scanned = baselineFromFindings(emptyFindings());
    scanned["small-fake-pid"]["new.test.ts"] = 9;
    scanned["window-orkestrator-direct"]["apps/web/src/App.tsx"] = 1;
    const merged = mergeBaseline(committed, scanned, ["window-orkestrator-direct"]);
    expect(merged["small-fake-pid"]).toEqual({ "kept.test.ts": 2 });
    expect(merged["window-orkestrator-direct"]).toEqual({ "apps/web/src/App.tsx": 1 });
  });
});

describe("the ratchet", () => {
  function findingsOf(entries: Array<[GuardId, string, number[]]>): Findings {
    const findings = emptyFindings();
    for (const [guard, file, found] of entries)
      findings[guard][file] = found.map((line) => ({ guard, file, line }));
    return findings;
  }

  function baselineOf(entries: Array<[GuardId, string, number]>): Baseline {
    const baseline = baselineFromFindings(emptyFindings());
    for (const [guard, file, count] of entries) baseline[guard][file] = count;
    return baseline;
  }

  test("passes when every file is at its baseline", () => {
    const findings = findingsOf([["small-fake-pid", "a.test.ts", [3, 9]]]);
    const result = compareWithBaseline(findings, baselineFromFindings(findings));
    expect(result).toEqual({ regressions: [], stale: [] });
  });

  test("fails on a new file, with each finding's file:line, the advice and the command", () => {
    const findings = findingsOf([["released-port-rebind", "new.test.ts", [12]]]);
    const { regressions, stale } = compareWithBaseline(findings, baselineOf([]));
    expect(stale).toEqual([]);
    expect(regressions.map(({ file, allowed }) => [file, allowed])).toEqual([["new.test.ts", 0]]);
    const message = formatRegressions(regressions, ADVICE);
    expect(message).toContain("new.test.ts:12");
    expect(message).toContain("retryOnAddressInUse");
    expect(message).toContain(REGENERATE_COMMAND);
  });

  test("fails when a file's count rises above its baseline", () => {
    const findings = findingsOf([["sleep-before-negative-assertion", "old.test.ts", [4, 8, 15]]]);
    const baseline = baselineOf([["sleep-before-negative-assertion", "old.test.ts", 2]]);
    const { regressions } = compareWithBaseline(findings, baseline);
    expect(regressions).toHaveLength(1);
    const message = formatRegressions(regressions, ADVICE);
    expect(message).toContain("old.test.ts: 3 finding(s), baseline allows 2");
    expect(message).toContain("installControlledTimeout");
  });

  test("fails on a baseline entry above reality, including a file that no longer offends", () => {
    const findings = findingsOf([["subprocess-without-budget", "kept.test.ts", [1]]]);
    const baseline = baselineOf([
      ["subprocess-without-budget", "kept.test.ts", 1],
      ["small-fake-pid", "fixed.test.ts", 2],
      ["small-fake-pid", "deleted.test.ts", 1],
    ]);
    const { regressions, stale } = compareWithBaseline(findings, baseline);
    expect(regressions).toEqual([]);
    expect(stale.map(({ file, allowed, actual }) => [file, allowed, actual])).toEqual([
      ["deleted.test.ts", 1, 0],
      ["fixed.test.ts", 2, 0],
    ]);
    expect(formatStale(stale)).toContain(REGENERATE_COMMAND);
  });

  test("serializes deterministically: every guard, sorted files, trailing newline", () => {
    const unordered = {
      "small-fake-pid": { "z.test.ts": 1, "a.test.ts": 2 },
      "sleep-before-negative-assertion": { "m.test.ts": 3 },
    } as unknown as Baseline;
    const text = serializeBaseline(unordered);
    expect(Object.keys(JSON.parse(text))).toEqual([...GUARD_IDS]);
    expect(Object.keys(JSON.parse(text)["small-fake-pid"])).toEqual(["a.test.ts", "z.test.ts"]);
    expect(text.endsWith("}\n")).toBe(true);
    expect(serializeBaseline(parseBaseline(text))).toBe(text);
  });

  test("the baseline file exists where the regenerate command writes it", () => {
    expect(existsSync(BASELINE_PATH)).toBe(true);
    expect(path.relative(ROOT, BASELINE_PATH)).toBe("tests/source-guards/baseline.json");
  });
});
