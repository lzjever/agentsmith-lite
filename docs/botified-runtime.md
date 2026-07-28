# Botified Runtime

AgentSmith consumes only the published Botified `v0.4.44` release asset
`botified-core-linux-x86_64-musl.tar.gz`. The version, asset, and SHA-256 digest
are pinned in `infra/docker/botified-release.env`; the image build downloads the
asset and verifies its digest before installing it.

There is no vendored Botified source, source-build path, fallback runtime, or
compatibility mode.

## Execution Boundary

Botified uses its published built-in local Bash behavior within its own runner
and workspace, not an external AgentSmith executor. The AgentSmith-owned
`bash-executor` is terminal-only and is not part of Botified tool execution.

## Service Boundary

The AgentSmith server controls Botified through Botified's public HTTP service
API. Botified sends model requests to the AgentSmith HTTP OpenAI-compatible
broker, which handles model traffic and usage accounting.
