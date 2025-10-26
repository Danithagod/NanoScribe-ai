// Global state and types for the proofreader dialog

export type ProofreaderCorrection = {
  type?: string;
  correction?: string;
  explanation?: string;
  startIndex?: number;
  endIndex?: number;
  replacement?: string;
};

export type ProofreaderSession = {
  id: string;
  selectedText: string;
  selectionRange: Range | null;
  selectedElement: Element | null;
  corrections: ProofreaderCorrection[];
  correctedText: string | null;
  isLoading: boolean;
  error: string | null;
  timestamp: number;
};

export type ProofreaderState = {
  isVisible: boolean;
  selectedText: string;
  corrections: ProofreaderCorrection[];
  isLoading: boolean;
  error: string | null;
  activeSession: ProofreaderSession | null;
  sessionId?: string | null;
  correctedText?: string | null;
};

// Global state for the proofreader dialog
export const proofreaderState: ProofreaderState = {
  isVisible: false,
  selectedText: '',
  corrections: [],
  isLoading: false,
  error: null,
  activeSession: null,
  sessionId: null,
  correctedText: null,
};

// Session management functions
export function createProofreaderSession(selectedText: string, selectionRange: Range | null, selectedElement: Element | null): ProofreaderSession {
  return {
    id: crypto.randomUUID(),
    selectedText,
    selectionRange,
    selectedElement,
    corrections: [],
    correctedText: null,
    isLoading: false,
    error: null,
    timestamp: Date.now(),
  };
}

export function updateSession(session: ProofreaderSession): void {
  proofreaderState.activeSession = session;
  proofreaderState.selectedText = session.selectedText;
  proofreaderState.corrections = session.corrections;
  proofreaderState.isLoading = session.isLoading;
  proofreaderState.error = session.error;
  proofreaderState.sessionId = session.id;
  proofreaderState.correctedText = session.correctedText;
}

export function clearSession(): void {
  proofreaderState.activeSession = null;
  proofreaderState.selectedText = '';
  proofreaderState.corrections = [];
  proofreaderState.isLoading = false;
  proofreaderState.error = null;
  proofreaderState.sessionId = null;
  proofreaderState.correctedText = null;
}

export function getCurrentSession(): ProofreaderSession | null {
  return proofreaderState.activeSession;
}
