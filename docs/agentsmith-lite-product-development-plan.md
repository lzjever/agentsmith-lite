# AgentSmith Lite 产品研发计划

状态：本地单机 K8s 交付版开发交接稿
日期：2026-07-05
适用仓库：`agentsmith-lite`，配套仓库 `agentsmith-lite-substrates`

## 0. 修订结论

本计划不是“已完成报告”，也不是可执行契约。测试不得 assert 本文措辞；测试应验证代码事实、API 行为、部署资源和运行结果。

本版只保留一个当前交付目标：

> 在本地搭建的单机 K8s 测试环境中跑通完整系统闭环：substrates 安装 k3s/Postgres/S3-compatible storage/JuiceFS CSI/Keycloak 并生成 env/secrets；app 部署；用户经 OIDC 登录并建立 session；通过 API/UI 创建 endpoint/project/task；Botified sandbox pod 挂载 JuiceFS 写 artifact；API/UI 能 list/download；cancel、TTL、reap 能清理 app-owned resources。

关键原则：

- 当前交付不要求真正上云测试；`existing-cloud` 保留为后续/可选 deployment profile，不作为当前交付前置。
- Keycloak/OIDC 是 Core。Keycloak 由 `agentsmith-lite-substrates` 安装和配置；app 只做 OIDC client、session 和 API 权限校验。
- doctor/status/quick checks/workflow checks/report 只能是开发、调试、部署仪表信号，不能成为产品主线、第三 repo、发布治理体系、审计记录体系或独立系统。
- 存量治理 overhead 也要删。已有治理类脚本、测试、文档、报告字段、命令参数、矩阵、记录，如果不直接服务本地单机 K8s 产品闭环或最小诊断，就删除；还有少量价值的，降级为手动、可选、生成输出，不进默认主线。
- 默认发布前检查必须克制：少量、快速、精确、小范围，并且与本阶段或本次改动直接相关。
- e2e 和 visual 只属于用户/开发者人工主动运行的 manual diagnostics，不进入整体发布主线。
- 硬规则：凡是不直接帮助“在 K8s 中运行 Botified sandbox task，并通过 API/UI 管理 task/files/artifacts/cancel/reap”的内容，只能落在 doctor/status/diagnostics 或 Deferred。

## 1. 产品目标与不可变边界

AgentSmith Lite 是从原 `agentsmith-project` 大幅简化出来的私有化智能体平台。核心目标是把 Botified agent runtime 放进可回收、可管理、可观察的 K8s sandbox task，并通过产品 API/UI 管理 endpoint、project files、task events、artifacts、cancel 和 resource reap。

| 决策 | 说明 |
| --- | --- |
| 两个 repo | 只保留 `agentsmith-lite` 和 `agentsmith-lite-substrates`。不拆 AFSCP、ASBCP、runner、release-kit 或第三个依赖准备 repo。 |
| 当前交付 profile | 本地单机 K8s 测试环境。跑通完整闭环即可交付开发团队继续产品化。 |
| 后续 profile | `existing-cloud` 和 disconnected/offline 保留为可选部署 profile，共用 env/secrets 契约，但不作为当前交付前置。 |
| 身份系统 | Keycloak/OIDC 是 Core。substrates 安装/配置 Keycloak 并输出 app 可消费的 OIDC issuer/client/secret；app 不安装 Keycloak。 |
| LLM 接口 | 只兼容 OpenAI-compatible Chat Completions/Responses 风格接口。移除 LLMUP。 |
| Agent runtime | 使用 Botified。移除 Codex 作为 agent core 的设计。 |
| 文件系统 | 只支持 JuiceFS CSI。移除 JVS、WebDAV、远程/本地挂载。 |
| 沙箱 | 每个 task 一个 K8s sandbox pod；API 负责生命周期、事件投影、取消和回收。 |
| UI/TUI 边界 | Web UI 和未来产品 TUI 只能调用产品 API，不做 provider 调用、K8s 操作、DB 写入、文件授权判断或认证业务逻辑。 |
| 外部依赖准备 | 外部依赖准备、offline cache、preflight/doctor 静态诊断留在 substrates；preflight 只是 doctor `--dry-run` thin wrapper。 |
| 治理 | 不建设 release/rehearsal/审计台账/质量矩阵。只保留事实型运行诊断。 |

## 2. 范围分层

### 2.1 MVP/Core

MVP/Core 必须服务本地单机 K8s 完整闭环：

| 范围 | Core 内容 |
| --- | --- |
| Substrates | 安装 k3s、PostgreSQL、S3-compatible storage、JuiceFS CSI、Keycloak；生成 `substrate.env`、`substrate.secrets.env`、`kubeconfig` 和必要诊断输出。 |
| Auth | Keycloak realm/client/user bootstrap；app 消费 OIDC issuer/client/client secret；服务端建立 session 并校验 API 权限。 |
| API | session、workspace/project 最小 create/list/select、endpoint create/list/use、一次 server-side endpoint 调用检查、task create/cancel/status/events/artifacts、project file list/upload/download/delete。 |
| Runtime | Botified vendored/pinned；构建 runner image；sandbox pod 运行 Botified；bash 写文件并发布 artifact。 |
| Sandbox | JuiceFS PVC 挂载；最小 RBAC；无 `pods/exec`；TTL/lease/reap/status。 |
| Files | 服务端负责 path normalization、权限、上传、下载、delete、artifact 投影。UI 只通过 API 展示和触发。 |
| Packaging | App image、Botified runner image、K8s manifest render/apply/status/down/doctor、digest-pinned app offline bundle。 |
| Checks | 少量 quick checks 与 workflow checks，只验证与当前阶段/改动相关的事实。 |

Core 中的“chat”不是长期对话产品。MVP 只要求服务端能通过已配置 endpoint 完成一次模型调用，用来验证 endpoint 与 server-side LLM access。

### 2.2 Deployment Profiles

| Profile | 当前定位 |
| --- | --- |
| local-single-node-k8s | 当前交付验证目标。必须跑通完整产品闭环。 |
| existing-cloud | 后续/可选 profile。沿用相同 env/secrets 契约，验证管理员提供的 K8s/Postgres/S3/JuiceFS/Keycloak，不创建云资源，不作为当前交付前置。 |
| disconnected/offline | 后续/可选 profile。offline cache 和 app offline bundle 是 generated deploy artifact/cache；可用于部署诊断，不是产品主线。 |

### 2.3 Deferred

以下能力不进入当前 MVP/Core，除非另开需求并重新评估：

| Deferred 项 | 原因 |
| --- | --- |
| chat persistence、chat attachments、conversation UI | 不属于沙箱 agent 平台首个闭环。 |
| workspace/project 全量 CRUD、membership/group/template UI | 会提前产品化权限管理。Core 先保留最小 owner/admin 语义，并由 OIDC session 承载身份。 |
| endpoint edit/delete、多 provider abstraction、模型路由 UI | Core 先支持 create/list/use。 |
| project file delete UI、文件版本、save/restore、回收站 | Server-side file delete API 属于 Core；UI 删除流程和恢复语义后置。 |
| audit/usage dashboard | 可先保留 server logs/task events/resource counters；产品化报表后置。 |
| 组织级 RBAC 深化 | OIDC 登录是 Core；复杂组织、组同步和细粒度角色后置。 |
| 产品 TUI | 未来可做 API client，但不承载业务逻辑。 |
| product terminal、K8s `pods/exec` | shell 只能通过 Botified bash tool 在 sandbox 中运行。 |
| warm pool、多租户高级 quota、跨集群调度 | 先用 one pod per task + TTL/reap。 |
| Redis、MongoDB、MinIO 作为必选依赖 | Core 不强制。MinIO 只可作为自建 S3-compatible 实现细节。 |
| visual/e2e/rehearsal matrix/审计台账 | 不进入默认发布主线。 |

### 2.4 Deploy/Runtime Diagnostics

本地 fake/stub 只能证明代码路径、接口边界和安全限制，不能冒称本地 K8s readiness。需要声明 readiness 时，运行对应诊断并脱敏分享必要输出；不要建设索引、台账或发布治理流程。

| 诊断信号 | 用途 |
| --- | --- |
| substrate readiness diagnostics | 确认本地 k3s/Postgres/S3/JuiceFS CSI/Keycloak 可用，并生成 app 可消费的 env/secrets。 |
| auth workflow check | 经 Keycloak/OIDC 登录，app 建立 session，API 权限校验生效。 |
| deploy workflow check | app image/runner image 使用 digest；render/apply/status/doctor 指向同一 env/secrets 契约。 |
| task workflow check | 通过产品 API 创建 endpoint/project/task；sandbox pod 挂载 JuiceFS；Botified bash 写 artifact；API/UI list/download。 |
| resource cleanup diagnostics | cancel、TTL、reap 只清理 app-owned pod/service/configmap/secret，不删除 durable project files。 |
| disconnected/offline diagnostics | 可选 profile 的导入/部署诊断；`dist/`、`offline-cache/`、`out/` 均为 generated deploy artifact/cache 或 generated diagnostic output。 |

## 3. Repository 设计

### 3.1 `agentsmith-lite-substrates`

职责：安装或验证 AgentSmith Lite 需要的运行基座，并输出统一环境契约。

Owned by substrates repo:

- local single-node k3s bootstrap；
- PostgreSQL 连接和 app database/bootstrap；
- S3-compatible object storage 接入；
- JuiceFS CSI 安装/验证；
- Keycloak 安装、realm/client/user bootstrap、OIDC issuer/client 配置；
- namespace、quota、StorageClass、PVC、dev ingress 基础资源；
- optional offline cache download/validate/import；
- `substrate.env`、`substrate.secrets.env`、`kubeconfig`、diagnostic output；
- optional existing-cloud profile 的环境校验。

Not owned:

- App product code；
- App DB migration bundle；
- App/Botified runner image build；
- App 发布治理流程；
- 云供应商资源创建；
- AFSCP/ASBCP/LLMUP/JVS 服务安装；
- 第三个依赖准备 repo。

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
    substrates.local-k8s.example.yaml
    substrates.existing-cloud.example.yaml
    offline-artifacts.example.env
  schemas/
    substrate.env.v1.schema.json
    substrate.secrets.env.v1.schema.json
    substrates-config.v1.schema.json
  scripts/
    download-online.sh
    prepare-offline-cache.sh
    install-online.sh
    install-offline.sh
    doctor.sh
    preflight.sh
    validate-env.sh
    validate-juicefs-contract.sh
    reset-dev.sh
    lib/
  manifests/
    namespace/
    postgres/
    s3-compatible/
    juicefs-csi/
    keycloak/
    quotas/
    ingress-dev/
  out/                # generated, gitignored
  dist/offline-cache/ # generated deploy cache, gitignored
```

Required outputs:

| Output | Producer | Consumer | Notes |
| --- | --- | --- | --- |
| `out/substrate.env` | install/validate scripts | app deploy/dev scripts | non-secret config：namespace、ingress、OIDC issuer/client id 等。 |
| `out/substrate.secrets.env` | install/validate scripts 或管理员 | app deploy scripts | `0600`；可包含 `POSTGRES_APP_URL`、`APP_SESSION_SECRET`、`OIDC_CLIENT_SECRET` 等 app 必需 secret。 |
| `out/kubeconfig` | local k3s install | operator/developer scripts | 只在 self-hosted/local 模式产生。 |
| `dist/offline-cache/` | offline cache scripts | optional disconnected install | generated deploy cache，不进 git。 |
| `out/doctor-report.json` | `doctor.sh` | operator/developer | generated diagnostic output，不是台账。 |

Secret boundary:

- `substrate.env` 不得包含 secret value。
- `substrate.secrets.env` 包含 credentials，必须 `chmod 0600`，日志只打印 key 名和 redacted value。
- App 可消费产品级 secret：`POSTGRES_APP_URL`、`APP_SESSION_SECRET`、`OIDC_CLIENT_SECRET`，以及必要的 app runtime secret refs。
- Keycloak admin secret、raw S3 credentials、`JUICEFS_META_URL` 等只属于 substrate/CSI，不得注入 Web/UI/TUI 或 Botified runtime，除非它们被转换为 app 明确需要的受限 secret。
- Dev-only bootstrap/admin 初始化可以保留，但生产身份系统只有 OIDC/Keycloak 一种做法。

### 3.2 `agentsmith-lite`

职责：产品服务端、静态 Web UI、OIDC client/session、Botified runtime 集成、sandbox controller、App packaging 和 deploy。

Owned by app repo:

- Node API 和 server-side business logic；
- OIDC client、session、CSRF/API 权限校验；
- static Web UI API client；
- OpenAI-compatible endpoint 管理与调用；
- PostgreSQL app migrations；
- project files 和 task artifacts 的服务端 API；
- Botified client、runner image、runtime config；
- K8s sandbox manifest/reconciler；
- app image、app offline bundle、deploy scripts；
- doctor/status/quick checks/workflow checks 等轻量诊断脚本。

Not owned:

- K8s cluster bootstrap；
- Keycloak 安装和 realm bootstrap；
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
  third_party/botified/
    PINNED_SOURCE.json
  scripts/
    acceptance/
    dev/
    deploy/
    db/
    visual/
    build-images.sh
    build-offline-bundle.sh
  e2e/
    workflow/
  out/                         # generated diagnostic/deploy output, gitignored
  dist/app-offline-bundle/      # generated deploy artifact, gitignored
```

Required outputs:

| Output | Producer | Consumer | Notes |
| --- | --- | --- | --- |
| `packages/contracts/api-contract.snapshot.json` | API contract test/build | Web/TUI clients | Product API only；不得暴露 K8s/Botified raw surface。 |
| `dist/` | `npm run build` | tests/dev/docker | compiled server packages and web assets。 |
| `agentsmith-lite/app@sha256:*` | image build/push | deploy/offline bundle | 部署用 digest-pinned image。 |
| `agentsmith-lite/botified-runner@sha256:*` | image build/push | sandbox pods/offline bundle | 来自 pinned Botified source 或等价批准来源。 |
| `out/manifests/` | deploy render | apply/doctor | generated namespace-scoped app resources only。 |
| `dist/app-offline-bundle/` | bundle script | optional disconnected app deploy | generated deploy artifact/cache，不是外部验收材料。 |
| `out/app-doctor-report.json` | app doctor | operator/developer | generated diagnostic output，不是台账。 |
| `out/workflow-check-report.json` | workflow check scripts | operator/developer | generated diagnostic output；只记录所跑 workflow。 |

## 4. 从参考项目复制与修改策略

目标不是手抄重建，而是从 `.reference` 中复制可用结构，再删掉不属于 Lite 的系统。复制记录写入 `docs/migration-from-reference.md`，用于说明 keep/modify/delete/deferred，不能演变成治理台账。

| Reference path | Decision | Lite target | Notes |
| --- | --- | --- | --- |
| `.reference/agentsmith/packages/domain` | modify | `packages/domain` | 只保留 workspace/project/endpoint/file/task/sandbox 基础实体。 |
| `.reference/agentsmith/packages/application` | modify | `packages/application` | 业务逻辑服务端完成；删除 governance/JVS/runner-release paths。 |
| `.reference/agentsmith/packages/api-entry-node` | modify | `packages/api-entry-node` | 保留 Node API；接入 OIDC client/session；删除 AFSCP、ASBCP、LLMUP。 |
| `.reference/agentsmith/src` | modify | `src/web` | 静态 API client；删除 file versioning、mount、WebDAV、terminal。 |
| `.reference/agentsmith/infra/deploy` | mine | `packages/sandbox-controller`, `scripts/deploy`, generated `out/manifests` | 只借鉴 namespace-scoped manifest ideas；不维护 tracked static manifest directory。 |
| `.reference/agentsmith/e2e` | selective | `e2e/workflow` | 保留少量人工 workflow diagnostics；删除 story/release matrix。 |
| `.reference/agentsmith-release-kit` | mine | substrates/scripts helper ideas | 只取小型 redaction/offline helper ideas；不复制 release-kit 体系。 |
| `.reference/agentsmith-sandbox-control-plane` | mine | `packages/sandbox-controller` | 保留 sandbox 状态机/RBAC 思路；不保留第三控制平面。 |
| `.reference/botified` | vendor | `third_party/botified` | pinned source；只用于 runner runtime。 |
| `.reference/llm-universal-proxy` | delete | none | LLMUP 完全移除。 |
| `.reference/jvs` | delete | none | 不保留版本化文件系统。 |
| `.reference/agentsmith-fs-control-plane` | delete | none | 不保留文件控制平面/WebDAV/mount。 |
| `.reference/agentsmith-runner` | delete/mine | none | Codex runner 不进入 Lite；只可借鉴 packaging 边界。 |

## 5. 禁止 surface 与测试边界

Forbidden product surfaces:

- `llm-universal-proxy`、`LLMUP`；
- Codex runner / `agentsmith-runner` 作为 agent core；
- JVS、save point、version restore、file version graph；
- WebDAV、本地挂载、远程挂载、file sync daemon；
- AFSCP/ASBCP 作为独立产品控制平面；
- release rehearsal、GA report、审计台账、quality matrix；
- UI/TUI 直接访问 Botified、K8s、PostgreSQL、S3/JuiceFS raw credentials；
- Product terminal 或 `pods/exec`；
- 测试治理系统本身，或让测试 assert 本计划 prose。

Required checks:

- App repo：`npm run check:forbidden-surfaces` 或等价快速检查。
- Substrates repo：`scripts/check-forbidden-copy.sh` 或等价快速检查。
- API contract test 必须证明 Web UI/TUI 只依赖 product API。
- K8s manifest doctor 必须拒绝 `pods/exec`、cluster-wide RBAC、substrate-only secrets 注入 app workloads。

测试策略：

- 默认发布前只跑少量 quick checks：typecheck、相关 unit/contract、forbidden surface、与改动直接相关的 workflow check。
- 不设计大量发布矩阵，不把 e2e/visual 绑进默认主线，不测试测试套本身。
- e2e/visual/manual review 只在 UI 或跨组件风险需要时由用户/开发者主动运行。
- 删除现有治理 overhead 的优先级：先删旧发布链路、rehearsal 和审计记录体系；再删测试治理系统本身的测试；再删笼统或冗余报告字段和命令参数；最后只保留小范围、精准、能说明产品闭环事实的 quick/workflow checks。

## 6. Core 架构

### 6.1 服务端业务边界

所有业务能力必须在服务端完成：

- OIDC callback、session、CSRF/API 权限校验；
- workspace/project selection；
- endpoint create/list/use；
- OpenAI-compatible request/response；
- file path normalization、安全校验、upload/download/delete；
- task state、events、artifacts；
- sandbox create/cancel/reap/status；
- Botified HTTP client；
- database persistence；
- K8s manifest rendering/reconciliation。

### 6.2 身份系统边界

- Keycloak 是唯一生产身份系统。
- `agentsmith-lite-substrates` 负责 Keycloak 安装、realm/client/user bootstrap，并输出 `OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET` 等 env/secrets。
- `agentsmith-lite` 只消费 OIDC 配置，完成 login callback、session 和 API 权限校验。
- Web UI/TUI 不实现认证业务逻辑，只跟随 app session/API 状态。
- Dev-only bootstrap/admin 初始化只能用于本地开发或初始设置，不能形成第二套生产 auth。

### 6.3 TUI 边界

未来产品 TUI 只能消费 product API/types + thin HTTP client：

- 可以 import `packages/contracts` 或生成的 API types。
- 不得 import `application`、`ports`、`sandbox-controller`、`botified-runtime`、`openai-compatible-client`、`adapters-postgres` 或 K8s client。
- 不得调用 `/api/operator/*`。
- 如需运维 TUI，必须是单独 ops client，面向 operator diagnostics，不进入产品 TUI。

### 6.4 Files 与 artifacts

- Project files 位于 JuiceFS PVC 的 project-scoped 目录。
- API 对所有 path 做 normalization，禁止 traversal、absolute path、symlink escape。
- Project files Core：list、upload、download、server-side delete API。Delete rejects the `files/` root and does not imply recycle/version restore semantics。
- Task artifacts Core：从 Botified timeline 或 runtime marker 投影；支持 list/download。
- Project file delete UI、版本化恢复和回收站 deferred。

### 6.5 Sandbox 与 Botified

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

### 6.6 Resource lifecycle

- 所有 app-owned K8s resources 带 `agentsmith-lite/managed-by=agentsmith-lite`。
- Sandbox resources 带 task/run labels。
- API service account 只能 create/get/list/delete/patch 必需 namespace resources。
- 禁止 cluster-wide RBAC 和 `pods/exec`。
- `status.sh --resources` 可展示 active task/sandbox 状态。
- `reap` 只清理 app-owned expired/cancelled resources。
- `down.sh` 默认只删 app-owned namespaced resources，不删 PVC/PV/bucket/database/Keycloak。

## 7. 命令与诊断语义

本文描述目标语义，不声称所有命令已经实现。脚本命名应尽量按具体场景命名：quick checks、auth workflow check、task workflow check、deploy diagnostics、readiness diagnostics。

### 7.1 Substrates

Core commands:

```bash
scripts/prepare-offline-cache.sh --artifacts-dir out/artifacts --output dist/offline-cache [--force]
scripts/download-online.sh --output dist/offline-cache [--force] [--contract-only]
scripts/download-online.sh --artifacts config/offline-artifacts.env --output dist/offline-cache --force

scripts/install-online.sh --cache dist/offline-cache --config config/substrates.local-k8s.example.yaml --output out/ [--dry-run] [--force]
scripts/install-offline.sh --cache dist/offline-cache --config config/substrates.local-k8s.example.yaml --output out/ [--dry-run] [--force]

scripts/validate-env.sh --env out/substrate.env --secrets out/substrate.secrets.env
scripts/validate-juicefs-contract.sh --env out/substrate.env --secrets out/substrate.secrets.env
scripts/preflight.sh --env out/substrate.env --secrets out/substrate.secrets.env [--offline-cache dist/offline-cache] [--report out/doctor-report.json]
scripts/doctor.sh --env out/substrate.env --secrets out/substrate.secrets.env [--offline-cache dist/offline-cache] [--report out/doctor-report.json] [--dry-run]
scripts/test.sh
```

Important semantics:

- `download-online.sh` without `--artifacts` 只写 contract skeleton；不是真实 offline cache。
- `prepare-offline-cache.sh` 留在 substrates；它不是第三个 repo，不是 live install，也不提交 generated cache。
- 非 dry-run `install-online.sh` / `install-offline.sh` 必须使用真实 cache/profile。
- Keycloak readiness 属于 substrate doctor：issuer discovery、client config、redirect URI、client secret presence、token validation path 都要可诊断。
- `scripts/preflight.sh` 只是 `scripts/doctor.sh --dry-run` 的 thin wrapper；它不是第三个 repo，不替代 live local K8s workflow。

### 7.2 App

Core commands:

```bash
npm install
npm run typecheck
npm test
npm run check:forbidden-surfaces

scripts/dev/up.sh [--env substrate.env --secrets substrate.secrets.env] [--app-env app.env] [--app-secrets app.secrets.env]

scripts/build-images.sh --tag <tag> [--runtime docker] [--push [--images-lock images.lock]] [--dry-run]
scripts/build-offline-bundle.sh --images-lock images.lock [--output dist/app-offline-bundle] [--runtime docker]

scripts/deploy/render.sh --env substrate.env [--secrets substrate.secrets.env] [--app-env app.env] [--app-secrets app.secrets.env] --tag <tag> --out out/manifests [--images-lock images.lock]
scripts/deploy/apply.sh [--env substrate.env] [--out out/manifests] [--images-lock images.lock] [--timeout 300s] [--dry-run]
scripts/deploy/status.sh --env substrate.env [--resources]
scripts/deploy/preflight.sh --env substrate.env --secrets substrate.secrets.env [--app-env app.env] [--app-secrets app.secrets.env] [--out out/manifests] [--bundle dist/app-offline-bundle] [--images-lock images.lock]
scripts/deploy/doctor.sh --env substrate.env --secrets substrate.secrets.env [--app-env app.env] [--app-secrets app.secrets.env] [--out out/manifests] [--bundle dist/app-offline-bundle] [--images-lock images.lock]
scripts/deploy/down.sh --env substrate.env [--dry-run]
```

Workflow check targets:

- auth workflow check：OIDC login/callback/session/API permission。
- deploy workflow check：render/apply/status/doctor 与 digest-pinned images。
- task workflow check：endpoint/project/task/artifact/cancel/reap。
- UI workflow check：API/UI list/download artifact and files。

Known semantics:

- `--env`/`--secrets` 表示 substrate contract；`--app-env`/`--app-secrets` 表示 app-owned overlay。
- App runtime 可消费 `POSTGRES_APP_URL`、`APP_SESSION_SECRET`、`OIDC_ISSUER_URL`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET` 等产品级配置。
- raw `S3_*`、JuiceFS substrate secrets、Keycloak admin secret 不能进入 app overlay。
- `scripts/deploy/preflight.sh` 是 app doctor static-only thin entry；不运行 workflow、visual、build/push/import/live K8s。
- app offline bundle 是 app image bundle，不是 substrate offline cache，不替代 local K8s runtime diagnostics。

### 7.3 Manual Diagnostics

以下内容只能人工主动运行，不进入默认发布主线：

- e2e workflow；
- operator lifecycle workflow；
- visual screenshot/manual review；
- deploy workflow with real endpoint and task artifact；
- resource cleanup diagnostics with scoped reap。

默认主线只保留与阶段相关的 build/typecheck/unit/contract/forbidden checks，以及必要的小范围 workflow check。

## 8. Phase Plan

### P0：Repo And Scope Bootstrap

Goal：建立两个 repo、删除旧系统入口、锁定 Botified 和 Lite 边界。

Deliverables:

- `agentsmith-lite` 和 `agentsmith-lite-substrates` 两个 repo；
- `.reference/` 只作为参考，不进入 active package graph；
- `third_party/botified/PINNED_SOURCE.json`；
- forbidden surface check；
- `docs/migration-from-reference.md` 迁移记录；
- README/DEVELOPMENT/OPERATOR 基础说明。

Dev checks:

- app `npm run check:forbidden-surfaces`；
- substrates forbidden-copy check；
- app `npm install && npm run typecheck`；
- Botified pin 文件存在并通过 checksum/source policy 检查。

Deploy/runtime diagnostics:

- 无。P0 不声明 runtime 或部署 readiness。

### P1：Local K8s Substrate And Keycloak

Goal：本地单机 K8s 安装 k3s/Postgres/S3-compatible storage/JuiceFS CSI/Keycloak，并输出 app 可消费的 env/secrets。

Deliverables:

- `install-online.sh` 和 `install-offline.sh` 支持 local-k8s profile；
- Keycloak realm/client/user bootstrap；
- OIDC issuer/client/client secret 输出；
- `doctor.sh` 检查 env split、Postgres、S3 probe、JuiceFS CSI、PVC Bound、RWX write/read、Keycloak issuer/client/token path；
- allowlist 拒绝 app-owned images 和未知 OCI archives；
- `out/substrate.env`、`out/substrate.secrets.env`、`out/doctor-report.json`；
- docs：local-k8s install、offline install、existing-cloud optional profile、env schema。

Dev checks:

- `scripts/test.sh`；
- `download-online.sh --contract-only` 只证明 skeleton contract；
- `install-*.sh --dry-run` 只证明 env/cache validation；
- fake `kubectl/probe` tests 只证明 doctor control flow、probe invocation 和 redaction。

Deploy/runtime diagnostics:

- 本地单机 K8s 非 dry-run install；
- doctor 输出显示 k3s/Postgres/S3/JuiceFS/Keycloak readiness；
- env/secrets 可被 app deploy 消费，脱敏后可分享。

Deferred:

- 真实云运行；
- 多 Linux 发行版矩阵；
- 云资源自动创建；
- PostgreSQL HA/backup productization；
- TLS policy 深度审计，除非部署目标要求。

### P2：Product API, OIDC Session And UI Client

Goal：完成服务端产品最小闭环，Web UI 只作为 API client。

Deliverables:

- OIDC login/callback/session/logout；
- API 权限校验和 CSRF/session boundary；
- workspace/project create/list/select；
- endpoint create/list/use，字段限定 OpenAI-compatible；
- server-side endpoint call check，不要求 chat persistence；
- project file list/upload/download/delete through server-side API；
- task create/cancel/status/events/artifacts API；
- API contract snapshot；
- static Web UI 调用 `/api/...`；
- UI boundary test 禁止 provider/K8s/DB/Botified direct access；
- server-side path safety 和 secret redaction。

Dev checks:

- `npm run typecheck`；
- `npm test`；
- API contract test；
- UI boundary test；
- auth/session unit and contract tests。

Deploy/runtime diagnostics:

- 在本地 K8s app 上完成 auth workflow check；
- 通过 UI/API 创建 project、endpoint，并完成一次 server-side endpoint call check；
- diagnostic output 脱敏即可分享，不建设 index。

Deferred:

- workspace/project update/delete；
- membership/group UI；
- endpoint edit/delete；
- chat_sessions/chat_messages/chat_attachments；
- audit/usage dashboard；
- project file delete UI、版本化恢复、回收站；
- 组织级 RBAC 深化。

### P3：Botified Sandbox Agent Tasks

Goal：真实 sandbox task 可以通过 Botified bash 运行、写文件、发布 artifact，并可被取消/回收。

Deliverables:

- Botified runner image Dockerfile；
- Botified config generator；
- Botified HTTP client：messages、timeline、state、abort；
- sandbox pod manifest renderer；
- task event/artifact projection；
- cancel/TTL/reap；
- operator status/reap API for deploy scripts only。

Dev checks:

- unit tests for manifest/RBAC/resource labels；
- fake Botified client tests for task lifecycle；
- local Botified process acceptance：vendored binary、mock-provider、bash marker、timeline/state/abort；
- runner image/container command 可作为手动验证入口；
- API contract tests for events/artifacts/cancel/reap；
- Dockerfile/static checks 只证明形状，不证明 K8s runtime。

Deploy/runtime diagnostics:

- 本地 K8s task workflow check：通过产品 API 创建 task；
- sandbox pod 使用 digest-pinned runner image；
- pod 挂载 JuiceFS PVC 并通过 Botified bash 写已知 artifact；
- API events/artifacts/list/download 内容校验通过；
- cancel 调用 `/v1/abort` 并删除 app-owned sandbox resources；
- API restart 后能从 cursor 或 `/v1/state` 恢复 timeline。

Deferred:

- warm pool；
- multi-agent orchestration UI；
- product terminal；
- direct pod exec；
- long-running session attach UX。

### P4：K8s App Packaging And Local Deploy

Goal：App 可以打包成 K8s 容器服务，并部署到本地单机 K8s substrate。

Deliverables:

- `scripts/build-images.sh`；
- digest capture/publish runbook；
- `scripts/build-offline-bundle.sh` using digest-pinned images；
- K8s manifests for API/web/schema bootstrap/sandbox RBAC/network policy；
- deploy scripts：render/apply/status/doctor/down/import-images；
- app doctor 检查 secret boundary、RBAC、schema job、image lock/bundle；
- quick checks 和 workflow checks 按场景命名。

Dev checks:

- `scripts/build-images.sh --dry-run`；
- render/doctor static checks；
- apply dry-run；
- offline bundle validation with local digest-pinned images；
- deploy script unit/contract tests。

Deploy/runtime diagnostics:

- local-k8s substrate 上 render/apply/status/doctor；
- auth workflow check；
- deploy workflow check；
- task workflow check；
- disconnected app deploy 只作为 optional profile 诊断：import images、render/apply、doctor、workflow check。

Deferred:

- real cloud validation；
- multi-region deploy；
- Helm chart productization；
- advanced backup/restore UX；
- CI release trains。

### P5：Cleanup, Hardening, Handoff

Goal：关闭迁移尾巴，保证 Lite 的边界清晰、操作方式简单、文档可交接。

Deliverables:

- `docs/architecture.md`；
- `docs/migration-from-reference.md` 迁移记录；
- `docs/operator-runbook.md` 或 `OPERATOR.md`；
- env/secrets examples 脱敏；
- forbidden surface checks 常态化；
- least-privilege RBAC review；
- resource cleanup runbook；
- operator runbook 可链接最近一次脱敏 diagnostic output；
- known Deferred backlog。

Dev checks:

- app `npm run typecheck && npm test && npm run check:forbidden-surfaces`；
- substrates `scripts/test.sh`；
- docs sanity：关键章节、命令、产出物存在；
- generated output 不被误提交。

Deploy/runtime diagnostics:

- 本地单机 K8s 完整闭环已跑通；
- runbook 包含最近一次脱敏诊断输出的链接或路径；
- 已知 Deferred 项明确写入 backlog，不混入 Core。

P5 不新增产品功能。任何新功能必须回到 Core/Deferred 分层重新判断。

## 9. 产出物清单

| Artifact | Repo | Status target | Purpose |
| --- | --- | --- | --- |
| `docs/agentsmith-lite-product-development-plan.md` | app | Core | 本计划。 |
| `docs/architecture.md` | app | Core | 服务端、OIDC、sandbox、Botified、files、deploy 架构。 |
| `docs/migration-from-reference.md` | app | Core | copied paths 的迁移记录。 |
| `docs/api-contract.md` + snapshot | app | Core | UI/TUI 只依赖产品 API。 |
| `docs/storage-and-files.md` | app | Core | JuiceFS path layout、path safety、artifact boundary。 |
| `docs/sandbox-controller.md` | app | Core | K8s labels/RBAC/reconciler/cleanup。 |
| `docs/botified-runtime.md` | app | Core | Botified config、event projection、state fallback。 |
| `infra/db/migrations/` | app | Core | MVP schema。 |
| `infra/docker/Dockerfile.app` | app | Core | App image。 |
| `infra/docker/Dockerfile.botified-runner` | app | Core | Botified runner image。 |
| `scripts/deploy/*` | app | Core | render/apply/status/doctor/down/import/workflow diagnostics。 |
| `dist/app-offline-bundle/` | app | Generated deploy artifact/cache | 生成产物，不进 git。 |
| `out/app-doctor-report.json` | app | Generated diagnostic output | 运行诊断输出，不是台账。 |
| `out/workflow-check-report.json` | app | Generated diagnostic output | 按 workflow 标明范围，不是发布治理材料。 |
| `schemas/*.json` | substrates | Core | env/config validation。 |
| `scripts/install-online.sh` | substrates | Core | local-k8s install；existing-cloud optional profile validation。 |
| `scripts/install-offline.sh` | substrates | Optional profile | disconnected install entrypoint。 |
| `scripts/download-online.sh` | substrates | Optional profile | offline cache producer。 |
| `scripts/doctor.sh` | substrates | Core diagnostics | substrate readiness diagnostics。 |
| `dist/offline-cache/` | substrates | Generated deploy artifact/cache | 生成产物，不进 git。 |
| `out/doctor-report.json` | substrates | Generated diagnostic output | 运行诊断输出，不是台账。 |

## 10. 验证边界

| Capability | Quick/dev checks can prove | Local K8s runtime must prove |
| --- | --- | --- |
| Removed systems absent | static grep/import/package checks | none unless forbidden surface appears in active repo。 |
| Env/secrets split | schema tests, redaction tests | app consumes OIDC/Postgres/session config without leaking substrate-only secrets。 |
| Keycloak/OIDC | config parser, callback/session unit tests | Keycloak issuer/client works；login/session/API permission path works。 |
| Substrate install | script control flow, dry-run validation | local k3s/Postgres/S3/JuiceFS/Keycloak readiness。 |
| Product API | route/schema/service tests | deployed ingress/session behavior and product API workflow。 |
| UI boundary | static tests | manual UI review only when UI changed。 |
| Botified runtime | fake client/unit tests, local process check | K8s pod/PVC/JuiceFS artifact path through product task API。 |
| Cleanup/reap | unit/fake lifecycle | real app-owned K8s resource deletion after cancel/TTL/reap。 |
| App offline bundle | bundle script validation | optional disconnected profile only；not required for current local-k8s delivery。 |

默认发布前验证只选与本次改动有关的行，不跑全表，不扩大成矩阵。

## 11. Development Handoff Checklist

此清单只用于开发交接，不是发布治理流程。

- [ ] Core/Deferred scope reviewed by product and engineering.
- [ ] 当前交付目标明确为 local-single-node-k8s full loop。
- [ ] `existing-cloud` 写为 optional deployment profile。
- [ ] Keycloak/OIDC 是 Core，且没有第二套生产身份系统。
- [ ] `docs/migration-from-reference.md` covers copied active paths。
- [ ] Forbidden surfaces absent from active package graph, manifests, routes, UI。
- [ ] App command contract matches current scripts or is marked TODO。
- [ ] Substrate command contract matches current scripts or is marked TODO。
- [ ] Web UI 和未来产品 TUI 只依赖 product API/types。
- [ ] Manual diagnostics 不进入默认发布主线。
- [ ] Generated deploy artifacts/cache 和 diagnostic output 不被误提交。

## 12. Immediate Next Work

1. 先清存量治理 overhead：删除不服务本地 K8s 产品闭环或最小诊断的旧发布链路、rehearsal、审计记录、报告、测试参数和文档；保留项必须降级为手动、可选、生成输出。
2. Build/push digest-pinned app image and Botified runner image，生成 images lock。
3. 在本地单机 K8s 环境安装 substrates：k3s/Postgres/S3-compatible storage/JuiceFS CSI/Keycloak。
4. 生成并校验 `substrate.env`、`substrate.secrets.env`，确保 OIDC issuer/client/client secret 可供 app 使用。
5. Render/apply app manifests，确认 app 使用 digest-pinned images 和正确 env/secrets。
6. 跑 auth workflow check：Keycloak login/callback/session/API permission。
7. 通过产品 API/UI 创建 project 和 OpenAI-compatible endpoint。
8. 通过产品 API 创建 task，让 Botified sandbox pod 挂载 JuiceFS 并写 artifact。
9. 通过 API/UI list/download task artifacts 和 project files。
10. 验证 cancel、TTL、reap 清理 app-owned resources，保留 durable project files。
11. 再按需运行 optional profiles：existing-cloud validation、disconnected/offline deploy diagnostics。
12. chat persistence、audit/usage dashboard、full CRUD、endpoint edit/delete、project file delete UI/version/restore/recycle bin 继续留在 Deferred。
