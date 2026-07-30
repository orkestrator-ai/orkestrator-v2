import { loader } from "@monaco-editor/react";

export type MonacoWorkerFactory = new () => Worker;

type MonacoEnvironmentGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, label: string) => Worker;
  };
};

export interface MonacoModuleBundle {
  monaco: typeof import("monaco-editor");
  EditorWorker: MonacoWorkerFactory;
  JsonWorker: MonacoWorkerFactory;
  CssWorker: MonacoWorkerFactory;
  HtmlWorker: MonacoWorkerFactory;
  TypeScriptWorker: MonacoWorkerFactory;
}

interface MonacoConfiguratorOptions {
  initiallyConfigured?: boolean;
  loadModules: () => Promise<MonacoModuleBundle>;
  configureLoader?: (monaco: MonacoModuleBundle["monaco"]) => void;
}

export interface MonacoConfigurator {
  isConfigured: () => boolean;
  ensureConfigured: () => Promise<void>;
}

export function installMonacoModules(
  modules: MonacoModuleBundle,
  configureLoader: (monaco: MonacoModuleBundle["monaco"]) => void,
): void {
  const {
    monaco,
    EditorWorker,
    JsonWorker,
    CssWorker,
    HtmlWorker,
    TypeScriptWorker,
  } = modules;
  const workerFactories: Record<string, MonacoWorkerFactory> = {
    css: CssWorker,
    handlebars: HtmlWorker,
    html: HtmlWorker,
    javascript: TypeScriptWorker,
    json: JsonWorker,
    less: CssWorker,
    razor: HtmlWorker,
    scss: CssWorker,
    typescript: TypeScriptWorker,
  };
  (globalThis as MonacoEnvironmentGlobal).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      const WorkerFactory = workerFactories[label] ?? EditorWorker;
      return new WorkerFactory();
    },
  };
  configureLoader(monaco);
}

export function createMonacoConfigurator({
  initiallyConfigured = false,
  loadModules,
  configureLoader = (monaco) => loader.config({ monaco }),
}: MonacoConfiguratorOptions): MonacoConfigurator {
  let configured = initiallyConfigured;
  let configPromise: Promise<void> | null = null;

  return {
    isConfigured: () => configured,
    async ensureConfigured(): Promise<void> {
      if (configured) return;
      if (!configPromise) {
        const attempt = loadModules().then((modules) => {
          installMonacoModules(modules, configureLoader);
          configured = true;
        });
        configPromise = attempt;
        void attempt.catch(() => {
          if (configPromise === attempt) configPromise = null;
        });
      }
      await configPromise;
    },
  };
}

async function loadMonacoModules(): Promise<MonacoModuleBundle> {
  const [
    monaco,
    { default: EditorWorker },
    { default: JsonWorker },
    { default: CssWorker },
    { default: HtmlWorker },
    { default: TypeScriptWorker },
  ] = await Promise.all([
    import("monaco-editor"),
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    import("monaco-editor/esm/vs/language/json/json.worker?worker"),
    import("monaco-editor/esm/vs/language/css/css.worker?worker"),
    import("monaco-editor/esm/vs/language/html/html.worker?worker"),
    import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
  ]);
  return {
    monaco,
    EditorWorker,
    JsonWorker,
    CssWorker,
    HtmlWorker,
    TypeScriptWorker,
  };
}

const monacoConfigurator = createMonacoConfigurator({
  // Bun's DOM test runner cannot execute Vite's `?worker` imports. Browser
  // integration is covered through createMonacoConfigurator with injected modules.
  initiallyConfigured: typeof Bun !== "undefined",
  loadModules: loadMonacoModules,
});

export function isMonacoConfigured(): boolean {
  return monacoConfigurator.isConfigured();
}

export function ensureMonacoConfigured(): Promise<void> {
  return monacoConfigurator.ensureConfigured();
}
