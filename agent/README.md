# Dangoo Agent

面向节点画布创作的独立 Agent。Node.js + TypeScript + SQLite，运行时不依赖 Codex。采用 Codex 的核心机制改写，源码与行为对应关系见 [source-map.md](docs/source-map.md)。

当前交付边界、生产配置、待对接及验收事项见 [Agent 对接与注意事项](docs/integration-handoff.md)。

## 在现有画布中启用

产品入口是宿主现有 `/canvas/:id` 页面中的固定悬浮框。`agent/` 是可独立构建和维护的代码包；无新增 Agent 产品模式或画布路由。

要求 Node.js 20.19+（原画布 Vite 8 需要 20.19+ 或 22.12+）。在仓库根目录执行：

```sh
npm run agent:install
npm run agent:build
```

设置 `AGENT_CANVAS_MODE=http`，填入当前本地测试用户的 `AGENT_OWNER_ID`（业务邮箱）、`AGENT_CANVAS_ID`、`DANGOO_BRIDGE_URL` 及该用户的 `DANGOO_AUTH_TOKEN`。宿主 PocketBase 应运行配套 hooks。然后分别启动：

```sh
npm run agent:dev
npm run dev
```

在原画布页面使用右下角 Agent。原应用的 Vite 开发代理将 `/agent-api` 转发到本机 `4317`；生产需要相同路径的反向代理。`npm run build` 会构建 Agent runtime 和 widget，并将 widget 放入原应用的 `public/agent/`，最终随原应用静态产物发布。

当前服务入口按单业务账号配置，HTTP 模式支持该账号有权限的多个画布。多用户部署需由可信认证入口提供用户与画布权限，并按主体选择业务凭据；不能把固定测试用户的服务直接开放到公网。`AGENT_TOKEN` 仅用于 Agent 服务认证。

Dangoo 平台模型通过 `/api/llm/*` 访问。模型不可用时显示未配置，不自动替换模拟模型。

### 内部联调工作台

仅供开发者独立验证内核：设置 `AGENT_CANVAS_MODE=local` 后，在本包目录运行 `npm run dev` 和 `npm run dev:ui`。此入口保存独立 SQLite 画布，不是产品交付入口，也不连接原画布媒体生成或钱包。

## 选择平台模型

HTTP 桥接模式按业务账号访问多个画布，建立会话前由业务桥接校验画布权限；每个画布保持自己的唯一会话。本地内部工作台仅开放 `AGENT_CANVAS_ID` 对应的测试画布。VibeX 托管桥接设置 `DANGOO_AUTH_HEADER=X-Pb-Auth`，直连 PocketBase 保持默认 `Authorization`。

`AGENT_MODEL` 可作为启动默认模型；平台模型清单以 `/api/llm/models` 为准。用户也可在原画布悬浮框点击设置，只选择平台模型并保存。设置保存到服务端 `data/provider-settings.json`（权限 0600），旧配置里的 API 地址和密钥会在启动时清除。保存后下一轮对话采用新模型，正在执行的任务保留原快照。

| 配置项 | 用途 |
| --- | --- |
| `AGENT_MODEL` | 实际发送给 Provider 的模型名 |
| `AGENT_MAX_MODEL_TURNS` | 单次运行最多模型往返次数，默认 128；到达上限保留进度并显示部分完成 |

`data/` 已从版本控制排除。

## 工程边界

```text
src/contracts  稳定接口与事件
src/core       Runtime / SQLite / Tool Registry / Scheduler / 恢复
src/providers  Provider Registry 与 OpenAI-compatible 流式协议
src/skills     Skill Registry / 发现 / 快照 / 资源加载
src/context    历史、预算、压缩、引用保留
src/adapters   Dangoo 节点和资产适配
src/server     独立 HTTP + SSE 服务
src/ui         悬浮对话、事件状态与宿主挂载
integrations   PocketBase 业务桥接源文件
```

Agent 数据库保存会话、事件、检查点、操作记录与结果引用。真实画布、资产文件、生成任务和钱包仍由 Dangoo 业务系统负责。运行目录 `data/`、`.env` 和数据库文件不进入 Git。

## 本次已接入的业务能力

- `canvas_read`、`node_catalog`、`canvas_apply`：节点创建、更新、删除、复制、连接/断开、布局、分组/解组，版本冲突和持久幂等。
- `asset_search / asset_get / asset_view`：完整接口与适配入口。尚未配置真实资产服务时明确不可用。
- `node_image_models / node_quote / node_run / job_get`：标准单张图片节点通过连接图读取提示词及参考图，复用业务提交、钱包扣费、任务查询和永久媒体存储。未设置 PocketBase 的 `AGENT_AIGC_INTERNAL_URL` 时 jobs 关闭。远端取消尚不支持，不注册 `job_cancel`。
- 原项目挂载：独立 UI 包通过同源动态模块挂载；发送前等待画布持久保存，收到 canvas.changed 后在没有本地改动时同步，有冲突沿用原项目恢复入口。

节点参数目前提供安全白名单；已有节点的其他字段、生成历史和裁剪信息在读写中保留。各生成模型的完整参数和定价授权要由后续节点执行 adapter 提供。执行能力缺失时不把通用节点目录的存在当成可以生成。

## 接入原项目

本包位于原仓库 `agent/`，接入在功能分支 `feat/independent-agent-bridge`。只保留桥接路由、认证路由范围、手动保存的事务封装、UI 挂载及同步方法；没有把内核塞进 `useCanvas.ts`。

构建独立组件与业务桥接：

```sh
npm run build
```

产物分别为 `dist/runtime`、`dist/ui`、`dist/widget`、`dist/host`。业务桥接源在 `integrations/pocketbase/agent-bridge.pb.js`，纯命令 reducer 从 `src/adapters/pocketbase-mapping.ts` 打包。需要更新开发中的宿主桥接时显式执行：

```sh
node scripts/build-host-bridge.mjs ../pocketbase/pb_hooks
```

生产接入应通过宿主 PR 发布配套改动；仅复制 hook 而没有手动保存事务修正，会再次产生两种写入口竞态。事务设计依据 PocketBase [官方数据库文档](https://pocketbase.io/docs/js-database/)。

把 widget 静态产物放到 Dangoo 的同源静态资源目录，配置宿主环境中的 `VITE_DANGOO_AGENT_MODULE_URL` 和 `VITE_DANGOO_AGENT_API_URL`。模块入口为 `dist/widget/dangoo-agent-widget.js`，React 与隔离样式随包提供。不要在 `VITE_*` 中填写 Provider key。Agent API 建议同源反向代理，认证由受控入口绑定 owner/canvas 范围。

服务端设 `AGENT_CANVAS_MODE=http`，指定 `DANGOO_BRIDGE_URL` 和经过业务系统认证的 `DANGOO_AUTH_TOKEN`。HTTP gateway 先验证契约主版本和能力，再启用工具。当前默认配置面向单用户本机开发；多用户部署需使用服务的 token→principal 映射，并为每个主体注入对应业务授权，不能共用一个用户的 PB token 服务所有人。

## 资产实施建议

详细方案见 [canvas-assets.md](docs/canvas-assets.md)，包括逻辑资产/内容版本/物理文件、数据表与索引、权限、搜索/查看/执行引用、生成落库和补偿、裁剪与候选组、旧数据迁移及验收用例。当前仅准备接入，不执行生产迁移。

## 验证

```sh
npm run typecheck
npm test
npm run build
```

测试区分 Dangoo 平台 Provider、核心/SQLite真实执行、PocketBase hook模拟环境与UI状态测试。fixtures 不能证明平台模型账户可用，也不能证明原 PocketBase 服务已经部署。最终验证记录在 [implementation-status.md](docs/implementation-status.md)。

线上原节点生成按用户确认的可用前提处理。Agent 的节点/钱包桥接已实现，待部署环境接线验收；资产服务待接入。原生 PocketBase 隔离回归已通过，使用测试认证。原应用集成构建通过，但不能替代多用户认证、浏览器视觉和部署验收。

## 节点媒体生成

启动宿主 PocketBase 时设置 `AGENT_AIGC_INTERNAL_URL=http://127.0.0.1:7000`（端口与实际服务一致），部署本分支的全部配套 hooks，包括钱包报价改动。Agent 服务仍使用该用户的 `DANGOO_AUTH_TOKEN`。内部调用复用业务鉴权、模型目录、钱包计价、提交及轮询，Agent 不读取媒体 Provider 密钥。

用户明确要求的节点编辑直接执行；即将扣费且尚未授权时展示确认。用户可以在当前对话中用自然语言预先授权，Agent 判断范围和后续撤销，不设置额外金额、时长规则。用户授权原文只在当前会话核对，画布之间不共享上下文或授权。

报价绑定节点输入、连接和画布版本；提交最多扣除已确认报价，价格上涨则重新报价。已提交任务由服务端持续查询，停止对话不会伪造远端取消。结果转存后追加到原节点，保留并发手动修改及主图选择。未知提交按幂等记录对账，禁止自动重提。

首期为标准单张图片节点，视频、AI 应用、摄影机、选区、透明背景和批量仍用原画布入口。真实业务账号出图和实际钱包流水尚待联调；本地原生测试使用 fixture 媒体服务，未产生付费生成。
