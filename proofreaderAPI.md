<!-- markdownlint-disable -->
Proofreader API Model Usage Summary

Examples
Basic usage: Create proofreader and correct text.
const proofreader = await Proofreader.create({
  includeCorrectionTypes: true,
  includeCorrectionExplanations: true,
});
const corrections = await proofreader.proofread("I seen him yesterday at the store, and he bought two loafs of bread.");

Repeated usage: Use the same proofreader for multiple texts.
const proofreader = await Proofreader.create();
editBoxEl.addEventListener("blur", async (event) => {
  const corrections = await proofreader.proofread(event.target.value);
});

Multilingual content: Specify expected languages.
const proofreader = await Proofreader.create({
  includeCorrectionTypes: true,
  expectedInputLanguages: ["en", "ja"],
});

Availability checks: Test options before creation.
const options = { includeCorrectionTypes: true, expectedInputLanguages: ["en"] };
const availability = await Proofreader.availability(options);
if (availability !== "unavailable") {
  const proofreader = await Proofreader.create(options);
}

Download progress: Monitor model downloads.
const proofreader = await Proofreader.create({
  monitor(m) {
    m.addEventListener("downloadprogress", e => {
      console.log(`Downloaded ${e.loaded * 100}%`);
    });
  }
});

Destruction and aborting: Manage sessions.
const controller = new AbortController();
const proofreader = await Proofreader.create({ signal: controller.signal });
proofreader.destroy(); // Free memory.

Detailed design
ProofreadResult: Returns corrected text and list of corrections.
dictionary ProofreadResult {
  DOMString corrected;
  sequence<ProofreadCorrection> corrections;
}

ProofreadCorrection: Details on each error fix.
dictionary ProofreadCorrection {
  unsigned long long startIndex;
  unsigned long long endIndex;
  DOMString correction;
  CorrectionType type; // If includeCorrectionTypes
  DOMString explanation; // If includeCorrectionExplanations
}

CorrectionType enum: "spelling", "punctuation", "capitalization", "preposition", "missing-words", "grammar".

API surface: Web IDL for interface and methods.