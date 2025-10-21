import type { ContentChunkRecord, MemoryRecord } from "../types";

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
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (request.oldVersion < 1) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("by-url", "url", { unique: true });
        store.createIndex("by-createdAt", "createdAt", { unique: false });
      }

      if (request.oldVersion < 2) {
        if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
          const chunkStore = db.createObjectStore(CHUNK_STORE_NAME, { keyPath: "id" });
          chunkStore.createIndex("by-memoryId", "memoryId", { unique: false });
          chunkStore.createIndex("by-createdAt", "createdAt", { unique: false });
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      const hasStores =
        db.objectStoreNames.contains(STORE_NAME) && db.objectStoreNames.contains(CHUNK_STORE_NAME);

      if (!hasStores) {
        resetDatabase(db)
          .then(() => openDatabase().then(resolve, reject))
          .catch(reject);
        return;
      }

      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });

  return databasePromise;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStore(mode: IDBTransactionMode = "readonly") {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    return { transaction, store };
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      await resetDatabase();
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
  const { store } = await getStore("readonly");
  const request = store.index("by-createdAt").getAll();
  const results = await promisifyRequest(request);
  return results.sort((a, b) => b.createdAt - a.createdAt);
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
