import React from 'react';
import { createRoot } from 'react-dom/client';
import { sendToBackground } from "./messaging";
import { ensureFieldId } from "./content-script";
import type {
  AutocompleteContextEntry,
  AutocompleteFieldType,
  AutocompleteState,
  AutocompleteSuggestion,
  MemoryRecord,
} from "./types";
import type { BackgroundResponse } from "./messaging";
import {
  createProofreaderSession,
  setActiveSession,
  getCurrentSession,
  getProofreaderSnapshot,
  clearSession,
  markApplyRequested,
  markApplySucceeded,
  markApplyFailed,
  resolveStoredNodeReference,
  type ProofreaderSession,
} from "./proofreader-state";
import type { ProofreaderCorrection } from "./types";
import {
  showProofreaderDialog,
  runProofreaderForSelection,
  hideProofreaderDialog,
  broadcastProofreaderState,
} from "./proofreader-utils";

const LOG_PREFIX = "[NanoScribe::Content]";
const AUTOCOMPLETE_DEBOUNCE_MS = 450;
const MIN_COMPLETION_LENGTH = 15;
const SURROUNDING_CONTEXT_WINDOW = 150;
const WORD_CHAR_REGEX = /[\p{L}\p{N}_]/u;
const MIN_PROOFREADER_SELECTION_LENGTH = 15;

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
      // New semantic recall testing utilities
      testContext: () => Promise<void>;
      checkSession: () => Promise<void>;
      clearMemories: (confirmed?: boolean) => Promise<void>;
      toggleContext: (enabled: boolean) => Promise<boolean>;
    };
  }
}

// Preserve selection targets for replacing with summary
let summaryReplaceRange: Range | null = null;
let summaryReplaceInputTarget: { element: SupportedField; start: number; end: number } | null = null;


let toastHost: HTMLElement | null = null;
let toastStylesInjected = false;
let activeLoadingToast: HTMLElement | null = null;

function ensureToastHost(): HTMLElement {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  const host = document.createElement('div');
  host.id = 'nanoscribe-toast-host';
  host.style.position = 'fixed';
  host.style.right = '16px';
  host.style.bottom = '16px';
  host.style.zIndex = '100000';
  host.style.display = 'flex';
  host.style.flexDirection = 'column';
  host.style.gap = '8px';
  document.body.appendChild(host);
  toastHost = host;
  return host;
}

function ensureToastStyles(): void {
  if (toastStylesInjected) {
    return;
  }

  const styleId = 'nanoscribe-toast-styles';
  if (document.getElementById(styleId)) {
    toastStylesInjected = true;
    return;
  }

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `@keyframes nanoscribe-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.nanoscribe-toast-spinner { width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.25); border-top-color: rgba(255,255,255,0.85); border-radius: 50%; animation: nanoscribe-spin 0.9s linear infinite; flex-shrink: 0; }
.nanoscribe-toast-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
`;
  document.head.appendChild(style);
  toastStylesInjected = true;
}

function showSummaryToast(payload: { state: "loading" | "success" | "error"; title?: string; description?: string }) {
  const host = ensureToastHost();
  ensureToastStyles();

  if (payload.state !== 'loading' && activeLoadingToast && activeLoadingToast.parentElement === host) {
    host.removeChild(activeLoadingToast);
    activeLoadingToast = null;
  }

  const toast = document.createElement('div');
  toast.style.background = '#111827';
  toast.style.color = 'white';
  toast.style.border = '1px solid rgba(255,255,255,0.08)';
  toast.style.borderRadius = '8px';
  toast.style.boxShadow = '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)';
  toast.style.padding = '12px 14px';
  toast.style.maxWidth = '420px';
  toast.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
  toast.style.cursor = 'default';
  // Prevent the toast itself from stealing focus (preserve caret in inputs)
  toast.onmousedown = (e) => { e.preventDefault(); };

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '8px';

  if (payload.state === 'loading') {
    const spinner = document.createElement('span');
    spinner.className = 'nanoscribe-toast-spinner';
    header.appendChild(spinner);
  } else if (payload.state === 'success' || payload.state === 'error') {
    const icon = document.createElement('span');
    icon.className = 'nanoscribe-toast-icon';
    icon.textContent = payload.state === 'success' ? '✅' : '⚠️';
    header.appendChild(icon);
  }

  const title = document.createElement('div');
  title.textContent = payload.title ?? (payload.state === 'loading' ? 'Summarizing…' : payload.state === 'success' ? 'Summary ready' : 'Error');
  title.style.fontWeight = '600';
  title.style.fontSize = '14px';
  title.style.marginBottom = '6px';
  header.appendChild(title);

  const desc = document.createElement('div');
  const text = (payload.description ?? '').toString();
  desc.textContent = payload.state === 'success' ? (text.length > 600 ? text.slice(0, 600) + '…' : text) : text;
  desc.style.whiteSpace = 'pre-wrap';
  desc.style.fontSize = '13px';
  desc.style.lineHeight = '1.4';
  desc.style.color = payload.state === 'error' ? '#fecaca' : '#e5e7eb';

  if (payload.state === 'success') {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
        const rng = sel.getRangeAt(0).cloneRange();
        // Only store if range is anchored in the document
        if (rng.commonAncestorContainer && document.contains(rng.commonAncestorContainer)) {
          summaryReplaceRange = rng;
        }
      }
    } catch (_err) { /* ignore selection snapshot errors */ }

    // If no DOM range, check for form field selection
    if (!summaryReplaceRange) {
      const candidate = (activeField?.element || (document.activeElement as HTMLElement | null)) as SupportedField | null;
      if (candidate && isSupportedField(candidate)) {
        if (candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement) {
          const start = candidate.selectionStart ?? 0;
          const end = candidate.selectionEnd ?? 0;
          if (end > start) {
            summaryReplaceInputTarget = { element: candidate, start, end };
          }
        }
      }
    }
  }

  const actions = document.createElement('div');
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.marginTop = '10px';

  if (payload.state === 'success') {
    // Replace button
    const replaceBtn = document.createElement('button');
    replaceBtn.textContent = 'Replace';
    replaceBtn.style.background = '#10b981';
    replaceBtn.style.color = 'white';
    replaceBtn.style.border = 'none';
    replaceBtn.style.borderRadius = '6px';
    replaceBtn.style.padding = '6px 10px';
    replaceBtn.style.fontSize = '12px';
    // Prevent focus change so caret/selection stays intact
    replaceBtn.onmousedown = (e) => { e.preventDefault(); };
    replaceBtn.onclick = (e) => {
      e.stopPropagation();
      let replaced = false;

      // Case 1: Replace inside input/textarea selection
      if (summaryReplaceInputTarget && (summaryReplaceInputTarget.element instanceof HTMLInputElement || summaryReplaceInputTarget.element instanceof HTMLTextAreaElement)) {
        const el = summaryReplaceInputTarget.element as HTMLInputElement | HTMLTextAreaElement;
        const { start, end } = summaryReplaceInputTarget;
        const current = el.value ?? '';
        el.value = current.slice(0, start) + text + current.slice(end);
        const caret = start + text.length;
        el.selectionStart = caret;
        el.selectionEnd = caret;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        replaced = true;
      }

      // Case 2: Replace a DOM Range selection (webpage text/contentEditable)
      if (!replaced && summaryReplaceRange) {
        try {
          // Validate the stored range
          const ancestor = summaryReplaceRange.commonAncestorContainer;
          if (ancestor && (ancestor.nodeType === Node.ELEMENT_NODE ? document.contains(ancestor as Element) : document.contains(ancestor.parentElement as Element))) {
            const sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(summaryReplaceRange);
            }
            // Perform replacement
            summaryReplaceRange.deleteContents();
            const node = document.createTextNode(text);
            summaryReplaceRange.insertNode(node);

            // Move caret after inserted node
            const after = document.createRange();
            after.setStartAfter(node);
            after.collapse(true);
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(after);
            }
            replaced = true;
          }
        } catch (_err) { /* ignore DOM replacement errors */ }
      }

      // Fallback: copy to clipboard if nothing to replace
      if (!replaced) {
        navigator.clipboard.writeText(text).catch(() => {});
        title.textContent = 'No selection to replace – copied to clipboard';
        title.style.color = '#fde68a';
        return;
      }

      // Provide quick visual feedback and dismiss
      replaceBtn.textContent = 'Replaced';
      setTimeout(() => { if (toast.parentElement === host) host.removeChild(toast); }, 600);
      summaryReplaceRange = null;
      summaryReplaceInputTarget = null;
    };
    actions.appendChild(replaceBtn);

    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.style.background = '#2563eb';
    copyBtn.style.color = 'white';
    copyBtn.style.border = 'none';
    copyBtn.style.borderRadius = '6px';
    copyBtn.style.padding = '6px 10px';
    copyBtn.style.fontSize = '12px';
    copyBtn.onmousedown = (e) => { e.preventDefault(); };
    copyBtn.onclick = async (e) => {
      e.stopPropagation();
      try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1500); } catch (_err) { /* ignore clipboard errors */ }
    };
    actions.appendChild(copyBtn);
  }

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.style.background = 'transparent';
  dismissBtn.style.color = '#9ca3af';
  dismissBtn.style.border = '1px solid rgba(255,255,255,0.12)';
  dismissBtn.style.borderRadius = '6px';
  dismissBtn.style.padding = '6px 10px';
  dismissBtn.style.fontSize = '12px';
  // Prevent focus change
  dismissBtn.onmousedown = (e) => { e.preventDefault(); };
  dismissBtn.onclick = (e) => {
    e.stopPropagation();
    if (toast.parentElement === host) {
      host.removeChild(toast);
    }
    if (toast === activeLoadingToast) {
      activeLoadingToast = null;
    }
    summaryReplaceRange = null;
    summaryReplaceInputTarget = null;
  };
  actions.appendChild(dismissBtn);

  toast.appendChild(header);
  toast.appendChild(desc);
  toast.appendChild(actions);
  host.appendChild(toast);

  if (payload.state === 'loading') {
    activeLoadingToast = toast;
  }

  if (payload.state !== 'loading') {
    setTimeout(() => {
      if (toast.parentElement === host) {
        host.removeChild(toast);
      }
    }, 10000);
  }
}

function detectFieldType(field: SupportedField): AutocompleteFieldType {
  if (isFormField(field)) {
    const type = field.type?.toLowerCase() ?? "text";
    if (["email", "to", "cc", "bcc"].includes(type)) {
      return "email";
    }
    if (["search"].includes(type)) {
      return "search";
    }
    if (type === "url") {
      return "generic";
    }
  }

  const labelText = (field.getAttribute("aria-label") || field.getAttribute("placeholder") || "").toLowerCase();
  if (labelText.includes("email") || labelText.includes("subject")) {
    return "email";
  }
  if (labelText.includes("search") || labelText.includes("find")) {
    return "search";
  }
  if (labelText.includes("chat") || labelText.includes("message")) {
    return "chat";
  }
  if (labelText.includes("code") || labelText.includes("snippet")) {
    return "code";
  }
  if (labelText.includes("document") || labelText.includes("article")) {
    return "document";
  }

  if (isContentEditableField(field)) {
    const role = field.getAttribute("role")?.toLowerCase();
    if (role === "textbox" && field.dataset.editor === "wysiwyg") {
      return "document";
    }
    if (role === "textbox" && field.closest("[contenteditable][data-panel='chat']")) {
      return "chat";
    }
  }

  return "generic";
}

function collectSurroundingText(field: SupportedField, caretIndex: number) {
  const text = getFieldText(field);
  const before = text.slice(Math.max(0, caretIndex - SURROUNDING_CONTEXT_WINDOW), caretIndex);
  const after = text.slice(caretIndex, caretIndex + SURROUNDING_CONTEXT_WINDOW);
  return { before, after };
}

function isCaretMidWord(text: string, caretIndex: number) {
  if (caretIndex <= 0 || caretIndex >= text.length) {
    return false;
  }

  const prevChar = text.charAt(caretIndex - 1);
  const nextChar = text.charAt(caretIndex);

  return WORD_CHAR_REGEX.test(prevChar) && WORD_CHAR_REGEX.test(nextChar);
}

function resolveFieldLabel(field: SupportedField): string | null {
  const fromAttribute =
    field.getAttribute("aria-label") ||
    field.getAttribute("aria-labelledby") ||
    field.getAttribute("placeholder") ||
    field.getAttribute("data-placeholder") ||
    null;

  if (fromAttribute) {
    return fromAttribute;
  }

  if (isFormField(field) && field.name) {
    return field.name;
  }

  const labelElement = document.querySelector<HTMLLabelElement>(`label[for='${field.id}']`);
  if (labelElement?.textContent) {
    return labelElement.textContent.trim();
  }

  return null;
}

function resolvePlaceholder(field: SupportedField): string | null {
  if (isFormField(field)) {
    return field.placeholder || null;
  }
  return field.getAttribute("placeholder") || field.getAttribute("data-placeholder") || null;
}

let activeField: ActiveField | null = null;
let debounceTimer: number | null = null;
let pendingRequestId: string | null = null;
let latestSuggestion: AutocompleteSuggestion | null = null;
let isSidepanelOpen: boolean = false;
let isContextAwareEnabled = true;

chrome.storage?.local.get("isContextAware", (result) => {
  if (chrome.runtime.lastError) {
    console.warn("[NanoScribe::Content] ⚠️ Failed to load context-aware setting", chrome.runtime.lastError);
    return;
  }
  if (typeof result?.isContextAware === "boolean") {
    isContextAwareEnabled = result.isContextAware;
    console.log("[NanoScribe::Content] 🔄 Context-aware initialized to", isContextAwareEnabled);
  }
});

let autocompleteState: AutocompleteState = {
  status: "idle",
  activeFieldId: null,
  caretIndex: null,
  suggestion: null,
  fieldPreview: null,
  error: null,
  contextSummary: null,
  updatedAt: Date.now(),
};

document.addEventListener("mouseup", () => {
  setTimeout(() => {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim();

    if (!selectedText || selectedText.length < MIN_PROOFREADER_SELECTION_LENGTH) {
      return;
    }

    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
    if (!range) {
      return;
    }

    const stateSnapshot = getProofreaderSnapshot();
    if (stateSnapshot.status !== "idle" && stateSnapshot.isVisible) {
      console.log("[NanoScribe::Content] ⚠️ Proofreader busy, ignoring selection");
      return;
    }

    if (getCurrentSession()) {
      console.log("[NanoScribe::Content] 🔄 Clearing existing session before creating new one");
      clearSession();
      void broadcastProofreaderState("selection:cleared-existing");
    }

    const selectedElement = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : (range.commonAncestorContainer as Element);

    const session = createProofreaderSession(selectedText, range, selectedElement);
    setActiveSession(session);
    void broadcastProofreaderState("selection:new-session:mouseup");

    chrome.runtime.sendMessage({ type: "PING" }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        console.warn("❌ Service worker not available for proofreader, skipping:", runtimeError.message);
        return;
      }

      showProofreaderDialog(selectedText).catch((error) => {
        console.error("[NanoScribe::Content] Failed to show proofreader dialog", error);
      });
    });
  }, 100);
});

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

// Decide if a leading space is needed before inserting a suggestion so it doesn't stick to the previous word
function computeSuggestionWithLeadingSpace(field: SupportedField, suggestion: string): string {
  try {
    if (!suggestion) return suggestion;
    if (/^\s/.test(suggestion)) return suggestion; // already starts with space

    const caret = getCaretIndex(field);
    const fullText = getFieldText(field);
    const prevChar = caret > 0 ? fullText[caret - 1] : '';
    const prevIsWhitespace = prevChar === '' || /\s/.test(prevChar);
    if (prevIsWhitespace) return suggestion;

    const first = suggestion[0];
    const startsWithPunct = /[.,;:!?)}"'\]-]/.test(first);
    if (startsWithPunct) return suggestion;

    return ' ' + suggestion;
  } catch {
    return suggestion;
  }
}

function createGhostTextOverlay(): HTMLElement {
  if (ghostTextOverlay) {
    return ghostTextOverlay;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    pointer-events: none;
    z-index: 10000;
    background: transparent;
    font-family: inherit;
    font-size: inherit;
    line-height: inherit;
    color: rgba(156, 163, 175, 0.6);
    white-space: pre-wrap;
    word-wrap: break-word;
    text-align: left;
    padding: 0;
    margin: 0;
    border: none;
    outline: none;
    overflow: visible;
    transform: translateZ(0);
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

  if (isContentEditableField(field)) {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0 && (field.contains(sel.anchorNode) || field.contains(sel.focusNode))) {
        const range = sel.getRangeAt(0).cloneRange();
        range.collapse(true);
        const marker = document.createElement('span');
        marker.textContent = '\u200b';
        range.insertNode(marker);

        let overlayLeft: number | null = null;
        let overlayTop: number | null = null;
        let lineHeight: number | null = null;

        try {
          const mr = marker.getBoundingClientRect();

          const caretGap = 0;
          overlayLeft = mr.left + caretGap;
          overlayTop = mr.top;
          lineHeight = mr.height;
        } finally {
          if (marker.parentNode) {
            marker.parentNode.removeChild(marker);
          }
        }

        if (overlayLeft !== null && overlayTop !== null && lineHeight !== null) {
          overlay.style.left = `${overlayLeft}px`;
          overlay.style.top = `${overlayTop}px`;
          overlay.style.maxWidth = `${Math.max(0, rect.right - overlayLeft - 2)}px`;
          overlay.style.fontFamily = computedStyle.fontFamily;
          overlay.style.fontSize = computedStyle.fontSize;
          overlay.style.fontWeight = computedStyle.fontWeight;
          overlay.style.lineHeight = `${lineHeight}px`;
          overlay.style.letterSpacing = computedStyle.letterSpacing;
          overlay.style.whiteSpace = computedStyle.whiteSpace;
          overlay.style.direction = computedStyle.direction;

          overlay.textContent = suggestion;
          currentGhostText = suggestion;
          if (!overlay.parentNode) {
            document.body.appendChild(overlay);
          }
          return;
        }
      }
    } catch (_e) { void 0; }
  }

  const caretIndex = getCaretIndex(field);
  const textBeforeCaret = getFieldText(field).slice(0, caretIndex);

  console.log(`${LOG_PREFIX} 🎭 Updating ghost text position - Field type: ${field.tagName}, Caret: ${caretIndex}, Text length: ${getFieldText(field).length}`);

  const measureDiv = document.createElement('div');
  measureDiv.style.cssText = `
    position: fixed;
    visibility: hidden;
    white-space: ${computedStyle.whiteSpace};
    word-wrap: break-word;
    font-family: ${computedStyle.fontFamily};
    font-size: ${computedStyle.fontSize};
    font-weight: ${computedStyle.fontWeight};
    line-height: ${computedStyle.lineHeight};
    letter-spacing: ${computedStyle.letterSpacing};
    font-variant-ligatures: ${computedStyle.fontVariantLigatures};
    font-feature-settings: ${computedStyle.fontFeatureSettings};
    font-variation-settings: ${computedStyle.fontVariationSettings};
    direction: ${computedStyle.direction};
    box-sizing: content-box;
    padding: ${computedStyle.paddingTop} ${computedStyle.paddingRight} ${computedStyle.paddingBottom} ${computedStyle.paddingLeft};
    border: 0;
    text-align: ${computedStyle.textAlign};
    text-indent: ${computedStyle.textIndent};
    text-transform: ${computedStyle.textTransform};
    word-break: ${computedStyle.wordBreak};
    tab-size: ${computedStyle.tabSize || '8'};
    width: __CONTENT_WIDTH__px;
    top: ${rect.top}px;
    left: ${rect.left}px;
  `;

  // Compute content width (exclude padding and borders)
  const pl = parseFloat(computedStyle.paddingLeft) || 0;
  const pr = parseFloat(computedStyle.paddingRight) || 0;
  const bl = parseFloat(computedStyle.borderLeftWidth) || 0;
  const br = parseFloat(computedStyle.borderRightWidth) || 0;
  const contentWidth = Math.max(0, rect.width - pl - pr - bl - br);
  measureDiv.style.width = `${contentWidth}px`;

  measureDiv.textContent = textBeforeCaret;
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  measureDiv.appendChild(marker);
  document.body.appendChild(measureDiv);

  const measureRect = measureDiv.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  let caretX = Math.max(0, markerRect.left - measureRect.left);
  const caretY = Math.max(0, markerRect.top - measureRect.top);

  document.body.removeChild(measureDiv);

  const scrollLeft = (field as HTMLElement).scrollLeft || 0;
  const scrollTop = (field as HTMLElement).scrollTop || 0;
  caretX = Math.max(0, caretX - scrollLeft);
  const adjustedCaretY = Math.max(0, caretY - scrollTop);

  const paddingRight = parseFloat(computedStyle.paddingRight) || 0;
  const borderLeft = parseFloat(computedStyle.borderLeftWidth) || 0;
  const borderTop = parseFloat(computedStyle.borderTopWidth) || 0;
  const maxX = Math.max(0, rect.width - paddingRight - 2);
  caretX = Math.min(caretX, maxX);

  const caretGap = 0;
  const overlayLeft = rect.left + borderLeft + caretX + caretGap;
  const overlayTop = rect.top + borderTop + adjustedCaretY;
  overlay.style.left = `${overlayLeft}px`;
  overlay.style.top = `${overlayTop}px`;
  overlay.style.maxWidth = `${Math.max(0, rect.right - overlayLeft - 2)}px`;
  overlay.style.fontFamily = computedStyle.fontFamily;
  overlay.style.fontSize = computedStyle.fontSize;
  overlay.style.fontWeight = computedStyle.fontWeight;
  overlay.style.lineHeight = `${markerRect.height}px`;
  overlay.style.letterSpacing = computedStyle.letterSpacing;
  overlay.style.whiteSpace = computedStyle.whiteSpace;
  overlay.style.direction = computedStyle.direction;

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

  const adjusted = computeSuggestionWithLeadingSpace(activeField.element, suggestion);
  console.info(`${LOG_PREFIX} Displaying ghost text: ${adjusted}`);
  updateGhostTextPosition(activeField.element, adjusted);
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
    contextSummary: null,
  });

  if (!trimmed) {
    console.log(`${LOG_PREFIX} 📝 No text content, skipping autocomplete`);
    latestSuggestion = null;
    hideGhostText(); // Hide ghost text when no text
    setStatus("listening", {
      suggestion: null,
      contextSummary: null,
    });
    return;
  }

  if (trimmed.length < MIN_COMPLETION_LENGTH) {
    console.log(`${LOG_PREFIX} 📏 Text too short (${trimmed.length} < ${MIN_COMPLETION_LENGTH}), skipping autocomplete`);
    latestSuggestion = null;
    hideGhostText(); // Hide ghost text when text too short
    setStatus("listening", {
      suggestion: null,
      contextSummary: null,
    });
    return;
  }

  if (isCaretMidWord(text, caretIndex)) {
    console.log(`${LOG_PREFIX} 🛑 Caret mid-word detected, deferring autocomplete`);
    latestSuggestion = null;
    hideGhostText();
    setStatus("listening", {
      suggestion: null,
      contextSummary: null,
    });
    return;
  }

  const requestId = crypto.randomUUID();
  pendingRequestId = requestId;
  console.log(`${LOG_PREFIX} 🚀 Sending autocomplete request - ID: ${requestId}, Text: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`);

  setStatus("pending", {
    error: null,
    suggestion: null,
    contextSummary: null,
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

    const fieldType = detectFieldType(field);
    const fieldLabel = resolveFieldLabel(field);
    const placeholder = resolvePlaceholder(field);
    const surroundingText = collectSurroundingText(field, caretIndex);

    const response = await sendToBackground({
      type: "REQUEST_COMPLETION",
      payload: {
        requestId,
        fieldId,
        text,
        caretIndex,
        fieldType,
        fieldLabel,
        placeholder,
        surroundingText,
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
      setStatus("error", { error: response.message, suggestion: null, contextSummary: null });
      return;
    }

    if (response.type !== "COMPLETION_RESULT") {
      console.log(`${LOG_PREFIX} ⚠️ Unexpected completion response: ${response.type}`);
      hideGhostText(); // Hide ghost text on unexpected response
      setStatus("error", { error: "Unexpected completion response", suggestion: null, contextSummary: null });
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
        setStatus("listening", { suggestion: null, contextSummary: null });
        return;
      }

      console.log(`${LOG_PREFIX} ❌ Autocomplete model error: ${result.error}`);
      hideGhostText(); // Hide ghost text on error
      setStatus("error", { error: result.error, suggestion: null, contextSummary: null });
      return;
    }

    if (!result.suggestion) {
      console.log(`${LOG_PREFIX} 📭 No suggestion generated by model`);
      latestSuggestion = null;
      hideGhostText(); // Hide ghost text when no suggestion
      setStatus("listening", { suggestion: null, contextSummary: null });
      return;
    }

    console.log(`${LOG_PREFIX} ✅ Autocomplete suggestion received: "${result.suggestion}"`);
    console.log(`${LOG_PREFIX} 📊 Completion response details:`, {
      requestId: result.requestId,
      suggestionLength: result.suggestion.length,
      suggestionPreview: result.suggestion.slice(0, 50) + (result.suggestion.length > 50 ? '...' : ''),
    });

    const suggestionSource = result.metadata?.source ?? "model";
    latestSuggestion = {
      requestId,
      fieldId,
      caretIndex,
      completionText: result.suggestion,
      generatedAt: Date.now(),
      contextEntries: result.contextEntries ?? undefined,
      strategy: suggestionSource,
    };

    setStatus("suggestion", {
      suggestion: { ...latestSuggestion },
      error: null,
      caretIndex,
      activeFieldId: fieldId,
      fieldPreview: buildFieldPreview(field, caretIndex),
      contextSummary: result.contextSummary ?? null,
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
      setStatus("listening", { suggestion: null, contextSummary: null });
    } else {
      console.error(`${LOG_PREFIX} 💥 Unexpected autocomplete error:`, error);
      hideGhostText();
      setStatus("error", {
        error: errorMessage,
        suggestion: null,
        contextSummary: null,
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
        setStatus("listening", { suggestion: null, contextSummary: null });
      } else {
        console.error(`${LOG_PREFIX} Unexpected autocomplete scheduling error:`, error);
        setStatus("error", {
          error: errorMessage,
          suggestion: null,
          contextSummary: null,
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
    contextSummary: null,
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
    contextSummary: null,
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

  // Use the helper function to insert text at caret (with conditional leading space)
  const toInsert = computeSuggestionWithLeadingSpace(field, latestSuggestion.completionText);
  insertTextAtCaret(field, toInsert);

  const newCaret = currentCaret + toInsert.length;
  setCaretIndex(field, newCaret);

  console.info(`${LOG_PREFIX} Suggestion inserted via ${source}.`);
  latestSuggestion = null;
  hideGhostText(); // Hide the ghost text when applying suggestion
  setStatus("listening", {
    suggestion: null,
    caretIndex: newCaret,
    fieldPreview: buildFieldPreview(field, newCaret),
    error: null,
    contextSummary: null,
  });
  return { ok: true };
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
    contextSummary: null,
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

  switch (message.type) {
    case "SHOW_SUMMARY_TOAST": {
      showSummaryToast(message.payload);
      sendResponse({ type: "ACK" });
      return true;
    }
    case "CONTEXT_AWARENESS_UPDATED":
    case "INITIAL_SETTINGS": {
      if (typeof message.payload?.isContextAware === "boolean") {
        isContextAwareEnabled = message.payload.isContextAware;
        console.log("[NanoScribe::Content] 🔄 Context-aware mode updated:", isContextAwareEnabled);
      }
      break;
    }
    case "RETRY_AUTOCOMPLETE": {
      if (!activeField || activeField.fieldId !== message.payload?.fieldId) {
        break;
      }
      console.log("[NanoScribe::Content] 🔁 Retry request received:", message.payload?.reason ?? "unknown");
      scheduleAutocomplete(activeField.element, activeField.fieldId, true);
      break;
    }
    case "SIDEPANEL_OPENED": {
      console.log(`${LOG_PREFIX} 📱 Sidepanel opened`);
      isSidepanelOpen = true;
      sendResponse({ type: "ACK" });
      return true;
    }
    case "SIDEPANEL_CLOSED": {
      console.log(`${LOG_PREFIX} 📱 Sidepanel closed`);
      isSidepanelOpen = false;
      sendResponse({ type: "ACK" });
      return true;
    }
    case "GET_ACTIVE_FIELD_CONTENT": {
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
    case "AUTOCOMPLETE_COMMAND": {
      const response = handleAutocompleteCommand(message.command);
      sendResponse(response);
      return true;
    }
    case "CANCEL_PROOFREADER_SESSION": {
      const requestedSessionId = message.payload?.sessionId as string | undefined;
      const activeSession = getCurrentSession();
      if (activeSession && (!requestedSessionId || requestedSessionId === activeSession.id)) {
        console.log('[NanoScribe::Content] 🛑 Cancelling proofreader session from background request');
        void broadcastProofreaderState("cancel:content-script");
        clearSession();
      } else {
        console.log('[NanoScribe::Content] ℹ️ No matching proofreader session to cancel', {
          requestedSessionId,
          activeSessionId: activeSession?.id ?? null,
        });
      }
      sendResponse({ type: "ACK" });
      return true;
    }
    case "APPLY_PROOFREADER_CORRECTIONS": {
      const { correctedText, originalText, sessionId } = message.payload;
      const activeSession = getCurrentSession();
      const activeSessionId = activeSession?.id ?? null;
      const targetSessionId = sessionId ?? activeSessionId;

      console.log('📝 Content script: Applying corrected text:', `"${correctedText}"`);
      console.log('📋 Original text:', originalText);
      console.log('🔑 Requested session ID:', sessionId);
      console.log('📊 Current session:', activeSessionId);

      if (sessionId && activeSessionId && sessionId !== activeSessionId) {
        console.warn('⚠️ Session ID mismatch:', { expected: activeSessionId, received: sessionId });
      }

      if (targetSessionId) {
        markApplyRequested(targetSessionId);
      }

      const result = applyAllCorrectionsInContentScript(correctedText, originalText);
      console.log('✅ Correction result:', result);

      if (targetSessionId) {
        if (result.ok) {
          markApplySucceeded(targetSessionId);
          clearSession();
        } else {
          markApplyFailed(targetSessionId, result.message);
        }
      } else if (result.ok) {
        clearSession();
      }

      void broadcastProofreaderState("apply:all");
      sendResponse(result);
      return true;
    }
    case "APPLY_SINGLE_CORRECTION": {
      const { correctedText, originalText, sessionId } = message.payload;
      const activeSession = getCurrentSession();
      const activeSessionId = activeSession?.id ?? null;
      const targetSessionId = sessionId ?? activeSessionId;

      console.log('📝 Content script: Applying single correction:', `"${correctedText}"`);
      console.log('📋 Original text:', originalText);
      console.log('🔑 Requested session ID:', sessionId);
      console.log('📊 Current session:', activeSessionId);

      if (sessionId && activeSessionId && sessionId !== activeSessionId) {
        console.warn('⚠️ Session ID mismatch:', { expected: activeSessionId, received: sessionId });
      }

      if (targetSessionId) {
        markApplyRequested(targetSessionId);
      }

      const result = applySingleCorrectionInContentScript(correctedText, originalText);
      console.log('✅ Correction result:', result);

      if (targetSessionId) {
        if (result.ok) {
          markApplySucceeded(targetSessionId);
          clearSession();
        } else {
          markApplyFailed(targetSessionId, result.message);
        }
      } else if (result.ok) {
        clearSession();
      }

      void broadcastProofreaderState("apply:single");
      sendResponse(result);
      return true;
    }
    case 'EXTENSION_CONTEXT_INVALIDATED': {
      console.log('🔄 Extension context invalidated, clearing proofreader session');
      clearSession();
      sendResponse({ type: 'ACK' });
      return true;
    }
    default:
      return false;
  }
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

// Keep ghost text aligned during viewport changes (scroll/resize)
function handleViewportChange() {
  if (!activeField || !latestSuggestion) return;
  try {
    displayGhostText(latestSuggestion.completionText);
  } catch (e) {
    // Non-fatal: alignment will refresh on next input/caret event
  }
}

document.addEventListener("focusin", handleFocusIn, true);
document.addEventListener("focusout", handleFocusOut, true);
document.addEventListener("input", handleInput, true);
document.addEventListener("keydown", handleKeyDown, true);
document.addEventListener("click", handleClick, true);
window.addEventListener("resize", handleViewportChange, true);
window.addEventListener("scroll", handleViewportChange, true);

// Add selection event listener for proofreader dialog - DISABLED: selectionchange fires with incomplete ranges
// document.addEventListener("selectionchange", () => {
//   // ... selectionchange logic removed - causes issues with incomplete ranges
// });

// Add session cleanup on page unload and visibility changes
window.addEventListener('beforeunload', () => {
  console.log('🔄 Page unloading, clearing proofreader session');
  clearSession();
});

// Also clear session when page visibility changes (user navigates away or switches tabs)
document.addEventListener('visibilitychange', () => {
  console.log(`${LOG_PREFIX} 👁️ Visibility change detected: ${document.visibilityState}`);

  // Only clear session if page is hidden for an extended period
  // This prevents clearing session when just switching browser tabs
  if (document.visibilityState === 'hidden') {
    console.log(`${LOG_PREFIX} 📱 Sidepanel state: ${isSidepanelOpen ? 'open' : 'closed'}`);
    const snapshot = getProofreaderSnapshot();
    console.log(`${LOG_PREFIX} 📊 Proofreader state:`, {
      hasActiveSession: !!getCurrentSession(),
      status: snapshot.status,
      isLoading: snapshot.isLoading,
    });

    // Clear session after a delay to allow for quick tab switches
    setTimeout(() => {
      const delayedSnapshot = getProofreaderSnapshot();
      const activeSession = getCurrentSession();
      if (document.visibilityState === 'hidden' &&
          activeSession &&
          !delayedSnapshot.isLoading &&
          !isSidepanelOpen) {
        console.log(`${LOG_PREFIX} 🔄 User navigated away, clearing proofreader session`);
        clearSession();
        void broadcastProofreaderState("visibility:cleared");
      } else if (activeSession && delayedSnapshot.isLoading && !isSidepanelOpen) {
        console.log(`${LOG_PREFIX} ⏳ Proofreader operation in progress, not clearing session`);
      } else if (isSidepanelOpen) {
        console.log(`${LOG_PREFIX} 📱 Sidepanel is open, not clearing session`);
      } else if (!activeSession) {
        console.log(`${LOG_PREFIX} 📭 No active proofreader session to clear`);
      }
    }, 5000); // 5 second delay before clearing on page hide
  }
});

// Handle extension context invalidation
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'EXTENSION_CONTEXT_INVALIDATED') {
    console.log('🔄 Extension context invalidated, clearing proofreader session');
    clearSession();
    sendResponse({ type: 'ACK' });
    return true;
  }

  // ... existing message handlers
});

if (typeof window !== "undefined") {
  window.NanoScribeAutocomplete = {
    schedule: () => {
      if (activeField) {
        scheduleAutocomplete(activeField.element, activeField.fieldId, true);
      }
    },
    test: async () => {
      console.log("[NanoScribe::Content] 🧪 Testing autocomplete directly...");
      if (!activeField) {
        console.log("[NanoScribe::Content] ❌ No active field, please focus on a text field first");
        return;
      }

      const { element, fieldId } = activeField;
      const text = getFieldText(element);
      console.log("[NanoScribe::Content] 📝 Testing with current field text: " + text);

      await runAutocompleteRequest(element, fieldId);
    },
    directTest: async () => {
      console.log("[NanoScribe::Content] 🧪 Testing direct chrome.runtime.sendMessage...");
      if (!activeField) {
        console.log("[NanoScribe::Content] ❌ No active field, please focus on a text field first");
        return;
      }

      const { element, fieldId } = activeField;
      const text = getFieldText(element);
      const caretIndex = getCaretIndex(element);
      const requestId = crypto.randomUUID();
      console.log("[NanoScribe::Content] 📤 Testing direct REQUEST_COMPLETION:", { requestId, textLength: text.length });

      const directResponse = await new Promise<BackgroundResponse>((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: "REQUEST_COMPLETION",
          payload: {
            requestId,
            fieldId,
            text,
            caretIndex,
            fieldType: detectFieldType(element),
            fieldLabel: resolveFieldLabel(element),
            placeholder: resolvePlaceholder(element),
            surroundingText: collectSurroundingText(element, caretIndex),
          },
        }, (response) => {
          const directError = chrome.runtime.lastError;
          if (directError) {
            console.error("[NanoScribe::Content] ❌ Direct message failed:", directError);
            reject(directError);
            return;
          }
          console.log("[NanoScribe::Content] ✅ Direct message response:", response?.type);
          resolve(response as BackgroundResponse);
        });
      });

      console.log("[NanoScribe::Content] 📋 Direct test result:", directResponse);
    },
    status: () => {
      console.log("[NanoScribe::Content] 📊 Current autocomplete state:", autocompleteState);
      console.log("[NanoScribe::Content] 🎯 Active field:", activeField);
      console.log("[NanoScribe::Content] 💡 Latest suggestion:", latestSuggestion);
    },
    testContext: async () => {
      console.log("[NanoScribe::Content] 🧪 Testing context-aware functionality...");
      if (!activeField) {
        console.log("[NanoScribe::Content] ❌ No active field, please focus on a text field first");
        return;
      }

      const { element, fieldId } = activeField;
      const text = getFieldText(element);
      console.log("[NanoScribe::Content] 📝 Testing context-aware completion with: " + text);

      try {
        const previous = await chrome.storage.local.get(["isContextAware"]);
        await chrome.storage.local.set({ isContextAware: true });
        console.log("[NanoScribe::Content] ✅ Context-aware enabled for test");

        await runAutocompleteRequest(element, fieldId);

        await chrome.storage.local.set({ isContextAware: previous.isContextAware ?? false });
        console.log("[NanoScribe::Content] ✅ Restored previous context-aware state");
      } catch (error) {
        console.error("[NanoScribe::Content] ❌ Test failed:", error);
      }
    },
    checkSession: async () => {
      console.log("[NanoScribe::Content] 🧪 Checking current session and memories...");

      try {
        const sessionData = await chrome.storage.local.get(["currentSessionId", "sessionLastActiveTimestamp", "isContextAware"]);
        console.log("[NanoScribe::Content] 📊 Session ID:", sessionData.currentSessionId);
        console.log("[NanoScribe::Content] 🕒 Last active:", new Date(sessionData.sessionLastActiveTimestamp || 0).toLocaleString());
        console.log("[NanoScribe::Content] 🔄 Context-aware:", sessionData.isContextAware);

        await new Promise<void>((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "PING" }, (response) => {
            const pingError = chrome.runtime.lastError;
            if (pingError) {
              console.error("[NanoScribe::Content] ❌ Service worker not available for GET_MEMORIES:", pingError);
              reject(new Error("Service worker not available"));
              return;
            }
            console.log("[NanoScribe::Content] ✅ Service worker available for GET_MEMORIES:", response);
            resolve();
          });
        });

        const memoriesResponse = await chrome.runtime.sendMessage({ type: "GET_MEMORIES" });
        if (memoriesResponse.type === "MEMORIES") {
          console.log("[NanoScribe::Content] 📚 Total memories:", memoriesResponse.payload.length);
          memoriesResponse.payload.slice(0, 3).forEach((memory: MemoryRecord, i: number) => {
            console.log("[NanoScribe::Content] 📖 Memory " + (i + 1) + ": " + memory.title + " (" + memory.url + ")");
          });
        }
      } catch (error) {
        console.error("[NanoScribe::Content] ❌ Failed to check session:", error);
      }
    },
    clearMemories: async (confirmed: boolean = false) => {
      if (!confirmed) {
        console.warn("[NanoScribe::Content] ⚠️ clearMemories requires explicit confirmation. Call with clearMemories(true) to confirm.");
        return;
      }

      console.log("[NanoScribe::Content] 🧪 Clearing all memories...");
      try {
        await new Promise<void>((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "PING" }, (response) => {
            const pingError = chrome.runtime.lastError;
            if (pingError) {
              reject(new Error("Service worker not available"));
              return;
            }
            resolve();
          });
        });

        await chrome.runtime.sendMessage({ type: "CLEAR_ALL_MEMORIES" });
        console.log("[NanoScribe::Content] ✅ Memories cleared");
      } catch (error) {
        console.error("[NanoScribe::Content] ❌ Failed to clear memories:", error);
      }
    },
    toggleContext: async (enabled: boolean): Promise<boolean> => {
      try {
        console.log("[NanoScribe::Content] 🧪 " + (enabled ? 'Enabling' : 'Disabling') + " context-aware mode...");
        await chrome.storage.local.set({ isContextAware: enabled });
        console.log("[NanoScribe::Content] ✅ Context-aware mode " + (enabled ? 'enabled' : 'disabled'));
        return true;
      } catch (error) {
        const action = enabled ? 'enabling' : 'disabling';
        console.error("[NanoScribe::Content] ❌ Failed to " + action + " context-aware mode:", error);
        return false;
      }
    },
  };

  console.log("[NanoScribe::Content] ✅ NanoScribeAutocomplete API initialized successfully");

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log("[NanoScribe::Content] 📄 DOM ready, API should be available");
    });
  }
}

// Helper function to calculate DOM depth between two elements
function getDOMDepth(from: Element, to: Element): number {
  let depth = 0;
  let current: Element | null = from;
  while (current && current !== to) {
    current = current.parentElement;
    depth++;
  }
  return current === to ? depth : -1;
}
function applyAllCorrectionsInContentScript(correctedText: string, originalText: string): { ok: boolean; message: string } {
  console.log('🔍 applyAllCorrectionsInContentScript called');
  console.log('📝 Original text:', `"${originalText}"`);
  console.log('📝 Corrected text:', `"${correctedText}"`);

  return applyCorrectionsToSelection(correctedText, originalText, "all corrections");
}

function applySingleCorrectionInContentScript(correctedText: string, originalText: string): { ok: boolean; message: string } {
  console.log('🔍 applySingleCorrectionInContentScript called');
  console.log('📝 Original text:', `"${originalText}"`);
  console.log('📝 Corrected text:', `"${correctedText}"`);

  return applyCorrectionsToSelection(correctedText, originalText, "single correction");
}

function applyCorrectionsToSelection(correctedText: string, originalText: string, operationType: string): { ok: boolean; message: string } {
  try {
    console.log(`🔄 Applying ${operationType} to selection`);

    // Get the current session
    const session = getCurrentSession();
    if (!session) {
      console.error('❌ No active proofreader session');
      return { ok: false, message: "No active proofreader session" };
    }

    console.log('📊 Session found:', session.id);
    console.log('📍 Selection range data:', session.selectionRange);
    console.log('🎯 Selected element:', session.selectedElement);
    console.log('📝 Original text:', `"${originalText}"`);
    console.log('📝 Corrected text:', `"${correctedText}"`);

    // Try direct text replacement approach first (works for most cases)
    const selectedElement = resolveStoredNodeReference(session.selectedElement);

    if (selectedElement) {
      console.log('🎯 Attempting direct text replacement');

      const element = selectedElement as HTMLElement;

      // Find the actual text-containing element using multiple strategies
      let textElement = element;

      // Strategy 1: Check if selected element itself is a text input
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' ||
          element.contentEditable === 'true') {
        textElement = element;
        console.log('🎯 Selected element is itself a text input:', element.tagName);
      }
      // Strategy 2: Look for text inputs within the selected element
      else {
        const inputs = element.querySelectorAll('input, textarea, [contenteditable]');
        if (inputs.length > 0) {
          textElement = inputs[0] as HTMLElement;
          console.log('🎯 Found text input inside selected element:', textElement.tagName);
        }
        // Strategy 3: Walk up from range containers to find text inputs
        else if (session.selectionRange) {
          const rangeData = session.selectionRange;
          const containers = [
            resolveStoredNodeReference(rangeData.start),
            resolveStoredNodeReference(rangeData.end),
            resolveStoredNodeReference(rangeData.commonAncestor),
          ];

          for (const container of containers) {
            if (container && container.nodeType === Node.ELEMENT_NODE) {
              const el = container as Element;
              // Check if this element or its parents are text inputs
              let current: Element | null = el;
              while (current) {
                if (current.tagName === 'INPUT' || current.tagName === 'TEXTAREA' ||
                    current.getAttribute('contenteditable') === 'true') {
                  textElement = current as HTMLElement;
                  console.log('🎯 Found text input via range container:', textElement.tagName, 'at depth', getDOMDepth(el, current));
                  break;
                }
                current = current.parentElement;
              }
              if (textElement !== element) break;
            }
          }
        }
        // Strategy 4: Search in nearby DOM for text inputs
        if (textElement === element) {
          const nearbyInputs = element.parentElement?.querySelectorAll('input, textarea, [contenteditable]');
          if (nearbyInputs && nearbyInputs.length > 0) {
            textElement = nearbyInputs[0] as HTMLElement;
            console.log('🎯 Found text input in parent element:', textElement.tagName);
          }
        }
      }

      // Get current text based on element type
      let currentText = '';
      if (textElement.tagName === 'INPUT' || textElement.tagName === 'TEXTAREA') {
        currentText = (textElement as HTMLInputElement).value;
      } else {
        currentText = textElement.textContent || '';
      }

      console.log('📄 Current text element:', textElement.tagName, textElement.className || '');
      console.log('📄 Current text content:', `"${currentText}"`);

      // Find and replace the text directly
      if (currentText.includes(originalText)) {
        const newText = currentText.replace(originalText, correctedText);

        if (textElement.tagName === 'INPUT' || textElement.tagName === 'TEXTAREA') {
          (textElement as HTMLInputElement).value = newText;
          // Trigger input event to notify the page
          textElement.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (textElement.contentEditable === 'true') {
          textElement.textContent = newText;
          // Trigger input event for contentEditable
          textElement.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          textElement.textContent = newText;
        }

        console.log('✅ Direct text replacement successful');

        // Clear the session after successful application
        clearSession();
        console.log('🧹 Cleared proofreader session');

        return { ok: true, message: `Successfully applied ${operationType}` };
      } else {
        console.warn('⚠️ Original text not found in element textContent, trying innerHTML');
        // Try to find the text within the element's innerHTML
        const elementHTML = textElement.innerHTML;
        if (elementHTML && elementHTML.includes(originalText)) {
          textElement.innerHTML = elementHTML.replace(originalText, correctedText);
          console.log('✅ InnerHTML replacement successful');

          // Clear the session after successful application
          clearSession();
          console.log('🧹 Cleared proofreader session');

          return { ok: true, message: `Successfully applied ${operationType}` };
        } else {
          console.error('❌ Could not find original text in element');
          return { ok: false, message: 'Original text not found' };
        }
      }
    }

    // Fallback to range-based approach if direct replacement fails
    console.log('📋 Falling back to range-based replacement');

    // Validate the selection range data
    if (!session.selectionRange) {
      console.error('❌ No selection range data stored in session');
      return { ok: false, message: "Selection range data not available" };
    }

    // Check if the range containers are still valid in the current DOM
    try {
      const rangeData = session.selectionRange;
      const startNode = resolveStoredNodeReference(rangeData.start);
      const endNode = resolveStoredNodeReference(rangeData.end);
      const commonAncestor = resolveStoredNodeReference(rangeData.commonAncestor);

      if (!startNode || !endNode || !commonAncestor) {
        console.error('❌ Selection range data is no longer valid in DOM');
        return { ok: false, message: "Selection is no longer valid" };
      }

      if (commonAncestor.nodeType === Node.ELEMENT_NODE && !(commonAncestor as Element).parentElement && commonAncestor !== document) {
        console.error('❌ Selection range data is no longer valid in DOM');
        return { ok: false, message: "Selection is no longer valid" };
      }

      console.log('✅ Selection range data is valid in DOM');

      // Recreate the Range from stored data
      const range = document.createRange();
      try {
        range.setStart(startNode, rangeData.startOffset);
        range.setEnd(endNode, rangeData.endOffset);
        console.log('✅ Range recreated successfully');
      } catch (rangeError) {
        console.error('❌ Failed to recreate range from stored data:', rangeError);
        return { ok: false, message: "Failed to recreate selection range" };
      }

      // Apply the correction using the recreated range
      console.log('✏️ Applying correction to recreated selection range');

      // Select the range
      const selection = window.getSelection();
      if (!selection) {
        console.error('❌ Cannot access window selection');
        return { ok: false, message: "Cannot access selection API" };
      }

      // Clear any existing selection
      selection.removeAllRanges();

      // Add our recreated range
      selection.addRange(range);

      // Replace the selected text
      document.execCommand('insertText', false, correctedText);

      console.log('✅ Correction applied successfully');
      console.log('📝 Final text:', `"${correctedText}"`);

      // Clear the session after successful application
      clearSession();
      console.log('🧹 Cleared proofreader session');

      return { ok: true, message: `Successfully applied ${operationType}` };

    } catch (rangeError) {
      console.error('❌ Error with range-based replacement:', rangeError);
      return { ok: false, message: "Selection range data is invalid" };
    }

  } catch (error) {
    console.error('❌ Error applying corrections:', error);
    const message = error instanceof Error ? error.message : "Unknown error occurred";
    return { ok: false, message: `Failed to apply ${operationType}: ${message}` };
  }
}
