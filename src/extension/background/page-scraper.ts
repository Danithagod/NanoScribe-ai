const MAX_CONTENT_LENGTH = 8000;

export async function extractReadableText(tabId: number): Promise<string> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const articleElement =
        document.querySelector("article") ||
        document.querySelector("main") ||
        document.body;

      if (!articleElement) {
        return "";
      }

      const walker = document.createTreeWalker(articleElement, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node || !node.parentElement) return NodeFilter.FILTER_SKIP;
          const parent = node.parentElement;
          const style = window.getComputedStyle(parent);
          if (style?.display === "none" || style?.visibility === "hidden") {
            return NodeFilter.FILTER_SKIP;
          }
          if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE" || parent.tagName === "NOSCRIPT") {
            return NodeFilter.FILTER_SKIP;
          }
          return node.textContent && node.textContent.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP;
        },
      });

      const segments: string[] = [];
      let currentNode = walker.nextNode();

      while (currentNode) {
        const text = currentNode.textContent?.trim();
        if (text) segments.push(text);
        currentNode = walker.nextNode();
      }

      return segments.join("\n\n");
    },
  });

  const text = typeof result === "string" ? result : "";
  if (text.length > MAX_CONTENT_LENGTH) {
    return text.slice(0, MAX_CONTENT_LENGTH);
  }
  return text;
}

export type ExtractedContentChunk = {
  title: string;
  text: string;
  ordinal: number;
};

type ExtractedContentPayload = {
  mainText: string;
  chunks: ExtractedContentChunk[];
};

export async function extractContentStructure(tabId: number): Promise<ExtractedContentPayload> {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const MAX_CHUNK_SIZE = 1800;

      function selectContentRoot(): HTMLElement | null {
        const preferredSelectors = ["article", "main", "[role='main']", "#content", ".post", ".entry"];
        for (const selector of preferredSelectors) {
          const element = document.querySelector(selector);
          if (element && element.textContent && element.textContent.trim().length > 400) {
            return element as HTMLElement;
          }
        }

        const paragraphs = Array.from(document.querySelectorAll("p"));
        if (paragraphs.length === 0) return null;

        const parentScores = new Map<HTMLElement, number>();
        for (const p of paragraphs) {
          const parent = p.closest("section, article, main, div");
          if (!parent) continue;
          const score = parentScores.get(parent as HTMLElement) ?? 0;
          parentScores.set(parent as HTMLElement, score + (p.textContent?.trim().length ?? 0));
        }

        let bestParent: HTMLElement | null = null;
        let bestScore = 0;
        parentScores.forEach((score, parent) => {
          if (score > bestScore) {
            bestParent = parent;
            bestScore = score;
          }
        });

        return bestParent;
      }

      function sanitizeText(text: string) {
        return text.replace(/\s+/g, " ").trim();
      }

      function chunkByHeadings(root: HTMLElement) {
        const chunks: { title: string; text: string }[] = [];
        let currentTitle = "";
        let buffer: string[] = [];

        const pushChunk = () => {
          const combined = sanitizeText(buffer.join(" "));
          if (combined.length > 120) {
            chunks.push({ title: currentTitle || "Section", text: combined });
          }
          buffer = [];
        };

        const headingTags = new Set(["H1", "H2", "H3"]);
        for (const child of Array.from(root.children)) {
          if (headingTags.has(child.tagName)) {
            if (buffer.length) pushChunk();
            currentTitle = sanitizeText(child.textContent ?? "");
          } else {
            const text = sanitizeText(child.textContent ?? "");
            if (text.length > 0) {
              buffer.push(text);
            }
          }
        }

        if (buffer.length) {
          pushChunk();
        }

        if (chunks.length === 0) {
          const fallback = sanitizeText(root.textContent ?? "");
          const parts: { title: string; text: string }[] = [];
          for (let i = 0; i < fallback.length; i += MAX_CHUNK_SIZE) {
            const slice = fallback.slice(i, i + MAX_CHUNK_SIZE).trim();
            if (slice) {
              parts.push({ title: `Part ${(i / MAX_CHUNK_SIZE) + 1}`, text: slice });
            }
          }
          return parts;
        }

        const normalized: { title: string; text: string }[] = [];
        chunks.forEach((chunk) => {
          if (chunk.text.length <= MAX_CHUNK_SIZE) {
            normalized.push(chunk);
          } else {
            for (let i = 0; i < chunk.text.length; i += MAX_CHUNK_SIZE) {
              const piece = chunk.text.slice(i, i + MAX_CHUNK_SIZE).trim();
              if (piece) {
                normalized.push({ title: chunk.title, text: piece });
              }
            }
          }
        });

        return normalized;
      }

      const root = selectContentRoot();
      const mainText = sanitizeText((root ?? document.body).innerText ?? "").slice(0, 10000);
      const chunkSources = root ? chunkByHeadings(root) : [];

      return {
        mainText,
        chunks: chunkSources.map((chunk, index) => ({
          title: chunk.title || `Section ${index + 1}`,
          text: chunk.text,
          ordinal: index,
        })),
      };
    },
  });

  if (!result) {
    return { mainText: "", chunks: [] };
  }

  return result as ExtractedContentPayload;
}
