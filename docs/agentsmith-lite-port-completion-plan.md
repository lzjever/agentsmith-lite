# AgentSmith Lite Port Completion Plan

## Purpose and Rules

Complete the retained AgentSmith workspace experience as independently demoable
vertical slices. This is a handoff implementation plan, not an audit, report,
or release procedure.

The reference application in `../.reference/agentsmith` is the user-experience
baseline. A reference capability is `REQUIRED_PORT` unless this document's
explicit-exclusion table names it. `MERGED_SINGLE_PATH` is permitted only when
Lite preserves the same user outcome through one simpler server-owned path.
Current absence, complexity, or a narrower old Lite contract never justifies
exclusion.

Each slice owns its contract, authorization, store, immutable migration when
needed, HTTP API, client, reachable UI, normal/loading/empty/error/no-permission
states, and focused tests. Do not split a user path into API-only and later UI
milestones. Each retained audit-worthy project operation and lifecycle
transition writes its own allowlisted light-audit action; audit is not deferred
to a final cleanup phase. Ordinary profile and context edits are not audited by
default.

Web is a product API client only. It must not import application, ports,
database, K8s, Botified, sandbox, or provider internals. Server code owns
authorization, validation, state changes, file safety, broker calls, lifecycle,
and cleanup. AgentSmith server interacts with Botified exclusively through
Botified service APIs.

A small in-process application service is allowed where it simplifies a
server-owned path. Do not add a deployable service, repository, control plane,
BFF, compatibility layer, or second data model.

## Runtime and Substrate Boundaries

- This repo owns product API/Web, OIDC session handling, app runtime config,
  Botified/broker runtime, sandbox manifest/reconciliation, and app deploy
  inputs. It consumes substrate outputs.
- The substrates repo owns k3s, PostgreSQL, S3-compatible storage, JuiceFS CSI,
  and Keycloak lifecycle. Raw substrate credentials, Keycloak admin secrets,
  and S3/JuiceFS internals do not enter Web or Botified runtime.
- Keycloak/OIDC is the only production identity path. Local profile data never
  exposes issuer or subject. Avatar is `MERGED_SINGLE_PATH`: render an
  available Keycloak claim, otherwise initials; do not add avatar upload or a
  second avatar record.
- Use one encrypted typed project credential path and one OpenAI-compatible
  broker. Browser and Botified never receive provider plaintext.
- Keep Project-scoped File Libraries on JuiceFS. Every Task exclusively binds
  one Library and one durable Botified session while Sandbox Runs remain
  replaceable compute. A healthy Sandbox is released only after explicit user
  confirmation; resource deletion remains fenced to the exact app-owned Run.
- `docs/task-workspace-product-improvement-plan.md` is authoritative for Files,
  Task conversation, Library binding, Sandbox release, usage, and Audit when
  this broader port plan contains older assumptions.

### Botified Delivery Contract

- Every task start prompt and active follow-up gets a stable non-secret
  `delivery_key`, derived from its task/start-intent identity or follow-up ID.
  AgentSmith persists `delivery_key`, canonical `request_hash`, receipt and
  timeline cursor when known, and the delivery `claim_token`; it passes key and
  hash to the compatible vendored Botified fork.
- Botified atomically records `delivery_key`, request hash, accepted receipt,
  and timeline cursor in that task's persistent home on the project PVC. It
  exposes idempotent post-by-key and query-receipt-by-key: same key and hash
  return the original receipt; same key with a different hash returns 409.
- Before reclaiming a start or follow-up delivery claim, AgentSmith queries
  Botified by key. A receipt makes the local delivery accepted; explicit absence
  permits a resend in the same Task/session; unreachable lookup remains
  retryable. AgentSmith
  never guesses remote acceptance. This avoids first-prompt double delivery
  after a crash before the local receipt commit.
- This is a runtime contract with the vendored compatible Botified fork, not a
  new service or adapter. The fork never receives provider credentials.

## Scope Classification

| Area | Capability | Classification | Lite implementation |
|---|---|---|---|
| Auth | OIDC deep-link return-to and session-expired recovery | REQUIRED_PORT | Validated local return-to session flow. |
| Workspace | Project pin, metadata/status, membership detail/recovery | REQUIRED_PORT | Project/workspace APIs and capability projections. |
| Profile | Local profile, UserMenu profile/context, identity avatar display | MERGED_SINGLE_PATH | Local profile plus Keycloak claim/initials. |
| Settings/context | Lifecycle/settings; workspace shared/personal and project shared/personal context conflict/retry | REQUIRED_PORT | Server-authoritative APIs. |
| Credentials | Typed lifecycle and safe description | REQUIRED_PORT | Encrypted project credential path. |
| Endpoints | OpenAI-compatible validation, health/last check/failure category | REQUIRED_PORT | One endpoint/broker implementation. |
| Files | Library CRUD/selection plus list, binary upload/download/delete, safe preview, directory browsing | REQUIRED_PORT | Multiple authorized Project Libraries on JuiceFS. |
| Tasks | List/query/title/edit/archive/delete; Library binding and Run recovery | REQUIRED_PORT | One durable Task/session with many turns and sequential Runs. |
| Tasks | Persistent workspace | MERGED_SINGLE_PATH | Exactly one exclusively bound File Library; no selected-file snapshot path. |
| Task detail | Conversation, queued follow-up, connection, artifacts, Terminal, explicit Sandbox release | REQUIRED_PORT | Follow-ups stay in one Task/session; release preserves durable state. |
| Task terminal | Interactive shell in the task workspace | MERGED_SINGLE_PATH | One browser terminal through AgentSmith API to the task's bash-executor sidecar. |
| Chat | Star, edit/delete/branch, provider recovery | REQUIRED_PORT | Persistent threads/messages, one broker. |
| Policy/usage | Endpoint windows, current-user usage, and Sandbox resource-time | REQUIRED_PORT | Provider plus per-Run Sandbox settlements. |
| Alerts/notifications | Rules, instance context, acknowledge/silence/recovery | REQUIRED_PORT | In-product evaluated state. |
| Audit | Exact safe audit list/detail and pagination | REQUIRED_PORT | Allowlisted project audit projection. |

## Handoff Matrix

This is a compact implementation index for the 14 slices, not a governance
artifact. Each row delivers the listed surface, final API, states, and tests.

| Slice | Route / surface | Reference CP to adapt | Main operation | API dependency | Required states |
|---|---|---|---|---|---|
| OIDC | Login/callback and retained deep link | `app/[locale]/` session routing, `app-shell/UserMenu.tsx` | Return after login | Session/login/callback | normal, expired, redirect error, forbidden |
| Workspace/membership | Workspace overview/projects/members | `components/members/MembersPage.tsx`, `MembersTable.tsx`, `MemberDetailDrawer.tsx` | pin, metadata, member mutation | workspace/project/membership | normal, loading, empty, error, forbidden |
| Profile | UserMenu and `/user/profile` | `app/[locale]/user/profile/page.tsx`, `components/app-shell/UserMenu.tsx` | local profile, context navigation | profile/session | normal, loading, error, forbidden |
| Settings/lifecycle | workspace/project settings | workspace `settings/page.tsx`; project `settings/_components/GeneralSettingsSection.tsx`, `ProjectOwnerSection.tsx` | rename, transfer, archive/delete | workspace/project lifecycle | normal, loading, dialog, error, forbidden |
| Context | workspace/project/my-context | `components/context/ContextManager.tsx`; workspace `context/page.tsx`; project `context/page.tsx`, `my-context/page.tsx` | edit, rename, retry conflict | context | normal, loading, empty, conflict, error, forbidden |
| Credentials | Project Credentials | `credentials/_components/CredentialsContent.tsx`, `credentials-table.tsx`, `components/credentials/CreateCredentialDialog.tsx`, `RotateCredentialDialog.tsx` | create, rotate, delete | credentials/endpoints | normal, loading, empty, dialog, error, forbidden |
| Endpoints | Project Endpoints | `components/endpoints/EndpointStatusBadge.tsx`, dialogs, toolbar, content | save, validate, health check | endpoint/broker/credential | normal, loading, empty, checking, error, forbidden |
| Files | Project File Libraries | `components/files/FilesPage.tsx`, `files-page/FilesLibrariesPane.tsx`, `FilesBrowserPane.tsx`, `FileObjectDetailsPanel.tsx` | select/create/rename/delete Library; browse/upload/preview/download/delete file | file-libraries/files | normal, loading, empty, bound, conflict, preview error, forbidden |
| Task lifecycle | Tasks list/create/detail header | `agent-tasks/TaskList.tsx`, `TaskCreateDialog.tsx`, `TaskPage.tsx`, `task-page/TaskPageStates.tsx` | atomic Library bind, idempotent create/edit/archive/delete and start delivery | tasks/libraries/runs/policy/Botified receipt | normal, loading, empty, dialog, ready/running/failed, forbidden |
| Task detail | Conversation/artifacts/Terminal/Sandbox | `agent-tasks/TaskPageContent.tsx`, `ConversationPanel.tsx`, `ArtifactsPanel.tsx` | same-session stream/queue/abort, explicit release and cold resume | task turns/events/artifacts/Botified/Run | normal, starting, running, ready, releasing, released, error, forbidden |
| Chat | Project Chat | `components/chat/ThreadsPane.tsx`, `ChatMainPane.tsx`, `MessageItem.tsx` | star, edit/delete/branch, Stop | chat threads/messages/broker | normal, loading, empty, streaming, provider error, forbidden |
| Policy/usage | Project policy and usage | `resource-policy/ResourcePolicyTable.tsx`, `ResourcePolicyStatusBadge.tsx`, `audit-usage/UsagePage.tsx`, `UsageView.tsx` | set windows, inspect usage | policy/usage/settlements | normal, loading, empty, error, forbidden |
| Alerts/notifications | Alerts and notification center | `alerts/AlertCenterPage.tsx`, `AlertRulesList.tsx`, `AlertRuleFormDialog.tsx`, `AlertNotificationsPanel.tsx`, `notifications/NotificationCenter.tsx` | rule test, ack, silence | alerts/notifications | normal, loading, empty, dialog, recovery, forbidden |
| Audit | Project Audit | `audit-usage/AuditPage.tsx`, `AuditPageContent.tsx`, `AuditTable.tsx`, `AuditDetailDrawer.tsx` | filter/page/view safe detail | audit | normal, loading, empty, drawer, error, forbidden |

## Explicitly Excluded

Only these capabilities may be absent. Remove reference entry points and
dependencies rather than leaving placeholders.

| Excluded capability | Reason / retained boundary |
|---|---|
| LLMUP, Codex runner core, JVS, WebDAV, local/remote mounts, AFSCP, ASBCP | Outside Lite runtime. |
| Library versions, templates, savepoints, restore, recovery UI, and mount flows | Lite keeps independent Libraries and ordinary file operations only. |
| Folder create/rename/move, multiselect/bulk file operations, file server pagination/search/sort | Approved files scope is list/upload/download/delete, safe preview, directory browsing. |
| Generic chat attachment | Project Chat has no attachment channel; Task work uses its bound Library. |
| Artifact picker as generic task/chat attachment | Artifacts remain Task outputs, not a generic attachment channel. |
| Agent Runner management, selection, binding, badges, tests, terminal replay, and runner debug controls | Botified is selected server-side. The task workspace retains one interactive browser shell without exposing runner controls. |
| Codex notices and SSE/debug transport UI | Runtime transport/debug controls are not product UI. |
| Groups, join policies/requests, invitations, project-creator governance | Membership uses existing local OIDC identities. |
| Personal API keys, Third-party Accounts, personal connections, generic secret bundles | Keycloak plus typed project credentials only. |
| Anthropic, universal proxy, protocol conversion, non-OpenAI paths | One OpenAI-compatible broker. |
| Endpoint catalog pricing/model lifecycle and bulk import/export | Endpoint scope is saved configuration validation and health. |
| i18n, locale URLs/layouts, language preference | English-only product. |
| Global operator/control-plane/dashboard | Workspace/project scope only. |
| Governance explainability/history, evidence, reports, gates, rehearsal/release systems | Product diagnostics and light audit only. |
| External notification delivery governance | In-product notification state only. |

## Slice Sequence

### 1. OIDC Deep-Link and Session Recovery

**Reference CP source:** `app/[locale]/user/profile/page.tsx` login-adjacent
navigation and `components/app-shell/UserMenu.tsx`; adapt only retained session
navigation, not locale routing.

**Owns:** session contracts, safe errors, Authorization/session service, session
store migration only if durable return-to requires it, login/callback/logout
APIs, API client, expired-session UI, and tests.

**Implementation:** accept only normalized same-origin local return-to paths,
preserve a retained deep link through login, show recoverable session expiry,
and return after callback. This slice has no default light-audit event because
session navigation is not an audit-worthy project operation.

**Minimum verification:** API/browser interaction proves deep-link return,
session-expired recovery, and rejection of malformed/external return-to. Use
real OIDC only for the identity boundary.

### 2. Workspace, Project, and Membership

**Reference CP source:** workspace/project route pages plus
`components/members/MembersPage.tsx`, `PeopleTab.tsx`, `MembersTable.tsx`, and
`MemberDetailDrawer.tsx`; omit groups, invitations, join requests, templates,
and permission-governance controls.

**Owns:** workspace/project/membership contracts, capabilities, authorization,
store, project pin/metadata/status migration if needed, APIs/client, reachable
overview/projects/members UI, and tests.

**Implementation:** retain project pin, ordinary metadata/status, member search
and detail, membership mutations, and recoverable mutation errors. Server is
the role/membership truth. Audit project and membership changes.

**Minimum verification:** store/API pin and authorization tests; rendered member
search/detail and rejected-mutation retry tests.

### 3. Profile and User Menu

**Reference CP source:** `app/[locale]/user/profile/page.tsx`,
`components/app-shell/UserMenu.tsx`, and avatar primitives.

**Owns:** local-profile contracts/auth/store/API/client/profile route/UserMenu
states/tests. No avatar-upload migration.

**Implementation:** retain editable local display fields, read-only Keycloak
identity/email verification display, Profile navigation, and UserMenu navigation
to workspace_personal context. Project Keycloak avatar when available, otherwise
initials. Never render issuer or subject.

**Minimum verification:** rendered UserMenu navigation/profile update; API tests
prove identity fields are read-only and sensitive identity data stays out of
profile responses and audit details.

### 4. Workspace/Project Settings and Lifecycle

**Reference CP source:** workspace `settings/page.tsx` and project
`settings/page.tsx`, `settings/_components/GeneralSettingsSection.tsx`, and
`ProjectOwnerSection.tsx`; omit governance/admin-group sections.

**Owns:** settings/lifecycle contracts/auth/store/migrations/APIs/client/routes/
dialogs/tests.

**Implementation:** retain rename, ordinary metadata/status, archive/delete
where reference supports it, owner transfer, capability-specific blocking/errors,
and failed-mutation recovery. Do not restore groups, joins/invites, or governance
history. Audit lifecycle transitions.

**Minimum verification:** service/API owner/role boundaries, archive/delete
blocking, idempotent replay, and rendered confirmation/error-retry tests.

### 5. Shared and Personal Context

**Reference CP source:** `components/context/ContextManager.tsx`, workspace
`context/page.tsx`, project `context/page.tsx`, and `my-context/page.tsx`.

**Owns:** context contracts/auth/store/migrations/APIs/client/routes/dialogs/tests.

**Implementation:** retain workspace shared, workspace_personal, project shared,
and project personal context. The personal scopes are identity-private and their
API authorization checks both membership and the current identity. Add rename,
optimistic-version conflict response, mutation retry, and recovery UI. Context
never carries credentials, sessions, files, or sandbox data. Ordinary context
edits are not audited by default.

**Minimum verification:** API/store tests for workspace_personal identity and
membership authorization, all scope boundaries, and conflict versions; rendered
UserMenu navigation plus rename/conflict/retry interaction.

### 6. Project Credentials

**Reference CP source:** `credentials/_components/CredentialsContent.tsx`,
`credentials-table.tsx`, `components/credentials/CreateCredentialDialog.tsx`,
`RotateCredentialDialog.tsx`, and `DeleteCredentialDialog.tsx`, adapted to typed
project credentials rather than Third-party Accounts.

**Owns:** credential contracts/auth/store/migrations/APIs/client/routes/dialogs/
tests.

**Implementation:** retain list/create/rotate/delete plus safe name, type,
fingerprint, state, and rotation metadata. Lite project credentials deliberately
do not have a description field. Plaintext is write-only and never reaches
audit, browser, Botified, logs, or endpoint responses. Reject deletion while
bound unless an explicit retained endpoint mutation unbinds it. Audit
metadata-only actions.

**Minimum verification:** crypto/service/API create/rotate/delete, bound deletion,
no-description projection, and plaintext non-disclosure tests.

### 7. Endpoints and OpenAI-Compatible Broker

**Reference CP source:** `components/endpoints/EndpointStatusBadge.tsx`,
`create-endpoint-dialog/EndpointBasicsForm.tsx`, `CreateEndpointDialog.tsx`,
`EditEndpointDialog.tsx`, `EndpointsToolbar.tsx`, and `EndpointsContent.tsx`.

**Owns:** endpoint/broker contracts/auth/store/migrations/APIs/client/routes/
dialogs/tests.

**Implementation:** retain saved OpenAI-compatible endpoint validation, health
check, last check time/result, categorized sanitized failure, configuration
lifecycle, and credential binding. Provider calls share one broker and
policy/usage enforcement. Do not port catalog pricing/model lifecycle or bulk
import/export. Audit endpoint mutations and checks with safe metadata.

**Minimum verification:** URL/model/credential validation, health transitions,
failure categories, authorization, and rendered recovery. Use a real provider
only when crossing the provider boundary.

### 8. File Libraries and Task Workspace

The complete product, API, storage, migration, UI-copy, deletion, and focused
verification instructions for Files, Task lifecycle, Conversation, Terminal,
Artifacts, and Sandbox are centralized in
`docs/task-workspace-product-improvement-plan.md`. Implement that plan as the
single source of truth instead of retaining older fixed-tree or terminal-Task
semantics here.

In summary:

- Project Files becomes a Library selector plus the selected Library browser.
- Task creation atomically creates or exclusively binds one Library.
- Task ID is the stable Botified session ID across all turns and Sandbox Runs.
- A turn completion returns the same Task to ready; follow-ups never create a
  successor Task.
- A healthy Sandbox has no idle TTL or automatic release. An authorized user
  confirms one unconditional `Release sandbox` action.
- Release deletes only exact app-owned Run resources and preserves Task,
  completed Botified history, Library files, and artifacts.
- Sandbox usage settles once per Run and appears in existing Usage and light
  Audit surfaces.

**Reference CP source:** original Files Library pane/browser and Agent Task
create/list/detail/Conversation/Terminal/Artifacts components named in the
authoritative plan. Copy those files and remove i18n, templates, savepoints,
restore, mounts, runner management, and governance dependencies.

### 11. Project Chat

**Reference CP source:** `components/chat/ThreadsPane.tsx`,
`ThreadsPaneHeader.tsx`, `ChatMainPane.tsx`, `MessageItem.tsx`, the project chat
page, and composer; omit `ChatDialogs.tsx`, `AddUrlDialog.tsx`, and attachment
actions.

**Owns:** chat thread/message contracts/auth/store/migrations/APIs/client/routes/
dialogs/tests.

**Implementation:** retain persistent threads, search, independent persistent pin
and star actions, rename/delete, stream/Stop, Markdown/
composer, edit/delete/branch, and provider endpoint failure recovery. Server
validates history/version/order and settlement; browser never constructs
arbitrary provider history. No file, artifact, URL, or generic attachments.
Audit thread/message mutations safely.

**Minimum verification:** versioned edit/delete/branch, independent pin/star persistence, history
ordering, sanitized failure, thread actions, Stop composer/history, and endpoint
recovery tests.

### 12. Resource Policy and Usage

**Reference CP source:** `components/resource-policy/ResourcePolicyTable.tsx`,
`ResourcePolicyStatusBadge.tsx`, project
`resource-policy/_components/ResourcePolicyEditor.tsx` and
`ResourcePolicyEffectiveSummary.tsx`, plus `components/audit-usage/UsagePage.tsx`
and `UsageView.tsx`. Omit explainability/governance panels.

**Owns:** policy/usage contracts/auth/store/migrations/APIs/client/routes/UI/tests.

**Implementation:** retain project policy and endpoint-specific request/token/cost
rate and spend windows, remaining/reset semantics, and current-user usage with
project totals. Account provider activity from existing settlements and Sandbox
resource-time from one idempotent settlement per Run, as defined by the Task
Workspace plan. Extend the existing Usage surface instead of creating a second
dashboard. Enforce before broker/Task work. Audit policy changes and denials
safely.

**Minimum verification:** window/reset arithmetic, endpoint enforcement,
provider and Sandbox settlement accounting, current-user/admin authorization,
and rendered window labels.

### 13. Alerts and In-Product Notifications

**Reference CP source:** `components/alerts/AlertCenterPage.tsx`,
`AlertRulesList.tsx`, `AlertRuleCard.tsx`, `AlertRuleFormDialog.tsx`,
`AlertNotificationsPanel.tsx`, `AlertNotificationItem.tsx`, and
`components/notifications/NotificationCenter.tsx`.

**Owns:** alert/notification contracts/auth/store/migrations/APIs/client/routes/
dialogs/tests.

**Implementation:** retain rule condition/window/threshold/scope/enabled/test,
evaluation/recovery, instance metric/context, acknowledgement, silence expiry,
and in-product notification state. Evaluate durable task/endpoint/policy events.
No external delivery governance. Audit rule/instance transitions safely.

**Minimum verification:** create/edit/test/enable/disable/delete, trigger/
recovery, ack/silence expiry, authorization, and rendered context/retry states.

### 14. Light Audit

**Reference CP source:** `components/audit-usage/AuditPage.tsx`,
`AuditPageContent.tsx`, `AuditPageToolbar.tsx`, `AuditTable.tsx`,
`AuditFilters.tsx`, and `AuditDetailDrawer.tsx`; omit JSON/governance
explainability surfaces.

**Owns:** audit contracts/auth/store/migrations/APIs/client/routes/UI/tests.

**Implementation:** provide server-paginated project audit with exact timestamp,
action, actor, resource, result, and allowlisted safe detail. Prior slices write
their own records; this slice completes reading/query/presentation/authorization.
Never store prompt, file content, secret, provider key, issuer/subject, or token.

**Minimum verification:** ordering, pagination, membership authorization, safe
detail allowlist, and rendered list/detail/error/empty states.

## Migration and Dependency Order

Continue the repository's immutable PostgreSQL migration sequence. The Task
Workspace plan owns the next File Library, Task binding, Sandbox Run settlement,
and removal migration. Because Lite has no production customer deployment, use
one direct local transition: preserve Project file content in a generated
Library, discard incompatible development Task runtime data, and remove old
snapshot/successor/TTL columns and statuses without dual reads or writes.

Endpoint policy/usage records precede alert evaluation fields. Audit readers
depend on prior per-slice producers, not the reverse. Every migration gets only
the focused fresh-install/store behavior needed for its data invariants; do not
create a migration for a UI workaround or a legacy compatibility layer.

## Constraints, Risks, and Completion

- Multiple Project File Libraries, one Library per Task, one Botified session
  per Task, one broker, and one artifact projection are the retained paths.
- The approved Files boundary includes Library selection/CRUD and ordinary file
  operations, but excludes versions, templates, savepoints, restore, mounts,
  bulk operations, URL import, and generic attachments.
- Endpoint checks share broker timeout, settlement, policy, and sanitized-error
  rules. Plaintext credentials never reach logs, audit, Botified, or responses.
- Archive preserves the Task/Library binding. Delete explicitly releases exact
  Run resources, removes Task session state, and releases but does not delete
  the Library. Turn completion never terminalizes the Task.
- Contract/API errors support recovery UI without leaking provider, K8s, identity,
  credential, or file-content data.

Use small focused unit, contract, API, store, and rendered interaction tests.
Use real environments only when crossing OIDC, K8s/sandbox, or provider
boundaries. Do not generate reports, evidence collections, gates, rehearsals,
committed screenshots, or default broad test wrappers. Transient browser views
used to inspect the current UI are not project artifacts.

The port is complete when all 14 handoff rows have a reachable English-only Next
route or surface, final same-origin `/api/v1` contract, server-owned
authorization/business logic, normal/loading/empty/error/forbidden states,
desktop/mobile and light/dark behavior, and their key dialog or drawer state.
Notifications are separately reachable, not merely an alert-rule side effect.
Each row has audit treatment appropriate to its operation (allowlisted event for
audit-worthy project operations/lifecycle transitions, none by default for
ordinary profile/context/session edits) and a focused behavior check where the
path has meaningful risk.
MERGED_SINGLE_PATH must preserve the original user outcome. Only the
explicit-exclusion table may be absent.
