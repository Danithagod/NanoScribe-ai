import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock, ExternalLink } from "lucide-react";

export interface Memory {
  id: string;
  url: string;
  title: string;
  summary: string;
  timestamp: Date;
  tags?: string[];
}

interface MemoryCardProps {
  memory: Memory;
  onClick?: () => void;
}

export const MemoryCard = ({ memory, onClick }: MemoryCardProps) => {
  const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const daysDiff = Math.floor((Date.now() - memory.timestamp.getTime()) / (1000 * 60 * 60 * 24));
  
  return (
    <Card 
      className="group hover:border-white/30 transition-all duration-300 hover:shadow-glow cursor-pointer animate-slide-in bg-white/5 backdrop-blur-xl border-white/10 "
      onClick={onClick}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base font-semibold line-clamp-2 group-hover:text-foreground transition-colors">
            {memory.title}
          </CardTitle>
          <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
        <CardDescription className="flex items-center gap-2 text-xs">
          <Clock className="h-3 w-3" />
          <span>{relativeTime.format(daysDiff, 'day')}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-sm text-muted-foreground line-clamp-3 mb-3">
          {memory.summary}
        </p>
        {memory.tags && memory.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {memory.tags.map((tag, idx) => (
              <Badge 
                key={idx} 
                variant="secondary" 
                className="text-xs px-2 py-0 h-5 bg-white/10 backdrop-blur-xl border-white/20"
              >
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};
