/**
 * Shared mock functions for @/hooks/useClipboardImagePaste.
 *
 * NOT registered in tests/setup.ts because useClipboardImagePaste.test.ts
 * needs the real module.  Tests that need these mocked (e.g. terminal-paste)
 * call mock.module() per-file, referencing these shared instances.
 */
import { mock } from "bun:test";

export const mockProcessClipboardPaste = mock(async (
  _containerId: string,
  _onImageSaved?: (filePath: string) => void | Promise<void>,
  _onTextPaste?: (text: string) => void | Promise<void>,
  _onError?: (error: string) => void,
) => false as boolean);

export const mockProcessLocalClipboardPaste = mock(async (
  _worktreePath: string,
  _onImageSaved?: (filePath: string) => void | Promise<void>,
  _onTextPaste?: (text: string) => void | Promise<void>,
  _onError?: (error: string) => void,
) => false as boolean);
