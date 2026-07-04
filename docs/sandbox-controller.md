# Sandbox Controller

P0 renders one sandbox pod per active task in dry-run form. The rendered resources include:

- ServiceAccount with token automount disabled.
- Secret for per-task Botified service key.
- ConfigMap for generated Botified config.
- Pod mounting only the project subPath of the substrate-provided PVC.
- Service for API-to-runner HTTP.
- Namespaced Role for pod/service/secret/configmap lifecycle.
- NetworkPolicy allowing API-to-runner traffic.

The role intentionally excludes terminal exec subresources and cluster-wide volume management. App manifests also render ResourceQuota and LimitRange.

