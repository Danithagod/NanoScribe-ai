/// <reference types="chrome" />

import type { ProofreaderCorrection } from "../types";
import { updateModelStatus } from "./model-status";
import { ModelLogger } from "@/lib/model-logger";

const LOG_PREFIX = "[NanoScribe]";
const logger = new ModelLogger("Proofreader");

type ProofreaderAvailabilityState = "readily" | "downloadable" | "after-download" | "unavailable" | "unknown";

type ModernProofreaderOptions = {
  expectedInputLanguages: string[];
  includeCorrectionTypes?: boolean;
  includeCorrectionExplanations?: boolean;
  correctionExplanationLanguage?: string;
};

type ModernProofreaderHandle = {
  proofread: (input: string) => Promise<{
    correctedInput: string;
    corrections: Array<{
      startIndex: number;
      endIndex: number;
      correction: string;
      type?: string;
      explanation?: string;
    }>;
  }>;
  destroy?: () => void;
};

type ModernProofreaderFactory = {
  availability: (options?: string) => Promise<string | boolean>;
  create: (options: Partial<ModernProofreaderOptions> & {
    monitor?: (monitorHandle: ProofreaderDownloadMonitor) => void;
    signal?: AbortSignal;
  }) => Promise<ModernProofreaderHandle>;
};

type ProofreaderDownloadMonitor = {
  addEventListener: (type: string, listener: (event: { loaded: number }) => void) => void;
};

export type ProofreaderResult = {
  corrected?: string;
  correctedInput?: string;
  corrections?: ProofreaderCorrection[];
};

const PROOFREADER_OPTIONS: ModernProofreaderOptions = {
  expectedInputLanguages: ["en"],
  includeCorrectionTypes: true,
  includeCorrectionExplanations: true,
  correctionExplanationLanguage: "en",
};

let activeHandle: ModernProofreaderHandle | null = null;
let loadingPromise: Promise<ModernProofreaderHandle | null> | null = null;

function getProofreaderVariant(): ModernProofreaderFactory | null {
  const globalAny = globalThis as typeof globalThis & {
    Proofreader?: ModernProofreaderFactory;
  };

  if (globalAny.Proofreader && typeof globalAny.Proofreader.create === "function") {
    return globalAny.Proofreader;
  }

  return null;
}

function interpretAvailabilityResponse(response: unknown): ProofreaderAvailabilityState {
  if (typeof response === "string") {
    // Handle string responses like "readily", "downloadable", "after-download", etc.
    const stringResponse = response as string;
    if (["readily", "downloadable", "after-download", "unavailable"].includes(stringResponse)) {
      return stringResponse as ProofreaderAvailabilityState;
    }
    return "unknown";
  }

  if (typeof response === "boolean") {
    // If availability() returns true, it's readily available
    // If availability() returns false, it's unavailable
    return response ? "readily" : "unavailable";
  }

  return "unknown";
}

async function queryAvailability(factory: ModernProofreaderFactory): Promise<ProofreaderAvailabilityState> {
  try {
    // Check general availability directly - follow same pattern as language model
    const generalCheck = await factory.availability?.();
    const interpreted = interpretAvailabilityResponse(generalCheck);
    logger.debug("Availability check (general) =>", interpreted);
    return interpreted;
  } catch (error) {
    console.warn(`${LOG_PREFIX} Availability query failed`, error);
    return "unknown";
  }
}

export async function isProofreaderReady(): Promise<boolean> {
  console.log(`${LOG_PREFIX} Checking proofreader availability...`);
  const factory = getProofreaderVariant();
  if (!factory) {
    console.info(`${LOG_PREFIX} Proofreader API not available in this context.`);
    updateModelStatus("proofreader", {
      state: "unavailable",
      progress: 0,
      message: "Proofreader API not available.",
    });
    return false;
  }

  updateModelStatus("proofreader", { state: "checking", message: "Checking proofreader availability…" });

  const availability = await queryAvailability(factory);
  console.info(`${LOG_PREFIX} Availability state:`, availability);

  if (availability === "readily") {
    console.log(`${LOG_PREFIX} Proofreader is ready!`);
    updateModelStatus("proofreader", { state: "ready", progress: 1, message: "Proofreader ready." });
    return true;
  }

  if (availability === "downloadable") {
    console.log(`${LOG_PREFIX} Proofreader is downloadable`);
    updateModelStatus("proofreader", {
      state: "downloading",
      progress: 0,
      message: "Proofreader downloading…",
    });
    return false;
  }

  if (availability === "after-download") {
    console.log(`${LOG_PREFIX} Proofreader needs download`);
    updateModelStatus("proofreader", {
      state: "downloading",
      progress: 0,
      message: "Proofreader downloading…",
    });
    return false;
  }

  // If availability is "unknown" but proofreader API exists, assume it's ready
  // This handles cases where the availability check doesn't work but the proofreader does
  if (availability === "unknown") {
    console.log(`${LOG_PREFIX} Availability unknown but API available, assuming ready`);
    updateModelStatus("proofreader", {
      state: "ready",
      progress: 1,
      message: "Proofreader ready (availability check inconclusive).",
    });
    return true;
  }

  console.log(`${LOG_PREFIX} Proofreader unavailable:`, availability);
  updateModelStatus("proofreader", {
    state: "unavailable",
    progress: 0,
    message: `Proofreader unavailable (${availability}).`,
  });
  return false;
}

async function instantiateProofreader(): Promise<ModernProofreaderHandle | null> {
  const factory = getProofreaderVariant();
  if (!factory) {
    console.warn(`${LOG_PREFIX} No proofreader factory detected while instantiating.`);
    updateModelStatus("proofreader", {
      state: "unavailable",
      progress: 0,
      message: "Proofreader API not available.",
    });
    return null;
  }

  const availability = await queryAvailability(factory);
  if (availability === "unavailable") {
    console.warn(`${LOG_PREFIX} Proofreader unavailable. Skipping instantiation.`);
    updateModelStatus("proofreader", {
      state: "unavailable",
      progress: 0,
      message: "Proofreader unavailable.",
    });
    return null;
  }

  if (availability === "downloadable" || availability === "after-download") {
    console.info(`${LOG_PREFIX} Proofreader requires download. Monitoring progress...`);
    updateModelStatus("proofreader", {
      state: "downloading",
      progress: 0,
      message: "Proofreader downloading…",
    });
  }

  try {
    const abortController = new AbortController();
    const handle = await factory.create({
      ...PROOFREADER_OPTIONS,
      monitor(monitorHandle) {
        monitorHandle.addEventListener("downloadprogress", (event) => {
          console.info(`${LOG_PREFIX} Download progress: ${(event.loaded * 100).toFixed(1)}%`);
          updateModelStatus("proofreader", {
            state: "downloading",
            progress: event.loaded ?? 0,
            message: `Proofreader download ${(event.loaded * 100).toFixed(1)}%`,
          });
        });
      },
      signal: abortController.signal,
    });

    console.info(`${LOG_PREFIX} Modern proofreader session created.`);
    updateModelStatus("proofreader", { state: "ready", progress: 1, message: "Proofreader ready." });
    activeHandle = handle;
    return handle;
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to create proofreader`, error);
    updateModelStatus("proofreader", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function ensureProofreader(): Promise<ModernProofreaderHandle | null> {
  if (activeHandle) {
    return activeHandle;
  }

  if (!loadingPromise) {
    loadingPromise = instantiateProofreader();
  }

  const handle = await loadingPromise;

  if (!handle) {
    loadingPromise = null;
  }

  return handle;
}

export async function proofreadText(input: string): Promise<ProofreaderResult | null> {
  if (!input) {
    console.debug(`${LOG_PREFIX} Skipping proofread due to empty input.`);
    return null;
  }

  console.log(`${LOG_PREFIX} Proofreading text: "${input}"`);
  const handle = await ensureProofreader();
  if (!handle) {
    console.warn(`${LOG_PREFIX} Proofreader handle unavailable.`);
    updateModelStatus("proofreader", {
      state: "error",
      progress: 0,
      message: "Proofreader handle unavailable.",
    });
    return null;
  }

  try {
    console.debug(`${LOG_PREFIX} Invoking proofreader for text length ${input.length}.`);

    console.log(`${LOG_PREFIX} Calling handle.proofread()...`);
    const raw = await handle.proofread(input);
    console.debug(`${LOG_PREFIX} Proofreader result received.`, raw);

    if (!raw) {
      console.log(`${LOG_PREFIX} Proofreader returned null/undefined`);
      return null;
    }

    // Convert modern API result to our internal format
    const result: ProofreaderResult = {
      corrected: raw.correctedInput,
      corrections: raw.corrections.map(correction => ({
        startIndex: correction.startIndex,
        endIndex: correction.endIndex,
        correction: correction.correction,
        type: correction.type,
        explanation: correction.explanation
      }))
    };

    console.log(`${LOG_PREFIX} Proofreader normalized result:`, result);
    return result;
  } catch (error) {
    console.error(`${LOG_PREFIX} Proofread invocation failed`, error);
    updateModelStatus("proofreader", {
      state: "error",
      progress: 0,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function resetProofreaderSession() {
  if (activeHandle) {
    activeHandle.destroy?.();
    console.info(`${LOG_PREFIX} Proofreader session destroyed.`);
  }
  activeHandle = null;
  loadingPromise = null;
  updateModelStatus("proofreader", {
    state: "idle",
    progress: 0,
    message: "Proofreader reset.",
  });
}
