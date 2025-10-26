/// <reference types="chrome" />

import { addContentChunks, addOrUpdateMemory, getAllMemories, getMemoryByUrl, searchMemories } from "./background/memory-store";
import { extractContentStructure } from "./background/page-scraper";
import { generateKeyPointSummary, isSummarizerReady } from "./background/summarizer";
import { generateCompletionFromPrompt, isLanguageModelReady, rankMemoriesWithPrompt } from "./background/language-model";
import { isProofreaderReady, proofreadText } from "./background/proofreader";
import { addModelStatusListener, getModelStatuses, updateModelStatus } from "./background/model-status";
import type { AutocompleteState, CompletionResultPayload, MemoryRecord, ProofreaderFieldResult } from "./types";
import type { BackgroundResponse } from "./messaging";

export type ExtensionRuntimeMessage =
  | { type: "PING" }
  | { type: "SIDEPANEL_READY" }
  | { type: "SIDEPANEL_OPENED" }
  | { type: "SIDEPANEL_CLOSED" }
  | { type: "GET_MEMORIES" }
  | { type: "SEARCH_MEMORIES"; query: string }
  | { type: "RUN_PROOFREADER_ON_ACTIVE_FIELD" }
  | { type: "PROOFREAD_SELECTED_TEXT"; payload: { text: string; fieldId: string } }
  | { type: "REQUEST_COMPLETION"; payload: { requestId: string; fieldId: string; text: string; caretIndex: number } }
  | { type: "GET_MODEL_STATUS" }
  | { type: "GET_AUTOCOMPLETE_STATE" }
  | { type: "AUTOCOMPLETE_COMMAND"; command: "accept" | "decline" | "regenerate" | "clear" }
  | { type: "AUTOCOMPLETE_STATE_PUSH"; payload: AutocompleteState }
  | { type: "INVOKE_LANGUAGE_MODEL" }
  | { type: "INVOKE_PROOFREADER" }
  | { type: "TEST_COMPLETION" }
  | { type: "INVOKE_SUMMARIZER" }
  | { type: "OPEN_PROOFREADER"; payload: { text: string; sessionId?: string } }
  | { type: "APPLY_PROOFREADER_CORRECTIONS"; payload: { correctedText: string; originalText: string; sessionId?: string } }
  | { type: "APPLY_SINGLE_CORRECTION"; payload: { correctedText: string; originalText: string; sessionId?: string } };

type PendingSummary = {
  tabId: number;
  url: string;
  title: string;
};

const LOG_PREFIX = "[NanoScribe]";
const DWELL_DELAY_MS = 20_000;
const MIN_CONTENT_LENGTH = 300;
const DUPLICATE_COOLDOWN_MS = 1000 * 60 * 60 * 6; // 6 hours

const pendingSummaries = new Map<string, PendingSummary>();

// Track sidepanel state
let isSidepanelOpen = false;

let autocompleteState: AutocompleteState = {
  status: "idle",
  activeFieldId: null,
  caretIndex: null,
  suggestion: null,
  fieldPreview: null,
  error: null,
  updatedAt: Date.now(),
};

function cloneAutocompleteState(): AutocompleteState {
  return {
    ...autocompleteState,
    suggestion: autocompleteState.suggestion ? { ...autocompleteState.suggestion } : null,
    error: autocompleteState.error ?? null,
  };
}

function broadcast(message: unknown) {
  try {
    chrome.runtime.sendMessage(message, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError && runtimeError.message) {
        // Only log if it's not a "no listeners" error
        if (!runtimeError.message.includes("Receiving end does not exist") &&
            !runtimeError.message.includes("The message port closed before a response was received")) {
          console.debug(`${LOG_PREFIX} Broadcast warning`, runtimeError.message);
        }
      }
    });
  } catch (error) {
    console.debug(`${LOG_PREFIX} Broadcast failed`, error);
  }
}

function broadcastAutocompleteState() {
  broadcast({ type: "AUTOCOMPLETE_STATE_UPDATED", payload: cloneAutocompleteState() });
}

addModelStatusListener((statuses) => {
  broadcast({ type: "MODEL_STATUS_CHANGED", payload: statuses });
});

const summarizerStatus = {
  ready: false,
};

function getAlarmName(tabId: number) {
  return `nanoscribe::summarize::${tabId}`;
}

function isUrlEligible(url: string | undefined | null) {
  if (!url) return false;
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("about:") || url.startsWith("data:") || url.startsWith("file:")) return false;
  return url.startsWith("http://") || url.startsWith("https://");
}

function scheduleSummarization(tabId: number, url: string, title: string | undefined | null) {
  const alarmName = getAlarmName(tabId);
  pendingSummaries.set(alarmName, {
    tabId,
    url,
    title: title ?? url,
  });

  chrome.alarms.create(alarmName, { when: Date.now() + DWELL_DELAY_MS });
  console.info(`${LOG_PREFIX} Scheduled summarization for`, url);
}

function clearPendingSummary(tabId: number) {
  const alarmName = getAlarmName(tabId);
  pendingSummaries.delete(alarmName);
  chrome.alarms.clear(alarmName);
}

function fallbackSummarize(text: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (sentences.length === 0) {
    return text.slice(0, 500);
  }
  return `- ${sentences.join("\n- ")}`;
}

async function ensureSummarizerReady() {
  summarizerStatus.ready = await isSummarizerReady();
  return summarizerStatus.ready;
}

async function applyCorrection(
  payload: { correctedText: string; originalText: string; sessionId?: string },
  messageType: "APPLY_PROOFREADER_CORRECTIONS" | "APPLY_SINGLE_CORRECTION",
  successType: "CORRECTIONS_APPLIED" | "CORRECTION_APPLIED",
  logMessage: string,
  sendResponse: (response: BackgroundResponse) => void
) {
  try {
    const { correctedText, originalText, sessionId } = payload;
    console.log(`${LOG_PREFIX} 📝 ${logMessage}`);

    // Find the active tab and send message to content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(
        tab.id,
        {
          type: messageType,
          payload: { correctedText, originalText, sessionId }
        },
        (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            console.warn(`${LOG_PREFIX} Failed to apply correction`, lastError.message);
            sendResponse({ type: "ERROR", message: lastError.message });
            return;
          }

          if (response?.ok) {
            console.log(`${LOG_PREFIX} ✅ Correction applied successfully`);
            // Note: Chrome's sidePanel API doesn't have a close method, so we only update state
            // The sidepanel will close automatically when corrections are applied in the content script
            isSidepanelOpen = false;
            broadcast({ type: "SIDEPANEL_CLOSED" });
            sendResponse({ type: successType, message: response.message });
          } else {
            console.error(`${LOG_PREFIX} ❌ Failed to apply correction:`, response?.message);
            sendResponse({ type: "ERROR", message: response?.message || "Failed to apply correction" });
          }
        }
      );
    } else {
      sendResponse({ type: "ERROR", message: "No active tab found" });
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Error in ${messageType}:`, error);
    sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleSummarizeAlarm(alarmName: string) {
  const pending = pendingSummaries.get(alarmName);
  if (!pending) {
    return;
  }

  pendingSummaries.delete(alarmName);

  const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
  if (!tab || !isUrlEligible(tab.url) || tab.url !== pending.url) {
    return;
  }

  const existing = await getMemoryByUrl(pending.url);
  if (existing && Date.now() - existing.updatedAt < DUPLICATE_COOLDOWN_MS) {
    console.info(`${LOG_PREFIX} Skipping summarization, recent entry exists for`, pending.url);
    return;
  }

  const contentStructure = await extractContentStructure(pending.tabId).catch((error) => {
    console.error(`${LOG_PREFIX} Failed to extract structured content`, error);
    return { mainText: "", chunks: [] };
  });

  const readableText = contentStructure.mainText;

  if (!readableText || readableText.length < MIN_CONTENT_LENGTH) {
    console.info(`${LOG_PREFIX} Not enough content to summarize for`, pending.url);
    return;
  }

  const trimmedText = readableText.slice(0, 6_000);

  if (!summarizerStatus.ready) {
    await ensureSummarizerReady();
  }

  let summary: string | null = null;
  if (summarizerStatus.ready) {
    summary = await generateKeyPointSummary(trimmedText);
  }

  if (!summary || summary.length === 0) {
    summary = fallbackSummarize(trimmedText);
  }

  const saved = await addOrUpdateMemory({
    url: pending.url,
    title: tab.title ?? pending.title ?? pending.url,
    summary,
  });

  console.info(`${LOG_PREFIX} Saved memory for`, pending.url);

  if (contentStructure.chunks.length > 0) {
    const sessionId = crypto.randomUUID();
    const chunkDrafts: Array<{
      memoryId: string;
      sessionId: string;
      chunkTitle?: string;
      rawText: string;
      keyPoints: string;
      ordinal: number;
    }> = [];

    for (const chunk of contentStructure.chunks) {
      const trimmedText = chunk.text.slice(0, 4000);

      let keyPoints = "";
      if (summarizerStatus.ready) {
        try {
          keyPoints = (await generateKeyPointSummary(trimmedText)) ?? "";
        } catch (error) {
          console.debug(`${LOG_PREFIX} Chunk summarization failed`, error);
        }
      }

      if (!keyPoints) {
        const sentences = trimmedText.split(/[.!?]\s+/).filter(Boolean).slice(0, 3);
        keyPoints = sentences.map((sentence) => `- ${sentence}`).join("\n");
      }

      chunkDrafts.push({
        memoryId: saved.id,
        sessionId,
        chunkTitle: chunk.title,
        rawText: trimmedText,
        keyPoints,
        ordinal: chunk.ordinal,
      });
    }

    if (chunkDrafts.length > 0) {
      await addContentChunks(chunkDrafts);
    }
  }

  chrome.runtime.sendMessage(
    { type: "MEMORY_SAVED", payload: saved } satisfies {
      type: "MEMORY_SAVED";
      payload: MemoryRecord;
    },
    () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        console.debug(`${LOG_PREFIX} No listeners for MEMORY_SAVED`, runtimeError.message);
      }
    },
  );
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.info(`${LOG_PREFIX} Extension installed.`);
  } else if (details.reason === "update") {
    console.info(`${LOG_PREFIX} Extension updated to a new version.`);
  }

  ensureSummarizerReady().catch((error) => {
    console.warn(`${LOG_PREFIX} Summarizer warmup failed on install`, error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureSummarizerReady().catch((error) => {
    console.warn(`${LOG_PREFIX} Summarizer warmup failed on startup`, error);
  });
});

chrome.runtime.onMessage.addListener((message: ExtensionRuntimeMessage, _sender, sendResponse) => {
  switch (message.type) {
    case "PING": {
      sendResponse({ type: "PONG" });
      return true;
    }
    case "SIDEPANEL_READY": {
      console.info(`${LOG_PREFIX} Side panel initialized.`);
      sendResponse({ type: "ACK" });
      broadcast({ type: "MODEL_STATUS_CHANGED", payload: getModelStatuses() });
      broadcastAutocompleteState();
      return true;
    }
    case "SIDEPANEL_OPENED": {
      console.info(`${LOG_PREFIX} Side panel opened.`);
      broadcast({ type: "SIDEPANEL_OPENED" });
      sendResponse({ type: "ACK" });
      return true;
    }
    case "OPEN_PROOFREADER": {
      ;(async () => {
        try {
          const { text, sessionId } = message.payload;
          console.log(`${LOG_PREFIX} 📱 Opening proofreader for text: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);

          // Open the sidepanel programmatically
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.windowId) {
            await chrome.sidePanel.open({ windowId: tab.windowId });
            isSidepanelOpen = true;
            console.log(`${LOG_PREFIX} 📱 Sidepanel opened successfully`);
            broadcast({ type: "SIDEPANEL_OPENED" });

            // Broadcast proofreader state update
            broadcast({
              type: "PROOFREADER_STATE_UPDATED",
              payload: {
                text,
                isVisible: true,
                isLoading: true,
                corrections: [],
                error: null,
                sessionId,
                correctedText: null
              }
            });
          }

          sendResponse({ type: "ACK" });
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to open sidepanel:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "GET_MEMORIES": {
      ;(async () => {
        try {
          const memories = await getAllMemories();
          sendResponse({ type: "MEMORIES", payload: memories });
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to load memories`, error);
          sendResponse({ type: "ERROR", message: String(error) });
        }
      })();
      return true;
    }
    case "SEARCH_MEMORIES": {
      ;(async () => {
        try {
          const query = (message.query ?? "").trim();

          if (!query) {
            const all = await getAllMemories();
            sendResponse({ type: "MEMORIES", payload: all });
            return;
          }

          const allMemories = await getAllMemories();

          if (await isLanguageModelReady()) {
            const rankedIds = await rankMemoriesWithPrompt(query, allMemories);
            if (rankedIds && rankedIds.length > 0) {
              const prioritized = allMemories
                .filter((memory) => rankedIds.includes(memory.id))
                .sort((a, b) => rankedIds.indexOf(a.id) - rankedIds.indexOf(b.id));

              sendResponse({ type: "MEMORIES", payload: prioritized });
              return;
            }
          }

          const fallback = await searchMemories(query);
          sendResponse({ type: "MEMORIES", payload: fallback });
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to search memories`, error);
          sendResponse({ type: "ERROR", message: String(error) });
        }
      })();
      return true;
    }
    case "REQUEST_COMPLETION": {
      console.log(`${LOG_PREFIX} 🎯 REQUEST_COMPLETION case reached!`);
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🚀 Starting REQUEST_COMPLETION processing...`);
          const payload = message.payload;
          console.debug(`${LOG_PREFIX} Completion request`, payload);

          if (!payload?.text || !payload.text.trim()) {
            const result: CompletionResultPayload = { requestId: payload?.requestId ?? crypto.randomUUID(), suggestion: null };
            sendResponse({ type: "COMPLETION_RESULT", payload: result });
            return;
          }

          if (!(await isLanguageModelReady())) {
            console.info(`${LOG_PREFIX} Language model not ready for completion yet.`);
            const result: CompletionResultPayload = {
              requestId: payload.requestId,
              suggestion: null,
              error: "model-unavailable",
            };
            sendResponse({ type: "COMPLETION_RESULT", payload: result });
            return;
          }

          console.log(`${LOG_PREFIX} ✅ Language model is ready, proceeding with completion generation...`);

          let contextSummary: string | undefined;
          try {
            console.log(`${LOG_PREFIX} 📚 Getting memories for context...`);

            // Add timeout protection for memory retrieval
            const memoryPromise = getAllMemories();
            const memoryTimeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => {
                console.warn(`${LOG_PREFIX} ⚠️ Memory retrieval timed out after 3 seconds, proceeding without context`);
                reject(new Error("Memory retrieval timeout"));
              }, 3000);
            });

            const memories = await Promise.race([memoryPromise, memoryTimeoutPromise]);
            console.log(`${LOG_PREFIX} 📚 Found ${memories.length} memories, checking if memory ranking needed...`);

            if (memories.length > 0) {
              console.log(`${LOG_PREFIX} 📚 Ranking memories with prompt...`);
              const rankedIds = await rankMemoriesWithPrompt(payload.text, memories);
              if (rankedIds && rankedIds.length > 0) {
                console.log(`${LOG_PREFIX} 📚 Found ${rankedIds.length} relevant memories, building context summary...`);
                const relevant = rankedIds
                  .map((id) => memories.find((memory) => memory.id === id))
                  .filter((memory): memory is MemoryRecord => Boolean(memory))
                  .slice(0, 3)
                  .map((memory) => `- ${memory.title}: ${memory.summary}`);
                if (relevant.length > 0) {
                  contextSummary = relevant.join("\n");
                  console.log(`${LOG_PREFIX} 📚 Context summary built:`, contextSummary.length, "characters");
                }
              } else {
                console.log(`${LOG_PREFIX} 📚 No relevant memories found`);
              }
            } else {
              console.log(`${LOG_PREFIX} 📚 No memories available for context`);
            }
          } catch (error) {
            console.warn(`${LOG_PREFIX} ⚠️ Memory context retrieval failed or timed out, proceeding without context:`, error);
            // Continue without memory context - it's optional
          }

          // Generate completion without timeout since it's working
          const completion = await generateCompletionFromPrompt({
            text: payload.text,
            contextSummary,
          });
          console.log("[NanoScribe] Completion generation finished, result:", completion);

          const result: CompletionResultPayload = {
            requestId: payload.requestId,
            suggestion: completion,
          };

          sendResponse({ type: "COMPLETION_RESULT", payload: result });
        } catch (error) {
          console.error(`${LOG_PREFIX} Completion request failed`, error);
          const requestId = message.payload?.requestId ?? crypto.randomUUID();
          const messageText = error instanceof Error ? error.message : String(error);
          sendResponse({
            type: "COMPLETION_RESULT",
            payload: { requestId, suggestion: null, error: messageText },
          });
        }
      })();
      return true;
    }
    case "GET_MODEL_STATUS": {
      ;(async () => {
        try {
          // Check and update availability for each model
          await Promise.all([
            isLanguageModelReady(),
            isProofreaderReady(),
            isSummarizerReady(),
          ]);

          // Respond with updated statuses
          sendResponse({ type: "MODEL_STATUS", payload: getModelStatuses() });
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to check model statuses`, error);
          sendResponse({ type: "ERROR", message: String(error) });
        }
      })();
      return true;
    }
    case "GET_AUTOCOMPLETE_STATE": {
      sendResponse({ type: "AUTOCOMPLETE_STATE", payload: cloneAutocompleteState() });
      return true;
    }
    case "AUTOCOMPLETE_COMMAND": {
      ;(async () => {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (!tab?.id) {
            sendResponse({ type: "ERROR", message: "No active tab." });
            return;
          }

          chrome.tabs.sendMessage(
            tab.id,
            { type: "AUTOCOMPLETE_COMMAND", command: message.command },
            (response) => {
              const lastError = chrome.runtime.lastError;
              if (lastError) {
                console.warn(`${LOG_PREFIX} Autocomplete command delivery failed`, lastError.message);
                sendResponse({ type: "ERROR", message: lastError.message });
                return;
              }

              if (response && typeof response === "object" && "error" in response) {
                sendResponse({ type: "ERROR", message: String((response as { error: unknown }).error) });
                return;
              }

              sendResponse(response ?? { type: "ACK" });
            },
          );
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to relay autocomplete command`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "AUTOCOMPLETE_STATE_PUSH": {
      autocompleteState = { ...message.payload, updatedAt: Date.now() };
      broadcastAutocompleteState();
      sendResponse({ type: "ACK" });
      return true;
    }
    case "PROOFREAD_SELECTED_TEXT": {
      ;(async () => {
        try {
          const { text, fieldId } = message.payload;
          console.debug(`${LOG_PREFIX} Proofreading selected text: "${text}" (length: ${text.length})`);

          if (!text || !text.trim()) {
            sendResponse({ type: "PROOFREADER_FIELD_RESULT", payload: { ok: false, message: "No text provided." } });
            return;
          }

          console.log(`${LOG_PREFIX} Checking proofreader availability...`);
          if (!(await isProofreaderReady())) {
            console.log(`${LOG_PREFIX} Proofreader not ready, checking why...`);
            sendResponse({
              type: "PROOFREADER_FIELD_RESULT",
              payload: {
                ok: false,
                message: "Proofreader model still downloading. Keep the browser open for a moment.",
                fieldId,
              },
            });
            return;
          }

          console.log(`${LOG_PREFIX} Proofreader ready, calling proofreadText with text: "${text}"`);
          const proofreaderResult = await proofreadText(text);
          console.log(`${LOG_PREFIX} Proofreader result:`, proofreaderResult);

          if (!proofreaderResult) {
            sendResponse({
              type: "PROOFREADER_FIELD_RESULT",
              payload: {
                ok: false,
                message: "Proofreader returned no results.",
                fieldId,
              },
            });
            return;
          }

          const corrected = proofreaderResult?.corrected ?? proofreaderResult?.correctedInput ?? text;
          const payload: ProofreaderFieldResult = {
            ok: Boolean(proofreaderResult),
            message: proofreaderResult ? "Proofreader completed." : "Proofreader returned no changes.",
            corrected,
            corrections: proofreaderResult?.corrections ?? [],
            fieldId,
            timestamp: Date.now(),
          };

          console.log(`${LOG_PREFIX} Sending response with corrections:`, payload.corrections?.length || 0);
          sendResponse({ type: "PROOFREADER_FIELD_RESULT", payload });
        } catch (error) {
          console.error(`${LOG_PREFIX} Proofread error:`, error);
          const messageText = error instanceof Error ? error.message : String(error);
          sendResponse({
            type: "PROOFREADER_FIELD_RESULT",
            payload: {
              ok: false,
              message: `Proofreader error: ${messageText}`,
              corrections: [],
            },
          });
        }
      })();
      return true;
    }

    case "INVOKE_LANGUAGE_MODEL": {
      ;(async () => {
        try {
          // Perform a simple prompt to test the model
          const result = await generateCompletionFromPrompt({
            text: "Hello, respond with 'Model is working'.",
          });
          updateModelStatus("languageModel", { state: "ready", message: `Invoked successfully: ${result?.slice(0, 50)}...` });
          sendResponse({ type: "ACK" });
        } catch (error) {
          updateModelStatus("languageModel", { state: "error", message: error instanceof Error ? error.message : String(error) });
          sendResponse({ type: "ERROR", message: String(error) });
        }
      })();
      return true;
    }
    case "INVOKE_PROOFREADER": {
      ;(async () => {
        try {
          // Proofread a sample text to test the model
          const result = await proofreadText("Thiss is a sampel text with erors.");
          updateModelStatus("proofreader", { state: "ready", message: "Invoked successfully." });
          sendResponse({ type: "ACK" });
        } catch (error) {
          updateModelStatus("proofreader", { state: "error", message: error instanceof Error ? error.message : String(error) });
          sendResponse({ type: "ERROR", message: String(error) });
        }
      })();
      return true;
    }
    case "INVOKE_SUMMARIZER": {
      ;(async () => {
        try {
          // Summarize a sample text to test the model
          const result = await generateKeyPointSummary("This is a long article about AI. It discusses various topics in detail.");
          updateModelStatus("summarizer", { state: "ready", message: "Invoked successfully." });
          sendResponse({ type: "ACK" });
        } catch (error) {
          updateModelStatus("summarizer", { state: "error", message: error instanceof Error ? error.message : String(error) });
          sendResponse({ type: "ERROR", message: String(error) });
        }
      })();
      return true;
    }
    case "TEST_COMPLETION": {
      console.log(`${LOG_PREFIX} 🧪 TEST_COMPLETION case reached!`);
      ;(async () => {
        try {
          console.log("[NanoScribe] 🧪 Testing completion generation directly...");
          const testText = "There are my types of cars are muscle";

          const completion = await generateCompletionFromPrompt({
            text: testText,
          });

          console.log("[NanoScribe] ✅ Test completion result:", completion);
          sendResponse({ type: "ACK", message: `Test completion: ${completion || 'null'}` });
        } catch (error) {
          console.error("[NanoScribe] ❌ Test completion failed:", error);
          sendResponse({ type: "ERROR", message: String(error) });
        }
      })();
      return true;
    }

    case "APPLY_PROOFREADER_CORRECTIONS": {
      applyCorrection(
        message.payload,
        "APPLY_PROOFREADER_CORRECTIONS",
        "CORRECTIONS_APPLIED",
        "Applying all corrections",
        sendResponse
      );
      return true;
    }

    case "APPLY_SINGLE_CORRECTION": {
      applyCorrection(
        message.payload,
        "APPLY_SINGLE_CORRECTION",
        "CORRECTION_APPLIED",
        "Applying single correction",
        sendResponse
      );
      return true;
    }

    default: {
      return false;
    }
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (chrome.sidePanel?.setOptions && changeInfo.status === "complete" && tabId >= 0) {
    chrome.sidePanel
      .setOptions({
        tabId,
        enabled: true,
      })
      .catch((error) => console.debug(`${LOG_PREFIX} Unable to enable side panel`, error));
  }

  if (changeInfo.status === "loading") {
    clearPendingSummary(tabId);
    return;
  }

  if (changeInfo.status !== "complete") return;

  if (!isUrlEligible(tab.url)) return;

  scheduleSummarization(tabId, tab.url!, tab.title);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPendingSummary(tabId);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  console.log(`${LOG_PREFIX} Extension action clicked`);

  if (isSidepanelOpen) {
    // Reset sidepanel state when user clicks extension action while sidepanel is open
    // Note: The sidepanel closes automatically when corrections are applied in the content script
    isSidepanelOpen = false;
    console.log(`${LOG_PREFIX} 📱 Sidepanel state reset via action click`);
    broadcast({ type: "SIDEPANEL_CLOSED" });
  } else {
    // Open the sidepanel
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      isSidepanelOpen = true;
      console.log(`${LOG_PREFIX} 📱 Sidepanel opened via action click`);
      broadcast({ type: "SIDEPANEL_OPENED" });
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to open sidepanel:`, error);
    }
  }
});
