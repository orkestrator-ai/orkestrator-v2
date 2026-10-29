import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import type { StartGraphProjectWatch } from "./graph-project-templates.js";
import {
  GraphTemplateService,
  type GraphTemplateServiceOptions,
} from "./graph-template-service.js";
import { StorageService, createProject } from "./storage.js";

/** A watch the test fires by hand, so re-read tests never wait on the OS. */
export class FakeGraphProjectWatch {
  readonly started: string[] = [];
  closed = 0;
  private listeners = new Map<string, () => void>();

  readonly start: StartGraphProjectWatch = (directory, onEvent) => {
    this.started.push(directory);
    this.listeners.set(directory, onEvent);
    return {
      close: () => {
        this.closed += 1;
        this.listeners.delete(directory);
      },
    };
  };

  /** Fires an event on every open watch. */
  fire(): void {
    for (const listener of this.listeners.values()) listener();
  }

  open(): string[] {
    return [...this.listeners.keys()];
  }
}

export interface GraphTemplateFixture {
  root: string;
  checkout: string;
  storage: StorageService;
  projectId: string;
  watch: FakeGraphProjectWatch;
  service: GraphTemplateService;
  /** Writes `.orkestrator/graphs/<name>` (a template or raw text). */
  writeProjectTemplate(name: string, value: GraphTemplateV1 | string): Promise<string>;
  close(): Promise<void>;
}

export async function createGraphTemplateFixture(
  options: Partial<GraphTemplateServiceOptions> = {},
): Promise<GraphTemplateFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "ork-graph-templates-"));
  const checkout = path.join(root, "checkout");
  await mkdir(checkout, { recursive: true });
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const projectId = (
    await storage.addProject(createProject("https://example.invalid/repo.git", checkout))
  ).id;
  const watch = new FakeGraphProjectWatch();
  const service = new GraphTemplateService({
    storage,
    builtins: () => [],
    host: () => ({ claudeSandbox: true }),
    startWatch: watch.start,
    watchSettleMs: 0,
    ...options,
  });
  return {
    root,
    checkout,
    storage,
    projectId,
    watch,
    service,
    async writeProjectTemplate(name, value) {
      const directory = path.join(checkout, ".orkestrator", "graphs");
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, name);
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
      return file;
    },
    async close() {
      service.shutdown();
      storage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** The report §9.1 example under another id and name (compiles cleanly). */
export function sampleGraphTemplate(
  id = "sample-review",
  overrides: Partial<GraphTemplateV1> = {},
): GraphTemplateV1 {
  return {
    ...graphTemplateExample("multi-review"),
    id,
    name: `Sample ${id}`,
    revision: 0,
    ...overrides,
  };
}

/** The sample with its fixer node asking for `git.push` (D12: always rejected). */
export function pushingGraphTemplate(id = "pushing-review"): GraphTemplateV1 {
  const template = sampleGraphTemplate(id);
  for (const node of template.nodes) {
    if (node.kind === "agent" && node.id === "fix") {
      node.capabilities = { ...node.capabilities, allow: ["git.push"] };
    }
  }
  return template;
}

/** Polls `condition` (each turn of the event loop) until it holds; fails after `timeoutMs`. */
export async function waitForGraphCondition(
  condition: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Collects `graph-template` announcements. */
export function recordGraphTemplateChanges(storage: StorageService): {
  ids: string[];
  stop: () => void;
} {
  const ids: string[] = [];
  const stop = storage.addResourceChangeListener((change) => {
    if (change.resource === "graph-template") ids.push(change.id);
  });
  return { ids, stop: () => void stop() };
}
