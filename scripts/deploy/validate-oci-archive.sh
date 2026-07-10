#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: validate-oci-archive.sh <archive> <sha256-digest>" >&2
  exit 2
fi

archive="$1"
expected_digest="$2"

if [[ ! "$expected_digest" =~ ^sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "invalid expected OCI digest: $expected_digest" >&2
  exit 2
fi
if [ ! -s "$archive" ]; then
  echo "OCI archive is missing or empty: $archive" >&2
  exit 1
fi

if ! layout="$(tar -xOf "$archive" oci-layout 2>/dev/null)"; then
  echo "OCI archive is missing oci-layout: $archive" >&2
  exit 1
fi
if ! printf '%s' "$layout" | node -e '
  const layout = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!layout || typeof layout.imageLayoutVersion !== "string" || !layout.imageLayoutVersion.startsWith("1.")) {
    throw new Error("oci-layout must declare imageLayoutVersion 1.x");
  }
'; then
  echo "OCI archive has an invalid oci-layout: $archive" >&2
  exit 1
fi

if ! index="$(tar -xOf "$archive" index.json 2>/dev/null)"; then
  echo "OCI archive is missing index.json: $archive" >&2
  exit 1
fi
if ! root_size="$(printf '%s' "$index" | node -e '
  const expected = process.argv[1];
  const index = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (!index || index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1) {
    throw new Error("index.json must contain exactly one root descriptor");
  }
  const root = index.manifests[0];
  if (!root || typeof root.digest !== "string" || !/^sha256:[0-9a-fA-F]{64}$/.test(root.digest)) {
    throw new Error("index.json root descriptor must have a sha256 digest");
  }
  if (root.mediaType !== "application/vnd.oci.image.manifest.v1+json") {
    throw new Error("index.json root descriptor must be an OCI image manifest");
  }
  if (!Number.isSafeInteger(root.size) || root.size < 0) {
    throw new Error("index.json root descriptor must have a non-negative integer size");
  }
  if (root.digest.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`index.json root digest ${root.digest} does not match ${expected}`);
  }
  process.stdout.write(String(root.size));
' "$expected_digest")"; then
  echo "OCI archive root digest does not match lock: $archive" >&2
  exit 1
fi

validate_blob() {
  local digest="$1"
  local size="$2"
  local label="$3"
  local blob="blobs/sha256/${digest#sha256:}"
  local blob_file
  local actual_size
  local actual_digest

  if ! tar -tf "$archive" | grep -Fx "$blob" >/dev/null; then
    echo "OCI archive is missing ${label} blob: $blob" >&2
    exit 1
  fi
  blob_file="$(mktemp "${TMPDIR:-/tmp}/agentsmith-lite-oci-blob.XXXXXX")"
  if ! tar -xOf "$archive" "$blob" > "$blob_file" 2>/dev/null; then
    rm -f "$blob_file"
    echo "OCI archive cannot read ${label} blob: $blob" >&2
    exit 1
  fi
  actual_size="$(wc -c < "$blob_file")"
  actual_digest="sha256:$(sha256sum "$blob_file" | awk '{print $1}')"
  if [ "$actual_size" -ne "$size" ]; then
    rm -f "$blob_file"
    echo "OCI archive ${label} descriptor size does not match blob: $archive" >&2
    exit 1
  fi
  if [ "${actual_digest,,}" != "${digest,,}" ]; then
    rm -f "$blob_file"
    echo "OCI archive ${label} blob hash does not match descriptor: $archive" >&2
    exit 1
  fi
  printf '%s\n' "$blob_file"
}

root_blob_file="$(validate_blob "$expected_digest" "$root_size" "root")"
if ! descriptor_refs="$(node -e '
  const manifest = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const config = manifest?.config;
  const layers = manifest?.layers;
  const layerMediaTypes = new Set([
    "application/vnd.oci.image.layer.v1.tar",
    "application/vnd.oci.image.layer.v1.tar+gzip",
    "application/vnd.oci.image.layer.v1.tar+zstd",
    "application/vnd.oci.image.layer.nondistributable.v1.tar",
    "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
    "application/vnd.oci.image.layer.nondistributable.v1.tar+zstd"
  ]);
  const validate = (descriptor, label, mediaTypes) => {
    if (!descriptor || typeof descriptor.digest !== "string" || !/^sha256:[0-9a-fA-F]{64}$/.test(descriptor.digest) || !Number.isSafeInteger(descriptor.size) || descriptor.size < 0 || !mediaTypes.has(descriptor.mediaType)) {
      throw new Error(`root manifest has an invalid ${label} descriptor`);
    }
    return `${descriptor.digest} ${descriptor.size}`;
  };
  if (!Array.isArray(layers)) throw new Error("root manifest layers must be an array");
  const refs = [validate(config, "config", new Set(["application/vnd.oci.image.config.v1+json"]))];
  for (const layer of layers) refs.push(validate(layer, "layer", layerMediaTypes));
  process.stdout.write(refs.join("\n"));
' "$root_blob_file")"; then
  rm -f "$root_blob_file"
  echo "OCI archive root manifest is invalid: $archive" >&2
  exit 1
fi
rm -f "$root_blob_file"

config_ref="$(printf '%s\n' "$descriptor_refs" | sed -n '1p')"
if [[ ! "$config_ref" =~ ^sha256:[0-9a-fA-F]{64}[[:space:]][0-9]+$ ]]; then
  echo "OCI archive has a malformed config descriptor: $archive" >&2
  exit 1
fi
config_digest="${config_ref%% *}"
config_size="${config_ref#* }"
config_blob_file="$(validate_blob "$config_digest" "$config_size" "config")"
if ! node -e '
  const config = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (config?.os !== "linux" || config?.architecture !== "amd64") {
    throw new Error("config must target linux/amd64");
  }
' "$config_blob_file"; then
  rm -f "$config_blob_file"
  echo "OCI archive config must target linux/amd64: $archive" >&2
  exit 1
fi
rm -f "$config_blob_file"

layer_refs="$(printf '%s\n' "$descriptor_refs" | sed '1d')"
while IFS=' ' read -r layer_digest layer_size; do
  [ -n "$layer_digest" ] || continue
  if [[ ! "$layer_digest" =~ ^sha256:[0-9a-fA-F]{64}$ ]] || [[ ! "$layer_size" =~ ^[0-9]+$ ]]; then
    echo "OCI archive has a malformed layer descriptor: $archive" >&2
    exit 1
  fi
  layer_blob_file="$(validate_blob "$layer_digest" "$layer_size" "layer")"
  rm -f "$layer_blob_file"
done <<< "$layer_refs"
