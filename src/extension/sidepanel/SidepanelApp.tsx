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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { proofreaderState, type ProofreaderState, type ProofreaderCorrection, type ProofreaderSession, getCurrentSession } from "../proofreader-state";
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

// Component for proofreader content in side panel
const ProofreaderContent: React.FC<{
  state: ProofreaderState;
  onStateChange: (state: ProofreaderState) => void;
}> = ({ state, onStateChange }) => {
  console.log('🎨 ProofreaderContent rendering with state:', state);

  const handleAccept = async () => {
    if (state.error) {
      window.location.reload();
      return;
    }

    if (state.corrections.length === 0) {
      onStateChange({ ...state, isVisible: false });
      return;
    }

    console.log('🎯 Sidepanel: User clicked Accept All');
    console.log('📋 Sending corrected text for application');

    // Get the corrected text from the local state
    const correctedText = state.correctedText;

    if (!correctedText) {
      console.error('❌ No corrected text available');
      return;
    }

    console.log('📝 Original text:', state.selectedText);
    console.log('📝 Corrected text:', correctedText);
    console.log('🔑 Session ID:', state.sessionId);

    try {
      // Send message to apply the corrected text through the service worker
      const response = await sendToBackground({
        type: "APPLY_PROOFREADER_CORRECTIONS",
        payload: {
          correctedText: correctedText,
          originalText: state.selectedText,
          sessionId: state.sessionId
        }
      });

      console.log('✅ Accept All response received:', response.type);

      if (response.type === "CORRECTIONS_APPLIED") {
        console.log('All corrections applied successfully');
        onStateChange({ ...state, isVisible: false });
      } else if (response.type === "ERROR") {
        console.error('Failed to apply corrections:', response.message);
        // Could show an error message to the user here
      }
    } catch (error) {
      console.error('Error applying corrections:', error);
    }
  };

  const handleIndividualCorrection = async (correction: ProofreaderCorrection) => {
    console.log('🎯 Sidepanel: User clicked individual correction');
    console.log('📝 Correction:', correction);
    console.log('📝 Original text:', state.selectedText);
    console.log('🔑 Session ID:', state.sessionId);

    // Get the corrected text from the local state
    const correctedText = state.correctedText;

    if (!correctedText) {
      console.error('❌ No corrected text available');
      return;
    }

    console.log('📝 Using corrected text:', correctedText);

    try {
      // Send message to apply the corrected text through the service worker
      const response = await sendToBackground({
        type: "APPLY_SINGLE_CORRECTION",
        payload: {
          correctedText: correctedText,
          originalText: state.selectedText,
          sessionId: state.sessionId
        }
      });

      console.log('✅ Individual correction response received:', response.type);

      if (response.type === "CORRECTION_APPLIED") {
        console.log('Single correction applied successfully');
        onStateChange({ ...state, isVisible: false });
      } else if (response.type === "ERROR") {
        console.error('Failed to apply single correction:', response.message);
        // Could show an error message to the user here
      }
    } catch (error) {
      console.error('Error applying single correction:', error);
    }
  };

  const handleCancel = () => {
    onStateChange({ ...state, isVisible: false });
  };

  return (
    <div className="flex flex-col gap-4">
      {state.isVisible && (
        <>
          {/* Selected text display */}
          <Card className="border-border bg-card/95 shadow-sm">
            <CardHeader className="space-y-1">
              <CardTitle className="text-sm font-medium text-card-foreground">Selected Text</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-32 overflow-y-auto">
                <p className="text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
                  {state.selectedText}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Loading state */}
          {state.isLoading && (
            <Card className="border-border bg-card/95 shadow-sm">
              <CardContent className="pt-6">
                <div className="flex items-center space-x-2 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">Analyzing text...</span>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Error state */}
          {state.error && (
            <Alert variant="destructive" className="border-red-200 bg-red-50/50">
              <AlertDescription className="text-red-700">{state.error}</AlertDescription>
            </Alert>
          )}

          {/* Corrections */}
          {!state.isLoading && !state.error && (
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {state.corrections.length > 0 ? (
                <div className="space-y-2">
                  {state.corrections.map((correction, index) => (
                    <Card
                      key={index}
                      className="border-border bg-card/95 shadow-sm cursor-pointer hover:bg-accent/50 transition-colors"
                      onClick={() => handleIndividualCorrection(correction)}
                    >
                      <CardContent className="pt-4">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="secondary" className="text-xs bg-primary/10 text-primary border-primary/20">
                              {correction.type}
                            </Badge>
                            <span className="font-medium text-sm text-card-foreground">
                              {correction.correction}
                            </span>
                          </div>
                          {correction.explanation && (
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              {correction.explanation}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            Click to apply this correction
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : (
                <Card className="border-green-200 bg-green-50/50 shadow-sm">
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 border-green-200">
                        ✓
                      </Badge>
                      <p className="text-sm text-green-700">
                        No corrections needed. The text looks good!
                      </p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Action buttons */}
          <Card className="border-border bg-card/95 shadow-sm">
            <CardContent className="pt-4">
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={handleCancel}
                  className="flex-1 border-border text-muted-foreground hover:bg-muted"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAccept}
                  disabled={state.corrections.length === 0 && !state.error}
                  variant={state.error ? "destructive" : "default"}
                  className={`flex-1 ${state.error ? '' : 'bg-primary hover:bg-primary/90 text-primary-foreground'}`}
                >
                  {state.error ? 'Reload Page' : 'Accept All'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {!state.isVisible && (
        <Card className="border-border bg-card/95 shadow-sm">
          <CardContent className="pt-6">
            <div className="text-center">
              <p className="text-sm font-medium text-card-foreground mb-2">No text selected</p>
              <p className="text-xs text-muted-foreground">
                Select text on the page to get proofreader suggestions
              </p>
            </div>
          </CardContent>
        </Card>
      )}
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
      <Card className="border-border bg-card/95 shadow-sm">
        <CardContent className="pt-6">
          <div className="text-center">
            <p className="text-sm font-medium text-card-foreground mb-2">No active field</p>
            <p className="text-xs text-muted-foreground">
              Click in a text field to see autocomplete suggestions
            </p>
          </div>
        </CardContent>
      </Card>
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
      <Card className="border-border bg-card/95 shadow-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-sm font-medium text-card-foreground flex items-center gap-2">
            Autocomplete Status
            <Badge variant="secondary" className={`text-xs ${
              statusInfo.tone === 'success' ? 'bg-green-100 text-green-800 border-green-200' :
              statusInfo.tone === 'warning' ? 'bg-yellow-100 text-yellow-800 border-yellow-200' :
              statusInfo.tone === 'destructive' ? 'bg-red-100 text-red-800 border-red-200' :
              'bg-gray-100 text-gray-800 border-gray-200'
            }`}>
              {statusInfo.label}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            {AUTOCOMPLETE_STATUS_COPY[state.status]}
          </p>

          {state.suggestion && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-card-foreground">Current Suggestion:</div>
              <div className="p-2 bg-muted/50 rounded border text-sm text-muted-foreground font-mono">
                {state.suggestion.completionText}
              </div>
              {state.fieldPreview && (
                <div className="text-xs text-muted-foreground">
                  Context: {state.fieldPreview}
                </div>
              )}
            </div>
          )}

          {state.error && (
            <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">
              {state.error}
            </div>
          )}
        </CardContent>
      </Card>

      {state.suggestion && (
        <Card className="border-border bg-card/95 shadow-sm">
          <CardContent className="pt-4">
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => onCommand("accept")}
                className="flex-1 bg-green-500 hover:bg-green-600 text-white text-xs"
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onCommand("decline")}
                className="flex-1 text-xs"
              >
                Decline
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onCommand("regenerate")}
                className="flex-1 text-xs"
              >
                Regenerate
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {state.status === "error" && (
        <Card className="border-border bg-card/95 shadow-sm">
          <CardContent className="pt-4">
            <Button
              size="sm"
              onClick={() => onCommand("clear")}
              className="w-full text-xs"
            >
              Clear Error
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

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
  const [activeTab, setActiveTab] = useState("memories");
  const [proofreaderStateLocal, setProofreaderStateLocal] = useState<ProofreaderState>(proofreaderState);
  const [lastStateUpdate, setLastStateUpdate] = useState<string | null>(null);

  useEffect(() => {
    console.log('🔄 proofreaderStateLocal changed:', proofreaderStateLocal);
  }, [proofreaderStateLocal]);

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

        // Auto-switch to autocomplete tab when suggestion becomes available
        if (message.payload.status === "suggestion" && message.payload.suggestion) {
          setActiveTab("autocomplete");
        }
      }

      if (message.type === "PROOFREADER_STATE_UPDATED") {
        console.log('🎯 Sidepanel received PROOFREADER_STATE_UPDATED:', message.payload);
        console.log('🔑 Session ID in payload:', message.payload.sessionId);
        console.log('📝 Corrected text in payload:', message.payload.correctedText);

        // Create a unique key for this state update to prevent duplicates
        const stateKey = `${message.payload.text}-${message.payload.isVisible}-${message.payload.isLoading}-${message.payload.corrections?.length || 0}`;

        // Skip if this is a duplicate update
        if (lastStateUpdate === stateKey) {
          console.log('🔄 Skipping duplicate state update');
          return;
        }

        setLastStateUpdate(stateKey);

        // Update local proofreader state and switch to proofreader tab
        const newState = {
          selectedText: message.payload.text,
          isVisible: message.payload.isVisible,
          isLoading: message.payload.isLoading,
          corrections: message.payload.corrections,
          error: message.payload.error,
          activeSession: null, // Sidepanel doesn't need the full session object
          sessionId: message.payload.sessionId,
          correctedText: message.payload.correctedText || null
        };

        console.log('🔄 Updating proofreader state with sessionId:', message.payload.sessionId);
        console.log('📝 Corrected text received:', message.payload.correctedText);

        // Reset session if corrections were applied (isVisible: false and no corrections)
        if (!message.payload.isVisible && (!message.payload.corrections || message.payload.corrections.length === 0) && !message.payload.error) {
          console.log('✅ Corrections applied successfully, resetting session');
          // Force a clean state reset
          setProofreaderStateLocal({
            isVisible: false,
            selectedText: '',
            corrections: [],
            isLoading: false,
            error: null,
            activeSession: null,
            correctedText: null
          });
        } else {
          setProofreaderStateLocal(newState);
        }

        setActiveTab("proofreader");
        console.log('✅ Switched to proofreader tab');
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [filter, lastStateUpdate]);

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
        <h1 className="text-lg font-semibold tracking-tight text-foreground">NanoScribe</h1>
        <p className="text-xs text-muted-foreground">Private AI assistant for writing and browsing.</p>
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="autocomplete">Autocomplete</TabsTrigger>
          <TabsTrigger value="memories">Memories</TabsTrigger>
          <TabsTrigger value="proofreader">Proofreader</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="memories" className="flex-1 flex flex-col gap-4 mt-4">
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
        </TabsContent>

        <TabsContent value="autocomplete" className="flex-1 mt-4">
          <div className="h-full overflow-y-auto">
            <AutocompleteContent state={autocompleteState} onCommand={handleAutocompleteCommand} />
          </div>
        </TabsContent>

        <TabsContent value="proofreader" className="flex-1 mt-4">
          <div className="h-full overflow-y-auto">
            <ProofreaderContent state={proofreaderStateLocal} onStateChange={setProofreaderStateLocal} />
          </div>
        </TabsContent>

        <TabsContent value="settings" className="flex-1 mt-4">
          <ScrollArea className="h-full">
            <ModelControlPanel />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
