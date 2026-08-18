import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createMonacoConfigurator,
  installMonacoModules,
  type MonacoModuleBundle,
  type MonacoWorkerFactory,
} from "./monaco-loader";

type WorkerWithKind = Worker & { kind: string };

const originalMonacoEnvironment = (
  globalThis as typeof globalThis & { MonacoEnvironment?: unknown }
).MonacoEnvironment;

function workerFactory(kind: string): MonacoWorkerFactory {
  return class {
    kind = kind;
  } as unknown as MonacoWorkerFactory;
}

function moduleBundle(): MonacoModuleBundle {
  return {
    monaco: { marker: "local-monaco" } as unknown as MonacoModuleBundle["monaco"],
    EditorWorker: workerFactory("editor"),
    JsonWorker: workerFactory("json"),
    CssWorker: workerFactory("css"),
    HtmlWorker: workerFactory("html"),
    TypeScriptWorker: workerFactory("typescript"),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  (globalThis as typeof globalThis & { MonacoEnvironment?: unknown }).MonacoEnvironment =
    originalMonacoEnvironment;
});

describe("createMonacoConfigurator", () => {
  test("configures a browser loader once and deduplicates concurrent callers", async () => {
    const pendingModules = deferred<MonacoModuleBundle>();
    const loadModules = mock(() => pendingModules.promise);
    const configureLoader = mock((_monaco: MonacoModuleBundle["monaco"]) => {});
    const configurator = createMonacoConfigurator({
      initiallyConfigured: false,
      loadModules,
      configureLoader,
    });

    const first = configurator.ensureConfigured();
    const second = configurator.ensureConfigured();
    expect(loadModules).toHaveBeenCalledTimes(1);
    expect(configurator.isConfigured()).toBe(false);

    const modules = moduleBundle();
    pendingModules.resolve(modules);
    await Promise.all([first, second]);

    expect(configureLoader).toHaveBeenCalledTimes(1);
    expect(configureLoader).toHaveBeenCalledWith(modules.monaco);
    expect(configurator.isConfigured()).toBe(true);
    await configurator.ensureConfigured();
    expect(loadModules).toHaveBeenCalledTimes(1);
  });

  test("clears a rejected attempt so a later call can retry", async () => {
    const loadFailure = new Error("worker chunk unavailable");
    const loadModules = mock(async () => {
      if (loadModules.mock.calls.length === 1) throw loadFailure;
      return moduleBundle();
    });
    const configureLoader = mock((_monaco: MonacoModuleBundle["monaco"]) => {});
    const configurator = createMonacoConfigurator({
      loadModules,
      configureLoader,
    });

    await expect(configurator.ensureConfigured()).rejects.toBe(loadFailure);
    expect(configurator.isConfigured()).toBe(false);

    await configurator.ensureConfigured();
    expect(loadModules).toHaveBeenCalledTimes(2);
    expect(configureLoader).toHaveBeenCalledTimes(1);
    expect(configurator.isConfigured()).toBe(true);
  });

  test("does not load browser modules in an already configured test runtime", async () => {
    const loadModules = mock(async () => moduleBundle());
    const configurator = createMonacoConfigurator({
      initiallyConfigured: true,
      loadModules,
    });

    await configurator.ensureConfigured();

    expect(loadModules).not.toHaveBeenCalled();
    expect(configurator.isConfigured()).toBe(true);
  });
});

describe("installMonacoModules", () => {
  test("routes language labels to their matching worker factories", () => {
    const modules = moduleBundle();
    const configureLoader = mock((_monaco: MonacoModuleBundle["monaco"]) => {});

    installMonacoModules(modules, configureLoader);

    const getWorker = (
      globalThis as typeof globalThis & {
        MonacoEnvironment: {
          getWorker: (_workerId: string, label: string) => Worker;
        };
      }
    ).MonacoEnvironment.getWorker as (_workerId: string, label: string) => WorkerWithKind;
    for (const label of ["css", "less", "scss"]) {
      expect(getWorker("", label).kind).toBe("css");
    }
    for (const label of ["html", "handlebars", "razor"]) {
      expect(getWorker("", label).kind).toBe("html");
    }
    for (const label of ["javascript", "typescript"]) {
      expect(getWorker("", label).kind).toBe("typescript");
    }
    expect(getWorker("", "json").kind).toBe("json");
    expect(getWorker("", "plaintext").kind).toBe("editor");
    expect(configureLoader).toHaveBeenCalledWith(modules.monaco);
  });
});
