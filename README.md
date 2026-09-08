# AI Story Studio

Milestone 1 is a CLI-first, provider-agnostic vertical slice:

`Chinese TXT → translation → narration polish → Story Bible → Fish Audio → MP3`

The pipeline preserves every intermediate artifact, fingerprints stage inputs, and resumes at the first stale or failed stage. OpenAI and Gemini are isolated behind one LLM contract; Fish Audio is isolated behind the TTS contract.

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

The result is stored under:

```text
stories/demo-story/
├── story.json
├── pipeline.json
├── story-bible.json
└── chapters/0001/
    ├── chapter.json
    ├── original.txt
    ├── english.txt
    ├── narration.txt
    ├── story-bible-update.json
    └── audio.mp3
```

Long narration is split at paragraph and sentence boundaries. Individual MP3 responses are retained in `audio-segments/` when splitting is required, and their byte streams are concatenated into `audio.mp3`, which is supported by ordinary MP3 players. A later audio-mastering milestone can replace this join strategy with FFmpeg without affecting TTS or pipeline contracts.

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
- OpenAI uses the Responses API and JSON Schema structured output.
- Gemini uses the Interactions API and JSON response format.
- Prompts and prompt versions live outside orchestration logic.
- `chapter.json` records status, fingerprints, provider/model, timings, errors, prompt versions, and available usage/request metadata per stage.
- Writes use same-directory temporary files followed by atomic rename.
- Story context contains canonical structured knowledge and earlier summaries, never every earlier chapter.
- Existing canonical translations win during Story Bible merges; conflicting new names become aliases where applicable.

Generated stories, private text, audio, `.env`, logs, dependencies, and build output are ignored by git.

## API references

- [OpenAI Responses API](https://developers.openai.com/api/reference/typescript/resources/responses/methods/create)
- [Gemini Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Fish Audio text-to-speech endpoint](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
