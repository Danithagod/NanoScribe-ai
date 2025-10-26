import React from 'react';
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Loader2 } from "lucide-react";
import { proofreaderState, type ProofreaderCorrection, type ProofreaderState, getCurrentSession } from "./proofreader-state";
import { sendToBackground } from "./messaging";
import {
  showProofreaderDialog,
  runProofreaderForSelection,
  hideProofreaderDialog
} from "./proofreader-utils";

// New proofreader dialog component using Shadcn UI
export const NewProofreaderDialog: React.FC = () => {
  const [state, setState] = React.useState<ProofreaderState>(proofreaderState);
  const [renderTrigger, setRenderTrigger] = React.useState(0);

  React.useEffect(() => {
    setState(proofreaderState);
  }, []);

  // Watch for changes in the global state and trigger re-renders
  React.useEffect(() => {
    const checkState = () => {
      const currentState = proofreaderState;
      setState(prevState => {
        // Only update if there are actual changes
        if (JSON.stringify(prevState) !== JSON.stringify(currentState)) {
          return currentState;
        }
        return prevState;
      });
    };

    // Check for state changes periodically
    const interval = setInterval(checkState, 100);

    return () => clearInterval(interval);
  }, []);

  const handleAccept = async () => {
    if (state.error) {
      window.location.reload();
      return;
    }

    if (state.corrections.length === 0) {
      hideProofreaderDialog();
      return;
    }

    try {
      // Send message to apply all corrections through the service worker
      const response = await sendToBackground({
        type: "APPLY_PROOFREADER_CORRECTIONS",
        payload: {
          correctedText: state.correctedText,
          originalText: state.selectedText,
          sessionId: state.activeSession?.id
        }
      });

      if (response.type === "CORRECTIONS_APPLIED") {
        console.log('All corrections applied successfully');
        hideProofreaderDialog();
      } else if (response.type === "ERROR") {
        console.error('Failed to apply corrections:', response.message);
        // Could show an error message to the user here
      }
    } catch (error) {
      console.error('Error applying corrections:', error);
    }
  };

  const handleIndividualCorrection = async (correction: ProofreaderCorrection) => {
    try {
      // Send message to apply single correction through the service worker
      const response = await sendToBackground({
        type: "APPLY_SINGLE_CORRECTION",
        payload: {
          correctedText: state.correctedText,
          originalText: state.selectedText,
          sessionId: state.activeSession?.id
        }
      });

      if (response.type === "CORRECTION_APPLIED") {
        console.log('Single correction applied successfully');
        hideProofreaderDialog();
      } else if (response.type === "ERROR") {
        console.error('Failed to apply single correction:', response.message);
        // Could show an error message to the user here
      }
    } catch (error) {
      console.error('Error applying single correction:', error);
    }
  };

  const handleCancel = () => {
    hideProofreaderDialog();
  };

  return (
    <div className="w-full max-h-full bg-background border border-gray-200 rounded-lg shadow-lg overflow-hidden font-sans">
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-gray-900">Proofreader</h3>
          <Button variant="ghost" size="sm" onClick={handleCancel} className="h-6 w-6 p-0 text-gray-500 hover:text-gray-700">
            ×
          </Button>
        </div>

        {state.isVisible && (
          <>
            {/* Selected text display */}
            <div className="p-3 bg-gray-50 rounded-lg mb-3 border border-gray-200">
              <p className="text-sm text-gray-700 leading-relaxed">
                {state.selectedText}
              </p>
            </div>

            {/* Loading state */}
            {state.isLoading && (
              <div className="flex items-center space-x-2 mb-3">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                <span className="text-sm text-gray-600">Analyzing text...</span>
              </div>
            )}

            {/* Error state */}
            {state.error && (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription className="text-red-700">{state.error}</AlertDescription>
              </Alert>
            )}

            {/* Corrections */}
            {!state.isLoading && !state.error && (
              <div className="space-y-3 mb-3 max-h-48 overflow-y-auto">
                {state.corrections.length > 0 ? (
                  <div className="space-y-2">
                    {state.corrections.map((correction, index) => (
                      <div
                        key={index}
                        className="p-3 border border-gray-200 rounded-lg space-y-2 bg-white cursor-pointer hover:bg-gray-50 transition-colors"
                        onClick={() => handleIndividualCorrection(correction)}
                      >
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800">
                            {correction.type}
                          </Badge>
                          <span className="font-medium text-sm text-gray-900">
                            {correction.correction}
                          </span>
                        </div>
                        {correction.explanation && (
                          <p className="text-xs text-gray-600">
                            {correction.explanation}
                          </p>
                        )}
                        <p className="text-xs text-gray-500">
                          Click to apply this correction
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-sm text-green-700">
                      No corrections needed. The text looks good!
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleCancel} className="flex-1 border-gray-300 text-gray-700 hover:bg-gray-50">
                Cancel
              </Button>
              <Button
                onClick={handleAccept}
                disabled={state.corrections.length === 0 && !state.error}
                variant={state.error ? "destructive" : "default"}
                className={`flex-1 ${state.error ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-blue-500 hover:bg-blue-600 text-white'}`}
              >
                {state.error ? 'Reload Page' : 'Accept All'}
              </Button>
            </div>
          </>
        )}

        {!state.isVisible && (
          <div className="text-center text-gray-500 text-sm">
            Select text to get proofreader suggestions
          </div>
        )}
      </div>
    </div>
  );
};
