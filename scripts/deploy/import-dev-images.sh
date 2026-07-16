#!/usr/bin/env bash
set -euo pipefail

k3s_bin=
kubectl_bin=
kubeconfig=
kube_context=
namespace=
tag=dev

while [ "$#" -gt 0 ]; do
  case "$1" in
    --k3s-bin)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--k3s-bin requires a path" >&2
        exit 2
      fi
      k3s_bin="$2"
      shift 2
      ;;
    --kubectl-bin)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--kubectl-bin requires a path" >&2
        exit 2
      fi
      kubectl_bin="$2"
      shift 2
      ;;
    --kubeconfig)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--kubeconfig requires a path" >&2
        exit 2
      fi
      kubeconfig="$2"
      shift 2
      ;;
    --kube-context)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--kube-context requires a value" >&2
        exit 2
      fi
      kube_context="$2"
      shift 2
      ;;
    --namespace)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--namespace requires a value" >&2
        exit 2
      fi
      namespace="$2"
      shift 2
      ;;
    --tag)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "--tag requires a value" >&2
        exit 2
      fi
      tag="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$k3s_bin" ]; then
  echo "--k3s-bin is required" >&2
  exit 2
fi
if [ -z "$kubectl_bin" ]; then
  echo "--kubectl-bin is required" >&2
  exit 2
fi
if [ -z "$kubeconfig" ]; then
  echo "--kubeconfig is required" >&2
  exit 2
fi
if [ -z "$kube_context" ]; then
  echo "--kube-context is required" >&2
  exit 2
fi
if [ -z "$namespace" ]; then
  echo "--namespace is required" >&2
  exit 2
fi
if [ ! -f "$k3s_bin" ] || [ ! -x "$k3s_bin" ]; then
  echo "--k3s-bin must be an executable file: $k3s_bin" >&2
  exit 1
fi
if [ ! -f "$kubectl_bin" ] || [ ! -x "$kubectl_bin" ]; then
  echo "--kubectl-bin must be an executable file: $kubectl_bin" >&2
  exit 1
fi
if [ ! -f "$kubeconfig" ]; then
  echo "--kubeconfig must be a file: $kubeconfig" >&2
  exit 1
fi
if ! docker_bin="$(command -v docker)"; then
  echo "docker is required to import local dev images" >&2
  exit 1
fi

images=(
  "agentsmith-lite/app:${tag}"
  "agentsmith-lite/botified-runner:${tag}"
)

temporary_archive=
cleanup() {
  if [ -n "$temporary_archive" ]; then
    rm -f -- "$temporary_archive"
  fi
}
trap cleanup EXIT

for image in "${images[@]}"; do
  if ! "$docker_bin" image inspect "$image" >/dev/null; then
    echo "local Docker image is required: $image" >&2
    exit 1
  fi
done

for image in "${images[@]}"; do
  normalized_image="docker.io/$image"
  if ! temporary_archive="$(mktemp "${TMPDIR:-/tmp}/agentsmith-lite-image.XXXXXX")"; then
    echo "failed to create temporary archive for local Docker image: $image" >&2
    exit 1
  fi
  if ! "$docker_bin" image save -o "$temporary_archive" "$image"; then
    echo "failed to export local Docker image: $image" >&2
    exit 1
  fi
  if ! "$k3s_bin" ctr -n k8s.io images import --all-platforms "$temporary_archive"; then
    echo "failed to import local Docker image into k3s containerd: $image" >&2
    exit 1
  fi
  if ! "$k3s_bin" ctr -n k8s.io images inspect "$normalized_image" >/dev/null 2>&1; then
    echo "k3s containerd image is missing after import: $normalized_image" >&2
    exit 1
  fi
  if ! image_labels="$("$k3s_bin" ctr -n k8s.io images label "$normalized_image" io.cri-containerd.pinned=pinned)"; then
    echo "failed to pin local image in k3s containerd: $normalized_image" >&2
    exit 1
  fi
  case ",$image_labels," in
    *,io.cri-containerd.pinned=pinned,*) ;;
    *)
      echo "k3s containerd image is not pinned after import: $normalized_image" >&2
      exit 1
      ;;
  esac
  rm -f -- "$temporary_archive"
  temporary_archive=
done

kubectl_args=(--kubeconfig "$kubeconfig" --context "$kube_context" --namespace "$namespace")
for deployment in agentsmith-lite-api agentsmith-lite-web; do
  if "$kubectl_bin" "${kubectl_args[@]}" get "deployment/$deployment" --ignore-not-found -o name | grep -q .; then
    "$kubectl_bin" "${kubectl_args[@]}" rollout restart "deployment/$deployment"
  fi
done
