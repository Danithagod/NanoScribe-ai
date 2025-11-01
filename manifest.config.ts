import { readFileSync } from "fs";

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), { encoding: "utf-8" })) as {
  version?: string;
};

const originTrialTokens = (() => {
  const token = process.env.NANOSCRIBE_ORIGIN_TRIAL_TOKEN;
  if (!token) return [] as string[];
  return token
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
})();

type ManifestFactoryOptions = {
  mode: string;
};

export default function createManifest({ mode }: ManifestFactoryOptions) {
  const isDev = mode === "development";

  return {
    manifest_version: 3,
    name: isDev ? "NanoScribe (Dev)" : "NanoScribe",
    description:
      "Private, offline-first writing assistant with semantic recall and contextual completions.",
    version: packageJson.version ?? "0.0.0",
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png", 
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png",
    },
    action: {
      default_title: "NanoScribe",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
      },
    },
    background: {
      service_worker: "src/extension/service-worker.ts",
      type: "module",
    },
    permissions: ["storage", "tabs", "scripting", "alarms", "sidePanel", "aiLanguageModel", "webNavigation", "contextMenus"],
    host_permissions: ["<all_urls>"],
    side_panel: {
      default_path: "src/extension/sidepanel/index.html",
    },
    ...(originTrialTokens.length > 0 ? { trial_tokens: originTrialTokens } : {}),
    content_scripts: [
      {
        matches: ["<all_urls>"],
        js: ["src/extension/content-script.tsx"],
        run_at: "document_idle",
        match_about_blank: false,
      },
    ],
  };
}
