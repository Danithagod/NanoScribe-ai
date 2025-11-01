import type { ProofreaderEvent } from "./proofreader-machine";

export type ProofreaderRuntimeEventType =
  | "PROOFREADER_EVENT"
  | "PROOFREADER_STATE_SYNC";

export type ProofreaderRuntimeEvent =
  | {
      type: "PROOFREADER_EVENT";
      payload: ProofreaderEvent;
    }
  | {
      type: "PROOFREADER_STATE_SYNC";
      payload: {
        source: "content-script" | "service-worker" | "sidepanel";
      };
    };

export function isProofreaderRuntimeEvent(value: unknown): value is ProofreaderRuntimeEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  if (!("type" in value)) {
    return false;
  }

  const { type } = value as { type?: unknown };
  if (type !== "PROOFREADER_EVENT" && type !== "PROOFREADER_STATE_SYNC") {
    return false;
  }

  if (type === "PROOFREADER_EVENT" || type === "PROOFREADER_STATE_SYNC") {
    return "payload" in (value as Record<string, unknown>);
  }

  return false;
}
