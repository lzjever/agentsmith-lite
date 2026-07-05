# AgentSmith Lite 产品研发计划

状态：收敛版开发交接稿
日期：2026-07-04
适用仓库：`agentsmith-lite`，配套仓库 `agentsmith-lite-substrates`

## 0. 修订结论与根因分析

本计划不是“已完成报告”。它是给开发团队继续收敛实现、补齐真实验收证据的产品研发计划。当前审计发现，上一版计划有三个根因问题：

1. **范围分层混乱**：把 Lite 核心目标、未来增强项、参考系统遗留能力混进同一个 P0/P2 范围，导致 chat persistence、audit/usage、workspace/project 全量 CRUD、endpoint edit、file delete UI 等未实现或非核心能力被误写为 MVP。
2. **证明层级混淆**：本地 unit/contract/fake smoke 只能证明代码路径、接口边界和安全限制，不能证明 clean VM、断网 VM、真实云 K8s、真实 Botified bash artifact 已经可用。计划必须把这些外部验收列为 redacted evidence，而不是用本地测试替代。
3. **命令契约与证明边界曾经混在一起**：`scripts/dev/up.sh --env/--secrets` 加 `--app-env/--app-secrets` 的本地 dev env 契约已补齐并测试；但它只证明本地开发启动契约，真实 clean/offline/existing-cloud、runner image/K8s/JuiceFS evidence 仍不能由本地命令替代。

结构性修订原则：

- 先定义 **MVP/Core**，再定义 **Deferred**，最后定义 **External Acceptance Evidence**。
- P0-P5 每个阶段都写清：要交付什么、本地能证明什么、真实环境还必须提交什么证据。
- 治理只保留为调试/发布仪表和事实报告，不进入主线开发路径。
- Web UI 和未来 TUI 只能是 API client；业务逻辑必须在服务端完成。

## 1. 产品目标与不可变边界

AgentSmith Lite 是从原 `agentsmith-project` 大幅简化出来的云端智能体平台。核心目标只有一个：

> 在 Kubernetes 中运行可回收、可管理、可观察的沙箱智能体任务，通过 JuiceFS CSI 提供云端文件系统，通过 OpenAI-compatible LLM 接口接入模型，通过 Botified 执行 agent runtime。

不可变技术决策：

| 决策 | 说明 |
| --- | --- |
| 两个 repo | `agentsmith-lite` 和 `agentsmith-lite-substrates`。不再拆出 AFSCP、ASBCP、runner、release-kit 等产品 repo。 |
| LLM 接口 | 只兼容 OpenAI-compatible Chat Completions/Responses 风格接口。移除 LLMUP。 |
| Agent runtime | 使用 Botified。移除 Codex 作为 agent 核心的设计。 |
| 文件系统 | 只支持 JuiceFS CSI 作为云端/私有化文件系统 provider。移除 JVS、WebDAV、远程/本地挂载。 |
| 沙箱 | 保留。任务在 K8s sandbox pod 内运行，API 负责生命周期、事件投影、取消和回收。 |
| UI 边界 | Web/TUI 只调用产品 API，不做 agent 编排、provider 调用、K8s 操作、DB 写入或文件授权判断。 |
| 依赖最小化 | Core 依赖只包括 Kubernetes、PostgreSQL、S3-compatible object storage、JuiceFS CSI、App/Botified images。 |
| 治理 | 不建设 release/rehearsal/evidence bureaucracy。只保留事实型 doctor/status/smoke/report。 |

## 2. 范围分层

### 2.1 MVP/Core

MVP/Core 是开发团队必须优先完成并证明的闭环：

| 范围 | Core 内容 |
| --- | --- |
| 部署模型 | 自建 substrates 或 existing-cloud 使用同一 `substrate.env` + `substrate.secrets.env` 契约。 |
| API | 内建 admin/session、workspace/project 最小 create/list/select、endpoint create/list/use、chat smoke、task create/cancel/events/artifacts、project file list/upload/download。 |
| Runtime | Botified vendored/pinned，构建 runner image，sandbox pod 运行 Botified，支持 bash 写文件并发布 artifact。 |
| Sandbox | 每个任务一个 sandbox pod；挂载 JuiceFS PVC；最小 RBAC；无 `pods/exec`；TTL/lease/reap/status。 |
| Files | 服务端负责路径安全、权限、上传、下载、artifact 投影。UI 只通过 API 展示和触发。 |
| Packaging | App image、Botified runner image、K8s manifest render/apply/status/down/doctor/smoke、digest-pinned app offline bundle。 |
| Substrates | k3s self-hosted 安装、existing-cloud validation、offline cache、JuiceFS CSI、PostgreSQL、S3-compatible storage、doctor。 |

Core 中的“chat”不是长期对话产品。MVP 只要求服务端可以通过已配置 endpoint 完成一次模型调用，用于验证 endpoint 与 server-side LLM access。

### 2.2 Deferred

以下能力不进入 MVP/Core，除非用户另开需求并重新评估：

| Deferred 项 | 原因 |
| --- | --- |
| chat persistence、chat attachments、conversation UI | 不属于云端沙箱 agent 平台的首个闭环。 |
| workspace/project 全量 CRUD、membership/group/template UI | 会把权限产品化提前，拖慢 sandbox runtime。Core 只保留最小所有者/admin 模型。 |
| endpoint edit/delete、多 provider abstraction、模型路由 UI | Core 先支持 create/list/use；编辑删除后续再做。 |
| project file delete UI、文件版本、save/restore、回收站 | 删除策略涉及数据安全，MVP 不抢跑。artifact 下载和项目文件下载优先。 |
| audit/usage dashboard | 可先保留 server logs/task events/resource counters；产品化报表后置。 |
| OIDC/Keycloak、组织级 RBAC | 内建 admin 先完成私有化闭环。 |
| TUI 产品面 | 未来 TUI 只能作为 API client，不承载业务逻辑。 |
| product terminal、K8s `pods/exec` | shell 只能通过 Botified bash tool 运行在 sandbox 中。 |
| warm pool、多租户高级 quota、跨集群调度 | 先用 one pod per task + TTL/reap。 |
| Redis、MongoDB、MinIO 作为必选依赖 | Core 不强制。MinIO 可作为自建 S3-compatible 实现细节。 |
| visual gate、rehearsal matrix、release evidence ledger | 不进入默认发布主线。 |

### 2.3 External Acceptance Evidence

以下验收或证据边界不能由本地 fake/stub 测试替代。Botified runner 已拆为已完成的本地 process acceptance、已实现入口但仍待真实运行归档的 runner image/container acceptance，以及仍需真实环境的 full external acceptance；真实环境证据必须保存 redacted evidence：

| Evidence | 必须证明 |
| --- | --- |
| Clean VM self-hosted install | 新 Linux VM 上执行 p1-real online install，生成 `substrate.env`、`substrate.secrets.env`、`doctor-report.json overallStatus=passed`。 |
| Disconnected VM offline install | 同一 offline cache 复制到断网 VM；关闭 egress/DNS 后执行 offline install；证明无公网下载。 |
| Existing-cloud validation | 管理员提供同格式 env/secrets，doctor 通过真实 K8s/Postgres/S3/JuiceFS PVC 检查。 |
| Botified runner local process acceptance | 已由 `npm run acceptance:botified-runner` 覆盖：本地 vendored Botified binary、mock-provider、bash marker、timeline/state/abort。这是本地 process 证据，不替代 full external acceptance。 |
| Botified runner image/container acceptance | `npm run acceptance:botified-runner-image` 已作为手动命令/本地验收入口实现，并有 fake-runtime contract tests 覆盖 build/run/cleanup/secret 边界；真实 runner image/container acceptance 仍需在可拉取 base image 的 Docker 环境中运行并归档 redacted 输出。命令成功时才是 runner-container-only 证据，不证明 K8s/PVC/JuiceFS/product task API/`publish_file`/cancel-reap。 |
| Full runner image/K8s/JuiceFS acceptance | 构建 runner image；在 K8s sandbox pod 中通过 PVC 挂载 JuiceFS 运行 Botified；真实调用 `/v1/messages` 或产品 task API；通过 bash 写 artifact 并产出 timeline/artifact。 |
| Live sandbox task | App 部署到 K8s 后创建 task，sandbox pod 挂载 JuiceFS，Botified bash 写 artifact，API 能轮询 events、下载 artifact。 |
| Resource reclaim | 长任务 cancel、TTL 过期、operator reap 能删除 app-owned pod/service/configmap/secret，并保留持久 project files。 |
| App offline deploy | 使用 digest-pinned app offline bundle 导入镜像、render/apply、doctor、smoke。 |

所有 evidence 必须脱敏：不能包含 raw secret、完整 token、云账号密钥、内部用户数据。

## 3. Repository 设计

### 3.1 `agentsmith-lite-substrates`

职责：安装或验证 AgentSmith Lite 需要的运行基座，并输出统一环境契约。

Owned by substrates repo:

- self-hosted `k3s` bootstrap；
- PostgreSQL 连接和 app database/bootstrap；
- S3-compatible object storage 接入；
- JuiceFS CSI 安装/验证；
- namespace、quota、StorageClass、PVC、dev ingress 基础资源；
- p1-real offline cache download/validate/import；
- `substrate.env`、`substrate.secrets.env`、`kubeconfig`、`doctor-report.json`；
- existing-cloud 模式的环境校验。

Not owned:

- App product code；
- App DB migration bundle；
- App/Botified runner image build；
- App release gate；
- 云供应商资源创建；
- AFSCP/ASBCP/LLMUP/JVS 服务安装。

Required layout:

```text
agentsmith-lite-substrates/
  README.md
  DEVELOPMENT.md
  docs/
    operator-runbook.md
    offline-install.md
    existing-cloud.md
    env-schema.md
  config/
    substrates.self-hosted.example.yaml
    substrates.existing-cloud.example.yaml
    offline-artifacts.example.env
  schemas/
    substrate.env.v1.schema.json
    substrate.secrets.env.v1.schema.json
    substrates-config.v1.schema.json
  scripts/
    download-online.sh
    install-online.sh
    install-offline.sh
    doctor.sh
    validate-env.sh
    validate-juicefs-contract.sh
    reset-dev.sh
    lib/
  manifests/
    namespace/
    postgres/
    minio/
    juicefs-csi/
    quotas/
    ingress-dev/
  out/                # generated, gitignored
  dist/offline-cache/ # generated, gitignored except examples
```

Required outputs:

| Output | Producer | Consumer | Notes |
| --- | --- | --- | --- |
| `out/substrate.env` | install/validate scripts | app deploy/dev scripts | non-secret config only。 |
| `out/substrate.secrets.env` | install/validate scripts 或管理员 | app deploy scripts consume product-secret subset | `0600`；不在日志打印 raw value。 |
| `out/kubeconfig` | self-hosted install | operator scripts | 只在 self-hosted 模式产生。 |
| `dist/offline-cache/manifest.yaml` | `download-online.sh` | `install-offline.sh`, `doctor.sh` | 标记 `cacheMode: p1-real` 才能作为真实离线安装证据。 |
| `dist/offline-cache/images/oci/*.tar` | `download-online.sh --artifacts` | `install-offline.sh` | 只允许 substrate-owned images。 |
| `out/doctor-report.json` | `doctor.sh` | operator/developer | 事实报告，不是治理 ledger。 |

Secret boundary:

- `substrate.env` 不得包含 secret key/value。
- `substrate.secrets.env` 包含 credentials，必须 `chmod 0600`。
- App 只可把产品级 secret 渲染到 app-owned K8s Secret：`POSTGRES_APP_URL`、`APP_SESSION_SECRET`、`BUILTIN_ADMIN_INITIAL_PASSWORD`，以及未来显式启用的 OIDC/admin secrets。
- S3 raw credentials 和 `JUICEFS_META_URL` 只属于 substrate/CSI，不得注入 Web/API/Botified/sandbox containers。

### 3.2 `agentsmith-lite`

职责：产品服务端、静态 Web UI、Botified runtime 集成、sandbox controller、App packaging 和 deploy。

Owned by app repo:

- Node API 和 server-side business logic；
- static Web UI API client；
- OpenAI-compatible endpoint 管理与调用；
- PostgreSQL app migrations；
- project files 和 task artifacts 的服务端 API；
- Botified client、runner image、runtime config；
- K8s sandbox manifest/reconciler；
- app image、app offline bundle、deploy scripts；
- smoke/doctor/status/down 等轻量事实脚本。

Not owned:

- K8s cluster bootstrap；
- raw S3/JuiceFS credential lifecycle；
- LLMUP；
- Codex runner；
- JVS/WebDAV/local mount/remote mount；
- release-kit/governance mainline。

Required layout:

```text
agentsmith-lite/
  README.md
  DEVELOPMENT.md
  OPERATOR.md
  docs/
    agentsmith-lite-product-development-plan.md
    architecture.md
    migration-from-reference.md
    api-contract.md
    storage-and-files.md
    sandbox-controller.md
    botified-runtime.md
  src/web/
  packages/
    contracts/
    domain/
    application/
    ports/
    adapters-postgres/
    openai-compatible-client/
    botified-runtime/
    sandbox-controller/
    api-entry-node/
  infra/
    db/migrations/
    docker/
    k8s/
  third_party/botified/
    PINNED_SOURCE.json
  scripts/
    dev/
    deploy/
    db/
  e2e/
    smoke/
    operator-lifecycle/
  out/                         # generated, gitignored
  dist/app-offline-bundle/      # generated, gitignored
```

Required outputs:

| Output | Producer | Consumer | Notes |
| --- | --- | --- | --- |
| `packages/contracts/api-contract.snapshot.json` | API contract test/build | Web/TUI clients | Product API only；不得暴露 K8s/Botified raw surface。 |
| `dist/` | `npm run build` | tests/dev/docker | compiled server packages and web assets。 |
| `agentsmith-lite/app@sha256:*` | image build/push | deploy/offline bundle | 生产/离线验收必须 digest-pinned。 |
| `agentsmith-lite/botified-runner@sha256:*` | image build/push | sandbox pods/offline bundle | 必须来自 pinned Botified source 或等价批准来源。 |
| `out/manifests/` | `scripts/deploy/render.sh` | apply/doctor | namespace-scoped app resources only。 |
| `dist/app-offline-bundle/` | `scripts/build-offline-bundle.sh` | disconnected app deploy | app images only，不包含 substrate cache。 |
| `out/app-doctor-report.json` | `scripts/deploy/doctor.sh` | operator/developer | 事实报告，不是 release gate ledger。 |
| `out/smoke-report.json` | smoke scripts | operator/developer | 轻量或 full smoke 结果，需标明 profile。 |

## 4. 从参考项目复制与修改策略

目标不是手抄重建，而是从 `.reference` 中复制可用结构，再删掉不属于 Lite 的系统。复制必须留下 ledger，避免旧概念悄悄回流。

Stages:

1. `cp -a` 原始可复用目录到新 repo 临时工作区。
2. 先删除禁用系统，再做适配。不要在旧系统旁边新增 Lite 分支。
3. 保留能直接支撑 Core 的 domain/application/ports/API/UI 片段。
4. 把 JVS/AFSCP/ASBCP/LLMUP/Codex runner/release governance 全部删出 active package graph。
5. 每个 copied path 在 `docs/migration-from-reference.md` 记录 `keep / modify / delete / deferred`。
6. 每次阶段验收运行 forbidden-surface check，确认没有 active import、workspace package、manifest、route 或 UI entrypoint 回流。

Reference decision table:

| Reference path | Decision | Lite target | Notes |
| --- | --- | --- | --- |
| `.reference/agentsmith/packages/domain` | modify | `packages/domain` | 只保留 workspace/project/endpoint/file/task/sandbox 基础实体。 |
| `.reference/agentsmith/packages/application` | modify | `packages/application` | 业务逻辑服务端完成；删除 governance/JVS/runner-release paths。 |
| `.reference/agentsmith/packages/api-entry-node` | modify | `packages/api-entry-node` | 保留 Node API；删除 Keycloak hard dependency、AFSCP、ASBCP、LLMUP。 |
| `.reference/agentsmith/src` | modify | `src/web` | 静态 API client；删除 file versioning、mount、WebDAV、terminal。 |
| `.reference/agentsmith/infra/deploy` | mine | `infra/k8s`, `scripts/deploy` | 只复制 namespace-scoped app manifest ideas。 |
| `.reference/agentsmith/e2e` | selective | `e2e/smoke` | 保留少量行为 smoke；删除 story/gate/release matrix。 |
| `.reference/agentsmith-release-kit` | mine | substrates scripts | 只取小型 redaction/offline helper ideas；不复制 evidence system。 |
| `.reference/agentsmith-sandbox-control-plane` | mine | `packages/sandbox-controller` | 保留 sandbox 状态机/RBAC 思路；不保留第三控制平面。 |
| `.reference/botified` | vendor | `third_party/botified` | pinned source；只用于 runner runtime。 |
| `.reference/llm-universal-proxy` | delete | none | LLMUP 完全移除。 |
| `.reference/jvs` | delete | none | 不保留版本化文件系统。 |
| `.reference/agentsmith-fs-control-plane` | delete | none | 不保留文件控制平面/WebDAV/mount。 |
| `.reference/agentsmith-runner` | delete/mine | none | Codex runner 不进入 Lite；只可借鉴 packaging 边界。 |

## 5. 禁止 surface 与边界检查

Forbidden product surfaces:

- `llm-universal-proxy`、`LLMUP`；
- Codex runner / `agentsmith-runner` 作为 agent core；
- JVS、save point、version restore、file version graph；
- WebDAV、本地挂载、远程挂载、file sync daemon；
- AFSCP/ASBCP 作为独立产品控制平面；
- release rehearsal、GA report、evidence ledger、quality-gate matrix；
- UI 直接访问 Botified、K8s、PostgreSQL、S3/JuiceFS raw credentials；
- Product terminal 或 `pods/exec`；
- 测试治理系统本身的测试。

Required checks:

- App repo：`npm run check:forbidden-surfaces`。
- Substrates repo：`scripts/check-forbidden-copy.sh` 或等价脚本。
- API contract test 必须证明 UI/TUI 只依赖 product API。
- K8s manifest doctor 必须拒绝 `pods/exec`、cluster-wide RBAC、substrate-only secrets 注入 app workloads。

## 6. Core 架构

### 6.1 服务端业务边界

所有业务能力必须在服务端完成：

- auth/session；
- workspace/project selection；
- endpoint create/list/use；
- OpenAI-compatible request/response；
- file path normalization、安全校验、upload/download；
- task state、events、artifacts；
- sandbox create/cancel/reap/status；
- Botified HTTP client；
- database persistence；
- K8s manifest rendering/reconciliation。

Web UI 和未来 TUI 只做：

- 登录/session 使用；
- 表单、列表、timeline、artifact/file 展示；
- 调用 `/api/...`；
- 不保存 secret；
- 不直接访问 Botified/K8s/Postgres/S3/JuiceFS。

### 6.2 数据模型分层

Core tables:

| Area | Tables / records | Notes |
| --- | --- | --- |
| auth | `users`, `sessions` 或等价内建 admin/session | 私有化 MVP。 |
| workspace/project | `workspaces`, `projects` | 最小 create/list/select；全量 CRUD deferred。 |
| endpoints | `model_endpoints` | OpenAI-compatible fields；secret value 只存 secret ref 或 server-side secret。 |
| files | `project_files` 可选索引；实际内容在 JuiceFS | 服务端负责 path safety。 |
| tasks | `tasks`, `task_events`, `task_artifacts` | task lifecycle 和 Botified timeline projection。 |
| sandbox | `sandbox_runs`, `sandbox_leases` | pod identity、TTL、cleanup status。 |

Deferred records:

- `chat_sessions`、`chat_messages`、`chat_attachments`；
- `audit_events`、`usage_events` 的产品化报表；
- membership/group/template/RBAC 扩展；
- endpoint edit history；
- file delete/recycle/versioning metadata。

### 6.3 Files 与 artifacts

Core 文件规则：

- 项目文件位于 JuiceFS PVC 的 project-scoped 目录。
- API 对所有 path 做 normalization，禁止 traversal、absolute path、symlink escape。
- Project files Core：list、upload、download。
- Task artifacts Core：从 Botified timeline 或 runtime marker 投影；支持 list/download。
- Project file delete 和版本化恢复 deferred。

### 6.4 Sandbox 与 Botified

Core runtime:

1. API 创建 task 记录。
2. Sandbox controller 创建 namespace-scoped pod/configmap/secret/service。
3. Pod 使用 `agentsmith-lite/botified-runner@sha256:*`。
4. Runner 启动 `botified serve`，配置 OpenAI-compatible endpoint 和 project workspace。
5. API 通过 Botified HTTP 调 `/v1/messages`、`/v1/timeline`、`/v1/state`、`/v1/abort`。
6. Botified bash tool 在 sandbox workspace 写文件。
7. API 将 timeline/file events 投影为 task events/artifacts。
8. Cancel 调 `/v1/abort`，随后删除 app-owned sandbox resources。
9. TTL/reap 清理 pod/service/configmap/secret，但不自动删除 durable project files。

External Botified acceptance still open unless separately proven:

- 构建 runner image 并运行真实 Botified acceptance；
- 在真实部署/API restart 中验收 `/v1/state` fallback 能从 cursor 或 state 恢复 timeline；
- full smoke 中使用 bash 写入已知 artifact，并通过 API 下载校验。

### 6.5 Resource lifecycle

Core resource policy:

- 所有 app-owned K8s resources 带 `agentsmith-lite/managed-by=agentsmith-lite`。
- Sandbox resources 带 task/run labels。
- API service account 只能 create/get/list/delete/patch 必需 namespace resources。
- 禁止 cluster-wide RBAC 和 `pods/exec`。
- `status.sh --resources` 可展示 active task/sandbox 状态。
- `reap` 只清理 app-owned expired/cancelled resources。
- `down.sh` 默认只删 app-owned namespaced resources，不删 PVC/PV/bucket/database。

## 7. 命令契约

本文区分“当前脚本已支持”和“阶段待实现”。如果命令未在当前脚本中支持，不得写成已完成验收。

### 7.1 Substrates repo 当前命令

```bash
scripts/download-online.sh --output dist/offline-cache [--force] [--contract-only]
scripts/download-online.sh --artifacts config/offline-artifacts.env --output dist/offline-cache --force

scripts/install-online.sh --cache dist/offline-cache --config config/substrates.self-hosted.example.yaml --output out/ [--dry-run] [--force]
scripts/install-offline.sh --cache dist/offline-cache --config config/substrates.self-hosted.example.yaml --output out/ [--dry-run] [--force]

scripts/validate-env.sh --env out/substrate.env --secrets out/substrate.secrets.env
scripts/validate-juicefs-contract.sh --env out/substrate.env --secrets out/substrate.secrets.env
scripts/doctor.sh --env out/substrate.env --secrets out/substrate.secrets.env [--offline-cache dist/offline-cache] [--report out/doctor-report.json] [--dry-run]
scripts/test.sh
```

Important semantics:

- `download-online.sh` without `--artifacts` writes a P0 contract skeleton only；它不是真实离线安装包。
- 非 dry-run `install-online.sh` / `install-offline.sh` 必须使用 `cacheMode: p1-real`。
- Existing-cloud 使用同一 env/secrets 格式；它验证管理员提供的服务，不创建云资源。

### 7.2 App repo 当前命令

```bash
npm install
npm run typecheck
npm test
npm run check:forbidden-surfaces

scripts/dev/up.sh [--env substrate.env --secrets substrate.secrets.env] [--app-env app.env] [--app-secrets app.secrets.env]

npm run e2e:smoke
npm run e2e:operator-lifecycle
npm run visual:screenshot

scripts/build-images.sh --tag <tag> [--runtime docker] [--push [--images-lock images.lock]] [--dry-run]
scripts/build-offline-bundle.sh \
  --images-lock images.lock \
  [--output dist/app-offline-bundle] [--runtime docker]
scripts/build-offline-bundle.sh \
  --app-image agentsmith-lite/app@sha256:<64hex> \
  --runner-image agentsmith-lite/botified-runner@sha256:<64hex> \
  [--output dist/app-offline-bundle] [--runtime docker]

scripts/deploy/render.sh --env substrate.env [--secrets substrate.secrets.env] [--app-env app.env] [--app-secrets app.secrets.env] --tag <tag> --out out/manifests [--images-lock images.lock]
scripts/deploy/apply.sh [--env substrate.env] [--out out/manifests] [--images-lock images.lock] [--timeout 300s] [--dry-run]
scripts/deploy/status.sh --env substrate.env
scripts/deploy/status.sh --env substrate.env --resources --base-url <url> --cookie-file <cookie-file> [--csrf-token <token>]
scripts/deploy/cleanup-stuck-tasks.sh --env substrate.env --dry-run|--apply --cookie-file <cookie-file> [--csrf-token <token>] [--run-id <run-id>]
scripts/deploy/doctor.sh --env substrate.env --secrets substrate.secrets.env [--app-env app.env] [--app-secrets app.secrets.env] [--out out/manifests] [--bundle dist/app-offline-bundle] [--images-lock images.lock]
scripts/deploy/smoke.sh --base-url <url> --secrets substrate.secrets.env [--app-env app.smoke.env] [--report out/smoke-report.json]
scripts/deploy/smoke.sh --env substrate.env --secrets substrate.secrets.env [--app-env app.smoke.env] --endpoint-base-url <url> --endpoint-model <model> --endpoint-secret-ref <secret-ref> [--task-smoke] [--task-reclaim-smoke] [--task-reclaim-reap-apply] [--report out/smoke-report.json]
scripts/deploy/down.sh --env substrate.env [--dry-run]
```

Known command status and gaps:

- `--env`/`--secrets` 只表示 substrate contract；`--app-env`/`--app-secrets` 只表示 app-owned deploy/runtime/smoke overlay。`POSTGRES_APP_URL`、`APP_SESSION_SECRET`、`BUILTIN_ADMIN_INITIAL_PASSWORD`、`OIDC_CLIENT_SECRET` 仍来自 substrate secrets；`AGENTSMITH_LITE_SANDBOX_MODE`、`AGENTSMITH_LITE_MODEL_BASE_URL_*`、`SMOKE_*` 等来自 app env overlay，`AGENTSMITH_LITE_MODEL_API_KEY_*` 来自 app secrets overlay。raw `S3_*`/JuiceFS substrate secrets 不能进入 app overlay。
- `scripts/dev/up.sh --env/--secrets [--app-env/--app-secrets]` 已作为本地 dev env 契约补齐：allowlist 限制可加载的 substrate contract 与 app overlay key，并有测试覆盖。它只证明本地 API/dev 启动契约，不证明真实 substrate readiness，也不替代 clean/offline/existing-cloud evidence。
- `npm run acceptance:botified-runner` 已覆盖本地 vendored Botified process：mock-provider、bash marker、timeline/state/abort。`scripts/deploy/smoke.sh --task-smoke` 覆盖产品 API 的 task artifact path：需要 endpoint config，创建 task，轮询 `/events` 和 `/artifacts`，下载 artifact，并校验 marker；`SMOKE_*` 只放在 app smoke overlay，不放在 substrate env。`scripts/deploy/smoke.sh --task-reclaim-smoke` 是另一个手动 opt-in：创建独立 task，cancel 后对该 `runId` 调用 scoped reap dry-run；`--task-reclaim-reap-apply` 只在 reclaim smoke 开启时允许，并执行 scoped dry-run -> scoped apply -> final scoped dry-run。它们都不进入默认 gate，也不替代 full external acceptance；runner image、sandbox pod、JuiceFS mount、Botified `publish_file`、真实 cancel/reap 在真实集群中的证据仍归入 P3/P4 External Acceptance Evidence。
- `scripts/deploy/operator-sandbox.mjs reap` 支持默认/显式 `--dry-run` 与显式 `--apply`；apply 通过 operator API 发送 `{ "apply": true }`，并由 deploy script 测试覆盖。
- `scripts/build-images.sh --push --images-lock images.lock` 已补齐 build/push 后的 digest-pinned lock 小闭环：push 成功后只从 runtime `RepoDigests` 捕获 app/runner digest refs；`--dry-run` 只打印 build/push/write-lock intent。真实 registry digest 仍必须在 push 后获得，不能用本地 image ID 代替。
- app offline bundle 固定包含 `manifest.yaml`、`images.lock`、`checksums.txt`、`images/app.tar`、`images/botified-runner.tar`。`checksums.txt` 是精确 allowlist，只允许校验 `manifest.yaml`、`images.lock`、`images/app.tar`、`images/botified-runner.tar`，消费端拒绝重复、路径逃逸、绝对路径、URL-like 或非 allowlist 条目。`scripts/build-offline-bundle.sh --images-lock`、`scripts/deploy/render.sh --images-lock`、`scripts/deploy/apply.sh --images-lock` 复用 `parseAppImagesLock()` 语义：输入 lock 可包含注释/空白/前后空格，输出 bundle lock 规范化成 app/runner 两行 digest refs。`scripts/deploy/doctor.sh --bundle` 会校验 bundle 文件、checksum allowlist、bundle `images.lock`，并确保 bundle lock 与 rendered manifests 一致；若同时给 `--images-lock`，还要求显式 lock 与 bundle lock 一致。这只是 app image bundle，不是 substrates p1-real offline cache，不替代真实 disconnected deploy evidence。

### 7.3 Manual gates

这些命令是手动诊断，不进入默认发布主线：

- `npm run e2e:smoke`；
- `npm run e2e:operator-lifecycle`；
- `npm run visual:screenshot`；
- full deploy smoke with real endpoint and task artifact；
- Playwright visual/manual review。

默认主线只要求与阶段相关的 build/typecheck/unit/contract/forbidden checks。任何 visual/e2e 失败都应作为产品质量信号处理，但不再建设单独治理层。

## 8. Phase Plan

### P0：Repo And Scope Bootstrap

Goal：建立两个 repo、删除旧系统入口、锁定 Botified 和 Lite 边界。

Deliverables:

- `agentsmith-lite` 和 `agentsmith-lite-substrates` 两个 repo；
- `.reference/` 只作为参考，不进入 active package graph；
- `third_party/botified/PINNED_SOURCE.json`；
- forbidden surface check；
- `docs/migration-from-reference.md` ledger；
- README/DEVELOPMENT/OPERATOR 基础说明。

Local evidence:

- `git status --short` clean；
- app `npm run check:forbidden-surfaces`；
- substrates forbidden-copy check；
- app `npm install && npm run typecheck`；
- Botified pin 文件存在并通过 checksum/source policy 检查。

External evidence:

- 无。P0 不声称真实 runtime 或部署可用。

Not P0:

- chat persistence；
- full CRUD；
- app offline deploy；
- clean VM/offline VM evidence。

### P1：Substrate Installer

Goal：自建和 existing-cloud 都输出同格式 env/secrets，并能证明 JuiceFS CSI/Postgres/S3/K8s 可用。

Deliverables:

- `download-online.sh` 支持 p1-real artifact lock；
- `install-online.sh` 和 `install-offline.sh` 非 dry-run 支持 p1-real；
- `doctor.sh` 检查 env split、Postgres、S3 probe、JuiceFS CSI、PVC Bound、RWX smoke；
- allowlist 拒绝 app-owned images 和未知 OCI archives；
- `out/substrate.env`、`out/substrate.secrets.env`、`out/doctor-report.json`；
- docs：offline install、existing-cloud、env schema。

Local evidence:

- `scripts/test.sh`；
- `download-online.sh --contract-only` 只证明 skeleton contract；
- `download-online.sh --artifacts file://fixtures` 可证明 lock/checksum/allowlist 逻辑；
- `install-*.sh --dry-run` 只证明 env/cache validation；
- fake `kubectl/psql` tests 只证明 doctor control flow 和 redaction。

External Acceptance Evidence:

- 真实 `config/offline-artifacts.env` 生成 p1-real cache；
- clean VM online self-hosted install，doctor `overallStatus=passed`；
- disconnected VM offline install，无 public download 证据；
- existing-cloud validation，doctor `overallStatus=passed`；
- redacted manifest/checksums/images.lock/doctor reports。

Deferred:

- 多 Linux 发行版矩阵；
- 云资源自动创建；
- PostgreSQL HA/backup productization；
- pgvector，除非后续 feature 明确需要 embeddings；
- TLS policy 深度审计，除非部署目标要求。

### P2：Product API And UI Client

Goal：完成服务端产品最小闭环，Web UI 只作为 API client。

Core deliverables:

- built-in admin/session；
- workspace/project create/list/select；
- endpoint create/list/use，字段限定 OpenAI-compatible；
- server-side chat smoke，不要求持久化；
- project file list/upload/download；
- task create/cancel/status/events/artifacts API；
- API contract snapshot；
- static Web UI 调用 `/api/...`；
- UI boundary test 禁止 provider/K8s/DB/Botified direct access；
- server-side path safety 和 secret redaction。

Local evidence:

- `npm run typecheck`；
- `npm test`；
- API contract test；
- UI boundary test；
- `npm run e2e:smoke` 只证明本地 API/UI smoke，不证明真实 K8s runtime。

External Acceptance Evidence:

- 已部署 app 通过 `scripts/deploy/smoke.sh --base-url ... --secrets ... [--app-env app.smoke.env]` 完成登录/session、workspace/project、endpoint create/list、chat smoke；
- smoke report 脱敏。

Deferred:

- workspace/project update/delete；
- membership/group UI；
- endpoint edit/delete；
- chat_sessions/chat_messages/chat_attachments；
- audit/usage dashboard；
- project file delete UI；
- OIDC。

### P3：Botified Sandbox Agent Tasks

Goal：真实 sandbox task 可以通过 Botified bash 运行、写文件、发布 artifact，并可被取消/回收。

Core deliverables:

- Botified runner image Dockerfile；
- Botified config generator；
- Botified HTTP client：messages、timeline、state、abort；state fallback 已由 core tests 覆盖；
- sandbox pod manifest renderer；
- task event/artifact projection；
- cancel/TTL/reap；
- operator status/reap API。

Local evidence:

- unit tests for manifest/RBAC/resource labels；
- fake Botified client tests for task lifecycle；
- `npm run acceptance:botified-runner` 证明本地 vendored Botified binary process、mock-provider、bash marker、timeline/state/abort；
- `npm run acceptance:botified-runner-image` 已作为 runner image/container 手动验收入口实现，fake-runtime contract tests 覆盖 build/run/cleanup/secret 边界；真实 runner-container-only evidence 仍需在可拉取 base image 的 Docker 环境中运行并归档 redacted 输出；
- API contract tests for events/artifacts/cancel/reap；
- Dockerfile/static checks 只证明形状，不证明 runtime 可跑。

External Acceptance Evidence:

- full runner image build 成功并记录 digest；
- runner image/container 启动 Botified，health/messages/timeline/abort 可用；
- live K8s task 使用 runner image，在 sandbox pod 通过 PVC/JuiceFS 写已知文件；
- API events 出现 expected timeline；
- artifact list/download 内容校验通过；
- cancel 调用 `/v1/abort` 并删除 app-owned sandbox resources；
- 真实部署中 API restart 后能从 cursor 或 `/v1/state` 恢复 timeline，并归档 redacted evidence。

Deferred:

- warm pool；
- multi-agent orchestration UI；
- product terminal；
- direct pod exec；
- long-running session attach UX。

### P4：K8s App Packaging And Deploy

Goal：App 可以在开发环境调试，也可以打包成 K8s 容器服务并部署到 self-hosted 或 existing-cloud substrate。

Core deliverables:

- `scripts/build-images.sh`；
- digest capture/publish runbook；
- `scripts/build-offline-bundle.sh` using digest-pinned images；
- K8s manifests for API/web/schema bootstrap/sandbox RBAC/network policy；
- deploy scripts：render/apply/status/doctor/smoke/down/import-images；
- app doctor 检查 secret boundary、RBAC、schema job、image lock/bundle；
- smoke 分层：default lightweight，manual full acceptance。

Local evidence:

- `scripts/build-images.sh --dry-run`；
- render/doctor static checks；
- apply dry-run；
- offline bundle validation with local digest-pinned images；
- deploy script unit/contract tests。

External Acceptance Evidence:

- self-hosted substrate 上 render/apply/status/doctor/smoke；
- existing-cloud substrate 上 render/apply/status/doctor/smoke；
- disconnected app offline deploy：import images、render/apply、doctor、smoke；
- full external acceptance smoke：login、endpoint、chat smoke、file upload/download、runner image/K8s sandbox/JuiceFS Botified task artifact、cancel/reap。

Deferred:

- multi-region deploy；
- Helm chart productization；
- advanced backup/restore UX；
- CI release trains。

### P5：Cleanup, Hardening, Handoff

Goal：关闭迁移尾巴，保证 Lite 的边界清晰、操作方式简单、文档可交接。

Deliverables:

- `docs/architecture.md`；
- `docs/migration-from-reference.md` 完整 ledger；
- `docs/operator-runbook.md` 或 `OPERATOR.md`；
- env/secrets examples 脱敏；
- forbidden surface checks 常态化；
- least-privilege RBAC review；
- resource cleanup runbook；
- evidence index template。

Local evidence:

- app `npm run typecheck && npm test && npm run check:forbidden-surfaces`；
- substrates `scripts/test.sh`；
- docs sanity：关键章节、命令、产出物存在；
- generated output 不被误提交。

External Acceptance Evidence:

- P1/P3/P4 evidence index 链接到 redacted reports；
- handoff checklist 全部勾选；
- 已知 deferred 项明确写入 backlog，不混入 Core。

P5 不新增产品功能。任何新功能必须回到 Core/Deferred 分层重新判断。

## 9. 产出物清单

| Artifact | Repo | Status target | Purpose |
| --- | --- | --- | --- |
| `docs/agentsmith-lite-product-development-plan.md` | app | Core | 本计划。 |
| `docs/architecture.md` | app | Core | 服务端、sandbox、Botified、files、deploy 架构。 |
| `docs/migration-from-reference.md` | app | Core | cp/modify/delete ledger。 |
| `docs/api-contract.md` + snapshot | app | Core | UI/TUI 只依赖产品 API。 |
| `docs/storage-and-files.md` | app | Core | JuiceFS path layout、path safety、artifact boundary。 |
| `docs/sandbox-controller.md` | app | Core | K8s labels/RBAC/reconciler/cleanup。 |
| `docs/botified-runtime.md` | app | Core | Botified config、event projection、state fallback。 |
| `infra/db/migrations/` | app | Core | MVP schema。 |
| `infra/docker/Dockerfile.app` | app | Core | App image。 |
| `infra/docker/Dockerfile.botified-runner` | app | Core | Botified runner image。 |
| `scripts/deploy/*` | app | Core | render/apply/status/doctor/smoke/down/import。 |
| `dist/app-offline-bundle/` | app | External evidence | 生成产物，不进 git。 |
| `schemas/*.json` | substrates | Core | env/config validation。 |
| `scripts/install-online.sh` | substrates | Core | online/self-hosted/existing-cloud validation entrypoint。 |
| `scripts/install-offline.sh` | substrates | Core | disconnected install entrypoint。 |
| `scripts/download-online.sh` | substrates | Core | p1-real cache producer。 |
| `scripts/doctor.sh` | substrates | Core | substrate factual readiness report。 |
| `dist/offline-cache/` | substrates | External evidence | 生成产物，不进 git。 |

## 10. Acceptance Matrix

| Capability | Local proof can prove | Local proof cannot prove | Required external evidence |
| --- | --- | --- | --- |
| Removed systems absent | static grep/import/package checks | historical files under `.reference` are irrelevant | none unless forbidden surface appears in active repo。 |
| Env/secrets split | schema tests, redaction tests | operator-provided secrets correctness | redacted real env validation report。 |
| Offline cache | checksum/allowlist/manifest logic | that real internet artifacts are complete | p1-real cache manifest/checksums/images.lock。 |
| Substrate install | script control flow | clean host compatibility, no egress | clean VM + disconnected VM reports。 |
| Product API | route/schema/service tests | real deployed ingress/session behavior | deploy smoke report。 |
| UI boundary | static tests | visual usability | manual visual screenshot if UI changed。 |
| Botified runtime | fake client/unit tests；`npm run acceptance:botified-runner` 覆盖本地 vendored binary process；`npm run acceptance:botified-runner-image` 入口和 fake-runtime contract tests 已实现 | successful runner-container-only command output、K8s pod/PVC/JuiceFS artifact、product task artifact、`publish_file`、cancel/reap | local process acceptance log + successful container acceptance log + full external runner/live task reports。 |
| Live sandbox | manifest tests、本地 runner process/container acceptance | pod scheduling, PVC mount, JuiceFS-backed bash artifact | full runner image/K8s/JuiceFS live task artifact smoke report。 |
| Cleanup/reap | unit/fake lifecycle | real K8s resource deletion | live cancel/TTL/reap report。 |
| App offline bundle | bundle script validation | real disconnected import/deploy | disconnected app deploy report。 |

## 11. Ready For Development Checklist

This checklist is for handoff, not a release gate bureaucracy.

- [ ] Core/Deferred/External Evidence scope reviewed by product and engineering.
- [ ] `docs/migration-from-reference.md` covers every copied active path.
- [ ] Forbidden surfaces absent from active package graph, manifests, routes, UI.
- [ ] App command contract matches current scripts or is marked TODO.
- [ ] Substrate command contract matches current scripts or is marked TODO.
- [ ] P0/P1/P2/P3/P4/P5 acceptance criteria distinguish local proof from external evidence.
- [ ] Full external Botified/K8s/JuiceFS bash artifact smoke is implemented or explicitly tracked as open P3 work.
- [ ] Clean VM/offline VM/existing-cloud evidence is collected before claiming deployment readiness.
- [ ] Visual/e2e/manual gates remain diagnostics, not default release mainline.
- [ ] Root copy of this plan, if kept, is synchronized intentionally after review.

## 12. Immediate Next Work

1. Completed: `docs/migration-from-reference.md` migration ledger, `scripts/dev/up.sh --env/--secrets [--app-env/--app-secrets]` allowlist/tests, and `npm run acceptance:botified-runner` local process acceptance.
2. Completed: `npm run acceptance:botified-runner-image` has passed in a Docker environment that could pull base images; this is real runner-container-only acceptance evidence and still does not cover K8s/PVC/JuiceFS/product task API/`publish_file`/cancel-reap.
3. Collect full runner image/K8s/JuiceFS live artifact evidence: runner image digest, sandbox pod/PVC mount, Botified bash marker, timeline/artifact, cancel/reap.
4. Run real `scripts/deploy/smoke.sh --task-smoke` with any `SMOKE_*` values in `--app-env`, and, when collecting manual reclaim evidence, `--task-reclaim-smoke [--task-reclaim-reap-apply]` in self-hosted/existing-cloud/offline deploys and archive redacted reports; these smokes remain supporting evidence and do not replace real K8s/JuiceFS observations.
5. Generate real `config/offline-artifacts.env` and real substrate env/secrets, then run clean VM/disconnected VM/existing-cloud acceptance.
6. Keep chat persistence、audit/usage dashboard、full CRUD、endpoint edit/delete、file delete UI in deferred backlog until Core runtime/deploy evidence exists.
