import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ModelStatusIndicator } from '@/components/ModelStatusIndicator';
import { useModelStatus } from '@/hooks/use-model-status';
import { Separator } from '@/components/ui/separator';
import { Play, CheckCircle } from 'lucide-react';

const MODEL_LABELS = {
  proofreader: 'Proofreader',
  languageModel: 'Language Model',
  summarizer: 'Summarizer',
};

const MODEL_DESCRIPTIONS = {
  proofreader: 'Corrects grammar, spelling, and punctuation in text.',
  languageModel: 'Generates text completions and responses.',
  summarizer: 'Creates summaries of long texts.',
};

export function ModelControlPanel() {
  const proofreaderStatus = useModelStatus('proofreader');
  const languageModelStatus = useModelStatus('languageModel');
  const summarizerStatus = useModelStatus('summarizer');

  const models = [
    { id: 'proofreader', status: proofreaderStatus, description: MODEL_DESCRIPTIONS.proofreader },
    { id: 'languageModel', status: languageModelStatus, description: MODEL_DESCRIPTIONS.languageModel },
    { id: 'summarizer', status: summarizerStatus, description: MODEL_DESCRIPTIONS.summarizer },
  ];

  const handleInvoke = (modelId: string) => {
    console.log(`Attempting to invoke ${modelId}, current status:`, models.find(m => m.id === modelId)?.status);

    let messageType: string;

    switch (modelId) {
      case 'languageModel':
        messageType = 'INVOKE_LANGUAGE_MODEL';
        break;
      case 'proofreader':
        messageType = 'INVOKE_PROOFREADER';
        break;
      case 'summarizer':
        messageType = 'INVOKE_SUMMARIZER';
        break;
      default:
        console.error(`Unknown model ID: ${modelId}`);
        return;
    }

    console.log(`Sending message type: ${messageType}`);

    chrome.runtime.sendMessage({ type: messageType }, (response) => {
      console.log(`Response for ${modelId}:`, response);
      if (response?.type === 'ERROR') {
        console.error(`Failed to invoke ${modelId}:`, response.message);
      } else {
        console.log(`${modelId} invoked successfully.`);
        // Status will update via the listener
      }
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle className="h-5 w-5" />
          Model Availability & Control
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {models.map((model) => (
          <div key={model.id} className="space-y-3">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h3 className="font-medium text-sm">{MODEL_LABELS[model.id as keyof typeof MODEL_LABELS]}</h3>
                <p className="text-xs text-muted-foreground mt-1">{model.description}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleInvoke(model.id)}
                disabled={false}
                className="ml-2"
              >
                <Play className="h-3 w-3 mr-1" />
                Invoke
              </Button>
            </div>
            <ModelStatusIndicator name={MODEL_LABELS[model.id as keyof typeof MODEL_LABELS]} status={model.status} />
            <Separator />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
