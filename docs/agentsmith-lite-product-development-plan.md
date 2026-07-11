# AgentSmith Lite 产品研发计划

状态：核心业务开发版
日期：2026-07-08
适用仓库：`agentsmith-lite`，配套仓库 `agentsmith-lite-substrates`

## 当前最高原则

本计划只服务一个目标：尽快跑通本地单机 K8s 上的核心业务闭环。

当前工作重点是把精力拉回产品本体：

1. `agentsmith-lite-substrates` 安装 k3s、PostgreSQL、S3-compatible storage、JuiceFS CSI、Keycloak，并输出 app 可消费的 env/secrets。
2. `agentsmith-lite` 部署 API/Web、OIDC session、Botified runtime、sandbox controller。
3. 用户通过 Keycloak/OIDC 登录。
4. Product API/UI 创建 workspace、project、endpoint、task。
5. Botified sandbox pod 挂载 JuiceFS，运行任务并写入 artifact。
6. API/UI list/download project files 和 task artifacts。
7. cancel、TTL、reap 只清理 app-owned resources。

硬规则：

- Keycloak/OIDC 是生产身份路径；built-in admin 只作为当前本地开发和过渡检查路径。
- Web UI 和未来产品 TUI 只能作为 API client。
- Server side 拥有 auth、endpoint 调用、file path 安全、task lifecycle、artifact 投影、sandbox cleanup；TUI 不承载 agent 业务逻辑。
- 只保留服务核心业务路径的代码、文档、命令和测试；纯流程材料直接删，不换名保留。
- 检查必须具体、窄、由开发者按当前改动主动选择，stdout/stderr 输出，失败退出非零。
- 不测试计划文档措辞，不测试测试设施本身，不建设报告/证据/演练/发布流程/默认关卡。
- e2e/visual 只在用户人工主动要求时手动运行，不作为默认流程。
- 最终交付只要求本地单机 K8s 核心闭环通过，不要求真云。

## 产品边界

AgentSmith Lite 是私有化智能体平台的最小产品内核。它把 Botified agent runtime 放入可回收、可管理的 K8s sandbox task，并通过产品 API/UI 管理 endpoint、project files、task events、artifacts、cancel 和 resource reap。

| 决策 | 当前边界 |
| --- | --- |
| 活跃 repo | 只处理 `agentsmith-lite` 和 `agentsmith-lite-substrates`。 |
| 运行基座 | 当前优先 local single-node K8s。 |
| Identity | Keycloak/OIDC 是目标生产路径；app 消费 substrates 输出的 issuer/client/secret。 |
| LLM 接口 | 只支持 OpenAI-compatible endpoint。 |
| Agent runtime | 使用 Botified runner。 |
| 文件系统 | 只支持 JuiceFS CSI/PVC 挂载。 |
| Sandbox | 每个 task 一个 app-owned K8s sandbox pod。 |
| Cleanup | cancel、TTL、reap 只作用于 app-owned resources，并按 runId/labels fence。 |
| UI/TUI | 只调用 `/api/*`；不得直接访问 K8s、DB、Botified、provider 或 substrate secrets。 |

命名空间必须分离且不可相同：`KUBE_NAMESPACE` 只拥有 app/API、sandbox task、JuiceFS PVC 及其 app-owned 资源；`SUBSTRATE_NAMESPACE` 只拥有 PostgreSQL、S3-compatible storage/MinIO、Keycloak、JuiceFS CSI secret 和 format resources。app runtime 不接收 substrate namespace 或 secret internals。

Sandbox task pod 固定为两个隔离容器：`botified-server` 独占 model/service credentials 与私有 Botified state；`bash-executor` 独立运行，不挂载或接收这些 env、secret 或 state，且 `shareProcessNamespace: false`。这是凭据职责隔离，不宣称可对抗任意 hostile code。

明确不做：

- LLMUP、Codex runner core、JVS、WebDAV、local/remote file mount、AFSCP、ASBCP。
- Product terminal、`pods/exec`、UI/TUI 直连 operator internals。
- 第三个依赖准备 repo 或新的服务拆分。

## Core 范围

| 范围 | Core 内容 |
| --- | --- |
| Substrates | k3s、PostgreSQL、S3-compatible storage、JuiceFS CSI、Keycloak、两命名空间/PVC/ingress 基础资源、env/secrets 输出。 |
| Auth | OIDC login/callback/session/logout、CSRF/API 权限校验、built-in admin 过渡路径收敛。 |
| Product API | workspace/project create/list/select，endpoint create/list/use，server-side endpoint call。 |
| Files | project file validate/list/upload/download/delete；服务端 path normalization 和权限判断。 |
| Tasks | task create/status/events/artifacts/cancel；任务 endpoint 必须同时声明 `text` 与 `tool_calls`，否则在 task/pod/model 副作用前拒绝；Botified event projection；artifact download。 |
| Runtime | Botified vendored source pin、runtime image、runtime config、HTTP client。 |
| Sandbox | K8s manifest render/apply/status/reap；JuiceFS PVC mount；最小 RBAC；TTL cleanup。 |
| Packaging | app image、runner image、manifest render/apply/status/down、digest-pinned app offline bundle。 |
| Tests | 与当前改动相关的 unit/contract/behavior tests；需要命令检查时，按具体业务路径命名并由开发者主动选择。 |

Core 中的 chat 只是 endpoint/server-side model access 验证路径，不是长期对话产品。

## App Repo 现状

当前 app repo 的本地单机 K8s 产品闭环已通过手动验证：

- 使用 substrates 输出的 env/secrets 渲染和部署 app 已跑通；API/Web、schema bootstrap、JuiceFS PVC、sandbox RBAC 在本地单机 K8s 环境可用。
- Keycloak/OIDC login/callback/session/logout、`OIDC_BACKCHANNEL_BASE_URL`、OIDC env contract 已通过手动验证；app 消费 substrates 输出的 issuer/client/secret/backchannel。
- Web UI logout、服务端 session revoke、`e2e:web-product-oidc` 手动浏览器路径已覆盖 OIDC login/callback -> workspace/project -> endpoint -> task -> artifact download -> project file upload/download/delete -> logout。
- Web UI active task 自动刷新已覆盖晚到 events/artifacts 自动出现，仍只通过产品 API 读取 task events/artifacts。
- 旧 runner 路径已验证 Botified bash 可在 JuiceFS 挂载中写文件并发布 artifact，API 能读取 events、列出 artifacts、下载 artifact 内容；当前双容器 sidecar 路径仍需开发者手动在本地单机 K8s 跑一次真实任务验证，不是默认 gate。
- cancel、TTL、reap 已通过本地 artifact/reclaim 手动验证，并继续使用 runId/label/UID fencing 只清理 app-owned resources。
- `scripts/deploy/check-product-workflow.sh` / `.mjs` 只是开发者主动选择的具体产品路径检查，stdout 输出，失败非零；不要包装成默认入口。
- Boundary checks 保留 repo scope、UI client boundary、forbidden surfaces。

仍需注意的现实：

- Keycloak bootstrap 创建的本地登录用户只用于本地/operator 登录；真实产品路径应走 Web UI + OIDC session。
- README/OPERATOR 中剩余 built-in admin 或 operator 语言需要继续收敛到 OIDC 产品路径。
- 手动验证只说明 local single-node K8s 产品闭环当前可跑，不扩展成多环境流程。
- Cleanup 必须继续保持 runId/label fencing，不能扩大到非 app-owned resources。

## Immediate Next Work

1. **Product API/UI polish from the verified loop**
   - 从已验证的 OIDC 浏览器产品路径收敛小问题，不再把 login/callback -> product actions -> logout 当作整体未完成项。
   - 下一步聚焦 project file list/download/delete 的路径、文件名和错误文案语义。
   - session、cookie、path-prefix follow-up 只围绕 OIDC browser path 保持短小修正。

2. **Cleanup and sandbox fence**
   - cleanup 继续保持 runId/label/UID fence，cancel/TTL/reap 只作用于 app-owned resources。
   - UI/API polish 不引入 `/api/operator/*` 浏览器路径，也不直连 K8s、Botified、DB 或 provider。
   - 相关逻辑变化时只补当前业务路径的小测试。

3. **Docs and commands stay small**
   - README/OPERATOR 只保留可执行命令、OIDC 产品路径和核心边界。
   - 新命令必须直接服务产品闭环，stdout/stderr 清晰，失败非零，且不能包装成默认入口。
   - 删除与核心闭环无关的 prose tests、长矩阵、默认产物生成和流程包装。
   - 开发中发现过时的治理产物或流程，应随当前业务路径改动就地删除；不得另建替代报告、证据记录、清理日志或后续流程官僚。
   - e2e/visual 如需使用，只能作为手动、独立、具体产品路径检查，不进入默认测试或发布流程。

## 禁止和清理

- 删除只服务流程包装的文档、命令、参数、产物和测试。
- 删除脱离业务路径的笼统检查名称；需要检查时，只保留按具体业务路径命名、由开发者按当前改动主动选择的精确窄检查。
- 运行时必要诊断、错误信息、产品 API 语义和 Botified/沙箱日志可以保留，因为它们帮助操作和调试核心闭环。
- offline cache/app bundle 只是部署输入。

## 工作方式

- 小步实现，每一步对应一个核心业务结果。
- 优先修产品代码，不用流程包装失败。
- 测试覆盖随风险增长：窄改动用窄测试，跨模块行为用 API/service tests。
- 不运行无关 e2e/visual；只有用户人工主动要求时才作为手动诊断触发。
- 当前改动相关检查只覆盖本地单机 K8s 核心闭环和当前改动风险，由开发者主动选择。
- 保持 app repo 与 substrates repo 边界清晰：substrates 提供运行基座，app 提供产品服务和 sandbox 业务逻辑。
