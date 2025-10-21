export function ensureFieldId(element: HTMLElement): string {
  const existing = element.getAttribute("data-nanoscribe-field-id");
  if (existing) return existing;
  const newId = `field-${crypto.randomUUID()}`;
  element.setAttribute("data-nanoscribe-field-id", newId);
  return newId;
}

declare global {
  interface Window {
    ensureFieldId?: typeof ensureFieldId;
  }
}

if (typeof window !== "undefined" && !window.ensureFieldId) {
  window.ensureFieldId = ensureFieldId;
}

export {};

