# Sandbox Controller

P0 renders one sandbox pod per active task in dry-run form and has a tested reconciler for run resource state plus a tested in-cluster Kubernetes port/action applier. TaskService also has an explicit live startup path: when live mode is configured, it persists run state, materializes the six per-run resources, applies them, waits for the Pod to become ready with a bounded poll loop, then posts the prompt to Botified.

Live mode also starts a single-replica runtime tick. On startup and then each interval, it syncs active Task Botified timelines and finishes persisted explicit release or deletion intents. The tick never selects a healthy Sandbox for release, and there is no idle, TTL, or automatic release policy.

## Run State

Desired sandbox state is represented by the pure `SandboxRunState` input to the reconciler and persisted through the typed `ProductStore.sandboxRuns` port. The backing storage is the existing `postgres_json_docs` table using the `sandbox_run_state` collection; there is no dedicated `sandbox_runs` table or migration. It records:

- workspace/project/task/run ids and namespace.
- phase and cleanup status.
- pod/service/configmap/secret names.
- Botified service key secret ref.
- task home, artifacts, and Botified data directories.
- runner image, PVC/project subPath, port, and resource requests/limits.
- ready/release timestamps, the user who started the Run, and the release reason.
- timeline cursor, fencing token, and minimal metadata for fenced store updates.

The run state document stores resource names, Secret key references, directories, limits, phase, cleanup status, and timestamps. It must not store real Botified service keys or model API keys; those values only appear in live Kubernetes Secret apply bodies. State transitions are emitted as idempotent `store_run_state` actions and are persisted only after cleanup mutations succeed.

## Rendered Resources

Per-run rendering includes:

- ServiceAccount with token automount disabled.
- Secret for the per-task Botified/broker key; it is not a provider API key. Public API/DB task JSON keeps only redacted placeholders.
- ConfigMap for generated Botified config.
- Pod mounting only the project subPath of the substrate-provided PVC.
- Service for API-to-runner HTTP.
- NetworkPolicy allowing API-to-runner traffic.

Every per-run resource carries immutable identity labels:

- `agentsmith-lite/managed-by`
- `agentsmith-lite/workspace-id`
- `agentsmith-lite/project-id`
- `agentsmith-lite/task-id`
- `agentsmith-lite/run-id`

The API Role remains in app manifests, not per-run sandbox output. It intentionally excludes watch, terminal exec/log/attach/port-forward subresources, and cluster-wide volume management. App manifests also render ResourceQuota and LimitRange.

## Reconciler And Appliers

`reconcileSandboxRuns` takes a required observation namespace, desired runs, and observed Kubernetes resources. It only reconciles observations in that namespace and emits deterministic actions:

- create missing lifecycle resources: Secret, ConfigMap, ServiceAccount, NetworkPolicy, Service, Pod.
- adopt observed resources whose kind/name/namespace and immutable labels match the desired run.
- delete unmatched Agentsmith-managed resources only when their full immutable identity is present; ignore partial-identity and unowned resources.
- delete resources for a persisted release or deletion intent in Pod -> Service -> NetworkPolicy -> ConfigMap -> Secret -> ServiceAccount order.
- emit idempotent store-state actions for observed desired state and cleanup transitions.

`applySandboxReconcileActions` is an in-memory fake applier for tests. It only mutates resources when the action labels match the resource labels, which preserves the same label fence the real Kubernetes client must use later.

`SandboxKubernetesPort` is an in-cluster-only Kubernetes HTTP port for the same six lifecycle resources. It lists by `agentsmith-lite/managed-by=agentsmith-lite`, applies with server-side apply, deletes with immutable-label fencing and UID preconditions when present, and reads Pod readiness with the same immutable label fence.

`applySandboxReconcileActionsToKubernetes` maps create/delete actions to that port. Adopt and store-state actions remain no-op for live Kubernetes mutation.

TaskService live startup uses this action applier only when `AGENTSMITH_LITE_SANDBOX_MODE=live` has wired a real Kubernetes port. Default local development remains dry-run and does not resolve model credentials, apply Kubernetes resources, or wait for Pod readiness. Live API startup requires `POSTGRES_APP_URL` so sandbox lifecycle state cannot silently run on the local in-memory store.

## Explicit Release

`SandboxLifecycleService.reapSandboxRunsOnce({ apply: true })` finishes a previously persisted explicit release or deletion intent. It never executes `create_resource`; TaskService owns new-Run startup. It executes exact-identity delete actions, re-observes the resources, and only then marks the Run released with fencing and settles that Run's Usage once. A Sandbox release never deletes Task HOME, Botified session data, File Library files, or artifacts. Those durable paths let the next message or Terminal open create a new Run for the same Task, session, and File Library. Cleanup failure leaves the release intent pending for a later retry and does not free the active-Sandbox reservation.
