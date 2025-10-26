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
    action: {
      default_title: "NanoScribe",
    },
    background: {
      service_worker: "src/extension/service-worker.ts",
      type: "module",
    },
    permissions: ["storage", "tabs", "scripting", "alarms", "sidePanel", "aiLanguageModel"],
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
