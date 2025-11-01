import type { ProofreaderCorrection } from "./types";

export type ProofreaderStatus =
  | "idle"
  | "collectingSelection"
  | "running"
  | "ready"
  | "applying"
  | "error";

export type ProofreaderEvent =
  | { type: "RESET" }
  | { type: "SELECTION_COLLECTED"; payload: { sessionId: string; text: string } }
  | { type: "RUN_REQUESTED"; payload: { sessionId: string; text: string } }
  | {
      type: "RUN_SUCCEEDED";
      payload: {
        sessionId: string;
        correctedText: string | null;
        corrections: ProofreaderCorrection[];
      };
    }
  | { type: "RUN_FAILED"; payload: { sessionId: string; message: string } }
  | { type: "APPLY_REQUESTED"; payload: { sessionId: string } }
  | { type: "APPLY_SUCCEEDED"; payload: { sessionId: string } }
  | { type: "APPLY_FAILED"; payload: { sessionId: string; message: string } };

export interface ProofreaderMachineState {
  status: ProofreaderStatus;
  sessionId: string | null;
  selectedText: string;
  correctedText: string | null;
  corrections: ProofreaderCorrection[];
  error: string | null;
  isVisible: boolean;
  isLoading: boolean;
  updatedAt: number;
}

export const initialProofreaderState: ProofreaderMachineState = {
  status: "idle",
  sessionId: null,
  selectedText: "",
  correctedText: null,
  corrections: [],
  error: null,
  isVisible: false,
  isLoading: false,
  updatedAt: Date.now(),
};

const STATUS_FLAGS: Record<ProofreaderStatus, { isVisible: boolean; isLoading: boolean }> = {
  idle: { isVisible: false, isLoading: false },
  collectingSelection: { isVisible: true, isLoading: true },
  running: { isVisible: true, isLoading: true },
  ready: { isVisible: true, isLoading: false },
  applying: { isVisible: true, isLoading: true },
  error: { isVisible: true, isLoading: false },
};

function withStatus(
  state: ProofreaderMachineState,
  status: ProofreaderStatus
): ProofreaderMachineState {
  const flags = STATUS_FLAGS[status];
  return {
    ...state,
    status,
    isVisible: flags.isVisible,
    isLoading: flags.isLoading,
    updatedAt: Date.now(),
  };
}

function ensureSessionMatch(
  state: ProofreaderMachineState,
  sessionId: string
): boolean {
  if (!state.sessionId) {
    return true;
  }
  return state.sessionId === sessionId;
}

export function reduceProofreaderState(
  state: ProofreaderMachineState,
  event: ProofreaderEvent
): ProofreaderMachineState {
  switch (event.type) {
    case "RESET":
      return { ...initialProofreaderState, updatedAt: Date.now() };

    case "SELECTION_COLLECTED": {
      const { sessionId, text } = event.payload;
      return withStatus(
        {
          ...state,
          sessionId,
          selectedText: text,
          correctedText: null,
          corrections: [],
          error: null,
        },
        "collectingSelection"
      );
    }

    case "RUN_REQUESTED": {
      const { sessionId, text } = event.payload;
      return withStatus(
        {
          ...state,
          sessionId,
          selectedText: text,
          correctedText: null,
          corrections: [],
          error: null,
        },
        "running"
      );
    }

    case "RUN_SUCCEEDED": {
      const { sessionId, correctedText, corrections } = event.payload;
      if (!ensureSessionMatch(state, sessionId)) {
        return state;
      }
      return withStatus(
        {
          ...state,
          correctedText,
          corrections,
          error: null,
        },
        "ready"
      );
    }

    case "RUN_FAILED": {
      const { sessionId, message } = event.payload;
      if (!ensureSessionMatch(state, sessionId)) {
        return state;
      }
      return withStatus(
        {
          ...state,
          correctedText: null,
          corrections: [],
          error: message,
        },
        "error"
      );
    }

    case "APPLY_REQUESTED": {
      const { sessionId } = event.payload;
      if (!ensureSessionMatch(state, sessionId)) {
        return state;
      }
      return withStatus({ ...state }, "applying");
    }

    case "APPLY_SUCCEEDED": {
      const { sessionId } = event.payload;
      if (!ensureSessionMatch(state, sessionId)) {
        return state;
      }
      return withStatus({ ...state, error: null }, "ready");
    }

    case "APPLY_FAILED": {
      const { sessionId, message } = event.payload;
      if (!ensureSessionMatch(state, sessionId)) {
        return state;
      }
      return withStatus(
        {
          ...state,
          error: message,
        },
        "error"
      );
    }

    default:
      return state;
  }
}
