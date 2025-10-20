import { useState } from "react";
import { SidePanel } from "@/components/SidePanel";
import { Editor } from "@/components/Editor";
import { type Memory } from "@/components/MemoryCard";

// Sample memory data
const sampleMemories: Memory[] = [
  {
    id: "1",
    url: "https://example.com/ai-research",
    title: "Advances in Neural Language Models",
    summary: "Exploration of transformer architectures and their impact on natural language understanding. Key insights into attention mechanisms and contextual embeddings.",
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    tags: ["AI", "NLP", "Research"]
  },
  {
    id: "2",
    url: "https://example.com/semantic-web",
    title: "The Semantic Web and Knowledge Graphs",
    summary: "Understanding how semantic technologies enable machines to understand and process web content more intelligently. Discussion of RDF, OWL, and SPARQL.",
    timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    tags: ["Semantic Web", "Knowledge Graphs"]
  },
  {
    id: "3",
    url: "https://example.com/chrome-extensions",
    title: "Building Chrome Extensions with Modern APIs",
    summary: "Comprehensive guide to Chrome Extension Manifest V3, service workers, and content scripts. Best practices for background processing and user privacy.",
    timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    tags: ["Chrome", "Extensions", "JavaScript"]
  },
  {
    id: "4",
    url: "https://example.com/indexeddb",
    title: "Client-Side Storage with IndexedDB",
    summary: "Deep dive into IndexedDB for storing large amounts of structured data. Covers transactions, indexes, and performance optimization techniques.",
    timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    tags: ["Database", "Web APIs"]
  },
  {
    id: "5",
    url: "https://example.com/ai-writing",
    title: "AI-Powered Writing Assistants",
    summary: "Analysis of how AI writing tools are transforming content creation. Examining GPT models, context awareness, and real-time suggestions.",
    timestamp: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
    tags: ["AI", "Writing", "Productivity"]
  }
];

const Index = () => {
  const [memories] = useState<Memory[]>(sampleMemories);

  const handleMemoryClick = (memory: Memory) => {
    console.log("Memory clicked:", memory);
    // In the actual extension, this would open the URL or insert context
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Side Panel - Fixed width */}
      <div className="w-80 shrink-0">
        <SidePanel memories={memories} onMemoryClick={handleMemoryClick} />
      </div>
      
      {/* Main Editor - Takes remaining space */}
      <div className="flex-1 overflow-hidden">
        <Editor />
      </div>
    </div>
  );
};

export default Index;
