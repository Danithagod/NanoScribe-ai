export type MemoryRecord = {
  id: string;
  url: string;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
  structuredSummary?: MemoryStructuredSummary;
};

export type MemoryStructuredSummary = {
  overview: string;
  sections: MemorySummarySection[];
};

export type MemorySummarySection = {
  ordinal: number;
  title: string;
  keyPoints: string;
  charCount: number;
};

// Session-based memory grouping
export type SessionGroup = {
  sessionId: string;
  lastActivity: number; // timestamp of most recent memory in session
  memoryCount: number;
  memories: MemoryRecord[];
  title?: string;
};

// Enhanced memory record with session info
export type MemoryWithSession = MemoryRecord & {
  sessionId: string;
  sessionLastActivity: number;
};

export type ContentChunkRecord = {
  id: string;
  memoryId: string;
  sessionId: string;
  chunkTitle?: string;
  rawText: string;
  keyPoints: string;
  keywords: string[];
  ordinal: number;
  createdAt: number;
  sourceTag?: string; // New field to indicate chunk source (readability, manual, etc.)
};

export type MemorySearchResult = {
  chunk: ContentChunkRecord;
  memory: MemoryRecord | null;
};

export type AskContextItem = {
  chunkId: string;
  memoryId: string;
  keyPoints: string;
  title?: string;
  url?: string | null;
  createdAt?: number;
};

export type AskResponsePayload = {
  question: string;
  answer: string;
  status: "answered" | "no-context" | "model-unavailable" | "error";
  context: AskContextItem[];
  error?: string;
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

export type AutocompleteFieldType =
  | "generic"
  | "email"
  | "document"
  | "chat"
  | "search"
  | "code";

export type AutocompleteContextEntry = {
  id?: string;
  title: string;
  summary: string;
  source: "session" | "memory";
  url?: string;
  timestamp?: number;
};

export type CompletionRequestPayload = {
  requestId: string;
  fieldId: string;
  text: string;
  caretIndex: number;
  fieldType: AutocompleteFieldType;
  fieldLabel?: string | null;
  placeholder?: string | null;
  surroundingText?: {
    before: string;
    after: string;
  };
};

export type CompletionResultPayload = {
  requestId: string;
  suggestion: string | null;
  error?: string;
  metadata?: {
    source?: "model" | "fallback";
    fieldType?: AutocompleteFieldType;
    dropReason?: string;
  };
  contextEntries?: AutocompleteContextEntry[];
  contextSummary?: string | null;
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
  generatedAt?: number;
  contextEntries?: AutocompleteContextEntry[];
  strategy?: "model" | "fallback";
};

export type AutocompleteState = {
  status: AutocompleteStateStatus;
  activeFieldId: string | null;
  caretIndex: number | null;
  suggestion: AutocompleteSuggestion | null;
  fieldPreview: string | null;
  error?: string | null;
  contextSummary?: string | null;
  updatedAt: number;
};

export type DiagnosticsSettings = {
  verboseLogging: boolean;
  trackMetrics: boolean;
};

export type DiagnosticsMetrics = {
  completionRequested: number;
  completionSucceeded: number;
  completionFailed: number;
  completionTimeouts: number;
  completionDroppedSanitized: number;
  completionDroppedDuplicate: number;
  fallbackCompletions: number;
  rankingRequests: number;
  rankingFailures: number;
  proofreaderRequests: number;
  proofreaderFailures: number;
};

export type DiagnosticsSnapshot = {
  settings: DiagnosticsSettings;
  metrics: DiagnosticsMetrics;
  updatedAt: number;
};
