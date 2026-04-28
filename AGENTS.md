# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Setup and common commands

- Requirements: Node.js >= 20.9.0, pnpm >= 10.
- `pnpm install` — install dependencies. Root `postinstall` also builds the workspace packages in `packages/mathml2omml` and `packages/pptxgenjs`.
- `cp .env.example .env.local` — base env setup.
- Current branch note: the auth-enabled app also needs `AUTH_SECRET` for login/session creation. `TEACHER_INVITE_CODE` is optional for teacher self-registration. Optional seed admin envs exist: `AUTH_SEED_ADMIN_USERNAME` and `AUTH_SEED_ADMIN_PASSWORD`.
- Server-side provider config can come from `.env.local` and/or `server-providers.yml`.

### Run the app

- `pnpm dev` — start the Next.js dev server.
- `pnpm build` — production build.
- `pnpm start` — serve the production build.

### Linting and formatting

- `pnpm lint`
- `pnpm check` — Prettier check.
- `pnpm format` — Prettier write.
- `pnpm exec eslint app/page.tsx`
- `pnpm exec prettier app/page.tsx --check`

### Tests

- `pnpm test` — run Vitest.
- `pnpm exec vitest run tests/server/middleware-auth.test.ts`
- `pnpm exec vitest run tests/server/learning-store.test.ts -t "creates"`
- `pnpm test:e2e` — run Playwright.
- `pnpm exec playwright test e2e/tests/auth-and-prototype-flow.spec.ts`
- `pnpm test:e2e:ui`

### E2E test runner details

- Playwright uses `e2e/tests`.
- Local Playwright runs against `http://localhost:3002` and starts its own web server with `PORT=3002`.
- In CI, Playwright uses `pnpm build && pnpm start`; locally it uses `pnpm dev`.

## High-level architecture

### App model

- This is a Next.js 16 App Router app.
- `app/layout.tsx` installs theme/i18n providers and mounts `components/server-providers-init.tsx`, which syncs server-configured providers into the client settings store.
- `middleware.ts` enforces session auth for almost everything. `/login`, `/register`, `/api/auth/*`, and `/api/health` are public. `/`, `/generation-preview`, and `/teacher` are teacher/admin-only surfaces; students are redirected to `/student`.

### Two classroom-generation paths

#### 1. Interactive client-first flow

This is the main browser flow used by the home page.

- `app/page.tsx` collects the requirement, optional PDF, language, web-search toggle, and current provider/settings state.
- `app/generation-preview/page.tsx` performs the upfront generation pipeline in the browser session:
  - parses the PDF if present,
  - optionally runs web search,
  - optionally generates agent profiles in auto-agent mode,
  - streams outlines from `/api/generate/scene-outlines-stream`,
  - generates the first scene content/actions/TTS,
  - seeds `useStageStore`, stores continuation params in `sessionStorage`, and navigates to `/classroom/[id]`.
- `app/classroom/[id]/page.tsx` then loads the stage and resumes background generation for the remaining scenes/media via `useSceneGenerator`.

Important consequence: the preview page only guarantees the first scene before navigation. Remaining scene generation continues from the classroom page.

#### 2. Server-side async generation flow

This is the hosted / API-oriented flow.

- `POST /api/generate-classroom` creates a JSON job in `data/classroom-jobs` and schedules `runClassroomGenerationJob()`.
- `lib/server/classroom-generation.ts` runs the full pipeline server-side: model resolution, optional web search, outline generation, scene generation, optional media/TTS generation, and final persistence.
- Results are stored in `data/classrooms` and polled through `GET /api/generate-classroom/[jobId]`.
- This flow is the better mental model for hosted usage and the `skills/openmaic` integration.

### Classroom runtime

- `components/stage.tsx` is the main classroom shell. It coordinates the scene sidebar, canvas/stage area, roundtable UI, playback engine, and chat area.
- `lib/store/stage.ts` is the central runtime store for the current stage/scenes/chats/generation status.
- `lib/store/settings.ts` is the persisted global settings store for model/provider/audio/agent/layout preferences.
- Scene rendering is split by type:
  - slide editing/rendering: `components/slide-renderer/*`
  - scene-specific renderers: `components/scene-renderers/*` (quiz, interactive, PBL)

### Shared action model for lecture playback and live chat

- `Scene.actions[]` is the common execution format.
- `lib/playback/engine.ts` replays scripted lecture actions for classroom playback.
- `lib/action/engine.ts` is the unified execution layer for actions such as speech, whiteboard operations, spotlight/laser, and video playback.
- The same action vocabulary is also used during live multi-agent chat, so fixes to action execution usually affect both playback and discussion paths.

### Stateless multi-agent chat

- `/api/chat` is stateless SSE: the client sends full message history plus store state on every turn.
- `lib/orchestration/director-graph.ts` uses LangGraph as the director/orchestrator that chooses the next speaking agent and streams structured events.
- The server does not hold a long-lived chat session; interruption/resume behavior is mostly a client concern.

### Providers and model resolution

- Client-side model/provider selection lives in `lib/store/settings.ts`.
- Server-side provider resolution lives in `lib/server/provider-config.ts`.
- Server config is built from `server-providers.yml` plus environment variables.
- `/api/server-providers` exposes only provider metadata/base URLs/models; secrets stay server-side.
- `components/server-providers-init.tsx` fetches that metadata and merges it into the client store on most pages.

### Persistence layers

#### Browser-side persistence

- Dexie/IndexedDB schema is in `lib/utils/database.ts`.
- `lib/utils/stage-storage.ts` persists stages, scenes, current scene selection, chats, and thumbnails.
- IndexedDB is also used for:
  - audio blobs,
  - generated media,
  - persisted outlines for resume-on-refresh,
  - generated agent profiles.

#### Server-side persistence

Server data is JSON-file-backed under `data/`:

- `data/classrooms` — persisted generated classrooms.
- `data/classroom-jobs` — async classroom generation jobs.
- `data/auth/users.json` — auth users.
- `data/learning/store.json` — teacher/student learning data.

`app/classroom/[id]/page.tsx` explains the load order: try IndexedDB first, then fall back to server-side classroom storage through `/api/classroom`.

### Auth and role-specific surfaces

- Session token creation/verification lives in `lib/server/auth/session.ts`.
- User storage lives in `lib/server/auth/storage.ts`.
- Auth API routes are under `app/api/auth/*`.
- Teacher and student dashboards are separate route surfaces:
  - `app/teacher/page.tsx`
  - `app/student/page.tsx`
- The learning dashboard backend is `app/api/learning/route.ts`, backed by `lib/server/learning-store.ts`.

### Learning / dashboard subsystem

The current branch adds a second major product surface alongside the classroom generator.

- Teachers create/publish/assign structured programs from the teacher dashboard.
- Students accept assignments, launch linked classrooms, mark lessons in progress/completed, and report stuck points.
- This subsystem is separate from the main classroom runtime but shares auth/session infrastructure and can reference classroom IDs as lesson content.

### Important invariants that are easy to miss

- Media placeholder IDs such as `gen_img_1` / `gen_vid_1` are not globally unique; they are only unique within a stage. The codebase works around this by keying persisted media by `stageId` and clearing media/whiteboard state on classroom switches.
- Generated agents can be persisted both in IndexedDB and embedded into server-generated stage payloads; when debugging agent selection, check both the stage data and the agent registry hydration path.

### Workspace packages and external integration

- `packages/mathml2omml` and `packages/pptxgenjs` are local workspace packages; they are built during install and transpiled by Next (`next.config.ts`).
- `skills/openmaic` contains the OpenClaw/ClawHub integration. That integration aligns more closely with the server-side async generation APIs than with the browser-only generation preview flow.
