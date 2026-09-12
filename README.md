# AI Story Studio

## Production Studio workflow

The browser studio is the primary local workflow. Open a story dashboard to see import, QA, audio, artwork, video, and the most recent durable production run in one place. **Set up production** opens a guided flow: choose a chapter range and output, review the dry-run plan and cached versus provider-backed operations, then explicitly start production.

The chapter workspace supports side-by-side source, translation, and narration review. Saving a manual translation or narration edit marks dependent stages stale but never starts paid regeneration. Story Bible corrections are stored in `story-bible-manual.json` as a protected overlay, so later extraction runs cannot silently replace deliberate edits. Voice tests are similarly isolated under `voice-previews/` and never become chapter artifacts.

The Outputs library exposes only known chapter and export artifacts through validated localhost API routes; arbitrary filesystem paths are never accepted from the browser. Production can be paused after the current chapter and resumed from its durable manifest after a page reload or server restart.

Milestone 1 is a CLI-first, provider-agnostic vertical slice:

`Chinese TXT → translation → narration polish → Story Bible → Fish Audio → MP3`

The pipeline preserves every intermediate artifact, fingerprints stage inputs, and resumes at the first stale or failed stage. OpenAI and Gemini are isolated behind one LLM contract; Fish Audio is isolated behind the TTS contract.

Milestone 2 adds deterministic multi-chapter discovery, validation, sequential processing, retries, durable batch history, graceful pause/resume, and progress summaries.

Milestone 3 adds provider-based local ingestion for TXT directories, TXT files, EPUB, DOCX, and manual/original stories. Import remains separate from AI processing.

Milestone 4 adds bounded remote ingestion with a Fanqie adapter, additive range imports, HTTP caching, and refresh discovery. Remote ingestion still feeds the same source manifest and batch pipeline.

Milestone 5 adds structured translation/narration QA, a safe TTS quality gate, controlled repair, isolated A/B previews, story-level model profiles, and batch quality summaries.

Milestone 6 adds a local browser studio backed by a localhost-only API, in-process jobs, and live SSE progress. It calls the same source, batch, QA, preview, profile, Story Bible, and TTS services used by the CLI.

Milestone 7 adds FFmpeg audio mastering, durable chapter masters, and cached MP3/M4B audiobook exports with chapter markers.

Milestone 8 adds deterministic SRT/WebVTT timing, cached H.264 chapter videos, cover or fallback backgrounds, and combined MP4 editions.

Milestone 9 adds structured scene planning, reviewable still-art generation, character visual references, and approved scene timelines for chapter video.

Milestone 10 adds one dependency-aware production orchestrator with resumable manifests, bounded QA repair, cost-safe planning, optional artwork, and final audiobook/video assembly.

Provider usage, historical estimates, budget guards, and analytics exports are documented in [Provider cost tracking](docs/provider-costs.md).

Milestone 13 adds a Postgres-backed production queue with chronological chapter claims, worker leases, durable retries and provider cooldowns, restart reconciliation against filesystem artifacts, persistent controls, and paginated queue/review workspaces.

Milestone 14 adds local narration-to-audio forced alignment, durable word timestamps, alignment-aware subtitle segmentation, quality metrics, protected manual timing edits, and deterministic estimated timing when the aligner is unavailable or produces unusable results.

## Requirements

- Node.js 22 or newer (an active LTS release is recommended)
- npm
- FFmpeg and ffprobe (available on `PATH`, or configured with `FFMPEG_PATH` and `FFPROBE_PATH`)
- whisper.cpp's `whisper-cli` plus a local GGML model for true forced alignment (optional; estimated subtitle timing remains available)
- Postgres 15 or newer for durable web production jobs (the synchronous CLI remains available without Postgres)
- OpenAI, Gemini, and Fish Audio API credentials
- A Fish Audio voice/reference ID is recommended for consistent voice output

Postgres coordinates durable queue state only. Filesystem manifests and fingerprints remain authoritative for generated content. The Compose service bind-mounts its data at `POSTGRES_DATA_DIR` rather than using an opaque Docker volume.

## Setup

```sh
npm install
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
```

Fill in `.env`:

```dotenv
STUDIO_DATA_ROOT=/Volumes/ReggieSSD/Mac/coding-projects/python/ai_story_studio
POSTGRES_DATA_DIR=/Volumes/ReggieSSD/Mac/coding-projects/python/ai_story_studio/postgres
DATABASE_URL=postgresql://ai_story_studio:ai_story_studio@127.0.0.1:5433/ai_story_studio
OPENAI_API_KEY=
OPENAI_DEFAULT_MODEL=gpt-5.6-terra
GEMINI_API_KEY=
GEMINI_DEFAULT_MODEL=gemini-3.8-flash
FISH_AUDIO_API_KEY=
FISH_AUDIO_MODEL=s2-pro
FISH_AUDIO_REFERENCE_ID=
PROVIDER_TIMEOUT_MS=120000
MEDIA_PROCESS_TIMEOUT_MS=1800000
ALIGNMENT_ENGINE=whisper-cpp
ALIGNMENT_EXECUTABLE=whisper-cli
ALIGNMENT_MODEL=models/ggml-base.en.bin
ALIGNMENT_DEVICE=auto
ALIGNMENT_MIN_MATCH_PERCENT=85
ALIGNMENT_MIN_CONFIDENCE=0.45
ALIGNMENT_MAX_GAP_SECONDS=15
ALIGNMENT_TIMEOUT_MS=1800000
WEB_REQUEST_TIMEOUT_MS=30000
WEB_REQUEST_DELAY_MS=500
WEB_MAX_RESPONSE_BYTES=5000000
WEB_MAX_RETRIES=2
WEB_CACHE_DIR=cache/web
```

`STUDIO_DATA_ROOT` is the durable application-data location. Story imports, source chapters, intermediate files, audio, artwork, video, exports, backups, queue reconciliation manifests, and relative web caches are stored beneath it. `POSTGRES_DATA_DIR` is the matching Docker bind-mount location for the database; keep both on persistent storage. The source checkout can be moved or replaced without moving production data.

## Forced alignment and subtitles

Alignment runs after audio mastering and before subtitle generation. The canonical artifact is `chapters/<chapter>/alignment.json`; it records narration and audio hashes, engine/model/version configuration, word timestamps, match percentage, confidence, gap checks, and whether timing is truly aligned or estimated. Changing narration, mastered audio, the model, device, engine version, or thresholds invalidates only alignment and its downstream subtitle/video work. Audio and TTS remain reusable.

The default backend is the maintained `whisper-cli` executable from whisper.cpp. Put a compatible GGML model under the durable data root (the default resolves to `$STUDIO_DATA_ROOT/models/ggml-base.en.bin`) or set `ALIGNMENT_MODEL` to an absolute path. No audio bytes are sent to a remote service. The application passes the mastered audio by path and hashes it as a stream, so large chapter files are not loaded into memory for alignment or subtitle cache checks.

```sh
# Align one chapter, using deterministic fallback if the local engine is unavailable.
npm run story:align -- --story undead-disaster --chapter 1

# Require true aligned timestamps and fail clearly instead of falling back.
npm run story:align -- --story undead-disaster --from 1 --to 10 --require-aligned

# Explicitly rebuild deterministic estimated timing.
npm run story:subtitles -- --story undead-disaster --chapter 1 --estimated --force

# Production enables alignment by default for video; this opts out explicitly.
npm run story:produce -- --story undead-disaster --from 1 --to 10 --output video --no-alignment
```

Low match percentage, low confidence, suspicious gaps, invalid timestamp order, or audio-bound violations prevent an aligned artifact from being trusted. Normal production writes a warning-bearing estimated artifact and continues deterministically; `--require-aligned` is available when review policy requires a hard failure. The chapter **Subtitles** workspace shows the timing mode and quality metrics, supports explicit regeneration, and validates manual cue order and audio bounds. Saved manual cues are protected from automatic regeneration until **Reset manual edits** is chosen.

## Durable production queue

Milestone 13 uses Postgres only for operational coordination. Chapter files, manifests, fingerprints, Story Bible data, and finished media remain authoritative on disk. The included Compose service binds Postgres to localhost port `5433`; change `DATABASE_URL` if you use another local Postgres instance.

Run migrations explicitly after starting or upgrading Postgres:

```sh
docker compose up -d postgres
npm run db:migrate
```

`npm run web` starts one conservative production worker alongside the studio when `DATABASE_URL` is set. It claims one chapter at a time in chronological order, persists leases and bounded retries, and resumes expired work after a crash. Run a worker separately when desired:

```sh
npm run story:worker
```

Submit without changing the synchronous `story:produce` behavior:

```sh
npm run story:queue -- --story undead-disaster --from 1 --to 1600 --profile audiobook
```

The browser’s **Production queue** and **Needs review** screens read canonical status from Postgres with paginated chapter lists. Pause and cancel finish the current safe chapter; already-generated artifacts are never deleted. Concise events are retained for 90 days by default. Tune polling, leases, maximum durable attempts, provider spacing, and retention with the `QUEUE_*` and `PROVIDER_MIN_SPACING_MS` values in `.env.example`.

Model IDs are configuration. The defaults reflect official model identifiers available when this milestone was implemented (September 2026); change them without touching source code if account availability or model recommendations differ.

## Process a chapter

```sh
npm run story:process -- \
  --story demo-story \
  --chapter 1 \
  --input ./input/chapter-001.txt
```

On first use, this bootstraps `stories/demo-story/story.json` from the environment defaults. Edit that file to independently choose `openai` or `gemini` for translation, narration, QA, and Story Bible extraction. The TTS provider is currently `fish`.

Run the same command again to reuse valid stages. Force a stage and every dependent stage after it with:

```sh
npm run story:process -- --story demo-story --chapter 1 --input ./input/chapter-001.txt --force tts
```

Allowed values are `translation`, `narration`, `qa`, `story-bible`, `tts`, `audio`, and `all`. Forcing narration, for example, also regenerates QA, the Story Bible update, TTS, and its audio master. Forcing `audio` remasters only and never calls TTS.

## End-to-end production

Produce finished content from an already imported story with one command:

```sh
npm run story:produce -- \
  --story undead-disaster \
  --from 1 \
  --to 25 \
  --profile audiobook
```

Built-in profiles are `audio`, `audiobook`, `story-video`, and `everything`. Profiles live in `story.json` under `productionProfiles` and may be customized. Explicit `--output audio|audiobook|video|all`, `--artwork`/`--no-artwork`, and `--repair-qa`/`--no-repair-qa` flags override profile choices. Audiobooks default to M4B; use `--format mp3` when needed.

Preview dependencies and paid-operation counts without calling a paid provider or changing source state:

```sh
npm run story:produce -- --story undead-disaster --from 1 --to 25 --profile story-video --dry-run
```

Use `--refresh` for a remote story to check and import only newly available chapters inside the explicit requested range. Use `--force <stage>` to regenerate a stage and its production dependents. Ctrl+C requests a safe pause after the current chapter; running the same command resumes the matching manifest under `stories/<story>/production-runs/` and skips completed, still-valid chapters.

QA warnings continue and are reported for review. QA failures stop that chapter while other chapters remain safe; profiles enable at most two targeted repair attempts by default. Final audiobook or combined-video assembly only runs when every required chapter is ready. The local web studio exposes the same planner and orchestrator from the **Production** page with live SSE progress and download links.

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
    ├── qa.json
    ├── story-bible-update.json
    ├── audio-segments/
    ├── audio-raw.mp3
    ├── audio.mp3
    ├── subtitles.srt
    ├── subtitles.vtt
    └── video.mp4
```

Long narration is split at paragraph and sentence boundaries. Every original TTS response remains in `audio-segments/`, `audio-raw.mp3` preserves the provider output, and the FFmpeg-mastered `audio.mp3` is the playback-ready chapter file.

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

Add chapters to an existing story without removing chapter numbers that are absent from the new source:

```sh
# Add one later chapter.
npm run story:update -- --story my-story --source ./chapter-29.txt --chapter 29

# Add a numbered folder such as Chapters 29–40. Chapters 1–3 remain in place.
npm run story:update -- --story my-story --source ./later-chapters --allow-gaps

# Chapters 4–28 can be added later and are inserted in numeric order.
npm run story:update -- --story my-story --source ./missing-chapters --allow-gaps
```

`story:update` is additive: new numbers are inserted, overlapping numbers are replaced only when their source changed, and all other chapters are preserved. `story:import` remains the authoritative full-source import and may remove chapters omitted from that source.

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

## Milestone 5 — Quality Control and A/B Preview

Every processed chapter now receives a structured QA review after narration and before Story Bible extraction or TTS. `qa.json` records a score, pass/warn/fail checks, and actionable issue categories for completeness, names, numbers, terminology, dialogue, story consistency, and narration fidelity. Warnings continue and appear in batch summaries; failures stop with `Chapter N failed QA` and leave downstream stages pending.

Compare the current story profile (A) with an alternate translation provider (B) without changing production chapter files:

```sh
npm run story:preview -- --story undead-disaster --chapter 1
npm run story:preview -- --story undead-disaster --chapter 1 --audio-preview
```

Override any preview model with `provider:model`, for example `--translation-b openai:gpt-5.6-terra`, `--narration-b openai:gpt-5.6-terra`, or `--qa-b gemini:gemini-3.8-flash`. Results live under `stories/<story>/previews/<preview-id>/`. Audio preview uses roughly the first 75 seconds and is skipped for a failed candidate.

Save either complete preview preset as that story's future default:

```sh
npm run story:profile -- --story undead-disaster --use-preview <preview-id> --choice a
```

For a failed chapter, regenerate the stage suggested by its QA findings and rerun downstream validation. The loop is deliberately capped:

```sh
npm run story:repair -- --story undead-disaster --chapter 27
npm run story:repair -- --story undead-disaster --chapter 27 --stage narration --max-attempts 2
```

Batch manifests and terminal summaries aggregate pass/warn/fail totals and common issue categories. To reevaluate only QA and its downstream outputs, run `npm run story:batch -- --story undead-disaster --from 1 --to 10 --force qa`.

## Milestone 6 — Local Web Studio

Start the browser interface:

```sh
npm run web
```

Open [http://localhost:3000](http://localhost:3000). The server binds to `127.0.0.1` by default and keeps all provider credentials server-side. Set `WEB_PORT` if port 3000 is already in use.

The studio provides:

- A story shelf with import, processing, and QA status
- A paginated chapter ledger and original/translation/narration comparison desk
- Structured QA findings with messages and evidence
- TXT, EPUB, DOCX, and ranged Fanqie inspection/import
- Batch jobs with server-sent progress events and safe pause requests
- Isolated A/B model previews with short audio samples and profile selection
- A searchable, read-only Story Bible
- Zod-validated story, model, context, and Fish Audio settings
- Remote chapter discovery and optional additive import

Browser operations use validated story slugs and chapter numbers rather than arbitrary filesystem paths. Concurrent mutations for the same story are rejected by the job registry or existing story lock. Batch manifests remain durable even though the local job registry is intentionally in memory.

Create an optimized browser bundle with:

```sh
npm run web:build
```

## Milestone 7 — Audio Mastering and Audiobook Assembly

FFmpeg mastering is a first-class pipeline stage after TTS. It safely joins retained TTS segments, inserts the configured inter-segment pause, normalizes loudness, applies a true-peak limiter, and verifies the result with ffprobe. The default target is **-17 LUFS** with a **-1.5 dBTP** ceiling: a clear, consistent audiobook level in the recommended -18 to -16 LUFS range without aggressive compression.

Story-level settings live in `story.json` under `audio`:

```json
{
  "audio": {
    "loudnessTarget": -17,
    "truePeak": -1.5,
    "segmentGapSeconds": 0.35,
    "chapterGapSeconds": 1.5,
    "format": "mp3",
    "bitrate": "128k",
    "sampleRate": 44100
  }
}
```

Master or remaster a range without rerunning TTS:

```sh
npm run story:audio -- --story undead-disaster --from 1 --to 10
npm run story:audio -- --story undead-disaster --from 1 --to 10 --force
```

Build a cached audiobook edition:

```sh
npm run story:audiobook -- --story undead-disaster --from 1 --to 100 --format m4b
npm run story:audiobook -- --story undead-disaster --from 1 --to 100 --format mp3
```

Exports are written to `stories/<story>/exports/`. M4B files use AAC audio and include book/author metadata plus chapter titles and markers for bookmarking; an existing `cover.jpg`, `cover.jpeg`, or `cover.png` at the story root is attached when present. Artwork is never generated. Chapter mastering and audiobook assembly both use content fingerprints, so only changed work is rebuilt.

The studio’s **Audio / Export** view shows chapter status and duration, total mastered runtime, current mastering settings, range/format controls, final chapter playback, export history, downloads, and live job progress.

## Milestone 8 — Subtitles and Video Rendering

Subtitle timing is local and deterministic: narration is split into sentence/phrase-sized captions, weighted by estimated speech content, and distributed across the mastered chapter duration. The generated `subtitles.srt` and `subtitles.vtt` are cached from the narration fingerprint, mastered-audio fingerprint, subtitle settings, and generator version. No provider call is made.

```sh
npm run story:subtitles -- --story undead-disaster --from 1 --to 10
npm run story:video -- --story undead-disaster --from 1 --to 10
npm run story:video -- --story undead-disaster --from 1 --to 10 --subtitles none --force
npm run story:video-export -- --story undead-disaster --from 1 --to 100
```

Each chapter produces `video.mp4` beside its mastered audio and subtitle files. The default is 1920×1080 H.264/AAC at 30 FPS with a three-second title card and burned captions. `--subtitles` accepts `none`, `burn`, `soft`, or `both`; SRT and WebVTT remain separate regardless of the render choice. An existing story cover is used when present, Ken Burns motion is available, and a clean dark fallback is generated when no cover exists.

Burned captions require FFmpeg’s `subtitles` filter (libass), and title cards require `drawtext` (FreeType). The renderer checks these capabilities before starting and reports exactly which filter is missing. A minimal FFmpeg build can still render with `introDurationSeconds: 0` and subtitle mode `none` or `soft`.

Combined exports are written to `stories/<story>/exports/<story>-<from>-<to>.mp4` in numeric chapter order with container chapter markers. ffprobe validation requires H.264 video, AAC audio, the configured resolution, and a plausible duration. Subtitle and video fingerprints are independent: formatting changes do not rerun TTS or mastering, and video-setting changes invalidate only video.

The studio’s **Video** workspace presents the production as a real edit rail—mastered audio, subtitle timing, visual field, and chapter renders—alongside range controls, caption mode, playback, combined editions, downloads, and live job progress. Chapter detail pages include subtitle preview and MP4 playback.

## Milestone 9 — Scene Planning and Artwork

Scene planning runs after narration and audio mastering, using the final narration, chapter title, mastered duration, and the canonical Story Bible. Plans cover the complete audio timeline and are stored at `chapters/<chapter>/scenes.json`. The default target is one still every 20 seconds, with 10–30 second guidance and a 50-scene safety cap; all values are validated story settings.

```sh
npm run story:scenes -- --story undead-disaster --chapter 1
npm run story:scenes -- --story undead-disaster --from 1 --to 10 --force
npm run story:artwork -- --story undead-disaster --from 1 --to 10 --dry-run
npm run story:artwork -- --story undead-disaster --chapter 1 --scene scene-003
npm run story:artwork -- --story undead-disaster --from 1 --to 10 --force
```

Both commands require an explicit chapter or inclusive range so a mistyped command cannot create a large paid job. `--dry-run` reports exactly which images would be requested without validating credentials or calling a provider. Artwork is written separately as `chapters/<chapter>/scenes/scene-NNN.png`; scene plans and individual images have independent fingerprints, so a prompt edit regenerates only its changed scene and planning changes never rerun narration, TTS, or mastering.

Artwork configuration lives in `story.json`:

```json
{
  "scenes": {
    "targetDurationSeconds": 20,
    "minimumDurationSeconds": 10,
    "maximumDurationSeconds": 30,
    "maximumScenesPerChapter": 50
  },
  "artwork": {
    "provider": "openai",
    "model": "gpt-image-1",
    "stylePrompt": "cinematic illustrated fiction, dramatic natural lighting, consistent character design, widescreen composition",
    "aspectRatio": "16:9",
    "quality": "medium",
    "size": "1536x1024",
    "outputFormat": "png"
  }
}
```

Optional character references belong under `stories/<story>/assets/characters/<character>/profile.json`, with a `reference.png` beside the profile when available. Profiles can define `name`, `description`, `hair`, `clothing`, and `distinctiveFeatures`; their content and image fingerprints participate in artwork caching. The initial OpenAI provider uses the textual canonical profile in its prompt. The reference PNG is retained and fingerprinted for consistency and future image-conditioned providers.

The studio’s **Scenes / Artwork** workspace uses a film-strip timeline to edit timing, summaries, characters, locations, importance, and visual prompts; estimate and generate missing work; regenerate one scene; and mark results approved, rejected, or needing regeneration. Manual edits become the saved source of truth. Video rendering uses the scene timeline only when every image is present, fingerprint-valid, and approved; otherwise it safely retains the existing cover or generated-background fallback.

## Milestone 12 — Library and Project Management

The local studio now opens as a multi-story working archive. Projects can be searched, sorted, filtered, and viewed as a shelf or list with cover art, chapter/production progress, QA state, output badges, storage size, and recent local activity.

Use **New story** to create an original project or inspect and import a TXT, TXT chapter folder, EPUB, DOCX, or supported HTTPS web novel. Project creation and dependency/provider status checks never call a paid API. Missing credentials are reported from configuration presence only; secrets stay in `.env` and are never returned to the browser.

Each story’s **Manage project** screen supports metadata and cover changes, settings-only or full duplication, bounded ZIP backup/restore, categorized storage reporting, safe cleanup of regenerable media, and explicit title-confirmed deletion. Deletion moves the project to local recoverable trash rather than recursively deleting an unresolved path. Restore rejects absolute paths, traversal, lock/temp entries, oversized files, excessive expansion, and invalid project manifests. Cover changes invalidate chapter video only; text, QA, TTS, and mastered audio remain reusable.

Application defaults live in `.ai-story-studio/settings.json` and apply only when a new story is created. Existing story configurations are not rewritten when these defaults change.

## Milestone 15 — Advanced Story Bible and Continuity

The Story Bible now keeps portable canonical entities with stable IDs, canonical names and aliases, chronological status/timeline events, entity-to-entity relationships, confidence, and chapter provenance. Characters, locations, organizations, abilities, items, and broader concepts share the same relationship model. Automatic extraction never silently merges uncertain duplicates; the studio presents deterministic suggestions for explicit approval.

Manual canonical-name locks, alias edits, notes, and merges live in `story-bible-canonical-manual.json`. These protected overlays survive chronological rebuilds, and approved merges preserve aliases, history, relationships, provenance, and stable references. Merges can be undone from the entity detail view.

Every successfully extracted chapter runs a separately fingerprinted, local continuity stage. Findings are stored in `continuity-review.json`, with lightweight chapter references rather than copied manuscript passages. The **Continuity Review** workspace explains the supporting facts and lets an editor accept new information, retain the canonical record, mark an intentional inconsistency, correct the Bible, record a merge, or persistently dismiss a false positive. Re-run only this analysis with:

```sh
npm run story:continuity -- --story undead-disaster
npm run story:produce -- --story undead-disaster --from 1 --to 100 --force continuity
```

Translation, narration, QA, preview, and scene planning receive a deterministic, inspectable subset of the Bible instead of the full long-story history. The context is selected from chapter mentions, known aliases, locks, recent events, and relevant relationships, and is bounded before it reaches a provider. The canonical browser is server-paginated and supports type, name, alias, appearance, lock, provenance, duplicate, and conflict review for stories with thousands of entities.

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
