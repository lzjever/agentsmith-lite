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

P2 file CRUD uses the live filesystem under each project root and narrows product file operations to the `files/` subtree:

- `POST /api/projects/{projectId}/files` uploads UTF-8 text with `{ "path": "files/name.txt", "content": "..." }`;
- `GET /api/projects/{projectId}/files?path=files` lists one directory level without following symlink entries;
- `GET /api/projects/{projectId}/files/download?path=files/name.txt` downloads UTF-8 text;
- `DELETE /api/projects/{projectId}/files` deletes a path from JSON `{ "path": "files/name.txt" }`.

The app creates safe parent directories for uploads. It rejects paths outside `files/`, absolute paths, `..`, backslash paths, symlink escapes, and deletion of the `files/` root.

S3 credentials and JuiceFS metadata credentials belong to substrate/CSI. The app deploy renderer does not copy them into app-owned Secrets or pod env.
