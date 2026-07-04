# Storage And Files

The app consumes a substrate-provided JuiceFS PVC by name and mounts project paths under:

```text
workspaces/<workspace_id>/projects/<project_id>
```

P0 implements path validation as product logic:

- reject absolute paths;
- reject traversal;
- reject backslash paths;
- resolve existing symlinks and reject escapes outside the project root.

S3 credentials and JuiceFS metadata credentials belong to substrate/CSI. The app deploy renderer does not copy them into app-owned Secrets or pod env.

