import { useEffect, useState } from 'react';
import type { ModelStatus, ModelIdentifier } from '@/extension/types';

interface MessageEvent {
  data: {
    type: string;
    payload?: Record<string, ModelStatus>;
  };
}

export function useModelStatus(modelId: string): ModelStatus {
  const [status, setStatus] = useState<ModelStatus>({
    id: modelId as ModelIdentifier,
    state: 'idle',
    progress: 0,
    message: "Not initialized",
    updatedAt: Date.now(),
  });

  useEffect(() => {
    const updateStatus = (message: { type: string; payload?: Record<string, ModelStatus> }) => {
      if (message?.type === 'MODEL_STATUS_CHANGED') {
        const statuses = message.payload;
        if (statuses && statuses[modelId]) {
          setStatus(statuses[modelId]);
        }
      }
    };

    // Listen for model status updates from the service worker
    chrome.runtime.onMessage.addListener(updateStatus);

    // Get initial status
    chrome.runtime.sendMessage(
      { type: 'GET_MODEL_STATUS' },
      (response) => {
        if (response?.type === 'MODEL_STATUS' && response.payload) {
          const statuses = response.payload;
          if (statuses[modelId]) {
            setStatus(statuses[modelId]);
          }
        }
      }
    );

    return () => {
      chrome.runtime.onMessage.removeListener(updateStatus);
    };
  }, [modelId]);

  return status;
}