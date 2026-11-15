import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { staticHtmlFramePlugin } from "../web/vite-plugin-renderer-security";

export default defineConfig({
  // Emits `static-html-frame.html`, which `vercel.json` serves under its own
  // sandboxed header rule rather than the strict `/(.*)` policy; see
  // `staticHtmlPresentationSupported` for how a build would opt out.
  plugins: [react(), tailwindcss(), staticHtmlFramePlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../web/src"),
      "~": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    fs: {
      allow: [path.resolve(import.meta.dirname, "../..")],
    },
  },
});
