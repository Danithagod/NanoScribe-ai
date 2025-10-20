import { useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Sparkles } from "lucide-react";
import { MemoryCard, type Memory } from "./MemoryCard";

interface SidePanelProps {
  memories: Memory[];
  onMemoryClick?: (memory: Memory) => void;
}

export const SidePanel = ({ memories, onMemoryClick }: SidePanelProps) => {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredMemories = memories.filter(memory =>
    memory.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    memory.summary.toLowerCase().includes(searchQuery.toLowerCase()) ||
    memory.tags?.some(tag => tag.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="h-screen w-full bg-card border-r border-border flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 bg-gradient-primary rounded-lg shadow-glow">
            <Sparkles className="h-5 w-5 text-primary-foreground" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Semantic Recall</h2>
            <p className="text-xs text-muted-foreground">Your browsing memory</p>
          </div>
        </div>
        
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 bg-background/50 border-border focus-visible:ring-primary"
          />
        </div>
      </div>

      {/* Memory List */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-3">
          {filteredMemories.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Sparkles className="h-12 w-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">
                {searchQuery ? "No memories match your search" : "No memories yet"}
              </p>
            </div>
          ) : (
            filteredMemories.map(memory => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                onClick={() => onMemoryClick?.(memory)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
