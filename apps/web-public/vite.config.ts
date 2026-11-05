import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // `vercel.json`'s policy cannot run the static document frame; see
    // `staticHtmlPresentationSupported`.
    "import.meta.env.ORKESTRATOR_STATIC_HTML_PRESENTATION": JSON.stringify("unavailable"),
  },
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
