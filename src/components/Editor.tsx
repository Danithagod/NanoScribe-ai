import { useState, useRef, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Sparkles, Lightbulb } from "lucide-react";

interface Suggestion {
  text: string;
  visible: boolean;
}

export const Editor = () => {
  const [content, setContent] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion>({ text: "", visible: false });
  const [cursorPosition, setCursorPosition] = useState({ top: 0, left: 0 });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestTimeoutRef = useRef<NodeJS.Timeout>();

  // Simulate AI suggestion generation
  const generateSuggestion = (text: string) => {
    if (text.trim().length < 10) {
      setSuggestion({ text: "", visible: false });
      return;
    }

    // Simulate context-aware suggestions
    const suggestions = [
      "Consider exploring the relationship between these concepts further.",
      "This insight could be expanded with specific examples.",
      "An interesting perspective that builds on your previous thoughts.",
      "You might want to connect this to your earlier notes on semantic memory.",
    ];

    const randomSuggestion = suggestions[Math.floor(Math.random() * suggestions.length)];
    
    // Get cursor position
    if (textareaRef.current) {
      const { selectionStart } = textareaRef.current;
      const textBeforeCursor = text.substring(0, selectionStart);
      const lines = textBeforeCursor.split('\n');
      const currentLine = lines.length;
      const lineHeight = 24; // Approximate line height
      
      setCursorPosition({
        top: currentLine * lineHeight,
        left: 20,
      });
    }

    setSuggestion({ text: randomSuggestion, visible: true });
  };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);

    // Clear existing timeout
    if (suggestTimeoutRef.current) {
      clearTimeout(suggestTimeoutRef.current);
    }

    // Debounce suggestion generation
    suggestTimeoutRef.current = setTimeout(() => {
      generateSuggestion(newContent);
    }, 1000);
  };

  const acceptSuggestion = () => {
    const newContent = content + " " + suggestion.text;
    setContent(newContent);
    setSuggestion({ text: "", visible: false });
  };

  const dismissSuggestion = () => {
    setSuggestion({ text: "", visible: false });
  };

  useEffect(() => {
    return () => {
      if (suggestTimeoutRef.current) {
        clearTimeout(suggestTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="relative h-full flex flex-col bg-background/40 backdrop-blur-2xl">
      {/* Header */}
      <div className="p-6 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-white/10 backdrop-blur-xl rounded-lg border border-white/20 shadow-glow">
            <Lightbulb className="h-5 w-5 text-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">NanoScribe Editor</h1>
            <p className="text-sm text-muted-foreground">
              Context-aware writing with semantic memory
            </p>
          </div>
        </div>
      </div>

      {/* Editor Area */}
      <div className="flex-1 p-6 relative">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleTextChange}
          placeholder="Start writing... Your semantic memories will help guide your thoughts."
          className="w-full h-full p-6 bg-white/5 backdrop-blur-xl rounded-lg border border-white/10 focus:outline-none focus:ring-2 focus:ring-white/30 focus:border-white/30 resize-none text-base leading-relaxed placeholder:text-muted-foreground"
        />

        {/* Suggestion Popover */}
        {suggestion.visible && (
          <Card 
            className="absolute bg-white/10 backdrop-blur-2xl border-white/20 p-4 max-w-md animate-slide-in shadow-glow"
            style={{
              top: `${cursorPosition.top + 120}px`,
              left: `${cursorPosition.left + 24}px`,
            }}
          >
            <div className="flex items-start gap-3">
              <div className="p-2 bg-white/20 backdrop-blur-xl rounded-lg shrink-0 border border-white/30 animate-glow-pulse">
                <Sparkles className="h-4 w-4 text-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm mb-3">{suggestion.text}</p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={acceptSuggestion}
                    className="bg-white/20 backdrop-blur-xl hover:bg-white/30 border border-white/30"
                  >
                    Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={dismissSuggestion}
                    className="text-muted-foreground hover:bg-white/10"
                  >
                    Dismiss
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-6 py-3 border-t border-white/10 bg-white/5 backdrop-blur-xl">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{content.split(/\s+/).filter(Boolean).length} words</span>
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-white/60 animate-pulse" />
            <span>AI assistance active</span>
          </div>
        </div>
      </div>
    </div>
  );
};
