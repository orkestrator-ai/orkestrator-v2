import { useCallback, useEffect, useRef } from "react";
import Editor, {
  type BeforeMount,
  type OnChange,
  type OnMount,
} from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { useConfigStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";

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

export function MonacoFileEditor({
  language,
  value,
  onChange,
  onSave,
}: MonacoFileEditorProps) {
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const handleEditorWillMount: BeforeMount = useCallback(
    disableMonacoFileDiagnostics,
    [],
  );

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    registerMonacoFileSaveCommand(editor, monaco, () => onSaveRef.current);
  }, []);

  const handleEditorChange: OnChange = useCallback((nextValue) => {
    forwardMonacoFileChange(nextValue, onChange);
  }, [onChange]);

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
      loading={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      }
    />
  );
}
