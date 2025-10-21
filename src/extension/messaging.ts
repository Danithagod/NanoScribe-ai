import type {
  CompletionRequestPayload,
  CompletionResultPayload,
  MemoryRecord,
  ModelStatusMap,
  AutocompleteState,
  ProofreaderFieldResult,
} from "./types";

export type AutocompleteCommand = "accept" | "decline" | "regenerate" | "clear";

export type BackgroundRequest =
  | { type: "PING" }
  | { type: "SIDEPANEL_READY" }
  | { type: "GET_MEMORIES" }
  | { type: "SEARCH_MEMORIES"; query: string }
  | { type: "RUN_PROOFREADER_ON_ACTIVE_FIELD" }
  | { type: "PROOFREAD_SELECTED_TEXT"; payload: { text: string; fieldId: string } }
  | { type: "REQUEST_COMPLETION"; payload: CompletionRequestPayload }
  | { type: "GET_MODEL_STATUS" }
  | { type: "GET_AUTOCOMPLETE_STATE" }
  | { type: "AUTOCOMPLETE_COMMAND"; command: AutocompleteCommand };

export type BackgroundResponse =
  | { type: "ACK" }
  | { type: "PONG" }
  | { type: "MEMORIES"; payload: MemoryRecord[] }
  | { type: "ERROR"; message: string }
  | { type: "PROOFREADER_FIELD_RESULT"; payload: ProofreaderFieldResult }
  | { type: "COMPLETION_RESULT"; payload: CompletionResultPayload }
  | { type: "MODEL_STATUS"; payload: ModelStatusMap }
  | { type: "AUTOCOMPLETE_STATE"; payload: AutocompleteState };

export type BackgroundEvent =
  | { type: "MEMORY_SAVED"; payload: MemoryRecord }
  | { type: "MODEL_STATUS_CHANGED"; payload: ModelStatusMap }
  | { type: "AUTOCOMPLETE_STATE_UPDATED"; payload: AutocompleteState };

export function sendToBackground<T extends BackgroundRequest>(message: T): Promise<BackgroundResponse> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          // Handle extension context invalidated error specifically
          if (error.message?.includes("Extension context invalidated") ||
              error.message?.includes("Could not establish connection")) {
            console.warn("Extension context invalidated - service worker may be restarting");
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
            console.warn("Service worker not available");
            reject(new Error("Service worker not available"));
            return;
          }

          reject(error);
          return;
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
      ["MEMORY_SAVED", "MODEL_STATUS_CHANGED", "AUTOCOMPLETE_STATE_UPDATED"].includes(
        (message as { type: string }).type,
      ),
  );
}
