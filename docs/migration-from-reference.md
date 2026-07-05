# 从参考项目迁移 Ledger

状态：开发交接用 ledger

本文记录 AgentSmith Lite 从参考项目中保留、改写、删除、暂缓、vendored 或只借鉴思路的路径级决策。它是 `docs/agentsmith-lite-product-development-plan.md` 中 Immediate Next Work #1 的落地文件，也是 forbidden/scope check 的人工审计依据。

## 0. 根因分析

此前的 `docs/migration-from-reference.md` 过薄，只有“vendored / rebuilt / deleted”三段摘要，不能证明开发团队已经做过路径级迁移判断，问题主要有四类：

1. **没有路径到目标的映射**：文档没有列出主要 reference repo/path、Lite target 与 active workspace package 的对应关系。读者无法判断 `packages/application`、`src/web`、`infra/docker`、`scripts/deploy`、`e2e/smoke` 等目录是复制、改写、重建还是只借鉴。
2. **没有 decision taxonomy**：旧文档把 copied、rebuilt、deleted 混在一起，没有稳定使用 `keep / modify / delete / deferred / vendor / mine` 这样的决策词。后续审计无法区分“现在必须存在”“以后再做”“永不进入 active graph”。
3. **没有 Core/Deferred/External Evidence 关系**：旧文档没有说明哪些迁移支撑 MVP/Core，哪些只进入 Deferred，哪些必须靠真实环境 evidence 证明。结果容易把 release governance、runner、JVS、WebDAV、LLMUP 等参考系统能力误认为 Core 尾巴。
4. **没有和边界检查闭环**：forbidden/scope check 只能 grep 关键词或检查 workspace 列表，失败时没有指向 ledger；ledger 也没有覆盖所有 active workspace package，无法证明检查背后的迁移策略。

结构性修正是：把迁移决策写成可交付给开发团队的 ledger，让每个主要 active surface 都有 reference 来源、Lite 目标、decision、原因和证据层级；同时明确被删除的参考系统不得进入 active package graph、manifest、route、UI entrypoint 或 deploy command。

## 1. 决策词

| Decision | 含义 |
| --- | --- |
| `keep` | 语义和边界基本保留，可做小幅命名或构建适配。 |
| `modify` | 从参考项目保留有用结构，但删除非 Lite 能力并改成 Core 所需形状。 |
| `delete` | 不进入 Lite active repo。不得有 workspace package、runtime route、UI entrypoint、manifest 或 deploy command。 |
| `deferred` | 不进 MVP/Core，可作为未来 backlog；当前 active surface 不应假装已支持。 |
| `vendor` | 第三方源码以 pinned source 形式进入 `third_party/`，只暴露批准的运行时用途。 |
| `mine` | 不复制系统本身，只借鉴小型实现思路、命令边界或 manifest/RBAC 形状，最终代码由 Lite 自己拥有。 |

证据层级：

- **Core**：本仓库必须交付并由本地 build/test/static check 证明的产品面。
- **Deferred**：明确不属于 MVP/Core，不能作为当前产品能力宣传。
- **External Evidence**：本地测试只能证明接口或脚本形状，真实可用性必须通过 redacted clean VM、offline VM、existing-cloud、runner acceptance 或 live sandbox 报告证明。

## 2. App Repo Active Surface Ledger

| Reference repo/path | Lite target | Decision | 原因 | Core/Deferred/External Evidence 关系 |
| --- | --- | --- | --- | --- |
| `.reference/agentsmith/packages/contracts` 或参考 API schema/test 片段 | `packages/contracts` | `modify` | 保留产品 API contract 的思想，但只描述 Lite API；不得暴露 K8s、Botified raw surface、JVS、WebDAV、LLMUP 或 release governance。 | **Core**。由 contract/build tests 证明；真实部署行为另由 smoke 证明。 |
| `.reference/agentsmith/packages/domain` | `packages/domain` | `modify` | 只保留 workspace、project、endpoint、file、task、sandbox 的基础实体和状态；删除旧权限产品化、文件版本图、release/gate 概念。 | **Core**。领域类型必须保持 Lite 最小模型。 |
| `.reference/agentsmith/packages/ports` | `packages/ports` | `modify` | 保留端口分层，但端口只面向 app-owned Postgres、OpenAI-compatible endpoint、Botified HTTP、K8s sandbox 和 project files。不得重新引入 provider registry、raw substrate secret、JVS/WebDAV/mount 端口。 | **Core**。端口边界由 unit/static tests 证明；外部依赖可用性属于 **External Evidence**。 |
| `.reference/agentsmith/packages/application` | `packages/application` | `modify` | 保留服务端业务编排位置；删除 governance、JVS、runner-release、Keycloak 强依赖和控制平面客户端。UI/TUI 只能调用这里暴露的产品 API。 | **Core**。服务端完成 auth/session、workspace/project、endpoint、chat smoke、task、artifact/file 业务。 |
| `.reference/agentsmith/packages/adapters-postgres` 或旧 persistence 片段 | `packages/adapters-postgres` | `modify` | 只保留 app-owned Postgres 适配；schema 由 `infra/db/migrations` 拥有。不得读取 substrate-only metadata，例如 JuiceFS、Redis、Mongo、MinIO 内部状态。 | **Core**。本地 migration/store tests 证明 SQL 和端口；真实 Postgres 属于 **External Evidence**。 |
| `.reference/agentsmith-sandbox-control-plane` | `packages/sandbox-controller` | `mine` | 借鉴 sandbox 状态机、labels、RBAC 和 cleanup 思路，但不保留第三控制平面服务。Lite API 自己渲染和回收 namespace-scoped Pod/Service/ConfigMap/Secret。 | **Core**。本地 manifest/reconciler tests 证明边界；真实 K8s lifecycle 属于 **External Evidence**。 |
| `.reference/botified` runtime-relevant source | `packages/botified-runtime` | `modify` | 保留 Botified HTTP/config/event projection 的集成点；产品行为通过 Lite 服务端封装。不得把 Botified TUI、playground 或 optional provider UI 变成 Lite 产品面。 | **Core** + **External Evidence**。本地 tests 证明 config/projection；真实 runner acceptance 另存证据。 |
| `.reference/agentsmith` OpenAI/provider 调用片段 | `packages/openai-compatible-client` | `modify` | 只支持 OpenAI-compatible endpoint 的直接 server-side 调用。删除 LLMUP、provider registry、translation runtime、SDK wrapper 扩展框架和多 provider 路由 UI。 | **Core**。chat smoke 是 endpoint 可用性探针，不是长期 chat 产品。 |
| `.reference/agentsmith/packages/api-entry-node` | `packages/api-entry-node` | `modify` | 保留 Node API entrypoint；删除 Keycloak hard dependency、AFSCP/ASBCP/LLMUP/JVS/WebDAV/mount/terminal route。所有业务能力在服务端完成。 | **Core**。route/API tests 证明 active surface；真实 ingress/session 由 deploy smoke 证明。 |
| `.reference/agentsmith/src` | `src/web` | `modify` | Web 是静态 API client，只做 session、表单、列表、timeline、artifact/file 展示。删除 file versioning、save/restore、mount、WebDAV、terminal、K8s/Botified/Postgres/S3 直接访问。 | **Core** UI shell。视觉和真实浏览器体验可作为手工/visual evidence；业务不能落在 UI。 |
| `.reference/agentsmith/infra/docker` 或旧 image build 片段 | `infra/docker` | `modify` | 保留 app image 与 Botified runner image 的构建边界；runner image 来自 pinned Botified source。不得构建 Codex runner、AFSCP、ASBCP、LLMUP、JVS 或 release-kit images。 | **Core**。Dockerfile 形状可本地检查；digest-pinned image acceptance 属于 **External Evidence**。 |
| `.reference/agentsmith/infra/deploy` | `packages/sandbox-controller/src/appManifestRenderer.ts`、`scripts/deploy`、generated `out/manifests` | `mine` | 只借鉴 namespace-scoped manifest/apply/status/doctor/down/smoke 形状。当前没有 tracked `infra/k8s` 静态目录；manifest 由 renderer 生成到 `out/manifests`。active deploy scripts 只能管理 app-owned resources，不做 cluster bootstrap、substrate install 或 forbidden RBAC。 | **Core** + **External Evidence**。本地 deploy tests 证明 plan/RBAC；真实 cluster apply/smoke 另存证据。 |
| `.reference/agentsmith/infra/db` 或旧 app schema 片段 | `infra/db/migrations` | `modify` | 只保留 Lite product schema：workspace/project/endpoint/task/event/artifact/file 等。不得导入 substrate schema、JVS schema、governance ledger 或 release evidence tables。 | **Core**。migration tests 证明 app DB bundle。 |
| `.reference/botified` pinned source | `third_party/botified` | `vendor` | 以 pinned source 进入第三方目录，只作为 runner runtime 输入。`PINNED_SOURCE.json` 是来源锚点；optional Botified TUI/playground/provider extras 不进入产品面。 | **Core** runtime input；真实 Botified binary/service 行为属于 **External Evidence**。 |
| `.reference/agentsmith/e2e` | `e2e/smoke` | `modify` | 保留少量产品行为 smoke：API、task、artifact、deploy smoke。删除 story/gate/release matrix 和治理系统测试。 | **Core** local/fake smoke；live smoke 报告属于 **External Evidence**。 |
| `.reference/agentsmith/e2e` operator/reclaim 片段 | `e2e/operator-lifecycle` | `modify` | 只保留 operator lifecycle 的事实型验证：task cancel、TTL、reap、resource cleanup。不得恢复 release rehearsal 或 quality gate matrix。 | **External Evidence** 优先；本地脚本可作为命令形状 smoke。 |

## 2.1 Active Script Root Coverage

`git ls-files scripts` 下的 active script roots 也必须有迁移决策。脚本是产品边界的一部分：它们可以是 build/dev/deploy/diagnostic helper，但不能成为旧系统回流的命令入口。

| Active script root | Reference repo/path | Decision | 原因 | Core/Deferred/External Evidence 关系 |
| --- | --- | --- | --- | --- |
| `scripts/dev` | `.reference/agentsmith` local dev/env helper ideas | `mine` | 只保留本地 API/dev 启动和 env/secrets allowlist 契约。不得启动 substrate install、旧控制平面、provider proxy、mount daemon 或 release workflow。 | **Core** local dev contract；不替代真实 substrate readiness。 |
| `scripts/db` | `.reference/agentsmith/infra/db` migration runner ideas | `modify` | 只执行 app-owned `infra/db/migrations`。不得安装 substrate schema、JVS schema、governance ledger 或外部控制平面 schema。 | **Core** app DB bootstrap；真实 Postgres 可用性属于 **External Evidence**。 |
| `scripts/deploy` | `.reference/agentsmith/infra/deploy` namespace deploy helper ideas | `mine` | 只包含 app render/apply/status/doctor/smoke/down/import/cleanup helpers。manifest 来自 app renderer 并写入 `out/manifests`；脚本不得管理 cluster bootstrap、substrate credentials、cluster-wide RBAC 或 old release gates。 | **Core** command shape and static checks；真实 apply/smoke 属于 **External Evidence**。 |
| `scripts/acceptance` | `.reference/botified` runner acceptance ideas | `modify` | 只验证 pinned Botified runner 的 local process/container acceptance。不得把 Botified optional TUI/playground/provider extras 或 Codex runner contract 变成产品命令。 | **Core** local runner-process evidence；container/K8s/JuiceFS 仍按 **External Evidence** 分层。 |
| `scripts/visual` | `.reference/agentsmith` UI smoke/screenshot ideas | `mine` | 只做静态 Web UI 视觉诊断，使用 fake product services。不得直连 Botified/K8s/Postgres/S3/JuiceFS 或成为 release gate。 | Diagnostic only；不替代 API/deploy evidence。 |
| `scripts/build-images.sh` | `.reference/agentsmith/infra/docker` image build helper ideas | `modify` | 只构建 app image 和 Botified runner image，并可写 digest-pinned lock。不得构建 Codex runner、AFSCP、ASBCP、LLMUP、JVS 或 release-kit images。 | **Core** packaging helper；push digest evidence 属于 **External Evidence**。 |
| `scripts/build-offline-bundle.sh` | `.reference/agentsmith-release-kit` offline bundle helper ideas | `mine` | 只打包 app/runner digest-pinned images 和 app bundle manifest/checksums。不得复制 release campaign、substrate offline cache、evidence bureaucracy 或 governance command tree。 | **Core** app offline bundle shape；真实 disconnected app deploy 属于 **External Evidence**。 |
| `scripts/check-forbidden-surfaces.sh` | boundary audit helper ideas | `mine` | 只做 lightweight active-surface grep，把失败指向本 ledger。它不是 release gate，也不替代人工路径级审计。 | **Core** boundary sanity check。 |
| `scripts/copy-web-assets.mjs` | static web build helper ideas | `mine` | 只把 app-owned static Web assets 复制到 build output。不得引入 reference UI build pipeline、asset CDN、TUI bundle 或 product terminal entrypoint。 | **Core** build helper。 |

## 3. Substrates Repo Boundary Ledger

| Reference repo/path | Lite target | Decision | 原因 | Core/Deferred/External Evidence 关系 |
| --- | --- | --- | --- | --- |
| `.reference/agentsmith-release-kit` redaction/offline helper ideas | `agentsmith-lite-substrates/scripts/*` 或 app deploy helper 中的小型脱敏逻辑 | `mine` | 只可借鉴 redaction、offline cache manifest、doctor report 的小型实现思路。不复制 release campaign、evidence bureaucracy、quality gate matrix 或 governance command tree。 | Substrates **Core** 是事实型 install/doctor/cache；真实 clean/offline VM 报告是 **External Evidence**。 |
| `.reference/agentsmith-sandbox-control-plane` cluster/RBAC ideas | `agentsmith-lite-substrates` namespace/quota/PVC/CSI validation | `mine` | Substrates repo 只负责基座：k3s、Postgres、S3-compatible storage、JuiceFS CSI、namespace、quota、PVC、env/secrets 输出。它不拥有 app task lifecycle。 | Substrates **Core**。app repo 不复制 substrate install 逻辑。 |
| `.reference/agentsmith/infra/deploy` cluster bootstrap 片段 | `agentsmith-lite-substrates/scripts/install-online.sh`、`install-offline.sh`、`doctor.sh` | `mine` | cluster bootstrap 与 substrate credential lifecycle 属于 substrates repo。app repo 只消费 `substrate.env`、`substrate.secrets.env` 和 kubeconfig。 | Substrates **Core** + clean VM/offline VM **External Evidence**。 |
| `.reference/agentsmith-fs-control-plane` JuiceFS/WebDAV/mount 相关实现 | none in app repo; only JuiceFS CSI validation in substrates | `delete` for app, `mine` for substrate validation ideas | Lite 文件系统只通过 JuiceFS CSI PVC 暴露给 sandbox；不保留 AFSCP、WebDAV、本地/远程 mount 或 file sync daemon。 | App **Core** 只看 project file API 和 PVC mount；CSI 真实可用性是 **External Evidence**。 |

边界结论：

- `agentsmith-lite` 不安装或管理 k3s、Postgres、S3-compatible object storage、JuiceFS CSI。
- `agentsmith-lite-substrates` 不包含 app product code、app DB migrations、Botified runner image build、API routes 或 UI。
- raw S3 credentials、`JUICEFS_META_URL`、CSI secret lifecycle 属于 substrates/CSI，不得注入 Web/API/Botified/sandbox containers，除非未来有明确的新安全设计。

## 4. Removed Systems Ledger

| Reference repo/path or surface | Lite target | Decision | 原因 | Core/Deferred/External Evidence 关系 |
| --- | --- | --- | --- | --- |
| `.reference/llm-universal-proxy`、`LLMUP`、provider translation runtime | none | `delete` | Lite 只做 OpenAI-compatible direct server-side call。多 provider 路由、翻译层、统一代理会扩大依赖和故障面。 | 不属于 **Core**；未来多 provider 产品化若需要，必须另开设计，当前不是 `deferred` 承诺。 |
| `.reference/jvs`、file version graph、save point、restore | none | `delete` | Lite MVP 文件能力是 project files 与 task artifacts。版本化文件系统会改变数据模型和 UX 责任。 | file versioning 属于 **Deferred** 产品想法，但 JVS 实现本身 `delete`。 |
| `.reference/agentsmith-fs-control-plane`、AFSCP、WebDAV、本地 mount、远程 mount、file sync daemon | none | `delete` | Lite 使用 JuiceFS CSI PVC，不建设文件控制平面或挂载产品。WebDAV/mount 不得进入 route、UI、manifest 或 script。 | 不属于 **Core**。真实文件能力由 JuiceFS CSI + API file/artifact smoke 证明。 |
| `.reference/agentsmith-sandbox-control-plane` 作为独立服务、ASBCP | none | `delete` | Sandbox lifecycle 由 Lite API 内部端口和 controller package 处理，不拆第三控制平面。 | 控制平面服务本身不属于 **Core**；状态机/RBAC 思路已在 `packages/sandbox-controller` 中 `mine`。 |
| `.reference/agentsmith-runner`、Codex runner、`agent-task-runner`、`agent-runner-contract` | none | `delete` | Agent runtime 改为 Botified。Codex runner 不能作为 Lite agent core 或 workspace package 回流。 | 不属于 **Core**。只可从 packaging 边界中 `mine` 极小思路，不能复制 runtime。 |
| `.reference/agentsmith-release-kit` release campaign、release governance、quality gate matrix、GA report、rehearsal system | none in app mainline | `delete` | Lite 保留事实型 doctor/status/smoke/report，不建设发布治理系统。 | 不属于 **Core**；阶段验收只要求相关 build/test/forbidden checks 和外部 redacted evidence。 |
| Keycloak/OIDC hard dependency、organization RBAC、membership/group/template UI | none for MVP | `deferred` | Core 使用内建 admin/session 和最小 owner/admin 模型。提前产品化组织权限会拖慢 sandbox runtime 闭环。 | **Deferred**。不得以 hard dependency 进入 active API/deploy。 |
| chat persistence、conversation attachments、长期对话 UI | none for MVP | `deferred` | Core chat 只是 endpoint smoke；产品主线是 sandbox task 和 artifacts。 | **Deferred**。当前 evidence 只能证明一次性 server-side model call。 |
| product terminal、xterm、K8s `pods/exec` | none | `delete` | Shell 只能由 Botified bash tool 在 sandbox 内执行；API/deploy RBAC 不允许 `pods/exec`。 | 不属于 **Core**。forbidden/deploy checks 必须阻止回流。 |
| Redis、MongoDB 作为必选产品依赖 | none | `delete` | Core product store 是 app-owned Postgres；local/test 可用 memory。Redis/Mongo 不能成为 app dependency。 | 不属于 **Core**；自建 object storage 等 substrate 实现细节由 substrates repo 处理。 |

## 5. Active Workspace Package Coverage

`package.json` 中的 active workspace package 必须全部在本 ledger 中有条目：

- `packages/contracts`
- `packages/domain`
- `packages/ports`
- `packages/application`
- `packages/adapters-postgres`
- `packages/sandbox-controller`
- `packages/botified-runtime`
- `packages/openai-compatible-client`
- `packages/api-entry-node`

如果新增 workspace package，开发者必须先判断它来自哪个 reference path、属于 `keep / modify / delete / deferred / vendor / mine` 的哪一种、是否属于 Core，以及需要什么本地或外部证据。新增 package 不能只是为了容纳旧系统回流。

同理，如果 `git ls-files scripts` 出现新的 top-level script root 或 root-level helper，必须先在 **Active Script Root Coverage** 中补迁移决策，再把它作为 active command surface 使用。

## 6. Check Contract

`npm run check:forbidden-surfaces` 和 `tests/boundary/repo-scope.test.ts` 只做轻量边界确认：

- active source 中不得出现被删除系统的 package、command、route、manifest 或 UI entrypoint；
- `third_party/botified` 不得把 optional Botified TUI/playground/provider extras 当成 runner 输入；
- `package.json` 的 workspace 列表必须保持 Lite 范围；
- active workspace package 和 active script roots 必须能在本 ledger 中找到路径锚点。

这些检查不是文档格式治理层，也不替代人工审计。它们的作用是把失败指向本 ledger，让开发团队回到路径级迁移决策，而不是只修一个 grep 词。
