import path from "node:path";

export function resolveRendererIndexPath(appPath: string): string {
  return path.join(appPath, "dist", "index.html");
}

export function resolveRuntimeRoots(options: {
  isDev: boolean;
  dirname: string;
  appPath: string;
  resourcesPath: string;
}): { appRoot: string; resourceRoot: string } {
  if (!options.isDev) {
    return {
      appRoot: options.appPath,
      resourceRoot: options.resourcesPath,
    };
  }

  const appRoot = path.resolve(options.dirname, "..", "..", "..", "..");
  return {
    appRoot,
    resourceRoot: appRoot,
  };
}
