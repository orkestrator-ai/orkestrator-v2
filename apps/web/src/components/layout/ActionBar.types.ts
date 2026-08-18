/** Result of an agent launch that may fail before a tab is created. */
export type ResolveLaunchResult = { ok: true } | { ok: false; message: string | null };
