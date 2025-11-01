/// <reference types="chrome" />

import { addContentChunks, addOrUpdateMemory, clearAllMemories, forceDatabaseUpgrade, getAllMemories, getMemoryByUrl, getRecentChunksBySession, searchMemories, getAllChunks, deleteMemory, getMemoriesGroupedBySessions, autoOrganizeUnorganizedMemories, reprocessUnorganizedMemories, cleanupUnorganizedMemories, aiOrganizeUnorganizedMemories, extractKeywordsFromText, getChunksByKeywords, getMemoriesByIds, sanitizeKeyPointsText, buildStructuredSummary } from "./background/memory-store";
import { extractContentStructure } from "./background/page-scraper";
import { generateKeyPointSummary, isSummarizerReady } from "./background/summarizer";
import { generateCompletionFromPrompt, generateJsonFromPrompt, generateWithCustomPrompt, isLanguageModelReady, rankMemoriesWithPrompt } from "./background/language-model";
import { isProofreaderReady, proofreadText } from "./background/proofreader";
import { addModelStatusListener, getModelStatuses, updateModelStatus } from "./background/model-status";
import type {
  AskContextItem,
  AskResponsePayload,
  AutocompleteContextEntry,
  AutocompleteFieldType,
  AutocompleteState,
  CompletionRequestPayload,
  CompletionResultPayload,
  DiagnosticsMetrics,
  DiagnosticsSettings,
  DiagnosticsSnapshot,
  MemoryRecord,
  ProofreaderFieldResult,
} from "./types";
import type { BackgroundResponse } from "./messaging";

export type ExtensionRuntimeMessage =
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
  | { type: "GET_AUTOCOMPLETE_STATE" }
  | { type: "AUTOCOMPLETE_COMMAND"; command: "accept" | "decline" | "regenerate" | "clear" }
  | { type: "AUTOCOMPLETE_STATE_PUSH"; payload: AutocompleteState }
  | { type: "INVOKE_LANGUAGE_MODEL" }
  | { type: "INVOKE_PROOFREADER" }
  | { type: "TEST_COMPLETION" }
  | { type: "INVOKE_SUMMARIZER" }
  | { type: "OPEN_PROOFREADER"; payload: { text: string; sessionId?: string } }
  | { type: "APPLY_PROOFREADER_CORRECTIONS"; payload: { correctedText: string; originalText: string; sessionId?: string } }
  | { type: "APPLY_SINGLE_CORRECTION"; payload: { correctedText: string; originalText: string; sessionId?: string } }
  | { type: "CANCEL_PROOFREADER_SESSION"; payload?: { sessionId?: string } }
  | { type: "ASK_NANOSCRIBE"; payload: { question: string } }
  | { type: "CLEAR_ALL_MEMORIES" }
  | { type: "FORCE_DATABASE_UPGRADE" }
  | { type: "RUN_READABILITY_TESTS" }
  | { type: "TEST_MEMORY_CREATION"; payload: { urls: string[] } }
  | { type: "TEST_DATABASE_STATUS" }
  | { type: "TEST_CONTENT_QUALITY" }
  | { type: "DELETE_MEMORY"; memoryId: string }
  | { type: "REFRESH_MEMORIES" }
  | { type: "AI_ORGANIZE_UNORGANIZED_MEMORIES" }
  | { type: "AUTO_ORGANIZE_UNORGANIZED_MEMORIES" }
  | { type: "REPROCESS_UNORGANIZED_MEMORIES" }
  | { type: "CLEANUP_UNORGANIZED_MEMORIES" }
  | { type: "GET_DIAGNOSTICS" }
  | { type: "UPDATE_DIAGNOSTICS_SETTINGS"; payload: DiagnosticsSettings };

type PendingSummary = {
  tabId: number;
  url: string;
  title: string;
};

const LOG_PREFIX = "[NanoScribe]";
const DWELL_DELAY_MS = 20_000;
const MIN_CONTENT_LENGTH = 300;
const DUPLICATE_COOLDOWN_MS = 1000 * 60 * 60 * 6; // 6 hours
const COMPLETION_TIMEOUT_MS = 45_000;
const MAX_COMPLETION_RETRIES = 1;
const COMPLETION_RETRY_DELAY_MS = 3_000;
const COMPLETION_RETRY_COOLDOWN_MS = 5_000;

const pendingSummaries = new Map<string, PendingSummary>();

// Track sidepanel state
let isSidepanelOpen = false;

const DEFAULT_DIAGNOSTICS_SETTINGS: DiagnosticsSettings = {
  verboseLogging: false,
  trackMetrics: true,
};

const DEFAULT_DIAGNOSTICS_METRICS: DiagnosticsMetrics = {
  completionRequested: 0,
  completionSucceeded: 0,
  completionFailed: 0,
  completionTimeouts: 0,
  completionDroppedSanitized: 0,
  completionDroppedDuplicate: 0,
  fallbackCompletions: 0,
  rankingRequests: 0,
  rankingFailures: 0,
  proofreaderRequests: 0,
  proofreaderFailures: 0,
};

const diagnosticsSettings: DiagnosticsSettings = { ...DEFAULT_DIAGNOSTICS_SETTINGS };
const diagnosticsMetrics: DiagnosticsMetrics = { ...DEFAULT_DIAGNOSTICS_METRICS };

let diagnosticsMetricsPersistTimer: ReturnType<typeof setTimeout> | null = null;

function logVerbose(...args: unknown[]) {
  if (!diagnosticsSettings.verboseLogging) {
    return;
  }
  console.debug(`${LOG_PREFIX} 🪵`, ...args);
}

function getDiagnosticsSnapshot(): DiagnosticsSnapshot {
  return {
    settings: { ...diagnosticsSettings },
    metrics: { ...diagnosticsMetrics },
    updatedAt: Date.now(),
  };
}

function broadcastDiagnosticsUpdate() {
  const snapshot = getDiagnosticsSnapshot();
  broadcast({ type: "DIAGNOSTICS_UPDATED", payload: snapshot });
}

function persistDiagnosticsSettings() {
  chrome.storage.local.set({ diagnosticsSettings: { ...diagnosticsSettings } });
}

function scheduleDiagnosticsMetricsPersist() {
  if (diagnosticsMetricsPersistTimer !== null) {
    return;
  }

  diagnosticsMetricsPersistTimer = setTimeout(() => {
    chrome.storage.local.set({ diagnosticsMetrics: { ...diagnosticsMetrics } });
    diagnosticsMetricsPersistTimer = null;
  }, 500);
}

function recordCompletionMetric(
  event: "requested" | "succeeded" | "failed" | "timeout" | "dropped-sanitized" | "dropped-duplicate",
) {
  if (!diagnosticsSettings.trackMetrics) {
    return;
  }

  switch (event) {
    case "requested":
      diagnosticsMetrics.completionRequested += 1;
      break;
    case "succeeded":
      diagnosticsMetrics.completionSucceeded += 1;
      break;
    case "failed":
      diagnosticsMetrics.completionFailed += 1;
      break;
    case "timeout":
      diagnosticsMetrics.completionTimeouts += 1;
      break;
    case "dropped-sanitized":
      diagnosticsMetrics.completionDroppedSanitized += 1;
      break;
    case "dropped-duplicate":
      diagnosticsMetrics.completionDroppedDuplicate += 1;
      break;
    default:
      break;
  }

  logVerbose("Diagnostics metrics updated", { ...diagnosticsMetrics });
  broadcastDiagnosticsUpdate();
  scheduleDiagnosticsMetricsPersist();
}

chrome.storage.local
  .get(["diagnosticsSettings", "diagnosticsMetrics"])
  .then((stored) => {
    if (stored.diagnosticsSettings) {
      Object.assign(diagnosticsSettings, DEFAULT_DIAGNOSTICS_SETTINGS, stored.diagnosticsSettings as DiagnosticsSettings);
    } else {
      persistDiagnosticsSettings();
    }

    if (stored.diagnosticsMetrics) {
      Object.assign(diagnosticsMetrics, DEFAULT_DIAGNOSTICS_METRICS, stored.diagnosticsMetrics as DiagnosticsMetrics);
    } else {
      chrome.storage.local.set({ diagnosticsMetrics: { ...diagnosticsMetrics } });
    }

    broadcastDiagnosticsUpdate();
  })
  .catch((error) => {
    console.warn(`${LOG_PREFIX} Failed to restore diagnostics from storage`, error);
  });

type PendingCompletionRecord = CompletionRequestPayload & {
  createdAt: number;
  retries: number;
  tabId?: number;
  lastRetryAt?: number;
};

const pendingCompletions = new Map<string, PendingCompletionRecord>();
const pendingByField = new Map<string, string>();

function trackPendingCompletion(payload: CompletionRequestPayload, tabId?: number) {
  const existingRequestId = pendingByField.get(payload.fieldId);
  if (existingRequestId && existingRequestId !== payload.requestId) {
    pendingCompletions.delete(existingRequestId);
  }

  logVerbose("Tracking completion request", {
    fieldId: payload.fieldId,
    requestId: payload.requestId,
    tabId,
  });

  pendingByField.set(payload.fieldId, payload.requestId);
  pendingCompletions.set(payload.requestId, {
    ...payload,
    createdAt: Date.now(),
    retries: 0,
    tabId,
  });
}

function finalizePendingCompletion(requestId: string) {
  const record = pendingCompletions.get(requestId);
  if (record) {
    const { fieldId } = record;
    if (pendingByField.get(fieldId) === requestId) {
      pendingByField.delete(fieldId);
    }
  }
  pendingCompletions.delete(requestId);
}

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [requestId, record] of pendingCompletions) {
    if (record.createdAt < cutoff) {
      console.warn(`${LOG_PREFIX} ⚠️ Cleaning stale pending completion`, {
        requestId,
        fieldId: record.fieldId,
      });
      finalizePendingCompletion(requestId);
    }
  }
}, 30_000);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (Object.prototype.hasOwnProperty.call(changes, "isContextAware")) {
    const newValue = changes.isContextAware.newValue ?? true;
    broadcast({ type: "CONTEXT_AWARENESS_UPDATED", payload: { isContextAware: newValue } });
  }

  let diagnosticsChanged = false;

  if (Object.prototype.hasOwnProperty.call(changes, "diagnosticsSettings")) {
    const incoming = changes.diagnosticsSettings.newValue as DiagnosticsSettings | undefined;
    if (incoming) {
      Object.assign(diagnosticsSettings, DEFAULT_DIAGNOSTICS_SETTINGS, incoming);
      diagnosticsChanged = true;
    }
  }

  if (Object.prototype.hasOwnProperty.call(changes, "diagnosticsMetrics")) {
    const incomingMetrics = changes.diagnosticsMetrics.newValue as DiagnosticsMetrics | undefined;
    if (incomingMetrics) {
      Object.assign(diagnosticsMetrics, DEFAULT_DIAGNOSTICS_METRICS, incomingMetrics);
      diagnosticsChanged = true;
    }
  }

  if (diagnosticsChanged) {
    broadcastDiagnosticsUpdate();
  }
});

async function runCompletionWithRetry(params: {
  payload: CompletionRequestPayload;
  contextEntries: AutocompleteContextEntry[];
  contextSummary: string | null;
  retryCount?: number;
}): Promise<CompletionResultPayload> {
  const { payload, contextEntries, contextSummary, retryCount = 0 } = params;
  const fieldType: AutocompleteFieldType = payload.fieldType ?? "generic";

  const record = pendingCompletions.get(payload.requestId);
  if (record) {
    record.retries = retryCount;
    record.createdAt = Date.now();
    pendingCompletions.set(payload.requestId, record);
  }

  try {
    logVerbose("Running completion attempt", {
      requestId: payload.requestId,
      retryCount,
      fieldType,
    });
    const completionPromise = generateCompletionFromPrompt({
      requestId: payload.requestId,
      text: payload.text,
      fieldType,
      fieldLabel: payload.fieldLabel,
      placeholder: payload.placeholder,
      surroundingText: payload.surroundingText,
      contextSummary,
      contextEntries,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error("Completion generation timed out"));
      }, COMPLETION_TIMEOUT_MS);
    });

    const completion = await Promise.race([completionPromise, timeoutPromise]);
    return completion;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("timed out") &&
      retryCount < MAX_COMPLETION_RETRIES
    ) {
      console.warn(`${LOG_PREFIX} ⚠️ Completion attempt timed out, retrying (${retryCount + 1}/${MAX_COMPLETION_RETRIES})`, {
        requestId: payload.requestId,
      });
      recordCompletionMetric("timeout");
      await new Promise((resolve) => setTimeout(resolve, COMPLETION_RETRY_DELAY_MS * (retryCount + 1)));
      return runCompletionWithRetry({
        payload,
        contextEntries,
        contextSummary,
        retryCount: retryCount + 1,
      });
    }
    if (record) {
      scheduleCompletionRetry(record, error instanceof Error ? error.message ?? "unknown" : String(error));
    }
    throw error;
  }
}

function scheduleCompletionRetry(record: PendingCompletionRecord, reason: string) {
  if (record.tabId == null) {
    return;
  }

  const now = Date.now();
  if (record.lastRetryAt && now - record.lastRetryAt < COMPLETION_RETRY_COOLDOWN_MS) {
    return;
  }

  record.lastRetryAt = now;

  logVerbose("Scheduling autocomplete retry", {
    fieldId: record.fieldId,
    reason,
    tabId: record.tabId,
  });

  chrome.tabs.sendMessage(
    record.tabId,
    {
      type: "RETRY_AUTOCOMPLETE",
      payload: {
        fieldId: record.fieldId,
        reason,
      },
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn(`${LOG_PREFIX} ⚠️ Failed to schedule autocomplete retry`, chrome.runtime.lastError.message);
      } else {
        logVerbose("Requested autocomplete retry", { fieldId: record.fieldId });
      }
    },
  );
}

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

// Periodic status broadcast to ensure sidepanel stays in sync
setInterval(() => {
  broadcast({ type: "MODEL_STATUS_CHANGED", payload: getModelStatuses() });
}, 30000); // Broadcast every 30 seconds

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
  console.info(`${LOG_PREFIX} 📖 Scheduled summarization for`, url, `(alarm: ${alarmName}, delay: ${DWELL_DELAY_MS}ms)`);

  sendSummaryToast(tabId, {
    state: "loading",
    title: "Tab summarization started",
    description: "Capturing this page while you read…"
  });
}

function clearPendingSummary(tabId: number) {
  const alarmName = getAlarmName(tabId);
  pendingSummaries.delete(alarmName);
  chrome.alarms.clear(alarmName);
}

async function ensureSummarizerReady() {
  const ready = await isSummarizerReady();
  summarizerStatus.ready = ready;
  console.info(`${LOG_PREFIX} Summarizer status updated: ${ready ? 'ready' : 'not ready'}`);
  return ready;
}

// New function to extract DOM with Readability from content script
async function getPageContentWithReadability(tabId: number): Promise<{ title: string; textContent: string; chunks: string[]; baseURI: string }> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      { type: "EXTRACT_WITH_READABILITY" },
      (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          console.error(`${LOG_PREFIX} Failed to extract content from tab ${tabId}:`, lastError.message);
          reject(new Error(lastError.message));
          return;
        }

        if (response?.success && response?.data) {
          console.log(`${LOG_PREFIX} ✅ Received processed content from Readability`);

          const { title, textContent, chunks, baseURI } = response.data as { title: string; textContent: string; chunks: string[]; baseURI: string };

          resolve({
            title,
            textContent,
            chunks,
            baseURI,
          });
        } else {
          const errorMsg = response?.error || "Content extraction failed";
          console.error(`${LOG_PREFIX} ❌ Content script failed to extract Readability content:`, errorMsg);

          // If content script is not available, provide a more helpful error message
          if (errorMsg.includes("Could not establish connection") || errorMsg.includes("Receiving end does not exist")) {
            console.warn(`${LOG_PREFIX} 💡 Content script not available in tab. This may happen if the tab was closed, navigated to a restricted page (chrome://, etc.), or the extension was reloaded.`);
          }

          reject(new Error(errorMsg));
        }
      }
    );
  });
}

// New Readability-based content processing function
async function processAndStoreWithReadability(url: string, title: string, textContent: string, chunks: string[], baseURI: string) {
  console.log(`${LOG_PREFIX} 📖 Processing page with Readability: ${url}`);

  try {
    console.log(`${LOG_PREFIX} ✅ Content script extracted ${textContent.length} characters of clean text`);

    if (chunks.length === 0) {
      console.warn(`${LOG_PREFIX} No valuable chunks found for ${url}`);
      return;
    }

    console.log(`${LOG_PREFIX} 📦 Created ${chunks.length} content chunks`);

    // Get current session for chunking
    const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
    if (!currentSessionId) {
      // Create a new session if none exists
      const newSessionId = crypto.randomUUID();
      await chrome.storage.local.set({
        currentSessionId: newSessionId,
        sessionLastActiveTimestamp: Date.now()
      });
      console.log(`${LOG_PREFIX} 🔄 Created new session for indexing: ${newSessionId}`);
    }

    // Store memory record
    await addOrUpdateMemory({
      url,
      title,
      summary: '', // Will be generated from chunks
      structuredSummary: undefined,
    });

    // Get the memory record we just created/updated
    const memory = await getMemoryByUrl(url);
    if (!memory) {
      console.error(`${LOG_PREFIX} Failed to retrieve memory record for ${url}`);
      return;
    }

    // Get the updated session ID (in case we just created one)
    const { currentSessionId: sessionId } = await chrome.storage.local.get('currentSessionId');

    // Generate key points for each chunk and store
    const chunkPromises = chunks.map(async (chunk, index) => {
      let keyPoints = '';
      try {
        // Try AI summarization first
        if (summarizerStatus.ready) {
          keyPoints = (await generateKeyPointSummary(chunk)) ?? '';
        }

        // Fallback to basic key points if AI fails
        if (!keyPoints) {
          const sentences = chunk.split(/[.!?]\s+/).filter(Boolean).slice(0, 3);
          keyPoints = sentences.length > 0 ? `- ${sentences.join("\n- ")}` : chunk.slice(0, 200);
        }
      } catch (error) {
        console.debug(`${LOG_PREFIX} Chunk summarization failed, using fallback`, error);
        const sentences = chunk.split(/[.!?]\s+/).filter(Boolean).slice(0, 3);
        keyPoints = sentences.length > 0 ? `- ${sentences.join("\n- ")}` : chunk.slice(0, 200);
      }

      const keywords = extractKeywordsFromText(`${title} ${keyPoints} ${chunk}`);

      return {
        memoryId: memory.id,
        sessionId,
        chunkTitle: `Section ${index + 1}`,
        rawText: chunk,
        keyPoints,
        keywords,
        ordinal: index,
        sourceTag: 'readability' // Mark as coming from Readability parsing
      };
    });

    const processedChunks = await Promise.all(chunkPromises);
    await addContentChunks(processedChunks);

    // Generate overall summary from first few chunks
    const summaryText = chunks.slice(0, 3).join('\n\n');
    let overallSummary = '';
    try {
      overallSummary = (await generateKeyPointSummary(summaryText)) ?? '';
    } catch (error) {
      const sentences = summaryText.split(/[.!?]\s+/).filter(Boolean).slice(0, 5);
      overallSummary = sentences.length > 0 ? `- ${sentences.join("\n- ")}` : summaryText.slice(0, 500);
    }

    // Update memory with generated summary
    const structuredSummary = buildStructuredSummary(processedChunks, overallSummary);

    await addOrUpdateMemory({
      url,
      title,
      summary: overallSummary,
      structuredSummary,
    });

    console.log(`${LOG_PREFIX} ✅ Successfully indexed ${url} with Readability (${chunks.length} chunks, ${processedChunks.length} processed)`);

    // Broadcast completion
    chrome.runtime.sendMessage({
      type: "MEMORY_SAVED",
      payload: await getMemoryByUrl(url)
    }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        console.debug(`${LOG_PREFIX} No listeners for MEMORY_SAVED`, runtimeError.message);
      }
    });

  } catch (error) {
    console.error(`${LOG_PREFIX} ❌ Failed to process ${url} with Readability:`, error);
  }
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
  console.log(`${LOG_PREFIX} ⏰ Alarm fired: ${alarmName}`);
  const pending = pendingSummaries.get(alarmName);
  if (!pending) {
    console.log(`${LOG_PREFIX} ⚠️ No pending summary found for alarm: ${alarmName}`);
    return;
  }

  console.log(`${LOG_PREFIX} 🔄 Processing pending summary: ${pending.url}`);
  pendingSummaries.delete(alarmName);

  const tab = await chrome.tabs.get(pending.tabId).catch(() => null);
  if (!tab || !isUrlEligible(tab.url)) {
    console.log(`${LOG_PREFIX} ⚠️ Tab ${pending.tabId} no longer eligible (URL: ${tab?.url})`);
    return;
  }

  // Additional check: ensure content script can be injected into this tab
  if (tab.status !== "complete") {
    console.log(`${LOG_PREFIX} ⚠️ Tab ${pending.tabId} is not fully loaded (status: ${tab.status})`);
    return;
  }

  // Check if this is a restricted URL that content scripts can't access
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://") || tab.url?.startsWith("about:")) {
    console.log(`${LOG_PREFIX} ⚠️ Tab ${pending.tabId} has restricted URL that content scripts cannot access: ${tab.url}`);
    return;
  }

  // Allow URL changes (e.g., from search to actual page)
  const actualUrl = tab.url!;

  const existing = await getMemoryByUrl(actualUrl);
  if (existing && Date.now() - existing.updatedAt < DUPLICATE_COOLDOWN_MS) {
    console.info(`${LOG_PREFIX} Skipping summarization, recent entry exists for`, actualUrl);
    return;
  }

  console.log(`${LOG_PREFIX} 🔄 Starting Readability-based indexing for ${actualUrl}`);

  try {
    // Use new Readability-based content extraction from content script
    const { title, textContent, chunks, baseURI } = await getPageContentWithReadability(pending.tabId);

    if (!textContent || textContent.length < 100) { // Reduced from 500 to 100 for minimal content
      console.info(`${LOG_PREFIX} Page content too small for ${actualUrl} (${textContent?.length || 0} chars)`);
      console.info(`${LOG_PREFIX} 💡 This page may have minimal content (search results, spec files, etc.)`);
      return;
    }

    // Process with Readability instead of the old extractContentStructure
    await processAndStoreWithReadability(actualUrl, title, textContent, chunks, baseURI);

  } catch (error) {
    console.error(`${LOG_PREFIX} ❌ Failed to index ${pending.url} with Readability:`, error);

    // Check if this is a content script availability issue
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("Could not establish connection") ||
        errorMessage.includes("Receiving end does not exist") ||
        errorMessage.includes("message port closed")) {
      console.warn(`${LOG_PREFIX} 💡 Content script not available in tab ${pending.tabId}. This may happen if the extension was reloaded or the tab was navigated to a restricted page. Skipping Readability indexing.`);
      return;
    }

    // For other errors, fall back to legacy method
    console.log(`${LOG_PREFIX} 🔄 Falling back to legacy content extraction for ${actualUrl}`);

    try {
      const contentStructure = await extractContentStructure(pending.tabId).catch((error) => {
        console.error(`${LOG_PREFIX} Legacy extraction also failed`, error);
        return { mainText: "", chunks: [] };
      });

      const readableText = contentStructure.mainText;

      if (!readableText || readableText.length < MIN_CONTENT_LENGTH) {
        console.info(`${LOG_PREFIX} Not enough content to summarize for`, actualUrl);
        return;
      }

      const trimmedText = readableText.slice(0, 6_000);

      // Always try to generate a summary, even if summarizer status says it's not ready
      // The generateKeyPointSummary function will handle fallback internally
      let summary: string | null = null;
      try {
        console.log(`${LOG_PREFIX} 🔄 Attempting to generate summary for ${actualUrl}`);
        summary = await generateKeyPointSummary(trimmedText);
        console.log(`${LOG_PREFIX} ✅ Summary generated: ${summary?.length || 0} characters`);
      } catch (error) {
        console.warn(`${LOG_PREFIX} ⚠️ Summary generation failed, using fallback:`, error);
        // Final fallback - basic text extraction
        const sentences = trimmedText.split(/[.!?]\s+/).filter(Boolean).slice(0, 3);
        summary = sentences.length > 0 ? `- ${sentences.join("\n- ")}` : trimmedText.slice(0, 500);
      }

      if (!summary || summary.length === 0) {
        // Ultimate fallback
        summary = trimmedText.slice(0, 500);
      }

      console.log(`${LOG_PREFIX} 📝 Final summary length: ${summary.length} characters`);

      const saved = await addOrUpdateMemory({
        url: actualUrl,
        title: tab.title ?? pending.title ?? actualUrl,
        summary,
      });

      console.info(`${LOG_PREFIX} Saved memory for`, actualUrl);

      if (contentStructure.chunks.length > 0) {
        const { currentSessionId: activeSessionId } = await chrome.storage.local.get('currentSessionId');

        const chunkPromises = contentStructure.chunks.map(async (chunk) => {
          let keyPoints = '';
          try {
            if (summarizerStatus.ready) {
              keyPoints = (await generateKeyPointSummary(chunk.text)) ?? '';
            }

            // Fallback to basic key points if AI fails
            if (!keyPoints) {
              const sentences = chunk.text.split(/[.!?]\s+/).filter(Boolean).slice(0, 3);
              keyPoints = sentences.length > 0 ? `- ${sentences.join("\n- ")}` : chunk.text.slice(0, 200);
            }
          } catch (error) {
            console.debug(`${LOG_PREFIX} Chunk summarization failed, using fallback`, error);
            const sentences = chunk.text.split(/[.!?]\s+/).filter(Boolean).slice(0, 3);
            keyPoints = sentences.length > 0 ? `- ${sentences.join("\n- ")}` : chunk.text.slice(0, 200);
          }

          const keywords = extractKeywordsFromText(`${chunk.title ?? ''} ${keyPoints} ${chunk.text}`);

          return {
            memoryId: saved.id,
            sessionId: activeSessionId,
            chunkTitle: chunk.title,
            rawText: chunk.text,
            keyPoints,
            keywords,
            ordinal: chunk.ordinal,
            sourceTag: 'legacy' // Mark as coming from legacy extraction
          };
        });

        const processedChunks = await Promise.all(chunkPromises);
        await addContentChunks(processedChunks);
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
        }
      );
    } catch (fallbackError) {
      console.error(`${LOG_PREFIX} ❌ Both Readability and legacy methods failed for ${actualUrl}:`, fallbackError);
    }
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.info(`${LOG_PREFIX} Extension installed.`);
    // Enable context-aware mode by default
    chrome.storage.local.set({ isContextAware: true });
  } else if (details.reason === "update") {
    console.info(`${LOG_PREFIX} Extension updated to a new version.`);
    // Ensure context-aware mode is enabled after update
    chrome.storage.local.get("isContextAware").then((settings) => {
      if (settings.isContextAware !== true) {
        chrome.storage.local.set({ isContextAware: true });
        console.info(`${LOG_PREFIX} Context-aware mode enabled after update.`);
      }
    });
  }

  // Always initialize summarizer status
  ensureSummarizerReady().catch((error) => {
    console.warn(`${LOG_PREFIX} Summarizer warmup failed on install`, error);
  });

  // Create context menu for summarizing selection
  try {
    chrome.contextMenus.removeAll(() => {
      // Ignore errors on removeAll during fresh install
      chrome.contextMenus.create({
        id: "nanoscribe_summarize_selection",
        title: "NanoScribe: Summarize Selection",
        contexts: ["selection"],
      }, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          console.warn(`${LOG_PREFIX} Failed to create context menu`, runtimeError.message);
        } else {
          console.info(`${LOG_PREFIX} ✅ Context menu created: NanoScribe: Summarize Selection`);
        }
      });
    });
  } catch (e) {
    console.warn(`${LOG_PREFIX} Failed to initialize context menu`, e);
  }
});

chrome.runtime.onStartup.addListener(() => {
  // Always initialize summarizer status on startup
  ensureSummarizerReady().catch((error) => {
    console.warn(`${LOG_PREFIX} Summarizer warmup failed on startup`, error);
  });
  // Ensure context menu exists after browser startup
  try {
    chrome.contextMenus.create({
      id: "nanoscribe_summarize_selection",
      title: "NanoScribe: Summarize Selection",
      contexts: ["selection"],
    }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError && !runtimeError.message.includes("Cannot create item with duplicate id")) {
        console.debug(`${LOG_PREFIX} Context menu re-create warning`, runtimeError.message);
      }
    });
  } catch (e) {
    // Ignore errors during context menu recreation on startup
  }
});

// Helper to send toast messages to a tab
function sendSummaryToast(tabId: number, payload: { state: "loading" | "success" | "error"; title?: string; description?: string }) {
  chrome.tabs.sendMessage(tabId, { type: "SHOW_SUMMARY_TOAST", payload }, () => {
    const err = chrome.runtime.lastError;
    if (err && !err.message.includes("Receiving end does not exist")) {
      console.debug(`${LOG_PREFIX} Toast send warning`, err.message);
    }
  });
}

// Context menu click handler
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "nanoscribe_summarize_selection") return;
  if (!tab?.id) return;

  const rawSelection = (info.selectionText ?? "").trim();
  if (!rawSelection) {
    sendSummaryToast(tab.id, { state: "error", title: "No selection", description: "Select text and try again." });
    return;
  }

  // Show loading toast
  sendSummaryToast(tab.id, { state: "loading", title: "Summarizing…", description: "Working on your selection." });

  // Length guard and chunking (simple trim for MVP)
  const MAX_CHARS = 12000;
  const selection = rawSelection.length > MAX_CHARS ? rawSelection.slice(0, MAX_CHARS) : rawSelection;

  try {
    // Attempt to summarize (function handles fallback internally)
    const summary = await generateKeyPointSummary(selection);
    const safeSummary = (summary ?? "").trim();
    if (!safeSummary) {
      sendSummaryToast(tab.id, { state: "error", title: "No summary", description: "Try a shorter selection." });
      return;
    }

    // Success toast
    sendSummaryToast(tab.id, { state: "success", title: "Summary ready", description: safeSummary });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendSummaryToast(tab.id, { state: "error", title: "Summarization failed", description: msg });
  }
});

chrome.runtime.onMessage.addListener((message: ExtensionRuntimeMessage, sender, sendResponse) => {
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
      broadcastDiagnosticsUpdate();
      chrome.storage.local
        .get("isContextAware")
        .then((settings) => {
          const enabled = settings.isContextAware ?? true;
          broadcast({ type: "INITIAL_SETTINGS", payload: { isContextAware: enabled } });
        })
        .catch((error) => {
          console.warn(`${LOG_PREFIX} Failed to load initial settings:`, error);
        });
      return true;
    }
    case "SIDEPANEL_OPENED": {
      console.info(`${LOG_PREFIX} Side panel opened.`);
      broadcast({ type: "SIDEPANEL_OPENED" });
      // Also broadcast current model statuses when sidepanel opens
      broadcast({ type: "MODEL_STATUS_CHANGED", payload: getModelStatuses() });
      broadcastAutocompleteState();
      broadcastDiagnosticsUpdate();
      sendResponse({ type: "ACK" });
      return true;
    }
    case "OPEN_PROOFREADER": {
      ;(async () => {
        try {
          const { text, sessionId } = message.payload;
          console.log(`${LOG_PREFIX} 📱 Opening proofreader for text: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);

          // Note: We cannot open sidepanel programmatically due to Chrome security restrictions
          // Users must open the sidepanel manually by clicking the extension icon or using the context menu
          console.log(`${LOG_PREFIX} 📱 Sidepanel must be opened manually by user (Chrome security restriction)`);

          // Instead, just broadcast proofreader state update to let sidepanel know about the session
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

          sendResponse({ type: "ACK", message: "Proofreader session created. Please open sidepanel manually to view corrections." });
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to handle proofreader request:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "ASK_NANOSCRIBE": {
      ;(async () => {
        const question = message.payload?.question?.trim() ?? "";

        const buildResponse = (payload: AskResponsePayload) => {
          sendResponse({ type: "ASK_RESPONSE", payload });
        };

        if (!question) {
          buildResponse({
            question,
            answer: "",
            status: "error",
            context: [],
            error: "Please enter a question.",
          });
          return;
        }

        try {
          const keywords = extractKeywordsFromText(question);
          const candidateChunks = await getChunksByKeywords(keywords, 50, question);

          if (candidateChunks.length === 0) {
            buildResponse({
              question,
              answer: "I couldn't find any memories related to that question.",
              status: "no-context",
              context: [],
            });
            return;
          }

          let rankedChunks = candidateChunks;

          if (await isLanguageModelReady()) {
            const listing = candidateChunks
              .map((chunk, index) => [`Chunk ${index + 1}`, `ID: ${chunk.id}`, `Title: ${chunk.chunkTitle ?? chunk.sourceTag ?? "Untitled"}`, `Key Points: ${chunk.keyPoints}`].join("\n"))
              .join("\n---\n");

            const rerankPrompt = `You are ranking stored knowledge chunks for question answering.\nQuestion: ${question}\n\nChunks:\n${listing}\n\nReturn ONLY a JSON array of the most relevant chunk IDs in order.`;

            try {
              const rerankResult = await generateJsonFromPrompt<(string | number)[]>({
                systemPrompt: "Return JSON arrays of chunk IDs ranked by relevance.",
                userPrompt: rerankPrompt,
                temperature: 0,
                topK: 1,
                timeoutMs: 20_000,
              });

              if (Array.isArray(rerankResult) && rerankResult.length > 0) {
                const ranked = rerankResult
                  .map((id) => candidateChunks.find((chunk) => chunk.id === String(id)))
                  .filter((chunk): chunk is typeof candidateChunks[number] => Boolean(chunk));

                if (ranked.length > 0) {
                  rankedChunks = ranked;
                }
              }
            } catch (error) {
              console.warn(`${LOG_PREFIX} Failed to rerank Ask NanoScribe chunks`, error);
            }
          }

          const topChunks = rankedChunks.slice(0, 8);

          const memories = await getMemoriesByIds(topChunks.map((chunk) => chunk.memoryId));
          const memoryMap = new Map(memories.map((memory) => [memory.id, memory]));

          const contextItems: AskContextItem[] = topChunks.map((chunk) => {
            const memory = memoryMap.get(chunk.memoryId);
            return {
              chunkId: chunk.id,
              memoryId: chunk.memoryId,
              keyPoints: sanitizeKeyPointsText(chunk.keyPoints || chunk.rawText || ""),
              title: memory?.title ?? chunk.chunkTitle,
              url: memory?.url ?? null,
              createdAt: chunk.createdAt,
            };
          });

          const contextText = contextItems
            .map((item, index) => {
              const title = item.title ? `Title: ${item.title}` : `Chunk ${index + 1}`;
              return `${title}\nKey Points:\n${item.keyPoints}`;
            })
            .join("\n\n");

          const qaPrompt = `You are NanoScribe, an on-device assistant answering questions from stored browsing memories.\nIf the answer is not present in the context, respond with "I couldn't find that in your memories."\n\nQuestion: ${question}\n\nContext:\n${contextText}`;

          if (!(await isLanguageModelReady())) {
            buildResponse({
              question,
              answer: "I couldn't load the language model to answer this question right now.",
              status: "model-unavailable",
              context: contextItems,
            });
            return;
          }

          const answer = await generateWithCustomPrompt({
            systemPrompt: "Answer questions only using the provided context. If no answer exists, say you couldn't find it.",
            userPrompt: qaPrompt,
            temperature: 0.2,
            topK: 4,
            timeoutMs: 30_000,
          });

          if (!answer) {
            buildResponse({
              question,
              answer: "I couldn't generate an answer from your memories.",
              status: "error",
              context: contextItems,
              error: "empty-response",
            });
            return;
          }

          const trimmed = answer.trim();

          buildResponse({
            question,
            answer: trimmed,
            status: trimmed.toLowerCase().includes("couldn't find") ? "no-context" : "answered",
            context: contextItems,
          });
        } catch (error) {
          console.error(`${LOG_PREFIX} Ask NanoScribe failed`, error);
          buildResponse({
            question,
            answer: "Something went wrong while answering that question.",
            status: "error",
            context: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return true;
    }
    case "GET_DIAGNOSTICS": {
      sendResponse({ type: "DIAGNOSTICS", payload: getDiagnosticsSnapshot() });
      return true;
    }
    case "UPDATE_DIAGNOSTICS_SETTINGS": {
      const incoming = message.payload ?? DEFAULT_DIAGNOSTICS_SETTINGS;
      Object.assign(diagnosticsSettings, DEFAULT_DIAGNOSTICS_SETTINGS, incoming);
      persistDiagnosticsSettings();
      broadcastDiagnosticsUpdate();
      sendResponse({ type: "ACK" });
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
    case "GET_MEMORIES_GROUPED": {
      ;(async () => {
        try {
          const sessionGroups = await getMemoriesGroupedBySessions();
          sendResponse({ type: "MEMORIES_GROUPED", payload: sessionGroups });
        } catch (error) {
          console.error(`${LOG_PREFIX} Failed to load grouped memories`, error);
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

          const queryKeywords = extractKeywordsFromText(query);
          const candidateChunks = await getChunksByKeywords(queryKeywords, 50, query);

          if (candidateChunks.length === 0) {
            sendResponse({ type: "SEARCH_RESULTS", payload: [] });
            return;
          }

          let rankedChunkIds: string[] = [];
          if (await isLanguageModelReady()) {
            const context = candidateChunks
              .map((chunk) => `ID: ${chunk.id}\nTitle: ${chunk.chunkTitle ?? chunk.sourceTag ?? "Untitled"}\nSummary: ${chunk.keyPoints}`)
              .join("\n---\n");

            const prompt = `You are a semantic search reranker.\nUser query: "${query}"\n\nCandidate documents:\n${context}\n\nReturn ONLY a JSON array (e.g., [12,5,2]) of up to 5 document IDs ordered by relevance.`;

            try {
              const rankingResponse = await generateJsonFromPrompt<(number | string)[]>({
                systemPrompt: "You return JSON arrays ranking relevant document IDs.",
                userPrompt: prompt,
                temperature: 0,
                topK: 1,
                timeoutMs: 20_000,
              });

              if (Array.isArray(rankingResponse)) {
                rankedChunkIds = rankingResponse.map((id) => String(id)).filter((id) => id.length > 0);
              }
            } catch (error) {
              console.warn(`${LOG_PREFIX} Failed to rerank search results`, error);
            }
          }

          const rankedCandidates =
            rankedChunkIds.length > 0
              ? rankedChunkIds
                  .map((id) => candidateChunks.find((chunk) => chunk.id === id))
                  .filter((chunk): chunk is typeof candidateChunks[number] => Boolean(chunk))
              : candidateChunks.slice(0, 5);

          const limitedCandidates = rankedCandidates.slice(0, 5);

          const memoryIds = limitedCandidates.map((chunk) => chunk.memoryId);
          const parentMemories = await getMemoriesByIds(memoryIds);
          const memoryMap = new Map(parentMemories.map((memory) => [memory.id, memory]));

          const payload = limitedCandidates.map((chunk) => ({
            chunk,
            memory: memoryMap.get(chunk.memoryId) ?? null,
          }));

          sendResponse({ type: "SEARCH_RESULTS", payload });
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
        let contextSummary: string | null = null;
        let contextEntries: AutocompleteContextEntry[] = [];

        try {
          console.log(`${LOG_PREFIX} 🚀 Starting REQUEST_COMPLETION processing...`);
          const payload = message.payload;
          console.debug(`${LOG_PREFIX} Completion request`, payload);

          trackPendingCompletion(payload, sender?.tab?.id ?? undefined);

          console.log(`${LOG_PREFIX} 🔄 [SEMANTIC-RECALL] Context-aware completion request initiated`);
          console.log(`${LOG_PREFIX} 📝 [SEMANTIC-RECALL] Input text: "${payload.text.slice(0, 100)}${payload.text.length > 100 ? '...' : ''}"`);
          console.log(`${LOG_PREFIX} 🎯 [SEMANTIC-RECALL] Field ID: ${payload.fieldId}`);
          console.log(`${LOG_PREFIX} 📊 [SEMANTIC-RECALL] Request ID: ${payload.requestId}`);

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
            recordCompletionMetric("failed");
            return;
          }

          console.log(`${LOG_PREFIX} ✅ Language model is ready, proceeding with completion generation...`);

          // Double-check model availability right before use
          const modelCheck = await isLanguageModelReady();
          if (!modelCheck) {
            console.warn(`${LOG_PREFIX} ⚠️ Language model became unavailable during processing`);
            const result: CompletionResultPayload = {
              requestId: payload.requestId,
              suggestion: null,
              error: "model-unavailable",
            };
            sendResponse({ type: "COMPLETION_RESULT", payload: result });
            recordCompletionMetric("failed");
            return;
          }

          recordCompletionMetric("requested");

          contextEntries = [];
          try {
            console.log(`${LOG_PREFIX} 📚 Getting memories for context...`);

            // Check if context-aware mode is enabled
            const settings = await chrome.storage.local.get("isContextAware");
            const isContextEnabled = settings.isContextAware ?? true;

            if (!isContextEnabled) {
              console.log(`${LOG_PREFIX} 🔄 Context-aware mode disabled, proceeding without context`);
            } else {
              // Get current session ID
              const sessionData = await chrome.storage.local.get(["currentSessionId", "sessionLastActiveTimestamp"]);
              const currentSessionId = sessionData.currentSessionId;
              const lastActiveTimestamp = sessionData.sessionLastActiveTimestamp || 0;

              console.log(`${LOG_PREFIX} 📊 Current session: ${currentSessionId}, last active: ${lastActiveTimestamp}`);

              if (currentSessionId) {
                // Get recent chunks from current session
                const recentChunks = await getRecentChunksBySession(currentSessionId, 10);
                console.log(`${LOG_PREFIX} 📋 Found ${recentChunks.length} recent chunks from session ${currentSessionId}`);

                if (recentChunks.length > 0) {
                  // Build context from recent chunks using their keyPoints
                  const contextParts = recentChunks.map(chunk => chunk.keyPoints).filter(Boolean);
                  recentChunks.slice(0, 5).forEach((chunk) => {
                    contextEntries.push({
                      id: chunk.id,
                      title: chunk.chunkTitle || "Recent activity",
                      summary: chunk.keyPoints || chunk.rawText.slice(0, 200),
                      source: "session",
                      timestamp: chunk.createdAt,
                    });
                  });
                  if (contextParts.length > 0) {
                    contextSummary = contextParts.join('\n---\n');
                    console.log(`${LOG_PREFIX} 📚 Built context summary from ${contextParts.length} chunks (${contextSummary.length} characters)`);
                  }
                } else {
                  console.log(`${LOG_PREFIX} 📭 No chunks found in current session`);
                }
              } else {
                console.log(`${LOG_PREFIX} 📭 No current session ID found, proceeding without context`);
              }
            }

            // Fallback to all memories if no session context available (but only if context is enabled)
            if (!contextSummary && isContextEnabled) {
              console.log(`${LOG_PREFIX} 🔄 No session context available, falling back to all memories...`);

              // Add timeout protection for memory retrieval
              const memoryPromise = getAllMemories();
              const memoryTimeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                  console.warn(`${LOG_PREFIX} ⚠️ Memory retrieval timed out after 3 seconds, proceeding without context`);
                  reject(new Error("Memory retrieval timeout"));
                }, 3000);
              });

              const memories = await Promise.race([memoryPromise, memoryTimeoutPromise]);
              console.log(`${LOG_PREFIX} 📚 Found ${memories.length} total memories, checking if memory ranking needed...`);

              if (memories.length > 0) {
                // Limit to 20 memories to avoid overwhelming the AI model
                const limitedMemories = memories.slice(0, 20);
                console.log(`${LOG_PREFIX} 📚 Ranking memories with prompt (limited to ${limitedMemories.length})...`);
                const rankedIds = await rankMemoriesWithPrompt(payload.text, limitedMemories);
                if (rankedIds && rankedIds.length > 0) {
                  console.log(`${LOG_PREFIX} 📚 Found ${rankedIds.length} relevant memories, building context summary...`);
                  const relevantMemories = rankedIds
                    .map((id) => memories.find((memory) => memory.id === id))
                    .filter((memory): memory is MemoryRecord => Boolean(memory))
                    .slice(0, 5);

                  const relevant = relevantMemories.map((memory) => `- ${memory.title}: ${memory.summary}`);
                  if (relevant.length > 0) {
                    contextSummary = relevant.join("\n");
                    console.log(`${LOG_PREFIX} 📚 Context summary built:`, contextSummary.length, "characters");
                    relevantMemories.forEach((memory) => {
                      contextEntries.push({
                        id: memory.id,
                        title: memory.title,
                        summary: memory.summary,
                        source: "memory",
                        url: memory.url,
                        timestamp: memory.updatedAt,
                      });
                    });
                  }
                } else {
                  console.log(`${LOG_PREFIX} 📚 No relevant memories found`);
                }
              } else {
                console.log(`${LOG_PREFIX} 📚 No memories available for context`);
              }
            }
          } catch (error) {
            console.warn(`${LOG_PREFIX} ⚠️ Memory context retrieval failed or timed out, proceeding without context:`, error);
            // Continue without memory context - it's optional
          }

          // Generate completion with retry support
          console.log(`${LOG_PREFIX} 🔄 Generating completion (may take up to ${COMPLETION_TIMEOUT_MS}ms)...`);
          const fieldType = payload.fieldType ?? "generic";
          const completion = await runCompletionWithRetry({
            payload,
            contextEntries,
            contextSummary,
          });

          console.log(`${LOG_PREFIX} ✨ [SEMANTIC-RECALL] Generated completion: "${completion.suggestion?.slice(0, 100)}${completion.suggestion && completion.suggestion.length > 100 ? '...' : ''}"`);
          console.log(`${LOG_PREFIX} 📊 [SEMANTIC-RECALL] Context used: ${completion.contextSummary ? 'YES' : 'NO'}${completion.contextSummary ? ` (${completion.contextSummary.length} chars)` : ''}`);
          console.log(`${LOG_PREFIX} 🎉 [SEMANTIC-RECALL] Completion request completed successfully`);

          finalizePendingCompletion(payload.requestId);
          if (completion.suggestion) {
            recordCompletionMetric("succeeded");
          } else {
            recordCompletionMetric("failed");
          }
          sendResponse({ type: "COMPLETION_RESULT", payload: completion });
        } catch (error) {
          console.error(`${LOG_PREFIX} Completion request failed`, error);
          const requestId = message.payload?.requestId ?? crypto.randomUUID();
          const messageText = error instanceof Error ? error.message : String(error);
          finalizePendingCompletion(requestId);
          if (!(error instanceof Error && error.message.includes("timed out"))) {
            recordCompletionMetric("failed");
          }
          sendResponse({
            type: "COMPLETION_RESULT",
            payload: {
              requestId,
              suggestion: null,
              error: messageText,
              contextEntries: contextEntries.length ? contextEntries : undefined,
              contextSummary,
              metadata: { source: "fallback", fieldType: message.payload?.fieldType ?? "generic" },
            },
          });
        }
      })();
      return true;
    }
    case "AUTOCOMPLETE_STATE_PUSH": {
      autocompleteState = { ...message.payload, updatedAt: Date.now() };
      if (message.payload?.suggestion?.requestId) {
        finalizePendingCompletion(message.payload.suggestion.requestId);
      }
      broadcastAutocompleteState();
      sendResponse({ type: "ACK" });
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
          const demoRequestId = crypto.randomUUID();
          const result = await generateCompletionFromPrompt({
            requestId: demoRequestId,
            text: "Hello, respond with 'Model is working'.",
            fieldType: "generic",
          });
          updateModelStatus("languageModel", {
            state: "ready",
            message: `Invoked successfully: ${result.suggestion ?? "(empty)"}`,
          });
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
            requestId: crypto.randomUUID(),
            text: testText,
            fieldType: "generic",
          });

          if (completion.suggestion) {
            console.log(`[NanoScribe] ✅ Completion obtained: ${completion.suggestion}`);
          } else {
            console.log("[NanoScribe] ⚠️ No completion obtained.");
          }
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
    case "CANCEL_PROOFREADER_SESSION": {
      ;(async () => {
        try {
          const { sessionId } = message.payload ?? {};
          const tabs = await chrome.tabs.query({});

          if (sessionId) {
            await chrome.storage.local.remove(`proofreaderSession:${sessionId}`);
          }

          await Promise.all(
            tabs.map(
              (tab) =>
                new Promise<void>((resolve) => {
                  if (!tab.id) {
                    resolve();
                    return;
                  }

                  chrome.tabs.sendMessage(
                    tab.id,
                    {
                      type: "CANCEL_PROOFREADER_SESSION",
                      payload: sessionId ? { sessionId } : undefined,
                    },
                    () => {
                      const runtimeError = chrome.runtime.lastError;
                      if (runtimeError) {
                        console.debug(`${LOG_PREFIX} Cancel notice not delivered to tab ${tab.id}:`, runtimeError.message);
                      }
                      resolve();
                    }
                  );
                })
            )
          );

          broadcast({
            type: "PROOFREADER_STATE_UPDATED",
            payload: {
              text: "",
              isVisible: false,
              isLoading: false,
              corrections: [],
              error: null,
              sessionId: null,
              correctedText: null,
              status: "idle",
            },
          });

          sendResponse({ type: "ACK" });
        } catch (error) {
          sendResponse({
            type: "ERROR",
            message: error instanceof Error ? error.message : "Failed to cancel session",
          });
        }
      })();
      return true;
    }

    case "FORCE_DATABASE_UPGRADE": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🔄 Forcing database upgrade...`);
          const result = await forceDatabaseUpgrade();
          console.log(`${LOG_PREFIX} ✅ Database upgrade completed`);

          if (result.success) {
            sendResponse({ type: "ACK", message: result.message });
          } else {
            sendResponse({ type: "ERROR", message: result.message });
          }
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Database upgrade failed:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }

    case "CLEAR_ALL_MEMORIES": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🧹 Clearing all memories...`);
          await clearAllMemories();
          console.log(`${LOG_PREFIX} ✅ All memories cleared`);
          sendResponse({ type: "ACK", message: "All memories cleared" });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Failed to clear memories:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }

    case "DELETE_MEMORY": {
      ;(async () => {
        try {
          const { memoryId } = message;
          console.log(`${LOG_PREFIX} 🗑️ Deleting memory: ${memoryId}`);

          await deleteMemory(memoryId);

          // Broadcast deletion to all sidepanels for real-time updates
          chrome.runtime.sendMessage({
            type: "MEMORY_DELETED",
            payload: { memoryId }
          }, () => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              console.debug(`${LOG_PREFIX} No listeners for MEMORY_DELETED`, runtimeError.message);
            }
          });

          sendResponse({ type: "ACK", message: "Memory deleted successfully" });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Failed to delete memory:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }

    case "REFRESH_MEMORIES": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🔄 Refreshing memories...`);
          const memories = await getAllMemories();
          console.log(`${LOG_PREFIX} ✅ Refreshed ${memories.length} memories`);
          sendResponse({ type: "MEMORIES", payload: memories });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Failed to refresh memories:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "AI_ORGANIZE_UNORGANIZED_MEMORIES": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🤖 AI-organizing unorganized memories...`);
          broadcast({ type: "AI_ORGANIZE_PROGRESS", payload: { stage: "start", organized: 0, failed: 0, total: 0 } });
          const result = await aiOrganizeUnorganizedMemories();
          console.log(`${LOG_PREFIX} ✅ AI-organization complete: ${result.organized} organized, ${result.failed} failed`);
          broadcast({ type: "AI_ORGANIZE_PROGRESS", payload: { stage: "complete", organized: result.organized, failed: result.failed, total: result.total } });
          sendResponse({ type: "AI_ORGANIZE_RESULT", payload: result });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ AI-organization failed:`, error);
          broadcast({ type: "AI_ORGANIZE_PROGRESS", payload: { stage: "error", organized: 0, failed: 0, total: 0 } });
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "AUTO_ORGANIZE_UNORGANIZED_MEMORIES": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🔄 Auto-organizing unorganized memories...`);
          const result = await autoOrganizeUnorganizedMemories();
          console.log(`${LOG_PREFIX} ✅ Auto-organization complete: ${result.organized} organized, ${result.failed} failed`);
          sendResponse({ type: "AUTO_ORGANIZE_RESULT", payload: result });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Auto-organization failed:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "REPROCESS_UNORGANIZED_MEMORIES": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🔄 Reprocessing unorganized memories...`);
          const result = await reprocessUnorganizedMemories();
          console.log(`${LOG_PREFIX} ✅ Reprocessing complete: ${result.reprocessed} reprocessed, ${result.failed} failed`);
          sendResponse({ type: "REPROCESS_RESULT", payload: result });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Reprocessing failed:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "CLEANUP_UNORGANIZED_MEMORIES": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🧹 Cleaning up unorganized memories...`);
          const result = await cleanupUnorganizedMemories();
          console.log(`${LOG_PREFIX} ✅ Cleanup complete: ${result.deleted} deleted`);
          sendResponse({ type: "CLEANUP_RESULT", payload: result });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Cleanup failed:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }

    case "RUN_READABILITY_TESTS": {
      ;(async () => {
        try {
          console.log(`${LOG_PREFIX} 🧪 Running comprehensive Readability tests...`);

          // Get baseline
          const baselineMemories = await getAllMemories();
          const baselineCount = baselineMemories.length;
          console.log(`${LOG_PREFIX} 📊 Baseline memory count: ${baselineCount}`);

          // Test URLs
          const testUrls = [
            "https://developer.mozilla.org/en-US/docs/Web/API/Readability",
            "https://en.wikipedia.org/wiki/Readability",
            "https://blog.mozilla.org/en/mozilla/readability-for-firefox/",
          ];

          let newMemoriesCount = 0;
          let readabilityChunksCount = 0;

          for (const testUrl of testUrls) {
            console.log(`${LOG_PREFIX} 🌐 Testing: ${testUrl}`);

            try {
              // CREATE A NEW TAB with the test URL (instead of looking for existing)
              console.log(`${LOG_PREFIX} 🔄 Creating tab for ${testUrl}...`);
              const tab = await chrome.tabs.create({ url: testUrl, active: false });
              console.log(`${LOG_PREFIX} ✅ Opened tab ${tab.id} for ${testUrl}`);

              // Wait for page to load (20 seconds for dwell time + processing)
              console.log(`${LOG_PREFIX} ⏳ Waiting for page load and dwell time (30 seconds)...`);
              await new Promise(resolve => setTimeout(resolve, 30000));

              // Now check if the tab still exists and process it
              const existingTab = await chrome.tabs.get(tab.id).catch(() => null);
              if (existingTab && existingTab.url === testUrl) {
                console.log(`${LOG_PREFIX} 📖 Processing tab ${tab.id} with Readability...`);

                // Ensure we have a session for testing
                const testSessionId = crypto.randomUUID();
                await chrome.storage.local.set({
                  currentSessionId: testSessionId,
                  sessionLastActiveTimestamp: Date.now()
                });
                console.log(`${LOG_PREFIX} 🔄 Created test session: ${testSessionId}`);

                // Use new Readability-based content extraction from content script
                const { title, textContent, chunks, baseURI } = await getPageContentWithReadability(tab.id);

                if (textContent && textContent.length > 100) { // Reduced threshold for tests
                  await processAndStoreWithReadability(testUrl, title, textContent, chunks, baseURI);

                  // Check for new memory
                  const updatedMemories = await getAllMemories();
                  const newMemory = updatedMemories.find(m => m.url === testUrl);

                  if (newMemory) {
                    console.log(`${LOG_PREFIX} ✅ Memory created: ${newMemory.title}`);
                    newMemoriesCount++;

                    // Count Readability chunks (get all chunks and filter)
                    const allChunks = await getAllChunks(1000);
                    const readabilityChunks = allChunks.filter(c =>
                      c.memoryId === newMemory.id && c.sourceTag === 'readability'
                    );
                    readabilityChunksCount += readabilityChunks.length;
                  }
                } else {
                  console.log(`${LOG_PREFIX} ⚠️ DOM too small for ${testUrl}`);
                }
              } else {
                console.log(`${LOG_PREFIX} ⚠️ Tab ${tab.id} no longer exists or URL changed`);
              }

              // Clean up the test tab
              await chrome.tabs.remove(tab.id).catch(() => {});
              console.log(`${LOG_PREFIX} 🗑️ Cleaned up tab ${tab.id}`);

            } catch (error) {
              console.error(`${LOG_PREFIX} ❌ Failed to test ${testUrl}:`, error);
            }
          }

          // Final results
          const finalMemories = await getAllMemories();
          const finalCount = finalMemories.length;

          console.log(`${LOG_PREFIX} 📊 Test Results:`);
          console.log(`  📚 Baseline: ${baselineCount}`);
          console.log(`  📚 Final: ${finalCount}`);
          console.log(`  🆕 New memories: ${newMemoriesCount}`);
          console.log(`  📖 Readability chunks: ${readabilityChunksCount}`);

          sendResponse({
            type: "TEST_RESULTS",
            payload: {
              baselineCount,
              finalCount,
              newMemoriesCount,
              readabilityChunksCount,
              success: newMemoriesCount > 0
            }
          });
        } catch (error) {
          console.error(`${LOG_PREFIX} ❌ Readability tests failed:`, error);
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "TEST_MEMORY_CREATION": {
      ;(async () => {
        try {
          const { urls } = message.payload;
          const results = [];

          for (const url of urls) {
            try {
              // CREATE A NEW TAB with the URL (instead of looking for existing)
              console.log(`${LOG_PREFIX} 🔄 Creating tab for ${url}...`);
              const tab = await chrome.tabs.create({ url, active: false });
              console.log(`${LOG_PREFIX} ✅ Opened tab ${tab.id} for ${url}`);

              // Wait for page to load and processing
              console.log(`${LOG_PREFIX} ⏳ Waiting for page load and processing (25 seconds)...`);
              await new Promise(resolve => setTimeout(resolve, 25000));

              // Check if tab still exists and URL matches
              const existingTab = await chrome.tabs.get(tab.id).catch(() => null);
              if (existingTab && existingTab.url?.startsWith(url)) {
                console.log(`${LOG_PREFIX} 📖 Processing tab ${tab.id} with Readability...`);

                // Ensure we have a session for testing
                const testSessionId = crypto.randomUUID();
                await chrome.storage.local.set({
                  currentSessionId: testSessionId,
                  sessionLastActiveTimestamp: Date.now()
                });
                console.log(`${LOG_PREFIX} 🔄 Created test session: ${testSessionId}`);

                const { title, textContent, chunks, baseURI } = await getPageContentWithReadability(tab.id);

                if (textContent && textContent.length > 100) { // Reduced threshold for tests
                  await processAndStoreWithReadability(url, title, textContent, chunks, baseURI);
                  results.push({ url, success: true });
                } else {
                  results.push({ url, success: false, error: "Content too small" });
                }
              } else {
                results.push({ url, success: false, error: "Tab no longer exists or URL changed" });
              }

              // Clean up
              await chrome.tabs.remove(tab.id).catch(() => {});
              console.log(`${LOG_PREFIX} 🗑️ Cleaned up tab ${tab.id}`);

            } catch (error) {
              results.push({ url, success: false, error: error instanceof Error ? error.message : String(error) });
            }
          }

          sendResponse({ type: "TEST_RESULTS", payload: results });
        } catch (error) {
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "TEST_DATABASE_STATUS": {
      ;(async () => {
        try {
          const memories = await getAllMemories();
          const allChunks = await getAllChunks(1000); // Get many chunks

          const readabilityChunks = allChunks.filter(c => c.sourceTag === 'readability');
          const legacyChunks = allChunks.filter(c => c.sourceTag === 'legacy');

          sendResponse({
            type: "DATABASE_STATUS",
            payload: {
              memoryCount: memories.length,
              totalChunks: allChunks.length,
              readabilityChunks: readabilityChunks.length,
              legacyChunks: legacyChunks.length,
              databaseVersion: 4
            }
          });
        } catch (error) {
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
    }
    case "TEST_CONTENT_QUALITY": {
      ;(async () => {
        try {
          const memories = await getAllMemories();
          const memoriesWithSummaries = memories.filter(m => m.summary && m.summary.length > 50);

          if (memoriesWithSummaries.length === 0) {
            sendResponse({
              type: "QUALITY_RESULTS",
              payload: { message: "No memories with summaries available for quality comparison" }
            });
            return;
          }

          const readabilityStats = { count: 0, totalLength: 0, avgLength: 0 };
          const legacyStats = { count: 0, totalLength: 0, avgLength: 0 };

          memoriesWithSummaries.forEach(memory => {
            const isReadability = memory.url?.includes('mozilla.org') ||
                                 memory.url?.includes('wikipedia.org') ||
                                 memory.url?.includes('chromium.org');

            if (isReadability) {
              readabilityStats.count++;
              readabilityStats.totalLength += memory.summary?.length || 0;
            } else {
              legacyStats.count++;
              legacyStats.totalLength += memory.summary?.length || 0;
            }
          });

          readabilityStats.avgLength = readabilityStats.count > 0 ?
            Math.round(readabilityStats.totalLength / readabilityStats.count) : 0;
          legacyStats.avgLength = legacyStats.count > 0 ?
            Math.round(legacyStats.totalLength / legacyStats.count) : 0;

          sendResponse({
            type: "QUALITY_RESULTS",
            payload: {
              readabilityStats,
              legacyStats,
              totalAnalyzed: memoriesWithSummaries.length,
              improvement: readabilityStats.avgLength - legacyStats.avgLength
            }
          });
        } catch (error) {
          sendResponse({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
        }
      })();
      return true;
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

  console.log(`${LOG_PREFIX} 📖 Tab updated: ${tab.url} (status: ${changeInfo.status})`);

  // Ensure we have a current session for indexing
  ;(async () => {
    const { currentSessionId } = await chrome.storage.local.get('currentSessionId');
    if (!currentSessionId) {
      const newSessionId = crypto.randomUUID();
      await chrome.storage.local.set({
        currentSessionId: newSessionId,
        sessionLastActiveTimestamp: Date.now()
      });
      console.log(`${LOG_PREFIX} 🔄 Created new session: ${newSessionId}`);
    }
  })();

  scheduleSummarization(tabId, tab.url!, tab.title);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  handleSummarizeAlarm(alarm.name);
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
