export type MemoryRecord = {
  id: string;
  url: string;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
};

export type ContentChunkRecord = {
  id: string;
  memoryId: string;
  sessionId: string;
  chunkTitle?: string;
  rawText: string;
  keyPoints: string;
  ordinal: number;
  createdAt: number;
};

export type ProofreaderCorrection = {
  startIndex: number;
  endIndex: number;
  replacement?: string;
  correction?: string;
  type?: string;
  explanation?: string;
};

export type ProofreaderTestResult = {
  ok: boolean;
  message: string;
  corrected?: string;
  corrections?: ProofreaderCorrection[];
};

export type ProofreaderFieldResult = ProofreaderTestResult & {
  fieldId?: string;
  timestamp?: number;
};

export type ModelIdentifier = "languageModel" | "proofreader" | "summarizer";

export type ModelStatusState = "idle" | "checking" | "downloading" | "ready" | "unavailable" | "error";

export type ModelStatus = {
  id: ModelIdentifier;
  state: ModelStatusState;
  progress?: number;
  message?: string;
  updatedAt: number;
};

export type ModelStatusMap = Record<ModelIdentifier, ModelStatus>;

export type CompletionRequestPayload = {
  requestId: string;
  fieldId: string;
  text: string;
  caretIndex: number;
};

export type CompletionResultPayload = {
  requestId: string;
  suggestion: string | null;
  error?: string;
};

export type FieldContentPayload = {
  fieldId: string;
  text: string;
  isContentEditable: boolean;
};

export type AutocompleteStateStatus = "idle" | "listening" | "pending" | "suggestion" | "error";

export type AutocompleteSuggestion = {
  requestId: string;
  fieldId: string;
  caretIndex: number;
  completionText: string;
};

export type AutocompleteState = {
  status: AutocompleteStateStatus;
  activeFieldId: string | null;
  caretIndex: number | null;
  suggestion: AutocompleteSuggestion | null;
  fieldPreview: string | null;
  error?: string | null;
  updatedAt: number;
};
