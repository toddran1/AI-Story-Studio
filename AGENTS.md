# AI Story Studio

## Project overview

AI Story Studio is a local, provider-agnostic production studio that turns Chinese web novels (or original drafts) into English audiobooks and chapter videos. The pipeline is:

`Chinese TXT → translation → narration polish → Story Bible → Fish Audio TTS → FFmpeg mastering → subtitles/alignment → video/audiobook exports`

Key architectural facts:

- **Language/runtime**: TypeScript (ES modules, `"type": "module"`), Node.js >= 22. No compile step for the backend — everything runs through `tsx`.
- **Apps** live in `apps/`: `apps/cli/` (one entry file per command, run via npm scripts), `apps/server/` (localhost-only API + job manager for the browser studio), `apps/web/` (React 19 SPA built with Vite, root `apps/web`, output `dist/web`).
- **Core logic** lives in `src/`, one directory per domain: `pipeline`, `translation`, `narration`, `story-bible`, `qa`, `tts`, `audio`, `subtitles`, `alignment`, `video`, `scenes`, `artwork`, `production`, `batch`, `queue`, `source` (ingestion: TXT/EPUB/DOCX + Fanqie web adapter), `studio`, `config`, `cost`, `llm`, `preview`, `errors`, `storage`, `utils`.
- **Vendor isolation**: provider-specific code exists *only* in `src/llm/openai` (Responses API, JSON Schema structured output), `src/llm/gemini` (Interactions API), and `src/tts/fish`. Everything else talks to generic LLM/TTS contracts. Remote transport/caching is in `src/source/web`; Fanqie specifics in `src/source/fanqie`.
- **Storage is filesystem-authoritative.** Stories live under `stories/<slug>/` (and durable data under `STUDIO_DATA_ROOT`). `chapter.json` records status, fingerprints, provider/model, timings, errors, prompt versions, and usage per stage. Stage reuse verifies recorded output fingerprints rather than metadata alone. Postgres (via `pg`, migrations in `migrations/`, applied with `npm run db:migrate`) is used **only** for durable production-queue coordination, never for content.
- Production orchestration: `src/production` with resumable manifests under `stories/<story>/production-runs/`; batch runs under `stories/<story>/batches/`.

## Build and test commands

- `npm install` — install dependencies (packageManager is yarn 1, but npm scripts are the documented interface).
- `npm test` — Vitest (`vitest run`), tests in `tests/**/*.{test,spec}.{ts,tsx}`. Tests use fake LLMs and mocked Fish Audio responses; they must never make paid API calls. PGlite is used for queue tests without a real Postgres.
- `npm run typecheck` — `tsc --noEmit` (strict mode, ES2022 target, NodeNext modules, react-jsx).
- `npm run web` — dev server (API + Vite) on http://localhost:3000 (binds 127.0.0.1; `WEB_PORT` to change). Starts one conservative production worker when `DATABASE_URL` is set.
- `npm run web:build` — optimized browser bundle to `dist/web`.
- `npm run smoke` — explicit real-credential smoke test on the short project-authored Chinese fixture (this one *does* call paid APIs).
- `docker compose up -d postgres && npm run db:migrate` — start Postgres (localhost port 5433) and apply migrations.

## CLI entry points

Every CLI command is a thin `apps/cli/*.ts` file exposed via an npm script: `story:process`, `story:batch`, `story:inspect`, `story:import`, `story:update`, `story:refresh`, `story:repair`, `story:preview`, `story:profile`, `story:audio`, `story:audiobook`, `story:subtitles`, `story:align`, `story:video`, `story:video-export`, `story:scenes`, `story:artwork`, `story:produce`, `story:queue`, `story:worker`, `story:continuity`, `story:cost`, `db:migrate`. Pass arguments after `--`, e.g.:

```sh
npm run story:produce -- --story undead-disaster --from 1 --to 25 --profile audiobook --dry-run
```

## Configuration and secrets

- Copy `.env.example` to `.env` (loaded with `dotenv`). Contains API keys (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `FISH_AUDIO_API_KEY`), model defaults, `STUDIO_DATA_ROOT`, `DATABASE_URL`, provider timeouts, alignment (whisper.cpp) settings, and `WEB_*`/`QUEUE_*` tuning. **Never commit `.env` or read it into agent output.** Secrets stay server-side and are never returned to the browser.
- Per-story configuration lives in `stories/<slug>/story.json` (Zod-validated): provider/model choices per stage, audio mastering settings, scene/artwork settings, `productionProfiles`. Application defaults for *new* stories are in `.ai-story-studio/settings.json`; existing stories are never rewritten.
- Model IDs are configuration, not code — change them in `story.json`/`.env` without editing source.

## Code style guidelines

- Strict TypeScript, ES modules with explicit imports, NodeNext module resolution (use `.js`-style extension conventions the existing files use if any; match neighboring files).
- Validation with **zod** at every boundary (story config, API requests, provider responses).
- Prompts and prompt versions live outside orchestration logic; prompt versions are recorded in `chapter.json`.
- **Atomic writes**: same-directory temporary file followed by rename; stage reuse verifies the output file's recorded fingerprint.
- Every expensive stage is fingerprinted and resumable; forcing a stage (e.g. `--force narration`) regenerates it and its dependents only.
- Story context passed to LLMs is canonical structured knowledge plus a bounded window of recent chapter summaries (`context.recentChapterSummaries`) — never every earlier chapter.
- Manual edits are protected overlays (`story-bible-manual.json`, `story-bible-canonical-manual.json`, manual subtitle cues) and must survive automatic regeneration.
- Chapters process strictly in ascending order (later chapters depend on earlier Story Bible state). Commands that mutate one story take a per-story lock.
- Retries: bounded exponential backoff with jitter for transient provider failures; per-request deadline via `PROVIDER_TIMEOUT_MS`.
- Logging via `pino`; async jobs report progress over SSE in the web studio.

## Testing instructions

- Run `npm test` and `npm run typecheck` before considering work done.
- Tests are colocated under `tests/` (flat `*.test.ts` files plus `tests/fixtures` and `tests/examples`); helpers in `tests/helpers.ts`.
- Always use fake LLMs / mocked provider responses in tests. Paid API calls in tests are forbidden. Only `npm run smoke` uses real credentials, explicitly.
- Queue tests use `@electric-sql/pglite` (`tests/queue-pglite.test.ts`); `tests/queue-postgres.integration.test.ts` requires real Postgres.

## Security considerations

- The web server binds to `127.0.0.1` only; browser endpoints accept validated story slugs and chapter numbers, never arbitrary filesystem paths.
- Remote ingestion (Fanqie) is HTTPS-only with redirect validation, bounded retries/timeouts, streaming response-size limits, rate limiting, and ETag/Last-Modified cache revalidation.
- EPUB/DOCX ZIP containers are rejected when compressed/expanded size, entry size, or entry count limits are exceeded. Backup restore rejects absolute paths, traversal, and oversized/expansion-bomb archives.
- Forced alignment (`src/alignment`) runs locally via whisper.cpp `whisper-cli`; no audio bytes leave the machine. Audio is passed by path and hashed as a stream.
- Story deletion moves projects to recoverable trash; exports only expose known artifacts.
- Generated stories, private text, audio, `.env`, logs, dependencies, and build output are git-ignored — keep it that way.

## External requirements

- FFmpeg + ffprobe on `PATH` (or `FFMPEG_PATH`/`FFPROBE_PATH`); burned subtitles need libass, title cards need drawtext/FreeType.
- Optional whisper.cpp `whisper-cli` + GGML model for true forced alignment (deterministic estimated timing is the fallback).
- Postgres 15+ for the durable production queue (optional for synchronous CLI work).

## Further reading

- `README.md` — milestone-by-milestone behavior, command examples, artifact layout.
- `docs/provider-costs.md` — provider usage, budget guards, cost analytics.
