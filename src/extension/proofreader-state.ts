/// <reference lib="es2021.weakref" />

import {
  dispatchProofreader,
  ensureProofreaderStore,
  getProofreaderState,
  resetProofreaderState,
  subscribeToProofreader,
} from "./proofreader-store";
import type { ProofreaderMachineState } from "./proofreader-machine";
import type { ProofreaderCorrection } from "./types";

ensureProofreaderStore();

export type StoredNodeReference = {
  ref: WeakRef<Node> | null;
  path: number[] | null;
};

export type StoredSelectionRange = {
  start: StoredNodeReference;
  end: StoredNodeReference;
  commonAncestor: StoredNodeReference;
  startOffset: number;
  endOffset: number;
};

function nodeIsConnected(node: Node | null): boolean {
  if (!node) return false;
  if ("isConnected" in node) {
    return (node as Node).isConnected;
  }
  const owner = (node as { ownerDocument?: Document }).ownerDocument ?? document;
  return owner.contains(node);
}

function getNodePath(node: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = node;

  while (current && current !== document) {
    const parent = current.parentNode;
    if (!parent) return null;

    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    if (index === -1) return null;

    path.unshift(index);
    current = parent;
  }

  return path;
}

function resolveNodePath(path: number[] | null): Node | null {
  if (!path) return null;

  let current: Node | null = document;
  for (const index of path) {
    if (!current || index < 0 || index >= current.childNodes.length) {
      return null;
    }
    current = current.childNodes[index];
  }

  return current;
}

function createNodeReference(node: Node | null): StoredNodeReference | null {
  if (!node) {
    return null;
  }

  const path = getNodePath(node);
  const hasWeakRef = typeof WeakRef !== "undefined";

  return {
    ref: hasWeakRef ? new WeakRef(node) : null,
    path,
  };
}

export function resolveStoredNodeReference(reference: StoredNodeReference | null): Node | null {
  if (!reference) {
    return null;
  }

  const candidate = reference.ref?.deref?.() ?? null;
  if (candidate && nodeIsConnected(candidate)) {
    return candidate;
  }

  const resolved = resolveNodePath(reference.path);
  if (resolved && nodeIsConnected(resolved)) {
    if (typeof WeakRef !== "undefined") {
      reference.ref = new WeakRef(resolved);
    }
    return resolved;
  }

  reference.ref = null;
  return null;
}

function pruneDetachedSessionData(session: ProofreaderSession | null): void {
  if (!session?.selectionRange) {
    // Still validate selected element
    if (session?.selectedElement && !resolveStoredNodeReference(session.selectedElement)) {
      session.selectedElement = null;
    }
    return;
  }

  const { start, end, commonAncestor } = session.selectionRange;
  const startNode = resolveStoredNodeReference(start);
  const endNode = resolveStoredNodeReference(end);
  const ancestorNode = resolveStoredNodeReference(commonAncestor);

  if (!startNode || !endNode || !ancestorNode) {
    session.selectionRange = null;
  }

  if (session.selectedElement && !resolveStoredNodeReference(session.selectedElement)) {
    session.selectedElement = null;
  }
}

export type ProofreaderSession = {
  id: string;
  selectedText: string;
  selectionRange: StoredSelectionRange | null;
  selectedElement: StoredNodeReference | null;
  corrections: ProofreaderCorrection[];
  correctedText: string | null;
  isLoading: boolean;
  error: string | null;
  timestamp: number;
  abortController: AbortController | null;
};

export type ProofreaderState = ProofreaderMachineState;

let activeSession: ProofreaderSession | null = null;

export { subscribeToProofreader, getProofreaderState };
export { dispatchProofreader };

export function getProofreaderSnapshot(): ProofreaderMachineState {
  return getProofreaderState();
}

export function createProofreaderSession(
  selectedText: string,
  selectionRange: Range | null,
  selectedElement: Element | null,
): ProofreaderSession {
  let rangeData: ProofreaderSession["selectionRange"] = null;
  let selectedElementRef: ProofreaderSession["selectedElement"] = null;
  if (selectionRange) {
    const start = createNodeReference(selectionRange.startContainer);
    const end = createNodeReference(selectionRange.endContainer);
    const commonAncestor = createNodeReference(selectionRange.commonAncestorContainer);

    if (start && end && commonAncestor) {
      rangeData = {
        start,
        end,
        commonAncestor,
        startOffset: selectionRange.startOffset,
        endOffset: selectionRange.endOffset,
      };
    }
  }

  if (selectedElement) {
    selectedElementRef = createNodeReference(selectedElement);
  }

  return {
    id: crypto.randomUUID(),
    selectedText,
    selectionRange: rangeData,
    selectedElement: selectedElementRef,
    corrections: [],
    correctedText: null,
    isLoading: false,
    error: null,
    timestamp: Date.now(),
    abortController: null,
  };
}

export function setActiveSession(session: ProofreaderSession): void {
  activeSession = session;
  dispatchProofreader({
    type: "SELECTION_COLLECTED",
    payload: { sessionId: session.id, text: session.selectedText },
  });
}

export function markProofreaderRunning(sessionId: string, text: string): void {
  if (activeSession && activeSession.id === sessionId) {
    activeSession.isLoading = true;
    activeSession.error = null;
    pruneDetachedSessionData(activeSession);
    dispatchProofreader({ type: "RUN_REQUESTED", payload: { sessionId, text } });
  }
}

export function markProofreaderSuccess(
  sessionId: string,
  correctedText: string | null,
  corrections: ProofreaderCorrection[],
): void {
  if (activeSession && activeSession.id === sessionId) {
    activeSession.isLoading = false;
    activeSession.error = null;
    activeSession.correctedText = correctedText;
    activeSession.corrections = corrections;
    pruneDetachedSessionData(activeSession);
    dispatchProofreader({
      type: "RUN_SUCCEEDED",
      payload: { sessionId, correctedText, corrections },
    });
  }
}

export function markProofreaderError(sessionId: string, message: string): void {
  if (activeSession && activeSession.id === sessionId) {
    activeSession.isLoading = false;
    activeSession.error = message;
    activeSession.correctedText = null;
    activeSession.corrections = [];
    pruneDetachedSessionData(activeSession);
    dispatchProofreader({ type: "RUN_FAILED", payload: { sessionId, message } });
  }
}

export function markApplyRequested(sessionId: string): void {
  dispatchProofreader({ type: "APPLY_REQUESTED", payload: { sessionId } });
}

export function markApplySucceeded(sessionId: string): void {
  dispatchProofreader({ type: "APPLY_SUCCEEDED", payload: { sessionId } });
}

export function markApplyFailed(sessionId: string, message: string): void {
  dispatchProofreader({ type: "APPLY_FAILED", payload: { sessionId, message } });
}

export function clearSession(): void {
  console.log(" Clearing proofreader session");
  if (activeSession?.abortController) {
    try {
      activeSession.abortController.abort();
    } catch (error) {
      console.warn("Failed to abort proofreader controller", error);
    }
  }
  activeSession = null;
  resetProofreaderState();
}

export function getCurrentSession(): ProofreaderSession | null {
  return activeSession;
}

export function setProofreaderAbortController(controller: AbortController): void {
  if (activeSession) {
    activeSession.abortController = controller;
  }
}

export function abortProofreaderSession(reason: string): void {
  if (activeSession?.abortController) {
    try {
      activeSession.abortController.abort(reason);
    } catch (error) {
      console.warn("Failed to abort proofreader session", error);
    }
  }
  clearSession();
}
