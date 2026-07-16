# Storage And Files

The app consumes a substrate-provided JuiceFS PVC by name and mounts project paths under:

```text
workspaces/<workspace_id>/projects/<project_id>
```

The app Deployment sets `AGENTSMITH_LITE_DATA_DIR=/agentsmith-lite` by default, matching the PVC mount root; deploy env may override it when a different mounted data root is intentionally supplied.

P0 implements path validation as product logic:

- reject absolute paths;
- reject traversal;
- reject backslash paths;
- resolve existing symlinks and reject escapes outside the project root.

File CRUD uses the live filesystem under each project root and narrows product file operations to the `files/` subtree:

- `PUT /api/v1/projects/{projectId}/files?path=files/name.bin` creates a raw binary file and returns `409` when it already exists; a user-confirmed replacement adds `overwrite=true`;
- `GET /api/v1/projects/{projectId}/files?path=files` lists one directory level without following symlink entries;
- `GET /api/v1/projects/{projectId}/files/download?path=files/name.bin` downloads the original bytes;
- `DELETE /api/v1/projects/{projectId}/files` deletes a path from JSON `{ "path": "files/name.txt" }`.

The app creates safe parent directories for uploads. It rejects paths outside `files/`, absolute paths, `..`, backslash paths, symlink escapes, and deletion of the `files/` root.

The file library may grow beyond this v1 surface later. This document describes only the implemented list, binary upload, download, and delete operations.

S3 credentials and JuiceFS metadata credentials belong to substrate/CSI. The app deploy renderer does not copy them into app-owned Secrets or pod env.
