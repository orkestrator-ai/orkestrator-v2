import { afterEach, describe, expect, test } from "bun:test";
import type { TabInfo } from "@/types/paneLayout";
import { createTabHistoryProvider, paletteTabTitle, type HistoryResult } from "./history";
import {
  PaletteQueryRunner,
  providerView,
  type PaletteProvider,
  type PaletteProviderState,
} from "./providers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const runners: PaletteQueryRunner<string>[] = [];
afterEach(() => {
  for (const runner of runners.splice(0)) runner.dispose();
});

function runner(provider: PaletteProvider<string>) {
  const states: PaletteProviderState<string>[] = [];
  const instance = new PaletteQueryRunner(provider, (state) => states.push(state));
  runners.push(instance);
  return { instance, states };
}

describe("PaletteQueryRunner", () => {
  test("discards an older query's late answer and aborts its request", async () => {
    const answers = new Map<
      string,
      ReturnType<typeof deferred<{ rows: string[]; partial: boolean }>>
    >();
    const signals = new Map<string, AbortSignal>();
    const { instance, states } = runner({
      search: (query, signal) => {
        const answer = deferred<{ rows: string[]; partial: boolean }>();
        answers.set(query, answer);
        signals.set(query, signal);
        return answer.promise;
      },
    });
    instance.run("pre", "k1");
    await flush();
    instance.run("preview", "k2");
    await flush();
    expect(signals.get("pre")?.aborted).toBe(true);

    answers.get("preview")?.resolve({ rows: ["new"], partial: false });
    await flush();
    // The slow answer for the older query arrives last and is ignored.
    answers.get("pre")?.resolve({ rows: ["old"], partial: false });
    await flush();
    expect(states).toEqual([{ status: "ready", rows: ["new"], generation: 2, key: "k2" }]);
  });

  test("reports failure and partial answers per provider", async () => {
    const failing = runner({
      search: () => {
        throw new Error("synchronous failure");
      },
    });
    failing.instance.run("q", "k");
    await flush();
    expect(failing.states).toEqual([{ status: "failed", rows: [], generation: 1, key: "k" }]);

    const partial = runner({ search: async () => ({ rows: ["a"], partial: true }) });
    partial.instance.run("q", "k");
    await flush();
    expect(partial.states[0]?.status).toBe("partial");
  });

  test("reports nothing after dispose", async () => {
    const answer = deferred<{ rows: string[]; partial: boolean }>();
    const { instance, states } = runner({ search: () => answer.promise });
    instance.run("q", "k");
    instance.dispose();
    answer.resolve({ rows: ["late"], partial: false });
    await flush();
    expect(states).toEqual([]);
  });

  test("a view shows loading until the answer for its own request arrives", () => {
    expect(providerView(null, null).status).toBe("idle");
    expect(providerView(null, "k").status).toBe("loading");
    const answered: PaletteProviderState<string> = {
      status: "ready",
      rows: ["a"],
      generation: 1,
      key: "old",
    };
    expect(providerView(answered, "new")).toEqual({ status: "loading", rows: [] });
    expect(providerView(answered, "old")).toEqual({ status: "ready", rows: ["a"] });
  });
});

describe("tab history provider", () => {
  const tab = (overrides: Partial<TabInfo> & Pick<TabInfo, "id" | "type">): TabInfo =>
    overrides as TabInfo;

  test("titles come from tab chrome only", () => {
    expect(paletteTabTitle(tab({ id: "1", type: "agent-native", displayTitle: "Review" }))).toEqual(
      {
        title: "Review",
        kind: "Agent",
      },
    );
    expect(paletteTabTitle(tab({ id: "2", type: "plain" }))).toEqual({
      title: "Terminal",
      kind: "Terminal",
    });
    expect(
      paletteTabTitle(
        tab({
          id: "3",
          type: "file",
          fileData: { filePath: "src/app.ts" } as TabInfo["fileData"],
        }),
      ).title,
    ).toBe("app.ts");
  });

  test("matches titles and environment names, lists this environment first, and is bounded", async () => {
    const provider = createTabHistoryProvider({
      machine: () => null,
      sources: () => [
        {
          environmentId: "e-1",
          environmentName: "checkout",
          projectId: "p",
          projectName: "orkestrator-v2",
          tabs: [
            tab({ id: "t1", type: "agent-native", displayTitle: "Plan release" }),
            tab({ id: "t2", type: "plain" }),
            tab({ id: "hidden", type: "agent-native", embeddedIn: "canvas" }),
          ],
        },
        {
          environmentId: "e-2",
          environmentName: "release-notes",
          projectId: "p",
          projectName: "orkestrator-v2",
          tabs: Array.from({ length: 10 }, (_, index) =>
            tab({ id: `n${index}`, type: "plain", displayTitle: `release ${index}` }),
          ),
        },
      ],
      scanLimit: 8,
      resultLimit: 5,
    });
    const controller = new AbortController();
    const all = await provider.search("", controller.signal);
    expect(all.rows.map((row: HistoryResult) => row.tabId).slice(0, 2)).toEqual(["t1", "t2"]);
    expect(all.rows).toHaveLength(5);
    expect(all.partial).toBe(true);
    expect(all.rows.some((row) => row.tabId === "hidden")).toBe(false);

    // A title that starts with the word outranks one that only contains it.
    const release = await provider.search("release", controller.signal);
    expect(release.rows[0]?.tabId).toBe("n0");
    const plan = await provider.search("plan", controller.signal);
    expect(plan.rows.map((row) => row.rowId)).toEqual(["history:this:e-1:t1"]);
  });
});
