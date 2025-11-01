/// <reference types="chrome" />

import { updateModelStatus } from "./model-status";

type SummarizerAvailabilityState = "available" | "downloadable" | "downloading" | "unavailable" | "unknown";

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
      message: "Chrome AI Summarizer API not available. Using fallback summarization.",
    });
    // Always return true for fallback mode - we can always summarize with basic text processing
    console.info("[NanoScribe] Summarizer API not available, but fallback summarization is ready");
    return true;
  }

  try {
    updateModelStatus("summarizer", { state: "checking", message: "Checking summarizer availability…" });

    if (variant.kind === "modern") {
      const availability = await variant.factory.availability({ ...MODERN_AVAILABILITY_OPTIONS });
      if (availability === "available") {
        updateModelStatus("summarizer", { state: "ready", progress: 1, message: "Summarizer ready." });
      } else if (availability === "downloading") {
        updateModelStatus("summarizer", {
          state: "downloading",
          progress: 0,
          message: "Summarizer downloading…",
        });
      } else if (availability === "downloadable") {
        updateModelStatus("summarizer", {
          state: "checking",
          progress: 0,
          message: "Summarizer model available for download.",
        });
      } else {
        updateModelStatus("summarizer", {
          state: "unavailable",
          progress: 0,
          message: `Summarizer unavailable (${availability}).`,
        });
      }
      return availability === "available";
    }

    const availability = await variant.factory.availability();
    if (availability === "available") {
      updateModelStatus("summarizer", { state: "ready", progress: 1, message: "Summarizer ready." });
    } else if (availability === "downloadable" || availability === "downloading") {
      updateModelStatus("summarizer", {
        state: "downloading",
        progress: 0,
        message: `Legacy summarizer ${availability === "downloadable" ? "requires download" : "is downloading"}.`,
      });
    } else {
      updateModelStatus("summarizer", {
        state: "unavailable",
        progress: 0,
        message: `Summarizer unavailable (${availability}).`,
      });
    }
    return availability === "available";
  } catch (error) {
    console.warn("[NanoScribe] Summarizer availability check failed", error);
    updateModelStatus("summarizer", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    // Return true for fallback mode even if AI check fails
    return true;
  }
}

export async function generateKeyPointSummary(text: string): Promise<string | null> {
  const variant = getSummarizerVariant();
  if (!variant) {
    updateModelStatus("summarizer", {
      state: "unavailable",
      progress: 0,
      message: "Chrome AI Summarizer API not available. Using fallback summarization.",
    });

    // Use fallback summarization when AI API is not available
    console.info("[NanoScribe] Using fallback summarization (Chrome AI API not available)");
    return fallbackSummarize(text);
  }

  try {
    if (variant.kind === "modern") {
      const availability = await variant.factory.availability({ ...MODERN_AVAILABILITY_OPTIONS });
      if (availability !== "available") {
        console.info("[NanoScribe] Modern summarizer not ready:", availability);
        updateModelStatus("summarizer", {
          state: availability === "downloading" || availability === "downloadable" ? "downloading" : "unavailable",
          progress: 0,
          message: `Modern summarizer not ready (${availability}). Using fallback.`,
        });
        return fallbackSummarize(text);
      }

      let abortController: AbortController | null = null;

      try {
        abortController = new AbortController();
        updateModelStatus("summarizer", {
          state: "checking",
          message: "Creating summarizer session…",
        });

type DownloadProgressEvent = {
  loaded: number;
  total?: number;
};

type MonitorHandle = {
  addEventListener: (type: string, listener: (event: DownloadProgressEvent) => void) => void;
};

        const summarizer = await variant.factory.create({
          ...MODERN_CREATE_OPTIONS,
          monitor(monitorHandle: MonitorHandle) {
            monitorHandle.addEventListener("downloadprogress", (event: DownloadProgressEvent) => {
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
    if (availability !== "available") {
      console.info("[NanoScribe] Legacy summarizer not ready:", availability);
      updateModelStatus("summarizer", {
        state: availability === "downloading" || availability === "downloadable" ? "downloading" : "unavailable",
        progress: 0,
        message: `Legacy summarizer not ready (${availability}). Using fallback.`,
      });
      return fallbackSummarize(text);
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

  // Always fallback to basic summarization if AI fails
  console.info("[NanoScribe] Falling back to basic text summarization");
  return fallbackSummarize(text);
}

// Enhanced fallback summarization
function fallbackSummarize(text: string): string {
  console.info("[NanoScribe] Using enhanced fallback summarization");

  // Remove extra whitespace and normalize
  const cleanText = text.trim().replace(/\s+/g, ' ');

  if (cleanText.length === 0) {
    return "No content to summarize.";
  }

  // Split into sentences
  const sentences = cleanText
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 10) // Filter very short sentences
    .slice(0, 5); // Take first 5 meaningful sentences

  if (sentences.length === 0) {
    // Fallback to first 200 characters
    return cleanText.slice(0, 200) + (cleanText.length > 200 ? '...' : '');
  }

  // Create key points format
  const keyPoints = sentences.map((sentence, index) => {
    return `- ${sentence}`;
  });

  const summary = keyPoints.join('\n');
  console.info(`[NanoScribe] Generated fallback summary: ${summary.length} characters, ${sentences.length} key points`);

  return summary;
}
