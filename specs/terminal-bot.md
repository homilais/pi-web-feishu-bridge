# Spec: 终端感知机器人（Terminal Bot）

Status: active
Owner: homilais
Created: 2026-10-05

## Problem

当前 `pi-web-feishu-bridge` 只能连接**独立运行的 pi-web 服务**（监听 `127.0.0.1:30141`）来远程指挥编码 agent。这带来两个限制：

1. **必须常驻 pi-web** —— 想用飞书指挥，就必须先起一个额外服务；它本身还要用 `node-pty` + xterm 模拟终端。
2. **场景割裂** —— 用户在终端直接跑 `pi`（人机对话）时，飞书完全无法介入；两条使用路径互不相通。

用户希望：**在终端跑 `pi` 时，飞书也能对同一个 pi 会话进行对话控制**，从而不再强依赖 pi-web。

## Goals

- 终端 pi 启动后，其会话能被飞书发现并选择（`/agents`）
- 飞书对该会话的功能与 pi-web 会话**对等**：消息、流式卡片、审批、停止、模型切换、`/last`、`/switch`
- 新增一类机器人 `kind: pi-terminal`，与现有 `piweb-pool` / `piweb-scoped` 并存，**不破坏现有 pi-web 能力**
- 扩展与 bridge 版本永不错位（单包分发）
- bridge 未运行时，扩展对日常 `pi` 使用**零干扰**

## Non-Goals

- 跨机器接入（仅限本机 localhost）
- 多个 `kind: pi-terminal` 机器人（至多一个）
- 终端会话的 cwd 归属/筛选/独占（终端会话按进程而非 cwd 归属）
- 替换或下线 pi-web 后端
- 替换 `@larksuiteoapi/node-sdk` 的飞书长连接层
- 把终端上的人机对话镜像到飞书

## Current Behavior

- `config.ts` 解析 `config.yaml`，`bots[]` 只有两种形态：`cwds` 为空 = 默认机器人（可绑 pi-web 全集），`cwds` 非空 = 限定机器人
- `index.ts` 为每个 bot 建独立 `channel` / `Registry` / `Bridge`，共享一个 `PiWebClient`
- `Bridge` 通过 `this.client.X()` 直接调用 `PiWebClient`（约 17 处，分布在 `bridge.ts` / `streamer.ts`），方法包括 `getState` / `sendPrompt` / `abort` / `setModel` / `getSessionContext` / `getLiveProgress` / `sse` / `getModels` / `listProjects` / `createAgent`
- `ensureAgent()` 按 cwd 从 pi-web 解析/创建 agent；`findExistingAgent()` 优先取 pi-web `activeSessionId`
- 审批通过 `PendingApprovals`（`queue.ts`）实现：注册 resolver，等飞书卡片按钮回调后 resolve
- bridge 进程**没有任何入站监听**（`lsof` 确认监听端口数为 0），只持有 2 条到飞书的出站 `ESTABLISHED` 连接

### 关键外部事实（已查证）

| 事实 | 来源 |
|---|---|
| `pi` CLI 无入站端口；`--mode` 仅 `text` / `json` / `rpc` | `pi --help` |
| RPC 是「客户端启动 `pi --mode rpc` 子进程」，无法连入已运行的 pi | `docs/rpc.md` |
| pi-web 并非用 RPC，而是以 SDK 在自身进程内跑 agent | `pi-web` 依赖 `@earendil-works/pi-coding-agent` + `node-pty` |
| pi 支持进程内扩展（jiti 直载 TS，无需编译） | `docs/extensions.md` |
| `pi.sendUserMessage(content, { deliverAs: "steer" \| "followUp" })` | `extensions/types.d.ts` |
| `ctx.sessionManager` 暴露 `getSessionId` / `getCwd` / `getEntries` | 同上 |
| `ExtensionUIDialogOptions.signal` —「programmatically dismiss the dialog」 | 同上 |
| 同一 session 的 SSE 端点支持并发多订阅 | 实测：两条并发连接均正常建立并收到 `connected` |
| bridge 当前无入站监听 | `lsof -a -p <pid> -iTCP -sTCP:LISTEN` → 0 |

## Desired Behavior

### 拓扑

pi 无法被外部连入，因此连接方向固定为**扩展主动连出**：

```
终端 pi 进程                         bridge（新增 localhost 监听）
┌──────────────────┐                ┌───────────────────────────┐
│ pi-feishu 扩展    │                │ 写发现文件                 │
│                  │──②POST 批量───►│   ~/.pi-bridge/bridge.json│
│ session_start    │   上行事件      │   {port, pid, version}    │
│ 事件监听          │                │ 监听 localhost:<port>      │
│                  │◄──SSE 下行──────│ 终端会话注册表 + 路由       │
│ sendUserMessage  │   命令          │                           │
└──────────────────┘                └───────────────────────────┘
```

- **上行**（扩展 → bridge）：批量 POST，周期 ~200ms
- **下行**（bridge → 扩展）：常驻 SSE 流，推送 prompt / abort / set_model / 取历史
- **认证**：无 token，仅绑定 localhost
- **端口**：全局单监听，所有 bot 的终端会话共用

### 上行批处理的合并规则（无损）

只有一类事件需要合并，其余要么幂等、要么必须原样保留：

| 事件 | 丢/乱序后果 | 策略 |
|---|---|---|
| `text_delta` | **丢字**（追加语义） | **拼接**（唯一需合并者） |
| `text_start` | 段落边界错乱 | 保序原样 |
| `toolcall_start` / `tool_execution_start` | 幂等（代码已判重） | 原样 |
| `tool_execution_end` | 状态永远卡在 running | 不可丢，原样 |
| `extension_ui_request`（审批） | 审批死锁 | 不可丢，原样 |
| `agent_settled` | 卡片永不收尾 | 不可丢，原样 |
| `message_end` | 容错（有长度护栏） | 原样 |

实现要点：单发送者 + drain 循环（在途请求期间新事件攒入下一批）；积压超阈值时把所有 delta 塌缩为一条作溢出兜底。

### 三类机器人

| kind | 可绑集合 | 数量 |
|---|---|---|
| `piweb-pool`（现有默认） | pi-web 全集 − 被其他 bot 声明的 cwd | ≤ 1 |
| `piweb-scoped`（现有限定） | 自身 cwds ∩ pi-web | 任意 |
| **`terminal`（新增）** | **仅终端会话** | **= 1，且不可声明 `cwds`** |

终端会话严格隔离：只归 `pi-terminal` bot，`piweb-pool` / `piweb-scoped` 完全不可见，反之亦然。`/agents` 语义干净，不混杂两类来源。

**`kind` 字段与向后兼容**：`kind` 可选。缺省时按现有规则推断——`cwds` 为空 → `piweb-pool`，`cwds` 非空 → `piweb-scoped`，因此**现有配置无需修改**。只有 `pi-terminal` 必须显式声明（它同样没有 `cwds`，无法靠推断区分），且不得同时声明 `cwds`（语义冲突 → 启动报错）。

### 会话标识

一个终端进程 = 一个可选项（不去重）。标签含 `pid` + `cwd` + 启动时间。

### 行为约定

| 项 | 约定 |
|---|---|
| `/last` | **不区分后端**；统一读真实 session 尾部，**显示全部**（含终端发起的），不做过滤 |
| `/switch` | = 在**终端进程之间**切换绑定 |
| `/abort` | 飞书**可中止任何回合**（收回控制权 ≠ 授权） |
| 可见性 | `/agents` 显示终端会话；飞书发起的回合实时流式；**终端上的人机对话不上报**（仅报状态，不报内容） |
| 断线 | 标记「⚪ 离线」保留 → **60s** 后从 `/agents` 移除 |
| 重连 | **状态重取**（复用 `/last` 通路），**不做事件补发** |
| 投递方式 | 与 pi-web 一致 = **`followUp`**（排队，不插队） |

### 审批模型（不对称：终端是超集审批者）

| 回合发起方 | 审批出现位置 | 谁能批 | 机制 |
|---|---|---|---|
| 用户（终端） | **仅终端** | 只有用户 | 原生弹窗 |
| 飞书 | **终端 + 飞书卡片** | 用户 **或** 飞书，先响应者胜 | `Promise.race` + `AbortSignal` 撤销另一侧 |

原理：**「给予」权限看信息完整度，「收回」权限看安全性。** 终端持有全部对话记录（含飞书发起的消息），故它做审批判断时信息完整；飞书看不到用户在终端的操作，故**不能代批用户的回合**。而中止是收回控制权，最坏结果是白干，故飞书可中止任何回合。

实现依据：`ExtensionUIDialogOptions.signal` 的官方注释为 "AbortSignal to programmatically dismiss the dialog"，飞书先响应时用它撤掉终端弹窗。

### 代码抽象边界

只抽象**会话级**接口，项目级操作留在 pi-web 路径：

```typescript
interface AgentSession {
  getState(): Promise<SessionState>;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  getContext(tail: number): Promise<SessionContext>;
  onEvent(handler: (ev: SessionEvent) => void): () => void;
}
// 两个实现：PiWebSession（包装现有 PiWebClient）、TerminalSession（走扩展通道）
```

`listProjects` / `createAgent` **不纳入接口** —— 终端会话不是「项目」，pi 已在运行，硬套会产生无法诚实实现的假方法。

### 扩展分发

扩展随现有 npm 包发布，新增子命令 `pi-web-feishu-bridge install-extension` 安装到 `~/.pi/agent/extensions/`；亦可 `pi --extension <path>` 单次启用。单包保证扩展与 bridge 的协议版本永不错位。

### bridge 未运行时

扩展**静默降级**：读不到发现文件或连不上 → 完全不介入，pi 正常可用；启动时输出**一次**提示（可静音）：`ℹ️ 未检测到 pi-bridge，飞书远程控制未启用（不影响本地使用）`。

## Acceptance Criteria

- [ ] `config.yaml` 支持 `kind: pi-terminal`，至多一个，且与 `cwds` 互斥（同时声明 → 启动报错）
- [ ] 未声明 `kind` 的现有配置仍按原规则推断（空 cwds → `piweb-pool`，非空 → `piweb-scoped`），无需修改
- [ ] bridge 启动时写 `~/.pi-bridge/bridge.json`（port/pid/version），监听 `127.0.0.1:<port>`（仅本机）
- [ ] 扩展启动读发现文件并连上；读不到则静默降级 + 单次提示
- [ ] 终端 pi 启动后，其会话出现在 `terminal` bot 的 `/agents` 列表；pi-web bot 的 `/agents` 不含它，反之亦然
- [ ] 同一 cwd 开两个终端 → `/agents` 出现两行（不去重）
- [ ] 飞书发消息 → 该消息也出现在终端（终端可见飞书全部消息）
- [ ] 飞书发起的回合：卡片流式更新直到 `agent_settled`
- [ ] 飞书发起的回合需审批 → **终端弹窗与飞书卡片同时出现**；任一侧响应后另一侧消失
- [ ] 用户发起的回合需审批 → 飞书**看不到**该审批，且**不能**代批
- [ ] `/abort` 可中止任何回合（终端发起的也可）
- [ ] `/last` 在两类后端上语义一致，均显示最后一条（含用户终端发起的回合）
- [ ] `/switch` 在终端会话间切换绑定
- [ ] 扩展连接断开 → `/agents` 该行变「⚪ 离线」，60s 后移除
- [ ] 扩展重连 → 状态重取（当前文本/工具/状态），不重放历史事件
- [ ] 上行批量合并：长时间任务下 `text_delta` **无丢字**（可对比终端实际输出与卡片文本）
- [ ] 终端对话内容**不上报**到飞书（仅状态）
- [ ] `install-extension` 可安装扩展到 `~/.pi/agent/extensions/`；`pi` 能加载并注册
- [ ] `npm run typecheck` 与 `npm run build` 通过

## Edge Cases

- **同机多终端并发**：每个 pi 独立注册，bridge 按 sessionId 路由；bot 归属一致
- **扩展崩溃/终端被杀**：连接断开 → 离线 → 60s 移除；不残留路由
- **bridge 重启**：扩展需重连（发现文件 pid 变化 → 重读）；期间飞书侧终端会话短暂离线
- **发现文件过期**（bridge 已死但文件残留）：扩展校验 pid 存活 + 端口可连，两者任一失败即降级
- **飞书消息到达时终端正忙**：按 `followUp` 排队，不插队（与 pi-web 一致）
- **同一终端会话被两个飞书群绑定**：两群均可下发；串行队列保证不并发
- **扩展与 bridge 版本不一致**：单包分发从根上避免；若手工装了旧版扩展，需在发现文件 version 字段校验并警告
- **审批双方同时响应**：`Promise.race` 先到者胜；另一侧经 `AbortSignal` 撤销
- **端口被占用**：bridge 启动失败并给出明确错误，不静默降级
- **扩展在非 TUI 模式**（`--mode json`/`rpc`/`print`）：`ctx.hasUI === false`，不弹终端弹窗，审批只在飞书

## Suggested Approach

### 实施顺序（建议垂直切分）

1. **协议与骨架**：定义 `AgentSession` 接口 + 消息类型；bridge 监听端口 + 发现文件
2. **扩展最小可用**：注册 + SSE 下行（prompt/abort）+ 状态上报，`/agents` 可见
3. **上行批处理**：批量 POST + 合并（无丢字）
4. **功能对等**：`/last`、`/switch`、`/model`、`/abort`、流式卡片
5. **审批双通道**：race + AbortSignal
6. **配置与分发**：`kind: pi-terminal`、`install-extension`
7. **生命周期**：离线标记、60s 清理、重连状态重取

### 建议新增/改动文件

```
新增：
  src/pi-web-ext/            或   src/terminal/
    server.ts                 bridge 侧监听 + 注册表 + 路由
    protocol.ts               上下行报文类型
    session.ts                TerminalSession 实现 AgentSession
    extension/pi-feishu.ts    扩展源码（随包分发）
  src/bridge/agent-session.ts AgentSession 接口 + PiWebSession 实现

改动：
  src/config.ts               kind 解析与校验（含缺省推断）
  src/index.ts                terminal bot 装配 + 监听启动
  src/bridge/bridge.ts        deps 增加 session 提供者；~17 处 this.client.X() 改走接口
  src/bridge/streamer.ts      支持 TerminalSession
  src/bridge/registry.ts      终端会话的存储（不复用 cwd 键）
  src/cli.ts                  install-extension 子命令
  src/feishu/cards.ts         /agents 卡片支持终端会话标签
```

### 被否决的备选

- **用 `pi --mode rpc` 替代 pi-web**：失去 TUI，且仍是「客户端启动子进程」，无法连入用户手动开的 pi
- **把终端会话塞进 cwd 归属体系**：破坏「一个 cwd 只属一个 bot」不变量，且归属歧义
- **抽象统一的 10 方法接口**：需伪造 `listProjects`/`createAgent` 语义
- **WebSocket 双向**：为一条通道引入新依赖与新范式，收益不足
- **事件补发（replay）**：需维护带序号的持久缓冲，断线场景收益低

## Testing Plan

```bash
npm run typecheck
npm run build
```

（仓库默认校验，由 setup-nightmanager 设定。`probe:*` 脚本因依赖外部 pi-web / 飞书服务被有意排除。）

本 spec 额外需要**人工验证**（无法自动化，因涉及真实飞书与终端会话）：

1. 启动 bridge 与一个终端 pi，在飞书 `/agents` 确认该会话可见
2. 飞书发消息 → 确认终端可见、卡片流式更新至结束
3. 制造审批场景（飞书发起）→ 确认终端与飞书同时出现、任一侧响应后另一侧消失
4. 制造审批场景（终端发起）→ 确认飞书不可见、不可代批
5. 关闭终端 → 确认 `/agents` 变离线、60s 后消失
6. 长任务中对比终端实际输出与卡片文本，验证 `text_delta` 无丢字

## Documentation Updates

- `README.md`：新增「终端感知机器人」小节；安装指引加 `install-extension`
- `docs/REQUIREMENTS.md`：新增日期章节记录本变更（含三类 bot 的可绑集合）
- `docs/FEISHU-BOT-SETUP.md`：补充终端模式的飞书侧配置（与现有 bot 相同的配置要求）
- `docs/USAGE.md`：`/agents`、`/switch`、`/last`、`/abort` 补充终端模式语义
- `AGENTS.md`：更新架构章节（新增入站监听、扩展分发、AgentSession 抽象）
- `CHANGELOG.md`：新版本条目

## Risks / Open Questions

### 已知风险

1. **无 token + localhost-only**：同机任意进程/用户可连入并驱动你的 pi —— 等同暴露终端 shell。已确认接受（网络侧被 localhost 挡住，同机侧不挡）。
2. **用户发起的回合卡在审批时**：用户不在则飞书**解不了**（不能代批），只能 `/abort`。这是决策 4 的既定代价。
3. **断线期间中间过程永久丢失**（只保最终结果）—— 决策 7 的既定取舍。
4. **`/agents` 行数膨胀**：多终端 + 多 pi-web 会话混排时列表变长，需靠状态与标签区分。
5. **扩展随包分发会把 TS 源码带入产物**：需确认不违反 npm 包内容约定（`files` 白名单已限制）。

### 已确认的默认值

以下四项已在评审中定稿，实现时直接采用：

| 项 | 值 |
|---|---|
| 发现文件路径 | `~/.pi-bridge/bridge.json` |
| 断线宽限期 | 60s |
| 上行批次周期 | 200ms |
| `kind` 命名 | `piweb-pool` / `piweb-scoped` / `pi-terminal`（缺省时按 `cwds` 推断，保持配置向后兼容） |