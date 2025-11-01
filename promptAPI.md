<!-- markdownlint-disable -->
Prompt API Model Usage Summary

Examples
Zero-shot prompting: Create session and prompt directly.
const session = await LanguageModel.create();
const result = await session.prompt("Write me a poem.");

Streaming output: Use promptStreaming for real-time responses.
const stream = session.promptStreaming("Write me an extra-long poem.");
for await (const chunk of stream) { console.log(chunk); }

System prompts: Configure with initialPrompts for context.
const session = await LanguageModel.create({
  initialPrompts: [{ role: "system", content: "Pretend to be an eloquent hamster." }]
});

N-shot prompting: Provide examples for better responses.
const session = await LanguageModel.create({
  initialPrompts: [
    { role: "system", content: "Predict up to 5 emojis as a response." },
    { role: "user", content: "This is amazing!" },
    { role: "assistant", content: "❤️, ➕" }
  ]
});

Tool use: Define external capabilities for the model.
const session = await LanguageModel.create({
  tools: [{
    name: "getWeather",
    async execute({ location }) { return JSON.stringify(await fetchWeather(location)); }
  }]
});

Multimodal inputs: Support image and audio with expectedInputs.
const session = await LanguageModel.create({ expectedInputs: [{ type: "image" }] });
const response = await session.prompt([{
  role: "user",
  content: [
    { type: "text", value: "Describe this image:" },
    { type: "image", value: imageBlob }
  ]
}]);

Structured output: Constrain responses with JSON schema or RegExp.
const result = await session.prompt("Summarize feedback:", { responseConstraint: schema });

Tokenization and quotas: Manage input usage and handle overflow.
console.log(`${session.inputUsage} tokens used, out of ${session.inputQuota}.`);
await session.measureInputUsage(promptString);

Multilingual support: Specify expected languages for better handling.
const session = await LanguageModel.create({
  expectedInputs: [{ type: "text", languages: ["en", "ja"] }]
});

Session management: Clone, destroy, abort for efficient resource use.
const newSession = await session.clone();
session.destroy(); // Frees model memory.

Availability checks: Use availability() before creation.
const availability = await LanguageModel.availability(options);
// `availability` will be one of "unavailable", "downloadable", "downloading", or "available".

Expected output languages
In general, what output language the model responds in will be governed by the language model's own decisions. For example, a prompt such as "Please say something in French" could produce "Bonjour" or it could produce "I'm sorry, I don't know French".

However, if you know ahead of time what languages you are hoping for the language model to output, it's best practice to use the expectedOutputs option to LanguageModel.create() to indicate them. This allows the implementation to download any necessary supporting material for those output languages, and to immediately reject the returned promise if it's known that the model cannot support that language:

const session = await LanguageModel.create({
  initialPrompts: [{
    role: "system",
    content: `You are a helpful, harmless French chatbot.`
  }],
  expectedInputs: [
    { type: "text", languages: ["en" /* for the system prompt */, "fr"] }
  ],
  expectedOutputs: [
    { type: "text", languages: ["fr"] }
  ]
});
As with expectedInputs, specifying a given language in expectedOutputs does not actually influence the language model's output. It's only expressing an expectation that can help set up the session, perform downloads, and fail creation if necessary. And as with expectedInputs, you can use LanguageModel.availability() to check ahead of time, before creating a session.

(Note that presently, the prompt API does not support multimodal outputs, so including anything array entries with types other than "text" will always fail. However, we've chosen this general shape so that in the future, if multimodal output support is added, it fits into the API naturally.)

Testing available options before creation
In the simple case, web developers should call LanguageModel.create(), and handle failures gracefully.

However, if the web developer wants to provide a differentiated user experience, which lets users know ahead of time that the feature will not be possible or might require a download, they can use the promise-returning LanguageModel.availability() method. This method lets developers know, before calling create(), what is possible with the implementation.

The method will return a promise that fulfills with one of the following availability values:

"unavailable" means that the implementation does not support the requested options, or does not support prompting a language model at all.
"downloadable" means that the implementation supports the requested options, but it will have to download something (e.g. the language model itself, or a fine-tuning) before it can create a session using those options.
"downloading" means that the implementation supports the requested options, but will need to finish an ongoing download operation before it can create a session using those options.
"available" means that the implementation supports the requested options without requiring any new downloads.
An example usage is the following:

const options = {
  expectedInputs: [
    { type: "text", languages: ["en", "es"] },
    { type: "audio", languages: ["en", "es"] }
  ],
  temperature: 2
};

const availability = await LanguageModel.availability(options);

if (availability !== "unavailable") {
  if (availability !== "available") {
    console.log("Sit tight, we need to do some downloading...");
  }

  const session = await LanguageModel.create(options);
  // ... Use session ...
} else {
  // Either the API overall, or the expected languages and temperature setting, is not available.
  console.error("No language model for us :(");
}
Download progress
For cases where using the API is only possible after a download, you can monitor the download progress (e.g. in order to show your users a progress bar) using code such as the following:

const session = await LanguageModel.create({
  monitor(m) {
    m.addEventListener("downloadprogress", e => {
      console.log(`Downloaded ${e.loaded * 100}%`);
    });
  }
});
If the download fails, then downloadprogress events will stop being emitted, and the promise returned by create() will be rejected with a "NetworkError" DOMException.

Note that in the case that multiple entities are downloaded (e.g., a base model plus LoRA fine-tunings for the expectedInputs) web developers do not get the ability to monitor the individual downloads. All of them are bundled into the overall downloadprogress events, and the create() promise is not fulfilled until all downloads and loads are successful.

The event is a ProgressEvent whose loaded property is between 0 and 1, and whose total property is always 1. (The exact number of total or downloaded bytes are not exposed; see the discussion in webmachinelearning/writing-assistance-apis issue #15.)

At least two events, with e.loaded === 0 and e.loaded === 1, will always be fired. This is true even if creating the model doesn't require any downloading.

What's up with this pattern?
Detailed design
Instruction-tuned versus base models
We intend for this API to expose instruction-tuned models. Although we cannot mandate any particular level of quality or instruction-following capability, we think setting this base expectation can help ensure that what browsers ship is aligned with what web developers expect.

To illustrate the difference and how it impacts web developer expectations:

In a base model, a prompt like "Write a poem about trees." might get completed with "... Write about the animal you would like to be. Write about a conflict between a brother and a sister." (etc.) It is directly completing plausible next tokens in the text sequence.
Whereas, in an instruction-tuned model, the model will generally follow instructions like "Write a poem about trees.", and respond with a poem about trees.
To ensure the API can be used by web developers across multiple implementations, all browsers should be sure their models behave like instruction-tuned models.

Permissions policy, iframes, and workers
By default, this API is only available to top-level Windows, and to their same-origin iframes. Access to the API can be delegated to cross-origin iframes using the Permissions Policy allow="" attribute:

<iframe src="https://example.com/" allow="language-model"></iframe>
This API is currently not available in workers, due to the complexity of establishing a responsible document for each worker in order to check the permissions policy status. See this discussion for more. It may be possible to loosen this restriction over time, if use cases arise.

Note that although the API is not exposed to web platform workers, a browser could expose them to extension service workers, which are outside the scope of web platform specifications and have a different permissions model.

Alternatives considered and under consideration
How many stages to reach a response?
To actually get a response back from the model given a prompt, the following possible stages are involved:

Download the model, if necessary.
Establish a session, including configuring per-session options and parameters.
Add an initial prompt to establish context. (This will not generate a response.)
Execute a prompt and receive a response.
We've chosen to manifest these 3-4 stages into the API as two methods, LanguageModel.create() and session.prompt()/session.promptStreaming(), with some additional facilities for dealing with the fact that LanguageModel.create() can include a download step. Some APIs simplify this into a single method, and some split it up into three (usually not four).

Stateless or session-based
Our design here uses sessions. An alternate design, seen in some APIs, is to require the developer to feed in the entire conversation history to the model each time, keeping track of the results.

This can be slightly more flexible; for example, it allows manually correcting the model's responses before feeding them back into the context window.

However, our understanding is that the session-based model can be more efficiently implemented, at least for browsers with on-device models. (Implementing it for a cloud-based model would likely be more work.) And, developers can always achieve a stateless model by using a new session for each interaction.