# Storage And Files

The app consumes a substrate-provided JuiceFS PVC by name and mounts project paths under:

```text
workspaces/<workspace_id>/projects/<project_id>
```

The app Deployment sets `AGENTSMITH_LITE_DATA_DIR=/agentsmith-lite` by default, matching the PVC mount root; deploy env may override it when a different mounted data root is intentionally supplied.
The local migration runner uses the API's local default `.data` when that env is
unset. The Kubernetes schema Job receives the rendered data root and mounts the
same JuiceFS PVC read-write.

Path validation is product logic:

- reject absolute paths;
- reject traversal;
- reject backslash paths;
- resolve existing symlinks and reject escapes outside the project root.

Each Task has one immutable exclusive File Library. Library roots use:

```text
workspaces/<workspace_id>/projects/<project_id>/libraries/<library_id>/home
```

Project File Library routes list all Libraries accessible to the current member
and select one with `libraryId`. File list, binary upload/download, and delete
operate only inside that Library root. Task and Terminal filesystem operations
use the Task-bound Library. The app creates safe parent directories for uploads
and rejects paths outside the selected Library, absolute paths, `..`, backslash
paths, symlink escapes, and deletion of the Library root.

Artifacts are incremental projections from the same Task Library. Artifact
metadata is durable product state; release removes Run compute but retains the
Library files and published artifacts.

The one-time pending migration `066` first completes its SQL preconditions in
the open migration transaction, then preflights every Project and File Library
cleanup path. In live mode it removes canonically labeled Sandbox resources
with observed UID fences and confirms them absent before deleting only each
Project's `tasks/` subtree and each Library's `workspace/.artifacts` subtree.
Ordinary Library and Project files are retained. An already-applied `066`
redeploy performs none of this cutover work.

S3 credentials and JuiceFS metadata credentials belong to substrate/CSI. The app deploy renderer does not copy them into app-owned Secrets or pod env.
