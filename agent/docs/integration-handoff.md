# Agent 对接与注意事项

更新：2026-09-17。适用：`feat/independent-agent-bridge`，PR：https://github.com/dango10031/dangoo/pull/1 。

## 交付结论

Agent 核心、原画布挂载和首期图片节点桥接已实现。本轮增加原画布用户鉴权、初始服装详情页 Skill、`/` 与按钮调用、本地确定性 mock。当前是功能分支候选，尚未合并或部署线上；本地验收不代表全部 PRD 或生产验收。

用户已确认线上原节点生成可用，本次以此为前提。后续验证重点是 Agent 到节点的调用、授权、状态恢复和结果回写，不重复验收原生成服务。

本轮验证：Agent `npm test` 86/86；宿主 `agent-auth`、`agent-pb-auth`、`agent-canvas-save` 6/6；根目录 `npm run build` 通过。浏览器通过 `/` 键盘选择、Skill 请求参数、画布写入与版本增长、刷新恢复、按钮搜索/空结果、停止、桌面及窄屏弹层边界。原画布与构建 widget 的浏览器测试通过既有登录弹窗、PB 凭据转发、退出卸载与 401 后重新登录。PB HTTP 响应及验签平台边界使用本地 fixture；未调用付费生成，未验证线上部署。

验收中修复：widget 库构建中的 `process.env.NODE_ENV` 导致浏览器加载失败；SSE 先于 POST 返回导致重复气泡（按 requestId 关联）；技能弹层裁切；mock 多轮误用旧工具结果。

## 已有能力与边界

| 能力 | 当前状态 | 注意事项 |
| --- | --- | --- |
| 独立 runtime、Tool/Provider/Skill Registry | 已实现并测试 | 内置 `fashion-ecommerce-image-set`，支持 `/`、按钮搜索、选择及移除；默认加载 builtin，workspace 同名优先 |
| 平台模型 | 通过 Dangoo `/api/llm/*` 接入 | 模型清单和执行都复用原画布平台能力 |
| Provider 配置 | 仅平台模型选择 | 用户在悬浮框选择模型；不支持外部 API 地址和密钥配置 |
| 画布上下文 | 同一 owner + canvas 固定一个持久会话 | 已有重复历史保留，最早创建的会话作为主会话；旧重复会话没有 UI 切换入口 |
| 自动压缩 | 默认 256,000 tokens 触发，保留原历史、工具配对及固定信息 | 更小 Provider 窗口提前触发；详见下文 |
| 画布编辑 | 创建、修改、连接、布局、分组等 | 通过版本及幂等校验；不能把节点可编辑解释为所有节点均可运行 |
| 媒体生成 | 标准单张图片节点，支持连线提示词和参考图 | 视频、AI 应用、摄影机、选区、透明背景、批量尚未接入 Agent 执行 |
| 任务恢复 | 轮询、提交未知对账、永久存储后回写节点 | 未接入真实远端取消；停止对话不等于取消已提交生成 |
| 资产工具 | search/get/view 接口已预留 | 无真实资产服务时明确不可用；不伪造资产 ID |
| 悬浮 UI | 原画布内固定深色面板、流式正文与工具/任务状态 | 新设置面板的浏览器视觉验收尚未完成 |

## 本地 Agent mock

在 `agent/` 分别运行 `npm run dev:mock` 与 `npm run dev:ui`，打开 `http://127.0.0.1:5173`。mock 使用真实 runtime、SQLite、HTTP/SSE、Skill 与画布工具，仅替换模型为确定性实现，数据默认写入独立临时目录。它不读取真实 Provider 凭据，不暴露生图执行工具。这个演示入口不代表原应用的登录页或完整画布。

输入普通文字测试读取和新增提示词节点；输入 `mock:question` 测试补充问题，`mock:approval` 测试确认，`mock:failed` 测试失败，`mock:stop` 测试持续流与停止。`/fashion` 或“技能”按钮选择真实内置服装详情页 Skill。

`npm run smoke:mock` 验证多轮读写、版本增长、Skill 正文注入、持久会话、SSE、问答、确认、失败及停止。另可在安装 Playwright 的机器运行 `node scripts/browser-smoke.mjs`；外部安装通过 `PLAYWRIGHT_MODULE` 指定，截图默认写入 `agent/artifacts/mock-browser/`。原宿主鉴权测试在项目根执行 `node --test tests/agent-auth.test.mjs`，后端认证测试在 `agent/` 执行 `npm test`。

原画布浏览器认证测试：先在项目根执行 `npm run build`，再启动 `npm run dev -- --host 127.0.0.1 --port 5174`；在 `agent/` 执行 `node scripts/auth-browser-smoke.mjs`。该脚本只向本地测试页填入 fixture 账号，拦截业务 HTTP，不使用真实账号或生产数据。

## 上线前必须对接

### 1. 部署三个配套部分

- 原前端：在 `/canvas/:id` 挂载 widget，发送前保存，收到画布变更后同步。
- 独立 Node.js Agent 服务：运行 runtime、SQLite、Provider、HTTP/SSE。
- PocketBase：部署本分支配套 hooks、打包的节点桥接、钱包报价和原画布保存事务改动。

根目录 `npm run build` 会构建原应用、Agent 服务和 widget，并生成宿主桥接。生产启动 Agent 可在 `agent/` 执行 `npm start`，需 Node.js 20.19+。静态前端发布本身不会启动 Agent 服务。

不能只复制 widget 或单个 hook。业务侧手动保存与 Agent 写入需同时使用本分支事务方案，避免互相覆盖。桥接源文件位于 `agent/integrations/pocketbase/`，生成入口为 `agent/scripts/build-host-bridge.mjs`；修改源文件后重新生成。

### 2. 复用原画布用户鉴权

宿主从现有 PocketBase `authStore` 获取登录态，并通过原 `getAuthHeaders()` 发送凭据。本地使用 `Authorization`，托管网关使用 `X-Pb-Auth`；Agent 模块和 API 必须同源。登录变化会卸载旧 widget，阻止旧客户端继续发送；401 清理仍对应这次请求的失效登录态，避免清理已切换的新账号。

HTTP 模式每次请求通过 PocketBase `/api/agent-bridge/v1/identity` 验证凭据。该端点使用原钱包中间件的真实验签、账号封禁检查与 `authEmail`，不读取客户端声称的 ownerId。会话按服务端确认的邮箱与画布隔离，画布编辑、报价、生成与任务轮询继续携带该用户凭据，由原业务接口检查画布归属。

业务凭据仅保存在 Agent 进程内存，不写入 SQLite、前端新存储或 Skill。重启后后台任务需对应用户重新认证才能恢复访问；无有效凭据不会借用其他账号执行。`DANGOO_AUTH_TOKEN` 不再用作 HTTP 模式的共享用户身份。独立 `local` 工作台只用于显式本地测试。

生产需将同源 `/agent-api` 代理到 Agent 的本机监听端口，去掉 `/agent-api` 前缀；Vite 的开发代理不会进入生产产物。SSE 应关闭响应缓冲并配置足够的读超时，验证断线后按 sequence 重放。服务只监听 loopback，保留 Host/Origin 校验；若代理改写 Host，需要匹配其可信来源配置，不能通过通配 CORS 解决。

Provider 由管理员统一配置，保存在实例私有文件。HTTP 模式未设置 `AGENT_OWNER_ID` 时不开放配置管理；这不影响使用服务端已配置模型。没有新增账号系统或每用户模型密钥管理。

### 3. 服务配置

| 配置 | 所在进程 | 要求 |
| --- | --- | --- |
| `AGENT_CANVAS_MODE=http` | Agent | 产品接入使用 HTTP 桥接 |
| `AGENT_OWNER_ID` | Agent | HTTP 模式下仅指定可管理 Provider 的管理员邮箱；会话身份由 PB 验证得出 |
| `DANGOO_BRIDGE_URL` | Agent | 指向已部署的 `/api/agent-bridge/v1/`；托管域名通常带 `/__pb` |
| `DANGOO_AUTH_HEADER` | Agent | 直连 PB 为 `Authorization`；VibeX 托管网关为 `X-Pb-Auth` |
| `AGENT_TOKEN` | Agent | 仅显式 local 工作台的可选访问令牌；HTTP 模式使用原画布登录凭据 |
| `AGENT_DATA_DIR` | Agent | 可写且持久的本机目录，包含会话及私有配置 |
| `AGENT_AIGC_INTERNAL_URL` | PocketBase | 本机 PB 的 HTTP 地址，端口与实际服务一致；缺失时 jobs 关闭 |
| `VITE_DANGOO_AGENT_MODULE_URL` | 前端构建 | 默认为同源 `/agent/dangoo-agent-widget.js` |
| `VITE_DANGOO_AGENT_API_URL` | 前端构建 | 默认为同源 `/agent-api` |

Agent 不再读取或保存外部 API 地址、密钥和预算配置。`AGENT_MODEL` 只作为平台模型启动默认值；用户在设置面板保存后，下一轮对话采用新模型，正在运行的请求保留原快照。

### 4. 扣费与节点结果

执行流程：读取画布 -> 配置节点及连线 -> `node_quote` -> 必要时确认 -> `node_run` -> `job_get`/后台轮询 -> 永久存储 -> 原节点追加结果。

报价使用钱包实际计价逻辑，绑定节点输入、连线、版本和有效期。报价有效期是业务价格有效期，不是用户预授权期限。价格上涨或版本失效需重新报价；提交响应不明时按 operation/task 记录对账，不直接重新生成。

用户通过自然语言表达预授权、限制及撤销，由模型理解。服务端验证引用来自当前会话的用户消息，确认按钮精确绑定运行与报价；没有额外金额、24 小时等固定授权规则。语义判断仍取决于模型，应验收“授权后撤销”“任务范围变化”等真实对话。

停止 Agent 后，已提交生成仍可完成并由后台回收；不能显示“远端已取消”。回写追加候选并保留用户手动修改、主图选择及连线。业务生成正常不等于新 Agent 的存储、回写和事件展示已在部署环境验收。

### 5. 上下文、资产和持久化

256K 是自动压缩触发阈值。当前估算包括系统提示、工具定义、历史、图片和输出预留，实际触发为 `min(256000, Provider窗口)`。默认窗口 128000，因此默认配置会提前压缩；更换 Provider 后按实际支持容量配置。当前使用估算，并非模型官方 tokenizer 的精确 token 计数。

压缩不删除原始持久消息。会话、检查点、事件和幂等记录需一起持久化；SQLite/WAL 备份应使用一致性快照。当前按单实例部署验收，尚未验证多个 Agent 实例同时执行同一任务，不能只增加副本数来横向扩容。

资产详细设计见 [canvas-assets.md](canvas-assets.md)。需业务侧提供稳定 assetId、内容版本、访问权限、搜索元数据、可供视觉读取的 URL 及生成产物登记。当前允许节点业务流程使用现有媒体 URL，但这不等于完成资产库或 Agent 看图能力；资产迁移未执行。

## 待验收清单

1. 部署配套组件后，原画布可打开 Agent，重新进入恢复同一会话；两个画布的消息和授权不互通。
2. 设置面板能主动填写并保存 key；刷新只显示已配置状态，网络响应与日志不泄露 key；测试失败可重试。
3. 流式正文、工具运行、等待确认、停止和断线恢复显示正确；桌面与窄屏无遮挡，深色固定面板不重复展示头像、名称、时间。
4. 用业务返回或受控 fixture 验证单张图片任务：确认/拒绝、预授权/撤销、成功回写、失败、提交未知、重启恢复和停止后回收。真实生成仅在确需验证接线时少量执行。
5. 在真实模型上验证长对话压缩后的创作要求、授权限制和工具配对；确认账户容量与视觉支持，再开放相应能力。
6. 多用户上线前完成认证、凭据刷新、配置归属和越权验证；当前单账号开发配置不作为该项验收证据。

## 验证记录与后续范围

已有证据：72 项 Agent 测试、原应用集成构建、此前宿主事务 2 项测试、原生 PocketBase fixture 节点链路、真实 GLM 文本流与节点编辑回读。线上认证、钱包和模型目录只读验证成功；线上桥接检查曾返回 404，这是检查时状态，部署后重新核实。

已有构建警告为原应用大 chunk 及 widget Tailwind 配置提示。新设置表单的浏览器视觉验收、多用户部署、真实视觉输入和规模性能尚未完成。视频等额外节点执行及资产服务属于后续接入，不以原节点本身可生成替代 Agent 支持。

更详细的历史证据见 [implementation-status.md](implementation-status.md)。其中保留了旧阶段记录；当前交接范围以本文为准。
