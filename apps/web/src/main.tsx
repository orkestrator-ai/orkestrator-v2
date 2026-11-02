import "./index.css";
import { installRendererErrorRecorder } from "./lib/bug-report/renderer-errors";
import { applyRendererLogLevel } from "./lib/debug-log";
import { bootstrapRenderer } from "./lib/renderer-bootstrap";

applyRendererLogLevel();

// First, so a bug report started later can include what went wrong at startup.
installRendererErrorRecorder();

// Keep this entry independent of App and its stores. A late preload must be
// ready before modules choose a transport or capture the desktop APIs.
void bootstrapRenderer();
