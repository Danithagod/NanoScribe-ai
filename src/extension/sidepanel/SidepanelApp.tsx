/// <reference types="chrome" />

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ModelStatusSection } from "@/components/ModelStatusSection";
import type { AutocompleteState, MemoryRecord, ModelIdentifier, ModelStatus, ModelStatusMap } from "../types";
import { sendToBackground, type AutocompleteCommand, type BackgroundEvent } from "../messaging";
import { isBackgroundEvent } from "../messaging";
import { ModelControlPanel } from "@/components/ModelControlPanel";

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

export function SidepanelApp() {
  const [filter, setFilter] = useState("");
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [allMemories, setAllMemories] = useState<MemoryRecord[]>([]);
  const [visibleMemories, setVisibleMemories] = useState<MemoryRecord[]>([]);
  const [modelStatuses, setModelStatuses] = useState<ModelStatusMap>(createFallbackStatuses);
  const [hasLoadedModelStatuses, setHasLoadedModelStatuses] = useState(false);
  const [autocompleteState, setAutocompleteState] = useState<AutocompleteState | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  useEffect(() => {
    sendToBackground({ type: "SIDEPANEL_READY" }).catch((error) => {
      console.error("[NanoScribe] Failed to acknowledge side panel", error);
    });

    setFetchState("loading");

    sendToBackground({ type: "GET_MEMORIES" })
      .then((response) => {
        if (response.type === "MEMORIES") {
          setAllMemories(response.payload);
          setVisibleMemories(response.payload);
          setFetchState("idle");
          setErrorMessage(null);
        } else if (response.type === "ERROR") {
          setFetchState("error");
          setErrorMessage(response.message);
        }
      })
      .catch((error) => {
        console.error("[NanoScribe] Failed to fetch memories", error);
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
  }, []);

  useEffect(() => {
    const controller = window.setTimeout(() => {
      const query = filter.trim();
      if (!query) {
        setVisibleMemories(allMemories);
        return;
      }

      sendToBackground({ type: "SEARCH_MEMORIES", query })
        .then((response) => {
          if (response.type === "MEMORIES") {
            setVisibleMemories(response.payload);
          } else if (response.type === "ERROR") {
            setErrorMessage(response.message);
          }
        })
        .catch((error) => {
          console.error("[NanoScribe] Search failed", error);
          setErrorMessage("Search failed. Try again.");
        });
    }, 250);

    return () => {
      window.clearTimeout(controller);
    };
  }, [filter, allMemories]);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (!isBackgroundEvent(message)) return;

      if (message.type === "MEMORY_SAVED") {
        setAllMemories((current) => {
          const withoutDuplicate = current.filter((memory) => memory.id !== message.payload.id);
          return [message.payload, ...withoutDuplicate].sort((a, b) => b.createdAt - a.createdAt);
        });

        setVisibleMemories((current) => {
          if (filter.trim()) {
            return current;
          }
          const withoutDuplicate = current.filter((memory) => memory.id !== message.payload.id);
          return [message.payload, ...withoutDuplicate];
        });
        return;
      }

      if (message.type === "MODEL_STATUS_CHANGED") {
        setModelStatuses(message.payload);
        setHasLoadedModelStatuses(true);
        return;
      }

      if (message.type === "AUTOCOMPLETE_STATE_UPDATED") {
        setAutocompleteState(message.payload);
        setCommandError(null);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [filter]);

  const statusLabel = useMemo(() => {
    if (fetchState === "loading") {
      return "Loading memories...";
    }
    if (fetchState === "error") {
      return errorMessage ?? "Something went wrong.";
    }
    if (visibleMemories.length === 0) {
      return filter.trim() ? "No memories match your search." : "Browse the web to start building memories.";
    }
    return null;
  }, [fetchState, errorMessage, visibleMemories.length, filter]);

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

  useEffect(() => {
    if (commandError && (!autocompleteState || autocompleteState.status !== "error")) {
      const timer = window.setTimeout(() => setCommandError(null), 4000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [commandError, autocompleteState]);

  return (
    <div className="flex h-full flex-col gap-4 bg-background p-4">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">NanoScribe Recall</h1>
        <p className="text-xs text-muted-foreground">Private summaries captured on-device.</p>
      </header>


    

      <ModelControlPanel/>

      <Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search memories..." className="text-sm" />

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 pb-4">
          {fetchState === "loading" ? (
            <>
              <Skeleton className="h-20 w-full rounded-lg" />
              <Skeleton className="h-20 w-full rounded-lg" />
            </>
          ) : (
            visibleMemories.map((memory) => (
              <Card key={memory.id} className="border-border bg-card/95 shadow-sm">
                <CardHeader className="space-y-1">
                  <CardTitle className="text-sm font-medium text-card-foreground">{memory.title}</CardTitle>
                  <a
                    href={memory.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-primary underline-offset-2 hover:underline"
                  >
                    {memory.url}
                  </a>
                </CardHeader>
                <CardContent>
                  <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-line">{memory.summary}</p>
                </CardContent>
              </Card>
            ))
          )}
          {statusLabel ? <p className="text-center text-xs text-muted-foreground">{statusLabel}</p> : null}
        </div>
      </ScrollArea>
    </div>
  );
}
