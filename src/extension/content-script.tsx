import { sendToBackground } from "./messaging";
import { ensureFieldId } from "./content-script";
import type { AutocompleteState, AutocompleteSuggestion, ProofreaderFieldResult, ProofreaderCorrection } from "./types";

const LOG_PREFIX = "[NanoScribe::Content]";
const AUTOCOMPLETE_DEBOUNCE_MS = 450;
const PROOFREADER_DEBOUNCE_MS = 800;
const MIN_COMPLETION_LENGTH = 20;

type SupportedField = HTMLInputElement | HTMLTextAreaElement;

type ActiveField = {
  element: SupportedField;
  fieldId: string;
};

declare global {
  interface Window {
    NanoScribeAutocomplete?: {
      schedule: () => void;
    };
    nanoscribeApplyCorrection?: (index: number) => void;
    hideProofreaderDialog?: () => void;
    acceptProofreaderCorrections?: () => void;
  }
}

let activeField: ActiveField | null = null;
let debounceTimer: number | null = null;
let proofreaderTimer: number | null = null;
let pendingRequestId: string | null = null;
let latestSuggestion: AutocompleteSuggestion | null = null;

let autocompleteState: AutocompleteState = {
  status: "idle",
  activeFieldId: null,
  caretIndex: null,
  suggestion: null,
  fieldPreview: null,
  error: null,
  updatedAt: Date.now(),
};

const proofreaderDialogState = {
  isVisible: false,
  selectedText: '',
  correctedText: '', // Add this to store the fully corrected text
  corrections: [] as ProofreaderCorrection[],
  isLoading: false,
  fieldId: null as string | null,
  error: null as string | null,
};

function isSupportedField(target: EventTarget | null): target is SupportedField {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return ["text", "search", "email", "url", "tel"].includes(target.type || "text");
  }
  return false;
}

function getCaretIndex(field: SupportedField): number {
  return typeof field.selectionStart === "number" ? field.selectionStart : field.value.length;
}

function buildFieldPreview(field: SupportedField, caretIndex: number): string {
  const text = field.value ?? "";
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

function clearProofreaderTimer() {
  if (proofreaderTimer !== null) {
    window.clearTimeout(proofreaderTimer);
    proofreaderTimer = null;
  }
}

function scheduleProofreader(field: SupportedField, fieldId: string, immediate = false) {
  clearProofreaderTimer();

  const trigger = () => {
    runProofreaderForSelection(field.value || "", fieldId).catch((error) => {
      console.error(`${LOG_PREFIX} Proofreader scheduling error`, error);
    });
  };

  if (immediate) {
    trigger();
  } else {
    proofreaderTimer = window.setTimeout(trigger, PROOFREADER_DEBOUNCE_MS);
  }
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

function showProofreaderDialog() {
  const selection = getSelectedText();
  if (!selection || !selection.text) return;

  console.log(`${LOG_PREFIX} showProofreaderDialog: Showing dialog for text: "${selection.text}"`);
  proofreaderDialogState.selectedText = selection.text;
  proofreaderDialogState.correctedText = ''; // Reset corrected text for new selection
  proofreaderDialogState.fieldId = selection.fieldId;
  proofreaderDialogState.isVisible = true;
  proofreaderDialogState.isLoading = true;
  proofreaderDialogState.corrections = [];
  proofreaderDialogState.error = null;

  if (selection.fieldId) {
    console.log(`${LOG_PREFIX} showProofreaderDialog: Calling proofreader API`);
    runProofreaderForSelection(selection.text, selection.fieldId);
  }

  console.log(`${LOG_PREFIX} showProofreaderDialog: Rendering dialog`);
  renderProofreaderDialog();
}

function hideProofreaderDialog() {
  proofreaderDialogState.isVisible = false;
  proofreaderDialogState.correctedText = ''; // Reset corrected text
  proofreaderDialogState.error = null;
  const dialog = document.querySelector('.nanoscribe-proofreader-dialog');
  if (dialog) {
    dialog.remove();
  }
}

async function runProofreaderForSelection(text: string, fieldId: string) {
  console.log(`${LOG_PREFIX} runProofreaderForSelection: Starting proofreader for text: "${text.slice(0, 50)}..."`);
  try {
    const response = await sendToBackground({
      type: "PROOFREAD_SELECTED_TEXT",
      payload: {
        text: text,
        fieldId: fieldId
      }
    });

    console.log(`${LOG_PREFIX} runProofreaderForSelection: API response received:`, response.type);

    if (response.type === "PROOFREADER_FIELD_RESULT") {
      const result = response.payload;
      console.log(`${LOG_PREFIX} runProofreaderForSelection: Corrections found:`, result.corrections?.length || 0);

      proofreaderDialogState.corrections = result.corrections || [];
      proofreaderDialogState.correctedText = result.corrected || proofreaderDialogState.selectedText; // Store the fully corrected text
      proofreaderDialogState.isLoading = false;
      proofreaderDialogState.error = null;

      console.log(`${LOG_PREFIX} runProofreaderForSelection: Updating dialog state and re-rendering`);
      renderProofreaderDialog();
    } else {
      console.log(`${LOG_PREFIX} runProofreaderForSelection: Unexpected response type:`, response.type);
      proofreaderDialogState.isLoading = false;
      proofreaderDialogState.corrections = [];
      proofreaderDialogState.error = null;
      renderProofreaderDialog();
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} runProofreaderForSelection: API error:`, error);

    // Handle extension context invalidated specifically
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("Extension context invalidated") ||
        errorMessage.includes("Service worker not available")) {
      console.log(`${LOG_PREFIX} runProofreaderForSelection: Extension context invalidated, showing user-friendly message`);
      proofreaderDialogState.isLoading = false;
      proofreaderDialogState.corrections = [];
      proofreaderDialogState.correctedText = ''; // Reset corrected text
      proofreaderDialogState.error = "Extension context invalidated. Please reload the page and try again.";
      renderProofreaderDialog();
    } else {
      proofreaderDialogState.isLoading = false;
      proofreaderDialogState.corrections = [];
      proofreaderDialogState.correctedText = ''; // Reset corrected text
      proofreaderDialogState.error = null;
      renderProofreaderDialog();
    }
  }
}

function acceptProofreaderCorrections() {
  console.log(`${LOG_PREFIX} acceptProofreaderCorrections: Starting function`, {
    error: proofreaderDialogState.error,
    correctionsLength: proofreaderDialogState.corrections.length,
    correctedText: proofreaderDialogState.correctedText,
    selectedText: proofreaderDialogState.selectedText
  });

  if (proofreaderDialogState.error) {
    // Reload the page when service worker is unavailable
    console.log(`${LOG_PREFIX} acceptProofreaderCorrections: Reloading page due to service worker error`);
    window.location.reload();
    return;
  }

  if (proofreaderDialogState.corrections.length === 0) {
    console.log(`${LOG_PREFIX} acceptProofreaderCorrections: No corrections to apply`);
    hideProofreaderDialog();
    return;
  }

  try {
    const selection = window.getSelection();
    console.log(`${LOG_PREFIX} acceptProofreaderCorrections: Selection info`, {
      selection: !!selection,
      rangeCount: selection?.rangeCount || 0
    });

    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      console.log(`${LOG_PREFIX} acceptProofreaderCorrections: Range info`, {
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        collapsed: range.collapsed
      });

      // Use the fully corrected text from the proofreader response
      if (proofreaderDialogState.correctedText && proofreaderDialogState.correctedText !== proofreaderDialogState.selectedText) {
        console.log(`${LOG_PREFIX} acceptProofreaderCorrections: Applying corrected text`, {
          originalLength: proofreaderDialogState.selectedText.length,
          correctedLength: proofreaderDialogState.correctedText.length
        });

        // Create a text node with the fully corrected text
        const correctedTextNode = document.createTextNode(proofreaderDialogState.correctedText);

        // Replace the selected content with the fully corrected text
        range.deleteContents();
        range.insertNode(correctedTextNode);

        // Select the corrected text
        range.selectNodeContents(correctedTextNode);
        selection.removeAllRanges();
        selection.addRange(range);

        console.log(`${LOG_PREFIX} acceptProofreaderCorrections: Successfully applied corrected text`);
      } else {
        console.log(`${LOG_PREFIX} acceptProofreaderCorrections: No corrections needed or text unchanged`);
      }
    } else {
      console.log(`${LOG_PREFIX} acceptProofreaderCorrections: No text selection found`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} acceptProofreaderCorrections: Error applying corrections`, error);
  }

  hideProofreaderDialog();
}

function renderProofreaderDialog() {
  if (!proofreaderDialogState.isVisible) {
    hideProofreaderDialog();
    return;
  }

  console.log(`${LOG_PREFIX} renderProofreaderDialog: Rendering dialog`, {
    isVisible: proofreaderDialogState.isVisible,
    correctionsLength: proofreaderDialogState.corrections.length,
    hasError: !!proofreaderDialogState.error,
    selectedText: proofreaderDialogState.selectedText
  });

  let dialog = document.querySelector('.nanoscribe-proofreader-dialog') as HTMLElement;
  if (!dialog) {
    dialog = document.createElement('div');
    dialog.className = 'nanoscribe-proofreader-dialog';
    dialog.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
      z-index: 10001;
      width: 90%;
      max-width: 500px;
      font-family: system-ui, -apple-system, sans-serif;
    `;
    document.body.appendChild(dialog);
    console.log(`${LOG_PREFIX} renderProofreaderDialog: Created new dialog element`);
  }

  // Add event listeners for buttons AFTER setting innerHTML
  const cancelBtn = dialog.querySelector('#proofreader-cancel-btn') as HTMLButtonElement;
  const acceptBtn = dialog.querySelector('#proofreader-accept-btn') as HTMLButtonElement;

  console.log(`${LOG_PREFIX} Button elements found:`, {
    cancelBtn: !!cancelBtn,
    acceptBtn: !!acceptBtn,
    correctionsCount: proofreaderDialogState.corrections.length,
    hasError: !!proofreaderDialogState.error,
    isVisible: proofreaderDialogState.isVisible,
    buttonDisabled: proofreaderDialogState.corrections.length === 0 && !proofreaderDialogState.error,
    buttonText: proofreaderDialogState.error ? 'Reload Page' : 'Accept Corrections'
  });

  if (cancelBtn) {
    cancelBtn.onclick = () => {
      console.log(`${LOG_PREFIX} Cancel button clicked`);
      hideProofreaderDialog();
    };
    console.log(`${LOG_PREFIX} Cancel button event listener attached`);
  }

  if (acceptBtn) {
    acceptBtn.onclick = () => {
      console.log(`${LOG_PREFIX} Accept button clicked`);
      acceptProofreaderCorrections();
    };
    console.log(`${LOG_PREFIX} Accept button event listener attached`);
  }

  dialog.innerHTML = `
    <div style="padding: 20px;">
      <div style="margin-bottom: 16px;">
        <h3 style="margin: 0 0 8px 0; font-size: 18px; font-weight: 600; color: #1f2937;">Proofreader Suggestions</h3>
        <div style="font-size: 14px; color: #6b7280; padding: 12px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
          ${proofreaderDialogState.selectedText}
        </div>
      </div>

      ${proofreaderDialogState.isLoading ? `
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
          <div style="width: 16px; height: 16px; border: 2px solid #e5e7eb; border-top: 2px solid #3b82f6; border-radius: 50%; animation: spin 1s linear infinite;"></div>
          <span style="font-size: 14px; color: #6b7280;">Analyzing text...</span>
        </div>
        <style>
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      ` : proofreaderDialogState.error ? `
        <div style="margin-bottom: 16px;">
          <div style="padding: 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; color: #dc2626; font-size: 14px;">
            ${proofreaderDialogState.error}
          </div>
        </div>
      ` : `
        <div style="margin-bottom: 16px;">
          ${proofreaderDialogState.corrections.length > 0 ? `
            ${proofreaderDialogState.corrections.map((correction, index) => `
              <div style="margin-bottom: 8px; padding: 8px; background: #fef3c7; border-radius: 6px; border-left: 3px solid #f59e0b;">
                <div style="font-size: 12px; color: #92400e; font-weight: 500; margin-bottom: 4px;">
                  ${correction.type || 'Correction'}: ${correction.correction || 'Suggested fix'}
                </div>
                ${correction.explanation ? `
                  <div style="font-size: 11px; color: #78350f;">
                    ${correction.explanation}
                  </div>
                ` : ''}
              </div>
            `).join('')}
          ` : `
            <div style="padding: 12px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; color: #166534; font-size: 14px;">
              No corrections needed. The text looks good!
            </div>
          `}
        </div>
      `}

      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button
          id="proofreader-cancel-btn"
          style="padding: 8px 16px; background: #f3f4f6; border: 1px solid #d1d5db; border-radius: 6px; color: #374151; font-size: 14px; cursor: pointer;"
        >
          Cancel
        </button>
        <button
          id="proofreader-accept-btn"
          ${proofreaderDialogState.corrections.length === 0 && !proofreaderDialogState.error ? 'disabled' : ''}
          style="padding: 8px 16px; background: ${proofreaderDialogState.corrections.length > 0 ? '#3b82f6' : proofreaderDialogState.error ? '#ef4444' : '#9ca3af'}; border: none; border-radius: 6px; color: white; font-size: 14px; cursor: ${proofreaderDialogState.corrections.length > 0 ? 'pointer' : proofreaderDialogState.error ? 'pointer' : 'not-allowed'}; pointer-events: ${proofreaderDialogState.corrections.length === 0 && !proofreaderDialogState.error ? 'none' : 'auto'};"
          title="${proofreaderDialogState.corrections.length === 0 && !proofreaderDialogState.error ? 'No corrections available' : 'Apply corrections'}"
        >
          ${proofreaderDialogState.error ? 'Reload Page' : 'Accept Corrections'}
        </button>
      </div>
    </div>
  `;

  console.log(`${LOG_PREFIX} Dialog HTML set, final state:`, {
    dialogExists: !!dialog,
    dialogVisible: dialog?.style.display !== 'none',
    correctionsCount: proofreaderDialogState.corrections.length,
    acceptBtnExists: !!dialog?.querySelector('#proofreader-accept-btn'),
    acceptBtnDisabled: dialog?.querySelector('#proofreader-accept-btn')?.hasAttribute('disabled'),
    dialogRect: dialog ? dialog.getBoundingClientRect() : null
  });
}

function hideProofreaderUI() {
  const containers = document.querySelectorAll('.nanoscribe-proofreader-container');
  containers.forEach(container => container.remove());
}

function renderProofreaderUI() {
  if (!activeField || !proofreaderDialogState.corrections.length) {
    hideProofreaderUI();
    return;
  }

  const field = activeField.element;
  let container = field.parentElement?.querySelector('.nanoscribe-proofreader-container') as HTMLElement;

  if (!container) {
    container = document.createElement('div');
    container.className = 'nanoscribe-proofreader-container';
    container.style.cssText = `
      position: absolute;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      z-index: 10000;
      max-width: 300px;
      font-family: system-ui, -apple-system, sans-serif;
    `;
    field.parentElement?.appendChild(container);
  }

  // Position the container below the field
  const fieldRect = field.getBoundingClientRect();
  (container as HTMLElement).style.left = `${fieldRect.left}px`;
  (container as HTMLElement).style.top = `${fieldRect.bottom + 5}px`;

  // Render corrections
  container.innerHTML = `
    <div style="padding: 8px;">
      <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">Proofreader Suggestions</div>
      ${proofreaderDialogState.corrections.map((correction, index) => `
        <div
          class="nanoscribe-correction-item"
          data-index="${index}"
          style="margin-bottom: 4px; padding: 4px; background: #fef3c7; border-radius: 4px; border-left: 3px solid #f59e0b; cursor: pointer;"
          onclick="window.nanoscribeApplyCorrection?.(${index})"
        >
          <div style="font-size: 11px; color: #92400e; font-weight: 500;">
            ${correction.type || 'Correction'}: ${correction.correction || 'Suggested fix'}
          </div>
          ${correction.explanation ? `
            <div style="font-size: 10px; color: #78350f; margin-top: 2px;">
              ${correction.explanation}
            </div>
          ` : ''}
        </div>
      `).join('')}
    </div>
  `;
}

function applyCorrection(index: number) {
  if (!activeField || !proofreaderDialogState.corrections[index]) {
    return;
  }

  const correction = proofreaderDialogState.corrections[index];
  const field = activeField.element;

  if (correction.startIndex !== undefined && correction.endIndex !== undefined && correction.replacement) {
    const before = field.value.slice(0, correction.startIndex);
    const after = field.value.slice(correction.endIndex);
    field.value = before + correction.replacement + after;

    // Update cursor position
    const newCaret = before.length + correction.replacement.length;
    field.selectionStart = newCaret;
    field.selectionEnd = newCaret;

    field.dispatchEvent(new Event("input", { bubbles: true }));

    console.info(`${LOG_PREFIX} Correction applied:`, correction);
  }

  // Hide the proofreader UI after applying
  proofreaderDialogState.corrections = [];
  proofreaderDialogState.correctedText = ''; // Reset corrected text
  hideProofreaderUI();
}

window.nanoscribeApplyCorrection = applyCorrection;

window.hideProofreaderDialog = hideProofreaderDialog;
window.acceptProofreaderCorrections = acceptProofreaderCorrections;

async function runAutocompleteRequest(field: SupportedField, fieldId: string) {
  const text = field.value ?? "";
  const trimmed = text.trim();
  const caretIndex = getCaretIndex(field);

  updateState({
    activeFieldId: fieldId,
    caretIndex,
    fieldPreview: buildFieldPreview(field, caretIndex),
    error: null,
    suggestion: null,
  });

  if (!trimmed) {
    latestSuggestion = null;
    setStatus("listening", {
      suggestion: null,
    });
    return;
  }

  if (trimmed.length < MIN_COMPLETION_LENGTH) {
    latestSuggestion = null;
    setStatus("listening", {
      suggestion: null,
    });
    return;
  }

  const requestId = crypto.randomUUID();
  pendingRequestId = requestId;
  setStatus("pending", {
    error: null,
    suggestion: null,
  });

  try {
    const response = await sendToBackground({
      type: "REQUEST_COMPLETION",
      payload: {
        requestId,
        fieldId,
        text,
        caretIndex,
      },
    });

    if (pendingRequestId !== requestId) {
      console.debug(`${LOG_PREFIX} Ignoring stale completion response`, requestId);
      return;
    }

    if (response.type === "ERROR") {
      setStatus("error", { error: response.message, suggestion: null });
      return;
    }

    if (response.type !== "COMPLETION_RESULT") {
      console.warn(`${LOG_PREFIX} Unexpected completion response`, response);
      setStatus("error", { error: "Unexpected completion response", suggestion: null });
      return;
    }

    const result = response.payload;
    if (result.error) {
      setStatus("error", { error: result.error, suggestion: null });
      return;
    }

    if (!result.suggestion) {
      latestSuggestion = null;
      setStatus("listening", { suggestion: null });
      return;
    }

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
  } catch (error) {
    console.error(`${LOG_PREFIX} Autocomplete request failed`, error);
    setStatus("error", {
      error: error instanceof Error ? error.message : String(error),
      suggestion: null,
    });
  } finally {
    if (pendingRequestId === requestId) {
      pendingRequestId = null;
    }
  }
}

function scheduleAutocomplete(field: SupportedField, fieldId: string, immediate = false) {
  clearDebounceTimer();

  const trigger = () => {
    runAutocompleteRequest(field, fieldId).catch((error) => {
      console.error(`${LOG_PREFIX} Autocomplete scheduling error`, error);
      setStatus("error", {
        error: error instanceof Error ? error.message : String(error),
        suggestion: null,
      });
    });
  };

  if (immediate) {
    trigger();
  } else {
    debounceTimer = window.setTimeout(trigger, AUTOCOMPLETE_DEBOUNCE_MS);
  }
}

function resetActiveField(reason: string) {
  activeField = null;
  latestSuggestion = null;
  clearDebounceTimer();
  clearProofreaderTimer();
  proofreaderDialogState.corrections = [];
  proofreaderDialogState.correctedText = ''; // Reset corrected text
  proofreaderDialogState.error = null;
  hideProofreaderUI();
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

  const before = field.value.slice(0, currentCaret);
  const after = field.value.slice(currentCaret);
  field.value = `${before}${latestSuggestion.completionText}${after}`;

  const newCaret = currentCaret + latestSuggestion.completionText.length;
  field.selectionStart = newCaret;
  field.selectionEnd = newCaret;
  field.dispatchEvent(new Event("input", { bubbles: true }));

  console.info(`${LOG_PREFIX} Suggestion inserted via ${source}.`);
  latestSuggestion = null;
  setStatus("listening", {
    suggestion: null,
    caretIndex: newCaret,
    fieldPreview: buildFieldPreview(field, newCaret),
    error: null,
  });
  return { ok: true };
}

function handleFocusIn(event: FocusEvent) {
  if (!isSupportedField(event.target)) {
    resetActiveField("unsupported target");
    return;
  }

  const element = event.target;
  const fieldId = ensureFieldId(element);
  activeField = { element, fieldId };

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
    resetActiveField("focus lost");
  }
}

function handleInput(event: Event) {
  const target = event.target;
  if (!isSupportedField(target)) {
    return;
  }

  const fieldId = ensureFieldId(target);
  if (!activeField || activeField.fieldId !== fieldId) {
    activeField = { element: target, fieldId };
  }

  scheduleAutocomplete(target, fieldId);
  scheduleProofreader(target, fieldId);
}

function handleKeyDown(event: KeyboardEvent) {
  if (!activeField) return;
  if (event.target !== activeField.element) return;

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

  if (!event.repeat && event.key.toLowerCase() === "p" && event.ctrlKey && event.shiftKey) {
    event.preventDefault();
    sendToBackground({ type: "RUN_PROOFREADER_ON_ACTIVE_FIELD" }).catch((error) => {
      console.error(`${LOG_PREFIX} Proofreader shortcut failed`, error);
    });
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

  if (message.type === "GET_ACTIVE_FIELD_CONTENT") {
    if (!activeField) {
      sendResponse({ error: "No active field" });
      return true;
    }

    const field = activeField.element;
    const response = {
      fieldId: activeField.fieldId,
      text: field.value,
      isContentEditable: field.isContentEditable || false,
    };

    sendResponse(response);
    return true;
  }

  if (message.type === "AUTOCOMPLETE_COMMAND") {
    const response = handleAutocompleteCommand(message.command);
    sendResponse(response);
    return true;
  }

  if (message.type === "APPLY_PROOFREADER_RESULT") {
    // The proofreader result is already handled by the real-time proofing system
    // This message is mainly for compatibility with the keyboard shortcut
    sendResponse({ type: "ACK" });
    return true;
  }

  return false;
});

document.addEventListener("focusin", handleFocusIn, true);
document.addEventListener("focusout", handleFocusOut, true);
document.addEventListener("input", handleInput, true);
document.addEventListener("keydown", handleKeyDown, true);

// Add selection event listeners for proofreader dialog
document.addEventListener("selectionchange", () => {
  const selection = getSelectedText();
  if (selection && selection.text && !proofreaderDialogState.isVisible) {
    // Show dialog after a short delay to avoid showing on quick selections
    setTimeout(() => {
      const currentSelection = getSelectedText();
      if (currentSelection && currentSelection.text && currentSelection.text === selection.text) {
        showProofreaderDialog();
      }
    }, 300);
  }
});

// Hide dialog when clicking outside
document.addEventListener("click", (event) => {
  if (proofreaderDialogState.isVisible) {
    const dialog = document.querySelector('.nanoscribe-proofreader-dialog');
    if (dialog && !dialog.contains(event.target as Node)) {
      hideProofreaderDialog();
    }
  }
});

pushState();

window.NanoScribeAutocomplete = {
  schedule: () => {
    if (activeField) {
      scheduleAutocomplete(activeField.element, activeField.fieldId, true);
    }
  },
};
