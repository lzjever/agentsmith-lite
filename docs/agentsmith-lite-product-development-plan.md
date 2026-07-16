# AgentSmith Lite 产品研发计划

适用仓库：`agentsmith-lite`；配套基础设施仓库：`agentsmith-lite-substrates`。只服务本地单节点 Kubernetes 上的产品闭环。

## 产品边界

AgentSmith Lite 保留原 AgentSmith Web App 的工作台体验，并通过同源 `/api/v1` 产品 API 提供 workspace、project、endpoint、固定文件库、task、artifact 和 chat。substrates 安装 k3s、PostgreSQL、S3-compatible storage、JuiceFS CSI 和 Keycloak，并输出应用消费的 env/secrets；它不承载产品业务逻辑。

- Keycloak/OIDC 是唯一生产身份路径。服务端建立 session，并持久化本地 OIDC identity、English-only local profile、workspace/project 归属和 membership；不发放或接受 personal API key。
- Web 保留原项目的 Next App Router、页面组织、样式体系和可复用 UI 组件；Next 不是 Lite 要删除的依赖。最终 Web 运行时只替换被明确排除的旧后端、BFF、mock 和业务实现，不重做用户可见的产品结构。
- Lite 当前只提供英文产品界面。迁移原 Web 时彻底排除 `next-intl`、翻译 catalog、locale layout、URL locale 前缀和语言切换；页面只有一份英文实现，不为假设中的未来多语言预留抽象。
- Web UI 仅是产品 API 客户端。授权、endpoint 调用、文件路径安全、task 生命周期、artifact 投影和 sandbox 清理均由服务端拥有。页面不得承载 agent、Kubernetes、数据库、Botified 或 provider 业务逻辑。AgentSmith 服务端只通过 Botified 服务接口与其交互。
- 每个 project 使用 substrate 提供的 JuiceFS PVC，文件库固定为 project 根目录的 `files/` 子树。只提供 list、二进制 upload、download、delete。
- 每个活动 task 使用受限 Botified sandbox Pod 和不可变输入 snapshot/manifest；artifact 与可清理运行目录隔离。Botified 与 bash 执行器保持进程和凭据隔离，只共享项目 PVC 中受控的 task 路径。cancel、TTL、reap 以 task/run、app-owned labels 和资源 UID 幂等围栏，只清理应用资源。
- 资源 policy 限制活动任务、请求、token、cost 和文件字节数；usage、alerts、light audit 是按项目授权读取的最小产品能力。audit 只记录必要操作和生命周期元数据，不保存 prompt、文件内容、密钥或 session token。
- provider credential 只有一条实现路径：服务端保存的 project-scoped、typed、endpoint-bound credential。它只返回名称、类型、fingerprint、状态和轮换元数据；明文只在 create/rotate 请求中接收，绝不返回、渲染、审计或交给 Botified。
- 明确不迁移 user-scoped Third-party Accounts 或 generic external secret bundles；不提供任意 external domain、任意 secret field 或未绑定 endpoint 的用户凭据入口。

坚持 KISS、DRY、YAGNI 和一项功能一条实现路径；不新建抽象层、第三个仓库或独立的产品/业务领域服务。为同源交付 Next 页面允许一个薄 Web workload；它只服务 Web，不拥有业务逻辑、产品数据或 API 兼容层。

## Web 体验恢复原则

Lite 简化的是产品能力、外部依赖和治理负担，不是原 AgentSmith 的工作台体验。原 Web App 是用户可见体验的基线：workspace/project 信息架构、导航、页面层级、详情页、表格/列表密度、空态/错误态和关键交互应尽量保持一致。

- 页面和组件优先从 `.reference/agentsmith` 的 Next 源码复制后直接适配最终 API；不得以“参考视觉”名义重新设计一套 Lite 控制台。
- 先从原页面删除明确排除的入口、数据和交互，再将剩余页面直接接到 Lite 的最终 `/api/v1` 合约。不得保留兼容 adapter、双数据层、mock、BFF 过渡层或第二套页面路径。
- 保留 Next App Router、布局、路由和组件组织。运行时迁移只能在保持同等用户可见结构的前提下进行；当前任何 Vite/独立 SPA 实现均是过渡实现，不是最终架构基线。
- 每个功能阶段同时交付服务端 API 和对应原页面的恢复范围。只有 API 而没有可到达的原工作台页面，不算该功能完成。
- 删除的体验必须有明确的 Lite 产品理由：LLMUP、Codex runner、独立 Agent Runners 管理 UI、JVS/WebDAV/挂载、文件 savepoint/template/version/restore、全局 operator 控制面、治理 explainability、治理历史、report/gate 页面与流程。其余核心工作台体验默认保留。
- 由于 Keycloak/OIDC-only identity 和唯一 OpenAI Chat Completions broker，明确不迁移 personal API keys，也不迁移旧 `use-guide` 的 personal-key、Anthropic、universal proxy 或 protocol-conversion 路径。
- 视觉恢复先完成共同基础，再迁业务页面：直接复用原字体资产、light/dark 主题令牌、全局排版、图标、按钮/输入/对话框/表格等基础组件，以及 topbar、workspace/project switcher、分组 sidebar、折叠和响应式行为。不得用一份 Lite 专用 CSS 对原设计做近似仿制。
- `AgentSmith` 是 Lite 的产品名称；可保留原工作台的结构和视觉语言，但不继承原仓库内部的 MBOS 名称、已删除产品入口或与 Lite 无关的品牌文案。

### 最终 Web 架构

- Next App Router 是 Web 的最终运行时和路由边界。原 layout、page、loading/error 状态、样式和可复用 UI 组件应按原有目录关系迁回；不以 Vite SPA 或平行页面树替代它。
- Web 页面直接调用最终同源 `/api/v1` 产品合约。Next 不能成为另一个业务 BFF、兼容 adapter 或数据复制层；鉴权和业务判断始终在产品服务端完成。
- Ingress 仅将公开的 `/api/v1` 路由转给 API workload；`/api/internal` 只经 API ClusterIP Service 供 sandbox 调用，绝不经公开 Ingress 暴露。
- `APP_PUBLIC_BASE_URL` 是 Next image build 与 deploy 的共同不变量：构建时以其规范化 path 生成 Next `basePath` 和公开 API path，部署时必须使用同一 URL；变更 host 或 mount path（例如 `/app`）必须重建 image 后再部署。
- 页面可以持有局部展示状态、表单状态和请求状态，但不得复制 endpoint、task、policy、usage、alert、audit、sandbox 或 agent 的业务规则。
- 每个迁移页面必须保留原页面的主要用户路径和信息层级；只要 Lite 删除一个原入口，就在该页面实现中同时删除其数据依赖，不能以隐藏的占位、feature gate 或 mock 替代。

### Web 完成标准

以下工作台路径必须在原 Next 页面结构中可达，并使用最终 API：user profile；workspace/project shell、workspace settings、workspace/shared/personal context；project overview/settings、成员、credentials、endpoints、files、task list/create/detail、task summary、artifacts/preview、project chat、resource policy、usage、alerts/alert rules 和 light audit。它们应保留原页面的导航关系、详情层级、列表密度、加载/空/错误状态及关键编辑交互；不要求保留被明确排除的能力。

共同视觉基础和每个保留页面都必须同时满足：

- desktop light/dark 和窄屏均保持原工作台的信息层级、密度、间距、控件形态和响应式行为；不能只更换颜色后宣称完成。
- 页面正常、加载、空、错误、无权限和主要 dialog/drawer 状态使用迁回的共同组件；删除能力不显示禁用入口、占位 tab 或“coming soon”。
- 以 `.reference/agentsmith/e2e/__screenshots__/visual.spec.ts/` 中对应页面截图作为人工对照基线，但只检查 Lite 保留的内容。Playwright 可由开发者临时运行并现场修正，不提交截图报告、不建立视觉基线仓库、不加入发布 gate。
- Web 不出现 `/en`、`/zh` 等 locale 路径，不加载翻译 runtime；同一产品页面只存在一个英文实现。
- 共享 UI 先于业务页面迁回：原 `PageLayout`、`PageHeader`、`PageState`、toolbar、table/list、Button/Input/Dialog/Sheet、status badge、theme 和 responsive shell 是唯一共同实现；后续页面不得引入 Lite 专用平行表面或兼容 CSS。

## 阶段计划

### 阶段 1：身份、授权与 Next 工作台基础

**交付：**

- Keycloak/OIDC login、callback、session、logout，以及本地 OIDC identity 绑定。
- workspace/project membership 和 owner、admin、member、viewer 四种角色；membership 是唯一服务端授权真相，所有 workspace/project API 经 `AuthorizationService` 判定。成员管理仅指向已有本地 OIDC identity。
- PostgreSQL migrations；Next Web App 与 `/api/v1` 同源部署，并消费 substrates 输出的 PostgreSQL、JuiceFS、OIDC env/secrets。
- 原 AgentSmith workspace/project shell、导航和 session 体验恢复为后续页面的共同基础，不以新的 Lite 控制台替代。
- 从原仓库复制字体资产、theme tokens、全局样式和实际使用的基础 UI 组件；先恢复 `PageLayout`、`PageHeader`、`PageState`、toolbar、table/list、Button/Input/Dialog/Sheet、status badge、light/dark、topbar、workspace/project switcher、sidebar 分组/折叠、用户菜单和窄屏导航。复制时删除 i18n、旧权限 hook、旧 BFF 和已排除入口的依赖，直接连接 Lite session 与 API。
- 恢复 English-only local profile：Keycloak subject、email 和 verified 状态只读；仅保留 display name、bio、job title、company、timezone、greeting preference 和 interests 等本地 profile 字段，不提供 locale 或 language preference。
- 恢复 workspace/project 生命周期与 settings：workspace/project create、rename、archive/delete（如原页面支持）、project list、project metadata、owner transfer 和成员入口；不恢复 join policy、join request、group、project-creator governance 或治理历史。
- 恢复 workspace shared context、project shared context 和 project personal context；各自按 workspace/project membership 授权，personal context 只对当前 identity 可见，context 不承载 provider credential、session、文件内容或 sandbox 数据。

**定向验证：** 在本地单节点 K8s 以 OIDC 用户完成登录、profile 读写、创建/修改 workspace/project、owner transfer、按角色访问或拒绝访问 context/settings、退出；确认 Next 工作台与 API 同源运行，并人工查看 shell 和共同组件的 desktop light/dark 与窄屏状态是否符合原工作台。

### 阶段 2：Endpoint 与直接 Chat Completions Broker

**交付：**

- project-scoped endpoint CRUD、服务端凭据绑定，以及唯一的 OpenAI Chat Completions broker。应用保存 provider credentials；浏览器通过项目授权 API 路由调用，服务端完成 membership/task 授权后直接请求 provider 的 `/v1/chat/completions`。
- 恢复 project credential lifecycle：authorized user 可 list、create、rotate、delete 项目 provider credential，并由 endpoint 以 credential identifier 绑定；删除被 endpoint 使用的 credential 必须由服务端拒绝或要求先解除绑定。
- Botified 仅获得 task-scoped credential，用于其被授权 task 的产品 API 调用；绝不获得 provider key。浏览器、Botified 和项目 API 响应均不暴露 provider key。
- 不实现 adapter、fallback、legacy model path 或第二套 broker；chat 与 task 共用同一授权、broker 和资源策略路径。
- Endpoint UI 按 `.reference/agentsmith/src/components/endpoints/` 的实际依赖顺序迁移：先复制 `endpoints-page-utils.tsx`、`EndpointStatusBadge.tsx`、`create-endpoint-dialog/EndpointBasicsForm.tsx`、`EndpointDialogFooter.tsx`；再适配 `CreateEndpointDialog.tsx`、`edit-endpoint-dialog/EditEndpointForm.tsx`、`EditEndpointDialog.tsx`；随后适配 `EndpointsToolbar.tsx`、`EndpointsHeaderActions.tsx`、`EndpointsContent.tsx`、`EndpointsDialogs.tsx`；最后接入原 Next 页面路由。所有数据和 mutation 直连 `/api/v1`。
- 不迁移 `CustomEndpointWizard`、旧 BFF、mock 数据层、批量 import/export、catalog sync 或 agent-task model setting。保留 Next 和原样式/组件体系。

**定向验证：** 在本地单节点 K8s 用 authorized project user 创建/轮换 provider credential、绑定 endpoint，并使用管理员本地环境提供的真实 DeepSeek OpenAI-compatible 配置完成一次浏览器 chat；用 task-scoped Botified credential 完成同一 endpoint 的真实 task 调用；确认未授权请求、credential 明文和 provider-key 暴露均被拒绝。mock/fake provider 只用于窄单元测试，不能代替该真实后端确认。

### 阶段 3：固定文件库、Task 与 Sandbox 生命周期

**交付：**

- 从原 Files 页面恢复固定 JuiceFS `files/` 库的 list、二进制 upload、download、delete 体验；服务端执行项目授权和路径规范化。移除多文件库、savepoint、template、version、restore 与挂载入口，而不是另做新 Files 控制台。
- task/run 创建、输入 snapshot、Botified sandbox、typed interaction 投影、artifact list/download、artifact text/metadata preview、cancel、TTL/reap，以及 app-owned labels/UID 围栏。
- 完成、失败、取消或过期后的任务保留在 list/detail；detail 提供 status、run、Conversation、只读 sandbox summary、artifact preview/download 和服务端决定的 retry 或 successor action。

**定向验证：** 在本地单节点 K8s 上传项目文件、由 sandbox 从 snapshot 读取并写出 artifact、查看授权 preview、通过 API 下载；完成后从 task detail 发起服务端决定的 retry 或 successor，并确认取消和 TTL/reap 后只回收对应 app-owned 资源。

### 阶段 4：Task Detail 与 Chat

**交付：**

- 从原 Task List、Task Detail、Conversation 和 Artifacts 页面恢复状态、typed interactions、task summary、artifact preview/download 和只读 sandbox 信息，全部来自经授权产品 API。
- Task Conversation 的最终产品和架构边界以 `docs/task-interaction-product-improvement-plan.md`
  为准：Botified NDJSON 只存在于服务端 transport；AgentSmith Server 生成唯一 typed Interaction
  read model、message disposition、run state 和 capabilities；Web 不解析 timeline、不合并 lifecycle、
  不推断 action。Conversation 不提供 transcript、公开 raw events、独立 follow-up UI、Codex parser、
  adapter 或双 contract。
- 从原项目 chat 页面恢复 thread create、rename、delete、search、message stream、stop、Markdown render 和 composer 体验，继续调用阶段 2 的直接 Chat Completions broker；不引入浏览器直连 provider、Anthropic/universal proxy 或额外模型路径。

**定向验证：** 在本地单节点 K8s 查看运行任务的 Conversation updates、artifacts、summary 和 preview，下载授权 artifact，并完成 thread rename/delete/search、stream/stop 和 Markdown chat；viewer/member 权限按 API 返回的边界生效。

### 阶段 5：Policy、Usage、Alerts 与 Light Audit

**交付：**

- 从原 Resource Policy、Usage、Alerts 和 Audit 页面恢复项目级服务端资源 policy、最小 usage、alert-rule CRUD、notifications 和 light audit API/UI。删除全局 dashboard、治理 explainability、报告和控制面入口。
- usage 按实际可验证用量写入；alert rule 覆盖 task、endpoint、配额状态并由服务端评估；notifications、audit 仅保留必要项目操作和生命周期元数据。

**定向验证：** 在本地单节点 K8s 创建、编辑、enable/disable 和删除一条项目 alert rule，触发一条资源限制，检查对应 usage/notification/audit 的项目授权读取和敏感数据不落库。

## 交付与验证边界

本地单节点 K8s 是唯一最终验收目标。agents 负责 substrates 配置、安装、部署、重部署和所需的本地 OIDC/K8s 产品验证；用户不需要手动操作目标环境。每阶段只运行与当前业务路径有关、输出 stdout/stderr 且失败非零的窄验证。

禁止默认 gate、evidence/report/rehearsal 产物、宽泛测试包装和云验收。也不实现 LLMUP、Codex runner core、JVS、WebDAV、AFSCP、ASBCP、本地或远程文件挂载、operator/全局控制面、全局资源 CLI，或浏览器直连 Kubernetes、数据库、Botified、provider。Next、原工作台信息架构和原 UI 组件体系不属于排除范围。

最终完成判断只看本地单节点 K8s 中的真实产品行为：OIDC 登录、保留页面、真实 DeepSeek chat/task、JuiceFS 文件和 artifact、sandbox 生命周期、成员授权、policy/usage/alerts/audit。开发中发现缺陷立即在实现处修正；不为完成判断生成测试报告、证据目录、诊断文档或额外验收框架。
