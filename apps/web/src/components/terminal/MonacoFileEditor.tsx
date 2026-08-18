import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount, type OnChange, type OnMount } from "@monaco-editor/react";
import { AlertCircle, Loader2 } from "lucide-react";
import { useConfigStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import { ensureMonacoConfigured, isMonacoConfigured } from "@/lib/monaco-loader";
import { Button } from "@/components/ui/button";

interface MonacoFileEditorProps {
  language: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void | Promise<unknown>;
}

type MonacoBeforeMountApi = Parameters<BeforeMount>[0];
type MonacoMountedEditor = Parameters<OnMount>[0];
type MonacoMountApi = Parameters<OnMount>[1];

export function disableMonacoFileDiagnostics(monaco: MonacoBeforeMountApi): void {
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: false,
  });
}

export function registerMonacoFileSaveCommand(
  editor: MonacoMountedEditor,
  monaco: MonacoMountApi,
  getOnSave: () => MonacoFileEditorProps["onSave"],
): void {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    void getOnSave()();
  });
}

export function forwardMonacoFileChange(
  nextValue: string | undefined,
  onChange: MonacoFileEditorProps["onChange"],
): void {
  if (nextValue !== undefined) onChange(nextValue);
}

export function MonacoFileEditor({ language, value, onChange, onSave }: MonacoFileEditorProps) {
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const onSaveRef = useRef(onSave);
  const [monacoReady, setMonacoReady] = useState(isMonacoConfigured);
  const [monacoFailed, setMonacoFailed] = useState(false);
  const [monacoAttempt, setMonacoAttempt] = useState(0);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (monacoReady) return;
    let cancelled = false;
    setMonacoFailed(false);
    void ensureMonacoConfigured().then(
      () => {
        if (!cancelled) setMonacoReady(true);
      },
      () => {
        if (!cancelled) setMonacoFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [monacoAttempt, monacoReady]);

  const handleEditorWillMount: BeforeMount = useCallback(disableMonacoFileDiagnostics, []);

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    registerMonacoFileSaveCommand(editor, monaco, () => onSaveRef.current);
  }, []);

  const handleEditorChange: OnChange = useCallback(
    (nextValue) => {
      forwardMonacoFileChange(nextValue, onChange);
    },
    [onChange],
  );

  const loading = (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );

  if (monacoFailed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <AlertCircle className="h-7 w-7 text-red-400" />
        <p className="text-sm text-red-400">Failed to load editor</p>
        <p className="max-w-md text-xs text-muted-foreground">
          The editor resources could not be loaded.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setMonacoAttempt((attempt) => attempt + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (!monacoReady) return loading;

  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="vs-dark"
      beforeMount={handleEditorWillMount}
      onMount={handleEditorMount}
      onChange={handleEditorChange}
      options={{
        lineNumbers: "on",
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        fontSize: terminalAppearance.fontSize,
        fontFamily: `"${terminalAppearance.fontFamily}", "Fira Code", monospace`,
        wordWrap: "on",
        automaticLayout: true,
        renderWhitespace: "selection",
        scrollbar: {
          verticalScrollbarSize: 10,
          horizontalScrollbarSize: 10,
        },
      }}
      loading={loading}
    />
  );
}
