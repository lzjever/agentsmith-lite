# AgentSmith Lite 产品研发计划

状态：核心业务开发版
日期：2026-07-08
适用仓库：`agentsmith-lite`，配套仓库 `agentsmith-lite-substrates`

## 当前最高原则

本计划只服务一个目标：尽快跑通本地单机 K8s 上的核心业务闭环，并用少量、直接、和改动相关的检查确认它能跑。

当前工作重点是删除治理 overhead，把精力拉回产品本体：

1. `agentsmith-lite-substrates` 安装 k3s、PostgreSQL、S3-compatible storage、JuiceFS CSI、Keycloak，并输出 app 可消费的 env/secrets。
2. `agentsmith-lite` 部署 API/Web、OIDC session、Botified runner、sandbox controller。
3. 用户通过 Keycloak/OIDC 登录。
4. Product API/UI 创建 workspace、project、endpoint、task。
5. Botified sandbox pod 挂载 JuiceFS，运行任务并写入 artifact。
6. API/UI list/download project files 和 task artifacts。
7. cancel、TTL、reap 只清理 app-owned resources。

硬规则：

- Keycloak/OIDC 是生产身份路径；built-in admin 只作为当前本地开发和过渡检查路径。
- Web UI 和未来产品 TUI 只能作为 API client。
- Server side 拥有 auth、endpoint 调用、file path 安全、task lifecycle、artifact 投影、sandbox cleanup。
- 只保留短小、直接、服务核心业务或边界安全的检查。
- 不测试计划文档措辞，不测试测试设施本身。
- e2e/visual 只在用户明确要求或 UI/cross-component 改动确实需要时手动运行。

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

明确不做：

- LLMUP、Codex runner core、JVS、WebDAV、local/remote file mount、AFSCP、ASBCP。
- Product terminal、`pods/exec`、UI/TUI 直连 operator internals。
- 第三个依赖准备 repo 或新的服务拆分。

## Core 范围

| 范围 | Core 内容 |
| --- | --- |
| Substrates | k3s、PostgreSQL、S3-compatible storage、JuiceFS CSI、Keycloak、namespace/PVC/ingress 基础资源、env/secrets 输出。 |
| Auth | OIDC login/callback/session/logout、CSRF/API 权限校验、built-in admin 过渡路径收敛。 |
| Product API | workspace/project create/list/select，endpoint create/list/use，server-side endpoint call。 |
| Files | project file validate/list/upload/download/delete；服务端 path normalization 和权限判断。 |
| Tasks | task create/status/events/artifacts/cancel；Botified event projection；artifact download。 |
| Runtime | Botified vendored source pin、runner image、runtime config、HTTP client。 |
| Sandbox | K8s manifest render/apply/status/reap；JuiceFS PVC mount；最小 RBAC；TTL cleanup。 |
| Packaging | app image、runner image、manifest render/apply/status/down、digest-pinned app offline bundle。 |
| Tests | 与当前改动相关的 unit/contract/behavior tests；forbidden surface 快速检查。 |

Core 中的 chat 只是 endpoint/server-side model access 验证路径，不是长期对话产品。

## App Repo 现状

当前 app repo 已经收敛到更直接的产品检查：

- Deploy workflow check 为 `scripts/deploy/check-product-workflow.sh` / `.mjs`，覆盖 health/auth/project/endpoint/chat/file/task/cancel/reap，stdout 输出，失败非零。
- App doctor 只做静态 manifest/env 和可选 K8s read-only facts 检查，stdout/stderr 输出，失败非零。
- OIDC login/callback/session/logout、`OIDC_BACKCHANNEL_BASE_URL`、OIDC env contract 已完成；app 消费 substrates 输出的 issuer/client/secret/backchannel。
- Botified runner acceptance 保留本地进程和 runner image 两层，覆盖 health/messages/timeline/file/state/abort。
- API product workflow test 覆盖 login、workspace、project、endpoint、chat、file CRUD、task resources。
- Boundary checks 保留 repo scope、UI client boundary、forbidden surfaces。

仍需注意的现实：

- Keycloak bootstrap 创建的本地登录用户只用于本地/operator 登录，不进入 app runtime。
- README/OPERATOR 仍描述 built-in admin 本地路径；OIDC/Keycloak app integration 已完成，后续只做文档收敛和真实部署验证。
- K8s/Botified/JuiceFS 的完整 artifact 流需要 local substrate 环境实际跑通。
- Cleanup 必须继续保持 runId/label fencing，不能扩大到非 app-owned resources。

## Immediate Next Work

1. **Local K8s deploy loop**
   - 使用 substrates 输出 env/secrets 渲染并部署 app。
   - 确认 API/Web readiness、schema bootstrap、JuiceFS PVC、sandbox RBAC。
   - 让 product workflow check 能对 live app 完成 health/auth/project/endpoint/file 基础路径。
   - 验证 OIDC session 使用 public issuer，server-side backchannel 使用 in-cluster URL。

2. **Botified task artifact loop**
   - 确认 runner image 可在 sandbox pod 中启动。
   - 通过 Botified bash 写入文件并 publish artifact。
   - API 能读取 events、列出 artifacts、下载 artifact 内容。
   - 增加只覆盖 task artifact 投影和下载路径的行为测试。

3. **Cancel / TTL / Reap**
   - cancel 调用 Botified abort，并标记 task/run state。
   - TTL tick 只选中 app-owned expired resources。
   - reap 支持 runId scoped dry-run/apply，并使用 label/UID fence。
   - 补齐 cleanup 不越界的 targeted tests。

4. **Web UI API client**
   - UI 完成 workspace/project/endpoint/task/files/artifacts 最小操作面。
   - UI 不导入 app internals，不调用 `/api/operator/*`。
   - 继续用 boundary test 固定 API-client-only 约束。

5. **Docs and commands stay small**
   - README/OPERATOR 只保留可执行命令和核心边界。
   - 新命令必须直接服务产品闭环，stdout/stderr 清晰，失败非零。
   - 删除与核心闭环无关的 prose tests、长矩阵、默认产物生成。

## 工作方式

- 小步实现，每一步对应一个核心业务结果。
- 优先修产品代码，不用流程包装失败。
- 测试覆盖随风险增长：窄改动用窄测试，跨模块行为用 API/service tests。
- 不运行无关 e2e/visual；需要时明确手动触发。
- 保持 app repo 与 substrates repo 边界清晰：substrates 提供运行基座，app 提供产品服务和 sandbox 业务逻辑。
