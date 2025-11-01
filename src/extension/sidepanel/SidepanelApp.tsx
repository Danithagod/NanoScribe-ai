/// <reference types="chrome" />

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { ModelStatusSection } from "@/components/ModelStatusSection";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { ProofreaderCorrection } from "../types";
import { ModelControlPanel } from "@/components/ModelControlPanel";
import type {
  AskContextItem,
  AutocompleteState,
  DiagnosticsSettings,
  DiagnosticsSnapshot,
  MemoryRecord,
  MemorySearchResult,
  ModelIdentifier,
  ModelStatus,
  ModelStatusMap,
  SessionGroup,
} from "../types";
import { sendToBackground, type AutocompleteCommand, type BackgroundEvent } from "../messaging";
import { getProofreaderSnapshot, type ProofreaderState } from "../proofreader-state";
import { isBackgroundEvent } from "../messaging";
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  Loader2,
  TestTube,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  BarChart3,
  ExternalLink,
  Sparkles,
  RotateCcw,
  BookOpen,
  MessageCircle,
  PenLine,
  X,
  Settings,
  Search,
} from "lucide-react";
import logoImage from "@/assets/nanoscribe.svg";

async function requestProofreaderCancel(sessionId?: string | null): Promise<void> {
  try {
    const response = await sendToBackground({
      type: "CANCEL_PROOFREADER_SESSION",
      payload: sessionId ? { sessionId } : undefined,
    });

    if (response.type !== "ACK") {
      console.warn("[NanoScribe::Sidepanel] Cancel request returned unexpected response", response);
    }
  } catch (error) {
    console.error("[NanoScribe::Sidepanel] Failed to cancel proofreader session", error);
  }
}

const MODEL_METADATA: Record<ModelIdentifier, { label: string; description: string }> = {
  languageModel: {
    label: "Language Model",
    description: "Autocomplete & memory ranking",
  },
  proofreader: {
    label: "Proofreader",
    description: "On-device corrections",
  },
  summarizer: {
    label: "Summarizer",
    description: "Key point summaries",
  },
};

const MODEL_STATUS_PRIORITY: Record<ModelStatus["state"], number> = {
  error: 0,
  downloading: 1,
  checking: 2,
  unavailable: 3,
  idle: 4,
  ready: 5,
};

const AUTOCOMPLETE_STATUS_COPY: Record<AutocompleteState["status"], string> = {
  idle: "Waiting for an editable field",
  listening: "Listening for changes",
  pending: "Generating a suggestion…",
  suggestion: "Suggestion ready",
  error: "Autocomplete unavailable",
};

const DEFAULT_DIAGNOSTICS_SETTINGS: DiagnosticsSettings = {
  verboseLogging: false,
  trackMetrics: true,
};

const SOURCE_TAGS_TO_HIDE = new Set(["readability", "legacy", "memory", "ai-organized", "auto-organized", "auto-organized-new-session", "reprocessed"]);
const INITIAL_ASK_STATE: AskState = { question: "", answer: null, status: "idle", context: [], error: null };

type SessionTitleCache = Record<string, string>;
type SessionRenameState = {
  sessionId: string;
  draft: string;
  isSaving: boolean;
};

type AskStateStatus = "idle" | "loading" | "answered" | "no-context" | "model-unavailable" | "error";

type AskState = {
  question: string;
  answer: string | null;
  status: AskStateStatus;
  context: AskContextItem[];
  error?: string | null;
};

function getPrimaryDomainFromMemories(memories: MemoryRecord[]): string | null {
  const counts = new Map<string, number>();
  for (const memory of memories) {
    if (!memory.url) {
      continue;
    }
    try {
      const host = new URL(memory.url).hostname.replace(/^www\./, "");
      counts.set(host, (counts.get(host) ?? 0) + 1);
    } catch (error) {
      // Ignore invalid URLs
    }
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [host, count] of counts) {
    if (count > bestCount) {
      best = host;
      bestCount = count;
    }
  }
  return best;
}

function humanizeSessionId(raw: string): string | null {
  const cleaned = raw.replace(/^[a-z]+-/, "");
  const words = cleaned.split(/[-_]+/).filter(Boolean);
  if (words.length === 0) {
    return null;
  }

  const isUuidLike = words.every((word) => /^[0-9a-f]{4,}$/i.test(word));
  if (isUuidLike) {
    return null;
  }

  const human = words
    .map((word) => {
      if (word.length <= 3) {
        return word.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");

  return human.length > 60 ? `${human.slice(0, 57)}…` : human;
}

function deriveSessionInfo(session: SessionGroup, sessionTitleMap: SessionTitleCache): { title: string; subtitle?: string } {
  const domain = getPrimaryDomainFromMemories(session.memories);
  const relative = formatRelativeTime(session.lastActivity);

  if (sessionTitleMap[session.sessionId]) {
    return {
      title: sessionTitleMap[session.sessionId],
      subtitle: domain ? `Includes ${domain}` : `Last updated ${relative}`,
    };
  }

  if (session.sessionId === "no-session") {
    return {
      title: "Unorganized",
      subtitle: domain ? `Top site: ${domain}` : "Memories waiting to be organized",
    };
  }

  if (session.sessionId === "search-results") {
    return {
      title: "Search Results",
      subtitle: domain ? `Includes matches from ${domain}` : undefined,
    };
  }

  if (session.sessionId.startsWith("ai-")) {
    const slug = session.sessionId.replace(/^ai-/, "");
    const human = humanizeSessionId(slug.replace(/-[0-9]+$/, "")) ?? humanizeSessionId(slug);
    if (human) {
      return {
        title: human,
        subtitle: domain ? `Includes ${domain}` : `Last updated ${relative}`,
      };
    }
  }

  if (session.sessionId.startsWith("auto-session-")) {
    return {
      title: domain ?? "Recent browsing session",
      subtitle: `Captured ${relative}`,
    };
  }

  const human = humanizeSessionId(session.sessionId);
  if (human) {
    return {
      title: human,
      subtitle: domain ? `Includes ${domain}` : `Last updated ${relative}`,
    };
  }

  return {
    title: domain ?? "Browsing session",
    subtitle: `Captured ${relative}`,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, query: string): React.ReactNode {
  const tokens = Array.from(new Set(query.toLowerCase().split(/\s+/).filter(Boolean)));
  if (tokens.length === 0) {
    return text;
  }

  const pattern = new RegExp(`(${tokens.map(escapeRegex).join("|")})`, "gi");
  const parts = text.split(pattern);

  return parts.map((part, index) => {
    if (tokens.includes(part.toLowerCase())) {
      return (
        <mark key={`${part}-${index}`} className="rounded bg-primary/10 px-0.5 text-primary">
          {part}
        </mark>
      );
    }
    return <Fragment key={`${part}-${index}`}>{part}</Fragment>;
  });
}

function buildSnippet(chunk: MemorySearchResult["chunk"]): string | null {
  const source = chunk.keyPoints?.trim() || chunk.rawText?.trim();
  if (!source) {
    return null;
  }

  const cleaned = source
    .replace(/^-\s*/gm, "")
    .replace(/\n-\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return null;
  }

  const limit = 200;
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function deriveTitle(result: MemorySearchResult): string {
  const title = result.memory?.title?.trim();
  if (title) {
    return title;
  }
  const chunkTitle = result.chunk.chunkTitle?.trim();
  if (chunkTitle) {
    return chunkTitle;
  }
  if (result.memory?.url) {
    try {
      const { pathname } = new URL(result.memory.url);
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length > 0) {
        return segments[segments.length - 1].replace(/[-_]/g, " ");
      }
    } catch (error) {
      // ignore parsing failure
    }
  }
  return "Untitled result";
}

function deriveUrlParts(result: MemorySearchResult): { href: string | null; domain: string | null; path: string | null } {
  const href = result.memory?.url ?? null;
  if (!href) {
    return { href: null, domain: null, path: null };
  }
  try {
    const url = new URL(href);
    const path = url.pathname.replace(/\/$/, "") || "/";
    return {
      href,
      domain: url.hostname.replace(/^www\./, ""),
      path: path.length > 60 ? `${path.slice(0, 57)}…` : path,
    };
  } catch (error) {
    return { href, domain: null, path: null };
  }
}

function shouldShowSourceTag(tag: string | undefined): boolean {
  if (!tag) {
    return false;
  }
  return !SOURCE_TAGS_TO_HIDE.has(tag);
}

function createFallbackStatuses(): ModelStatusMap {
  const now = Date.now();
  return {
    languageModel: { id: "languageModel", state: "idle", progress: 0, message: "Awaiting status", updatedAt: now },
    proofreader: { id: "proofreader", state: "idle", progress: 0, message: "Awaiting status", updatedAt: now },
    summarizer: { id: "summarizer", state: "idle", progress: 0, message: "Awaiting status", updatedAt: now },
  };
}

function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleTimeString();
  }
}

// Enhanced relative time formatting
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMinutes < 1) {
    return "Just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `${months} month${months === 1 ? '' : 's'} ago`;
  } else {
    const years = Math.floor(diffDays / 365);
    return `${years} year${years === 1 ? '' : 's'} ago`;
  }
}

// URL shortening utility
function shortenUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const path = urlObj.pathname + urlObj.search;
    // Show domain + first part of path, truncate if too long
    const shortPath = path.length > 20 ? path.substring(0, 20) + "..." : path;
    return domain + (shortPath !== "/" ? shortPath : "");
  } catch {
    // Fallback if URL parsing fails
    return url.length > 40 ? url.substring(0, 40) + "..." : url;
  }
}

function hashStringToHue(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash) % 360;
}

function getSessionAccent(sessionId: string): { backgroundColor: string; borderColor: string } {
  if (sessionId === "no-session") {
    return { backgroundColor: "hsl(210, 10%, 80%)", borderColor: "hsl(210, 10%, 65%)" };
  }
  if (sessionId === "search-results") {
    return { backgroundColor: "hsl(45, 90%, 65%)", borderColor: "hsl(45, 90%, 50%)" };
  }

  const hue = hashStringToHue(sessionId);
  const saturation = 65;
  const lightness = 55;
  const borderLightness = Math.max(20, lightness - 15);

  return {
    backgroundColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
    borderColor: `hsl(${hue}, ${saturation}%, ${borderLightness}%)`,
  };
}

function getModelStatusBadge(status: ModelStatus): { label: string; tone: "success" | "muted" | "warning" | "destructive" } {
  switch (status.state) {
    case "ready":
      return { label: "Ready", tone: "success" };
    case "downloading":
      return { label: "Downloading", tone: "warning" };
    case "checking":
      return { label: "Checking", tone: "muted" };
    case "unavailable":
      return { label: "Unavailable", tone: "warning" };
    case "error":
      return { label: "Error", tone: "destructive" };
    default:
      return { label: "Idle", tone: "muted" };
  }
}

// Component for proofreader content in side panel
const ProofreaderContent: React.FC<{
  state: ProofreaderState;
  onStateChange: (state: ProofreaderState) => void;
}> = ({ state, onStateChange }) => {
  console.log("🎨 ProofreaderContent rendering with state:", state);

  const handleAccept = async () => {
    if (state.error) {
      window.location.reload();
      return;
    }

    if (state.corrections.length === 0) {
      onStateChange({ ...state, isVisible: false, status: "idle" });
      return;
    }

    console.log("🎯 Sidepanel: User clicked Accept All");
    console.log("📋 Sending corrected text for application");

    const correctedText = state.correctedText;

    if (!correctedText) {
      console.error("❌ No corrected text available");
      return;
    }

    console.log("📝 Original text:", state.selectedText);
    console.log("📝 Corrected text:", correctedText);
    console.log("🔑 Session ID:", state.sessionId);

    try {
      const response = await sendToBackground({
        type: "APPLY_PROOFREADER_CORRECTIONS",
        payload: {
          correctedText,
          originalText: state.selectedText,
          sessionId: state.sessionId,
        },
      });

      console.log("✅ Accept All response received:", response.type);

      if (response.type === "CORRECTIONS_APPLIED") {
        console.log("All corrections applied successfully");
        onStateChange({
          ...state,
          isVisible: false,
          status: "idle",
          correctedText: null,
          corrections: [],
          selectedText: "",
          error: null,
        });
      } else if (response.type === "ERROR") {
        console.error("Failed to apply corrections:", response.message);
      }
    } catch (error) {
      console.error("Error applying corrections:", error);
    }
  };

  const handleIndividualCorrection = async (correction: ProofreaderCorrection) => {
    console.log("🎯 Sidepanel: User clicked individual correction");
    console.log("📝 Correction:", correction);
    console.log("📝 Original text:", state.selectedText);
    console.log("🔑 Session ID:", state.sessionId);

    const correctedText = state.correctedText;

    if (!correctedText) {
      console.error("❌ No corrected text available");
      return;
    }

    console.log("📝 Using corrected text:", correctedText);

    try {
      const response = await sendToBackground({
        type: "APPLY_SINGLE_CORRECTION",
        payload: {
          correctedText,
          originalText: state.selectedText,
          sessionId: state.sessionId,
        },
      });

      console.log("✅ Individual correction response received:", response.type);

      if (response.type === "CORRECTION_APPLIED") {
        console.log("Single correction applied successfully");
        onStateChange({
          ...state,
          isVisible: false,
          status: "idle",
          correctedText: null,
          corrections: [],
          selectedText: "",
          error: null,
        });
      } else if (response.type === "ERROR") {
        console.error("Failed to apply single correction:", response.message);
      }
    } catch (error) {
      console.error("Error applying single correction:", error);
    }
  };

  const handleCancel = () => {
    onStateChange({
      ...state,
      status: "idle",
      isVisible: false,
      corrections: [],
      correctedText: null,
      selectedText: "",
      error: null,
    });
    void requestProofreaderCancel(state.sessionId ?? null);
  };

  if (!state.isVisible) {
    return (
      <div className="glass-card rounded-2xl border border-dashed border-white/15 bg-white/5 p-10 text-center text-sm text-muted-foreground">
        <div className="mx-auto mb-4 h-12 w-12 rounded-2xl bg-white/5 backdrop-blur">
          <span className="fancy-spinner" aria-hidden="true" />
        </div>
        <p>Select text on the page to start proofreading.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-white/10 p-2">
              <PenLine className="h-4 w-4" />
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Selected Text</p>
              <h3 className="text-sm font-semibold text-card-foreground">Proofreader</h3>
            </div>
          </div>
          {state.status === "running" ? (
            <span className="fancy-spinner sm" aria-label="Analyzing text" />
          ) : null}
        </div>
        <div className="mt-3 max-h-32 overflow-y-auto rounded-xl border border-white/5 bg-black/10 p-3">
          <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
            {state.selectedText}
          </p>
        </div>
      </div>

      {state.status === "running" && (
        <div className="glass-card flex items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-muted-foreground shadow-lg">
          <span className="fancy-spinner" aria-hidden="true" />
          <span>Analyzing text…</span>
        </div>
      )}

      {state.status === "error" && state.error && (
        <div className="glass-card rounded-2xl border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-100 shadow-lg">
          {state.error}
        </div>
      )}

      {state.status === "ready" && state.corrections.length > 0 && (
        <div className="max-h-64 space-y-3 overflow-y-auto">
          {state.corrections.map((correction, index) => (
            <button
              key={index}
              type="button"
              onClick={() => handleIndividualCorrection(correction)}
              className="glass-card block w-full rounded-2xl border border-white/10 bg-white/5 p-4 text-left transition hover:border-white/30 hover:bg-white/10"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-card-foreground">
                <Badge variant="secondary" className="border-white/20 bg-white/10 text-[11px]">
                  {correction.type}
                </Badge>
                <span>{correction.correction}</span>
              </div>
              {correction.explanation ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {correction.explanation}
                </p>
              ) : null}
              <p className="mt-3 text-xs text-primary/80">Tap to apply this correction</p>
            </button>
          ))}
        </div>
      )}

      {state.status === "ready" && state.corrections.length === 0 && (
        <div className="glass-card flex items-center gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100 shadow-lg">
          <Badge variant="secondary" className="border-emerald-200/40 bg-emerald-100/20 text-emerald-50">
            ✓
          </Badge>
          <span>No corrections needed. The text looks great!</span>
        </div>
      )}

      <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-4 shadow-lg">
        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={handleCancel}
            className="flex-1 rounded-xl border-white/20 bg-white/5 text-xs uppercase tracking-wide text-muted-foreground hover:border-white/40 hover:bg-white/10"
          >
            Cancel
          </Button>
          <Button
            onClick={handleAccept}
            disabled={state.corrections.length === 0 && state.status !== "error"}
            className={`flex-1 rounded-xl text-xs uppercase tracking-wide ${state.status === "error" ? "bg-red-500/80 hover:bg-red-500 text-white" : "bg-primary hover:bg-primary/90 text-primary-foreground"}`}
          >
            {state.status === "error" ? "Reload Page" : "Accept All"}
          </Button>
        </div>
      </div>
    </div>
  );
};

// Component for autocomplete content in side panel
const AutocompleteContent: React.FC<{
  state: AutocompleteState | null;
  onCommand: (command: AutocompleteCommand) => void;
}> = ({ state, onCommand }) => {
  if (!state) {
    return (
      <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-6 text-center shadow-lg">
        <div className="mx-auto mb-3 h-10 w-10 rounded-2xl bg-white/5 backdrop-blur">
          <Sparkles className="h-full w-full p-2 text-primary" />
        </div>
        <h3 className="text-sm font-semibold text-card-foreground">No active field</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Click inside a text box to see autocomplete suggestions.
        </p>
      </div>
    );
  }

  const getStatusBadge = (status: AutocompleteState["status"]) => {
    switch (status) {
      case "idle":
        return { label: "Idle", tone: "muted" as const };
      case "listening":
        return { label: "Listening", tone: "success" as const };
      case "pending":
        return { label: "Generating", tone: "warning" as const };
      case "suggestion":
        return { label: "Ready", tone: "success" as const };
      case "error":
        return { label: "Error", tone: "destructive" as const };
      default:
        return { label: status, tone: "muted" as const };
    }
  };

  const statusInfo = getStatusBadge(state.status);

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-card-foreground">
            <Sparkles className="h-4 w-4" />
            Autocomplete Status
          </div>
          <Badge
            variant="secondary"
            className={`text-[11px] uppercase tracking-wide ${
              statusInfo.tone === "success"
                ? "border-emerald-200/40 bg-emerald-100/20 text-emerald-50"
                : statusInfo.tone === "warning"
                  ? "border-amber-200/40 bg-amber-100/20 text-amber-50"
                  : statusInfo.tone === "destructive"
                    ? "border-red-200/40 bg-red-100/20 text-red-50"
                    : "border-white/30 bg-white/10 text-muted-foreground"
            }`}
          >
            {statusInfo.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {AUTOCOMPLETE_STATUS_COPY[state.status]}
        </p>

        {state.suggestion && (
          <div className="mt-4 space-y-2">
            <div className="text-xs font-medium text-card-foreground">Current Suggestion</div>
            <div className="glass-card rounded-xl border border-white/5 bg-black/10 p-3 text-xs font-mono text-muted-foreground whitespace-pre-wrap">
              {state.suggestion.completionText}
            </div>
            {state.fieldPreview ? (
              <div className="glass-card rounded-xl border border-white/5 bg-white/5 p-2 text-[11px] text-muted-foreground">
                Context: {state.fieldPreview}
              </div>
            ) : null}
          </div>
        )}

        {state.error && (
          <div className="mt-4 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-xs text-red-100">
            {state.error}
          </div>
        )}
      </div>

      {state.suggestion && (
        <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-4 shadow-lg">
          <div className="grid grid-cols-3 gap-2">
            <Button
              size="sm"
              onClick={() => onCommand("accept")}
              className="rounded-xl bg-emerald-500/80 text-xs uppercase tracking-wide text-white shadow-inner transition hover:bg-emerald-500"
            >
              Accept (Tab)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCommand("decline")}
              className="rounded-xl border-white/20 bg-white/5 text-xs uppercase tracking-wide text-muted-foreground hover:border-white/40 hover:bg-white/10"
            >
              Decline (Esc)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onCommand("regenerate")}
              className="rounded-xl border-white/20 bg-white/5 text-xs uppercase tracking-wide text-muted-foreground hover:border-white/40 hover:bg-white/10"
            >
              Regenerate
            </Button>
          </div>
        </div>
      )}

      {state.status === "error" && (
        <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-4 shadow-lg">
          <Button
            size="sm"
            onClick={() => onCommand("clear")}
            className="w-full rounded-xl bg-white/10 text-xs uppercase tracking-wide text-muted-foreground hover:bg-white/20"
          >
            Clear Error
          </Button>
        </div>
      )}
    </div>
  );
};

export function SidepanelApp() {
  const [filter, setFilter] = useState("");
  const [askInput, setAskInput] = useState("");
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sessionGroups, setSessionGroups] = useState<SessionGroup[]>([]);
  const [modelStatuses, setModelStatuses] = useState<ModelStatusMap>(createFallbackStatuses);
  const [hasLoadedModelStatuses, setHasLoadedModelStatuses] = useState(false);
  const [autocompleteState, setAutocompleteState] = useState<AutocompleteState | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [isAIOrganizing, setIsAIOrganizing] = useState(false);
  const [aiOrganizeStatus, setAiOrganizeStatus] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("memories");
  const [proofreaderStateLocal, setProofreaderStateLocal] = useState<ProofreaderState>(() => getProofreaderSnapshot());
  const [lastStateUpdate, setLastStateUpdate] = useState<string | null>(null);
  const [isContextAware, setIsContextAware] = useState(true);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsSettings, setDiagnosticsSettings] = useState<DiagnosticsSettings>(DEFAULT_DIAGNOSTICS_SETTINGS);
  const [deleteState, setDeleteState] = useState<{ memoryId: string | null; isDeleting: boolean }>({
    memoryId: null,
    isDeleting: false
  });
  // Collapsible state for memory cards - tracks which memories are expanded
  const [expandedMemories, setExpandedMemories] = useState<Set<string>>(new Set());
  const [searchResults, setSearchResults] = useState<MemorySearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [sessionTitleMap, setSessionTitleMap] = useState<SessionTitleCache>({});
  const [renameState, setRenameState] = useState<SessionRenameState | null>(null);
  const [askState, setAskState] = useState<AskState>(INITIAL_ASK_STATE);
  const [searchMode, setSearchMode] = useState<"memories" | "ask">("memories");
  const askQueryRef = useRef<string | null>(null);

  useEffect(() => {
    chrome.storage.local.get({ sessionTitles: {} as SessionTitleCache }, (entries) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        console.error("[NanoScribe] Failed to load stored session titles:", runtimeError);
        return;
      }

      const storedTitles = entries.sessionTitles ?? {};
      if (storedTitles && Object.keys(storedTitles).length > 0) {
        setSessionTitleMap(storedTitles);
      }
    });
  }, []);

  useEffect(() => {
    if (searchMode === "memories") {
      askQueryRef.current = null;
      setAskState(INITIAL_ASK_STATE);
    } else {
      setIsSearching(false);
    }
  }, [searchMode]);

  const runAskQuery = useCallback(async (question: string) => {
    const trimmed = question.trim();

    if (!trimmed) {
      askQueryRef.current = null;
      setAskState(INITIAL_ASK_STATE);
      return;
    }

    askQueryRef.current = trimmed;
    setAskState({
      question: trimmed,
      answer: null,
      status: "loading",
      context: [],
      error: null,
    });

    try {
      const response = await sendToBackground({ type: "ASK_NANOSCRIBE", payload: { question: trimmed } });

      if (askQueryRef.current !== trimmed) {
        return;
      }

      if (response.type === "ASK_RESPONSE") {
        const payload = response.payload;
        setAskState({
          question: trimmed,
          answer: payload.answer,
          status: payload.status,
          context: payload.context,
          error: payload.error ?? null,
        });
      } else if (response.type === "ERROR") {
        setAskState({
          question: trimmed,
          answer: null,
          status: "error",
          context: [],
          error: response.message ?? "Something went wrong.",
        });
      }
    } catch (error) {
      if (askQueryRef.current !== trimmed) {
        return;
      }

      const message = error instanceof Error ? error.message : "Unable to reach NanoScribe right now.";
      setAskState({
        question: trimmed,
        answer: null,
        status: "error",
        context: [],
        error: message,
      });
    }
  }, []);

  const handleAskSubmit = useCallback(() => {
    if (searchMode !== "ask") {
      return;
    }

    const trimmed = askInput.trim();

    if (!trimmed) {
      setAskState((prev) => ({
        ...prev,
        question: "",
        answer: null,
        status: "error",
        context: [],
        error: "Please enter a question.",
      }));
      return;
    }

    if (trimmed !== askInput) {
      setAskInput(trimmed);
    }

    runAskQuery(trimmed);
  }, [askInput, runAskQuery, searchMode]);

  const renderAskResult = useCallback(() => {
    if (askState.status === "idle") {
      return (
        <div className="glass-card rounded-2xl border border-white/12 bg-black/25 p-6 text-sm text-muted-foreground">
          Ask NanoScribe any question about what you've read. We'll search your stored memories and answer using only on-device data.
        </div>
      );
    }

    if (askState.status === "loading") {
      return (
        <div className="glass-card flex items-center gap-3 rounded-2xl border border-white/12 bg-black/25 p-6 text-sm text-muted-foreground">
          <span className="fancy-spinner" aria-hidden="true" />
          <span>Searching your memories…</span>
        </div>
      );
    }

    if (askState.status === "error") {
      return (
        <div className="glass-card rounded-2xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-100">
          {askState.error ?? "Something went wrong."}
        </div>
      );
    }

    if (askState.status === "model-unavailable") {
      return (
        <div className="glass-card rounded-2xl border border-white/12 bg-black/25 p-5 text-sm text-muted-foreground">
          We couldn't load the language model to answer this question right now. Try again after the model finishes downloading.
        </div>
      );
    }

    const showNoContext = askState.status === "no-context";

    return (
      <div className="glass-card space-y-4 rounded-2xl border border-white/12 bg-black/25 p-5 text-sm text-foreground/90 shadow-lg">
        <div className="space-y-1">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Answer</p>
          <p className="text-[11px] font-medium uppercase tracking-[0.25em] text-muted-foreground/80">Question</p>
          <p className="text-sm text-muted-foreground/90">{askState.question}</p>
        </div>
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Response</p>
          <p className="leading-relaxed whitespace-pre-line">{askState.answer}</p>
        </div>
        {showNoContext ? (
          <p className="text-xs text-muted-foreground/80">
            We couldn't find anything in your memories matching this question.
          </p>
        ) : null}
      </div>
    );
  }, [askState]);


  // Refresh model statuses if they're still in fallback state
  useEffect(() => {
    const shouldRefreshStatuses = modelStatuses && Object.values(modelStatuses).some(
      status => status.message === "Awaiting status" || status.message === "Not initialized"
    );

    if (shouldRefreshStatuses && !hasLoadedModelStatuses) {
      console.log("[NanoScribe] Model statuses still in fallback state, requesting refresh");

      sendToBackground({ type: "GET_MODEL_STATUS" })
        .then((response) => {
          if (response.type === "MODEL_STATUS") {
            setModelStatuses(response.payload);
            setHasLoadedModelStatuses(true);
            console.log("[NanoScribe] Model statuses refreshed:", response.payload);
          } else if (response.type === "ERROR") {
            setHasLoadedModelStatuses(true);
            console.warn("[NanoScribe] Failed to refresh model status", response.message);
          }
        })
        .catch((error) => {
          setHasLoadedModelStatuses(true);
          console.error("[NanoScribe] Failed to refresh model status", error);
        });
    }
  }, [modelStatuses, hasLoadedModelStatuses]);

  // Also refresh when switching to settings tab if statuses are stale
  useEffect(() => {
    if (activeTab === "settings" && modelStatuses) {
      const isStale = Object.values(modelStatuses).some(
        status => status.message === "Awaiting status" || status.message === "Not initialized"
      );

      if (isStale) {
        console.log("[NanoScribe] Settings tab opened with stale model statuses, refreshing");

        sendToBackground({ type: "GET_MODEL_STATUS" })
          .then((response) => {
            if (response.type === "MODEL_STATUS") {
              setModelStatuses(response.payload);
              console.log("[NanoScribe] Model statuses refreshed from settings tab:", response.payload);
            }
          })
          .catch((error) => {
            console.error("[NanoScribe] Failed to refresh model status from settings tab", error);
          });
      }
    }
  }, [activeTab, modelStatuses]);

  // Save context toggle state when changed
  const handleContextToggleChange = useCallback((isChecked: boolean) => {
    setIsContextAware(isChecked);
    chrome.storage.local.set({ isContextAware: isChecked }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        console.error("[NanoScribe] Failed to save context-aware setting:", runtimeError);
        return;
      }
      console.log(`[NanoScribe] Context-aware mode ${isChecked ? 'enabled' : 'disabled'} (autocomplete will ${isChecked ? 'use' : 'ignore'} recent browsing context)`);
    });
  }, []);

  const handleAIOrganize = useCallback(async () => {
    if (isAIOrganizing) return;
    setIsAIOrganizing(true);
    setAiOrganizeStatus("Starting AI organization…");
    try {
      const response = await sendToBackground({ type: "AI_ORGANIZE_UNORGANIZED_MEMORIES" });
      if (response.type === "AI_ORGANIZE_RESULT") {
        setAiOrganizeStatus("Refreshing organized memories…");
        const refreshResponse = await sendToBackground({ type: "GET_MEMORIES_GROUPED" });
        if (refreshResponse.type === "MEMORIES_GROUPED") {
          setSessionGroups(refreshResponse.payload);
          setAiOrganizeStatus("AI organization complete");
        }
      } else if (response.type === "ERROR") {
        throw new Error(response.message);
      }
    } catch (error) {
      console.error("AI organization failed:", error);
      setAiOrganizeStatus("AI organization failed");
    } finally {
      setTimeout(() => setAiOrganizeStatus(null), 4000);
      setIsAIOrganizing(false);
    }
  }, [isAIOrganizing]);

  const handleRenameSession = useCallback(
    (sessionId: string, draft: string) => {
      const trimmed = draft.trim();
      const nextTitles: SessionTitleCache = { ...sessionTitleMap };

      if (trimmed.length > 0) {
        nextTitles[sessionId] = trimmed;
      } else {
        delete nextTitles[sessionId];
      }

      setRenameState((prev) =>
        prev && prev.sessionId === sessionId ? { ...prev, isSaving: true } : prev
      );
      setSessionTitleMap(nextTitles);

      chrome.storage.local.set({ sessionTitles: nextTitles }, () => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          console.error("[NanoScribe] Failed to persist session title:", runtimeError);
        }
        setRenameState((prev) => (prev && prev.sessionId === sessionId ? null : prev));
      });
    },
    [sessionTitleMap]
  );

  useEffect(() => {
    sendToBackground({ type: "SIDEPANEL_READY" }).catch((error) => {
      console.error("[NanoScribe] Failed to acknowledge side panel", error);
    });

    setFetchState("loading");

    sendToBackground({ type: "GET_MEMORIES_GROUPED" })
      .then((response) => {
        if (response.type === "MEMORIES_GROUPED") {
          setSessionGroups(response.payload);
          setFetchState("idle");
          setErrorMessage(null);
        } else if (response.type === "ERROR") {
          setFetchState("error");
          setErrorMessage(response.message);
        }
      })
      .catch((error) => {
        console.error("[NanoScribe] Failed to fetch grouped memories", error);
        setFetchState("error");
        setErrorMessage("Unable to load memories.");
      });

    sendToBackground({ type: "GET_MODEL_STATUS" })
      .then((response) => {
        if (response.type === "MODEL_STATUS") {
          setModelStatuses(response.payload);
          setHasLoadedModelStatuses(true);
        } else if (response.type === "ERROR") {
          setHasLoadedModelStatuses(true);
          console.warn("[NanoScribe] Failed to fetch model status", response.message);
        }
      })
      .catch((error) => {
        setHasLoadedModelStatuses(true);
        console.error("[NanoScribe] Failed to load model status", error);
      });

    sendToBackground({ type: "GET_AUTOCOMPLETE_STATE" })
      .then((response) => {
        if (response.type === "AUTOCOMPLETE_STATE") {
          setAutocompleteState(response.payload);
        }
      })
      .catch((error) => {
        console.error("[NanoScribe] Failed to load autocomplete state", error);
      });

    sendToBackground({ type: "GET_DIAGNOSTICS" })
      .then((response) => {
        if (response.type === "DIAGNOSTICS") {
          setDiagnosticsSnapshot(response.payload);
          setDiagnosticsSettings(response.payload.settings);
        }
      })
      .catch((error) => {
        console.error("[NanoScribe] Failed to load diagnostics snapshot", error);
      });
  }, []);

  const handleDiagnosticsToggleChange = useCallback(
    (key: keyof DiagnosticsSettings) => (isChecked: boolean) => {
      const previous = diagnosticsSettings;
      const next = { ...diagnosticsSettings, [key]: isChecked };
      setDiagnosticsSettings(next);
      sendToBackground({ type: "UPDATE_DIAGNOSTICS_SETTINGS", payload: next })
        .then((response) => {
          if (response.type !== "ACK") {
            throw new Error(`Unexpected response: ${response.type}`);
          }
        })
        .catch((error) => {
          console.error("[NanoScribe] Failed to update diagnostics settings", error);
          setDiagnosticsSettings(previous);
        });
    },
    [diagnosticsSettings],
  );

  useEffect(() => {
    if (searchMode !== "memories") {
      return;
    }

    const controller = window.setTimeout(() => {
      const query = filter.trim();

      if (!query) {
        setSearchResults(null);
        setIsSearching(false);
        setSessionGroups((current) => {
          if (current.length === 0) {
            sendToBackground({ type: "GET_MEMORIES_GROUPED" })
              .then((response) => {
                if (response.type === "MEMORIES_GROUPED") {
                  setSessionGroups(response.payload);
                }
              })
              .catch((error) => {
                console.error("[NanoScribe] Failed to re-fetch memories", error);
              });
          }
          return current;
        });
        return;
      }

      setSearchResults(null);
      setIsSearching(true);
      sendToBackground({ type: "SEARCH_MEMORIES", query })
        .then((response) => {
          if (response.type === "SEARCH_RESULTS") {
            setSearchResults(response.payload);
          } else if (response.type === "MEMORIES") {
            const memoriesOnly: MemoryRecord[] = response.payload;
            setSearchResults(
              memoriesOnly.map((memory) => ({
                memory,
                chunk: {
                  id: `memory-${memory.id}`,
                  memoryId: memory.id,
                  sessionId: "memory-fallback",
                  chunkTitle: memory.title,
                  rawText: memory.summary,
                  keyPoints: memory.summary,
                  keywords: [],
                  ordinal: 0,
                  createdAt: memory.createdAt,
                  sourceTag: "memory",
                },
              })),
            );
          } else if (response.type === "ERROR") {
            setErrorMessage(response.message);
            setSearchResults([]);
          }
        })
        .catch((error) => {
          console.error("[NanoScribe] Search failed", error);
          setErrorMessage("Search failed. Try again.");
          setSearchResults([]);
        })
        .finally(() => {
          setIsSearching(false);
        });
    }, 250);

    return () => {
      window.clearTimeout(controller);
    };
  }, [filter, searchMode]);

  useEffect(() => {
    const listener = (message: BackgroundEvent) => {
      if (!isBackgroundEvent(message)) return;

      switch (message.type) {
        case "MEMORY_SAVED": {
          sendToBackground({ type: "GET_MEMORIES_GROUPED" })
            .then((response) => {
              if (response.type === "MEMORIES_GROUPED") {
                setSessionGroups(response.payload);
              }
            })
            .catch((error) => {
              console.error("[NanoScribe] Failed to refresh session groups after memory save", error);
            });
          return;
        }
        case "MEMORY_DELETED": {
          const { memoryId } = message.payload;
          setSessionGroups((current) =>
            current
              .map((group) => ({
                ...group,
                memories: group.memories.filter((m) => m.id !== memoryId),
                memoryCount: group.memories.filter((m) => m.id !== memoryId).length,
              }))
              .filter((group) => group.memoryCount > 0),
          );
          return;
        }
        case "MODEL_STATUS_CHANGED": {
          setModelStatuses(message.payload);
          setHasLoadedModelStatuses(true);
          return;
        }
        case "AUTOCOMPLETE_STATE_UPDATED": {
          setAutocompleteState(message.payload);
          setCommandError(null);

          if (message.payload.status === "suggestion" && message.payload.suggestion) {
            setActiveTab("autocomplete");
          }
          return;
        }
        case "PROOFREADER_STATE_UPDATED": {
          const stateKey = `${message.payload.text}-${message.payload.isVisible}-${message.payload.isLoading}-${message.payload.corrections?.length || 0}-${message.payload.sessionId || "no-session"}-${Date.now()}`;
          if (lastStateUpdate && lastStateUpdate === stateKey) {
            return;
          }

          const nextStatus: ProofreaderState["status"] = message.payload.error
            ? "error"
            : message.payload.isLoading
              ? "running"
              : message.payload.isVisible
                ? "ready"
                : "idle";

          const isCleanup = !message.payload.isVisible && !message.payload.corrections?.length && !message.payload.error;

          setProofreaderStateLocal((prev) => {
            const base = prev ?? {
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

            if (isCleanup) {
              return {
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
            }

            return {
              status: nextStatus,
              sessionId: message.payload.sessionId ?? base.sessionId,
              selectedText: message.payload.text ?? base.selectedText,
              correctedText: message.payload.correctedText ?? base.correctedText,
              corrections: message.payload.corrections ?? base.corrections,
              error: message.payload.error ?? base.error,
              isVisible: message.payload.isVisible ?? base.isVisible,
              isLoading: message.payload.isLoading ?? base.isLoading,
              updatedAt: Date.now(),
            };
          });

          if (!isCleanup && message.payload.isVisible) {
            setActiveTab("proofreader");
          }

          setLastStateUpdate(stateKey);
          return;
        }
        case "INITIAL_SETTINGS":
        case "CONTEXT_AWARENESS_UPDATED": {
          const enabled = message.payload?.isContextAware ?? true;
          setIsContextAware(enabled);
          return;
        }
        case "DIAGNOSTICS_UPDATED": {
          setDiagnosticsSnapshot(message.payload);
          setDiagnosticsSettings(message.payload.settings);
          return;
        }
        case "MEMORIES_GROUPED": {
          setSessionGroups(message.payload);
          if (Array.isArray(message.payload)) {
            const entries: SessionTitleCache = {};
            message.payload.forEach((group) => {
              if (group.sessionId && group.title) {
                entries[group.sessionId] = group.title;
              }
            });
            if (Object.keys(entries).length > 0) {
              setSessionTitleMap((prev) => ({ ...prev, ...entries }));
            }
          }
          return;
        }
        default:
          return;
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [lastStateUpdate]);

  const renderSearchResults = () => {
    if (searchResults === null) {
      return null;
    }

    if (isSearching) {
      return (
        <div className="mt-4 space-y-3">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      );
    }

    if (searchResults.length === 0) {
      return (
        <div className="mt-4 rounded-md border border-dashed border-border/60 p-4 text-sm text-muted-foreground">
          No results match "{filter}". Try a different query.
        </div>
      );
    }

    return (
      <div className="mt-4 space-y-3">
        {searchResults.map((result) => {
          const title = deriveTitle(result);
          const snippet = buildSnippet(result.chunk);
          const { href, domain, path } = deriveUrlParts(result);
          const showSource = shouldShowSourceTag(result.chunk.sourceTag);

          return (
            <Card key={`search-${result.chunk.id}`} className="border-border/80 bg-card/95 shadow-sm transition hover:border-primary/40">
              <CardHeader className="space-y-2 pb-3">
                <div className="flex flex-col gap-1">
                  <div className="flex items-start justify-between gap-3">
                    <CardTitle className="text-base font-semibold leading-6 text-card-foreground">
                      {highlightText(title, filter)}
                    </CardTitle>
                    {result.memory?.createdAt ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        {formatRelativeTime(result.memory.createdAt)}
                      </span>
                    ) : null}
                  </div>
                  {href && domain ? (
                    <a
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="font-medium">{domain}</span>
                      {path ? <span className="truncate text-muted-foreground">{path}</span> : null}
                      <ExternalLink className="h-3 w-3 opacity-80" />
                    </a>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {snippet ? (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {highlightText(snippet, filter)}
                  </p>
                ) : null}
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span>
                    Chunk #{result.chunk.ordinal + 1}
                  </span>
                  <span aria-hidden="true">•</span>
                  <span>{result.chunk.keywords.length} keyword{result.chunk.keywords.length === 1 ? "" : "s"}</span>
                  {showSource ? (
                    <>
                      <span aria-hidden="true">•</span>
                      <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                        {result.chunk.sourceTag}
                      </Badge>
                    </>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    );
  };

  const statusLabel = useMemo(() => {
    if (fetchState === "loading") {
      return "Loading memories...";
    }
    if (fetchState === "error") {
      return errorMessage ?? "Something went wrong.";
    }
    if (sessionGroups.length === 0) {
      return filter.trim() ? "No memories match your search." : "Browse the web to start building memories.";
    }
    return null;
  }, [fetchState, errorMessage, sessionGroups.length, filter]);

  const sortedModelStatuses = useMemo(() => {
    if (!modelStatuses) return [];
    return (Object.keys(MODEL_METADATA) as ModelIdentifier[])
      .map((id) => modelStatuses[id])
      .sort((a, b) => MODEL_STATUS_PRIORITY[a.state] - MODEL_STATUS_PRIORITY[b.state]);
  }, [modelStatuses]);

  const autocompleteStatusLabel = useMemo(() => {
    if (!autocompleteState) return "Waiting for an editable field";
    if (autocompleteState.status === "error" && autocompleteState.error) {
      return autocompleteState.error;
    }
    return AUTOCOMPLETE_STATUS_COPY[autocompleteState.status];
  }, [autocompleteState]);

  const diagnosticsSummary = useMemo(() => {
    if (!diagnosticsSnapshot?.metrics) {
      return {
        totalRequests: 0,
        successRate: null as number | null,
        failureRate: null as number | null,
        succeeded: 0,
        failed: 0,
        timeouts: 0,
      };
    }

    const metrics = diagnosticsSnapshot.metrics;
    const totalRequests = metrics.completionRequested;
    const successRate = totalRequests > 0 ? Math.round((metrics.completionSucceeded / totalRequests) * 100) : null;
    const failureRate = totalRequests > 0 ? Math.round((metrics.completionFailed / totalRequests) * 100) : null;

    return {
      totalRequests,
      successRate,
      failureRate,
      succeeded: metrics.completionSucceeded,
      failed: metrics.completionFailed,
      timeouts: metrics.completionTimeouts,
    };
  }, [diagnosticsSnapshot]);

  const suggestionText = autocompleteState?.suggestion?.completionText ?? "";
  const hasSuggestion = Boolean(suggestionText);

  const handleAutocompleteCommand = useCallback(
    (command: AutocompleteCommand) => {
      sendToBackground({ type: "AUTOCOMPLETE_COMMAND", command })
        .then((response) => {
          if (response.type === "ERROR") {
            setCommandError(response.message);
          } else {
            setCommandError(null);
          }
        })
        .catch((error) => {
          console.error("[NanoScribe] Autocomplete command failed", error);
          setCommandError(error instanceof Error ? error.message : String(error));
        });
    },
    [],
  );

  const handleCopySuggestion = useCallback(() => {
    if (!suggestionText) return;
    if (!navigator.clipboard) {
      setCommandError("Clipboard access unavailable");
      return;
    }
    navigator.clipboard
      .writeText(suggestionText)
      .then(() => setCommandError(null))
      .catch((error) => {
        console.error("[NanoScribe] Failed to copy suggestion", error);
        setCommandError(error instanceof Error ? error.message : "Copy failed");
      });
  }, [suggestionText]);

  // Delete memory handler
  const handleMemoryDelete = useCallback(async (memoryId: string) => {
    setDeleteState({ memoryId, isDeleting: true });

    try {
      const response = await sendToBackground({
        type: "DELETE_MEMORY",
        memoryId
      });

      if (response.type === "ACK") {
        // Remove from local state immediately for better UX
        setSessionGroups((current) =>
          current
            .map((group) => ({
              ...group,
              memories: group.memories.filter(m => m.id !== memoryId),
              memoryCount: group.memories.filter(m => m.id !== memoryId).length,
            }))
            .filter((group) => group.memoryCount > 0) // Remove empty groups
        );
      } else if (response.type === "ERROR") {
        throw new Error(response.message);
      } else {
        throw new Error("Unexpected response type");
      }
    } catch (error) {
      console.error("Failed to delete memory:", error);
      // Could show a toast notification here
    } finally {
      setDeleteState({ memoryId: null, isDeleting: false });
    }
  }, []);

  // Refresh memories handler
  const handleRefreshMemories = useCallback(async () => {
    setFetchState("loading");

    try {
      const response = await sendToBackground({ type: "GET_MEMORIES_GROUPED" });
      if (response.type === "MEMORIES_GROUPED") {
        setSessionGroups(response.payload);
        setFetchState("idle");
      } else if (response.type === "ERROR") {
        throw new Error(response.message);
      } else {
        throw new Error("Unexpected response type");
      }
    } catch (error) {
      setFetchState("error");
      setErrorMessage("Failed to refresh memories");
    }
  }, []);

  useEffect(() => {
    if (commandError && (!autocompleteState || autocompleteState.status !== "error")) {
      const timer = window.setTimeout(() => setCommandError(null), 4000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [commandError, autocompleteState]);

  useEffect(() => {
    const listener = (message: BackgroundEvent) => {
      if (isBackgroundEvent(message) && message.type === "AI_ORGANIZE_PROGRESS") {
        const { stage, organized, failed, total } = message.payload;
        if (stage === "start") {
          setAiOrganizeStatus("Analyzing memories with AI…");
          setIsAIOrganizing(true);
        } else if (stage === "complete") {
          setAiOrganizeStatus(`AI organized ${organized} memories (${failed} failed)`);
          setIsAIOrganizing(false);
          setTimeout(() => setAiOrganizeStatus(null), 5000);
        } else if (stage === "error") {
          setAiOrganizeStatus("AI organization failed");
          setIsAIOrganizing(false);
          setTimeout(() => setAiOrganizeStatus(null), 5000);
        } else if (total > 0) {
          setAiOrganizeStatus(`Organized ${organized}/${total} memories…`);
        }
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, []);

  const formatSessionName = useCallback((sessionId: string, lastActivity: number): string => {
    if (sessionId === "no-session") return "Unorganized";
    if (sessionId === "search-results") return "Search Results";

    if (sessionId.startsWith("ai-")) {
      const parts = sessionId.split("-");
      if (parts.length > 2) {
        const [, ...nameParts] = parts;
        const cleaned = nameParts
          .filter((part) => !/^\d+$/.test(part))
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" ");
        if (cleaned.length > 0) {
          return cleaned.slice(0, 60);
        }
      }
    }

    if (sessionId.startsWith("auto-session-")) {
      return `Session ${formatRelativeTime(lastActivity)}`;
    }

    const readable = sessionId
      .replace(/ai-group-/, "")
      .replace(/auto-session-/, "")
      .replace(/-[0-9a-z]{6,}$/i, "")
      .replace(/-/g, " ")
      .trim();

    if (readable.length > 0) {
      return readable
        .split(" ")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
        .slice(0, 60);
    }

    return `Session ${formatRelativeTime(lastActivity)}`;
  }, []);

  return (
    <Fragment>
      <div className="sidepanel-ambient" aria-hidden="true" />
      <div className="sidepanel-noise" aria-hidden="true" />

      <div className="glass-panel aurora-bg flex h-full flex-col gap-4 overflow-hidden border border-white/10 p-4 shadow-2xl mb-10">
        <header className="glass-card relative overflow-hidden rounded-2xl border border-white/10 px-4 py-4 shadow-lg">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[radial-gradient(circle_at_20%_10%,hsl(var(--primary)/0.35),transparent_55%),radial-gradient(circle_at_80%_0%,hsl(var(--accent-glow)/0.25),transparent_60%)] opacity-70"
          />
          <div className="relative flex items-center gap-5 ">
            <div className="logo-frame h-16 w-16">
              <img
                src={logoImage}
                alt="NanoScribe logo"
                className="logo-mark"
                loading="lazy"
              />
            </div>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">NanoScribe</h1>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-widest text-foreground/80">
                  AI Sidepanel
                </span>
                <span>Private assistant for writing & browsing</span>
              </div>
            </div>
          </div>
        </header>

        <div className="frosted-divider opacity-60" aria-hidden="true" />

        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
          <TabsList className="glass-card grid h-auto w-full grid-cols-4 gap-2 rounded-2xl bg-black/25 p-1">
            <TabsTrigger
              value="autocomplete"
              className="group relative flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-transparent px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-all duration-300 hover:border-white/20 hover:text-foreground data-[state=active]:bg-white/15 data-[state=active]:text-foreground data-[state=active]:shadow-[0_0_18px_rgba(255,255,255,0.12)]"
            >
              <Sparkles className="h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
              <span>Autocomplete</span>
            </TabsTrigger>
            <TabsTrigger
              value="memories"
              className="group relative flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-transparent px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-all duration-300 hover:border-white/20 hover:text-foreground data-[state=active]:bg-white/15 data-[state=active]:text-foreground data-[state=active]:shadow-[0_0_18px_rgba(255,255,255,0.12)]"
            >
              <BookOpen className="h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
              <span>Memories</span>
            </TabsTrigger>
            <TabsTrigger
              value="proofreader"
              className="group relative flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-transparent px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-all duration-300 hover:border-white/20 hover:text-foreground data-[state=active]:bg-white/15 data-[state=active]:text-foreground data-[state=active]:shadow-[0_0_18px_rgba(255,255,255,0.12)]"
            >
              <PenLine className="h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
              <span>Proofreader</span>
            </TabsTrigger>
            <TabsTrigger
              value="settings"
              className="group relative flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/10 bg-transparent px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-all duration-300 hover:border-white/20 hover:text-foreground data-[state=active]:bg-white/15 data-[state=active]:text-foreground data-[state=active]:shadow-[0_0_18px_rgba(255,255,255,0.12)]"
            >
              <Settings className="h-4 w-4 transition-transform duration-300 group-hover:scale-110" />
              <span>Settings</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="memories" className="mt-4 flex-1 flex flex-col gap-4">
            <div className="glass-card flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-black/25 px-3 py-2 shadow-md">
              <div className="relative flex min-w-[220px] flex-1 items-center">
                <Search className="absolute left-3 h-4 w-4 text-muted-foreground/70" />
                <Input
                  value={searchMode === "ask" ? askInput : filter}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (searchMode === "ask") {
                      setAskInput(value);
                      if (askState.status !== "idle") {
                        setAskState(INITIAL_ASK_STATE);
                      }
                    } else {
                      setFilter(value);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (searchMode === "ask" && event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handleAskSubmit();
                    }
                  }}
                  placeholder={searchMode === "ask" ? "Ask NanoScribe anything..." : "Search memories..."}
                  className="glass-card h-10 w-full rounded-xl border border-white/5 bg-black/40 pl-10 text-sm text-foreground/90 placeholder:text-muted-foreground/60 focus:bg-black/30"
                />
              </div>
              <div className="flex items-center gap-2">
                <TooltipProvider delayDuration={200}>
                  <div className="glass-card inline-flex gap-1 rounded-2xl border border-white/12 bg-black/35 p-1 shadow-inner">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => setSearchMode("memories")}
                          aria-pressed={searchMode === "memories"}
                          aria-label="Keyword search"
                          className={`h-9 w-9 rounded-xl border border-transparent text-muted-foreground transition  ${
                            searchMode === "memories"
                              ? "bg-white/20 text-foreground shadow-[0_0_10px_rgba(255,255,255,0.18)]"
                              : "hover:bg-white/10"
                          }`}
                        >
                          <BookOpen className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6} className="text-xs">
                        Memories search
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => setSearchMode("ask")}
                          aria-pressed={searchMode === "ask"}
                          aria-label="Ask NanoScribe"
                          className={`h-9 w-9 rounded-xl border border-transparent text-muted-foreground transition focus-visible:ring-2 focus-visible:ring-white/30 ${
                            searchMode === "ask"
                              ? "bg-white/20 text-foreground shadow-[0_0_10px_rgba(255,255,255,0.18)]"
                              : "hover:bg-white/10"
                          }`}
                        >
                          <MessageCircle className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6} className="text-xs">
                        Ask NanoScribe
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TooltipProvider>
                {searchMode === "ask" ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleAskSubmit}
                    disabled={askState.status === "loading"}
                    className="glow-ring inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/15 px-3 text-xs font-semibold uppercase tracking-wide text-foreground/90 hover:bg-white/20 disabled:opacity-60"
                  >
                    {askState.status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    <span>{askState.status === "loading" ? "Thinking" : "Ask"}</span>
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRefreshMemories}
                  disabled={fetchState === "loading" || searchMode === "ask"}
                  className="glow-ring shrink-0 rounded-xl border-white/15 bg-black/30 text-xs text-foreground/80 disabled:opacity-60"
                >
                  <RefreshCw className={`h-4 w-4 ${fetchState === "loading" ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>

            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-4 pb-4">
                {searchMode === "ask" ? (
                  <div className="space-y-4">
                    {renderAskResult()}
                    {askState.status !== "idle" && askState.status !== "loading" && askState.context.length > 0 ? (
                      <div className="glass-card space-y-3 rounded-2xl border border-white/10 bg-black/25 p-5 text-xs text-muted-foreground">
                        <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Relevant memories</p>
                        {askState.context.map((item) => (
                          <div key={`ask-context-${item.chunkId}`} className="glass-card space-y-2 rounded-xl border border-white/10 bg-black/30 p-3">
                            {item.title ? <p className="text-xs font-semibold text-foreground/90">{item.title}</p> : null}
                            <p className="text-xs leading-relaxed whitespace-pre-line text-muted-foreground/90">{item.keyPoints}</p>
                            {item.url ? (
                              <a
                                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Open memory
                                <ExternalLink className="h-3 w-3" />
                              </a>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : isSearching ? (
                  <div className="glass-card flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/12 bg-black/25 p-6 text-sm text-muted-foreground shadow-lg">
                    <span className="fancy-spinner" aria-hidden="true" />
                    <span>Searching memories…</span>
                  </div>
                ) : searchResults !== null ? (
                  renderSearchResults()
                ) : fetchState === "loading" ? (
                  <div className="glass-card flex flex-col items-center justify-center gap-3 rounded-2xl border border-white/12 bg-black/25 p-6 text-sm text-muted-foreground shadow-lg">
                    <span className="fancy-spinner" aria-hidden="true" />
                    <span>Loading memories…</span>
                  </div>
                ) : (
                  sessionGroups.map((sessionGroup) => {
                    const accent = getSessionAccent(sessionGroup.sessionId);
                    const info = deriveSessionInfo(sessionGroup, sessionTitleMap);
                    const isUnorganized = sessionGroup.sessionId === "no-session";

                    return (
                      <div key={sessionGroup.sessionId} className="space-y-3">
                        <div className="glass-card flex items-start gap-3 rounded-2xl border border-white/12 bg-black/30 px-4 py-3 shadow-md">
                          <span
                            className="mt-1 flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/10 text-white shadow-[inset_0_0_12px_rgba(255,255,255,0.08)] backdrop-blur-sm"
                            style={{
                              background: `linear-gradient(145deg, rgba(255,255,255,0.15), rgba(0,0,0,0.35))`,
                              boxShadow: `0 0 0 1px ${accent.borderColor} inset, 0 8px 20px -12px ${accent.backgroundColor}`,
                            }}
                            aria-hidden="true"
                          >
                            <span
                              className="absolute inset-0 rounded-xl opacity-40"
                              style={{ backgroundColor: accent.backgroundColor }}
                            />
                            <BookOpen className="relative h-4 w-4" />
                          </span>
                          <div className="flex flex-1 flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-2 text-foreground/90">
                              {renameState?.sessionId === sessionGroup.sessionId ? (
                                <form
                                  className="flex flex-wrap items-center gap-2"
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    if (renameState) {
                                      handleRenameSession(sessionGroup.sessionId, renameState.draft);
                                    }
                                  }}
                                >
                                  <Input
                                    autoFocus
                                    value={renameState.draft}
                                    onChange={(event) =>
                                      setRenameState((prev) =>
                                        prev && prev.sessionId === sessionGroup.sessionId
                                          ? { ...prev, draft: event.target.value }
                                          : prev
                                      )
                                    }
                                    placeholder="Session title"
                                    className="h-8 w-52 rounded-lg border-white/20 bg-black/40 text-sm text-foreground focus-visible:ring-1 focus-visible:ring-white/50"
                                    disabled={renameState.isSaving}
                                  />
                                  <div className="flex items-center gap-1">
                                    <Button
                                      type="submit"
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 rounded-lg border border-white/15 bg-white/10 px-2 text-xs text-foreground/85 hover:bg-white/20"
                                      disabled={renameState.isSaving}
                                    >
                                      {renameState.isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
                                    </Button>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-8 w-8 rounded-lg border border-transparent p-0 text-muted-foreground hover:border-white/15 hover:bg-white/10"
                                      onClick={() => setRenameState(null)}
                                      disabled={renameState.isSaving}
                                    >
                                      <X className="h-3.5 w-3.5" />
                                    </Button>
                                  </div>
                                </form>
                              ) : (
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-semibold text-card-foreground">{info.title}</span>
                                  {sessionGroup.sessionId !== "no-session" && sessionGroup.sessionId !== "search-results" ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 w-7 rounded-lg border border-transparent p-0 text-muted-foreground hover:border-white/15 hover:text-foreground"
                                      onClick={() =>
                                        setRenameState({
                                          sessionId: sessionGroup.sessionId,
                                          draft:
                                            sessionTitleMap[sessionGroup.sessionId] ?? info.title,
                                          isSaving: false,
                                        })
                                      }
                                      aria-label="Rename session"
                                    >
                                      <PenLine className="h-3.5 w-3.5" />
                                    </Button>
                                  ) : null}
                                  <Badge variant="secondary" className="glass-card border-white/12 bg-black/45 text-xs font-medium text-foreground/85 backdrop-blur">
                                    {sessionGroup.memoryCount} {sessionGroup.memoryCount === 1 ? "memory" : "memories"}
                                  </Badge>
                                  <span className="text-xs text-muted-foreground">• {formatRelativeTime(sessionGroup.lastActivity)}</span>
                                </div>
                              )}
                            </div>
                            {info.subtitle ? (
                              <span className="text-xs text-muted-foreground/85">{info.subtitle}</span>
                            ) : null}
                          </div>
                          {isUnorganized && sessionGroup.memoryCount > 0 ? (
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={handleAIOrganize}
                                disabled={isAIOrganizing}
                                className="glow-ring h-8 rounded-xl border-white/15 bg-black/35 px-3 text-xs text-foreground/85"
                              >
                                {isAIOrganizing ? (
                                  <>
                                    <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                    Organizing
                                  </>
                                ) : (
                                  <>
                                    <Sparkles className="mr-1 h-3 w-3" />
                                    AI Organize
                                  </>
                                )}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="glow-ring h-8 rounded-xl border-white/15 bg-black/35 px-3 text-xs text-foreground/85"
                                onClick={async () => {
                                  try {
                                    const response = await sendToBackground({ type: "REPROCESS_UNORGANIZED_MEMORIES" });
                                    if (response.type === "REPROCESS_RESULT") {
                                      const refreshResponse = await sendToBackground({ type: "GET_MEMORIES_GROUPED" });
                                      if (refreshResponse.type === "MEMORIES_GROUPED") {
                                        setSessionGroups(refreshResponse.payload);
                                      }
                                    }
                                  } catch (error) {
                                    console.error("Reprocessing failed:", error);
                                  }
                                }}
                              >
                                <RotateCcw className="mr-1 h-3 w-3" />
                                Reprocess
                              </Button>
                              <Button
                                size="sm"
                                variant="destructive"
                                className="h-8 rounded-xl bg-red-500/25 px-3 text-xs text-red-100 hover:bg-red-500/35"
                                onClick={async () => {
                                  if (window.confirm(`Delete all ${sessionGroup.memoryCount} unorganized memories?`)) {
                                    try {
                                      const response = await sendToBackground({ type: "CLEANUP_UNORGANIZED_MEMORIES" });
                                      if (response.type === "CLEANUP_RESULT") {
                                        const refreshResponse = await sendToBackground({ type: "GET_MEMORIES_GROUPED" });
                                        if (refreshResponse.type === "MEMORIES_GROUPED") {
                                          setSessionGroups(refreshResponse.payload);
                                        }
                                      }
                                    } catch (error) {
                                      console.error("Cleanup failed:", error);
                                    }
                                  }
                                }}
                              >
                                Delete
                              </Button>
                            </div>
                          ) : null}
                        </div>

                        <div className="space-y-3 pl-6 pr-2">
                          {sessionGroup.memories.map((memory) => {
                            const isExpanded = expandedMemories.has(memory.id);
                            const isDeleting = deleteState.memoryId === memory.id && deleteState.isDeleting;

                            return (
                              <Card key={memory.id} className="glass-card rounded-2xl border border-white/12 bg-black/25 shadow-lg">
                                <CardHeader className="pb-3">
                                  <div className="flex items-start gap-3">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="mt-0.5 h-7 w-7 shrink-0 rounded-lg border border-transparent text-muted-foreground hover:border-white/10 hover:text-primary"
                                      onClick={() => {
                                        setExpandedMemories((prev) => {
                                          const newSet = new Set(prev);
                                          if (newSet.has(memory.id)) {
                                            newSet.delete(memory.id);
                                          } else {
                                            newSet.add(memory.id);
                                          }
                                          return newSet;
                                        });
                                      }}
                                    >
                                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                    </Button>
                                    <div className="min-w-0 flex-1 space-y-1">
                                      <div className="flex items-center gap-2">
                                        <CardTitle className="text-sm font-semibold text-card-foreground line-clamp-2">
                                          {memory.title}
                                        </CardTitle>
                                        <span className="text-xs text-muted-foreground">{formatRelativeTime(memory.createdAt)}</span>
                                      </div>
                                      <span className="block truncate text-xs text-muted-foreground">{shortenUrl(memory.url)}</span>
                                    </div>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 rounded-lg border border-transparent p-0 text-red-300 hover:border-red-400/40 hover:bg-red-500/10"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        if (window.confirm(`Delete memory: "${memory.title}"?`)) {
                                          handleMemoryDelete(memory.id);
                                        }
                                      }}
                                      disabled={isDeleting}
                                    >
                                      {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                    </Button>
                                  </div>
                                </CardHeader>
                                {isExpanded ? (
                                  <CardContent className="pb-4 pt-0">
                                    <div className="glass-card space-y-3 rounded-xl border border-white/12 bg-black/30 p-4 text-sm shadow-inner">
                                      {memory.summary ? (
                                        <p className="whitespace-pre-line leading-relaxed text-muted-foreground">
                                          {memory.summary}
                                        </p>
                                      ) : (
                                        <p className="text-sm italic text-muted-foreground">No summary captured for this page.</p>
                                      )}
                                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                                        <span>Stored {formatRelativeTime(memory.updatedAt)}</span>
                                        <a
                                          href={memory.url}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                                        >
                                          Open page
                                          <ExternalLink className="h-3 w-3" />
                                        </a>
                                      </div>
                                    </div>
                                  </CardContent>
                                ) : null}
                              </Card>
                            );
                          })}
                        </div>
                        <div className="frosted-divider opacity-30" />
                      </div>
                    );
                  })
                )}
                {searchResults === null && statusLabel ? (
                  <p className="text-center text-xs text-muted-foreground">{statusLabel}</p>
                ) : null}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="autocomplete" className="mt-4 flex-1">
            <div className="h-full overflow-y-auto">
              <AutocompleteContent state={autocompleteState} onCommand={handleAutocompleteCommand} />
            </div>
          </TabsContent>

          <TabsContent value="proofreader" className="mt-4 flex-1">
            <div className="h-full overflow-y-auto">
              <ProofreaderContent state={proofreaderStateLocal} onStateChange={setProofreaderStateLocal} />
            </div>
          </TabsContent>

          <TabsContent value="settings" className="mt-4 flex-1">
            <ScrollArea className="h-full">
              <div className="space-y-6">
                <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="glow-ring flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                        <Sparkles className="h-4 w-4" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-card-foreground">Context-Aware Writing</p>
                        <p className="text-xs text-muted-foreground">
                          Use recent browsing context to enhance autocomplete suggestions
                        </p>
                      </div>
                    </div>
                    <Switch
                      id="context-toggle"
                      checked={isContextAware}
                      onCheckedChange={handleContextToggleChange}
                    />
                  </div>
                </div>

                <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="glow-ring flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                        <BarChart3 className="h-4 w-4" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-card-foreground">Diagnostics & Logging</p>
                        <p className="text-xs text-muted-foreground">
                          Monitor model performance and collect debugging data
                        </p>
                      </div>
                    </div>
                    {diagnosticsSettings.trackMetrics && !diagnosticsSnapshot ? (
                      <span className="fancy-spinner sm" aria-label="Loading diagnostics" />
                    ) : null}
                  </div>

                  <div className="mt-4 space-y-3">
                    <div className="glass-card flex items-center justify-between rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="space-y-1">
                        <Label htmlFor="diagnostics-verbose" className="text-sm font-medium text-card-foreground">
                          Verbose console logging
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Emit detailed service worker traces for debugging
                        </p>
                      </div>
                      <Switch
                        id="diagnostics-verbose"
                        checked={diagnosticsSettings.verboseLogging}
                        onCheckedChange={handleDiagnosticsToggleChange("verboseLogging")}
                      />
                    </div>

                    <div className="glass-card flex items-center justify-between rounded-xl border border-white/10 bg-black/10 p-3">
                      <div className="space-y-1">
                        <Label htmlFor="diagnostics-metrics" className="text-sm font-medium text-card-foreground">
                          Track autocomplete metrics
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          Capture request, success, and timeout counts for troubleshooting
                        </p>
                      </div>
                      <Switch
                        id="diagnostics-metrics"
                        checked={diagnosticsSettings.trackMetrics}
                        onCheckedChange={handleDiagnosticsToggleChange("trackMetrics")}
                      />
                    </div>
                  </div>

                  <div className="mt-4">
                    {diagnosticsSettings.trackMetrics ? (
                      diagnosticsSnapshot ? (
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div className="glass-card rounded-xl border border-white/10 bg-white/5 p-3 text-center">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Requests</p>
                            <p className="mt-1 text-lg font-semibold text-card-foreground">{diagnosticsSummary.totalRequests}</p>
                          </div>
                          <div className="glass-card rounded-xl border border-white/10 bg-white/5 p-3 text-center">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Success rate</p>
                            <p className="mt-1 text-lg font-semibold text-card-foreground">
                              {diagnosticsSummary.successRate != null ? `${diagnosticsSummary.successRate}%` : "–"}
                            </p>
                          </div>
                          <div className="glass-card rounded-xl border border-white/10 bg-white/5 p-3 text-center">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Failures</p>
                            <p className="mt-1 text-lg font-semibold text-card-foreground">{diagnosticsSummary.failed}</p>
                          </div>
                          <div className="glass-card rounded-xl border border-white/10 bg-white/5 p-3 text-center">
                            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Timeouts</p>
                            <p className="mt-1 text-lg font-semibold text-card-foreground">{diagnosticsSummary.timeouts}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="grid grid-cols-2 gap-3">
                          <Skeleton className="h-16 rounded-xl" />
                          <Skeleton className="h-16 rounded-xl" />
                          <Skeleton className="h-16 rounded-xl" />
                          <Skeleton className="h-16 rounded-xl" />
                        </div>
                      )
                    ) : (
                      <p className="glass-card rounded-xl border border-white/10 bg-white/5 p-3 text-[11px] italic text-muted-foreground">
                        Metrics tracking is disabled. Enable it to collect autocomplete diagnostics.
                      </p>
                    )}
                    {diagnosticsSettings.trackMetrics && diagnosticsSnapshot ? (
                      <p className="mt-2 text-right text-[11px] text-muted-foreground">
                        Last updated {diagnosticsSnapshot?.updatedAt ? formatTimestamp(diagnosticsSnapshot.updatedAt) : "–"}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg">
                  <ModelControlPanel />
                </div>

                <div className="glass-card rounded-2xl border border-white/10 bg-white/5 p-5 shadow-lg">
                  <div className="flex items-start gap-3">
                    <div className="glow-ring flex h-10 w-10 items-center justify-center rounded-xl bg-white/10">
                      <TestTube className="h-4 w-4" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-card-foreground">System Tests</p>
                      <p className="text-xs text-muted-foreground">
                        Run quick health checks for NanoScribe components
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-3">
                    <Button
                      onClick={async () => {
                        try {
                          console.log("🧪 Running Readability tests...");
                          const response = await sendToBackground({ type: "RUN_READABILITY_TESTS" });
                          if (response.type === "TEST_RESULTS") {
                            console.log("📊 Test Results:", response.payload);
                          }
                        } catch (error) {
                          console.error("❌ Tests failed:", error);
                        }
                      }}
                      variant="outline"
                      className="justify-start rounded-xl border-white/20 bg-white/5 text-sm text-muted-foreground hover:border-white/40 hover:bg-white/10"
                    >
                      <TestTube className="mr-2 h-4 w-4" />
                      Run Readability Tests
                    </Button>

                    <Button
                      onClick={async () => {
                        try {
                          const response = await sendToBackground({ type: "TEST_DATABASE_STATUS" });
                          if (response.type === "DATABASE_STATUS") {
                            console.log("📊 Database Status:", response.payload);
                          }
                        } catch (error) {
                          console.error("❌ Database test failed:", error);
                        }
                      }}
                      variant="outline"
                      className="justify-start rounded-xl border-white/20 bg-white/5 text-sm text-muted-foreground hover:border-white/40 hover:bg-white/10"
                    >
                      Check Database Status
                    </Button>

                    <Button
                      onClick={async () => {
                        try {
                          const response = await sendToBackground({ type: "TEST_CONTENT_QUALITY" });
                          if (response.type === "QUALITY_RESULTS") {
                            console.log("📊 Content Quality:", response.payload);
                          }
                        } catch (error) {
                          console.error("❌ Quality test failed:", error);
                        }
                      }}
                      variant="outline"
                      className="justify-start rounded-xl border-white/20 bg-white/5 text-sm text-muted-foreground hover:border-white/40 hover:bg-white/10"
                    >
                      Test Content Quality
                    </Button>
                  </div>
                  <div className="mt-4 text-xs text-muted-foreground">
                    <p>💡 Tests run in the background and log results to the console.</p>
                    <p>💡 Check DevTools Console (F12) for detailed results.</p>
                    <p>💡 Make sure to visit some websites first for meaningful tests.</p>
                  </div>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </Fragment>
  );
}
