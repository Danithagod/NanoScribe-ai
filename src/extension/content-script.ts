export function ensureFieldId(element: HTMLElement): string {
  const existing = element.getAttribute("data-nanoscribe-field-id");
  if (existing) return existing;
  const newId = `field-${crypto.randomUUID()}`;
  element.setAttribute("data-nanoscribe-field-id", newId);
  return newId;
}

// Types for test responses
interface DatabaseStatusPayload {
  memoryCount: number;
  totalChunks: number;
  readabilityChunks: number;
  legacyChunks: number;
  databaseVersion: number;
}

interface QualityStats {
  count: number;
  totalLength: number;
  avgLength: number;
}

interface QualityResultsPayload {
  readabilityStats: QualityStats;
  legacyStats: QualityStats;
  totalAnalyzed: number;
  improvement: number;
}

interface TestResultsPayload {
  baselineCount: number;
  finalCount: number;
  newMemoriesCount: number;
  readabilityChunksCount: number;
  success: boolean;
}

interface MemoryCreationResult {
  url: string;
  success: boolean;
  error?: string;
}

type TestResponse<T = unknown> = {
  type: string;
  payload?: T;
} | undefined;

declare global {
  interface Window {
    ensureFieldId?: typeof ensureFieldId;
    runReadabilityTests?: () => Promise<void>;
    testDatabaseStatus?: () => Promise<void>;
    testMemoryCreation?: () => Promise<void>;
  }
}

if (typeof window !== "undefined" && !window.ensureFieldId) {
  window.ensureFieldId = ensureFieldId;
}

// Simple test functions that work within extension context
async function runReadabilityTests() {
  console.log("🧪 Running Readability Tests (Extension Context)...");

  try {
    // Test 1: Basic connectivity
    const pingResponse = await new Promise<TestResponse<{type: string}>>(resolve => chrome.runtime.sendMessage({ type: "PING" }, resolve));
    console.log(`${pingResponse?.type === "PONG" ? '✅' : '❌'} Service worker responding`);

    // Test 2: Database status
    const dbResponse = await new Promise<TestResponse<DatabaseStatusPayload>>(resolve => chrome.runtime.sendMessage({ type: "TEST_DATABASE_STATUS" }, resolve));
    if (dbResponse?.type === "DATABASE_STATUS") {
      console.log("📊 Database Status:");
      console.log(`  📚 Memories: ${dbResponse.payload?.memoryCount || 0}`);
      console.log(`  📦 Total chunks: ${dbResponse.payload?.totalChunks || 0}`);
      console.log(`  📖 Readability chunks: ${dbResponse.payload?.readabilityChunks || 0}`);
      console.log(`  📜 Legacy chunks: ${dbResponse.payload?.legacyChunks || 0}`);
    }

    // Test 3: Content quality
    const qualityResponse = await new Promise<TestResponse<QualityResultsPayload>>(resolve => chrome.runtime.sendMessage({ type: "TEST_CONTENT_QUALITY" }, resolve));
    if (qualityResponse?.type === "QUALITY_RESULTS") {
      console.log("📊 Content Quality Analysis:");
      console.log(`  Readability avg length: ${qualityResponse.payload?.readabilityStats?.avgLength || 0} chars`);
      console.log(`  Legacy avg length: ${qualityResponse.payload?.legacyStats?.avgLength || 0} chars`);
      console.log(`  Improvement: ${qualityResponse.payload?.improvement || 0} chars`);
    }

    // Test 4: Comprehensive tests
    const testResponse = await new Promise<TestResponse<TestResultsPayload>>(resolve => chrome.runtime.sendMessage({ type: "RUN_READABILITY_TESTS" }, resolve));
    if (testResponse?.type === "TEST_RESULTS") {
      console.log("📊 Test Results:");
      console.log(`  Baseline: ${testResponse.payload?.baselineCount || 0}`);
      console.log(`  Final: ${testResponse.payload?.finalCount || 0}`);
      console.log(`  New memories: ${testResponse.payload?.newMemoriesCount || 0}`);
      console.log(`  Readability chunks: ${testResponse.payload?.readabilityChunksCount || 0}`);
      console.log(`  Success: ${testResponse.payload?.success ? '✅' : '❌'}`);
    }

    console.log("🎉 Readability tests completed!");

  } catch (error) {
    console.error("❌ Tests failed:", error);
  }
}

async function testDatabaseStatus() {
  console.log("🔍 Testing Database Status...");

  try {
    const response = await new Promise<TestResponse<DatabaseStatusPayload>>(resolve => chrome.runtime.sendMessage({ type: "TEST_DATABASE_STATUS" }, resolve));
    if (response?.type === "DATABASE_STATUS") {
      console.log("📊 Database Status:");
      console.log(`  📚 Total memories: ${response.payload?.memoryCount || 0}`);
      console.log(`  📦 Total chunks: ${response.payload?.totalChunks || 0}`);
      console.log(`  📖 Readability chunks: ${response.payload?.readabilityChunks || 0}`);
      console.log(`  📜 Legacy chunks: ${response.payload?.legacyChunks || 0}`);
      console.log(`  🗄️ Database version: ${response.payload?.databaseVersion || 0}`);
    }
  } catch (error) {
    console.error("❌ Database status test failed:", error);
  }
}

async function testMemoryCreation() {
  console.log("📝 Testing Memory Creation...");

  try {
    // First clear existing memories for clean test
    await new Promise(resolve => chrome.runtime.sendMessage({ type: "CLEAR_ALL_MEMORIES" }, resolve));
    console.log("✅ Cleared existing memories");

    // Test URLs
    const testUrls = [
      "https://developer.mozilla.org/en-US/docs/Web/API/Readability",
      "https://en.wikipedia.org/wiki/Readability"
    ];

    // Send test creation request
    const response = await new Promise<TestResponse<MemoryCreationResult[]>>(resolve =>
      chrome.runtime.sendMessage({ type: "TEST_MEMORY_CREATION", payload: { urls: testUrls } }, resolve)
    );

    if (response?.type === "TEST_RESULTS") {
      console.log("📊 Memory Creation Results:");
      response.payload?.forEach((result) => {
        console.log(`  ${result.success ? '✅' : '❌'} ${result.url}: ${result.success ? 'Success' : result.error}`);
      });
    }

  } catch (error) {
    console.error("❌ Memory creation test failed:", error);
  }
}

// Import Readability for DOM parsing
import { Readability } from '@mozilla/readability';

// Types for content script messages
interface ExtractReadabilityResponse {
  success: boolean;
  data?: {
    title: string;
    textContent: string;
    chunks: string[];
    baseURI: string;
  };
  error?: string;
}

// Message handler for Readability extraction
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "EXTRACT_WITH_READABILITY") {
    try {
      console.log("[NanoScribe::Content] 📖 Extracting content with Readability...");

      // Create a detached document to avoid mutating the live DOM
      const parser = new DOMParser();
      const detachedDoc = parser.parseFromString(document.documentElement.outerHTML, "text/html");

      // Set baseURI on the detached document
      if (document.baseURI) {
        const baseTag = detachedDoc.createElement("base");
        baseTag.href = document.baseURI;

        if (detachedDoc.head) {
          const existingBase = detachedDoc.head.querySelector("base");
          if (existingBase) {
            existingBase.replaceWith(baseTag);
          } else {
            detachedDoc.head.prepend(baseTag);
          }
        } else {
          const head = detachedDoc.createElement("head");
          head.append(baseTag);
          if (detachedDoc.documentElement) {
            detachedDoc.documentElement.insertBefore(head, detachedDoc.body ?? null);
          }
        }
      }

      // Parse with Readability using the detached document
      const reader = new Readability(detachedDoc);
      const article = reader.parse();

      if (!article || !article.textContent) {
        console.log("[NanoScribe::Content] ❌ Readability failed to extract content");
        sendResponse({
          success: false,
          error: "Readability failed to extract content"
        } as ExtractReadabilityResponse);
        return;
      }

      console.log(`[NanoScribe::Content] ✅ Readability extracted ${article.textContent.length} characters`);

      // Split into chunks by paragraphs (Readability's approach)
      const chunks = article.textContent
        .split(/\n\s*\n/) // Split by one or more empty lines
        .map(chunk => chunk.trim())
        .filter(chunk => chunk.length > 50);

      console.log(`[NanoScribe::Content] 📦 Created ${chunks.length} content chunks`);

      // For pages with very little content (like search results), skip indexing
      if (chunks.length === 0 || article.textContent.length < 200) {
        console.log("[NanoScribe::Content] ⚠️ Page has minimal content, skipping Readability extraction");
        sendResponse({
          success: false,
          error: "Page has minimal content (likely search results or index page)"
        } as ExtractReadabilityResponse);
        return;
      }

      // For pages with very few chunks, check if it's worth indexing
      if (chunks.length < 2) {
        console.log("[NanoScribe::Content] ⚠️ Page has very few content chunks, likely not worth indexing");
        sendResponse({
          success: false,
          error: "Page has insufficient content chunks for indexing"
        } as ExtractReadabilityResponse);
        return;
      }

      sendResponse({
        success: true,
        data: {
          title: article.title || document.title,
          textContent: article.textContent,
          chunks,
          baseURI: document.baseURI
        }
      } as ExtractReadabilityResponse);
    } catch (error) {
      console.error("[NanoScribe::Content] ❌ Readability extraction failed:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      } as ExtractReadabilityResponse);
    }
    return true; // Keep message channel open for async response
  }
});

