# Scanner Map Modernization Roadmap

This roadmap breaks the larger architecture work into reviewable PRs. Each phase should preserve current behavior while creating room for deeper changes.

## Phase 1: Foundations

- Add shared config parsing and validation.
- Add a migration module that can replace scattered table creation over time.
- Add ingestion normalization helpers for SDRTrunk, TrunkRecorder, and rdio-scanner compatible uploads.
- Add a local demo data generator.
- Add smoke tests and CI.
- Add role and permission primitives that can back future RBAC.

## Phase 2: Runtime Integration

- Replace scattered `process.env` reads in `bot.js`, `webserver.js`, and `geocoding.js` with the shared config module.
- Move database initialization to the migration runner.
- Route upload handling through the ingestion normalization helpers.
- Keep the old endpoint behavior intact while shrinking request-handler complexity.

## Phase 3: Reliable Processing Queue

- Persist call processing jobs in SQLite or a dedicated queue backend.
- Track job state: pending, processing, failed, complete, and retryable.
- Retry transcription, geocoding, categorization, Discord publishing, and storage steps independently.
- Add admin visibility for queue depth, failed jobs, and processing latency.

## Phase 4: Local Demo And Developer Mode

- Add a demo server mode that serves sample calls without SDRTrunk, TrunkRecorder, Discord, geocoding keys, or audio hardware.
- Add sample talkgroups, categories, and map markers.
- Make frontend work possible with one command.

## Phase 5: Frontend Modules

- Split `public/app.js` into modules for map setup, markers, audio playback, live feed, auth, talkgroup modal, purge modal, and geocoding search.
- Gate verbose browser logging behind a debug flag.
- Add targeted browser smoke tests once the local demo mode exists.

## Phase 6: Data Model And Retention

- Add schema versioning and repeatable migrations.
- Add indexes for common call history, talkgroup, timestamp, and category queries.
- Add configurable retention rules for calls and audio.
- Add database maintenance docs for long-running deployments.

## Phase 7: Roles And Permissions

- Add a `role` column for users and migrate existing admin users.
- Replace ad hoc admin checks with permission checks.
- Introduce viewer, editor, moderator, and admin roles.
- Add UI controls only when the current user has the matching permission.

## Phase 8: Adapter Architecture

- Formalize ingestion adapters for SDRTrunk, TrunkRecorder, and rdio-scanner compatible uploads.
- Add adapter tests with real-world fixture payloads.
- Make future upload sources additive instead of route-handler rewrites.
