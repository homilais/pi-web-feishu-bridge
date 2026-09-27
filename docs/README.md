# 飞书远程指挥 pi —— 项目文档

> 本目录只放**当前项目的实现文档**（设计、使用、部署）。
> 方案确定前的调研、选型评估、外部技术资料放在 [`../learning/`](../learning/)。

| 文档 | 内容 |
|---|---|
| [`README.md`](./README.md) | 项目介绍、架构设计、功能清单、目录结构（本文件） |
| [`USAGE.md`](./USAGE.md) | **使用手册**：指令一览、卡片一览、常见场景、排错 |
| [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) | 安装、配置、运行、验证、运维 |
| [`PUBLISH.md`](./PUBLISH.md) | **发布到 npm**：package.json 改造、build 配置、发布流程、常见坑 |

## 项目是什么

一个**外挂式飞书桥接**：在飞书（手机端）像聊天一样给电脑上的 pi 编码 agent 下任务，pi 在本地干活，进度和结果通过**飞书流式卡片**实时推回手机。

> ⚠️ **前提**：[`@agegr/pi-web@0.9.3`](https://www.npmjs.com/package/@agegr/pi-web) 必须先安装并常驻运行。
> 本项目**不直接操作 pi SDK**，全部会话操作走 pi-web 的 HTTP/SSE。
> 连不上 pi-web 时桥接**直接退出**，不会降级运行。

- 不需要公网暴露（飞书走**长连接出站**）
- **多 agent 并行**：一个飞书群同时指挥多个项目的 agent（跨项目并行、同项目串行）
- 任务**流式**回传（打字机效果），完成时推送通知
- 支持多项目并行、工具调用状态展示、审批按钮确认、模型/项目点选切换
- 与原生 `pi -c` 共享同一份 session 文件，可交替使用

## 架构

```
手机飞书
   ↕  WebSocket 长连接（出站，无需公网）
   ↕
飞书桥接（本项目，独立 Node 进程）
   ├─ 收飞书消息/卡片回调 → 指令路由 → 单会话串行队列
   └─ 翻译层：SSE 事件 → 飞书流式卡片
   ↕  HTTP + SSE（127.0.0.1，Basic Auth）
@agegr/pi-web（Next.js 网关）
   ↕  进程内 SDK 调用
pi SDK（@earendil-works/pi-coding-agent）
   ↕  HTTP
模型供应商
```

三层职责分离：
- **pi-web** 是唯一的会话所有者（会话创建/销毁/事件广播都走它），桥接只订阅 SSE + 投递指令，**不自己起 pi 进程写 session 文件**（避免锁冲突）
- **桥接** 是纯翻译层：飞书协议 ↔ pi-web 接口
- **pi SDK** 在 pi-web 进程内运行 agent，与 `pi -c` 共享 session 文件

## 功能清单

| 功能 | 状态 | 实现位置 |
|---|---|---|
| 飞书长连接收发消息 | ✅ | `src/feishu/`、`src/index.ts` |
| SSE 事件订阅（自动重连+状态对齐） | ✅ | `src/piweb/events.ts` |
| 流式卡片（打字机） | ✅ | `src/bridge/streamer.ts`、`src/feishu/cards.ts` |
| 工具调用状态行 | ✅ | `src/bridge/turn-state.ts` |
| 审批按钮（`extension_ui_request` → 卡片 → `extension_ui_response`） | ✅ 链路就绪 | `src/bridge/turn-state.ts`、`bridge.ts` |
| 完成通知 | ✅（挂 `agent_settled`） | `src/bridge/bridge.ts` |
| **多 agent 并行执行**（跨项目） | ✅ 实测 | `src/bridge/queue.ts` `QueueMap` |
| 同项目串行队列（防 session 并发写冲突） | ✅ | `src/bridge/queue.ts` `SerialQueue` |
| 多项目切换（`/info` 下拉） | ✅ | `src/feishu/cards.ts` `statusCard` |
| 模型点选切换（`/info` 下拉） | ✅ | `src/feishu/cards.ts` `statusCard` |
| 按项目复用 agent 进程 | ✅ | `src/bridge/bridge.ts` `ensureAgent` |
| 回复卡片定向路由 | ✅ | `src/bridge/registry.ts` `routes` |
| 执行进展卡（`/last` 双模式） | ✅ | `src/piweb/client.ts` `getLiveProgress` |
| 卡片复用（最后回复/摘要/进展） | ✅ | `src/feishu/cards.ts` |
| 会话释放给终端 | ✅ | `src/bridge/bridge.ts` `/release` |
| 持久化会话绑定（v2） | ✅ | `registry.json` |

## 飞书指令

| 指令 | 说明 | 回复形式 |
|---|---|---|
| `/help` | 指令帮助 | 卡片 |
| `/info` | 项目 + 模型（**下拉切换**） | 卡片 |
| `/switch <项目>` | 切换项目（**必须带参**） | 卡片 |
| `/model <provider>/<modelId>` | 切换模型（**必须带参**） | 文本回执 |
| `/last` | 空闲=最后回复；**执行中=实时进展** | 卡片 |
| `/agents` | 会话列表（点击切换；已回收自动解绑） | 卡片 |
| `/abort` | 停止当前任务（保留绑定） | 文本回执 |
| `/release` | 纯解绑（**不打断任务**） | 卡片 |
| 直接发消息 | 下发任务（流式卡片回复） | 流式卡片 |
| **回复任意卡片** | 定向到该卡片的项目/进程 | 流式卡片 |

> 无参 `/switch`、`/model` 与未知指令统一回 help 卡；
> 「去 /info」类引导不再单独发文本，提示并入卡片顶部（`statusCard.notice`）。

## 代码结构

```
src/
├── index.ts              入口：装配 + 长驻 + 优雅退出
├── config.ts             配置加载（.env）
├── log.ts                日志
├── piweb/                Pi-Web 客户端（纯 pi-web 接口封装）
│   ├── types.ts          已核实的事件/RPC 类型
│   ├── client.ts         HTTP 客户端（Basic Auth pi:<password>、节流重试）
│   └── events.ts         SSE 订阅（fetch 手动解析、自动重连、状态对齐）
├── bridge/               核心逻辑
│   ├── turn-state.ts     单轮状态机：消费 SSE 事件 → 可渲染状态
│   ├── streamer.ts       翻译层：SSE → 飞书流式卡片
│   ├── bridge.ts         编排：消息路由、指令、卡片动作、审批
│   ├── registry.ts       飞书会话 ↔ 项目 ↔ agent 绑定（持久化）
│   └── queue.ts          单 agent 串行队列 + 审批 pending 表
├── feishu/
│   └── cards.ts          飞书卡片 V2 构建器（流式/工具/审批/模型列表/项目列表）
└── probes/               探针（独立验证单个环节）
    ├── probe-piweb.ts    端到端验证 pi-web 侧（无需飞书凭据）
    └── probe-feishu.ts   验证飞书长连接 + 卡片按钮回调
```

## 关键设计决策

1. **会话所有权只在 pi-web** —— 桥接不直接操作 pi SDK，避免「两个进程同时写一份 session 文件」。代价是多一层 HTTP 转发（本地毫秒级）。
2. **完成通知挂 `agent_settled` 而非 `agent_end`** —— `agent_end` 之后可能还有 auto_retry / 上下文压缩 / 队列消息，`agent_settled` 才是真正彻底空闲。
3. **飞书侧用官方 `createLarkChannel()`** —— 长连接、流式卡片、按钮回调、白名单、去重、分片、重试全部内置，不自搓飞书协议。
4. **`PI_WEB_IDLE_TIMEOUT_MS` 需按工作流调整** —— 桥接常驻设 `0`（防会话被回收）；要频繁交给终端就设 `60000`（1 分钟后自动释放锁）。
5. **模型需选稳定的** —— 部分供应商/模型会间歇返回空文本、触发 auto_retry；换模型之前先用小任务验证一下。
6. **执行进展不用 SSE** —— `GET /api/sessions/[id]/context` 在**执行中**就返回实时消息（assistant 流式文本 / toolCall / toolResult），轮询即可拼装进展快照。见 `getLiveProgress`。
7. **卡片优先于文本** —— 含结构化信息或需要用户操作的回复一律走卡片；纯状态回执（≤1 行）保持文本。提示语并入卡片顶部而非另发消息。

## 依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| `@larksuiteoapi/node-sdk` | ^1.74.0 | 飞书 SDK（含 `createLarkChannel`） |
| `@agegr/pi-web` | 0.9.3 | **基座**，单独安装运行（不在本项目依赖里） |
| Node.js | >=22.19 | 实测 Node 26.8.2；直接用 type stripping 跑 .ts |

## 参考（调研/学习资料）

- [`../learning/PIWEB-CAPABILITIES.md`](../learning/PIWEB-CAPABILITIES.md) —— pi-web 完整能力手册（API/SSE/鉴权/生命周期）
- [`../learning/VERIFIED.md`](../learning/VERIFIED.md) —— pi-web 接口实测核实记录
- [`../learning/EVALUATION.md`](../learning/EVALUATION.md) —— 三方案选型评估
- [`../learning/plan-2-external-bridge.md`](../learning/plan-2-external-bridge.md) —— 本方案的原始设计文档