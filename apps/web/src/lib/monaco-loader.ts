import { loader } from "@monaco-editor/react";

let monacoConfigured = typeof Bun !== "undefined";
let monacoConfigPromise: Promise<void> | null = null;

type MonacoWorkerFactory = new () => Worker;

type MonacoEnvironmentGlobal = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker: (_workerId: string, label: string) => Worker;
  };
};

export function isMonacoConfigured(): boolean {
  return monacoConfigured;
}

export async function ensureMonacoConfigured(): Promise<void> {
  if (monacoConfigured) return;
  monacoConfigPromise ??= (async () => {
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

    const workerFactories: Record<string, MonacoWorkerFactory> = {
      css: CssWorker,
      html: HtmlWorker,
      javascript: TypeScriptWorker,
      json: JsonWorker,
      scss: CssWorker,
      less: CssWorker,
      typescript: TypeScriptWorker,
    };
    (globalThis as MonacoEnvironmentGlobal).MonacoEnvironment = {
      getWorker(_workerId: string, label: string): Worker {
        const WorkerFactory = workerFactories[label] ?? EditorWorker;
        return new WorkerFactory();
      },
    };
    loader.config({ monaco });
    monacoConfigured = true;
  })();
  await monacoConfigPromise;
}
