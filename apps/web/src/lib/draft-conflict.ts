export interface DraftRevisionState {
  revision: number;
  conflictRevision: number | null;
}

export function createDraftRevisionState(): DraftRevisionState {
  return {
    revision: 0,
    conflictRevision: null,
  };
}

export class DraftRevisionConflictError extends Error {
  constructor(
    readonly draftKey: string,
    readonly currentRevision: number,
    options: { cause?: unknown } = {},
  ) {
    super(
      "This draft changed in another window. Your local input has been preserved.",
      options,
    );
    this.name = "DraftRevisionConflictError";
  }
}

export function isDraftRevisionConflict(error: unknown): boolean {
  return error instanceof DraftRevisionConflictError
    || (
      error instanceof Error
      && error.message.toLowerCase().includes("revision conflict")
    );
}
