import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as realMonacoReact from "@monaco-editor/react";

const realMonacoReactSnapshot = { ...realMonacoReact };

interface MockEditorProps {
  height?: string;
  language?: string;
  value?: string;
  theme?: string;
  beforeMount?: (monaco: unknown) => void;
  onMount?: (editor: unknown, monaco: unknown) => void;
  onChange?: (value: string | undefined) => void;
  options?: Record<string, unknown>;
  loading?: unknown;
}

let renderedEditorProps: MockEditorProps | null = null;

mock.module("@monaco-editor/react", () => ({
  ...realMonacoReactSnapshot,
  default: (props: MockEditorProps) => {
    renderedEditorProps = props;
    return (
      <textarea
        aria-label="Mock Monaco editor"
        value={props.value}
        onChange={(event) => props.onChange?.(event.currentTarget.value)}
      />
    );
  },
}));

const {
  MonacoFileEditor,
  disableMonacoFileDiagnostics,
  forwardMonacoFileChange,
  registerMonacoFileSaveCommand,
} = await import("./MonacoFileEditor");

beforeEach(() => {
  renderedEditorProps = null;
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.module("@monaco-editor/react", () => realMonacoReactSnapshot);
});

describe("MonacoFileEditor integration helpers", () => {
  test("disables TypeScript, JavaScript, and JSON diagnostics", () => {
    const setTypeScriptOptions = mock((_options: unknown) => {});
    const setJavaScriptOptions = mock((_options: unknown) => {});
    const setJsonOptions = mock((_options: unknown) => {});
    const monaco = {
      languages: {
        typescript: {
          typescriptDefaults: { setDiagnosticsOptions: setTypeScriptOptions },
          javascriptDefaults: { setDiagnosticsOptions: setJavaScriptOptions },
        },
        json: {
          jsonDefaults: { setDiagnosticsOptions: setJsonOptions },
        },
      },
    };

    disableMonacoFileDiagnostics(monaco as never);

    expect(setTypeScriptOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    expect(setJavaScriptOptions).toHaveBeenCalledWith({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    expect(setJsonOptions).toHaveBeenCalledWith({ validate: false });
  });

  test("registers Cmd/Ctrl+S and calls the latest save callback", () => {
    const firstSave = mock(() => {});
    const latestSave = mock(() => {});
    let onSave = firstSave;
    let command: (() => void) | undefined;
    const addCommand = mock((keybinding: number, callback: () => void) => {
      expect(keybinding).toBe(12);
      command = callback;
      return null;
    });

    registerMonacoFileSaveCommand(
      { addCommand } as never,
      { KeyMod: { CtrlCmd: 4 }, KeyCode: { KeyS: 8 } } as never,
      () => onSave,
    );

    command?.();
    onSave = latestSave;
    command?.();
    expect(firstSave).toHaveBeenCalledTimes(1);
    expect(latestSave).toHaveBeenCalledTimes(1);
  });

  test("forwards defined changes, including an empty file", () => {
    const onChange = mock((_value: string) => {});

    forwardMonacoFileChange(undefined, onChange);
    forwardMonacoFileChange("", onChange);
    forwardMonacoFileChange("updated", onChange);

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenNthCalledWith(1, "");
    expect(onChange).toHaveBeenNthCalledWith(2, "updated");
  });
});

describe("MonacoFileEditor component", () => {
  test("wires editor configuration, diagnostics, changes, and the latest save callback", () => {
    const firstSave = mock(() => {});
    const latestSave = mock(() => {});
    const onChange = mock((_value: string) => {});
    let command: (() => void) | undefined;
    const setDiagnosticsOptions = mock((_options: unknown) => {});
    const monaco = {
      KeyMod: { CtrlCmd: 4 },
      KeyCode: { KeyS: 8 },
      languages: {
        typescript: {
          typescriptDefaults: { setDiagnosticsOptions },
          javascriptDefaults: { setDiagnosticsOptions },
        },
        json: {
          jsonDefaults: { setDiagnosticsOptions },
        },
      },
    };
    const editor = {
      addCommand: mock((_keybinding: number, callback: () => void) => {
        command = callback;
        return null;
      }),
    };

    const view = render(
      <MonacoFileEditor
        language="markdown"
        value="initial"
        onChange={onChange}
        onSave={firstSave}
      />,
    );

    expect(renderedEditorProps?.height).toBe("100%");
    expect(renderedEditorProps?.language).toBe("markdown");
    expect(renderedEditorProps?.theme).toBe("vs-dark");
    expect(renderedEditorProps?.options).toMatchObject({
      lineNumbers: "on",
      wordWrap: "on",
      automaticLayout: true,
    });
    expect(renderedEditorProps?.loading).toBeTruthy();

    renderedEditorProps?.beforeMount?.(monaco);
    renderedEditorProps?.onMount?.(editor, monaco);
    expect(setDiagnosticsOptions).toHaveBeenCalledTimes(3);

    fireEvent.change(screen.getByRole("textbox", { name: "Mock Monaco editor" }), {
      target: { value: "updated" },
    });
    expect(onChange).toHaveBeenCalledWith("updated");

    command?.();
    expect(firstSave).toHaveBeenCalledTimes(1);

    view.rerender(
      <MonacoFileEditor
        language="markdown"
        value="updated"
        onChange={onChange}
        onSave={latestSave}
      />,
    );
    command?.();
    expect(firstSave).toHaveBeenCalledTimes(1);
    expect(latestSave).toHaveBeenCalledTimes(1);
  });
});
