/// <reference types="chrome" />

import type { MemoryRecord } from "../types";
import { updateModelStatus } from "./model-status";

type LanguageModelAvailability = "readily" | "after-download" | "unavailable" | "unknown";

type LanguageModelHandle = {
  prompt: (input: string | { prompt: string }) => Promise<string>;
  promptStreaming: (input: string | { prompt: string }, options?: { signal?: AbortSignal }) => Promise<ReadableStream>;
  destroy?: () => void;
};

type LanguageModelFactory = {
  availability: (options?: Record<string, unknown>) => Promise<LanguageModelAvailability>;
  create: (options?: Record<string, unknown>) => Promise<LanguageModelHandle>;
};

function getLanguageModelFactory(): LanguageModelFactory | null {
  const ai = (globalThis as typeof globalThis & { ai?: { languageModel?: LanguageModelFactory } }).ai;
  return ai?.languageModel ?? null;
}

export async function isLanguageModelReady(): Promise<boolean> {
  const factory = getLanguageModelFactory();
  if (!factory) {
    updateModelStatus("languageModel", {
      state: "unavailable",
      message: "Language model API not available in this runtime.",
      progress: 0,
    });
    return false;
  }

  try {
    updateModelStatus("languageModel", { state: "checking", message: "Checking availability…" });
    const availability = await factory.availability({ topK: 3, temperature: 1 });
    if (availability === "readily") {
      updateModelStatus("languageModel", { state: "ready", progress: 1, message: "Language model ready." });
    } else if (availability === "after-download") {
      updateModelStatus("languageModel", {
        state: "downloading",
        progress: 0,
        message: "Language model downloading…",
      });
    } else {
      updateModelStatus("languageModel", {
        state: "unavailable",
        progress: 0,
        message: `Language model unavailable (${availability}).`,
      });
    }
    return availability === "readily";
  } catch (error) {
    console.warn("[NanoScribe] Language model availability check failed", error);
    updateModelStatus("languageModel", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function formatMemoriesForPrompt(memories: MemoryRecord[], limit = 12): string {
  return memories
    .slice(0, limit)
    .map((memory, index) => {
      return [
        `Memory ${index + 1}`,
        `ID: ${memory.id}`,
        `Title: ${memory.title}`,
        `URL: ${memory.url}`,
        `Summary: ${memory.summary}`,
      ].join("\n");
    })
    .join("\n\n");
}

async function readStreamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();

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

export async function rankMemoriesWithPrompt(query: string, memories: MemoryRecord[]): Promise<string[] | null> {
  const factory = getLanguageModelFactory();
  if (!factory) {
    updateModelStatus("languageModel", {
      state: "unavailable",
      progress: 0,
      message: "Language model API not available.",
    });
    return null;
  }

  const abortController = new AbortController();

  try {
    updateModelStatus("languageModel", {
      state: "checking",
      message: "Creating session for memory ranking…",
    });
    const session = await factory.create({
      topK: 3,
      temperature: 1,
      initialPrompts: [],
      monitor(monitorHandle: { addEventListener: (type: string, listener: (event: any) => void) => void }) {
        monitorHandle.addEventListener("downloadprogress", (event: { loaded: number }) => {
          console.debug(`[NanoScribe] Language model download ${(event.loaded * 100).toFixed(1)}%`);
          updateModelStatus("languageModel", {
            state: "downloading",
            progress: event.loaded ?? 0,
            message: `Language model download ${(event.loaded * 100).toFixed(1)}%`,
          });
        });
      },
      signal: abortController.signal,
    });

    try {
      updateModelStatus("languageModel", {
        state: "ready",
        progress: 1,
        message: "Language model session ready.",
      });
      const memoryContext = formatMemoriesForPrompt(memories);
      const prompt = [
        "You are helping choose which stored memories are most relevant for an end user query.",
        "You will be given the query and a list of memories with IDs.",
        "Return ONLY a JSON array of up to five memory IDs, ordered from most to least relevant.",
        "If none are relevant, return an empty JSON array.",
        "",
        `Query: ${query}`,
        "",
        "Memories:",
        memoryContext,
      ].join("\n");

      const stream = await session.promptStreaming(prompt, {
        signal: abortController.signal,
      });

      const output = await readStreamToString(stream);
      const trimmed = output.trim();

      const jsonStart = trimmed.indexOf("[");
      const jsonEnd = trimmed.lastIndexOf("]");

      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      console.warn("[NanoScribe] Language model response missing JSON array", trimmed);
      return null;
    }

    const jsonText = trimmed.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(jsonText);

      if (!Array.isArray(parsed)) {
        return null;
      }

      return parsed
        .map((value) => String(value))
        .filter(Boolean);
    } finally {
      session.destroy?.();
    }
  } catch (error) {
    console.error("[NanoScribe] Language model ranking failed", error);
    abortController.abort();
    updateModelStatus("languageModel", {
      state: "error",
      message: error instanceof Error ? error.message : String(error),
      progress: 0,
    });
  }

  return null;
}

export async function generateCompletionFromPrompt(params: {
  text: string;
  contextSummary?: string;
}): Promise<string | null> {
  const factory = getLanguageModelFactory();
  if (!factory) {
    updateModelStatus("languageModel", {
      state: "unavailable",
      message: "Language model API not available.",
      progress: 0,
    });
    return null;
  }

  const abortController = new AbortController();

  try {
    updateModelStatus("languageModel", { state: "checking", message: "Preparing autocomplete session…" });
    const session = await factory.create({
      topK: 3,
      temperature: 0.3,
      initialPrompts: [],
      monitor(monitorHandle: { addEventListener: (type: string, listener: (event: any) => void) => void }) {
        monitorHandle.addEventListener("downloadprogress", (event: { loaded: number }) => {
          console.debug(`[NanoScribe] Language model download ${(event.loaded * 100).toFixed(1)}%`);
          updateModelStatus("languageModel", {
            state: "downloading",
            progress: event.loaded ?? 0,
            message: `Language model download ${(event.loaded * 100).toFixed(1)}%`,
          });
        });
      },
      signal: abortController.signal,
    });

    updateModelStatus("languageModel", {
      state: "ready",
      progress: 1,
      message: "Language model ready.",
    });

    const promptParts = [
      "You are a concise writing assistant.",
      "Given the user's current text, provide a short continuation (a few words) that flows naturally.",
      "Do not rewrite existing text. If no sensible continuation exists, respond with an empty string.",
      "",
    ];

    if (params.contextSummary) {
      promptParts.push("Context summary:");
      promptParts.push(params.contextSummary);
      promptParts.push("");
    }

    promptParts.push("User text:");
    promptParts.push(params.text);
    promptParts.push("");
    promptParts.push("Completion:");

    try {
      const stream = await session.promptStreaming(promptParts.join("\n"), {
        signal: abortController.signal,
      });
      const output = (await readStreamToString(stream)).trim();

      if (!output || output.toLowerCase().startsWith("completion:")) {
        return null;
      }

      return output.replace(/\s+/g, " ").trim();
    } finally {
      session.destroy?.();
    }
  } catch (error) {
    console.error("[NanoScribe] Completion generation failed", error);
    abortController.abort();
    updateModelStatus("languageModel", {
      state: "error",
      message: error instanceof Error ? error.message : String(error),
      progress: 0,
    });
  }

  return null;
}
