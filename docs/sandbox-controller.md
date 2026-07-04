# Sandbox Controller

P0 renders one sandbox pod per active task in dry-run form and now has a first-pass fake reconciler for run resource state plus a tested in-cluster Kubernetes port/action applier. TaskService live wiring, materialization, readiness, pod startup, and Botified-in-sandbox execution are still the next slice.

## Run State

Desired sandbox state is represented in this slice by the pure `SandboxRunState` input to the reconciler. It records:

- workspace/project/task/run ids and namespace.
- phase and cleanup status.
- pod/service/configmap/secret names.
- Botified service key secret ref.
- task home, artifacts, and Botified data directories.
- runner image, PVC/project subPath, port, and resource requests/limits.
- expiry and idle expiry timestamps.
- timeline cursor and fencing token for future store integration.

This slice does not add a database table or store port. State transitions are emitted as idempotent `store_run_state` actions so a later persistence layer can fence writes with `run_id + fencing_token`.

## Rendered Resources

Per-run rendering includes:

- ServiceAccount with token automount disabled.
- Secret for the per-task Botified service key.
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

The API Role remains in app manifests, not per-run sandbox output. It intentionally excludes terminal exec subresources and cluster-wide volume management. App manifests also render ResourceQuota and LimitRange.

## Reconciler And Appliers

`reconcileSandboxRuns` takes desired runs plus observed fake Kubernetes resources and emits deterministic actions:

- create missing lifecycle resources: Secret, ConfigMap, ServiceAccount, NetworkPolicy, Service, Pod.
- adopt observed resources whose kind/name/namespace and immutable labels match the desired run.
- mark unknown Agentsmith-managed resources for cleanup while ignoring unowned resources.
- delete stopping, expired, or idle-expired resources in Pod -> Service -> NetworkPolicy -> ConfigMap -> Secret -> ServiceAccount order.
- emit idempotent store-state actions for observed desired state and cleanup transitions.

`applySandboxReconcileActions` is an in-memory fake applier for tests. It only mutates resources when the action labels match the resource labels, which preserves the same label fence the real Kubernetes client must use later.

`SandboxKubernetesPort` is an in-cluster-only Kubernetes HTTP port for the same six lifecycle resources. It lists by `agentsmith-lite/managed-by=agentsmith-lite`, applies with server-side apply, patches cleanup labels with JSON Patch `test` fencing, deletes with UID preconditions when present, and reads Pod readiness with the same immutable label fence. It intentionally has no exec/log/attach/port-forward, PVC/PV, CRD/operator, watch loop, or governance-gate surface.

`applySandboxReconcileActionsToKubernetes` maps create/delete/mark-cleanup actions to that port. Adopt and store-state actions remain no-op for live Kubernetes mutation.
