import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

/** Capture exact bytes and permissions before temporarily redirecting a disposable home. */
export function snapshotFixtureFiles(files: string[]): () => void {
  const snapshots = files.map((file) => ({
    file,
    contents: existsSync(file) ? readFileSync(file) : null,
    mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600,
  }));
  return () => {
    for (const { file, contents, mode } of snapshots) {
      if (contents === null) rmSync(file, { force: true });
      else writeFileSync(file, contents, { mode });
    }
  };
}
