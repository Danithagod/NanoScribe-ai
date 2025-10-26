/// <reference types="chrome" />

import type { MemoryRecord } from "../types";
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

  // Destroy existing session if it exists
  if (currentSession) {
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
  text: string;
  contextSummary?: string;
}): Promise<string | null> {
  console.log("[NanoScribe] 🚀 generateCompletionFromPrompt CALLED with:", {
    textLength: params.text?.length || 0,
    hasContext: !!params.contextSummary,
    textPreview: params.text?.slice(0, 50) + (params.text?.length > 50 ? '...' : ''),
  });

  try {
    console.log("[NanoScribe] 🚀 Creating autocomplete session for text:", params.text.slice(0, 50) + "...");

    // Create system prompt for autocomplete
    const systemPrompt: LanguageModelPromptMessage = {
      role: "system",
      content: "You are an intelligent autocomplete assistant. Given the user's current text, provide ONLY the next 3-8 words that would naturally complete their thought. Be concise. Do not repeat existing text. Do not add punctuation unless it naturally completes the sentence. If no good continuation exists, respond with an empty string."
    };

    // Add context if available
    const initialPrompts: LanguageModelPromptMessage[] = [systemPrompt];
    if (params.contextSummary) {
      initialPrompts.push({
        role: "system",
        content: `Relevant context from user's browsing history:\n${params.contextSummary}`
      });
    }

    console.log("[NanoScribe] 📋 Creating session with initial prompts...");
    // Create/update session
    await createOrUpdateSession({ initialPrompts });
    console.log("[NanoScribe] ✅ Session created successfully");

    // Prepare the prompt
    const userPrompt = `Current text: ${params.text}\n\nNext words:`;

    console.log("[NanoScribe] 📤 PROMPT API INPUT:");
    console.log("  System prompt:", initialPrompts[0].content);
    if (params.contextSummary) {
      console.log("  Context prompt:", initialPrompts[1].content);
    }
    console.log("  User prompt:", userPrompt);

    console.log("[NanoScribe] 🔄 Calling currentSession.prompt()...");
    // Use direct prompt instead of streaming for simpler completion
    const result = await currentSession!.prompt(userPrompt);
    console.log("[NanoScribe] ✅ Prompt API call completed");

    console.log("[NanoScribe] 📥 PROMPT API RESPONSE:");
    console.log("  Raw response:", result);
    console.log("  Response length:", result.length);

    if (!result || result.trim().length === 0) {
      console.log("[NanoScribe] ⚠️ No completion generated");
      return null;
    }

    // Clean up the response
    const cleanedResult = result.replace(/\s+/g, " ").trim();
    console.log("[NanoScribe] ✨ Final completion:", cleanedResult);

    return cleanedResult;
  } catch (error) {
    console.error("[NanoScribe] 💥 Autocomplete generation failed:", error);
    updateModelStatus("languageModel", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Generate memory ranking
export async function rankMemoriesWithPrompt(query: string, memories: MemoryRecord[]): Promise<string[] | null> {
  try {
    console.log("[NanoScribe] 🔍 Creating memory ranking session for query:", query);

    const systemPrompt: LanguageModelPromptMessage = {
      role: "system",
      content: "You are helping choose which stored memories are most relevant for an end user query. Return ONLY a JSON array of up to five memory IDs, ordered from most to least relevant. If none are relevant, return an empty JSON array."
    };

    // Create session for memory ranking
    await createOrUpdateSession({ initialPrompts: [systemPrompt] });

    // Format memories for prompt
    const memoryContext = memories
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

    const userPrompt = `Query: ${query}\n\nMemories:\n${memoryContext}`;

    console.log("[NanoScribe] 📤 MEMORY RANKING PROMPT:");
    console.log("  Query:", query);
    console.log("  Memory count:", memories.length);
    console.log("  System prompt:", systemPrompt.content);
    console.log("  User prompt:", userPrompt);

    const result = await currentSession!.prompt(userPrompt);

    console.log("[NanoScribe] 📥 MEMORY RANKING RESPONSE:");
    console.log("  Raw response:", result);

    if (!result || !result.includes("[")) {
      console.log("[NanoScribe] ⚠️ No valid JSON array in response");
      return null;
    }

    try {
      const jsonStart = result.indexOf("[");
      const jsonEnd = result.lastIndexOf("]");
      if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        console.log("[NanoScribe] ⚠️ Invalid JSON array bounds");
        return null;
      }

      const jsonText = result.slice(jsonStart, jsonEnd + 1);
      const parsed = JSON.parse(jsonText);

      if (!Array.isArray(parsed)) {
        console.log("[NanoScribe] ⚠️ Response is not an array");
        return null;
      }

      console.log("[NanoScribe] ✨ Memory ranking result:", parsed);
      return parsed
        .map((value) => String(value))
        .filter(Boolean);
    } catch (parseError) {
      console.error("[NanoScribe] Failed to parse JSON response:", parseError);
      return null;
    }
  } catch (error) {
    console.error("[NanoScribe] Memory ranking failed:", error);
    updateModelStatus("languageModel", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
