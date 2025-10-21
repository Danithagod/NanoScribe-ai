// vite.config.ts
import { defineConfig } from "file:///C:/Users/user/vs-projects/nano-scribe-ai/node_modules/vite/dist/node/index.js";
import react from "file:///C:/Users/user/vs-projects/nano-scribe-ai/node_modules/@vitejs/plugin-react-swc/index.js";
import webExtension from "file:///C:/Users/user/vs-projects/nano-scribe-ai/node_modules/vite-plugin-web-extension/dist/index.js";
import path from "path";
import { componentTagger } from "file:///C:/Users/user/vs-projects/nano-scribe-ai/node_modules/lovable-tagger/dist/index.js";

// manifest.config.ts
import { readFileSync } from "fs";
var __vite_injected_original_import_meta_url = "file:///C:/Users/user/vs-projects/nano-scribe-ai/manifest.config.ts";
var packageJson = JSON.parse(readFileSync(new URL("./package.json", __vite_injected_original_import_meta_url), { encoding: "utf-8" }));
var originTrialTokens = (() => {
  const token = process.env.NANOSCRIBE_ORIGIN_TRIAL_TOKEN;
  if (!token) return [];
  return token.split(",").map((entry) => entry.trim()).filter(Boolean);
})();
function createManifest({ mode }) {
  const isDev = mode === "development";
  return {
    manifest_version: 3,
    name: isDev ? "NanoScribe (Dev)" : "NanoScribe",
    description: "Private, offline-first writing assistant with semantic recall and contextual completions.",
    version: packageJson.version ?? "0.0.0",
    action: {
      default_title: "NanoScribe"
    },
    background: {
      service_worker: "src/extension/service-worker.ts",
      type: "module"
    },
    permissions: ["storage", "tabs", "scripting", "alarms", "sidePanel", "aiLanguageModel", "aiSummarizer"],
    host_permissions: ["<all_urls>"],
    side_panel: {
      default_path: "src/extension/sidepanel/index.html"
    },
    ...originTrialTokens.length > 0 ? { trial_tokens: originTrialTokens } : {},
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["src/extension/content-script.tsx"],
        run_at: "document_idle",
        match_about_blank: false
      }
    ]
  };
}

// vite.config.ts
var __vite_injected_original_dirname = "C:\\Users\\user\\vs-projects\\nano-scribe-ai";
var vite_config_default = defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    webExtension({
      manifest: () => createManifest({ mode }),
      watchFilePaths: ["manifest.config.ts", "src/extension"],
      additionalInputs: ["src/extension/sidepanel/index.html"]
    })
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "./src")
    }
  }
}));
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiLCAibWFuaWZlc3QuY29uZmlnLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFx2cy1wcm9qZWN0c1xcXFxuYW5vLXNjcmliZS1haVwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFx2cy1wcm9qZWN0c1xcXFxuYW5vLXNjcmliZS1haVxcXFx2aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vQzovVXNlcnMvdXNlci92cy1wcm9qZWN0cy9uYW5vLXNjcmliZS1haS92aXRlLmNvbmZpZy50c1wiO2ltcG9ydCB7IGRlZmluZUNvbmZpZyB9IGZyb20gXCJ2aXRlXCI7XG5pbXBvcnQgcmVhY3QgZnJvbSBcIkB2aXRlanMvcGx1Z2luLXJlYWN0LXN3Y1wiO1xuaW1wb3J0IHdlYkV4dGVuc2lvbiBmcm9tIFwidml0ZS1wbHVnaW4td2ViLWV4dGVuc2lvblwiO1xuaW1wb3J0IHBhdGggZnJvbSBcInBhdGhcIjtcbmltcG9ydCB7IGNvbXBvbmVudFRhZ2dlciB9IGZyb20gXCJsb3ZhYmxlLXRhZ2dlclwiO1xuaW1wb3J0IGNyZWF0ZU1hbmlmZXN0IGZyb20gXCIuL21hbmlmZXN0LmNvbmZpZ1wiO1xuXG4vLyBodHRwczovL3ZpdGVqcy5kZXYvY29uZmlnL1xuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKCh7IG1vZGUgfSkgPT4gKHtcbiAgc2VydmVyOiB7XG4gICAgaG9zdDogXCI6OlwiLFxuICAgIHBvcnQ6IDgwODAsXG4gIH0sXG4gIHBsdWdpbnM6IFtcbiAgICByZWFjdCgpLFxuICAgIG1vZGUgPT09IFwiZGV2ZWxvcG1lbnRcIiAmJiBjb21wb25lbnRUYWdnZXIoKSxcbiAgICB3ZWJFeHRlbnNpb24oe1xuICAgICAgbWFuaWZlc3Q6ICgpID0+IGNyZWF0ZU1hbmlmZXN0KHsgbW9kZSB9KSxcbiAgICAgIHdhdGNoRmlsZVBhdGhzOiBbXCJtYW5pZmVzdC5jb25maWcudHNcIiwgXCJzcmMvZXh0ZW5zaW9uXCJdLFxuICAgICAgYWRkaXRpb25hbElucHV0czogW1wic3JjL2V4dGVuc2lvbi9zaWRlcGFuZWwvaW5kZXguaHRtbFwiXSxcbiAgICB9KSxcbiAgXS5maWx0ZXIoQm9vbGVhbiksXG4gIHJlc29sdmU6IHtcbiAgICBhbGlhczoge1xuICAgICAgXCJAXCI6IHBhdGgucmVzb2x2ZShfX2Rpcm5hbWUsIFwiLi9zcmNcIiksXG4gICAgfSxcbiAgfSxcbn0pKTtcbiIsICJjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZGlybmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFx2cy1wcm9qZWN0c1xcXFxuYW5vLXNjcmliZS1haVwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcdXNlclxcXFx2cy1wcm9qZWN0c1xcXFxuYW5vLXNjcmliZS1haVxcXFxtYW5pZmVzdC5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0M6L1VzZXJzL3VzZXIvdnMtcHJvamVjdHMvbmFuby1zY3JpYmUtYWkvbWFuaWZlc3QuY29uZmlnLnRzXCI7aW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSBcImZzXCI7XG5cbmNvbnN0IHBhY2thZ2VKc29uID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMobmV3IFVSTChcIi4vcGFja2FnZS5qc29uXCIsIGltcG9ydC5tZXRhLnVybCksIHsgZW5jb2Rpbmc6IFwidXRmLThcIiB9KSkgYXMge1xuICB2ZXJzaW9uPzogc3RyaW5nO1xufTtcblxuY29uc3Qgb3JpZ2luVHJpYWxUb2tlbnMgPSAoKCkgPT4ge1xuICBjb25zdCB0b2tlbiA9IHByb2Nlc3MuZW52Lk5BTk9TQ1JJQkVfT1JJR0lOX1RSSUFMX1RPS0VOO1xuICBpZiAoIXRva2VuKSByZXR1cm4gW10gYXMgc3RyaW5nW107XG4gIHJldHVybiB0b2tlblxuICAgIC5zcGxpdChcIixcIilcbiAgICAubWFwKChlbnRyeSkgPT4gZW50cnkudHJpbSgpKVxuICAgIC5maWx0ZXIoQm9vbGVhbik7XG59KSgpO1xuXG50eXBlIE1hbmlmZXN0RmFjdG9yeU9wdGlvbnMgPSB7XG4gIG1vZGU6IHN0cmluZztcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGZ1bmN0aW9uIGNyZWF0ZU1hbmlmZXN0KHsgbW9kZSB9OiBNYW5pZmVzdEZhY3RvcnlPcHRpb25zKSB7XG4gIGNvbnN0IGlzRGV2ID0gbW9kZSA9PT0gXCJkZXZlbG9wbWVudFwiO1xuXG4gIHJldHVybiB7XG4gICAgbWFuaWZlc3RfdmVyc2lvbjogMyxcbiAgICBuYW1lOiBpc0RldiA/IFwiTmFub1NjcmliZSAoRGV2KVwiIDogXCJOYW5vU2NyaWJlXCIsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlByaXZhdGUsIG9mZmxpbmUtZmlyc3Qgd3JpdGluZyBhc3Npc3RhbnQgd2l0aCBzZW1hbnRpYyByZWNhbGwgYW5kIGNvbnRleHR1YWwgY29tcGxldGlvbnMuXCIsXG4gICAgdmVyc2lvbjogcGFja2FnZUpzb24udmVyc2lvbiA/PyBcIjAuMC4wXCIsXG4gICAgYWN0aW9uOiB7XG4gICAgICBkZWZhdWx0X3RpdGxlOiBcIk5hbm9TY3JpYmVcIixcbiAgICB9LFxuICAgIGJhY2tncm91bmQ6IHtcbiAgICAgIHNlcnZpY2Vfd29ya2VyOiBcInNyYy9leHRlbnNpb24vc2VydmljZS13b3JrZXIudHNcIixcbiAgICAgIHR5cGU6IFwibW9kdWxlXCIsXG4gICAgfSxcbiAgICBwZXJtaXNzaW9uczogW1wic3RvcmFnZVwiLCBcInRhYnNcIiwgXCJzY3JpcHRpbmdcIiwgXCJhbGFybXNcIiwgXCJzaWRlUGFuZWxcIiwgXCJhaUxhbmd1YWdlTW9kZWxcIiwgXCJhaVN1bW1hcml6ZXJcIl0sXG4gICAgaG9zdF9wZXJtaXNzaW9uczogW1wiPGFsbF91cmxzPlwiXSxcbiAgICBzaWRlX3BhbmVsOiB7XG4gICAgICBkZWZhdWx0X3BhdGg6IFwic3JjL2V4dGVuc2lvbi9zaWRlcGFuZWwvaW5kZXguaHRtbFwiLFxuICAgIH0sXG4gICAgLi4uKG9yaWdpblRyaWFsVG9rZW5zLmxlbmd0aCA+IDAgPyB7IHRyaWFsX3Rva2Vuczogb3JpZ2luVHJpYWxUb2tlbnMgfSA6IHt9KSxcbiAgICBjb250ZW50X3NjcmlwdHM6IFtcbiAgICAgIHtcbiAgICAgICAgbWF0Y2hlczogW1wiPGFsbF91cmxzPlwiXSxcbiAgICAgICAganM6IFtcInNyYy9leHRlbnNpb24vY29udGVudC1zY3JpcHQudHN4XCJdLFxuICAgICAgICBydW5fYXQ6IFwiZG9jdW1lbnRfaWRsZVwiLFxuICAgICAgICBtYXRjaF9hYm91dF9ibGFuazogZmFsc2UsXG4gICAgICB9LFxuICAgIF0sXG4gIH07XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBQW9ULFNBQVMsb0JBQW9CO0FBQ2pWLE9BQU8sV0FBVztBQUNsQixPQUFPLGtCQUFrQjtBQUN6QixPQUFPLFVBQVU7QUFDakIsU0FBUyx1QkFBdUI7OztBQ0o0UixTQUFTLG9CQUFvQjtBQUFwSixJQUFNLDJDQUEyQztBQUV0UCxJQUFNLGNBQWMsS0FBSyxNQUFNLGFBQWEsSUFBSSxJQUFJLGtCQUFrQix3Q0FBZSxHQUFHLEVBQUUsVUFBVSxRQUFRLENBQUMsQ0FBQztBQUk5RyxJQUFNLHFCQUFxQixNQUFNO0FBQy9CLFFBQU0sUUFBUSxRQUFRLElBQUk7QUFDMUIsTUFBSSxDQUFDLE1BQU8sUUFBTyxDQUFDO0FBQ3BCLFNBQU8sTUFDSixNQUFNLEdBQUcsRUFDVCxJQUFJLENBQUMsVUFBVSxNQUFNLEtBQUssQ0FBQyxFQUMzQixPQUFPLE9BQU87QUFDbkIsR0FBRztBQU1ZLFNBQVIsZUFBZ0MsRUFBRSxLQUFLLEdBQTJCO0FBQ3ZFLFFBQU0sUUFBUSxTQUFTO0FBRXZCLFNBQU87QUFBQSxJQUNMLGtCQUFrQjtBQUFBLElBQ2xCLE1BQU0sUUFBUSxxQkFBcUI7QUFBQSxJQUNuQyxhQUNFO0FBQUEsSUFDRixTQUFTLFlBQVksV0FBVztBQUFBLElBQ2hDLFFBQVE7QUFBQSxNQUNOLGVBQWU7QUFBQSxJQUNqQjtBQUFBLElBQ0EsWUFBWTtBQUFBLE1BQ1YsZ0JBQWdCO0FBQUEsTUFDaEIsTUFBTTtBQUFBLElBQ1I7QUFBQSxJQUNBLGFBQWEsQ0FBQyxXQUFXLFFBQVEsYUFBYSxVQUFVLGFBQWEsbUJBQW1CLGNBQWM7QUFBQSxJQUN0RyxrQkFBa0IsQ0FBQyxZQUFZO0FBQUEsSUFDL0IsWUFBWTtBQUFBLE1BQ1YsY0FBYztBQUFBLElBQ2hCO0FBQUEsSUFDQSxHQUFJLGtCQUFrQixTQUFTLElBQUksRUFBRSxjQUFjLGtCQUFrQixJQUFJLENBQUM7QUFBQSxJQUMxRSxpQkFBaUI7QUFBQSxNQUNmO0FBQUEsUUFDRSxTQUFTLENBQUMsWUFBWTtBQUFBLFFBQ3RCLElBQUksQ0FBQyxrQ0FBa0M7QUFBQSxRQUN2QyxRQUFRO0FBQUEsUUFDUixtQkFBbUI7QUFBQSxNQUNyQjtBQUFBLElBQ0Y7QUFBQSxFQUNGO0FBQ0Y7OztBRGxEQSxJQUFNLG1DQUFtQztBQVF6QyxJQUFPLHNCQUFRLGFBQWEsQ0FBQyxFQUFFLEtBQUssT0FBTztBQUFBLEVBQ3pDLFFBQVE7QUFBQSxJQUNOLE1BQU07QUFBQSxJQUNOLE1BQU07QUFBQSxFQUNSO0FBQUEsRUFDQSxTQUFTO0FBQUEsSUFDUCxNQUFNO0FBQUEsSUFDTixTQUFTLGlCQUFpQixnQkFBZ0I7QUFBQSxJQUMxQyxhQUFhO0FBQUEsTUFDWCxVQUFVLE1BQU0sZUFBZSxFQUFFLEtBQUssQ0FBQztBQUFBLE1BQ3ZDLGdCQUFnQixDQUFDLHNCQUFzQixlQUFlO0FBQUEsTUFDdEQsa0JBQWtCLENBQUMsb0NBQW9DO0FBQUEsSUFDekQsQ0FBQztBQUFBLEVBQ0gsRUFBRSxPQUFPLE9BQU87QUFBQSxFQUNoQixTQUFTO0FBQUEsSUFDUCxPQUFPO0FBQUEsTUFDTCxLQUFLLEtBQUssUUFBUSxrQ0FBVyxPQUFPO0FBQUEsSUFDdEM7QUFBQSxFQUNGO0FBQ0YsRUFBRTsiLAogICJuYW1lcyI6IFtdCn0K
