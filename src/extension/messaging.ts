import type {
  AskResponsePayload,
  CompletionRequestPayload,
  CompletionResultPayload,
  MemoryRecord,
  MemorySearchResult,
  ModelStatusMap,
  AutocompleteState,
  ProofreaderCorrection,
  ProofreaderFieldResult,
  SessionGroup,
  DiagnosticsSnapshot,
  DiagnosticsSettings,
} from "./types";

export type AutocompleteCommand = "accept" | "decline" | "regenerate" | "clear";

export type BackgroundRequest =
  | { type: "PING" }
  | { type: "SIDEPANEL_READY" }
  | { type: "SIDEPANEL_OPENED" }
  | { type: "SIDEPANEL_CLOSED" }
  | { type: "GET_MEMORIES" }
  | { type: "GET_MEMORIES_GROUPED" }
  | { type: "SEARCH_MEMORIES"; query: string }
  | { type: "RUN_PROOFREADER_ON_ACTIVE_FIELD" }
  | { type: "PROOFREAD_SELECTED_TEXT"; payload: { text: string; fieldId: string } }
  | { type: "REQUEST_COMPLETION"; payload: CompletionRequestPayload }
  | { type: "GET_MODEL_STATUS" }
  | { type: "REFRESH_MODEL_STATUS" }
  | { type: "GET_AUTOCOMPLETE_STATE" }
  | { type: "AUTOCOMPLETE_COMMAND"; command: AutocompleteCommand }
  | { type: "OPEN_PROOFREADER"; payload: { text: string; sessionId?: string } }
  | { type: "APPLY_PROOFREADER_CORRECTIONS"; payload: { correctedText: string; originalText: string; sessionId?: string } }
  | { type: "APPLY_SINGLE_CORRECTION"; payload: { correctedText: string; originalText: string; sessionId?: string } }
  | { type: "CANCEL_PROOFREADER_SESSION"; payload?: { sessionId?: string } }
  | { type: "AUTOCOMPLETE_STATE_PUSH"; payload: AutocompleteState }
  | { type: "INVOKE_LANGUAGE_MODEL" }
  | { type: "INVOKE_PROOFREADER" }
  | { type: "TEST_COMPLETION" }
  | { type: "INVOKE_SUMMARIZER" }
  | { type: "CLEAR_ALL_MEMORIES" }
  | { type: "DELETE_MEMORY"; memoryId: string }
  | { type: "REFRESH_MEMORIES" }
  | { type: "ASK_NANOSCRIBE"; payload: { question: string } }
  | { type: "AI_ORGANIZE_UNORGANIZED_MEMORIES" }
  | { type: "AUTO_ORGANIZE_UNORGANIZED_MEMORIES" }
  | { type: "REPROCESS_UNORGANIZED_MEMORIES" }
  | { type: "CLEANUP_UNORGANIZED_MEMORIES" }
  | { type: "FORCE_DATABASE_UPGRADE" }
  | { type: "GET_DIAGNOSTICS" }
  | { type: "UPDATE_DIAGNOSTICS_SETTINGS"; payload: DiagnosticsSettings }
  | { type: "ECHO"; payload: unknown }
  | { type: "RUN_READABILITY_TESTS" }
  | { type: "TEST_MEMORY_CREATION"; payload: { urls: string[] } }
  | { type: "TEST_DATABASE_STATUS" }
  | { type: "TEST_CONTENT_QUALITY" };

export type BackgroundResponse =
  | { type: "ACK"; message?: string }
  | { type: "PONG" }
  | { type: "MEMORIES"; payload: MemoryRecord[] }
  | { type: "MEMORIES_GROUPED"; payload: SessionGroup[] }
  | { type: "SEARCH_RESULTS"; payload: MemorySearchResult[] }
  | { type: "AI_ORGANIZE_RESULT"; payload: { organized: number; failed: number; total: number } }
  | { type: "AUTO_ORGANIZE_RESULT"; payload: { organized: number; failed: number; total: number } }
  | { type: "REPROCESS_RESULT"; payload: { reprocessed: number; failed: number; total: number } }
  | { type: "CLEANUP_RESULT"; payload: { deleted: number; total: number } }
  | { type: "ERROR"; message: string }
  | { type: "PROOFREADER_FIELD_RESULT"; payload: ProofreaderFieldResult }
  | { type: "COMPLETION_RESULT"; payload: CompletionResultPayload }
  | { type: "MODEL_STATUS"; payload: ModelStatusMap }
  | { type: "AUTOCOMPLETE_STATE"; payload: AutocompleteState }
  | { type: "DIAGNOSTICS"; payload: DiagnosticsSnapshot }
  | { type: "ASK_RESPONSE"; payload: AskResponsePayload }
  | { type: "CORRECTIONS_APPLIED"; message: string }
  | { type: "CORRECTION_APPLIED"; message: string }
  | { type: "ECHO_RESPONSE"; payload: unknown }
  | { type: "TEST_RESULTS"; payload: { baselineCount: number; finalCount: number; newMemoriesCount: number; readabilityChunksCount: number; success: boolean } }
  | { type: "DATABASE_STATUS"; payload: { memoryCount: number; totalChunks: number; readabilityChunks: number; legacyChunks: number; databaseVersion: number } }
  | { type: "QUALITY_RESULTS"; payload: { readabilityStats: { count: number; totalLength: number; avgLength: number }; legacyStats: { count: number; totalLength: number; avgLength: number }; totalAnalyzed: number; improvement: number } };

export type BackgroundEvent =
  | { type: "MEMORY_SAVED"; payload: MemoryRecord }
  | { type: "AI_ORGANIZE_PROGRESS"; payload: { stage: string; organized: number; failed: number; total: number } }
  | { type: "MEMORY_DELETED"; payload: { memoryId: string } }
  | { type: "MODEL_STATUS_CHANGED"; payload: ModelStatusMap }
  | { type: "AUTOCOMPLETE_STATE_UPDATED"; payload: AutocompleteState }
  | { type: "PROOFREADER_STATE_UPDATED"; payload: { text: string; isVisible: boolean; isLoading: boolean; corrections: ProofreaderCorrection[]; error: string | null; sessionId?: string | null; correctedText?: string | null } }
  | { type: "MEMORIES_GROUPED"; payload: SessionGroup[] }
  | { type: "SIDEPANEL_OPENED" }
  | { type: "SIDEPANEL_CLOSED" }
  | { type: "INITIAL_SETTINGS"; payload: { isContextAware: boolean } }
  | { type: "CONTEXT_AWARENESS_UPDATED"; payload: { isContextAware: boolean } }
  | { type: "DIAGNOSTICS_UPDATED"; payload: DiagnosticsSnapshot };

export function sendToBackground<T extends BackgroundRequest>(message: T): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    try {
      // Add specific logging for REQUEST_COMPLETION messages
      if (message.type === "REQUEST_COMPLETION") {
        const payload = (message as { payload: { text: string; requestId: string } }).payload;
        console.log(`[NanoScribe::Messaging] 🔄 Sending REQUEST_COMPLETION:`, {
          requestId: payload?.requestId,
          textLength: payload?.text?.length || 0,
          textPreview: payload?.text?.slice(0, 50) + (payload?.text?.length > 50 ? '...' : ''),
        });
      }

      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          // Handle extension context invalidated error specifically
          if (error.message?.includes("Extension context invalidated") ||
              error.message?.includes("Could not establish connection")) {
            console.warn("[NanoScribe::Messaging] Extension context invalidated - service worker may be restarting");
            // For proofreader requests, return a fallback response
            if (message.type === "PROOFREAD_SELECTED_TEXT") {
              resolve({
                type: "PROOFREADER_FIELD_RESULT",
                payload: {
                  ok: false,
                  message: "Extension context invalidated. Please reload the page and try again.",
                  corrections: []
                }
              });
              return;
            }
            // For other requests, reject with a specific error
            reject(new Error("Extension context invalidated. Service worker may be restarting."));
            return;
          }

          // Handle other runtime errors
          if (error.message?.includes("Receiving end does not exist")) {
            console.warn("[NanoScribe::Messaging] Service worker not available");
            reject(new Error("Service worker not available"));
            return;
          }

          reject(error);
          return;
        }

        // Add specific logging for REQUEST_COMPLETION responses
        if (message.type === "REQUEST_COMPLETION") {
          console.log(`[NanoScribe::Messaging] ✅ REQUEST_COMPLETION response received:`, response?.type);
          if (response?.type === "COMPLETION_RESULT") {
            const result = (response as { payload: { suggestion: string | null; error?: string } }).payload;
            console.log(`[NanoScribe::Messaging] 📋 Completion result:`, {
              hasSuggestion: !!result.suggestion,
              suggestionLength: result.suggestion?.length || 0,
              hasError: !!result.error,
              error: result.error || 'none'
            });
          }
        }

        resolve(response as BackgroundResponse);
      });
    } catch (error) {
      reject(error);
    }
  });
}

export function isBackgroundEvent(message: unknown): message is BackgroundEvent {
  return Boolean(
    message &&
      typeof message === "object" &&
      "type" in message &&
      (message as { type: string }).type &&
      [
        "MEMORY_SAVED",
        "MEMORY_DELETED",
        "MODEL_STATUS_CHANGED",
        "AUTOCOMPLETE_STATE_UPDATED",
        "PROOFREADER_STATE_UPDATED",
        "MEMORIES_GROUPED",
        "SIDEPANEL_OPENED",
        "SIDEPANEL_CLOSED",
        "INITIAL_SETTINGS",
        "CONTEXT_AWARENESS_UPDATED",
        "DIAGNOSTICS_UPDATED",
      ].includes(
        (message as { type: string }).type,
      ),
  );
}
