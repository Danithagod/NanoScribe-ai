import { initialProofreaderState, reduceProofreaderState, type ProofreaderEvent, type ProofreaderMachineState } from "./proofreader-machine";

type ProofreaderListener = (state: ProofreaderMachineState) => void;

let currentState: ProofreaderMachineState = initialProofreaderState;
const listeners = new Set<ProofreaderListener>();
let initialized = false;

export function getProofreaderState(): ProofreaderMachineState {
  return currentState;
}

export function subscribeToProofreader(listener: ProofreaderListener): () => void {
  listeners.add(listener);
  listener(currentState);
  return () => {
    listeners.delete(listener);
  };
}

function notifySubscribers(): void {
  listeners.forEach((listener) => {
    try {
      listener(currentState);
    } catch (error) {
      console.warn("[NanoScribe] Proofreader listener error", error);
    }
  });
}

export function dispatchProofreader(event: ProofreaderEvent): ProofreaderMachineState {
  const nextState = reduceProofreaderState(currentState, event);
  if (nextState !== currentState) {
    currentState = nextState;
    notifySubscribers();
  }
  return currentState;
}

export function resetProofreaderState(): ProofreaderMachineState {
  currentState = { ...initialProofreaderState, updatedAt: Date.now() };
  notifySubscribers();
  return currentState;
}

export function ensureProofreaderStore(): void {
  if (initialized) {
    return;
  }

  const globalWithStore = globalThis as typeof globalThis & {
    __NanoScribeProofreaderStore__?: ProofreaderMachineState;
  };

  if (globalWithStore.__NanoScribeProofreaderStore__) {
    currentState = globalWithStore.__NanoScribeProofreaderStore__;
  }

  globalWithStore.__NanoScribeProofreaderStore__ = currentState;
  initialized = true;
}
