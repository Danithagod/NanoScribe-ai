import type { ContentChunkRecord, MemoryRecord } from "../types";

// Extend IndexedDB types to include oldVersion property
declare global {
  interface IDBOpenDBRequest {
    oldVersion: number;
  }
}

const DATABASE_NAME = "nanoscribe-memories";
const DATABASE_VERSION = 2;
const STORE_NAME = "memories";
const CHUNK_STORE_NAME = "contentChunks";

type MemoryDraft = Omit<MemoryRecord, "id" | "createdAt" | "updatedAt">;
type ContentChunkDraft = Omit<ContentChunkRecord, "id" | "createdAt">;

let databasePromise: Promise<IDBDatabase> | null = null;

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
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("by-url", "url", { unique: true });
        store.createIndex("by-createdAt", "createdAt", { unique: false });
      }

      if (oldVersion < 2) {
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          console.log("[NanoScribe::Memory] 🔄 Creating content chunks store...");
          const chunkStore = db.createObjectStore(CHUNK_STORE_NAME, { keyPath: "id" });
          chunkStore.createIndex("by-memoryId", "memoryId", { unique: false });
          chunkStore.createIndex("by-createdAt", "createdAt", { unique: false });
        }
      }
    };

    request.onsuccess = () => {
      console.log("[NanoScribe::Memory] ✅ IndexedDB opened successfully");
      const db = request.result;

      const hasStores =
        db.objectStoreNames.contains(STORE_NAME) && db.objectStoreNames.contains(CHUNK_STORE_NAME);

      if (!hasStores) {
        console.log("[NanoScribe::Memory] ⚠️ Missing stores, resetting database...");
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
    const haystack = `${memory.title} ${memory.summary} ${memory.url}`.toLowerCase();
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

export async function addContentChunks(chunks: ContentChunkDraft[]): Promise<void> {
  if (!chunks.length) return;

  const { store, transaction } = await getChunkStore("readwrite");

  for (const chunk of chunks) {
    const record: ContentChunkRecord = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      ...chunk,
    };
    await promisifyRequest(store.put(record));
  }

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
