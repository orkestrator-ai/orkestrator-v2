/**
 * Starts the container safe reader (`buildContainerSafeBase64Reader`, the
 * reader behind `read_container_file_base64`) in `stream` mode inside an
 * environment's container: the same `/workspace` confinement, symbolic-link
 * refusal, size limit and final stability check, with the raw bytes written
 * to stdout as they are read instead of one base64 string.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { CONTAINER_SAFE_BASE64_READER } from "../container-scripts.js";
import { spawnCommand } from "../shell.js";
import type { ContainerReaderSpawner } from "./media-stream.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const spawnDockerMediaReader: ContainerReaderSpawner = ({
  containerId,
  workspacePath,
  maxBytes,
}): ChildProcessWithoutNullStreams =>
  spawnCommand("docker", [
    "exec",
    containerId,
    "bash",
    "-lc",
    `node -e ${shellQuote(CONTAINER_SAFE_BASE64_READER)} -- /workspace ${shellQuote(workspacePath)} ${Math.floor(maxBytes)} stream`,
  ]);
