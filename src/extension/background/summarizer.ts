/// <reference types="chrome" />

import { updateModelStatus } from "./model-status";

type SummarizerAvailabilityState = "readily" | "after-download" | "unavailable" | "unknown";

type ModernSummarizerHandle = {
  summarizeStreaming: (text: string, options?: { context?: string }) => Promise<ReadableStream>;
  destroy?: () => void;
};

type ModernSummarizerFactory = {
  availability: (options: Record<string, unknown>) => Promise<SummarizerAvailabilityState>;
  create: (options: Record<string, unknown>) => Promise<ModernSummarizerHandle>;
};

type LegacySummarizerHandle = {
  summarize: (input: string | { text: string }) => Promise<unknown>;
  destroy?: () => void;
};

type LegacySummarizerFactory = {
  availability: () => Promise<SummarizerAvailabilityState>;
  create: (options?: Record<string, unknown>) => Promise<LegacySummarizerHandle>;
};

type SummarizerVariant =
  | { kind: "modern"; factory: ModernSummarizerFactory }
  | { kind: "legacy"; factory: LegacySummarizerFactory };

const MODERN_AVAILABILITY_OPTIONS = {
  type: "headline",
  format: "plain-text",
  length: "medium",
  expectedInputLanguages: [] as string[],
  expectedContextLanguages: [] as string[],
  outputLanguage: "en",
};

const MODERN_CREATE_OPTIONS = {
  type: "headline",
  format: "plain-text",
  length: "medium",
  sharedContext: "",
  expectedInputLanguages: [] as string[],
  expectedContextLanguages: [] as string[],
  outputLanguage: "en",
};

function getSummarizerVariant(): SummarizerVariant | null {
  const globalAny = globalThis as typeof globalThis & {
    Summarizer?: ModernSummarizerFactory;
    ai?: { summarizer?: LegacySummarizerFactory };
  };

  if (globalAny.Summarizer && typeof globalAny.Summarizer.create === "function") {
    return { kind: "modern", factory: globalAny.Summarizer };
  }

  const legacy = globalAny.ai?.summarizer;
  if (legacy && typeof legacy.create === "function") {
    return { kind: "legacy", factory: legacy };
  }

  return null;
}

async function readStreamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (typeof value === "string") {
      chunks.push(value);
    } else if (value) {
      chunks.push(decoder.decode(value, { stream: true }));
    }
  }

  return chunks.join("");
}

export async function isSummarizerReady(): Promise<boolean> {
  const variant = getSummarizerVariant();
  if (!variant) {
    updateModelStatus("summarizer", {
      state: "unavailable",
      progress: 0,
      message: "Summarizer API not available.",
    });
    return false;
  }

  try {
    updateModelStatus("summarizer", { state: "checking", message: "Checking summarizer availability…" });

    if (variant.kind === "modern") {
      const availability = await variant.factory.availability({ ...MODERN_AVAILABILITY_OPTIONS });
      if (availability === "readily") {
        updateModelStatus("summarizer", { state: "ready", progress: 1, message: "Summarizer ready." });
      } else if (availability === "after-download") {
        updateModelStatus("summarizer", {
          state: "downloading",
          progress: 0,
          message: "Summarizer downloading…",
        });
      } else {
        updateModelStatus("summarizer", {
          state: "unavailable",
          progress: 0,
          message: `Summarizer unavailable (${availability}).`,
        });
      }
      return availability === "readily";
    }

    const availability = await variant.factory.availability();
    if (availability === "readily") {
      updateModelStatus("summarizer", { state: "ready", progress: 1, message: "Summarizer ready." });
    } else {
      updateModelStatus("summarizer", {
        state: "unavailable",
        progress: 0,
        message: `Summarizer unavailable (${availability}).`,
      });
    }
    return availability === "readily";
  } catch (error) {
    console.warn("[NanoScribe] Summarizer availability check failed", error);
    updateModelStatus("summarizer", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function generateKeyPointSummary(text: string): Promise<string | null> {
  const variant = getSummarizerVariant();
  if (!variant) {
    updateModelStatus("summarizer", {
      state: "unavailable",
      progress: 0,
      message: "Summarizer API not available.",
    });
    return null;
  }

  try {
    if (variant.kind === "modern") {
      const availability = await variant.factory.availability({ ...MODERN_AVAILABILITY_OPTIONS });
      if (availability !== "readily") {
        console.info("[NanoScribe] Summarizer not ready:", availability);
        updateModelStatus("summarizer", {
          state: availability === "after-download" ? "downloading" : "unavailable",
          progress: availability === "after-download" ? 0 : 0,
          message: `Summarizer not ready (${availability}).`,
        });
        return null;
      }

      let abortController: AbortController | null = null;

      try {
        abortController = new AbortController();
        updateModelStatus("summarizer", {
          state: "checking",
          message: "Creating summarizer session…",
        });

        const summarizer = await variant.factory.create({
          ...MODERN_CREATE_OPTIONS,
          monitor(monitorHandle: { addEventListener: (type: string, listener: (event: any) => void) => void }) {
            monitorHandle.addEventListener("downloadprogress", (event: { loaded: number }) => {
              console.debug(`[NanoScribe] Summarizer download ${(event.loaded * 100).toFixed(1)}%`);
              updateModelStatus("summarizer", {
                state: "downloading",
                progress: event.loaded ?? 0,
                message: `Summarizer download ${(event.loaded * 100).toFixed(1)}%`,
              });
            });
          },
          signal: abortController.signal,
        });

        try {
          updateModelStatus("summarizer", {
            state: "ready",
            progress: 1,
            message: "Summarizer ready.",
          });
          const stream = await summarizer.summarizeStreaming(text, { context: "" });
          const output = await readStreamToString(stream);
          return output.trim();
        } finally {
          summarizer.destroy?.();
        }
      } catch (error) {
        abortController?.abort();
        updateModelStatus("summarizer", {
          state: "error",
          progress: 0,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }

    const availability = await variant.factory.availability();
    if (availability !== "readily") {
      console.info("[NanoScribe] Summarizer not ready:", availability);
      updateModelStatus("summarizer", {
        state: "unavailable",
        progress: 0,
        message: `Summarizer not ready (${availability}).`,
      });
      return null;
    }

    updateModelStatus("summarizer", {
      state: "checking",
      message: "Creating summarizer session…",
    });

    const summarizer = await variant.factory.create({
      format: "plain-text",
      type: "key-points",
      length: "medium",
    });

    try {
      updateModelStatus("summarizer", {
        state: "ready",
        progress: 1,
        message: "Summarizer ready.",
      });
      const output = await summarizer.summarize({ text });
      if (typeof output === "string") {
        return output.trim();
      }

      if (Array.isArray(output)) {
        return output.join("\n").trim();
      }

      if (output && typeof output === "object") {
        const maybeSummary = (output as { summary?: string; summaries?: string[] }).summary;
        if (typeof maybeSummary === "string") {
          return maybeSummary.trim();
        }

        const maybeSummaries = (output as { summaries?: string[] }).summaries;
        if (Array.isArray(maybeSummaries)) {
          return maybeSummaries.join("\n").trim();
        }
      }
    } finally {
      summarizer.destroy?.();
    }
  } catch (error) {
    console.error("[NanoScribe] Summarization failed", error);
    updateModelStatus("summarizer", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
}
