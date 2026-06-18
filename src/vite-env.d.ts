/// <reference types="vite/client" />

interface Window {
  orkestrator?: {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T = unknown>(event: string, callback: (payload: T) => void): () => void;
    clipboard: {
      readText(): Promise<string>;
      writeText(text: string): Promise<void>;
      readImage(): Promise<{ width: number; height: number; dataUrl: string } | null>;
      writeImage(dataUrl: string): Promise<void>;
    };
    dialog: {
      open(options?: {
        directory?: boolean;
        multiple?: boolean;
        title?: string;
        defaultPath?: string;
      }): Promise<string | string[] | null>;
    };
    process: {
      exit(code?: number): Promise<void>;
    };
    window: {
      startDragging(): Promise<void>;
    };
  };
}
