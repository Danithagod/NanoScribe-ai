import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ActivitySquare, AlertTriangle, CheckCircle, Cloud, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ModelStatus } from '@/extension/types';

export type ModelStatusIndicatorProps = {
  name: string;
  status: ModelStatus;
};

import type { ModelStatusState } from '@/extension/types';

const statusConfig: Record<ModelStatusState, {
  icon: typeof Loader2;
  color: string;
  bgColor: string;
  borderColor: string;
  label: string;
}> = {
  idle: {
    icon: Loader2,
    color: 'text-gray-500',
    bgColor: 'bg-gray-500/10',
    borderColor: 'border-gray-500/20',
    label: 'Idle'
  },
  checking: {
    icon: Loader2,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
    label: 'Checking'
  },
  ready: {
    icon: CheckCircle,
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
    borderColor: 'border-green-500/20',
    label: 'Ready'
  },
  downloading: {
    icon: Cloud,
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/20',
    label: 'Downloading'
  },
  unavailable: {
    icon: AlertTriangle,
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
    label: 'Unavailable'
  },
  error: {
    icon: AlertTriangle,
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    borderColor: 'border-red-500/20',
    label: 'Error'
  }
};

export function ModelStatusIndicator({ name, status }: ModelStatusIndicatorProps) {
  const config = statusConfig[status.state];
  const Icon = config.icon;

  return (
    <Card className={cn("p-4 transition-all", config.borderColor, config.bgColor)}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ActivitySquare className="h-5 w-5 text-muted-foreground" />
          <h3 className="font-medium">{name}</h3>
        </div>
        <Badge variant="outline" className={cn("font-medium", config.color)}>
          <Icon className="h-3 w-3 mr-1" />
          {config.label}
        </Badge>
      </div>
      
      {status.state === 'downloading' && (
        <div className="space-y-2">
          <Progress value={status.progress} className="h-1" />
          <p className="text-xs text-muted-foreground">{Math.round(status.progress)}% complete</p>
        </div>
      )}
      
      {status.message && (
        <p className="text-sm text-muted-foreground mt-2">{status.message}</p>
      )}
    </Card>
  );
}