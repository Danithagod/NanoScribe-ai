import type {
  ContentChunkRecord,
  MemoryRecord,
  MemoryStructuredSummary,
  MemorySummarySection,
  SessionGroup
} from "../types";
import { generateKeyPointSummary } from "./summarizer";
import { generateJsonFromPrompt, isLanguageModelReady } from "./language-model";

export function sanitizeKeyPointsText(keyPoints: string): string {
  return keyPoints
    .split(/\n+/)
    .map((line) => line.replace(/^[-•\s]+/, "").trim())
    .filter(Boolean)
    .join("\n");
}

// Extend IndexedDB types to include oldVersion property
declare global {
  interface IDBOpenDBRequest {
    oldVersion: number;
  }
}

const DATABASE_NAME = "nanoscribe-memories";
const DATABASE_VERSION = 5; // Incremented for keywords index support
const STORE_NAME = "memories";
const CHUNK_STORE_NAME = "contentChunks";
const KEYWORD_INDEX_NAME = "by-keyword";

type MemoryDraft = Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">;
type ContentChunkDraft = {
  memoryId: string;
  sessionId: string;
  chunkTitle?: string;
  rawText: string;
  keyPoints: string;
  keywords: string[];
  ordinal: number;
  sourceTag?: string;
};

type SummaryConvertibleChunk = Pick<ContentChunkRecord, "ordinal" | "chunkTitle" | "rawText"> & {
  keyPoints?: string;
};

export function buildStructuredSummary(
  chunks: SummaryConvertibleChunk[],
  fallbackOverview: string
): MemoryStructuredSummary {
  const normalizedFallback = fallbackOverview?.trim() ?? "";

  const sections: MemorySummarySection[] = chunks
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .slice(0, 12)
    .map((chunk) => {
      const keyPoints = sanitizeKeyPointsText(chunk.keyPoints ?? "");
      const derivedTitle = chunk.chunkTitle?.trim() || `Section ${chunk.ordinal + 1}`;
      const fallbackPoints = chunk.rawText.slice(0, 280).trim();
      const resolvedKeyPoints = keyPoints || (fallbackPoints ? `- ${fallbackPoints}` : "");

      return {
        ordinal: chunk.ordinal,
        title: derivedTitle,
        keyPoints: resolvedKeyPoints,
        charCount: chunk.rawText.length,
      } satisfies MemorySummarySection;
    })
    .filter((section) => section.keyPoints.length > 0);

  const overview = sections.length
    ? sections
        .slice(0, 5)
        .flatMap((section) => section.keyPoints.split(/\n+/).map((line) => line.trim()).filter(Boolean))
        .map((line) => (line.startsWith("-") ? line : `- ${line}`))
        .join("\n")
    : "";

  return {
    overview: overview || (normalizedFallback ? normalizedFallback : "- No summary available"),
    sections,
  } satisfies MemoryStructuredSummary;
}

const AI_ORGANIZE_MAX_MEMORIES = 12;
const AI_SIMILARITY_THRESHOLD = 0.4;
const AI_KEYWORD_SYSTEM_PROMPT = `You are an assistant helping organize saved web memories. Analyze the provided memory title and summary and return a concise JSON object with a \\"keywords\\" array containing 2-4 lowercase topic keywords (single or short compound words). Respond ONLY with JSON.`;
const AI_SESSION_NAME_SYSTEM_PROMPT = `You are naming a group of related saved web memories. Given the combined keywords and the first memory title, return JSON with a single field \\"name\\" containing a concise 3-6 word session title. Avoid punctuation except hyphens. Respond ONLY with JSON.`;

let databasePromise: Promise<IDBDatabase> | null = null;

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "to",
  "in",
  "of",
  "for",
  "on",
  "with",
  "as",
  "it",
  "this",
  "that",
]);

export function extractKeywordsFromText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\n\W]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .filter((value, index, array) => array.indexOf(value) === index);
}

function collapseGeneratedTitle(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return "";
  }

  return cleaned.length > 64 ? `${cleaned.slice(0, 61)}…` : cleaned;
}

async function generateSessionTitleFromContent(
  sessionId: string,
  sessionMemories: MemoryRecord[],
  chunksBySession: Map<string, ContentChunkRecord[]>
): Promise<string | undefined> {
  if (!sessionMemories.length) {
    return undefined;
  }

  const sessionChunks = chunksBySession.get(sessionId) ?? [];
  const contentSamples: string[] = [];

  if (sessionChunks.length > 0) {
    const sortedChunks = [...sessionChunks].sort((a, b) => b.createdAt - a.createdAt);
    for (const chunk of sortedChunks.slice(0, 4)) {
      const keyPoints = sanitizeKeyPointsText(chunk.keyPoints ?? "");
      if (keyPoints) {
        contentSamples.push(keyPoints);
      } else if (chunk.rawText) {
        contentSamples.push(chunk.rawText.slice(0, 400));
      }
    }
  }

  if (contentSamples.length < 2) {
    for (const memory of sessionMemories.slice(0, 3)) {
      if (memory.summary) {
        contentSamples.push(memory.summary);
      }
    }
  }

  if (contentSamples.length === 0) {
    for (const memory of sessionMemories.slice(0, 3)) {
      if (memory.title) {
        contentSamples.push(memory.title);
      }
    }
  }

  if (contentSamples.length === 0) {
    return undefined;
  }

  const payload = contentSamples.join("\n").slice(0, 2000);
  try {
    const summary = await generateKeyPointSummary(payload);
    if (!summary) {
      return undefined;
    }

    const candidateLines = summary
      .split(/\n+/)
      .map((line) => line.replace(/^[-•\s]+/, "").trim())
      .filter(Boolean);

    if (!candidateLines.length) {
      return undefined;
    }

    return collapseGeneratedTitle(candidateLines[0]);
  } catch (error) {
    console.warn(`[NanoScribe::Memory] ⚠️ Failed to auto-generate title for session ${sessionId}:`, error);
    return undefined;
  }
}

// Force database upgrade by resetting and reopening
export async function forceDatabaseUpgrade(): Promise<{ success: boolean; message: string }> {
  console.log("[NanoScribe::Memory] 🔄 Forcing database upgrade...");

  try {
    await resetDatabase();
    console.log("[NanoScribe::Memory] ✅ Database reset complete, reopening...");

    // Opening database will trigger the upgrade to the latest version
    await openDatabase();
    console.log("[NanoScribe::Memory] ✅ Database upgrade completed successfully");
    return { success: true, message: "Database upgrade completed successfully" };
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ Database upgrade failed:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function resetDatabase(currentDb?: IDBDatabase): Promise<void> {
  if (currentDb) {
    currentDb.close();
  } else if (databasePromise) {
    databasePromise
      .then((db) => db.close())
      .catch(() => undefined);
  }

  databasePromise = null;

  await new Promise<void>((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase(DATABASE_NAME);
    deleteRequest.onsuccess = () => resolve();
    deleteRequest.onerror = () => reject(deleteRequest.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  console.log("[NanoScribe::Memory] 🔍 openDatabase() CALLED");

  if (databasePromise) {
    console.log("[NanoScribe::Memory] ✅ Using existing database promise");
    return databasePromise;
  }

  console.log("[NanoScribe::Memory] 🔄 Creating new database promise...");
  databasePromise = new Promise((resolve, reject) => {
    console.log("[NanoScribe::Memory] 🔄 Creating IndexedDB.open() request...");
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      console.log("[NanoScribe::Memory] 🔄 Database upgrade needed");
      const db = request.result;

      const oldVersion = request.oldVersion || 0;

      if (oldVersion < 1) {
        console.log("[NanoScribe::Memory] 🔄 Creating memories store...");
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("by-url", "url", { unique: true });
          store.createIndex("by-createdAt", "createdAt", { unique: false });
        }
      }

      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          console.log("[NanoScribe::Memory] 🔄 Creating content chunks store...");
          const chunkStore = db.createObjectStore(CHUNK_STORE_NAME, { keyPath: "id" });
          chunkStore.createIndex("by-memoryId", "memoryId", { unique: false });
          chunkStore.createIndex("by-createdAt", "createdAt", { unique: false });
          chunkStore.createIndex(KEYWORD_INDEX_NAME, "keywords", { unique: false, multiEntry: true });
        }
      }

      if (oldVersion < 3) {
        console.log("[NanoScribe::Memory] 🔄 Creating compound index for sessionId-createdAt...");

        if (db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          const chunkStore = request.transaction.objectStore(CHUNK_STORE_NAME);

          // Check if index already exists before creating
          if (!chunkStore.indexNames.contains("by-sessionId-createdAt")) {
            chunkStore.createIndex("by-sessionId-createdAt", ["sessionId", "createdAt"], { unique: false });
            console.log("[NanoScribe::Memory] ✅ Compound index created successfully");
          } else {
            console.log("[NanoScribe::Memory] ✅ Compound index already exists");
          }
        } else {
          console.warn("[NanoScribe::Memory] ⚠️ Chunk store not available for compound index creation");
        }
      }

      if (oldVersion < 4) {
        console.log("[NanoScribe::Memory] 🔄 Database upgrade to v4 - adding sourceTag support");
        // Check if we need to add the compound index (for databases that skipped v3)
        if (db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          const chunkStore = request.transaction.objectStore(CHUNK_STORE_NAME);
          if (!chunkStore.indexNames.contains("by-sessionId-createdAt")) {
            chunkStore.createIndex("by-sessionId-createdAt", ["sessionId", "createdAt"], { unique: false });
            console.log("[NanoScribe::Memory] ✅ Compound index created for v4 upgrade");
          }
        }
        // No schema changes needed since sourceTag is optional and has a default value
      }

      if (oldVersion < 5) {
        console.log("[NanoScribe::Memory] 🔄 Database upgrade to v5 - adding keyword index");
        if (db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          const chunkStore = request.transaction.objectStore(CHUNK_STORE_NAME);
          if (!chunkStore.indexNames.contains(KEYWORD_INDEX_NAME)) {
            chunkStore.createIndex(KEYWORD_INDEX_NAME, "keywords", { unique: false, multiEntry: true });
            console.log("[NanoScribe::Memory] ✅ Keyword index created");
          }

          // Clearing existing chunks ensures we rebuild keyword metadata consistently
          chunkStore.clear();
          console.log("[NanoScribe::Memory] ⚠️ Cleared existing chunks during v5 upgrade; they will be regenerated on revisit");
        }
      }
    };

    request.onsuccess = () => {
      console.log("[NanoScribe::Memory] ✅ IndexedDB opened successfully");
      const db = request.result;

      // Check if we have the minimum required stores
      const hasMemoryStore = db.objectStoreNames.contains(STORE_NAME);

      if (!hasMemoryStore) {
        console.log("[NanoScribe::Memory] ⚠️ Memory store missing, resetting database...");
        resetDatabase(db)
          .then(() => openDatabase().then(resolve, reject))
          .catch(reject);
        return;
      }

      db.onversionchange = () => {
        console.log("[NanoScribe::Memory] 🔄 Database version changed, closing...");
        db.close();
      };
      resolve(db);
    };
    request.onerror = () => {
      console.error("[NanoScribe::Memory] ❌ IndexedDB open failed:", request.error);
      reject(request.error);
    };
  });

  return databasePromise;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  console.log("[NanoScribe::Memory] 🔄 promisifyRequest() CALLED for", request);

  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      console.log("[NanoScribe::Memory] ✅ IDB request succeeded");
      resolve(request.result);
    };
    request.onerror = () => {
      console.error("[NanoScribe::Memory] ❌ IDB request failed:", request.error);
      reject(request.error);
    };
  });
}

async function getStore(mode: IDBTransactionMode = "readonly") {
  console.log("[NanoScribe::Memory] 🔍 getStore() CALLED with mode:", mode);

  try {
    console.log("[NanoScribe::Memory] 🔍 Calling openDatabase()...");
    const db = await openDatabase();
    console.log("[NanoScribe::Memory] ✅ Database opened successfully");

    console.log("[NanoScribe::Memory] 🔍 Creating transaction...");
    const transaction = db.transaction(STORE_NAME, mode);
    console.log("[NanoScribe::Memory] ✅ Transaction created");

    const store = transaction.objectStore(STORE_NAME);
    console.log("[NanoScribe::Memory] ✅ Store obtained");

    return { transaction, store };
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ getStore() failed:", error);
    if (error instanceof DOMException && error.name === "NotFoundError") {
      console.log("[NanoScribe::Memory] 🔄 Database not found, resetting...");
      await resetDatabase();
      console.log("[NanoScribe::Memory] ✅ Database reset, retrying...");
      const db = await openDatabase();
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      return { transaction, store };
    }
    throw error;
  }
}

export async function addOrUpdateMemory(draft: MemoryDraft): Promise<MemoryRecord> {
  const { store, transaction } = await getStore("readwrite");
  const urlIndex = store.index("by-url");

  const existing = await promisifyRequest<IDBValidKey | undefined>(urlIndex.getKey(draft.url));
  const now = Date.now();

  const record: MemoryRecord = existing
    ? {
        ...(await promisifyRequest<MemoryRecord>(store.get(existing))),
        ...draft,
        updatedAt: now,
      }
    : {
        id: crypto.randomUUID(),
        ...draft,
        createdAt: now,
        updatedAt: now,
      };

  await promisifyRequest(store.put(record));
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });

  return record;
}

export async function getAllMemories(): Promise<MemoryRecord[]> {
  console.log("[NanoScribe::Memory] 🔍 getAllMemories() CALLED");

  try {
    console.log("[NanoScribe::Memory] 🔍 Opening database and getting store...");
    const { store } = await getStore("readonly");
    console.log("[NanoScribe::Memory] ✅ Store obtained, getting all records...");

    const request = store.index("by-createdAt").getAll();
    console.log("[NanoScribe::Memory] 🔄 IndexedDB getAll() request created, waiting for results...");

    const results = await promisifyRequest(request);
    console.log("[NanoScribe::Memory] ✅ IndexedDB request completed, got", results.length, "records");

    const sorted = results.sort((a, b) => b.createdAt - a.createdAt);
    console.log("[NanoScribe::Memory] ✅ Records sorted, returning", sorted.length, "memories");
    return sorted;
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ getAllMemories() failed:", error);
    throw error;
  }
}

export async function searchMemories(query: string): Promise<MemoryRecord[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return getAllMemories();
  }

  const normalized = trimmed.toLowerCase();
  const all = await getAllMemories();
  return all.filter((memory) => {
    const structuredText = memory.structuredSummary
      ? `${memory.structuredSummary.overview} ${memory.structuredSummary.sections
          .map((section) => section.keyPoints)
          .join(" ")}`
      : "";
    const haystack = `${memory.title} ${memory.summary} ${structuredText} ${memory.url}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export async function getMemoryByUrl(url: string): Promise<MemoryRecord | undefined> {
  const { store } = await getStore("readonly");
  const index = store.index("by-url");
  const key = await promisifyRequest<IDBValidKey | undefined>(index.getKey(url));
  if (key === undefined) return undefined;
  return promisifyRequest<MemoryRecord>(store.get(key));
}

async function getChunkStore(mode: IDBTransactionMode = "readonly") {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(CHUNK_STORE_NAME, mode);
    const store = transaction.objectStore(CHUNK_STORE_NAME);
    return { transaction, store };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      await resetDatabase();
      const db = await openDatabase();
      const transaction = db.transaction(CHUNK_STORE_NAME, mode);
      const store = transaction.objectStore(CHUNK_STORE_NAME);
      return { transaction, store };
    }
    throw error;
  }
}

export async function getRecentChunksBySession(sessionId: string, limit: number = 10): Promise<ContentChunkRecord[]> {
  const { store } = await getChunkStore("readonly");

  try {
    // Try to use the new compound index (available after database upgrade to v3)
    const compoundIndex = store.index("by-sessionId-createdAt");
    console.log("[NanoScribe::Memory] 🔍 Using compound index for session query");

    // Query using compound key range: [sessionId, minTime] to [sessionId, maxTime]
    // This efficiently finds all chunks for the session without needing to scan all records
    const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
    const chunks = await promisifyRequest<ContentChunkRecord[]>(compoundIndex.getAll(range, limit));

    // The index already returns results sorted by [sessionId, createdAt], so no additional sorting needed
    console.log(`[NanoScribe::Memory] ✅ Found ${chunks.length} chunks using compound index`);
    return chunks;
  } catch (error) {
    // Fallback: compound index doesn't exist yet (database needs upgrade)
    console.warn("[NanoScribe::Memory] ⚠️ Compound index not available, falling back to JavaScript filtering:", error);

    try {
      // Use the simple createdAt index and filter in JavaScript
      const simpleIndex = store.index("by-createdAt");
      const allChunks = await promisifyRequest<ContentChunkRecord[]>(simpleIndex.getAll());

      // Filter chunks by sessionId and limit results
      const sessionChunks = allChunks
        .filter(chunk => chunk.sessionId === sessionId)
        .sort((a, b) => b.createdAt - a.createdAt) // Sort by creation time descending
        .slice(0, limit);

      console.log(`[NanoScribe::Memory] ✅ Found ${sessionChunks.length} chunks using fallback filtering`);
      return sessionChunks;
    } catch (fallbackError) {
      console.error("[NanoScribe::Memory] ❌ Both compound index and fallback failed:", fallbackError);
      throw fallbackError;
    }
  }
}

export async function getAllChunks(limit: number = 1000): Promise<ContentChunkRecord[]> {
  const { store } = await getChunkStore("readonly");

  try {
    // Use the createdAt index to get all chunks
    const index = store.index("by-createdAt");
    const allChunks = await promisifyRequest<ContentChunkRecord[]>(index.getAll(undefined, limit));

    // Sort by creation time descending (newest first)
    return allChunks.sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ Failed to get all chunks:", error);
    throw error;
  }
}

export async function getChunksByKeywords(queryKeywords: string[], limit: number = 50, fallbackQuery?: string): Promise<ContentChunkRecord[]> {
  if (!queryKeywords.length && !fallbackQuery) {
    return [];
  }

  const { store } = await getChunkStore("readonly");
  const seen = new Set<string>();
  const results: ContentChunkRecord[] = [];

  try {
    if (queryKeywords.length) {
      const keywordIndex = store.index(KEYWORD_INDEX_NAME);
      for (const keyword of queryKeywords) {
        const matches = await promisifyRequest<ContentChunkRecord[]>(keywordIndex.getAll(keyword));
        for (const match of matches) {
          if (seen.has(match.id)) {
            continue;
          }
          results.push(match);
          seen.add(match.id);
          if (results.length >= limit) {
            return results;
          }
        }
      }
    }
  } catch (error) {
    console.warn("[NanoScribe::Memory] ⚠️ Keyword index lookup failed, falling back to text search", error);
  }

  if (results.length >= limit) {
    return results.slice(0, limit);
  }

  // Fallback: scan chunks by createdAt order and match against fallback query/keywords
  const fallbackText = (fallbackQuery ?? queryKeywords.join(" ")).toLowerCase();
  if (!fallbackText) {
    return results;
  }

  const createdAtIndex = store.index("by-createdAt");
  const allChunks = await promisifyRequest<ContentChunkRecord[]>(createdAtIndex.getAll());
  for (const chunk of allChunks) {
    if (seen.has(chunk.id)) {
      continue;
    }
    const haystack = `${chunk.keyPoints} ${chunk.rawText}`.toLowerCase();
    if (haystack.includes(fallbackText)) {
      results.push(chunk);
      seen.add(chunk.id);
      if (results.length >= limit) {
        break;
      }
    }
  }

  return results.slice(0, limit);
}

export async function getMemoriesByIds(ids: string[]): Promise<MemoryRecord[]> {
  if (ids.length === 0) {
    return [];
  }

  const uniqueIds = Array.from(new Set(ids));
  const { store } = await getStore("readonly");
  const records: MemoryRecord[] = [];

  for (const id of uniqueIds) {
    const record = await promisifyRequest<MemoryRecord | undefined>(store.get(id));
    if (record) {
      records.push(record);
    }
  }

  return records;
}

// Get memories grouped by sessions
export async function getMemoriesGroupedBySessions(): Promise<SessionGroup[]> {
  console.log("[NanoScribe::Memory] 🔍 getMemoriesGroupedBySessions() CALLED");

  try {
    // Get all memories
    const memories = await getAllMemories();

    // Get all chunks to determine session activity
    const allChunks = await getAllChunks();

    const chunksBySession = new Map<string, ContentChunkRecord[]>();
    const chunksByMemory = new Map<string, ContentChunkRecord[]>();

    // Group chunks by sessionId and find last activity per session
    const sessionActivity = new Map<string, number>();
    for (const chunk of allChunks) {
      const currentLastActivity = sessionActivity.get(chunk.sessionId) || 0;
      sessionActivity.set(chunk.sessionId, Math.max(currentLastActivity, chunk.createdAt));

      if (!chunksBySession.has(chunk.sessionId)) {
        chunksBySession.set(chunk.sessionId, []);
      }
      chunksBySession.get(chunk.sessionId)!.push(chunk);

      if (!chunksByMemory.has(chunk.memoryId)) {
        chunksByMemory.set(chunk.memoryId, []);
      }
      chunksByMemory.get(chunk.memoryId)!.push(chunk);
    }

    // Group memories by their associated chunks' sessionId
    const memoriesBySession = new Map<string, MemoryRecord[]>();

    // For each memory, find its chunks and determine which session it belongs to
    for (const memory of memories) {
      const memoryChunks = chunksByMemory.get(memory.id) ?? [];
      if (memoryChunks.length > 0) {
        // Use the session from the most recent chunk
        const mostRecentChunk = memoryChunks.sort((a, b) => b.createdAt - a.createdAt)[0];
        const sessionId = mostRecentChunk.sessionId;

        if (!memoriesBySession.has(sessionId)) {
          memoriesBySession.set(sessionId, []);
        }
        memoriesBySession.get(sessionId)!.push(memory);
      } else {
        // Memory has no chunks, put it in a fallback "no-session" group
        const noSessionId = "no-session";
        if (!memoriesBySession.has(noSessionId)) {
          memoriesBySession.set(noSessionId, []);
        }
        memoriesBySession.get(noSessionId)!.push(memory);
      }
    }

    const sessionTitleEntries = await chrome.storage.local.get({ sessionTitles: {} as Record<string, string> });
    const sessionTitles: Record<string, string> = { ...(sessionTitleEntries.sessionTitles ?? {}) };

    const generatedTitles: Record<string, string> = {};

    // Convert to SessionGroup array, sorted by most recent session activity
    const sessionGroups: SessionGroup[] = Array.from(memoriesBySession.entries())
      .map(([sessionId, groupedMemories]) => {
        // Sort memories within session by creation time (newest first)
        groupedMemories.sort((a, b) => b.createdAt - a.createdAt);

        const lastActivity =
          sessionId === "no-session"
            ? Math.max(...groupedMemories.map((m) => m.createdAt))
            : sessionActivity.get(sessionId) || Math.max(...groupedMemories.map((m) => m.createdAt));

        return {
          sessionId,
          lastActivity,
          memoryCount: groupedMemories.length,
          memories: groupedMemories,
          title: sessionTitles[sessionId],
        } satisfies SessionGroup;
      })
      // Sort sessions by last activity (newest first)
      .sort((a, b) => b.lastActivity - a.lastActivity);

    for (const session of sessionGroups) {
      if (session.title || session.sessionId === "no-session" || session.sessionId === "search-results") {
        continue;
      }

      const generated = await generateSessionTitleFromContent(
        session.sessionId,
        session.memories,
        chunksBySession
      );

      if (generated) {
        session.title = generated;
        sessionTitles[session.sessionId] = generated;
        generatedTitles[session.sessionId] = generated;
      }
    }

    if (Object.keys(generatedTitles).length > 0) {
      await chrome.storage.local.set({ sessionTitles });
    }

    console.log(`[NanoScribe::Memory] ✅ Grouped ${memories.length} memories into ${sessionGroups.length} sessions`);
    return sessionGroups;
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ getMemoriesGroupedBySessions() failed:", error);
    throw error;
  }
}

type KeywordExtractionResult = { keywords?: string[] };
type SessionNameResult = { name?: string };

// AI semantic organization for unorganized memories
export async function aiOrganizeUnorganizedMemories(): Promise<{ organized: number; failed: number; total: number }> {
  console.log("[NanoScribe::Memory] 🤖 aiOrganizeUnorganizedMemories() CALLED");

  try {
    if (!(await isLanguageModelReady())) {
      console.log("[NanoScribe::Memory] ⚠️ Language model not ready, falling back to auto organization");
      return autoOrganizeUnorganizedMemories();
    }

    const [allMemories, allChunks] = await Promise.all([getAllMemories(), getAllChunks()]);

    const unorganizedMemories = allMemories.filter((memory) =>
      !allChunks.some((chunk) => chunk.memoryId === memory.id)
    );

    console.log(`[NanoScribe::Memory] 📊 Found ${unorganizedMemories.length} unorganized memories for AI organization`);

    if (unorganizedMemories.length === 0) {
      return { organized: 0, failed: 0, total: 0 };
    }

    let organized = 0;
    let failed = 0;

    const batches: MemoryRecord[][] = [];
    for (let i = 0; i < unorganizedMemories.length; i += AI_ORGANIZE_MAX_MEMORIES) {
      batches.push(unorganizedMemories.slice(i, i + AI_ORGANIZE_MAX_MEMORIES));
    }

    for (const [batchIndex, batchMemories] of batches.entries()) {
      console.log(`[NanoScribe::Memory] 🔄 Processing AI batch ${batchIndex + 1}/${batches.length} (${batchMemories.length} memories)`);

      const memoryKeywords = new Map<string, string[]>();

      for (const memory of batchMemories) {
        try {
          const keywords = await extractKeywordsForMemory(memory);
          memoryKeywords.set(memory.id, keywords);
          console.log(`[NanoScribe::Memory] ✅ Keywords for "${memory.title}":`, keywords);
        } catch (error) {
          console.error(`[NanoScribe::Memory] ❌ Keyword extraction failed for "${memory.title}":`, error);
          memoryKeywords.set(memory.id, fallbackKeywordsFromMemory(memory));
        }
      }

      const processedIds = new Set<string>();
      const groupSeeds = [...batchMemories];

      for (const memory of groupSeeds) {
        if (processedIds.has(memory.id)) {
          continue;
        }

        const currentKeywords = memoryKeywords.get(memory.id) ?? fallbackKeywordsFromMemory(memory);
        const groupedMemories: MemoryRecord[] = [memory];
        processedIds.add(memory.id);

        for (const candidate of groupSeeds) {
          if (processedIds.has(candidate.id) || candidate.id === memory.id) {
            continue;
          }

          const candidateKeywords = memoryKeywords.get(candidate.id) ?? fallbackKeywordsFromMemory(candidate);
          const similarity = calculateKeywordSimilarity(currentKeywords, candidateKeywords);

          if (similarity >= AI_SIMILARITY_THRESHOLD) {
            groupedMemories.push(candidate);
            processedIds.add(candidate.id);
            console.log(`[NanoScribe::Memory] 🔗 Grouped "${candidate.title}" with "${memory.title}" (similarity ${(similarity * 100).toFixed(0)}%)`);
          }
        }

        try {
          const sessionId = await createAiSession(groupedMemories, memoryKeywords);
          const chunkDrafts = groupedMemories.map((groupMemory, index) => {
            const keywords = memoryKeywords.get(groupMemory.id) ?? fallbackKeywordsFromMemory(groupMemory);
            const keyPoints = keywords.length > 0
              ? `- ${keywords.join("\n- ")}`
              : groupMemory.summary
                ? `- ${groupMemory.summary.split(/[.!?]\s+/).slice(0, 3).join("\n- ")}`
                : "- AI organized memory";

            return {
              memoryId: groupMemory.id,
              sessionId,
              chunkTitle: "AI-organized",
              rawText: groupMemory.summary || "AI-organized memory",
              keyPoints,
              keywords: extractKeywordsFromText(`${groupMemory.title} ${groupMemory.summary ?? ""}`),
              ordinal: index,
              sourceTag: "ai-organized",
            } as ContentChunkDraft;
          });

          await addContentChunks(chunkDrafts);
          organized += chunkDrafts.length;
          console.log(`[NanoScribe::Memory] ✅ Organized ${chunkDrafts.length} memories into session ${sessionId}`);
        } catch (groupError) {
          console.error(`[NanoScribe::Memory] ❌ Failed to organize group seeded by "${memory.title}":`, groupError);
          failed += groupedMemories.length;
        }
      }
    }

    console.log(`[NanoScribe::Memory] ✅ AI organization complete: ${organized} organized, ${failed} failed, ${unorganizedMemories.length} total`);
    return { organized, failed, total: unorganizedMemories.length };
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ aiOrganizeUnorganizedMemories() failed, falling back to auto organization:", error);
    return autoOrganizeUnorganizedMemories();
  }
}

async function extractKeywordsForMemory(memory: MemoryRecord): Promise<string[]> {
  const summary = memory.summary?.slice(0, 400) ?? "";
  const userPrompt = `Title: ${memory.title}\nSummary: ${summary || "(no summary available)"}\nURL: ${memory.url}\n\nReturn JSON now.`;

  const response = await generateJsonFromPrompt<KeywordExtractionResult>({
    systemPrompt: AI_KEYWORD_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.2,
    topK: 4,
    timeoutMs: 20000,
  });

  const keywords = response?.keywords?.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean) ?? [];

  if (keywords.length > 0) {
    return Array.from(new Set(keywords)).slice(0, 6);
  }

  return fallbackKeywordsFromMemory(memory);
}

function fallbackKeywordsFromMemory(memory: MemoryRecord): string[] {
  const tokens = `${memory.title} ${memory.summary ?? ""}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && token.length < 20);

  const unique = Array.from(new Set(tokens));
  return unique.slice(0, 5);
}

function calculateKeywordSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const setA = new Set(a);
  const setB = new Set(b);

  const intersection = new Set([...setA].filter((keyword) => setB.has(keyword)));
  const union = new Set([...setA, ...setB]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

async function createAiSession(memories: MemoryRecord[], keywordMap: Map<string, string[]>): Promise<string> {
  if (memories.length === 0) {
    return `ai-group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const primaryMemory = memories[0];
  const keywordSet = new Set<string>();

  for (const memory of memories) {
    const keywords = keywordMap.get(memory.id) ?? fallbackKeywordsFromMemory(memory);
    keywords.forEach((keyword) => keywordSet.add(keyword));
  }

  const keywordList = Array.from(keywordSet).slice(0, 10).join(", ");
  const userPrompt = `Keywords: ${keywordList || "(none)"}\nFirst memory title: ${primaryMemory.title}\n\nReturn JSON now.`;

  const response = await generateJsonFromPrompt<SessionNameResult>({
    systemPrompt: AI_SESSION_NAME_SYSTEM_PROMPT,
    userPrompt,
    temperature: 0.3,
    topK: 4,
    timeoutMs: 20000,
  });

  const sessionName = response?.name?.trim();

  if (sessionName && sessionName.length > 0) {
    const slug = sessionName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);

    if (slug.length > 0) {
      return `ai-${slug}-${Date.now()}`;
    }
  }

  return `ai-group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Auto-organize unorganized memories by linking them to appropriate sessions
export async function autoOrganizeUnorganizedMemories(): Promise<{ organized: number; failed: number; total: number }> {
  console.log("[NanoScribe::Memory] 🔄 autoOrganizeUnorganizedMemories() CALLED");

  try {
    // Get all memories and chunks
    const allMemories = await getAllMemories();
    const allChunks = await getAllChunks();

    // Find unorganized memories (those without chunks)
    const unorganizedMemories = allMemories.filter(memory =>
      !allChunks.some(chunk => chunk.memoryId === memory.id)
    );

    console.log(`[NanoScribe::Memory] 📊 Found ${unorganizedMemories.length} unorganized memories`);

    if (unorganizedMemories.length === 0) {
      return { organized: 0, failed: 0, total: 0 };
    }

    // Get existing sessions and their activity patterns
    const sessionDomains = new Map<string, Set<string>>();
    const sessionTimestamps = new Map<string, number[]>();

    for (const chunk of allChunks) {
      const sessionId = chunk.sessionId;
      const memory = allMemories.find(m => m.id === chunk.memoryId);

      if (memory) {
        try {
          const url = new URL(memory.url);
          const domain = url.hostname;

          if (!sessionDomains.has(sessionId)) {
            sessionDomains.set(sessionId, new Set());
          }
          sessionDomains.get(sessionId)!.add(domain);

          if (!sessionTimestamps.has(sessionId)) {
            sessionTimestamps.set(sessionId, []);
          }
          sessionTimestamps.get(sessionId)!.push(memory.createdAt);
        } catch (error) {
          // Skip invalid URLs
          console.debug("[NanoScribe::Memory] Skipping invalid URL:", memory.url);
        }
      }
    }

    let organized = 0;
    let failed = 0;

    // Process each unorganized memory
    for (const memory of unorganizedMemories) {
      try {
        const memoryUrl = new URL(memory.url);
        const memoryDomain = memoryUrl.hostname;
        const memoryTimestamp = memory.createdAt;

        // Find best matching session
        let bestSessionId: string | null = null;
        let bestScore = 0;

        for (const [sessionId, domains] of sessionDomains.entries()) {
          let score = 0;

          // Domain match bonus
          if (domains.has(memoryDomain)) {
            score += 100;
          }

          // Time proximity bonus (within 1 hour = 50 points, within 24 hours = 20 points)
          const sessionTimes = sessionTimestamps.get(sessionId) || [];
          if (sessionTimes.length > 0) {
            const avgSessionTime = sessionTimes.reduce((a, b) => a + b, 0) / sessionTimes.length;
            const timeDiff = Math.abs(memoryTimestamp - avgSessionTime);

            if (timeDiff < 60 * 60 * 1000) { // Within 1 hour
              score += 50;
            } else if (timeDiff < 24 * 60 * 60 * 1000) { // Within 24 hours
              score += 20;
            }
          }

          if (score > bestScore) {
            bestScore = score;
            bestSessionId = sessionId;
          }
        }

        if (bestSessionId && bestScore > 20) { // Require minimum score
          // Create a chunk for this memory with the matched session
          const chunkDraft: ContentChunkDraft = {
            memoryId: memory.id,
            sessionId: bestSessionId,
            chunkTitle: "Auto-organized",
            rawText: memory.summary || "Auto-organized memory",
            keyPoints: memory.summary ? `- ${memory.summary.split(/[.!?]\s+/).slice(0, 3).join("\n- " )}` : "- Auto-organized memory",
            keywords: extractKeywordsFromText(`${memory.title} ${memory.summary ?? ""}`),
            ordinal: 0,
            sourceTag: "auto-organized"
          };

          await addContentChunks([chunkDraft]);
          organized++;

          console.log(`[NanoScribe::Memory] ✅ Auto-organized memory "${memory.title}" into session ${bestSessionId} (score: ${bestScore})`);
        } else {
          // Create a new session for this memory if no good match found
          const newSessionId = `auto-session-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          const chunkDraft: ContentChunkDraft = {
            memoryId: memory.id,
            sessionId: newSessionId,
            chunkTitle: "Auto-organized",
            rawText: memory.summary || "Auto-organized memory",
            keyPoints: memory.summary ? `- ${memory.summary.split(/[.!?]\s+/).slice(0, 3).join("\n- " )}` : "- Auto-organized memory",
            keywords: extractKeywordsFromText(`${memory.title} ${memory.summary ?? ""}`),
            ordinal: 0,
            sourceTag: "auto-organized-new-session"
          };

          await addContentChunks([chunkDraft]);
          organized++;

          console.log(`[NanoScribe::Memory] ✅ Created new session ${newSessionId} for memory "${memory.title}"`);
        }
      } catch (error) {
        console.error(`[NanoScribe::Memory] ❌ Failed to auto-organize memory "${memory.title}":`, error);
        failed++;
      }
    }

    console.log(`[NanoScribe::Memory] ✅ Auto-organization complete: ${organized} organized, ${failed} failed, ${unorganizedMemories.length} total`);
    return { organized, failed, total: unorganizedMemories.length };
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ autoOrganizeUnorganizedMemories() failed:", error);
    throw error;
  }
}

// Re-process unorganized memories by re-running content extraction
export async function reprocessUnorganizedMemories(): Promise<{ reprocessed: number; failed: number; total: number }> {
  console.log("[NanoScribe::Memory] 🔄 reprocessUnorganizedMemories() CALLED");

  try {
    // Get all memories and chunks
    const allMemories = await getAllMemories();
    const allChunks = await getAllChunks();

    // Find unorganized memories (those without chunks)
    const unorganizedMemories = allMemories.filter(memory =>
      !allChunks.some(chunk => chunk.memoryId === memory.id)
    );

    console.log(`[NanoScribe::Memory] 📊 Found ${unorganizedMemories.length} unorganized memories to reprocess`);

    if (unorganizedMemories.length === 0) {
      return { reprocessed: 0, failed: 0, total: 0 };
    }

    let reprocessed = 0;
    let failed = 0;

    // Process each unorganized memory
    for (const memory of unorganizedMemories) {
      try {
        // Attempt to create basic chunks from existing memory data
        // Since we can't re-run the full extraction pipeline without the original page,
        // we'll create basic chunks that at least organize the memory

        const sessionId = `reprocessed-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

        // Extract basic key points from the summary
        let keyPoints = "- Reprocessed memory";
        if (memory.summary) {
          const sentences = memory.summary.split(/[.!?]\s+/).filter(Boolean).slice(0, 5);
          keyPoints = sentences.length > 0 ? `- ${sentences.join("\n- ")}` : "- Reprocessed memory";
        }

        const baseText = `${memory.title} ${memory.summary ?? ""}`;
        const chunkDraft: ContentChunkDraft = {
          memoryId: memory.id,
          sessionId,
          chunkTitle: "Reprocessed",
          rawText: memory.summary || "Reprocessed memory content",
          keyPoints,
          keywords: extractKeywordsFromText(baseText),
          ordinal: 0,
          sourceTag: "reprocessed"
        };

        await addContentChunks([chunkDraft]);
        reprocessed++;

        console.log(`[NanoScribe::Memory] ✅ Reprocessed memory "${memory.title}" into new session ${sessionId}`);
      } catch (error) {
        console.error(`[NanoScribe::Memory] ❌ Failed to reprocess memory "${memory.title}":`, error);
        failed++;
      }
    }

    console.log(`[NanoScribe::Memory] ✅ Reprocessing complete: ${reprocessed} reprocessed, ${failed} failed, ${unorganizedMemories.length} total`);
    return { reprocessed, failed, total: unorganizedMemories.length };
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ reprocessUnorganizedMemories() failed:", error);
    throw error;
  }
}

// Clean up unorganized memories (delete them)
export async function cleanupUnorganizedMemories(): Promise<{ deleted: number; total: number }> {
  console.log("[NanoScribe::Memory] 🧹 cleanupUnorganizedMemories() CALLED");

  try {
    // Get all memories and chunks
    const allMemories = await getAllMemories();
    const allChunks = await getAllChunks();

    // Find unorganized memories (those without chunks)
    const unorganizedMemories = allMemories.filter(memory =>
      !allChunks.some(chunk => chunk.memoryId === memory.id)
    );

    console.log(`[NanoScribe::Memory] 📊 Found ${unorganizedMemories.length} unorganized memories to clean up`);

    if (unorganizedMemories.length === 0) {
      return { deleted: 0, total: 0 };
    }

    let deleted = 0;

    // Delete each unorganized memory
    for (const memory of unorganizedMemories) {
      try {
        await deleteMemory(memory.id);
        deleted++;
        console.log(`[NanoScribe::Memory] ✅ Deleted unorganized memory "${memory.title}"`);
      } catch (error) {
        console.error(`[NanoScribe::Memory] ❌ Failed to delete memory "${memory.title}":`, error);
      }
    }

    console.log(`[NanoScribe::Memory] ✅ Cleanup complete: ${deleted} deleted, ${unorganizedMemories.length} total`);
    return { deleted, total: unorganizedMemories.length };
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ cleanupUnorganizedMemories() failed:", error);
    throw error;
  }
}

export async function addContentChunks(chunks: ContentChunkDraft[]): Promise<void> {
  if (!chunks.length) return;

  const { store, transaction } = await getChunkStore("readwrite");

  for (const chunk of chunks) {
    const keywordSource = `${chunk.chunkTitle ?? ""} ${chunk.keyPoints ?? ""} ${chunk.rawText ?? ""}`;
    const record: ContentChunkRecord = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...chunk,
      keywords: chunk.keywords && chunk.keywords.length > 0 ? chunk.keywords : extractKeywordsFromText(keywordSource),
    };
    await promisifyRequest(store.put(record));
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function clearAllMemories(): Promise<void> {
  console.log("[NanoScribe::Memory] 🧹 clearAllMemories() CALLED");

  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME, CHUNK_STORE_NAME], "readwrite");

    const memoryStore = transaction.objectStore(STORE_NAME);
    const chunkStore = transaction.objectStore(CHUNK_STORE_NAME);

    // Clear both stores
    await promisifyRequest(memoryStore.clear());
    await promisifyRequest(chunkStore.clear());

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        console.log("[NanoScribe::Memory] ✅ All memories and chunks cleared successfully");
        resolve();
      };
      transaction.onerror = () => {
        console.error("[NanoScribe::Memory] ❌ Failed to clear memories:", transaction.error);
        reject(transaction.error);
      };
      transaction.onabort = () => {
        console.error("[NanoScribe::Memory] ❌ Transaction aborted:", transaction.error);
        reject(transaction.error);
      };
    });
  } catch (error) {
    console.error("[NanoScribe::Memory] ❌ clearAllMemories() failed:", error);
    throw error;
  }
}

export async function deleteMemory(memoryId: string): Promise<void> {
  console.log(`[NanoScribe::Memory] 🗑️ deleteMemory() CALLED for memory: ${memoryId}`);

  try {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_NAME, CHUNK_STORE_NAME], "readwrite");

    const memoryStore = transaction.objectStore(STORE_NAME);
    const chunkStore = transaction.objectStore(CHUNK_STORE_NAME);

    // Delete the memory record
    console.log(`[NanoScribe::Memory] 🔄 Deleting memory record: ${memoryId}`);
    await promisifyRequest(memoryStore.delete(memoryId));

    // Delete associated content chunks
    console.log(`[NanoScribe::Memory] 🔄 Deleting associated chunks for memory: ${memoryId}`);
    const chunkIndex = chunkStore.index("by-memoryId");
    const chunksToDelete = await promisifyRequest<IDBValidKey[]>(chunkIndex.getAllKeys(memoryId));

    console.log(`[NanoScribe::Memory] 📦 Found ${chunksToDelete.length} chunks to delete`);

    for (const chunkId of chunksToDelete) {
      await promisifyRequest(chunkStore.delete(chunkId));
    }

    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        console.log(`[NanoScribe::Memory] ✅ Memory ${memoryId} and ${chunksToDelete.length} chunks deleted successfully`);
        resolve();
      };
      transaction.onerror = () => {
        console.error("[NanoScribe::Memory] ❌ Failed to delete memory:", transaction.error);
        reject(transaction.error);
      };
      transaction.onabort = () => {
        console.error("[NanoScribe::Memory] ❌ Transaction aborted:", transaction.error);
        reject(transaction.error);
      };
    });
  } catch (error) {
    console.error(`[NanoScribe::Memory] ❌ deleteMemory() failed for ${memoryId}:`, error);
    throw error;
  }
}
