# 详细设计文档

> 基于需求文档 (`docs/REQUIREMENTS.md`) 编写，描述桥接服务的架构设计与实现细节。

---

## 一、架构概览

```
飞书消息
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    Bridge (bridge.ts)                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  onMessage   │  │  onCommand   │  │  onCardAction       │  │
│  │  消息路由    │  │  指令处理    │  │  卡片回调           │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│  ┌──────▼────────────────▼─────────────────────▼──────────┐  │
│  │                    Registry (registry.ts)                │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐ │  │
│  │  │  chats      │  │  agents     │  │  routes        │ │  │
│  │  │  chatId→cwd │  │  cwd→agentId│  │  msgId→cwd/sid │ │  │
│  │  └─────────────┘  └─────────────┘  └────────────────┘ │  │
│  │              持久化存储，重启后保留                       │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    Client (client.ts)                    │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌────────────────┐ │  │
│  │  │  HTTP APIs  │  │  SSE        │  │  Models        │ │  │
│  │  │  get/create │  │  流式订阅   │  │  缓存 60s      │ │  │
│  │  └─────────────┘  └─────────────┘  └────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
    │                        │                        │
    ▼                        ▼                        ▼
pi-web API              pi-web SSE              pi-web Models
```

---

## 二、核心模块设计

### 2.1 Registry (registry.ts)

**职责**：维护会话绑定关系与 agent 集合的持久化存储

**数据结构**：
```typescript
interface StoredState {
  version: 2;
  chats: Record<chatId, { chatId, cwd, createdAt }>;      // 会话 ↔ 项目
  agents: Record<cwd, { agentId, cwd }>;                   // 项目 ↔ agent
  routes: Record<messageId, { cwd, agentId, at }>;        // 卡片 → agent 路由
}
```

**关键方法**：

| 方法 | 用途 | 需求映射 |
|---|---|---|
| `bindProject(chatId, cwd)` | 绑定会话到项目 | 2.1 Agent 绑定 |
| `unbindChat(chatId)` | 解绑会话 | 3.7 /release |
| `projectOf(chatId)` | 查询会话绑定的项目 | 2.1 Agent 绑定 |
| `getAgent(cwd)` | 查询项目对应的 agent | 2.2 Agent 列表 |
| `setAgent(cwd, agentId)` | 设置项目的 agent | 2.1 Agent 绑定 |
| `adoptAgent(cwd, agentId)` | 采纳已有 agent | 2.4 Agent 生命周期 |
| `clearAgent(cwd)` | 清除项目的 agent | 2.3 状态同步 |
| `agentEntries()` | 列出所有 agent | 3.4 /agents |
| `routeFor(messageId)` | 查询卡片路由 | 2.5 路由记忆 |
| `rememberRoute(msgId, cwd, sid)` | 记录卡片路由 | 2.5 路由记忆 |

**持久化策略**：每次修改立即写入 `registry.json`

---

### 2.2 Client (client.ts)

**职责**：封装所有 pi-web HTTP/SSE 交互

**设计原则**：
1. **禁止直接 `fetch`** — 所有调用通过 `client.ts`
2. **统一鉴权** — 使用 Basic Auth（`pi:<password>`）
3. **节流重试** — 429 错误自动指数退避重试
4. **缓存** — 模型列表 60s 缓存

**方法清单**：

| 方法 | 用途 | 需求映射 |
|---|---|---|
| `listProjects()` | 列出项目（含状态） | 2.2 Agent 列表 |
| `getState(agentId)` | 获取 agent 状态 | 2.3 状态同步 |
| `getSessionContext(sid, tail)` | 获取消息历史 | 3.5 /last |
| `getLiveProgress(sid, tail)` | 获取实时进度 | 3.5 /last |
| `createAgent(cwd, cmd)` | 创建新 agent | 2.4 Agent 生命周期 |
| `send(agentId, cmd)` | 发送消息给 agent | 五 消息处理 |
| `sse(agentId, signal)` | SSE 订阅 | 一 流式输出 |
| `getModels()` / `getModelsCached()` | 获取模型列表 | 3.8 /model |

---

### 2.3 Bridge (bridge.ts)

**职责**：核心业务逻辑，协调消息路由、指令处理、卡片回调

**关键方法**：

| 方法 | 用途 | 需求映射 |
|---|---|---|
| `onMessage(msg)` | 处理入站消息 | 五 消息处理 |
| `onCommand(msg, text)` | 处理指令 | 三 指令列表 |
| `onCardAction(evt)` | 处理卡片回调 | 四 卡片交互 |
| `ensureAgent(cwd, chatId)` | 确保 agent 存在 | 2.4 Agent 生命周期 |
| `resolveAgentId(cwd, chatId)` | 获取 sid + running | 2.3 状态同步 |
| `pruneDeadAgents()` | 清理无效 agent | 2.3 状态同步 |
| `sendContextSummary(chatId)` | 发送上下文摘要 | 3.2 /info |

---

### 2.4 Cards (cards.ts)

**职责**：飞书卡片模板定义

**卡片类型**：

| 卡片 | 用途 | 需求映射 |
|---|---|---|
| `statusCard` | 项目状态 + 选择器 | 3.2 /info |
| `agentsCard` | agent 列表 | 3.4 /agents |
| `progressCard` | 实时进展 | 3.5 /last |
| `lastReplyCard` | 最后回复 | 3.5 /last |
| `helpCard` | 帮助信息 | 3.1 /help |
| `confirmCard` | 确认提示 | 四 卡片交互 |

---

## 三、需求实现核对

### 3.1 会话 Agent 管理

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 每个会话绑定到一个项目 | ✅ 已实现 | `registry.bindProject(chatId, cwd)` |
| 每个项目对应一个 agent | ✅ 已实现 | `registry.agents` 按 cwd 索引 |
| agentId 来自 pi-web | ⚠️ 需调整 | 当前 `ensureAgent` 会创建新 agent，应改为只采纳已有 |
| 持久化存储 | ✅ 已实现 | `registry.json` 文件 |
| 未绑定 cwd 时引导绑定 | ✅ 已实现 | `onMessage` 发送 info 卡片 |
| 记录所有绑定过的 agent | ✅ 已实现 | `registry.agents` 持久化 |

**问题**：`ensureAgent` 当前会创建新 agent，但需求要求"所有的 agentId 都来自 pi-web，不允许自动生成"。需要修改 `ensureAgent` 只采纳已有 agent，不创建新 agent。

---

### 3.2 指令实现核对

#### `/info`

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 显示当前 Agent 信息 | ✅ 已实现 | `statusCard` 显示项目名称、模型、状态 |
| 项目列表下拉选择 | ✅ 已实现 | `statusCard` 的 `select_static` 组件 |
| 展示项目名称:是否有被会话管理 | ⚠️ 需调整 | 当前不显示是否被会话管理 |
| 模型列表下拉选择 | ✅ 已实现 | `statusCard` 的 `select_static` 组件 |
| 空白项代表 pi-web 现有 model | ❌ 未实现 | 当前无空白项 |
| 未绑定项目时不展示模型列表 | ❌ 未实现 | 当前总是展示模型列表 |

**问题**：
1. 项目列表未显示"是否有被会话管理"标记
2. 模型列表无空白项
3. 未绑定项目时未隐藏模型列表

#### `/switch <project>`

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 先判断是否已在会话管理中 | ❌ 未实现 | 当前不检查，直接绑定 |
| 在会话管理中 → 直接绑定 | ❌ 未实现 | 当前不区分 |
| 不在会话管理中 → 寻找 agentId 纳入 | ⚠️ 部分实现 | 当前会创建新 agent，需求是只采纳已有 |
| 优先 running，然后非 running | ⚠️ 部分实现 | 当前只采纳 running，不找非 running 历史 session |
| 只允许绑定一个 | ✅ 已实现 | 每个 cwd 只存一个 agentId |
| 未找到 → 更新项目列表让重新选择 | ❌ 未实现 | 当前发送 info 卡片提示 |
| 找到 → 纳入会话管理 + 绑定 + 回复 last | ⚠️ 部分实现 | 当前不发送 last 卡片 |

**问题**：
1. 未区分"已在会话管理中"和"不在会话管理中"
2. 不寻找非 running 的历史 session
3. 未找到时未更新项目列表
4. 找到时未发送 last 卡片

#### `/agents`

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 列出所有纳入会话管理的 agent | ✅ 已实现 | `registry.agentEntries()` |
| 用户可以点击触发 `/switch` | ✅ 已实现 | 卡片按钮 |
| 显示项目名称、状态 | ✅ 已实现 | `agentsCard` |
| 已回收 agent 应该显示 | ✅ 已实现 | `pruneDeadAgents` 不清理已回收 |
| 无效 agent 不显示 | ✅ 已实现 | `pruneDeadAgents` 清理无效 |

#### `/last`

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 未绑定项目 → info 卡片提示 | ✅ 已实现 | 发送 info 卡片 |
| 工作中 → 实时进展卡片 | ✅ 已实现 | `progressCard` |
| 空闲 → 最后回复卡片 | ✅ 已实现 | `lastReplyCard` |

#### `/abort`

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 无参时使用当前绑定的 agentId | ✅ 已实现 | `registry.projectOf(chatId)` → `getAgent(cwd)` |
| 无 agent → "已经移除的 Agent" | ❌ 未实现 | 当前显示"当前无活跃 agent" |
| 大任务卡片点击终止触发 | ✅ 已实现 | 卡片按钮 |

#### `/release`

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 解绑 chat 与项目 agent 绑定 | ✅ 已实现 | `unbindChat` + `clearAgent` |
| 从会话管理中移除 agent | ✅ 已实现 | `clearAgent(cwd)` |
| 旧卡片回复不允许发送 | ❌ 未实现 | 当前路由仍保留 |
| 提示用 info 卡片绑定 | ✅ 已实现 | 发送 info 卡片 |

**问题**：旧卡片回复仍允许发送，需求要求"由于不在会话管理集合中，将不允许发送"。

#### `/model`

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 格式错误 → 提示格式 | ✅ 已实现 | 回复"格式：/model provider/modelId" |
| 无 agent → "已经移除的 Agent" | ❌ 未实现 | 当前显示"请先下发一条消息以创建 agent" |
| 有 agent → 切换模型 | ✅ 已实现 | `client.setModel` |

---

### 3.3 卡片交互核对

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 项目选择触发 `/switch` | ✅ 已实现 | 卡片回调 |
| 模型选择触发 `/model` | ✅ 已实现 | 卡片回调 |
| 中止触发 `/abort` | ✅ 已实现 | 卡片回调 |

---

### 3.4 消息处理核对

| 需求 | 实现状态 | 说明 |
|---|---|---|
| 未绑定项目 → info 卡片提示 | ✅ 已实现 | 发送 info 卡片 |
| 执行中 → 提示等待 | ✅ 已实现 | 回复"请等待当前任务完成" |
| 空闲 → 执行任务 | ✅ 已实现 | 流式更新卡片 |
| 回复卡片 → 路由到对应 agent | ✅ 已实现 | `registry.routeFor` |

---

## 四、待调整事项

### 4.1 必须调整

1. **`ensureAgent` 不创建新 agent**
   - 当前：registry 无记录 → 采纳 running → 创建新 agent
   - 需求：registry 无记录 → 只采纳已有（running 或非 running）→ 不创建新 agent
   - 影响：`/switch`、消息处理流程

2. **`/switch` 区分"已在会话管理中"和"不在会话管理中"**
   - 当前：不区分，直接绑定
   - 需求：已在 → 直接绑定；不在 → 寻找已有 agentId 纳入

3. **`/switch` 寻找非 running 的历史 session**
   - 当前：只采纳 running
   - 需求：优先 running，然后非 running 的历史 session

4. **`/release` 清理路由记录**
   - 当前：路由保留，旧卡片仍可回复
   - 需求：路由清理，旧卡片回复提示重新绑定

5. **`/info` 项目列表显示"是否有被会话管理"**
   - 当前：不显示
   - 需求：展示"项目名称:是否有被会话管理"

6. **`/info` 模型列表条件显示**
   - 当前：总是显示
   - 需求：未绑定项目时不展示模型列表

7. **`/info` 模型列表空白项**
   - 当前：无空白项
   - 需求：留空白项代表 pi-web 现有 model

### 4.2 建议调整

1. **`/abort` 和 `/model` 的无 agent 提示**
   - 当前：显示"当前无活跃 agent" / "请先下发一条消息以创建 agent"
   - 需求：显示"已经移除的 Agent"

2. **`/switch` 未找到时更新项目列表**
   - 当前：发送 info 卡片提示
   - 需求：更新项目列表让重新选择

3. **`/switch` 找到时发送 last 卡片**
   - 当前：发送 status 卡片
   - 需求：发送 last 卡片便于理解上下文

---

## 五、架构改进建议

### 5.1 Registry 增强

**当前问题**：
- 只有 `agents` 记录 cwd→agentId 映射
- 没有记录 agent 的额外信息（model, lastActive 等）

**建议**：
```typescript
interface ProjectAgent {
  agentId: string;
  cwd: string;
  model?: string;        // 当前模型
  lastActive: number;    // 最后活跃时间
  firstBound: number;    // 首次绑定时间
}
```

### 5.2 Agent 寻找策略重构

**当前问题**：
- `ensureAgent` 混合了"查找"和"创建"职责
- 不区分"已在会话管理中"和"不在会话管理中"

**建议**：
```typescript
// 查找已有 agent（不创建）
async findExistingAgent(cwd: string): Promise<{ agentId: string; running: boolean } | undefined> {
  // 1. 查 registry
  // 2. 查 pi-web running
  // 3. 查 pi-web 历史 session（非 running）
  // 返回 undefined 表示未找到
}

// 确保 agent 存在（可能创建）
async ensureAgent(cwd: string, chatId: string): Promise<string | undefined> {
  // 1. findExistingAgent
  // 2. 未找到 → 创建新 agent（仅消息处理流程使用）
}
```

### 5.3 路由记忆清理

**当前问题**：
- `/release` 不清理路由记录
- 旧卡片仍可回复

**建议**：
```typescript
// 从 registry 清理指定 agent 的所有路由
clearRoutesByAgent(agentId: string): void {
  for (const [msgId, route] of this.routes) {
    if (route.agentId === agentId) {
      this.routes.delete(msgId);
    }
  }
  this.persist();
}
```

---

## 六、参考

- `docs/REQUIREMENTS.md` — 需求文档
- `src/bridge/bridge.ts` — 指令处理实现
- `src/bridge/registry.ts` — 会话绑定与 agent 持久化
- `src/feishu/cards.ts` — 卡片模板
- `src/piweb/client.ts` — pi-web 客户端封装
