# Botified AgentSmith-Driven Change Retraction Plan

Status: implementation plan for the Botified development team.

## 1. Objective

Starting from the Botified team's latest `HEAD` at execution time, surgically
remove only the behavior introduced for AgentSmith by these commits:

1. `5f2e548` - `feat: support external bash executor`
2. `20ef986` - `feat: allow per-provider insecure HTTP`
3. `dcbac47` - `feat: add durable message delivery receipts`
4. `609e24e` - `feat: discard unfinished runtime state on cold open`
5. `4b9ab72` - `feat: add exact durable turn aborts`
6. `fc8505d` - `feat: add exact durable background stops`
7. `51b8277` - `feat: replay legacy lite delivery journals`
8. `fb17037` - `build: produce portable x86 release artifacts`
9. `385d393` - `release: prepare v0.4.41`

Preserve `08362ae`, `d0b8331`, and every later Botified team change that is not
owned solely by the nine commits above. `d0b8331` is a semantic reference for
the pre-AgentSmith behavior, not a tree to restore, a commit to revert, or a
source of whole-file replacements.

The resulting product has one Botified-owned behavior:

- `POST /v1/abort` is again the simple no-body, session-wide Abort command;
- there is no `/v1/tasks/stop` service endpoint;
- normal message admission has no AgentSmith delivery receipt protocol;
- runtime open has no `resume_unfinished` switch or cold-discard mode;
- Bash executes through Botified's local implementation, not an external
  executor protocol;
- provider HTTP remains restricted to the Botified team's pre-existing secure
  transport rule;
- AgentSmith Lite legacy journals receive no compatibility parser;
- Botified's team-owned release helper and Unitree R1 build targets are
  restored in their current-team-compatible form.

Fresh sessions are the corrected version's only session-compatibility promise.
Before deployment, delete or isolate every `v0.4.41`/AgentSmith test session
from the corrected runtime's session root. If an incompatible AgentSmith record
is encountered anyway, fail fast without rewriting the journal, then delete or
isolate that entire session. Do not add migration, dual-read, fallback parsers,
compatibility facades, record-by-record repair, or a second runtime path.

## 2. Non-Negotiable History And Release Rules

- Work on a normal branch from the latest team `HEAD` and create ordinary
  forward commits.
- Do not use `git reset`, force-push, history rewriting, tag deletion, tag
  movement, or tag recreation.
- Do not delete, move, or retag `v0.4.41`. Its source and published assets
  remain immutable historical release material.
- Do not revert or cherry-pick `d0b8331`; use it only to answer what the
  pre-AgentSmith contract meant.
- Do not restore complete files from `d0b8331`, a target commit parent, or
  `v0.4.40`. Later team work in the same files must survive.
- Do not lower the current package versions to `0.4.40`. Publish a new version
  greater than `v0.4.41` after the retraction.
- Keep the historical `v0.4.41` changelog entry truthful as a record of that
  immutable release. Add a new correction entry describing removals; do not
  rewrite the old release as if it had never shipped.
- Do not create evidence bundles, migration reports, governance reports, or
  generated retraction records.

The nine commits form a contiguous historical chain after `d0b8331`, but the
execution-time `HEAD` may contain later team work. A reverse patch is therefore
only a review aid. Its context never outranks current team-owned semantics.

## 3. Ownership, Interface, And Dependency Matrix

| Commit | AgentSmith-owned purpose | Public/config/session surface to remove | Direct dependencies inside this set | Shared areas requiring hunk review |
|---|---|---|---|---|
| `5f2e548` | Run Bash through an AgentSmith sidecar executor | `tools.execution.bash_executor_addr`, `BashTool::with_executor_addr`, TCP/NDJSON execute, output, stdin, cancel, and external-exit translation | none | `src/tools/bash.rs`, runtime assembly and config |
| `20ef986` | Permit AgentSmith's in-cluster plaintext provider broker | provider `allow_insecure_http`, `OpenAiCompatibleConfig::with_allow_insecure_http`, generalized HTTP/no-proxy handling | none | provider validation and runtime config |
| `dcbac47` | Give AgentSmith stable message delivery receipts | request `delivery_key` and `request_hash`; delivery-only response; `DeliveryIntake`, `DeliveryReceipt`, durable delivery admissions, replay, validation, and receipt errors | base for `4b9ab72` and `51b8277`; session overlap with `609e24e` | HTTP message admission, service enqueue, session replay/checkpoint/writer |
| `609e24e` | Cold-open a reused AgentSmith session without unfinished work | `runtime.resume_unfinished`, `open_runtime_session_in_home_with_cwd_and_resume`, runtime discard journal record and replay/checkpoint state | legacy discard handling is extended by `51b8277`; shares session identities with `dcbac47` | runtime config/assembly and all session modules |
| `4b9ab72` | Exact durable compare-and-Abort for AgentSmith, including durable turn lifecycle wrapping | Abort JSON body with `command_key` and `expected_turn_id`; abort receipts/outcomes; `TurnStarted`, `TurnTerminal`, `TurnTerminalReason`, `DurableTurnReplay`, active/latest-terminal authority; `durably_start_*`/`durably_terminalize_*`; exact-turn capability and TUI plumbing | uses durable session/intake patterns introduced by `dcbac47`; wraps normal enqueue/provider/retry/panic/shutdown/recovery paths that must be restored; base for stop token/receipt patterns in `fc8505d` | HTTP, service loop/control, input enqueue, session writer/checkpoint/replay/open, TUI |
| `fc8505d` | Exact durable stop for AgentSmith background tasks | `/v1/tasks/stop`, `stop_background_task`, stop request/response/outcomes, durable stop receipts and task cancellation bridge | `4b9ab72` token and durable control patterns; managed task subsystem | HTTP, service control, session, task coordinator/facade |
| `51b8277` | Read and normalize AgentSmith Lite legacy journals | CanonicalLegacy/raw legacy delivery variants, `LegacyCompatibility`, legacy payload digest, legacy `unfinished_work_discarded` replay/checkpoint handling | `dcbac47` delivery authority and `609e24e` discard machinery | attachments, HTTP delivery response, session replay/checkpoint |
| `fb17037` | Produce AgentSmith-requested portable x86 release artifacts | generalized release image, `build-x86`, `build-arm`, `release-core`, x86 GLIBC/Bookworm checks and renamed release Dockerfile | packages the preceding feature set but has no runtime dependency | Makefile, workflow, Dockerfile name, release helper tests |
| `385d393` | Publish the AgentSmith feature set as `v0.4.41` | version bumps, release changelog claims and deployment-doc version references | all preceding commits, especially `fb17037` | current version metadata and changelog |
| `08362ae` **preserve anchor** | Botified team compact identifier work, not an AgentSmith retraction target | compact ID encoding and validation, checkpoint/replay representation, and model-visible projection must remain | overlaps the target chain in session, callback, task, projection, and test code; it is not a dependency to remove | `src/session.rs`, `src/session/checkpoint.rs`, `src/session/replay.rs`, `src/service/subagent_runtime/callback.rs`, `src/service/task_projection.rs`, `src/tasks.rs`, `src/tasks/coordinator_state.rs`, `src/tasks/facade.rs`, related integration/projection tests |

Commit attribution is behavioral, not line-count based. For example, later
team changes to `src/session/replay.rs` remain team-owned even when they now
sit inside a function first touched by `dcbac47`.

## 4. Per-Hunk Ownership Rules

Apply these rules to every conflict or shared symbol:

1. Inspect the target commit's parent, the target commit, and current `HEAD` for
   the exact symbol. Do not decide from a three-way conflict marker alone.
2. Remove a hunk only when its continuing purpose is one of the AgentSmith
   interfaces in the matrix. Formatting, relocation, or a renamed symbol does
   not change that ownership.
3. Preserve later team behavior added to the same function, enum, struct,
   route group, replay accumulator, checkpoint pass, or test module. Rebuild
   the function without the AgentSmith branch instead of accepting either
   whole conflict side.
4. When a later team feature consumes an AgentSmith-created helper for a
   different product purpose, retain the later feature but replace its
   dependency with the smallest Botified-owned local equivalent. Do not keep
   the AgentSmith public interface merely because a later implementation
   reused an internal helper.
5. Remove enum variants, struct fields, error arms, imports, serializers, and
   test helpers only after all non-AgentSmith callers are accounted for.
   Exhaustive matches must be repaired around the remaining current variants.
6. In overlapping session code, assign the most recent target commit first:
   `51b8277` owns CanonicalLegacy/raw-legacy and legacy discard deltas;
   `fc8505d` owns background-stop receipts; `4b9ab72` owns durable exact-Abort
   state; `609e24e` owns runtime cold-discard state; `dcbac47` owns delivery
   admissions. Remove them in that order.
7. Treat `08362ae` as a protected shared-file anchor. Its compact ID encoding,
   validation, checkpoint/replay representation, and model-visible projection
   survive even when they occupy the same `SessionLine`, replay accumulator,
   callback, task facade, or test hunk as a target feature. Remove the
   AgentSmith record or branch around those semantics; never restore a
   pre-`08362ae` whole hunk that expands compact IDs or drops their validation.
8. For `4b9ab72`, classify the whole symbol family before editing:
   `TurnStarted`, `TurnTerminal`, `TurnTerminalReason`, `DurableTurnReplay`,
   active/latest-terminal replay fields, `AbortReceipt`, and
   `durably_start_*`/`durably_terminalize_*` writers and call sites were added
   together. Remove a schema or branch only when its remaining purpose is exact
   durable control, but remove that purpose coherently across writer,
   checkpoint, replay, open state, service state, projection, and tests. Do not
   leave a writer without a reader, a reader without a writer, or an active-turn
   gate whose receipt/control consumer has gone.
9. A line originally deleted by `fb17037` remains team-owned if it implemented
   a pre-existing build target or focused helper test. Restore its current
   equivalent, not necessarily its old spelling or byte-for-byte body.
10. Do not resurrect obsolete plan prose merely to make a reverse diff clean.
   Restore executable team build targets and their focused tests; documentation
   should describe only the resulting current product.
11. Tests introduced solely to prove a removed AgentSmith contract are removed.
   Later tests that also protect team behavior are narrowed to that behavior
   rather than deleted.
12. If attribution is still ambiguous, preserve the later team behavior and
    remove only the externally visible AgentSmith contract. Do not broaden the
    retraction into an unrelated refactor.

Useful comparisons are read-only:

```bash
git show <commit>^:<path>
git show <commit>:<path>
git show HEAD:<path>
git diff <commit>^ <commit> -- <path>
git log -L :<symbol>:<path>
```

Do not use a whole-file `git checkout <old-commit> -- <path>`.

## 5. Reverse-Dependency Retraction Slices

Implement the slices serially. Each slice leaves current team behavior
internally coherent before the next lower dependency is removed.

### Slice 1: Select The Corrective Version Without Editing Release Metadata

Use `385d393` to identify the old feature claims, but do not mechanically
reverse its version files.

- Leave tag `v0.4.41`, its commit, and published assets untouched.
- Keep the `v0.4.41` changelog section as historical release information.
- Select a target version greater than `v0.4.41` according to current team
  release policy so implementation and asset naming have one destination.
- Do not yet edit `Cargo.toml`, `Cargo.lock`, gateway package files, changelog,
  release docs, deployment examples, asset names, or checksums.
- Do not create an interim changelog entry or claim wire/session compatibility
  with `v0.4.41`.

All version, changelog, documentation, and asset metadata changes are deferred
to the single final release-preparation step after the code and build slices
are coherent.

### Slice 2: Retract The AgentSmith Build Rewrite

Reverse only the build behavior owned by `fb17037`, reconciled with current
team changes.

- Restore the team-owned `unitree-image`, `build-r1`,
  `package-core-r1`, `release`, and `release-all` responsibilities, or their
  current team-renamed equivalents.
- Restore `TARGET_R1`, R1 release directory/linker settings,
  `MAX_R1_GLIBC`, and the Unitree aarch64 release Dockerfile role where later
  team work has not superseded them.
- Restore the `release-tools-test` target, its invocation from
  `release-build`, and the release workflow's focused helper-test step.
- Restore the Unitree image retry test and the calls removed from
  `tests/local_release_test.sh` and `tests/release_ci_test.py`, adapting only
  for legitimate later team changes.
- Remove AgentSmith-only `release-image`, formal `build-x86`/`build-arm`,
  `package-core-x86`/`package-core-arm`, `release-core`, x86 GLIBC ceiling,
  Bookworm smoke image, and platform forcing unless a later independent team
  commit now owns a specific piece.
- Resolve the Dockerfile rename by retaining the filename expected by the
  restored current build targets. Do not keep two aliases.

Do not restore the deleted release-distribution planning document as a proof
artifact. The executable targets and their focused tests are the source of
truth.

### Slice 3: Remove AgentSmith Lite Journal Compatibility

Retract `51b8277` before removing its delivery and discard foundations.

- Remove raw legacy delivery parsing, CanonicalLegacy authority/admission
  variants, `canonical_legacy` responses, legacy payload hashing, and
  `SessionError::LegacyCompatibility`.
- Restore the current delivery authority to the single modern form temporarily
  required by `dcbac47`; Slice 7 removes that form entirely.
- Remove special parsing and checkpoint emission for the legacy
  `unfinished_work_discarded` record, including selective legacy message and
  projection ID sets.
- Remove legacy-only attachment helpers and HTTP response discrimination while
  retaining ordinary attachment parsing and later team attachment work.
- Delete legacy fixture tests. Do not replace them with migration or
  compatibility tests.

An old Lite journal may fail to open after this slice. That is accepted.

### Slice 4: Remove Exact Durable Background Stop

Retract `fc8505d` while exact Abort still exists for any shared helper use.

- Remove the `/v1/tasks/stop` route, request/response types, status mapping, and
  background-stop-specific API errors.
- Remove `Service::stop_background_task`, durable stop receipt maps, journal
  records, checkpoint/replay handling, test hooks, and service errors.
- Remove only the managed-task cancellation methods and coordinator fields
  added for this endpoint. Preserve the team's normal task lifecycle, existing
  slash commands, task cancellation semantics, callbacks, and retention work.
- Remove `src/service/tests/background_stop.rs` and stop-only HTTP tests.

No replacement stop endpoint or compatibility alias is introduced.

### Slice 5: Restore Simple No-Body Abort

Retract `4b9ab72` and restore the semantic contract visible at `d0b8331`,
adapted to current team internals:

```text
POST /v1/abort
request body: none
success: 200
response: { "ok": true, "queue_length": <number>, "state": <service-state> }
```

- The handler authenticates, invokes `Service::abort()` with no command key or
  expected turn ID, and returns current `ServiceStatus`.
- Remove `AbortRequest`, exact target validation, durable Abort outcomes and
  receipts, command-key mismatch errors, HTTP 202/409 exact-control mapping,
  and abort receipt journal/checkpoint/replay state.
- Attribute the complete `4b9ab72` turn-journal family explicitly:
  `SessionLine::TurnStarted`, `SessionLine::TurnTerminal`,
  `TurnTerminalReason`, `DurableTurnReplay`, its `active_turn_id`,
  `latest_terminal`, and abort-receipt collections, corresponding open/runtime
  fields, replay accumulators and validation, checkpoint emission, writer
  methods, and service-state `latest_terminal_turn` were introduced to make
  exact Abort durable and replayable.
- Likewise attribute `durably_start_turn`, `durably_start_followup_turn`,
  `durably_start_and_finalize_enqueue`, `durably_terminalize_turn`, and their
  enqueue, provider completion, retry, panic, shutdown, and recovery call sites
  to the `4b9ab72` wrapping unless a later independent team commit owns a
  specific surviving behavior.
- Remove the entire turn-journal schema and its service branches when, after
  reviewing later `HEAD`, they still serve only exact control. This means
  removing records, serializers, writers, checkpoint/replay/open state,
  admission gates, terminal-reason branches, capability projection, and
  exact-control tests as one coherent unit. Do not retain `TurnStarted` or
  `TurnTerminal` merely because normal execution was routed through them by
  `4b9ab72`.
- If a later team change independently requires a turn ID for timeline,
  diagnostics, model behavior, or another current product contract, preserve
  that later behavior using its smallest team-owned representation. It does not
  justify retaining `DurableTurnReplay`, latest-terminal authority, an exact
  Abort capability, or an orphan journal half.
- Remove exact-Abort capability projection and TUI command-key/turn-ID request
  plumbing. Preserve `08362ae` compact ID encoding, validation,
  checkpoint/replay representation, and model-visible projection wherever
  those protected semantics share a session or task hunk.
- Restore the simple idempotent service semantics: Running transitions to
  Aborting and signals the active cancellation token; Idle, Aborting, Failed,
  and ShuttingDown return current status without a durable command receipt.
- Reconstruct the pre-`4b9ab72` normal flow, adapted to current team code:
  ordinary enqueue publishes work without a turn-journal admission gate;
  provider completion and provider retry continue through their normal paths;
  panic and shutdown still clear/cancel the active request according to the
  team's current semantics; startup and active-request recovery still restore
  normal queued/pending work. Preserve later team service-loop, queue,
  provider, subagent, callback, event-ordering, panic, shutdown, and recovery
  fixes hunk by hunk.
- Check writer, checkpoint, replay, open state, service state, HTTP, TUI, and
  focused tests together before completing the slice. No half journal is
  allowed: no orphan record variant, replay field, terminalization helper,
  active/latest-terminal authority, or compatibility parser may remain.

Do not retain a hidden exact-Abort overload.

### Slice 6: Remove Runtime Cold Discard

Retract `609e24e`.

- Remove `runtime.resume_unfinished` from config parsing, defaults,
  serialization, setup output, and runtime assembly.
- Restore one runtime open API equivalent to
  `open_runtime_session_in_home_with_cwd(name, home, cwd)`.
- Remove `open_runtime_session_in_home_with_cwd_and_resume`, the
  `OpenKind::Runtime { resume_unfinished }` branch, runtime unfinished-discard
  records, replay flags, discarded ID sets, writer truncation helpers created
  for discard, and checkpoint discard behavior.
- Preserve ordinary restart-boundary recovery, compaction, pending messages,
  task recovery, and all later team session performance/correctness work.
- Remove cold-discard tests rather than adding old-session migration tests.

This slice does not make old journals compatible. The corrected version's
fresh-session deployment boundary below applies.

### Slice 7: Remove Durable Delivery Receipts

Retract `dcbac47` after its dependent compatibility and exact-control features
are gone.

- Remove `delivery_key` and `request_hash` parsing and validation from
  `/v1/messages`.
- Restore the normal message path based on `client_message_id` or a generated
  message ID, ordinary enqueue, and the team's current normal
  `MessageResponse`.
- Remove delivery-only response bodies, `DeliveryIntake`,
  `DeliveryReceipt`, delivery request/admission types, delivery-key mismatch
  errors, replay maps, payload digests, and durable delivery session records.
- Simplify enqueue preflight, persistence, publication, rollback, checkpoint,
  and replay only where the extra branch exists. Preserve normal durable input,
  queue, callback, cursor, and active-request recovery.
- Remove receipt/replay HTTP and session tests; retain ordinary duplicate
  message-ID and queue persistence tests.

There is no GET receipt endpoint, POST receipt compatibility mode, or dual
message schema after this slice.

### Slice 8: Restore Strict Provider Transport

Retract `20ef986`.

- Remove provider `allow_insecure_http` from runtime YAML and
  `OpenAiCompatibleConfig`.
- Remove `with_allow_insecure_http` and the generalized
  `is_http_provider_base_url` behavior.
- Restore the current equivalent of the prior rule: HTTPS is accepted;
  plaintext HTTP is accepted only for the already-supported literal loopback
  case.
- Apply `no_proxy` only under the team's pre-existing loopback rule.
- Remove tests for explicitly allowed non-loopback HTTP while preserving
  credential redaction, redirect, URL validation, and later provider tests.

Do not introduce an AgentSmith hostname allowlist or environment override.

### Slice 9: Restore Botified-Local Bash

Retract `5f2e548` last.

- Remove `tools.execution.bash_executor_addr` and its validation.
- Remove `BashTool::with_executor_addr`, external executor state, TCP/NDJSON
  request/response/control types, remote stdin/cancel handling, external frame
  limits, exit-status synthesis, and executor-specific errors.
- Restore runtime assembly to construct the current local `BashTool` and apply
  the team's secret-environment filtering.
- Keep the current Botified-local process execution, output accounting,
  detach, timeout, cancellation, stdin, frame scanning, and later team Bash
  improvements.
- Remove executor-only tests. Retain focused tests for the surviving local Bash
  behavior.

There must be no dormant external-executor configuration or fallback branch.

### Fresh-Session Deployment Boundary

Fresh sessions are the sole session contract of the corrected release:

- Before deploying it, delete or isolate all known `v0.4.41`/AgentSmith test
  sessions and ensure they are outside the corrected runtime's session root.
- Do not use an old session as a release acceptance fixture. Create a fresh
  session under the corrected binary and exercise only the surviving current
  journal format.
- If open encounters an incompatible AgentSmith-only record, fail fast before
  truncating, checkpointing, appending, or otherwise mutating that session.
  Delete or isolate the entire incompatible session before retrying.
- Do not migrate, normalize, selectively skip, dual-read, or translate old
  records. Do not retain `v0.4.41` readers behind a feature flag or fallback.
- Session contents are disposable at this boundary; code and release assets are
  not. `v0.4.41`, its tag, and its published release remain immutable.

## 6. Focused Verification

Run only focused checks selected for the changed behavior, serially. Do not
create a gate wrapper or report.

Minimum behavior checks:

1. HTTP Abort: an authenticated no-body `POST /v1/abort` returns the simple
   status response while Running and while already Idle/Aborting.
2. Route absence: `/v1/tasks/stop` is not registered.
3. Message admission: a normal message uses the ordinary response and no
   delivery receipt fields or replay authority.
4. Runtime config: `resume_unfinished`, `bash_executor_addr`, and
   `allow_insecure_http` are not accepted configuration fields.
5. Provider transport: HTTPS and literal-loopback HTTP follow the retained team
   rule; non-loopback plaintext HTTP is rejected.
6. Bash: one local command covers output, cancellation, and secret filtering
   through the surviving local implementation.
7. Session: a fresh corrected-version session opens and reopens through the
   single session path; an incompatible AgentSmith-only record fails fast
   without changing the journal. Use only a minimal incompatible-record check,
   not a migration, dual-read, or old-session acceptance fixture.
8. Build surface: focused Makefile/workflow helper tests confirm the restored
   team release helper and R1 targets. Do not run an actual release build merely
   to prove target names.

Use existing test modules where possible. Delete AgentSmith-only tests in the
same slice as their implementation. Do not run broad integration, live
provider, container release, or full release publication checks unless a
focused failure shows that one is necessary.

## 7. Corrective Release

After all code/build slices and focused checks:

1. confirm the branch is based on the execution-time latest team `HEAD` and
   contains no reverse merge, history rewrite, or tag mutation;
2. confirm the nine AgentSmith surfaces are absent while unrelated later team
   work and the `08362ae` protected semantics remain;
3. in one final release-preparation change, set the previously selected version
   greater than `0.4.41` across `Cargo.toml`, `Cargo.lock`, gateway package
   files, and any other current package metadata;
4. in that same change, add the new correction changelog entry and update only
   current-version docs, deployment examples, asset names, and checksums to
   match the completed code/build result; keep the historical `v0.4.41`
   changelog and release material unchanged;
5. state that the removed API/config/session surfaces are intentionally
   incompatible and that fresh sessions are the corrected release's only
   promise;
6. publish a new annotated version and newly generated assets through the restored
   team-owned release path.

`v0.4.41` remains available and immutable. The correction is represented only
by new forward commits and the new release. No version, changelog, release-doc,
or asset metadata is changed before this final release-preparation step.

## 8. Completion Conditions

The retraction is complete when:

- all nine commits remain in history but none of their AgentSmith-only runtime,
  API, compatibility, or build behavior remains at the corrected `HEAD`;
- `08362ae` compact ID encoding, validation, checkpoint/replay representation,
  and model-visible projection, `d0b8331`-compatible product semantics, and
  unrelated later team changes remain intact;
- Abort is simple and bodyless;
- `/v1/tasks/stop`, delivery receipts, `resume_unfinished`, external Bash,
  non-loopback insecure HTTP opt-in, and Lite journal compatibility are absent;
- the current equivalent of the Botified team's release helper and Unitree R1
  build targets is restored;
- there is one fresh-session reader, incompatible AgentSmith records fail fast
  without mutation, and no migration or dual-read path exists;
- `v0.4.41` and its tag are unchanged;
- code/build retraction precedes one final version/changelog/docs/assets update,
  and a higher corrective version is published using ordinary forward history;
- verification consists only of focused product and build-surface tests, with
  no generated governance or evidence report.
