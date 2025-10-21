import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import webExtension from "vite-plugin-web-extension";
import path from "path";
import { componentTagger } from "lovable-tagger";
import createManifest from "./manifest.config";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    webExtension({
      manifest: () => createManifest({ mode }),
      watchFilePaths: ["manifest.config.ts", "src/extension"],
      additionalInputs: ["src/extension/sidepanel/index.html"],
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
