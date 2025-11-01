import { sendToBackground } from "./messaging";
import {
  clearSession,
  getCurrentSession,
  getProofreaderSnapshot,
  markProofreaderError,
  markProofreaderRunning,
  markProofreaderSuccess,
} from "./proofreader-state";

export async function broadcastProofreaderState(reason?: string): Promise<void> {
  const snapshot = getProofreaderSnapshot();
  console.log("📤 Broadcasting proofreader state", { reason, snapshot });

  try {
    await chrome.runtime.sendMessage({
      type: "PROOFREADER_STATE_UPDATED",
      payload: {
        text: snapshot.selectedText,
        isVisible: snapshot.isVisible,
        isLoading: snapshot.isLoading,
        corrections: snapshot.corrections,
        error: snapshot.error,
        sessionId: snapshot.sessionId,
        correctedText: snapshot.correctedText,
        status: snapshot.status,
      },
    });
  } catch (error) {
    console.error("Failed to broadcast proofreader state:", error);
  }
}

export async function showProofreaderDialog(selectedText: string): Promise<void> {
  console.log("showProofreaderDialog called with text:", selectedText);

  const session = getCurrentSession();
  if (!session) {
    console.warn("showProofreaderDialog called without an active session");
    return;
  }

  await broadcastProofreaderState("show-proofreader:start");

  try {
    console.log("📤 Sending OPEN_PROOFREADER message");
    const response = await sendToBackground({
      type: "OPEN_PROOFREADER",
      payload: {
        text: selectedText,
        sessionId: session.id,
      },
    });

    console.log("✅ OPEN_PROOFREADER response received:", response.type);

    if (response.type !== "ACK") {
      const message = response.type === "ERROR" ? response.message : "Unable to open proofreader";
      markProofreaderError(session.id, message ?? "Unable to open proofreader");
      await broadcastProofreaderState("show-proofreader:error-response");
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to open proofreader. Please try again.";
    console.error("❌ Failed to open proofreader in side panel:", message);
    markProofreaderError(session.id, message);
    await broadcastProofreaderState("show-proofreader:exception");
    return;
  }

  void runProofreaderForSelection(selectedText);
}

export async function runProofreaderForSelection(text: string): Promise<void> {
  const session = getCurrentSession();
  if (!session) {
    console.warn("runProofreaderForSelection called without an active session");
    return;
  }

  markProofreaderRunning(session.id, text);
  await broadcastProofreaderState("run:start");

  try {
    const response = await sendToBackground({
      type: "PROOFREAD_SELECTED_TEXT",
      payload: {
        text,
        fieldId: "selection",
        sessionId: session.id,
      },
    });

    if (response.type !== "PROOFREADER_FIELD_RESULT") {
      console.error("❌ Unexpected response type from proofreader:", response.type);
      markProofreaderError(session.id, "Unexpected response type");
      await broadcastProofreaderState("run:unexpected-response");
      return;
    }

    const result = response.payload;
    console.log("📋 Proofreader result:", result);

    if (result.ok) {
      markProofreaderSuccess(session.id, result.corrected ?? null, result.corrections ?? []);
      await broadcastProofreaderState("run:success");
    } else {
      markProofreaderError(session.id, result.message ?? "Proofreader error");
      await broadcastProofreaderState("run:failure");
      clearSession();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proofreader request failed";
    console.error("❌ Proofreader error:", message);
    markProofreaderError(session.id, message);
    await broadcastProofreaderState("run:exception");
    clearSession();
  }
}

export async function hideProofreaderDialog(): Promise<void> {
  console.log("hideProofreaderDialog called");
  clearSession();
  await broadcastProofreaderState("hide-dialog");
}

export function renderProofreaderDialog(): void {
  console.log("renderProofreaderDialog called - using sidepanel approach");
}
