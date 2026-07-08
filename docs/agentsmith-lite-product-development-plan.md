# AgentSmith Lite 产品研发计划

状态：核心业务开发版
日期：2026-07-08
适用仓库：`agentsmith-lite`，配套仓库 `agentsmith-lite-substrates`

## 0. 当前最高原则

本计划只服务一个目标：尽快把核心业务闭环做出来，并用少量、直接、和改动相关的测试确认它能跑。

当前交付目标：

> 在本地搭建的单机 K8s 测试环境中跑通完整系统闭环：`agentsmith-lite-substrates` 安装 k3s/PostgreSQL/S3-compatible storage/JuiceFS CSI/Keycloak 并生成 env/secrets；`agentsmith-lite` 部署 app 和 Botified runner；用户通过 Keycloak/OIDC 登录；通过 API/UI 创建 project、endpoint、task；Botified sandbox pod 挂载 JuiceFS 写 artifact；API/UI 能 list/download；cancel、TTL、reap 能清理 app-owned resources。

硬规则：

- 100% 精力放在核心业务逻辑、K8s 沙箱运行、Keycloak/OIDC、Botified runtime、文件/artifact、资源回收上。
- 不再建设 evidence、report、release、rehearsal、gate、质量矩阵、诊断文档生成、审计记录体系。
- 已存在的治理 overhead 该删就删，不要手软；不直接服务核心闭环或少量必要测试的脚本、参数、报告字段、文档段落、测试套件都应删除。
- 出现错误快速失败，就地修正；不要为了失败再建一层治理、包装、报告或流程。
- 测试只验证产品代码事实和核心行为；不要测试测试系统本身，不要 assert 计划文档 prose。
- e2e 和 visual 只在用户/开发者主动要求时手动运行，不进入默认发布前验证。
- 默认发布前验证必须克制：只跑少量、快速、精确、和本次改动相关的 checks。

## 1. 产品边界

AgentSmith Lite 是从原 `agentsmith-project` 大幅简化出来的私有化智能体平台。核心目标是把 Botified agent runtime 放进可回收、可管理、可观察的 K8s sandbox task，并通过产品 API/UI 管理 endpoint、project files、task events、artifacts、cancel 和 resource reap。

| 决策 | 说明 |
| --- | --- |
| 两个 repo | 只保留 `agentsmith-lite` 和 `agentsmith-lite-substrates`。不拆 AFSCP、ASBCP、runner、release-kit 或第三个依赖准备 repo。 |
| 当前交付 profile | 本地单机 K8s 测试环境。跑通完整闭环即可继续产品化。 |
| 后续 profile | `existing-cloud` 和 disconnected/offline 仅保留为后续部署能力，不作为当前交付前置。 |
| 身份系统 | Keycloak/OIDC 是 Core。substrates 安装/配置 Keycloak 并输出 app 可消费的 OIDC issuer/client/secret；app 不安装 Keycloak。 |
| LLM 接口 | 只兼容 OpenAI-compatible 接口。移除 LLMUP。 |
| Agent runtime | 使用 Botified。移除 Codex 作为 agent core 的设计。 |
| 文件系统 | 只支持 JuiceFS CSI。移除 JVS、WebDAV、远程/本地挂载。 |
| 沙箱 | 每个 task 一个 K8s sandbox pod；API 负责生命周期、事件投影、取消和回收。 |
| UI/TUI 边界 | Web UI 和未来产品 TUI 只能调用产品 API，不做 provider 调用、K8s 操作、DB 写入、文件授权判断或认证业务逻辑。 |

## 2. Core 范围

| 范围 | Core 内容 |
| --- | --- |
| Substrates | 安装 k3s、PostgreSQL、S3-compatible storage、JuiceFS CSI、Keycloak；生成 `substrate.env`、`substrate.secrets.env`、`kubeconfig`。 |
| Auth | Keycloak realm/client/user bootstrap；app 消费 OIDC issuer/client/client secret；服务端建立 session 并校验 API 权限。 |
| API | session、workspace/project 最小 create/list/select、endpoint create/list/use、一次 server-side endpoint 调用、task create/cancel/status/events/artifacts、project file list/upload/download/delete。 |
| Runtime | Botified vendored/pinned；构建 runner image；sandbox pod 运行 Botified；bash 写文件并发布 artifact。 |
| Sandbox | JuiceFS PVC 挂载；最小 RBAC；无 `pods/exec`；TTL/lease/reap/status。 |
| Files | 服务端负责 path normalization、权限、上传、下载、delete、artifact 投影。UI 只通过 API 展示和触发。 |
| Packaging | App image、Botified runner image、K8s manifest render/apply/status/down、digest-pinned app offline bundle。 |
| Tests | 少量快速 unit/contract/behavior checks，只覆盖当前改动和核心闭环。 |

Core 中的“chat”不是长期对话产品。MVP 只要求服务端能通过已配置 endpoint 完成一次模型调用，用来验证 endpoint 与 server-side LLM access。

## 3. 明确删除和禁止

立即删除或持续清理：

- evidence ledger、release report、GA report、rehearsal、quality gate matrix、各种 gate 产物；
- 默认写入的 `*-report.json`、运行报告、诊断文档生成、证据归档参数；
- 笼统的 smoke 概念和 smoke report；需要检查时按业务场景命名并直接失败；
- 测试治理系统本身的测试；
- 断言计划文档措辞的测试；
- 与核心闭环无关的长矩阵、跨环境证明、外部云证明；
- JVS、WebDAV、远程/本地挂载、AFSCP/ASBCP、LLMUP、Codex runner；
- UI/TUI 直接访问 Botified、K8s、PostgreSQL、S3/JuiceFS raw credentials；
- Product terminal 或 `pods/exec`。

允许保留但必须克制：

- `doctor` 或 `status` 类命令只能作为快速 stdout/stderr 检查，失败即退出非零；不得默认生成报告文件。
- 手动 e2e/visual 只能在用户或开发者主动触发时运行，不进入默认发布前验证。
- offline cache/app bundle 只是部署输入，不是证据系统。

## 4. Repository 设计

### 4.1 `agentsmith-lite-substrates`

职责：安装本地单机 K8s 运行基座，输出 app 可消费的统一环境契约。

Owned by substrates repo:

- local single-node k3s bootstrap；
- PostgreSQL 连接和 app database/bootstrap；
- S3-compatible object storage 接入；
- JuiceFS CSI 安装/验证；
- Keycloak 安装、realm/client/user bootstrap、OIDC issuer/client 配置；
- namespace、quota、StorageClass、PVC、dev ingress 基础资源；
- optional offline cache download/import；
- `substrate.env`、`substrate.secrets.env`、`kubeconfig`。

Not owned:

- App product code；
- App DB migration bundle；
- App/Botified runner image build；
- 发布治理流程；
- 云供应商资源创建；
- AFSCP/ASBCP/LLMUP/JVS 服务安装；
- 第三个依赖准备 repo。

Required outputs:

| Output | Consumer | Notes |
| --- | --- | --- |
| `out/substrate.env` | app deploy/dev scripts | non-secret config：namespace、ingress、OIDC issuer/client id 等。 |
| `out/substrate.secrets.env` | app deploy scripts | `0600`；包含 `POSTGRES_APP_URL`、`APP_SESSION_SECRET`、`OIDC_CLIENT_SECRET` 等 app 必需 secret。 |
| `out/kubeconfig` | operator/developer scripts | 只在 self-hosted/local 模式产生。 |
| `dist/offline-cache/` | optional disconnected install | generated deploy cache，不进 git。 |

### 4.2 `agentsmith-lite`

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
- app image、app offline bundle、deploy scripts。

Not owned:

- K8s cluster bootstrap；
- Keycloak 安装和 realm bootstrap；
- raw S3/JuiceFS credential lifecycle；
- LLMUP；
- Codex runner；
- JVS/WebDAV/local mount/remote mount；
- release-kit/governance mainline。

## 5. 服务端业务边界

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

Web UI 和未来 TUI 只能消费 product API/types + thin HTTP client：

- 可以 import `packages/contracts` 或生成的 API types；
- 不得 import `application`、`ports`、`sandbox-controller`、`botified-runtime`、`openai-compatible-client`、`adapters-postgres` 或 K8s client；
- 不得调用 `/api/operator/*`；
- 不得保存 endpoint secrets、解析 substrate env/secrets、构建 cleanup plan、直连 Botified/provider/K8s。

## 6. 测试策略

测试只服务核心逻辑开发：

- 优先 unit/contract/behavior tests，覆盖当前改动和核心业务路径。
- 必要时 TDD：先写能暴露业务 bug 的小测试，再实现。
- 失败立即修，不新增治理包装。
- 不跑无关全量矩阵。
- 不测试测试工具、报告格式、文档措辞、截图流程。
- e2e/visual 只人工主动运行。

默认发布前建议最多选择：

- 类型检查；
- 与本次改动相关的 unit/contract tests；
- forbidden surface 快速检查；
- 一条本地 K8s 核心业务路径检查，且必须短小、失败清晰。

## 7. 命令语义

命令应该直接做事、直接失败：

- `install-*` 安装或导入依赖，失败时退出非零并在 stderr 说明原因。
- `validate-*` 只验证输入契约，不生成报告文件。
- `doctor` 若保留，只能作为快速环境检查命令；不默认写 `doctor-report.json`，不形成诊断文档。
- `status` 只展示当前资源状态，不做审计汇总。
- app deploy scripts 只负责 render/apply/status/down/import，不生成发布材料。
- workflow 类检查按业务命名，例如 auth、task、resource cleanup；不要再使用笼统 smoke 概念。

## 8. Phase Plan

### P0：治理 overhead 清理与边界复位

Goal：先砍掉会分散注意力的治理系统和遗留概念。

Deliverables:

- 删除或降级 evidence/report/rehearsal/gate/matrix 相关脚本、参数、文档段落、测试；
- 删除对计划文档 prose 的测试；
- 清理 LLMUP/JVS/WebDAV/Codex runner/AFSCP/ASBCP active surface；
- 保留两个 repo 和 Botified/Keycloak/JuiceFS/K8s 核心边界。

Checks:

- grep/import/package 快速检查禁用 surface；
- 相关 unit/contract tests。

### P1：Local K8s Substrate And Keycloak

Goal：本地单机 K8s 安装 k3s/PostgreSQL/S3-compatible storage/JuiceFS CSI/Keycloak，并输出 app 可消费的 env/secrets。

Deliverables:

- `install-online.sh` 和 `install-offline.sh` 支持 local-k8s profile；
- Keycloak realm/client/user bootstrap；
- OIDC issuer/client/client secret 输出；
- Postgres/S3/JuiceFS CSI/PVC 基础可用；
- `out/substrate.env`、`out/substrate.secrets.env`、`out/kubeconfig`。

Checks:

- `scripts/test.sh` 中与安装输入、env/secrets、Keycloak config、JuiceFS contract 直接相关的小测试；
- 本地单机 K8s 非 dry-run install。

### P2：Product API, OIDC Session And UI Client

Goal：完成服务端产品最小闭环，Web UI 只作为 API client。

Deliverables:

- OIDC login/callback/session/logout；
- API 权限校验和 CSRF/session boundary；
- workspace/project create/list/select；
- endpoint create/list/use；
- server-side endpoint call check；
- project file list/upload/download/delete through server-side API；
- task create/cancel/status/events/artifacts API；
- static Web UI 调用 `/api/...`。

Checks:

- typecheck；
- auth/session unit and contract tests；
- API/service tests for changed routes；
- UI boundary test 禁止 provider/K8s/DB/Botified direct access。

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

Checks:

- manifest/RBAC/resource label unit tests；
- fake Botified client tests for task lifecycle；
- local Botified process check；
- API tests for events/artifacts/cancel/reap。

### P4：K8s App Packaging And Local Deploy

Goal：App 可以打包成 K8s 容器服务，并部署到本地单机 K8s substrate。

Deliverables:

- `scripts/build-images.sh`；
- digest capture/publish runbook；
- `scripts/build-offline-bundle.sh` using digest-pinned images；
- K8s manifests for API/web/schema bootstrap/sandbox RBAC/network policy；
- deploy scripts：render/apply/status/down/import-images；
- local K8s full loop：OIDC login、endpoint、project、task、artifact list/download、cancel/TTL/reap。

Checks:

- build/render/apply dry-run 相关小测试；
- 本地单机 K8s 完整闭环人工确认；
- e2e/visual 仅在用户主动要求时运行。

### P5：Handoff

Goal：交接文档只说明如何开发、安装、运行核心闭环，不生成治理材料。

Deliverables:

- README/DEVELOPMENT/OPERATOR 与当前核心命令一致；
- `docs/architecture.md`、`docs/api-contract.md`、`docs/sandbox-controller.md`、`docs/botified-runtime.md` 只保留核心设计；
- Deferred backlog 明确，不混入 Core；
- generated artifacts/cache 不被误提交。

## 9. Immediate Next Work

1. 删除存量治理 overhead：report/evidence/rehearsal/gate/matrix/诊断文档生成/测试治理系统/文档 prose 测试。
2. 清理命令接口：去掉默认 `--report`、`*-report.json`、笼统 smoke 命名；命令改为 stdout/stderr + exit code。
3. 在 substrates 中实现 local K8s + Keycloak 核心安装输出。
4. 在 app 中实现 OIDC login/session/API 权限。
5. build/push digest-pinned app image and Botified runner image。
6. render/apply 到本地单机 K8s。
7. 通过产品 API/UI 创建 project 和 OpenAI-compatible endpoint。
8. 创建 task，让 Botified sandbox pod 挂载 JuiceFS 并写 artifact。
9. 通过 API/UI list/download task artifacts 和 project files。
10. 验证 cancel、TTL、reap 清理 app-owned resources，保留 durable project files。
11. chat persistence、audit/usage dashboard、full CRUD、endpoint edit/delete、project file delete UI/version/restore/recycle bin 继续留在 Deferred。
