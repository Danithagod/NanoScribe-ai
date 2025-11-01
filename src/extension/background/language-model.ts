/// <reference types="chrome" />

import type {
  AutocompleteContextEntry,
  AutocompleteFieldType,
  CompletionResultPayload,
  MemoryRecord,
} from "../types";
import { updateModelStatus } from "./model-status";

// Chrome LanguageModel API Type Declarations
declare global {
  interface LanguageModelPromptMessage {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text" | "image" | "audio"; value: unknown }>;
  }

  interface LanguageModelSession {
    prompt: (input: string | LanguageModelPromptMessage[], options?: { signal?: AbortSignal; responseConstraint?: unknown }) => Promise<string>;
    promptStreaming: (input: string | LanguageModelPromptMessage[], options?: { signal?: AbortSignal }) => Promise<ReadableStream>;
    clone: (options?: { signal?: AbortSignal }) => Promise<LanguageModelSession>;
    append: (messages: LanguageModelPromptMessage[], options?: { signal?: AbortSignal }) => Promise<void>;
    destroy: () => void;
    addEventListener: (type: string, listener: (event: Event) => void) => void;
    removeEventListener: (type: string, listener: (event: Event) => void) => void;
    inputUsage: number;
    inputQuota: number;
    measureInputUsage: (input: string | LanguageModelPromptMessage[], options?: { signal?: AbortSignal }) => Promise<number>;
  }

  interface LanguageModel {
    availability: () => Promise<"readily" | "after-download" | "no" | "available" | string>;
    create: (options?: {
      temperature?: number;
      topK?: number;
      initialPrompts?: LanguageModelPromptMessage[];
      expectedInputs?: Array<{ type: string; languages?: string[] }>;
      expectedOutputs?: Array<{ type: string; languages?: string[] }>;
      monitor?: (monitor: { addEventListener: (type: string, listener: (event: ProgressEvent) => void) => void }) => void;
      signal?: AbortSignal;
    }) => Promise<LanguageModelSession>;
    params: () => Promise<{
      defaultTemperature: number;
      maxTemperature: number;
      defaultTopK: number;
      maxTopK: number;
    } | null>;
  }

  var LanguageModel: LanguageModel;
}

type CustomPromptOptions = {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  topK?: number;
  timeoutMs?: number;
};

export async function generateWithCustomPrompt(options: CustomPromptOptions): Promise<string | null> {
  const { systemPrompt, userPrompt, temperature = 0.3, topK = 4, timeoutMs = 45000 } = options;

  const LanguageModel = getLanguageModelFactory();
  if (!LanguageModel) {
    console.warn("[NanoScribe] LanguageModel API not available for custom prompt");
    return null;
  }

  let session: LanguageModelSession | null = null;
  try {
    session = await LanguageModel.create({
      temperature,
      topK,
      initialPrompts: [{ role: "system", content: systemPrompt }],
    });

    const promptPromise = session.prompt(userPrompt);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Custom prompt request timed out")), timeoutMs);
    });

    const result = await Promise.race([promptPromise, timeoutPromise]);
    if (!result) {
      return null;
    }

    return typeof result === "string" ? result.trim() : String(result).trim();
  } catch (error) {
    console.error("[NanoScribe] Custom prompt failed:", error);
    return null;
  } finally {
    try {
      session?.destroy();
    } catch (destroyError) {
      console.warn("[NanoScribe] Failed to destroy custom prompt session:", destroyError);
    }
  }
}

function extractJsonSnippet(raw: string): string | null {
  if (!raw) return null;
  const firstBrace = raw.indexOf("{");
  const firstBracket = raw.indexOf("[");

  let start = -1;
  let end = -1;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;
    end = raw.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    start = firstBracket;
    end = raw.lastIndexOf("]");
  }

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return raw.slice(start, end + 1);
}

export async function generateJsonFromPrompt<T>(options: CustomPromptOptions): Promise<T | null> {
  const raw = await generateWithCustomPrompt(options);
  if (!raw) {
    return null;
  }

  const jsonSnippet = extractJsonSnippet(raw);
  if (!jsonSnippet) {
    console.warn("[NanoScribe] No JSON snippet found in custom prompt response");
    return null;
  }

  try {
    return JSON.parse(jsonSnippet) as T;
  } catch (error) {
    console.error("[NanoScribe] Failed to parse JSON from custom prompt:", error, "Raw response:", raw);
    return null;
  }
}

// Official Chrome Prompt API Types (local definitions for compatibility)
type LanguageModelAvailability = "readily" | "after-download" | "no" | "available" | string;

// Get the official Chrome LanguageModel API
function getLanguageModelFactory(): LanguageModel | null {
  return (globalThis as typeof globalThis & { LanguageModel?: LanguageModel }).LanguageModel ?? null;
}

// Common configuration for all language model operations
const COMMON_CONFIG = {
  temperature: 0.3,
  topK: 3,
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

const AUTOCOMPLETE_TEMPERATURE_BASE = 0.35;
const AUTOCOMPLETE_TOP_K_BASE = 4;
const AUTOCOMPLETE_TOP_P_BASE = 0.9;
const AUTOCOMPLETE_MAX_OUTPUT_TOKENS = 64;

type FieldGuidance = {
  tone: string;
  min: number;
  max: number;
};

const DEFAULT_FIELD_GUIDANCE: FieldGuidance = {
  tone: "Provide a concise continuation aligned with the current voice.",
  min: 3,
  max: 12,
};

const FIELD_TYPE_GUIDANCE: Partial<Record<AutocompleteFieldType, FieldGuidance>> = {
  email: {
    tone: "Use a polite, professional tone suitable for email replies or drafts.",
    min: 6,
    max: 18,
  },
  document: {
    tone: "Continue the narrative or explanation with cohesive prose and clear transitions.",
    min: 8,
    max: 20,
  },
  chat: {
    tone: "Respond conversationally and empathetically while staying concise.",
    min: 4,
    max: 14,
  },
  search: {
    tone: "Return short keyword-style phrases that match typical search queries.",
    min: 2,
    max: 6,
  },
  code: {
    tone: "Maintain programming language syntax, indentation, and structure.",
    min: 1,
    max: 16,
  },
};

function getFieldGuidance(fieldType: AutocompleteFieldType): FieldGuidance {
  return FIELD_TYPE_GUIDANCE[fieldType] ?? DEFAULT_FIELD_GUIDANCE;
}

const FIELD_TYPE_TEMPERATURE_BOOST: Partial<Record<AutocompleteFieldType, number>> = {
  email: -0.05,
  document: 0,
  chat: 0.1,
  search: -0.1,
  code: -0.15,
};

const FIELD_TYPE_TOP_K: Partial<Record<AutocompleteFieldType, number>> = {
  email: 3,
  document: 4,
  chat: 5,
  search: 2,
  code: 2,
};

const SYSTEM_PROMPT_TEMPLATE = `You are NanoScribe, an intelligent autocomplete assistant helping the user continue their current thought.

Follow these rules:
- Prioritize information in this order: (1) the user's current text and cursor context, (2) session highlights, (3) stored memories. Ignore context that conflicts with the live text.
- Respect the user's existing voice, tense, and formatting. If the user appears to be writing code, preserve syntax and indentation.
- Apply any "Field guidance" details provided in the user message. If none are supplied, default to a concise continuation of roughly 3 to 12 words.
- NEVER repeat text the user already typed, and avoid echoing the text immediately after the cursor.
- Only include punctuation when it naturally completes the sentence or matches the user's style.
- Use provided context only when it clearly helps. Do not invent facts, personal data, or sensitive information. If you are uncertain or the request is unsafe, respond with an empty string.

Respond with ONLY the suggested continuation as plain text (no quotes or list markers).
Example response: and schedule the follow-up call tomorrow.`;
function truncateText(input: string | undefined | null, maxLength = 180): string {
  if (!input) return "";
  const text = input.trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildContextSection(entries: AutocompleteContextEntry[] | undefined, summary: string | null | undefined) {
  if ((!entries || entries.length === 0) && !summary) {
    return null;
  }

  const sections: string[] = [];

  if (summary) {
    const highlightLines = summary
      .split(/\n+/)
      .map((line) => truncateText(line, 160))
      .filter((line) => line.length > 0)
      .map((line) => `- ${line}`);

    if (highlightLines.length > 0) {
      sections.push(`## Session highlights (secondary)\n${highlightLines.join("\n")}`);
    }
  }

  if (entries && entries.length > 0) {
    const formatted = entries.slice(0, 5).map((entry, index) => {
      const relevanceTag = index < 2 ? "High" : "Related";
      const sourceTag = entry.source === "session" ? "Session" : "Memory";
      const title = truncateText(entry.title ?? "Context note", 80);
      const summaryText = truncateText(entry.summary, 160);
      const details = summaryText ? ` — ${summaryText}` : "";
      const urlLine = entry.url ? `\n  Link: ${entry.url}` : "";
      return `- [${sourceTag} | ${relevanceTag}] ${title}${details}${urlLine}`;
    });

    sections.push(`## Stored context (use only if helpful)\n${formatted.join("\n")}`);
  }

  return sections.join("\n\n");
}

function buildAutocompletePrompt(params: {
  text: string;
  fieldType: AutocompleteFieldType;
  fieldLabel?: string | null;
  placeholder?: string | null;
  surroundingText?: { before: string; after: string };
  contextEntries?: AutocompleteContextEntry[];
  contextSummary?: string | null;
}) {
  const fieldGuidance = getFieldGuidance(params.fieldType);
  const descriptors: string[] = [];
  if (params.fieldType && params.fieldType !== "generic") {
    descriptors.push(`Field type: ${params.fieldType}`);
  }
  if (params.fieldLabel) {
    descriptors.push(`Field label: ${params.fieldLabel}`);
  }
  if (params.placeholder) {
    descriptors.push(`Placeholder: ${params.placeholder}`);
  }

  const surrounding = params.surroundingText
    ? `\nBefore cursor: ${params.surroundingText.before || "<empty>"}\nAfter cursor: ${params.surroundingText.after || "<empty>"}`
    : "";

  const lines = [`Current text: ${params.text}${surrounding}`];
  if (descriptors.length > 0) {
    lines.push(`Field details: ${descriptors.join(" | ")}`);
  }

  if (fieldGuidance) {
    lines.push(
      `Field guidance:\n- Style: ${fieldGuidance.tone}\n- Target length: ${fieldGuidance.min}-${fieldGuidance.max} words.\nAdhere to the prioritization rules from the system instructions.`,
    );
  }

  const contextSection = buildContextSection(params.contextEntries, params.contextSummary);
  if (contextSection) {
    lines.push(contextSection);
  }

  return {
    system: SYSTEM_PROMPT_TEMPLATE,
    user: lines.join("\n\n"),
  };
}

function selectAutocompleteParameters(fieldType: AutocompleteFieldType, hasContext: boolean) {
  const temperatureBoost = FIELD_TYPE_TEMPERATURE_BOOST[fieldType] ?? 0;
  const temperature = Math.min(0.8, Math.max(0.05, AUTOCOMPLETE_TEMPERATURE_BASE + temperatureBoost));
  const topK = FIELD_TYPE_TOP_K[fieldType] ?? AUTOCOMPLETE_TOP_K_BASE;
  const topP = hasContext ? Math.min(1, AUTOCOMPLETE_TOP_P_BASE + 0.05) : AUTOCOMPLETE_TOP_P_BASE;

  return { temperature, topK, topP };
}

function normalizeModelOutput(raw: string | null | undefined, fieldType: AutocompleteFieldType): string {
  if (!raw) {
    return "";
  }

  if (fieldType === "code") {
    return raw.replace(/\r/g, "").replace(/[ \t]+$/gm, "");
  }

  return raw.replace(/\s+/g, " ").trim();
}

function sanitizeSuggestion(
  text: string,
  fieldType: AutocompleteFieldType,
): { value: string | null; dropReason?: string } {
  if (!text) {
    return { value: null, dropReason: "empty-response" };
  }

  if (fieldType === "code") {
    const value = text.replace(/\s+$/g, "");
    return value ? { value } : { value: null, dropReason: "empty-after-sanitize" };
  }

  let value = text.replace(/^['"`«»“”‘’\s—-]+/, "").replace(/^[.,;:!?]+/, "");
  value = value.trim();

  if (!value) {
    return { value: null, dropReason: "empty-after-sanitize" };
  }

  return { value };
}

function isDuplicateContinuation(
  suggestion: string,
  surrounding?: { before: string; after: string },
): boolean {
  if (!suggestion || !surrounding?.after) {
    return false;
  }

  const normalizedSuggestion = suggestion.trim().toLowerCase();
  const normalizedAfter = surrounding.after.trimStart().toLowerCase();

  if (!normalizedSuggestion || !normalizedAfter) {
    return false;
  }

  return normalizedAfter.startsWith(normalizedSuggestion);
}

// Global session management
let currentSession: LanguageModelSession | null = null;

// Check if AI is available and supported
export async function isLanguageModelReady(): Promise<boolean> {
  console.log("[NanoScribe] 🔍 isLanguageModelReady() CALLED");

  const LanguageModel = getLanguageModelFactory();
  if (!LanguageModel) {
    console.warn("[NanoScribe] LanguageModel API not available");
    updateModelStatus("languageModel", {
      state: "unavailable",
      progress: 0,
      message: "LanguageModel API not available in this runtime.",
    });
    return false;
  }

  console.log("[NanoScribe] 🔍 LanguageModel API found, checking availability...");

  try {
    updateModelStatus("languageModel", { state: "checking", message: "Checking availability…" });

    console.log("[NanoScribe] 🔍 Calling LanguageModel.availability()...");
    const availabilityResult = await LanguageModel.availability();
    console.log("[NanoScribe] LanguageModel availability result:", availabilityResult);

    if (availabilityResult === "readily" || availabilityResult === "available") {
      console.log("[NanoScribe] LanguageModel is ready");
      updateModelStatus("languageModel", {
        state: "ready",
        progress: 1,
        message: "Language model ready.",
      });
      return true;
    } else if (availabilityResult === "after-download") {
      console.log("[NanoScribe] LanguageModel needs download");
      updateModelStatus("languageModel", {
        state: "downloading",
        progress: 0,
        message: "Language model downloading…",
      });
      return false;
    } else {
      console.warn("[NanoScribe] LanguageModel not available:", availabilityResult);
      updateModelStatus("languageModel", {
        state: "unavailable",
        progress: 0,
        message: `Language model not available (${availabilityResult}).`,
      });
      return false;
    }
  } catch (error) {
    console.error("[NanoScribe] Language model availability check failed:", error);
    updateModelStatus("languageModel", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// Create or update AI session with specific configuration
async function createOrUpdateSession({ initialPrompts, topK, temperature }: {
  initialPrompts?: LanguageModelPromptMessage[];
  topK?: number;
  temperature?: number;
} = {}): Promise<LanguageModelSession> {
  const LanguageModel = getLanguageModelFactory();
  if (!LanguageModel) {
    throw new Error("LanguageModel API not available");
  }

  // Wait a bit to ensure any ongoing operations complete
  if (currentSession) {
    console.log("[NanoScribe] ⏳ Waiting before destroying existing session...");
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log("[NanoScribe] 🗑️ Destroying existing session");
    currentSession.destroy();
    currentSession = null;
  }

  try {
    updateModelStatus("languageModel", { state: "checking", message: "Creating AI session…" });

    // Get model parameters
    console.log("[NanoScribe] 📊 Getting model parameters...");
    const params = await LanguageModel.params();
    if (!params) {
      throw new Error("Unable to get language model parameters");
    }
    console.log("[NanoScribe] ✅ Model parameters retrieved:", params);

    const sessionConfig = {
      temperature: temperature || params.defaultTemperature || COMMON_CONFIG.temperature,
      topK: topK || params.defaultTopK || COMMON_CONFIG.topK,
      initialPrompts: initialPrompts || [],
      monitor: (monitor: { addEventListener: (type: string, listener: (event: ProgressEvent) => void) => void }) => {
        monitor.addEventListener("downloadprogress", (event: ProgressEvent) => {
          console.log(`[NanoScribe] Language model download ${(event.loaded * 100).toFixed(1)}%`);
          updateModelStatus("languageModel", {
            state: "downloading",
            progress: event.loaded,
            message: `Language model download ${(event.loaded * 100).toFixed(1)}%`,
          });
        });
      },
    };

    console.log("[NanoScribe] Creating session with config:", {
      temperature: sessionConfig.temperature,
      topK: sessionConfig.topK,
      initialPromptsCount: sessionConfig.initialPrompts.length,
    });

    console.log("[NanoScribe] 🔄 Calling LanguageModel.create()...");
    currentSession = await LanguageModel.create(sessionConfig);
    console.log("[NanoScribe] ✅ Session created successfully");

    updateModelStatus("languageModel", {
      state: "ready",
      progress: 1,
      message: "AI session ready.",
    });

    return currentSession;
  } catch (error) {
    console.error("[NanoScribe] ❌ Session creation failed:", error);
    updateModelStatus("languageModel", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Generate autocomplete suggestions
export async function generateCompletionFromPrompt(params: {
  requestId: string;
  text: string;
  fieldType: AutocompleteFieldType;
  fieldLabel?: string | null;
  placeholder?: string | null;
  surroundingText?: { before: string; after: string };
  contextSummary?: string | null;
  contextEntries?: AutocompleteContextEntry[];
}): Promise<CompletionResultPayload> {
  const contextEntries = params.contextEntries?.slice(0, 5) ?? [];
  const contextSummary = params.contextSummary ?? null;
  console.log("[NanoScribe] 🚀 generateCompletionFromPrompt CALLED with:", {
    textLength: params.text?.length || 0,
    hasContextSummary: !!contextSummary,
    contextEntryCount: contextEntries.length,
    fieldType: params.fieldType,
    textPreview: params.text?.slice(0, 50) + (params.text?.length > 50 ? '...' : ''),
  });

  const prompt = buildAutocompletePrompt({
    text: params.text,
    fieldType: params.fieldType,
    fieldLabel: params.fieldLabel,
    placeholder: params.placeholder,
    surroundingText: params.surroundingText,
    contextEntries,
    contextSummary,
  });

  const { temperature, topK, topP } = selectAutocompleteParameters(
    params.fieldType,
    contextEntries.length > 0 || !!contextSummary,
  );

  const buildResult = (
    suggestion: string | null,
    source: "model" | "fallback",
    dropReason?: string,
  ): CompletionResultPayload => ({
    requestId: params.requestId,
    suggestion,
    metadata: {
      source,
      fieldType: params.fieldType,
      ...(dropReason ? { dropReason } : {}),
    },
    contextEntries: contextEntries.length > 0 ? contextEntries : undefined,
    contextSummary,
  });

  try {
    const LanguageModel = getLanguageModelFactory();
    if (!LanguageModel) {
      console.log("[NanoScribe] 🔄 LanguageModel API not available, using fallback completion");
      return buildResult(generateFallbackCompletion(params.text), "fallback");
    }

    const initialPrompt: LanguageModelPromptMessage = {
      role: "system",
      content: prompt.system,
    };

    console.log("[NanoScribe] 📋 Creating session with temperature/topK/topP", {
      temperature,
      topK,
      topP,
    });

    await createOrUpdateSession({ initialPrompts: [initialPrompt], temperature, topK });

    const promptPromise = currentSession!.prompt(prompt.user);
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Completion generation timed out"));
      }, 45000);
    });

    const rawResponse = await Promise.race([promptPromise, timeoutPromise]);
    const normalized = normalizeModelOutput(rawResponse, params.fieldType);

    if (!normalized) {
      console.log("[NanoScribe] ⚠️ Empty completion received, using fallback");
      return buildResult(generateFallbackCompletion(params.text), "fallback");
    }

    const tokenLimit = getFieldGuidance(params.fieldType).max;
    const tokens = normalized.split(/\s+/).filter(Boolean);
    const limited = tokens.slice(0, tokenLimit).join(" ");

    const sanitized = sanitizeSuggestion(limited, params.fieldType);

    if (!sanitized.value) {
      console.log("[NanoScribe] ⚠️ Dropping suggestion after sanitize", sanitized.dropReason);
      return buildResult(null, "model", sanitized.dropReason);
    }

    if (isDuplicateContinuation(sanitized.value, params.surroundingText)) {
      console.log("[NanoScribe] ⚠️ Dropping suggestion due to duplicate continuation");
      return buildResult(null, "model", "duplicate");
    }

    console.log("[NanoScribe] ✨ Final completion", { original: normalized, limited: sanitized.value });

    return buildResult(sanitized.value, "model");
  } catch (error) {
    console.error("[NanoScribe] 💥 Autocomplete generation failed:", error);
    updateModelStatus("languageModel", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error && (error.message.includes("timed out") || error.message.includes("cancelled"))) {
      console.log("[NanoScribe] 🔄 Attempting session recovery after error...");
      try {
        await createOrUpdateSession();
        console.log("[NanoScribe] ✅ Session recovered");
      } catch (recoveryError) {
        console.error("[NanoScribe] ❌ Session recovery failed:", recoveryError);
      }
    }

    return buildResult(generateFallbackCompletion(params.text), "fallback");
  }
}

// Generate memory ranking
export async function rankMemoriesWithPrompt(query: string, memories: MemoryRecord[]): Promise<string[] | null> {
  try {
    // First try to use the LanguageModel API
    const LanguageModel = getLanguageModelFactory();
    if (LanguageModel) {
      try {
        console.log("[NanoScribe] 🔍 Creating memory ranking session for query:", query);

        const systemPrompt: LanguageModelPromptMessage = {
          role: "system",
          content: "You are helping choose which stored memories are most relevant for an end user query. Return ONLY a JSON array of up to five memory IDs, ordered from most to least relevant. If none are relevant, return an empty JSON array."
        };

        // Create session for memory ranking
        await createOrUpdateSession({ initialPrompts: [systemPrompt] });

        // Format memories for prompt (limit to top candidates to avoid overwhelming AI)
        const maxMemoriesForRanking = Math.min(memories.length, 10); // Limit to 10 memories
        const topMemories = memories.slice(0, maxMemoriesForRanking);

        const memoryContext = topMemories
          .map((memory, index) => {
            return [
              `Memory ${index + 1}`,
              `ID: ${memory.id}`,
              `Title: ${memory.title}`,
              `URL: ${memory.url}`,
              `Summary: ${memory.summary?.slice(0, 200)}...`, // Truncate long summaries
            ].join("\n");
          })
          .join("\n\n");

        const userPrompt = `Query: ${query}\n\nRelevant memories (${topMemories.length}):\n${memoryContext}\n\nReturn JSON array of up to 5 most relevant memory IDs:`;

        console.log("[NanoScribe] 📤 MEMORY RANKING PROMPT:");
        console.log("  Query:", query);
        console.log("  Memory count:", topMemories.length);
        console.log("  System prompt:", systemPrompt.content);
        console.log("  User prompt length:", userPrompt.length);

        // Increase timeout for memory ranking since it can be complex
        console.log("[NanoScribe] 🔄 Calling memory ranking prompt with increased timeout...");
        const promptPromise = currentSession!.prompt(userPrompt);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            console.warn("[NanoScribe] ⚠️ Memory ranking timed out after 45 seconds");
            reject(new Error("Memory ranking request timed out"));
          }, 45000); // Increased from 20 to 45 seconds
        });

        const result = await Promise.race([promptPromise, timeoutPromise]);

        console.log("[NanoScribe] 📥 MEMORY RANKING RESPONSE:");
        console.log("  Raw response:", result);

        if (!result || !result.includes("[")) {
          console.log("[NanoScribe] ⚠️ No valid JSON array in response, using fallback ranking");
          return rankMemoriesFallback(query, memories);
        }

        try {
          const jsonStart = result.indexOf("[");
          const jsonEnd = result.lastIndexOf("]");
          if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
            console.log("[NanoScribe] ⚠️ Invalid JSON array bounds, using fallback ranking");
            return rankMemoriesFallback(query, memories);
          }

          const jsonText = result.slice(jsonStart, jsonEnd + 1);
          const parsed = JSON.parse(jsonText);

          if (!Array.isArray(parsed)) {
            console.log("[NanoScribe] ⚠️ Response is not an array, using fallback ranking");
            return rankMemoriesFallback(query, memories);
          }

          console.log("[NanoScribe] ✨ Memory ranking result:", parsed);
          return parsed
            .map((value) => String(value))
            .filter(Boolean);
        } catch (parseError) {
          console.error("[NanoScribe] Failed to parse JSON response:", parseError);
          return rankMemoriesFallback(query, memories);
        }
      } catch (error) {
        console.error("[NanoScribe] LanguageModel memory ranking failed:", error);
        console.log("[NanoScribe] 🔄 Falling back to simple ranking...");
        return rankMemoriesFallback(query, memories);
      }
    } else {
      console.log("[NanoScribe] 🔄 LanguageModel API not available, using fallback memory ranking");
      return rankMemoriesFallback(query, memories);
    }
  } catch (error) {
    console.error("[NanoScribe] Memory ranking failed:", error);
    updateModelStatus("languageModel", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });

    // If it's a timeout or abort error, try to recover the session
    if (error instanceof Error && (error.message.includes("timed out") || error.message.includes("cancelled"))) {
      console.log("[NanoScribe] 🔄 Attempting session recovery after memory ranking error...");
      try {
        await createOrUpdateSession();
        console.log("[NanoScribe] ✅ Session recovered after memory ranking error");
      } catch (recoveryError) {
        console.error("[NanoScribe] ❌ Session recovery failed:", recoveryError);
      }
    }

    return rankMemoriesFallback(query, memories);
  }
}

// Fallback memory ranking when LanguageModel API is not available
function rankMemoriesFallback(query: string, memories: MemoryRecord[]): string[] {
  console.log("[NanoScribe] 🔄 Using fallback memory ranking for:", query);

  if (memories.length === 0) {
    return [];
  }

  // Limit to first 20 memories to avoid performance issues
  const limitedMemories = memories.slice(0, 20);

  // Simple keyword-based ranking
  const queryWords = query.toLowerCase().split(' ').filter(word => word.length > 2);

  const scored = limitedMemories.map(memory => {
    let score = 0;
    const searchableText = `${memory.title} ${memory.summary} ${memory.url}`.toLowerCase();

    queryWords.forEach(word => {
      // Title matches get higher score
      if (memory.title.toLowerCase().includes(word)) {
        score += 3;
      }
      // Summary matches get medium score
      if (memory.summary.toLowerCase().includes(word)) {
        score += 2;
      }
      // URL matches get lower score
      if (memory.url.toLowerCase().includes(word)) {
        score += 1;
      }
    });

    return { memory, score };
  });

  // Sort by score descending and return top 5 IDs
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(item => item.memory.id);
}

// Fallback completion when LanguageModel API is not available
export function generateFallbackCompletion(text: string): string | null {
  console.log("[NanoScribe] 🔄 Using fallback completion for:", text);

  // Simple pattern-based completions
  const completions: { [key: string]: string } = {
    "the": "quick brown fox jumps over the lazy dog",
    "i": "am writing a letter to my friend",
    "this": "is a sample text for testing purposes",
    "we": "are going to the store to buy some groceries",
    "you": "can achieve anything you set your mind to",
    "it": "is important to stay hydrated throughout the day",
    "they": "were walking down the street when they saw",
    "he": "was reading a book about artificial intelligence",
    "she": "enjoys listening to music while working",
    "what": "are you doing this weekend",
    "how": "are you feeling today",
    "why": "did the chicken cross the road",
    "when": "will you be available for a meeting",
    "where": "is the nearest coffee shop",
    "which": "one would you prefer",
    "who": "is your favorite author",
    "artificial": "intelligence is transforming our world",
    "machine": "learning algorithms are becoming more sophisticated",
    "computer": "science is a fascinating field of study",
    "programming": "languages have evolved significantly over time",
    "software": "development requires careful planning and testing",
    "technology": "advances at an incredible pace",
    "internet": "connectivity is essential in today's world",
    "data": "analysis helps us make informed decisions",
    "algorithm": "optimization can significantly improve performance",
    "application": "development involves multiple stages and testing",
    "system": "architecture must be carefully designed",
    "network": "security is crucial for protecting sensitive information",
    "database": "management requires expertise and attention to detail",
    "user": "interface design should prioritize usability",
    "performance": "monitoring helps identify bottlenecks",
    "security": "measures protect against various threats",
    "testing": "ensures software quality and reliability",
    "deployment": "strategies vary depending on requirements",
    "monitoring": "tools help track system health",
    "backup": "procedures are essential for data protection",
    "recovery": "plans should be regularly tested",
  };

  // Find matching patterns
  const words = text.toLowerCase().split(' ');
  for (let i = words.length; i > 0; i--) {
    const phrase = words.slice(-i).join(' ');
    if (completions[phrase]) {
      return completions[phrase];
    }
  }

  // If no pattern matches, return a generic completion
  return "is a great way to improve productivity and achieve your goals.";
}

// Test function to verify the model works
export async function testLanguageModelPrompt(): Promise<string | null> {
  try {
    console.log("[NanoScribe] 🧪 Testing language model prompt API...");

    const LanguageModel = getLanguageModelFactory();
    if (!LanguageModel) {
      throw new Error("LanguageModel API not available");
    }

    console.log("[NanoScribe] 📊 Testing availability...");
    const availability = await LanguageModel.availability();
    console.log("[NanoScribe] 📊 Availability result:", availability);

    console.log("[NanoScribe] 📊 Getting model parameters...");
    const params = await LanguageModel.params();
    console.log("[NanoScribe] 📊 Parameters:", params);

    console.log("[NanoScribe] 🏗️ Creating test session...");
    const testSession = await LanguageModel.create({
      temperature: 0.1,
      topK: 1,
      initialPrompts: [{
        role: "system",
        content: "You are a helpful assistant. Respond with exactly one word."
      }]
    });

    console.log("[NanoScribe] 🔄 Testing prompt call...");
    const result = await testSession.prompt("Say 'hello' and nothing else.");
    console.log("[NanoScribe] ✅ Test prompt result:", result);

    testSession.destroy();
    return result;
  } catch (error) {
    console.error("[NanoScribe] ❌ Language model test failed:", error);
    return null;
  }
}

// Cleanup function
export function cleanupLanguageModelSession(): void {
  if (currentSession) {
    currentSession.destroy();
    currentSession = null;
    console.debug("[NanoScribe] Language model session cleaned up");
  }
}
