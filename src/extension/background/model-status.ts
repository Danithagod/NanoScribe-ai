import type { ModelIdentifier, ModelStatus, ModelStatusMap, ModelStatusState } from "../types";

type ModelStatusListener = (statuses: ModelStatusMap) => void;

const INITIAL_STATE: ModelStatusMap = {
  languageModel: {
    id: "languageModel",
    state: "idle",
    progress: 0,
    message: "Not initialized",
    updatedAt: Date.now(),
  },
  proofreader: {
    id: "proofreader",
    state: "idle",
    progress: 0,
    message: "Not initialized",
    updatedAt: Date.now(),
  },
  summarizer: {
    id: "summarizer",
    state: "idle",
    progress: 0,
    message: "Not initialized",
    updatedAt: Date.now(),
  },
};

const listeners = new Set<ModelStatusListener>();

let currentStatuses: ModelStatusMap = { ...INITIAL_STATE };

function cloneStatuses(): ModelStatusMap {
  return {
    languageModel: { ...currentStatuses.languageModel },
    proofreader: { ...currentStatuses.proofreader },
    summarizer: { ...currentStatuses.summarizer },
  };
}

function emitChange() {
  const snapshot = cloneStatuses();
  listeners.forEach((listener) => {
    try {
      listener(snapshot);
    } catch (error) {
      console.error("[NanoScribe] Model status listener failed", error);
    }
  });
}

export function getModelStatuses(): ModelStatusMap {
  return cloneStatuses();
}

export function updateModelStatus(
  id: ModelIdentifier,
  updates: Partial<Omit<ModelStatus, "id">> & { state?: ModelStatusState },
) {
  const previous = currentStatuses[id];
  const next: ModelStatus = {
    ...previous,
    ...updates,
    id,
    updatedAt: Date.now(),
  };

  // Clamp progress between 0 and 1 when provided.
  if (typeof next.progress === "number") {
    next.progress = Math.max(0, Math.min(1, next.progress));
  }

  currentStatuses = {
    ...currentStatuses,
    [id]: next,
  };

  emitChange();
}

export function resetModelStatus(id: ModelIdentifier) {
  const fallback = { ...INITIAL_STATE[id], updatedAt: Date.now() };
  currentStatuses = {
    ...currentStatuses,
    [id]: fallback,
  };
  emitChange();
}

export function addModelStatusListener(listener: ModelStatusListener): () => void {
  listeners.add(listener);
  try {
    listener(cloneStatuses());
  } catch (error) {
    console.error("[NanoScribe] Model status listener initialization failed", error);
  }
  return () => listeners.delete(listener);
}
