import type { FilesApi } from "@/lib/node-scope/domains/files";
import {
  dropBaseName,
  dropParentPath,
  workspacePathInDropTarget,
  type ExternalFolderCopyPlan,
} from "./external-file-drop";

type ImportAction = Parameters<FilesApi["import_external_entry"]>[0]["action"];

export async function executeExternalFolderDrop(
  plan: ExternalFolderCopyPlan,
  looseFiles: readonly File[],
  destination: string,
  mutate: (action: ImportAction) => Promise<string>,
  encodeFile: (file: File) => Promise<string>,
  filePrepared: () => void,
) {
  const completedPaths: string[] = [];
  const remainingPaths = new Set<string>();
  const failures = plan.failures.map(({ message }) => message);
  const cleanupFailures: string[] = [];
  let copiedFiles = 0;
  let copiedFolders = 0;

  const copy = async (directory: string, file: File) => {
    const base64Data = await encodeFile(file);
    const copied = await mutate({ kind: "copy", directory, name: file.name, base64Data });
    if (copied !== workspacePathInDropTarget(directory, file.name)) {
      throw new Error("The workspace returned an unexpected file path");
    }
    filePrepared();
    return copied;
  };

  for (const file of looseFiles) {
    try {
      completedPaths.push(await copy(destination, file));
      copiedFiles += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`Could not copy ${file.name}: ${message}`);
      remainingPaths.add(file.name);
    }
  }

  for (const root of plan.folders.filter((folder) => dropParentPath(folder) === "")) {
    const isInRoot = (relative: string) => relative === root || relative.startsWith(`${root}/`);
    const directories = plan.folders.filter(isInRoot);
    const files = plan.files.filter(({ path }) => isInRoot(path));
    const readFailures = plan.failures.filter(({ name }) => isInRoot(name));
    const remaining = [...directories, ...files.map(({ path }) => path)];
    if (readFailures.length > 0) {
      for (const path of remaining) remainingPaths.add(path);
      for (const { name } of readFailures) remainingPaths.add(name);
      continue;
    }

    let stagingPath: string | undefined;
    let failedPath = root;
    try {
      const staged = await mutate({ kind: "stage", directory: destination, name: root });
      const stagingName = dropBaseName(staged);
      if (
        !stagingName.startsWith(".orkestrator-import-") ||
        staged !== workspacePathInDropTarget(destination, stagingName)
      ) {
        throw new Error("The workspace returned an unexpected temporary folder path");
      }
      stagingPath = staged;
      const stagingDirectory = (relative: string) => staged + relative.slice(root.length);
      for (const folder of directories.slice(1)) {
        failedPath = folder;
        const created = await mutate({
          kind: "mkdir",
          directory: stagingDirectory(dropParentPath(folder)),
          name: dropBaseName(folder),
        });
        if (created !== stagingDirectory(folder)) {
          throw new Error("The workspace returned an unexpected folder path");
        }
      }
      for (const entry of files) {
        failedPath = entry.path;
        await copy(stagingDirectory(entry.directory), entry.file);
      }
      failedPath = root;
      const published = await mutate({ kind: "publish", stagingPath, name: root });
      stagingPath = undefined;
      if (published !== workspacePathInDropTarget(destination, root)) {
        throw new Error("The workspace returned an unexpected folder path");
      }
      for (const path of remaining) {
        completedPaths.push(workspacePathInDropTarget(destination, path));
      }
      copiedFiles += files.length;
      copiedFolders += directories.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`Could not copy ${failedPath}: ${message}`);
      for (const path of remaining) remainingPaths.add(path);
      if (stagingPath !== undefined) {
        try {
          await mutate({ kind: "discard", stagingPath });
        } catch {
          cleanupFailures.push(`Temporary folder could not be removed: ${stagingPath}`);
        }
      }
    }
  }

  return {
    completedPaths,
    remainingPaths: [...remainingPaths],
    failures,
    cleanupFailures,
    copiedFiles,
    copiedFolders,
  };
}
