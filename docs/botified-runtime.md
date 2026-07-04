# Botified Runtime

P0 Botified consumption is fixed as vendored source from pinned commit:

- pin file: `third_party/botified/PINNED_SOURCE.json`
- runtime entrypoint: `botified serve`

The app does not expose Botified's TUI as product runtime. The runner Dockerfile builds the vendored source and the entrypoint execs:

```bash
botified serve --config /etc/botified/botified-config.yaml
```

`packages/botified-runtime` owns:

- hardened config generation;
- pure timeline event projection;
- a small wrapper for starting `botified serve`;
- a runtime HTTP client port stub in `packages/ports`.

