// Minimal preload for backend, bridge, protocol, CLI, and desktop-script tests.
// Renderer tests use tests/setup.ts, which installs Happy DOM and native mocks.
import "./isolate-git-config";
import { installBoundedConsoleDiagnostics } from "./bounded-console-diagnostics";

process.env.CODEX_BRIDGE_NO_SERVER ??= "1";
installBoundedConsoleDiagnostics();
