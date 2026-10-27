export const XDG_KEYS = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
] as const;

/** Force HOME-based fixture paths and restore both present and absent overrides. */
export function isolateXdgEnvironment(env: NodeJS.ProcessEnv = process.env): () => void {
  const original = XDG_KEYS.map((key) => [key, env[key]] as const);
  for (const key of XDG_KEYS) delete env[key];
  return () => {
    for (const [key, value] of original) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}
