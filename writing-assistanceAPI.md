Writing Assistance APIs Model Usage Summary

Examples
Basic usage for Summarizer: Create and summarize text.
const summarizer = await Summarizer.create({
  sharedContext: "An article from the Daily Economic News magazine",
  type: "headline",
  length: "short"
});
const summary = await summarizer.summarize(articleEl.textContent, {
  context: "This article was written 2024-08-07 and it's in the World Markets section."
});

Basic usage for Writer: Generate new content.
const writer = await Writer.create({ tone: "formal" });
const result = await writer.write("A draft for an inquiry to my bank about how to enable wire transfers on my account");

Basic usage for Rewriter: Modify existing text.
const rewriter = await Rewriter.create({
  sharedContext: "A review for the Flux Capacitor 3000 from TimeMachines Inc."
});
const result = await rewriter.rewrite(reviewEl.textContent, {
  context: "Avoid any toxic language and be as constructive as possible."
});

Streaming output: Use streaming methods for real-time results.
const writer = await Writer.create({ tone: "formal", length: "long" });
const stream = writer.writeStreaming("A draft for an inquiry...");
for await (const chunk of stream) { composeTextbox.append(chunk); }

Repeated usage: Reuse objects for multiple operations.
const summarizer = await Summarizer.create({ type: "tldr" });
const reviewSummaries = await Promise.all(
  Array.from(document.querySelectorAll("#reviews > .review"), reviewEl =>
    summarizer.summarize(reviewEl.textContent)
  )
);

Multilingual content: Specify languages for better support.
const summarizer = await Summarizer.create({
  type: "key-points",
  expectedInputLanguages: ["ja", "ko"],
  expectedContextLanguages: ["en", "ja", "ko"],
  outputLanguage: "zh"
});

Input quotas: Handle token limits.
const rewriter = await Rewriter.create();
meterEl.max = rewriter.inputQuota;
textbox.addEventListener("input", () => {
  meterEl.value = await rewriter.measureInputUsage(textbox.value);
  submitButton.disabled = meterEl.value > meterEl.max;
});

Availability checks: Test before creation.
const options = { type: "teaser", expectedInputLanguages: ["ja"] };
const availability = await Summarizer.availability(options);
if (availability !== "unavailable") {
  const summarizer = await Summarizer.create(options);
}

Download progress: Monitor model downloads.
const writer = await Writer.create({
  monitor(m) {
    m.addEventListener("downloadprogress", e => {
      console.log(`Downloaded ${e.loaded * 100}%`);
    });
  }
});

Destruction and aborting: Manage sessions.
const controller = new AbortController();
const rewriter = await Rewriter.create({ signal: controller.signal });
rewriter.destroy(); // Free memory.

Detailed design
Robustness to adversarial inputs: Encourage handling tricky user inputs.
Permissions policy: Control access in iframes.
Specifications and tests: Focus on non-output API parts for interop.