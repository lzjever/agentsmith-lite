# Sandbox Controller

P0 renders one sandbox pod per active task in dry-run form and has a tested reconciler for run resource state plus a tested in-cluster Kubernetes port/action applier. TaskService also has an explicit live startup path: when live mode is configured, it persists run state, materializes the six per-run resources, applies them, waits for the Pod to become ready with a bounded poll loop, then posts the prompt to Botified.

Live mode also starts a P0 single-replica runtime tick. On startup and then each interval, it syncs active task Botified timelines through TaskService and runs `reapSandboxRunsOnce({ apply: true })`. This is a thin process-local loop, not a Kubernetes watch/operator, lease/queue framework, or governance control plane. Operator status/reap endpoints remain explicit diagnostics and manual convergence tools.

## Run State

Desired sandbox state is represented by the pure `SandboxRunState` input to the reconciler and persisted through the typed `ProductStore.sandboxRuns` port. The backing storage is the existing `postgres_json_docs` table using the `sandbox_run_state` collection; there is no dedicated `sandbox_runs` table or migration. It records:

- workspace/project/task/run ids and namespace.
- phase and cleanup status.
- pod/service/configmap/secret names.
- Botified service key secret ref.
- task home, artifacts, and Botified data directories.
- runner image, PVC/project subPath, port, and resource requests/limits.
- expiry and idle expiry timestamps.
- timeline cursor, fencing token, and minimal cleanup metadata for fenced store updates and recent cleanup diagnostics.

The run state document stores resource names, Secret key references, directories, limits, phase, cleanup status, and timestamps. It must not store real Botified service keys or model API keys; those values only appear in live Kubernetes Secret apply bodies. State transitions are emitted as idempotent `store_run_state` actions and are persisted only after cleanup mutations succeed.

## Rendered Resources

Per-run rendering includes:

- ServiceAccount with token automount disabled.
- Secret for the per-task Botified service key and model API key environment binding. Public API/DB task JSON keeps only redacted placeholders.
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

`reconcileSandboxRuns` takes desired runs plus observed fake Kubernetes resources and emits deterministic actions:

- create missing lifecycle resources: Secret, ConfigMap, ServiceAccount, NetworkPolicy, Service, Pod.
- adopt observed resources whose kind/name/namespace and immutable labels match the desired run.
- mark unknown Agentsmith-managed resources for cleanup while ignoring unowned resources.
- delete stopping, expired, or idle-expired resources in Pod -> Service -> NetworkPolicy -> ConfigMap -> Secret -> ServiceAccount order.
- emit idempotent store-state actions for observed desired state and cleanup transitions.

`applySandboxReconcileActions` is an in-memory fake applier for tests. It only mutates resources when the action labels match the resource labels, which preserves the same label fence the real Kubernetes client must use later.

`SandboxKubernetesPort` is an in-cluster-only Kubernetes HTTP port for the same six lifecycle resources. It lists by `agentsmith-lite/managed-by=agentsmith-lite`, applies with server-side apply, patches cleanup labels with JSON Patch `test` fencing, deletes with UID preconditions when present, and reads Pod readiness with the same immutable label fence. It intentionally has no exec/log/attach/port-forward, PVC/PV, CRD/operator, watch loop, or privileged operator surface.

`applySandboxReconcileActionsToKubernetes` maps create/delete/mark-cleanup actions to that port. Adopt and store-state actions remain no-op for live Kubernetes mutation.

TaskService live startup uses this action applier only when `AGENTSMITH_LITE_SANDBOX_MODE=live` has wired a real Kubernetes port. Default local development remains dry-run and does not resolve model credentials, apply Kubernetes resources, or wait for Pod readiness. Live API startup requires `POSTGRES_APP_URL` so sandbox lifecycle state cannot silently run on the local in-memory store.

## Explicit Lifecycle Operations

`SandboxLifecycleService` provides two explicit operations:

- `getSandboxStatus({ runId? })` reads active tasks, persisted run state, observed K8s resources, runtime directory state, and recent cleanup failures without mutating anything. Passing `runId` scopes those counts, observations, and cleanup-plan summaries to one sandbox run.
- `reapSandboxRunsOnce({ dryRun | apply, runId? })` computes one reconciliation pass. It never executes `create_resource`; startup remains the only create path. In dry-run mode it returns the planned summary only. In apply mode it executes delete/mark-cleanup actions, then re-observes resources. Only after K8s cleanup is complete does it remove runtime cleanup candidates (`home` and `botified`), retain durable `artifacts`, and persist cleaned store-state transitions with fencing.

Both operations return the same server-generated `cleanupPlan.targets[]` shape as the lifecycle source of truth. Targets include non-secret K8s/store summaries (`delete_resource`, `mark_cleanup`, `store_run_state`) plus runtime directory targets that distinguish cleanup candidates from retained artifacts. Directory cleanup is performed only in the service layer after `dataRoot` containment checks. Cleanup failures are recorded back into the run state as bounded, redacted recent failure metadata and prevent the run from being marked cleaned.

The product API exposes these as admin-only endpoints:

- `GET /api/operator/sandbox/status`, optionally scoped with `?runId=<runId>`
- `POST /api/operator/sandbox/reap`, defaulting to dry-run unless the JSON body contains `"apply": true`.

Operator scripts should be thin clients of these endpoints. They must not reimplement lifecycle business logic or build independent cleanup plans from kubectl output.
