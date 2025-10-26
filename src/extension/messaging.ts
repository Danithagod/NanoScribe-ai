import type {
  CompletionRequestPayload,
  CompletionResultPayload,
  MemoryRecord,
  ModelStatusMap,
  AutocompleteState,
  ProofreaderFieldResult,
} from "./types";
import type { ProofreaderCorrection } from "./proofreader-state";

export type AutocompleteCommand = "accept" | "decline" | "regenerate" | "clear";

export type BackgroundRequest =
  | { type: "PING" }
  | { type: "SIDEPANEL_READY" }
  | { type: "SIDEPANEL_OPENED" }
  | { type: "SIDEPANEL_CLOSED" }
  | { type: "GET_MEMORIES" }
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
  | { type: "AUTOCOMPLETE_STATE_PUSH"; payload: AutocompleteState }
  | { type: "INVOKE_LANGUAGE_MODEL" }
  | { type: "INVOKE_PROOFREADER" }
  | { type: "TEST_COMPLETION" }
  | { type: "INVOKE_SUMMARIZER" }
  | { type: "ECHO"; payload: unknown };

export type BackgroundResponse =
  | { type: "ACK" }
  | { type: "PONG" }
  | { type: "MEMORIES"; payload: MemoryRecord[] }
  | { type: "ERROR"; message: string }
  | { type: "PROOFREADER_FIELD_RESULT"; payload: ProofreaderFieldResult }
  | { type: "COMPLETION_RESULT"; payload: CompletionResultPayload }
  | { type: "MODEL_STATUS"; payload: ModelStatusMap }
  | { type: "AUTOCOMPLETE_STATE"; payload: AutocompleteState }
  | { type: "CORRECTIONS_APPLIED"; message: string }
  | { type: "CORRECTION_APPLIED"; message: string }
  | { type: "ECHO_RESPONSE"; payload: unknown };

export type BackgroundEvent =
  | { type: "MEMORY_SAVED"; payload: MemoryRecord }
  | { type: "MODEL_STATUS_CHANGED"; payload: ModelStatusMap }
  | { type: "AUTOCOMPLETE_STATE_UPDATED"; payload: AutocompleteState }
  | { type: "PROOFREADER_STATE_UPDATED"; payload: { text: string; isVisible: boolean; isLoading: boolean; corrections: ProofreaderCorrection[]; error: string | null; sessionId?: string | null; correctedText?: string | null } }
  | { type: "SIDEPANEL_OPENED" }
  | { type: "SIDEPANEL_CLOSED" };

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
      ["MEMORY_SAVED", "MODEL_STATUS_CHANGED", "AUTOCOMPLETE_STATE_UPDATED", "PROOFREADER_STATE_UPDATED", "SIDEPANEL_OPENED", "SIDEPANEL_CLOSED"].includes(
        (message as { type: string }).type,
      ),
  );
}
