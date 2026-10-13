import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.VITE_DEV_HOST;
const configuredPort = Number.parseInt(process.env.VITE_DEV_PORT ?? "1420", 10);
const port =
  Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
  // Use relative asset paths so the packaged app can load assets over file://
  base: "./",

  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },

  clearScreen: false,
  server: {
    port,
    strictPort: true,
    host: host || "127.0.0.1",
    ws: host
      ? {
          protocol: "ws",
          host,
          port,
        }
      : undefined,
    watch: {
      ignored: ["**/apps/desktop/dist/**"],
    },
  },
}));
