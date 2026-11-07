import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, type BrowserContext, type Request } from "@playwright/test";

/**
 * Plan item 2010's runtime check: during a browser suite run, which path every
 * renderer invoke and listen took. Opt-in: with
 * `ORKESTRATOR_AGENT_TEST_OBSERVE_INVOKES=<directory>` set, every context the
 * browser suite routes (`browser-test.ts`) gets an init script that wraps
 * `window.orkestrator.invoke` and `.listen` in place as the gateway API is
 * installed (an accessor on `window`, so the API object keeps its identity),
 * and reports, per call, the command or event name (never arguments or
 * payloads) and the first page-module frame on the call's stack. In a Vite dev
 * renderer that frame is the source module that called the global:
 * `lib/node-scope/command-client.ts` is the command scope's client; no
 * page-module frame at all is a spec's own `page.evaluate`; anything else is a
 * direct global call from that module. The context also counts the
 * `/__orkestrator/invoke` requests that left the page, by command name, so a
 * command that reached the wire without passing the global (a transport built
 * on the side, a raw fetch) shows as wire-only. Each context writes one JSON
 * file into the directory when it closes; `summarizeInvokeObservations` reads
 * them back. Nothing is observed when the variable is unset.
 */
export const INVOKE_OBSERVER_ENV = "ORKESTRATOR_AGENT_TEST_OBSERVE_INVOKES";

export const INVOKE_OBSERVER_BINDING = "__orkestratorInvokeObserver";
const CLIENT_MODULE = "/lib/node-scope/command-client.ts";
const INVOKE_PATH = "/__orkestrator/invoke";

export type InvokePath = "client" | "harness" | "direct";

export interface ObservedCall {
  readonly kind: "invoke" | "listen";
  readonly name: string;
  readonly path: InvokePath;
  /** The calling module's pathname for a `direct` call. */
  readonly module?: string;
  readonly count: number;
}

export interface ObservationFile {
  readonly test: string;
  readonly calls: readonly ObservedCall[];
  /** `/__orkestrator/invoke` requests by command name; `base` is the path before it. */
  readonly wire: readonly {
    readonly name: string;
    readonly base: string;
    readonly count: number;
  }[];
}

/** Runs in the page: wraps the API's invoke and listen when it is assigned. */
export function observerInitScript(binding: string): void {
  const report = (kind: string, name: unknown) => {
    const lines = (new Error().stack ?? "").split("\n").slice(1);
    const frame = lines.find((line) => /https?:\/\//u.test(line)) ?? "";
    const send = (window as unknown as Record<string, unknown>)[binding];
    if (typeof send === "function") {
      void (send as (record: unknown) => Promise<void>)({
        kind,
        name: typeof name === "string" ? name : String(name),
        frame,
      }).catch(() => undefined);
    }
  };
  const patched = new WeakSet<object>();
  const patch = (api: unknown) => {
    if (!api || typeof api !== "object" || patched.has(api)) return;
    patched.add(api);
    const target = api as Record<string, unknown>;
    for (const kind of ["invoke", "listen"] as const) {
      const original = target[kind];
      if (typeof original !== "function") continue;
      try {
        target[kind] = function observed(this: unknown, name: unknown, ...rest: unknown[]) {
          report(kind, name);
          return (original as (...args: unknown[]) => unknown).call(this, name, ...rest);
        };
      } catch {
        // A frozen API (not the browser gateway's) stays unobserved.
      }
    }
  };
  let current: unknown = (window as unknown as Record<string, unknown>).orkestrator;
  patch(current);
  Object.defineProperty(window, "orkestrator", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value: unknown) => {
      patch(value);
      current = value;
    },
  });
}

/**
 * Which path a call took, from the first stack line naming an http(s) module
 * (V8's `at fn (url:line:col)` or `at url:line:col`).
 */
export function classifyCaller(frame: string): { path: InvokePath; module?: string } {
  const url = /(https?:\/\/[^\s)]+?)(?::\d+){1,2}\)?\s*$/u.exec(frame.trim())?.[1];
  if (!url || !URL.canParse(url)) return { path: "harness" };
  const pathname = new URL(url).pathname;
  if (pathname.endsWith(CLIENT_MODULE)) return { path: "client" };
  return { path: "direct", module: pathname };
}

/** Event names without the ids some carry (`terminal-output-<session>`). */
export function normalizeEventName(name: string): string {
  return name
    .replace(/^terminal-output-.+$/u, "terminal-output-*")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, "<id>");
}

/** The command name of an invoke request, or `undefined` when it is not one. */
export function wireInvoke(
  request: Pick<Request, "method" | "url" | "postData">,
): { name: string; base: string } | undefined {
  if (request.method() !== "POST" || !URL.canParse(request.url())) return undefined;
  const { pathname } = new URL(request.url());
  if (!pathname.endsWith(INVOKE_PATH)) return undefined;
  try {
    const body = JSON.parse(request.postData() ?? "") as { command?: unknown };
    if (typeof body.command !== "string") return undefined;
    return { name: body.command, base: pathname.slice(0, -INVOKE_PATH.length) };
  } catch {
    return undefined;
  }
}

const observed = new WeakSet<BrowserContext>();
let contextsObserved = 0;

function currentTestName(): string {
  try {
    const info = test.info();
    return `${path.basename(info.file)} › ${info.titlePath.slice(1).join(" › ")} (retry ${info.retry})`;
  } catch {
    return "outside a test";
  }
}

/** Observes `context` when the opt-in is set; once per context. */
export async function observeCommandInvokes(
  context: BrowserContext,
  directory: string | undefined = process.env[INVOKE_OBSERVER_ENV],
): Promise<void> {
  if (!directory || observed.has(context)) return;
  observed.add(context);
  const name = currentTestName();
  const file = path.join(directory, `${process.pid}-${(contextsObserved += 1)}.json`);
  const calls = new Map<string, ObservedCall>();
  const wire = new Map<string, { name: string; base: string; count: number }>();
  await context.exposeBinding(INVOKE_OBSERVER_BINDING, (_source, record: unknown) => {
    if (!record || typeof record !== "object") return;
    const { kind, name: raw, frame } = record as Record<string, unknown>;
    if ((kind !== "invoke" && kind !== "listen") || typeof raw !== "string") return;
    const callName = kind === "listen" ? normalizeEventName(raw) : raw;
    const caller = classifyCaller(typeof frame === "string" ? frame : "");
    const key = `${kind}\u0000${callName}\u0000${caller.path}\u0000${caller.module ?? ""}`;
    const previous = calls.get(key);
    calls.set(key, { kind, name: callName, ...caller, count: (previous?.count ?? 0) + 1 });
  });
  context.on("request", (request) => {
    const invoke = wireInvoke(request);
    if (!invoke) return;
    const key = `${invoke.base}\u0000${invoke.name}`;
    wire.set(key, { ...invoke, count: (wire.get(key)?.count ?? 0) + 1 });
  });
  context.on("close", () => {
    const observation: ObservationFile = {
      test: name,
      calls: [...calls.values()],
      wire: [...wire.values()],
    };
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, `${JSON.stringify(observation, null, 2)}\n`);
  });
  await context.addInitScript(observerInitScript, INVOKE_OBSERVER_BINDING);
}

export interface InvokeObservationSummary {
  readonly contexts: number;
  readonly totals: Record<`${"invoke" | "listen"}:${InvokePath}`, number>;
  /** Command and event names called through the client. */
  readonly clientNames: { readonly invoke: number; readonly listen: number };
  /** Every direct global call: the test, the name and the calling module. */
  readonly direct: readonly (ObservedCall & { readonly test: string })[];
  /** Wire commands a context sent that never passed `window.orkestrator.invoke` in it. */
  readonly wireOnly: readonly {
    readonly test: string;
    readonly name: string;
    readonly base: string;
  }[];
  readonly wireTotal: number;
}

export function summarizeObservations(files: readonly ObservationFile[]): InvokeObservationSummary {
  const totals = {
    "invoke:client": 0,
    "invoke:harness": 0,
    "invoke:direct": 0,
    "listen:client": 0,
    "listen:harness": 0,
    "listen:direct": 0,
  } as InvokeObservationSummary["totals"];
  const names = { invoke: new Set<string>(), listen: new Set<string>() };
  const direct: (ObservedCall & { test: string })[] = [];
  const wireOnly: { test: string; name: string; base: string }[] = [];
  let wireTotal = 0;
  for (const file of files) {
    const invoked = new Set<string>();
    for (const call of file.calls) {
      totals[`${call.kind}:${call.path}`] += call.count;
      if (call.path === "client") names[call.kind].add(call.name);
      if (call.path === "direct") direct.push({ ...call, test: file.test });
      if (call.kind === "invoke") invoked.add(call.name);
    }
    for (const entry of file.wire) {
      wireTotal += entry.count;
      if (!invoked.has(entry.name)) {
        wireOnly.push({ test: file.test, name: entry.name, base: entry.base });
      }
    }
  }
  return {
    contexts: files.length,
    totals,
    clientNames: { invoke: names.invoke.size, listen: names.listen.size },
    direct,
    wireOnly,
    wireTotal,
  };
}

export function readObservations(directory: string): ObservationFile[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .map(
      (entry) => JSON.parse(readFileSync(path.join(directory, entry), "utf8")) as ObservationFile,
    );
}
