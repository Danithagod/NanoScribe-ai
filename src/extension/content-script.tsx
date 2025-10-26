import React from 'react';
import { createRoot } from 'react-dom/client';
import { sendToBackground } from "./messaging";
import { ensureFieldId } from "./content-script";
import type { AutocompleteState, AutocompleteSuggestion } from "./types";
import type { BackgroundResponse } from "./messaging";
import { proofreaderState, createProofreaderSession, updateSession, clearSession, type ProofreaderSession, type ProofreaderCorrection } from "./proofreader-state";
import {
  showProofreaderDialog,
  runProofreaderForSelection,
  hideProofreaderDialog
} from "./proofreader-utils";

const LOG_PREFIX = "[NanoScribe::Content]";
const AUTOCOMPLETE_DEBOUNCE_MS = 450;
const MIN_COMPLETION_LENGTH = 15;

type SupportedField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

type ActiveField = {
  element: SupportedField;
  fieldId: string;
};

declare global {
  interface Window {
    NanoScribeAutocomplete?: {
      schedule: () => void;
      test: () => Promise<void>;
      directTest: () => Promise<void>;
      status: () => void;
    };
  }
}

let activeField: ActiveField | null = null;
let debounceTimer: number | null = null;
let pendingRequestId: string | null = null;
let latestSuggestion: AutocompleteSuggestion | null = null;
let isSidepanelOpen: boolean = false;

let autocompleteState: AutocompleteState = {
  status: "idle",
  activeFieldId: null,
  caretIndex: null,
  suggestion: null,
  fieldPreview: null,
  error: null,
  updatedAt: Date.now(),
};

function isSupportedField(target: EventTarget | null): target is SupportedField {
  if (!target || !(target instanceof HTMLElement)) {
    console.debug(`${LOG_PREFIX} Field detection: Target is not HTMLElement`, target);
    return false;
  }

  // Check for standard form fields
  if (target instanceof HTMLTextAreaElement) {
    console.debug(`${LOG_PREFIX} Field detection: HTMLTextAreaElement detected`, target.tagName);
    return true;
  }
  if (target instanceof HTMLInputElement) {
    const isValidType = ["text", "search", "email", "url", "tel"].includes(target.type || "text");
    console.debug(`${LOG_PREFIX} Field detection: HTMLInputElement detected`, {
      tagName: target.tagName,
      type: target.type,
      isValidType,
    });
    return isValidType;
  }

  // Check for contentEditable elements
  if (target.isContentEditable && (target.contentEditable === "true" || target.contentEditable === "")) {
    console.debug(`${LOG_PREFIX} Field detection: ContentEditable element detected`, {
      tagName: target.tagName,
      contentEditable: target.contentEditable,
      textContent: target.textContent?.slice(0, 50),
    });
    return true;
  }

  console.debug(`${LOG_PREFIX} Field detection: Unsupported field type`, {
    tagName: target.tagName,
    type: target instanceof HTMLInputElement ? target.type : "N/A",
    contentEditable: target.contentEditable,
  });
  return false;
}

function isFormField(field: SupportedField): field is HTMLInputElement | HTMLTextAreaElement {
  return field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
}

function isContentEditableField(field: SupportedField): field is HTMLElement {
  return field instanceof HTMLElement && field.isContentEditable && (field.contentEditable === "true" || field.contentEditable === "");
}

function getFieldText(field: SupportedField): string {
  if (isFormField(field)) {
    return field.value || "";
  }
  if (isContentEditableField(field)) {
    return field.textContent || "";
  }
  return "";
}

function getCaretIndex(field: SupportedField): number {
  if (isFormField(field)) {
    return typeof field.selectionStart === "number" ? field.selectionStart : getFieldText(field).length;
  }
  if (isContentEditableField(field)) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      // Create a range from start of contentEditable to cursor/selection start
      const fullRange = document.createRange();
      fullRange.selectNodeContents(field);
      fullRange.setEnd(range.startContainer, range.startOffset);

      // Clone the range to avoid modifying the original selection
      const clonedRange = fullRange.cloneRange();
      return clonedRange.toString().length;
    }
    return getFieldText(field).length;
  }
  return 0;
}

function setCaretIndex(field: SupportedField, index: number): void {
  if (isFormField(field)) {
    field.selectionStart = index;
    field.selectionEnd = index;
    field.focus();
  } else if (isContentEditableField(field)) {
    const selection = window.getSelection();
    if (selection) {
      const fullText = getFieldText(field);
      if (index <= 0) {
        // Set cursor at the beginning
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (index >= fullText.length) {
        // Set cursor at the end
        const range = document.createRange();
        range.selectNodeContents(field);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        // Find the text node and offset for the given character index
        let currentIndex = 0;
        const walker = document.createTreeWalker(
          field,
          NodeFilter.SHOW_TEXT,
          null
        );

        let textNode: Text | null = null;
        let nodeOffset = 0;

        // Walk through all text nodes to find the one containing our index
        while ((textNode = walker.nextNode() as Text | null)) {
          const nodeLength = textNode.textContent?.length || 0;
          if (currentIndex + nodeLength >= index) {
            // Found the text node containing our index
            nodeOffset = index - currentIndex;
            break;
          }
          currentIndex += nodeLength;
        }

        if (textNode && nodeOffset >= 0) {
          const range = document.createRange();
          range.setStart(textNode, nodeOffset);
          range.setEnd(textNode, nodeOffset);
          selection.removeAllRanges();
          selection.addRange(range);
        } else {
          // Fallback: set at the end
          const range = document.createRange();
          range.selectNodeContents(field);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      field.focus();
    }
  }
}

function insertTextAtCaret(field: SupportedField, text: string): void {
  if (isFormField(field)) {
    const start = field.selectionStart || 0;
    const end = field.selectionEnd || 0;
    const currentValue = field.value || "";
    field.value = currentValue.slice(0, start) + text + currentValue.slice(end);
    const newPosition = start + text.length;
    field.selectionStart = newPosition;
    field.selectionEnd = newPosition;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (isContentEditableField(field)) {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
}

function buildFieldPreview(field: SupportedField, caretIndex: number): string {
  const text = getFieldText(field);
  if (!text) return "";
  const left = Math.max(0, caretIndex - 40);
  const right = Math.min(text.length, caretIndex + 40);
  const before = text.slice(left, caretIndex);
  const after = text.slice(caretIndex, right);
  return `${before}▌${after}`.trim();
}

function cloneState(): AutocompleteState {
  return {
    ...autocompleteState,
    suggestion: autocompleteState.suggestion ? { ...autocompleteState.suggestion } : null,
    error: autocompleteState.error ?? null,
  };
}

function pushState() {
  const payload = cloneState();
  try {
    chrome.runtime.sendMessage({ type: "AUTOCOMPLETE_STATE_PUSH", payload }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError && runtimeError.message && !runtimeError.message.includes("Receiving end does not exist")) {
        console.debug(`${LOG_PREFIX} Failed to push autocomplete state`, runtimeError.message);
      }
    });
  } catch (error) {
    console.debug(`${LOG_PREFIX} Unable to push autocomplete state`, error);
  }
}

function updateState(partial: Partial<AutocompleteState>) {
  autocompleteState = {
    ...autocompleteState,
    ...partial,
    updatedAt: Date.now(),
  };
  pushState();
}

function setStatus(status: AutocompleteState["status"], updates: Partial<AutocompleteState> = {}) {
  updateState({ status, ...updates });
}

function clearDebounceTimer() {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

// Ghost text overlay management for autocomplete suggestions
let ghostTextOverlay: HTMLElement | null = null;
let currentGhostText: string = '';

function createGhostTextOverlay(): HTMLElement {
  if (ghostTextOverlay) {
    return ghostTextOverlay;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: absolute;
    pointer-events: none;
    z-index: 10000;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    color: rgba(156, 163, 175, 0.6);
    white-space: pre-wrap;
    word-wrap: break-word;
    padding: 0;
    margin: 0;
    border: none;
    outline: none;
    overflow: visible;
  `;

  ghostTextOverlay = overlay;
  return overlay;
}

function removeGhostTextOverlay() {
  if (ghostTextOverlay && ghostTextOverlay.parentNode) {
    ghostTextOverlay.parentNode.removeChild(ghostTextOverlay);
    ghostTextOverlay = null;
  }
  currentGhostText = '';
}

function updateGhostTextPosition(field: SupportedField, suggestion: string) {
  if (!field || !suggestion) {
    removeGhostTextOverlay();
    return;
  }

  const overlay = createGhostTextOverlay();
  const rect = field.getBoundingClientRect();
  const computedStyle = window.getComputedStyle(field);

  // Get caret position
  const caretIndex = getCaretIndex(field);
  const textBeforeCaret = getFieldText(field).slice(0, caretIndex);

  console.log(`${LOG_PREFIX} 🎭 Updating ghost text position - Field type: ${field.tagName}, Caret: ${caretIndex}, Text length: ${getFieldText(field).length}`);

  // Create a temporary element to measure text width
  const measureDiv = document.createElement('div');
  measureDiv.style.cssText = `
    position: absolute;
    visibility: hidden;
    white-space: pre;
    font-family: ${computedStyle.fontFamily};
    font-size: ${computedStyle.fontSize};
    font-weight: ${computedStyle.fontWeight};
    line-height: ${computedStyle.lineHeight};
    letter-spacing: ${computedStyle.letterSpacing};
    padding: ${computedStyle.paddingTop} ${computedStyle.paddingRight} ${computedStyle.paddingBottom} ${computedStyle.paddingLeft};
    border: ${computedStyle.borderTopWidth} ${computedStyle.borderRightWidth} ${computedStyle.borderBottomWidth} ${computedStyle.borderLeftWidth};
    width: ${rect.width}px;
    top: ${rect.top}px;
    left: ${rect.left}px;
  `;

  measureDiv.textContent = textBeforeCaret;
  document.body.appendChild(measureDiv);

  // Calculate caret position
  let caretX = measureDiv.scrollWidth;
  let caretY = 0;

  // For contentEditable, we might need to account for line wrapping
  if (isContentEditableField(field)) {
    const lines = textBeforeCaret.split('\n');
    if (lines.length > 1) {
      caretY = (lines.length - 1) * parseFloat(computedStyle.lineHeight);
      caretX = lines[lines.length - 1].length * parseFloat(computedStyle.fontSize) * 0.6; // Approximate character width
    }
  }

  document.body.removeChild(measureDiv);

  // Position the overlay
  overlay.style.left = `${rect.left + caretX + parseInt(computedStyle.paddingLeft)}px`;
  overlay.style.top = `${rect.top + caretY + parseInt(computedStyle.paddingTop)}px`;
  overlay.style.width = `${rect.width - caretX - parseInt(computedStyle.paddingLeft) - parseInt(computedStyle.paddingRight)}px`;
  overlay.style.height = `${rect.height - parseInt(computedStyle.paddingTop) - parseInt(computedStyle.paddingBottom)}px`;
  overlay.style.fontFamily = computedStyle.fontFamily;
  overlay.style.fontSize = computedStyle.fontSize;
  overlay.style.fontWeight = computedStyle.fontWeight;
  overlay.style.lineHeight = computedStyle.lineHeight;
  overlay.style.letterSpacing = computedStyle.letterSpacing;

  // Update content
  overlay.textContent = suggestion;
  currentGhostText = suggestion;

  // Ensure it's in the DOM
  if (!overlay.parentNode) {
    document.body.appendChild(overlay);
  }
}

function displayGhostText(suggestion: string) {
  if (!activeField || !suggestion) {
    removeGhostTextOverlay();
    return;
  }

  console.info(`${LOG_PREFIX} Displaying ghost text: ${suggestion}`);
  updateGhostTextPosition(activeField.element, suggestion);
}

function hideGhostText() {
  console.info(`${LOG_PREFIX} Hiding ghost text`);
  removeGhostTextOverlay();
}

// Track caret position changes to invalidate suggestions when user moves cursor
let lastCaretIndex: number | null = null;

function handleCaretPositionChange(field: SupportedField) {
  const currentCaret = getCaretIndex(field);

  // If caret moved significantly from the suggestion position, hide suggestion
  if (latestSuggestion && Math.abs(currentCaret - latestSuggestion.caretIndex) > 1) {
    console.debug(`${LOG_PREFIX} Caret moved significantly, hiding suggestion`);
    declineSuggestion("caret moved");
    return;
  }

  // Update ghost text position if caret moved slightly (within 1 character)
  if (latestSuggestion && currentCaret !== lastCaretIndex) {
    console.debug(`${LOG_PREFIX} Updating ghost text position`);
    displayGhostText(latestSuggestion.completionText);
  }

  lastCaretIndex = currentCaret;
}



function getSelectedText(): { text: string; fieldId: string | null } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const selectedText = selection.toString().trim();

  if (selectedText.length < 15) return null;

  // For proofreader dialog, we can work with any selected text, not just form fields
  // Generate a temporary fieldId for tracking purposes
  const fieldId = `selection-${crypto.randomUUID()}`;

  return { text: selectedText, fieldId };
}









async function runAutocompleteRequest(field: SupportedField, fieldId: string) {
  const text = getFieldText(field);
  const trimmed = text.trim();
  const caretIndex = getCaretIndex(field);

  console.log(`${LOG_PREFIX} 🔍 Autocomplete request - Field: ${fieldId}, Text length: ${text.length}, Caret: ${caretIndex}`);

  updateState({
    activeFieldId: fieldId,
    caretIndex,
    fieldPreview: buildFieldPreview(field, caretIndex),
    error: null,
    suggestion: null,
  });

  if (!trimmed) {
    console.log(`${LOG_PREFIX} 📝 No text content, skipping autocomplete`);
    latestSuggestion = null;
    hideGhostText(); // Hide ghost text when no text
    setStatus("listening", {
      suggestion: null,
    });
    return;
  }

  if (trimmed.length < MIN_COMPLETION_LENGTH) {
    console.log(`${LOG_PREFIX} 📏 Text too short (${trimmed.length} < ${MIN_COMPLETION_LENGTH}), skipping autocomplete`);
    latestSuggestion = null;
    hideGhostText(); // Hide ghost text when text too short
    setStatus("listening", {
      suggestion: null,
    });
    return;
  }

  const requestId = crypto.randomUUID();
  pendingRequestId = requestId;
  console.log(`${LOG_PREFIX} 🚀 Sending autocomplete request - ID: ${requestId}, Text: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);

  setStatus("pending", {
    error: null,
    suggestion: null,
  });

  // Hide ghost text when starting new request
  hideGhostText();

  try {
    console.log(`${LOG_PREFIX} 📤 Calling sendToBackground with REQUEST_COMPLETION...`);

    // Test if service worker is still available before sending
    console.log(`${LOG_PREFIX} 🧪 Testing service worker availability before REQUEST_COMPLETION...`);
    await new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "PING" }, (response) => {
        const pingError = chrome.runtime.lastError;
        if (pingError) {
          console.error(`${LOG_PREFIX} ❌ Service worker not available for PING before completion:`, pingError);
          reject(new Error("Service worker not available"));
          return;
        }
        console.log(`${LOG_PREFIX} ✅ Service worker available for PING before completion:`, response);
        resolve();
      });
    });

    const response = await sendToBackground({
      type: "REQUEST_COMPLETION",
      payload: {
        requestId,
        fieldId,
        text,
        caretIndex,
      },
    });

    console.log(`${LOG_PREFIX} 📥 Final response:`, response.type);

    if (pendingRequestId !== requestId) {
      console.log(`${LOG_PREFIX} ⚠️ Ignoring stale completion response for request ${requestId}`);
      return;
    }

    if (response.type === "ERROR") {
      console.log(`${LOG_PREFIX} ❌ Autocomplete request failed: ${response.message}`);
      hideGhostText(); // Hide ghost text on error
      setStatus("error", { error: response.message, suggestion: null });
      return;
    }

    if (response.type !== "COMPLETION_RESULT") {
      console.log(`${LOG_PREFIX} ⚠️ Unexpected completion response: ${response.type}`);
      hideGhostText(); // Hide ghost text on unexpected response
      setStatus("error", { error: "Unexpected completion response", suggestion: null });
      return;
    }

    const result = response.payload;
    console.log(`${LOG_PREFIX} 📋 Processing completion result:`, {
      requestId: result.requestId,
      hasSuggestion: !!result.suggestion,
      suggestionLength: result.suggestion?.length || 0,
      hasError: !!result.error,
    });
    if (result.error) {
      // Check if this is a handled messaging error (like context invalidated)
      if (result.error.includes("Extension context invalidated") ||
          result.error.includes("Extension service worker") ||
          result.error.includes("service worker unavailable") ||
          result.error.includes("Language model not available (available)")) {
        console.log(`${LOG_PREFIX} ⏳ ${result.error}`);
        // Don't treat this as an error state, just log and continue
        hideGhostText();
        setStatus("listening", { suggestion: null });
        return;
      }

      console.log(`${LOG_PREFIX} ❌ Autocomplete model error: ${result.error}`);
      hideGhostText(); // Hide ghost text on error
      setStatus("error", { error: result.error, suggestion: null });
      return;
    }

    if (!result.suggestion) {
      console.log(`${LOG_PREFIX} 📭 No suggestion generated by model`);
      latestSuggestion = null;
      hideGhostText(); // Hide ghost text when no suggestion
      setStatus("listening", { suggestion: null });
      return;
    }

    console.log(`${LOG_PREFIX} ✅ Autocomplete suggestion received: "${result.suggestion}"`);
    console.log(`${LOG_PREFIX} 📊 Completion response details:`, {
      requestId: result.requestId,
      suggestionLength: result.suggestion.length,
      suggestionPreview: result.suggestion.slice(0, 50) + (result.suggestion.length > 50 ? '...' : ''),
    });

    latestSuggestion = {
      requestId,
      fieldId,
      caretIndex,
      completionText: result.suggestion,
    };

    setStatus("suggestion", {
      suggestion: { ...latestSuggestion },
      error: null,
      caretIndex,
      activeFieldId: fieldId,
      fieldPreview: buildFieldPreview(field, caretIndex),
    });

    // Display the suggestion as ghost text
    displayGhostText(result.suggestion);
  } catch (error) {
    // Only log unexpected errors that aren't handled by the messaging system
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("Extension context invalidated") ||
        errorMessage.includes("service worker") ||
        errorMessage.includes("Receiving end does not exist")) {
      console.log(`${LOG_PREFIX} ⏳ Service worker temporarily unavailable, will retry automatically`);
      hideGhostText();
      setStatus("listening", { suggestion: null });
    } else {
      console.error(`${LOG_PREFIX} 💥 Unexpected autocomplete error:`, error);
      hideGhostText();
      setStatus("error", {
        error: errorMessage,
        suggestion: null,
      });
    }
  } finally {
    if (pendingRequestId === requestId) {
      pendingRequestId = null;
    }
  }
}

function scheduleAutocomplete(field: SupportedField, fieldId: string, immediate = false) {
  console.log(`${LOG_PREFIX} 📅 scheduleAutocomplete called - Field: ${fieldId}, Immediate: ${immediate}`);
  clearDebounceTimer();

  // Hide any existing ghost text when starting new request
  hideGhostText();

  const trigger = () => {
    console.log(`${LOG_PREFIX} 🎯 Triggering autocomplete for field: ${fieldId}`);
    runAutocompleteRequest(field, fieldId).catch((error) => {
      // Only log unexpected errors that aren't handled by the messaging system
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("Extension context invalidated") ||
          errorMessage.includes("service worker") ||
          errorMessage.includes("Receiving end does not exist")) {
        console.log(`${LOG_PREFIX} ⏳ Service worker temporarily unavailable, will retry automatically`);
        setStatus("listening", { suggestion: null });
      } else {
        console.error(`${LOG_PREFIX} Unexpected autocomplete scheduling error:`, error);
        setStatus("error", {
          error: errorMessage,
          suggestion: null,
        });
      }
    });
  };

  if (immediate) {
    console.log(`${LOG_PREFIX} 🚀 Executing autocomplete immediately`);
    trigger();
  } else {
    console.log(`${LOG_PREFIX} ⏰ Scheduling autocomplete with ${AUTOCOMPLETE_DEBOUNCE_MS}ms delay`);
    debounceTimer = window.setTimeout(trigger, AUTOCOMPLETE_DEBOUNCE_MS);
  }
}

function resetActiveField(reason: string) {
activeField = null;
latestSuggestion = null;
hideGhostText(); // Hide ghost text when resetting field
clearDebounceTimer();
setStatus("idle", {
activeFieldId: null,
caretIndex: null,
suggestion: null,
fieldPreview: null,
error: reason === "error" ? autocompleteState.error : null,
});
}

function declineSuggestion(reason: string) {
if (!latestSuggestion) return;
console.info(`${LOG_PREFIX} Suggestion declined: ${reason}`);
latestSuggestion = null;
hideGhostText(); // Hide the ghost text when declining
setStatus("listening", {
suggestion: null,
error: null,
});
}

function applySuggestion(source: "keyboard" | "command" = "command"): { ok: boolean; message?: string } {
  if (!latestSuggestion || !activeField) {
    return { ok: false, message: "No suggestion available" };
  }

  if (activeField.fieldId !== latestSuggestion.fieldId) {
    return { ok: false, message: "Suggestion no longer matches active field" };
  }

  const field = activeField.element;
  const currentCaret = getCaretIndex(field);
  if (currentCaret !== latestSuggestion.caretIndex) {
    console.debug(`${LOG_PREFIX} Caret mismatch; skipping insertion.`);
    declineSuggestion("caret mismatch");
    return { ok: false, message: "Caret mismatch" };
  }

  // Use the helper function to insert text at caret
  insertTextAtCaret(field, latestSuggestion.completionText);

  const newCaret = currentCaret + latestSuggestion.completionText.length;
  setCaretIndex(field, newCaret);

  console.info(`${LOG_PREFIX} Suggestion inserted via ${source}.`);
  latestSuggestion = null;
  hideGhostText(); // Hide the ghost text when applying suggestion
  setStatus("listening", {
    suggestion: null,
    caretIndex: newCaret,
    fieldPreview: buildFieldPreview(field, newCaret),
    error: null,
  });
  return { ok: true };
}

function applyAllCorrectionsInContentScript(correctedText: string, originalText: string): { ok: boolean; message?: string } {
  try {
    const session = proofreaderState.activeSession;
    console.log('🔍 Applying corrected text - Session:', session?.id);

    if (!session || !session.selectionRange) {
      console.error('❌ No active proofreader session or selection range available');
      return { ok: false, message: "No active proofreader session or selection range available" };
    }

    const range = session.selectionRange;
    if (!range) {
      console.error('❌ No selection range available for text replacement');
      return { ok: false, message: "No selection range available" };
    }

    console.log('📝 Original text:', `"${originalText}"`);
    console.log('📝 Corrected text:', `"${correctedText}"`);

    console.log('🗑️ Deleting original content');
    range.deleteContents();

    console.log('📝 Inserting corrected text');
    const textNode = document.createTextNode(correctedText);
    range.insertNode(textNode);

    console.log('🎯 Selecting new text');
    range.selectNodeContents(textNode);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    clearSession();
    console.log('🧹 Cleared session after successful application');

    console.log(`✅ Successfully applied corrected text`);
    return { ok: true, message: `Applied corrected text` };
  } catch (error) {
    console.error('❌ Error applying corrected text in content script:', error);
    return { ok: false, message: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function applySingleCorrectionInContentScript(correctedText: string, originalText: string): { ok: boolean; message?: string } {
  try {
    // Get the current session
    const session = proofreaderState.activeSession;
    console.log('🔍 Applying single correction - Session:', session?.id);

    if (!session || !session.selectionRange) {
      console.error('❌ No active proofreader session or selection range available');
      return { ok: false, message: "No active proofreader session or selection range available" };
    }

    // Validate that the selection range is still valid in the DOM
    try {
      const range = session.selectionRange;
      if (!range || !range.commonAncestorContainer || !range.commonAncestorContainer.parentElement) {
        console.error('❌ Selection range is no longer valid in DOM');
        return { ok: false, message: "Selection range is no longer valid. Please select the text again." };
      }
      console.log('✅ Selection range is valid in DOM');
    } catch (domError) {
      console.error('❌ DOM validation error:', domError);
      return { ok: false, message: "Selection range validation failed. Please try again." };
    }

    // Verify the original text matches the session
    if (originalText !== session.selectedText) {
      console.warn('⚠️ Original text mismatch:', { expected: session.selectedText, received: originalText });
    }

    const selection = window.getSelection();
    if (!selection) {
      console.error('❌ Cannot access text selection');
      return { ok: false, message: "Cannot access text selection" };
    }

    console.log('📝 Original text:', `"${originalText}"`);
    console.log('📝 Corrected text:', `"${correctedText}"`);

    // Replace the selection from the session with the corrected text
    const range = session.selectionRange;
    console.log('🗑️ Deleting original content');
    range.deleteContents();

    console.log('📝 Inserting corrected text');
    const textNode = document.createTextNode(correctedText);
    range.insertNode(textNode);

    // Select the new text
    console.log('🎯 Selecting new text');
    range.selectNodeContents(textNode);
    selection.removeAllRanges();
    selection.addRange(range);

    // Clear the session after successful application
    clearSession();
    console.log('🧹 Cleared session after successful application');

    console.log('✅ Successfully applied single correction');
    return { ok: true, message: "Correction applied" };
  } catch (error) {
    console.error('❌ Error applying single correction in content script:', error);
    return { ok: false, message: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function handleFocusIn(event: FocusEvent) {
  const target = event.target;
  console.log(`${LOG_PREFIX} 🎯 FocusIn event detected`, {
    tagName: (target as HTMLElement)?.tagName,
    type: (target as HTMLInputElement)?.type,
    contentEditable: (target as HTMLElement)?.contentEditable,
  });

  if (!isSupportedField(target)) {
    console.log(`${LOG_PREFIX} ❌ FocusIn: Unsupported field type, resetting active field`);
    resetActiveField("unsupported target");
    return;
  }

  const element = target;
  const fieldId = ensureFieldId(element);
  activeField = { element, fieldId };

  console.log(`${LOG_PREFIX} ✅ FocusIn: Active field set`, {
    fieldId,
    fieldType: element.tagName,
    textLength: getFieldText(element).length,
    caretIndex: getCaretIndex(element),
  });

  // Hide any existing ghost text when focusing new field
  hideGhostText();

  setStatus("listening", {
    activeFieldId: fieldId,
    caretIndex: getCaretIndex(element),
    fieldPreview: buildFieldPreview(element, getCaretIndex(element)),
    error: null,
  });

  scheduleAutocomplete(element, fieldId);
}

function handleFocusOut(event: FocusEvent) {
  if (!activeField) return;
  if (event.target === activeField.element) {
    hideGhostText(); // Hide ghost text when field loses focus
    resetActiveField("focus lost");
  }
}

function handleInput(event: Event) {
  const target = event.target;
  console.log(`${LOG_PREFIX} 📝 Input event detected`, {
    tagName: (target as HTMLElement)?.tagName,
    type: (target as HTMLInputElement)?.type,
  });

  if (!isSupportedField(target)) {
    console.log(`${LOG_PREFIX} ❌ Input: Unsupported field type`);
    return;
  }

  const fieldId = ensureFieldId(target);
  if (!activeField || activeField.fieldId !== fieldId) {
    console.log(`${LOG_PREFIX} 🔄 Input: New active field detected`, { fieldId });
    activeField = { element: target, fieldId };
  }

  const text = getFieldText(target);
  console.log(`${LOG_PREFIX} 📝 Input: Field updated`, {
    fieldId,
    textLength: text.length,
    caretIndex: getCaretIndex(target),
  });

  // Hide ghost text when user types
  hideGhostText();

  scheduleAutocomplete(target, fieldId);
}

function handleKeyDown(event: KeyboardEvent) {
  if (!activeField) return;
  if (event.target !== activeField.element) return;

  // Track caret position changes for ghost text updates
  handleCaretPositionChange(activeField.element);

  if (event.key === "Tab" && !event.shiftKey && latestSuggestion) {
    event.preventDefault();
    applySuggestion("keyboard");
    return;
  }

  if (event.key === "Escape" && latestSuggestion) {
    event.preventDefault();
    declineSuggestion("escape");
    return;
  }

  // Add Ctrl+Space shortcut to manually trigger autocomplete
  if (event.ctrlKey && event.key === " " && !latestSuggestion) {
    event.preventDefault();
    scheduleAutocomplete(activeField.element, activeField.fieldId, true);
    return;
  }
}

function handleAutocompleteCommand(command: "accept" | "decline" | "regenerate" | "clear") {
  switch (command) {
    case "accept": {
      const result = applySuggestion("command");
      return result.ok ? { type: "ACK" } : { error: result.message ?? "Unable to apply suggestion" };
    }
    case "decline": {
      declineSuggestion("command");
      return { type: "ACK" };
    }
    case "clear": {
      latestSuggestion = null;
      hideGhostText(); // Hide ghost text when clearing suggestion
      setStatus("listening", { suggestion: null });
      return { type: "ACK" };
    }
    case "regenerate": {
      if (!activeField) {
        return { error: "No active field" };
      }
      scheduleAutocomplete(activeField.element, activeField.fieldId, true);
      return { type: "ACK" };
    }
    default:
      return { error: "Unknown command" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "SIDEPANEL_OPENED") {
    console.log(`${LOG_PREFIX} 📱 Sidepanel opened`);
    isSidepanelOpen = true;
    sendResponse({ type: "ACK" });
    return true;
  }

  if (message.type === "SIDEPANEL_CLOSED") {
    console.log(`${LOG_PREFIX} 📱 Sidepanel closed`);
    isSidepanelOpen = false;
    sendResponse({ type: "ACK" });
    return true;
  }

  if (message.type === "GET_ACTIVE_FIELD_CONTENT") {
    if (!activeField) {
      sendResponse({ error: "No active field" });
      return true;
    }

    const field = activeField.element;
    const response = {
      fieldId: activeField.fieldId,
      text: getFieldText(field),
      isContentEditable: isContentEditableField(field),
    };

    sendResponse(response);
    return true;
  }

  if (message.type === "AUTOCOMPLETE_COMMAND") {
    const response = handleAutocompleteCommand(message.command);
    sendResponse(response);
    return true;
  }

  if (message.type === "APPLY_PROOFREADER_CORRECTIONS") {
    const { correctedText, originalText, sessionId } = message.payload;
    console.log('📝 Content script: Applying corrected text:', `"${correctedText}"`);
    console.log('📋 Original text:', originalText);
    console.log('🔑 Session ID:', sessionId);
    console.log('📊 Current session:', proofreaderState.activeSession?.id);

    // Validate session if sessionId is provided
    if (sessionId && sessionId !== proofreaderState.activeSession?.id) {
      console.warn('⚠️ Session ID mismatch:', { expected: proofreaderState.activeSession?.id, received: sessionId });
    }

    const result = applyAllCorrectionsInContentScript(correctedText, originalText);
    console.log('✅ Correction result:', result);
    sendResponse(result);
    return true;
  }

  if (message.type === "APPLY_SINGLE_CORRECTION") {
    const { correctedText, originalText, sessionId } = message.payload;
    console.log('📝 Content script: Applying single correction:', `"${correctedText}"`);
    console.log('📋 Original text:', originalText);
    console.log('🔑 Session ID:', sessionId);
    console.log('📊 Current session:', proofreaderState.activeSession?.id);

    // Validate session if sessionId is provided
    if (sessionId && sessionId !== proofreaderState.activeSession?.id) {
      console.warn('⚠️ Session ID mismatch:', { expected: proofreaderState.activeSession?.id, received: sessionId });
    }

    const result = applySingleCorrectionInContentScript(correctedText, originalText);
    console.log('✅ Correction result:', result);
    sendResponse(result);
    return true;
  }

  if (message.type === 'EXTENSION_CONTEXT_INVALIDATED') {
    console.log('🔄 Extension context invalidated, clearing proofreader session');
    clearSession();
    sendResponse({ type: 'ACK' });
    return true;
  }

  return false;
});

function handleClick(event: MouseEvent) {
  const target = event.target;
  if (!isSupportedField(target)) {
    return;
  }

  const fieldId = ensureFieldId(target);
  if (!activeField || activeField.fieldId !== fieldId) {
    return;
  }

  // Track caret position changes for ghost text updates
  handleCaretPositionChange(activeField.element);
}

document.addEventListener("focusin", handleFocusIn, true);
document.addEventListener("focusout", handleFocusOut, true);
document.addEventListener("input", handleInput, true);
document.addEventListener("keydown", handleKeyDown, true);
document.addEventListener("click", handleClick, true);

// Add selection event listener for proofreader dialog
document.addEventListener("selectionchange", () => {
  console.log('🔍 Selection change detected');
  const selection = getSelectedText();
  console.log('Selection result:', selection);

  if (selection && selection.text && !proofreaderState.isVisible) {
    console.log('✅ Valid selection found, setting timeout');
    setTimeout(() => {
      const currentSelection = getSelectedText();
      console.log('Current selection after timeout:', currentSelection);

      if (currentSelection && currentSelection.text && currentSelection.text === selection.text) {
        console.log('✅ Selections match, showing dialog with text:', selection.text);

        // Clear any existing session before creating a new one
        if (proofreaderState.activeSession) {
          console.log('🧹 Clearing existing session before creating new one');
          clearSession();
        }

        // Store the selection range and create a session
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const selectedElement = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? range.commonAncestorContainer.parentElement
            : range.commonAncestorContainer as Element;

          // Create a new proofreader session
          const session = createProofreaderSession(selection.text, range, selectedElement);
          updateSession(session);

          console.log('📝 Created proofreader session:', session.id);
          console.log('📍 Stored selection range:', { range, selectedElement });
        }

        // Check if service worker is available before showing dialog
        chrome.runtime.sendMessage({ type: "PING" }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            console.warn('❌ Service worker not available for proofreader, skipping:', runtimeError.message);
            return;
          }

          console.log('✅ Service worker available, showing proofreader dialog');
          showProofreaderDialog(selection.text);
        });
      } else {
        console.log('❌ Selections do not match or no current selection');
      }
    }, 300);
  } else {
    console.log('❌ No valid selection or dialog already visible');
  }
});

// Add mouse click stop detection for text selection
document.addEventListener("mouseup", () => {
  console.log('🖱️ Mouse up detected');
  setTimeout(() => {
    const selection = getSelectedText();
    console.log('Mouse up - Selection result:', selection);

    if (selection && selection.text && !proofreaderState.isVisible) {
      console.log('✅ Valid selection found from mouse up, showing dialog with text:', selection.text);

      // Clear any existing session before creating a new one
      if (proofreaderState.activeSession) {
        console.log('🧹 Clearing existing session before creating new one');
        clearSession();
      }

      // Store the selection range and create a session
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const selectedElement = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
          ? range.commonAncestorContainer.parentElement
          : range.commonAncestorContainer as Element;

        // Create a new proofreader session
        const session = createProofreaderSession(selection.text, range, selectedElement);
        updateSession(session);

        console.log('📝 Created proofreader session:', session.id);
        console.log('📍 Stored selection range:', { range, selectedElement });
      }

      // Check if service worker is available before showing dialog
      chrome.runtime.sendMessage({ type: "PING" }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          console.warn('❌ Service worker not available for proofreader, skipping:', runtimeError.message);
          return;
        }

        console.log('✅ Service worker available, showing proofreader dialog');
        showProofreaderDialog(selection.text);
      });
    }
  }, 100); // Short delay for mouse up events
});


// Add session cleanup on page unload
window.addEventListener('beforeunload', () => {
  console.log('🔄 Page unloading, clearing proofreader session');
  clearSession();
});

// Also clear session when page visibility changes (user navigates away)
document.addEventListener('visibilitychange', () => {
  console.log(`${LOG_PREFIX} 👁️ Visibility change detected: ${document.visibilityState}`);

  // Only clear session if page is hidden AND sidepanel is not open AND user actually navigated away
  if (document.visibilityState === 'hidden') {
    console.log(`${LOG_PREFIX} 📱 Sidepanel state: ${isSidepanelOpen ? 'open' : 'closed'}`);
    console.log(`${LOG_PREFIX} 📊 Proofreader state:`, {
      hasActiveSession: !!proofreaderState.activeSession,
      isLoading: proofreaderState.isLoading
    });

    // Only clear session if:
    // 1. Page is hidden (user navigated away)
    // 2. Sidepanel is not open (user didn't just open sidepanel)
    // 3. There is an active proofreader session
    // 4. No proofreader operations are currently loading
    if (proofreaderState.activeSession && !proofreaderState.isLoading && !isSidepanelOpen) {
      console.log(`${LOG_PREFIX} 🔄 User navigated away, clearing proofreader session`);
      clearSession();
    } else if (proofreaderState.activeSession && proofreaderState.isLoading && !isSidepanelOpen) {
      console.log(`${LOG_PREFIX} ⏳ Proofreader operation in progress, not clearing session`);
    } else if (isSidepanelOpen) {
      console.log(`${LOG_PREFIX} 📱 Sidepanel is open, not clearing session`);
    } else if (!proofreaderState.activeSession) {
      console.log(`${LOG_PREFIX} 📭 No active proofreader session to clear`);
    }
  }
});

window.NanoScribeAutocomplete = {
  schedule: () => {
    if (activeField) {
      scheduleAutocomplete(activeField.element, activeField.fieldId, true);
    }
  },
  test: async () => {
    console.log(`${LOG_PREFIX} 🧪 Testing autocomplete directly...`);
    if (!activeField) {
      console.log(`${LOG_PREFIX} ❌ No active field, please focus on a text field first`);
      return;
    }

    const text = getFieldText(activeField.element);
    console.log(`${LOG_PREFIX} 📝 Testing with current field text: "${text}"`);

    await runAutocompleteRequest(activeField.element, activeField.fieldId);
  },
  directTest: async () => {
    console.log(`${LOG_PREFIX} 🧪 Testing direct chrome.runtime.sendMessage...`);
    if (!activeField) {
      console.log(`${LOG_PREFIX} ❌ No active field, please focus on a text field first`);
      return;
    }

    const text = getFieldText(activeField.element);
    const requestId = crypto.randomUUID();
    console.log(`${LOG_PREFIX} 📤 Testing direct REQUEST_COMPLETION:`, { requestId, textLength: text.length });

    // Test direct chrome.runtime.sendMessage
    const directResponse = await new Promise<BackgroundResponse>((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "REQUEST_COMPLETION",
        payload: {
          requestId,
          fieldId: activeField!.fieldId,
          text,
          caretIndex: getCaretIndex(activeField!.element),
        },
      }, (response) => {
        const directError = chrome.runtime.lastError;
        if (directError) {
          console.error(`${LOG_PREFIX} ❌ Direct message failed:`, directError);
          reject(directError);
          return;
        }
        console.log(`${LOG_PREFIX} ✅ Direct message response:`, response?.type);
        resolve(response as BackgroundResponse);
      });
    });

    console.log(`${LOG_PREFIX} 📋 Direct test result:`, directResponse);
  },
  status: () => {
    console.log(`${LOG_PREFIX} 📊 Current autocomplete state:`, autocompleteState);
    console.log(`${LOG_PREFIX} 🎯 Active field:`, activeField);
    console.log(`${LOG_PREFIX} 💡 Latest suggestion:`, latestSuggestion);
  }
};
