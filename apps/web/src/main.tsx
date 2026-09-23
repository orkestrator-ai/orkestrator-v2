import "./index.css";
import { bootstrapRenderer } from "./lib/renderer-bootstrap";

// Keep this entry independent of App and its stores. A late preload must be
// ready before modules choose a transport or capture the desktop APIs.
void bootstrapRenderer();
