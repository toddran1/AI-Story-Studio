# AI Story Studio

Milestone 1 is a CLI-first, provider-agnostic vertical slice:

`Chinese TXT → translation → narration polish → Story Bible → Fish Audio → MP3`

The pipeline preserves every intermediate artifact, fingerprints stage inputs, and resumes at the first stale or failed stage. OpenAI and Gemini are isolated behind one LLM contract; Fish Audio is isolated behind the TTS contract.

Milestone 2 adds deterministic multi-chapter discovery, validation, sequential processing, retries, durable batch history, graceful pause/resume, and progress summaries.

Milestone 3 adds provider-based local ingestion for TXT directories, TXT files, EPUB, DOCX, and manual/original stories. Import remains separate from AI processing.

Milestone 4 adds bounded remote ingestion with a Fanqie adapter, additive range imports, HTTP caching, and refresh discovery. Remote ingestion still feeds the same source manifest and batch pipeline.

## Requirements

- Node.js 22 or newer (an active LTS release is recommended)
- npm
- OpenAI, Gemini, and Fish Audio API credentials
- A Fish Audio voice/reference ID is recommended for consistent voice output

Postgres is the intended durable store for later multi-job milestones. Milestone 1 deliberately uses the requested filesystem/JSON persistence so the single-chapter workflow remains local and easy to inspect; storage access is isolated so a database implementation can be introduced later.

## Setup

```sh
npm install
cp .env.example .env
```

Fill in `.env`:

```dotenv
OPENAI_API_KEY=
OPENAI_DEFAULT_MODEL=gpt-5.6-terra
GEMINI_API_KEY=
GEMINI_DEFAULT_MODEL=gemini-3.8-flash
FISH_AUDIO_API_KEY=
FISH_AUDIO_MODEL=s2-pro
FISH_AUDIO_REFERENCE_ID=
PROVIDER_TIMEOUT_MS=120000
WEB_REQUEST_TIMEOUT_MS=30000
WEB_REQUEST_DELAY_MS=500
WEB_MAX_RESPONSE_BYTES=5000000
WEB_MAX_RETRIES=2
WEB_CACHE_DIR=.cache/ai-story-studio/web
```

Model IDs are configuration. The defaults reflect official model identifiers available when this milestone was implemented (September 2026); change them without touching source code if account availability or model recommendations differ.

## Process a chapter

```sh
npm run story:process -- \
  --story demo-story \
  --chapter 1 \
  --input ./input/chapter-001.txt
```

On first use, this bootstraps `stories/demo-story/story.json` from the environment defaults. Edit that file to independently choose `openai` or `gemini` for translation, narration, and Story Bible extraction. The TTS provider is currently `fish`.

Run the same command again to reuse valid stages. Force a stage and every dependent stage after it with:

```sh
npm run story:process -- --story demo-story --chapter 1 --input ./input/chapter-001.txt --force tts
```

Allowed values are `translation`, `narration`, `story-bible`, `tts`, and `all`. Forcing narration, for example, also regenerates the Story Bible update and audio because those outputs depend on narration.

## Milestone 2 — Multi-Chapter Processing

Place UTF-8 chapter files in one directory. Supported names include `001.txt`, `0001.txt`, `chapter-1.txt`, `chapter-001.txt`, and `Chapter 001.txt`.

```sh
npm run story:batch -- \
  --story my-story \
  --input ./input/my-story \
  --from 1 \
  --to 100
```

`--from` and `--to` are inclusive and optional. Discovery validates the entire directory before any provider call: duplicate numbers, unrecognized `.txt` names, empty files, invalid ranges, and numbering gaps all stop the run. Use `--allow-gaps` only when missing chapter numbers are intentional.

Preview the plan with zero paid API calls:

```sh
npm run story:batch -- --story my-story --input ./input/my-story --dry-run
```

Chapters run strictly in ascending order because each chapter's translation depends on the Story Bible produced by earlier chapters. The default behavior stops on the first failure. `--continue-on-error` is available, but later chapters may then receive incomplete story context.

Transient network, timeout, rate-limit, and server failures use bounded exponential backoff with jitter. Defaults are three attempts, a 1-second initial delay, and a 30-second cap. Configure these with `--max-attempts`, `--initial-delay-ms`, and `--max-delay-ms`; add `--delay-ms` to throttle between chapters.

Each provider request also has a 120-second deadline by default. Set `PROVIDER_TIMEOUT_MS` in `.env` to adjust it. Commands that mutate one story acquire a per-story lock, so accidentally starting an import, batch, or single-chapter run for the same story twice fails clearly instead of corrupting shared state.

Every run has a unique manifest under `stories/<story>/batches/`, plus `latest.json`. Rerunning the normal batch is safe: the chapter pipeline remains the authority for fingerprints and reuses valid expensive outputs. Retry only failures from the latest manifest with:

```sh
npm run story:batch -- --story my-story --retry-failed
```

Batch force values match the single-chapter command. Force is applied only on the first attempt of a chapter; retries reuse any stages that already finished. Forcing translation, narration, or Story Bible work causes dependent stages and later chapter context fingerprints to be reevaluated chronologically.

Press Ctrl+C once to request a graceful pause. The active chapter is allowed to reach its safe boundary, the manifest is written atomically, and no next chapter starts. Run the original batch command again to resume via stage-level reuse.

Story configuration now supports a bounded summary window:

```json
{"context":{"recentChapterSummaries":5}}
```

Canonical entities remain available, while only the latest configured number of chapter summaries enters model context.

The result is stored under:

```text
stories/demo-story/
├── story.json
├── pipeline.json
├── story-bible.json
├── batches/
│   ├── latest.json
│   └── <batch-id>.json
└── chapters/0001/
    ├── chapter.json
    ├── original.txt
    ├── english.txt
    ├── narration.txt
    ├── story-bible-update.json
    └── audio.mp3
```

Long narration is split at paragraph and sentence boundaries. Individual MP3 responses are retained in `audio-segments/` when splitting is required, and their byte streams are concatenated into `audio.mp3`, which is supported by ordinary MP3 players. A later audio-mastering milestone can replace this join strategy with FFmpeg without affecting TTS or pipeline contracts.

## Milestone 3 — Source Ingestion

Inspect a source before importing it:

```sh
npm run story:inspect -- --source ./books/my-novel.epub
npm run story:inspect -- --source ./drafts/my-story.docx
npm run story:inspect -- --source ./drafts/my-story.txt --split-chapters
```

Inspection detects the source type, prints available title/author/language metadata, lists numbered chapters and titles, and surfaces unnumbered sections and structured warnings. It does not write story state or call an LLM or TTS provider.

Import the inspected source into a story:

```sh
npm run story:import -- --story my-novel --source ./books/my-novel.epub
npm run story:import -- --story my-story --source ./drafts/my-story.docx
npm run story:import -- --story my-story --source ./drafts/my-story.txt --type original --split-chapters
```

A single TXT file is one chapter by default; select its number with `--chapter 361`. Add `--split-chapters` only when one TXT contains headings such as `Chapter 1`, `第1章`, or `第一章`. TXT directories retain the Milestone 2 filename validation rules. Use `--allow-gaps` when missing numbers are intentional.

Import writes normalized chapters to `stories/<slug>/source/chapters/` and a validated `source.json` manifest containing source/chapter fingerprints, titles, metadata, warnings, and the import origin. Writes are staged and finalized atomically, interrupted staging directories are cleaned up on the next import, and a previous source is restored if configuration finalization fails. Re-importing unchanged content reuses the existing materialization; changed imports report added, modified, and removed chapter numbers. EPUB and DOCX ZIP containers are rejected when compressed, expanded, entry-size, or entry-count safety limits are exceeded.

Process an imported source without repeating its path:

```sh
npm run story:batch -- --story my-novel --from 1 --to 10
```

Explicit `--input` remains supported. Importing consumes no LLM or TTS credits and never changes the Story Bible; only batch processing does. When the configured source and output languages are identical, translation is persisted as a fingerprinted `passthrough` stage, while narration polish, Story Bible extraction, and TTS continue normally.

## Milestone 4 — Web Novel Ingestion

Fanqie book and chapter URLs are recognized automatically. Inspection retrieves book metadata and the chapter directory only; it does not download every chapter body:

```sh
npm run story:inspect -- \
  --source https://fanqienovel.com/page/7367239434808347672

# Optionally verify the first three chapter bodies.
npm run story:inspect -- \
  --source https://fanqienovel.com/page/7367239434808347672 \
  --probe 3
```

Remote imports require an explicit inclusive range as a guard against accidentally downloading an entire novel:

```sh
npm run story:import -- \
  --story undead-disaster \
  --source https://fanqienovel.com/page/7367239434808347672 \
  --from 1 \
  --to 25
```

Later imports are additive. Importing `26–100` preserves `1–25`; overlapping ranges reuse unchanged chapters and report changed bodies. The materialized chapters remain under `stories/<slug>/source/chapters/`, so normal processing is unchanged:

```sh
npm run story:batch -- --story undead-disaster --from 1 --to 10
```

Check the saved remote directory snapshot for newly published chapters without importing or processing anything:

```sh
npm run story:refresh -- --story undead-disaster
npm run story:refresh -- --story undead-disaster --import-new
```

Automatic refresh import stops if existing remote chapters were removed or reordered. Locked or unreadable bodies also fail explicitly; the adapter does not bypass account or payment access controls.

Remote requests allow HTTPS only, validate redirect destinations, use bounded retries and timeouts, enforce streaming response-size limits, and are rate-limited. The file cache uses ETag and Last-Modified revalidation when supplied by the server; set `WEB_CACHE_DIR=` to disable it. Configure these behaviors with the `WEB_*` environment values shown above.

## Verification

```sh
npm test
npm run typecheck
```

Tests use fake LLMs and mocked Fish responses and never make paid API calls. The explicit real-credential smoke test processes the short, project-authored Chinese fixture:

```sh
npm run smoke
```

## Architecture notes

- Vendor code exists only in `src/llm/openai`, `src/llm/gemini`, and `src/tts/fish`.
- Generic remote transport and caching live under `src/source/web`; Fanqie URL, directory, body, and font-decoding logic lives under `src/source/fanqie`.
- OpenAI uses the Responses API and JSON Schema structured output.
- Gemini uses the Interactions API and JSON response format.
- Prompts and prompt versions live outside orchestration logic.
- `chapter.json` records status, fingerprints, provider/model, timings, errors, prompt versions, and available usage/request metadata per stage.
- Writes use same-directory temporary files followed by atomic rename, and stage reuse verifies the output file's recorded fingerprint rather than trusting metadata alone.
- Story context contains canonical structured knowledge and earlier summaries, never every earlier chapter.
- Existing canonical translations win during Story Bible merges; conflicting new names become aliases where applicable.

Generated stories, private text, audio, `.env`, logs, dependencies, and build output are ignored by git.

## API references

- [OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
- [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Fish Audio text-to-speech endpoint](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
