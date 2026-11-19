import { useEffect, useRef, useState } from "react";
import { DiffEditor, type DiffOnMount } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";
import { useConfigStore } from "@/stores";
import { DEFAULT_TERMINAL_APPEARANCE } from "@/constants/terminal";
import { ensureMonacoConfigured, isMonacoConfigured } from "@/lib/monaco-loader";
import { configureMonacoFileEditor } from "./MonacoFileEditor";

interface FileConflictDiffProps {
  language: string;
  /** The newer version on disk (left, read-only). */
  disk: string;
  /** The unsaved buffer (right, editable, so the user can merge into it). */
  mine: string;
  onChange: (value: string) => void;
  /** Ctrl/Cmd+S uses the ordinary checked save. */
  onSave: () => void;
}

type MonacoDiffEditor = Parameters<DiffOnMount>[0];

/** Side-by-side comparison of a save conflict. */
export function FileConflictDiff({
  language,
  disk,
  mine,
  onChange,
  onSave,
}: FileConflictDiffProps) {
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ||
    DEFAULT_TERMINAL_APPEARANCE;
  const [monacoReady, setMonacoReady] = useState(isMonacoConfigured);
  const [monacoFailed, setMonacoFailed] = useState(false);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const disposeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
  });

  useEffect(() => {
    if (monacoReady) return;
    let cancelled = false;
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
  }, [monacoReady]);

  useEffect(
    () => () => {
      disposeRef.current?.();
      disposeRef.current = null;
    },
    [],
  );

  const handleMount: DiffOnMount = (editor: MonacoDiffEditor, monaco) => {
    const modified = editor.getModifiedEditor();
    const subscription = modified.onDidChangeModelContent(() => {
      onChangeRef.current(modified.getValue());
    });
    modified.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSaveRef.current();
    });
    disposeRef.current?.();
    disposeRef.current = () => subscription.dispose();
  };

  const loading = (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid grid-cols-2 border-b border-border bg-background text-xs text-muted-foreground">
        <span className="truncate px-4 py-1.5">On disk (newer, read-only)</span>
        <span className="truncate border-l border-border px-4 py-1.5">Your edits (unsaved)</span>
      </div>
      <div className="min-h-0 flex-1">
        {monacoFailed ? (
          <p className="p-4 text-sm text-failure">The comparison view could not be loaded.</p>
        ) : !monacoReady ? (
          loading
        ) : (
          <DiffEditor
            height="100%"
            language={language}
            original={disk}
            modified={mine}
            theme="vs-dark"
            beforeMount={configureMonacoFileEditor}
            onMount={handleMount}
            loading={loading}
            options={{
              originalEditable: false,
              readOnly: false,
              renderSideBySide: true,
              ignoreTrimWhitespace: false,
              useInlineViewWhenSpaceIsLimited: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize: terminalAppearance.fontSize,
              fontFamily: `"${terminalAppearance.fontFamily}", "Fira Code", monospace`,
              wordWrap: "on",
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
