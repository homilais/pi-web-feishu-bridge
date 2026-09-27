# AGENTS.md

> 本文件为 AI 编码助手（Claude Code / Cursor / Copilot 等）提供项目上下文与开发指南。

## 项目概览

**pi-web-feishu-bridge** — 飞书 ↔ pi-web 桥接服务

将飞书消息路由到 pi-web 的编码 agent，支持流式输出、卡片交互、会话管理。

## 技术栈

- **运行时**: Node.js >= 22（ESM，TypeScript 5.9）
- **飞书 SDK**: `@larksuiteoapi/node-sdk` v1.59
- **pi-web API**: HTTP + SSE（Basic Auth，用户名固定 `pi`）
- **构建**: `tsc -p tsconfig.build.json` → `dist/`
- **开发**: `tsx watch src/cli.ts`（或 `node --watch --loader ts-node/esm`）

## 目录结构

```
src/
├── cli.ts              # CLI 入口（参数解析、env 加载）
├── config.ts           # 配置解析（.env、PROJECTS）
├── index.ts            # 启动入口（组合各模块）
├── log.ts              # 结构化日志
├── bridge/
│   ├── bridge.ts       # 核心桥接（消息路由、指令处理、卡片回调）
│   ├── registry.ts     # 会话绑定持久化（chatId↔cwd, agentId 缓存）
│   ├── queue.ts        # 消息队列（防并发）
│   ├── streamer.ts     # SSE 流式订阅 + 卡片更新
│   └── turn-state.ts   # Turn 状态机（idle/running/completed）
├── feishu/
│   └── cards.ts        # 飞书卡片模板（V2 schema）
├── piweb/
│   ├── client.ts       # pi-web HTTP/SSE 客户端封装
│   ├── events.ts       # SSE 订阅（自动重连 + 状态对齐）
│   └── types.ts        # 类型定义（ProjectInfo, AgentState, ...）
└── probes/             # 探针脚本（测试用）
```

## 核心流程

### 消息处理

```
飞书消息 → onMessage
  → 检查指令（/info /last /agents /model ...）
  → 非指令：enqueue(text)
    → ensureAgent(cwd)  // 查 registry → 查 pi-web → 创建
    → subscribeEvents(agentId)  // SSE 订阅
    → sendPrompt(agentId, text)  // 发送消息
    → onEvent: streamer 更新卡片
    → onEnd: 发送完成卡片
```

### Agent 管理

```
ensureAgent(cwd, chatId): Promise<agentId>
  1. registry.getAgent(cwd)  // 本地缓存
  2. listProjects() → 采纳活跃进程
  3. createAgent(cwd)  // POST /api/agent/new

resolveAgentId(cwd, chatId): Promise<{sid, running}>
  1. ensureAgent → 获取 sid
  2. getState(sid) → 验证有效
  3. 无效则 clearAgent + 重试
```

### SSE 流式

```
subscribeEvents(client, agentId, handlers)
  → client.sse(agentId, signal)  // GET /api/agent/[id]/events
  → 手动解析 SSE data 行
  → 断线重连（指数退避，最多 15s）
  → 重连后 getState 对齐状态
```

## pi-web 客户端封装

**所有 pi-web 交互必须通过 `src/piweb/client.ts`，禁止直接 `fetch`。**

| 方法 | 用途 |
|---|---|
| `getState(agentId)` | 获取 agent 状态（running/busy/model） |
| `getSessionContext(sid, tail?)` | 获取消息历史 |
| `getLiveProgress(sid, tail?)` | 获取实时进度（工作中） |
| `listProjects()` | 列出项目（含 running/hasAgent） |
| `createAgent(cwd, cmd?)` | 创建新 agent |
| `send(agentId, cmd)` | 发送消息给 agent |
| `sse(agentId, signal)` | SSE 订阅（返回 Response） |
| `getModels()` / `getModelsCached()` | 获取模型列表（带缓存） |

## 飞书卡片

- **必须使用 V2 schema**（`schema:"2.0"` + `behaviors:[{type:"callback",value}]`）
- 流式输出用 `stream()`，不能用 `editMessage` 模拟
- 所有卡片模板在 `src/feishu/cards.ts`

## 开发约定

### 命名

- 方法名：动词开头（`ensureAgent`, `resolveAgentId`, `sendContextSummary`）
- 私有方法：`private async`，无 `_` 前缀
- 类型：PascalCase，接口无 `I` 前缀

### 错误处理

- 网络错误：`catch(() => null)` 或 `catch(() => undefined)`，不中断流程
- 用户错误：`sendErr(chatId, msg)` 发送错误卡片
- 日志：`log.warn/error` 记录，不静默吞掉

### 日志

```typescript
log.info(`[module] 消息`, { key: value });  // 结构化
log.warn(`[module] 警告`, { e: String(e).slice(0, 100) });
log.error('异常', e);  // 完整错误
```

### 状态描述

| running | busy | 状态 |
|---|---|---|
| `true` | `true` | 🔴 运行中 |
| `true` | `false` | 🟢 空闲 |
| `false` | `false` | ⚪ 已回收 |

## 常见任务

### 添加新指令

1. 在 `bridge.ts` 的 `onCommand` 方法中添加 `case`
2. 如需卡片，在 `cards.ts` 添加模板
3. 测试：飞书发送指令

### 添加新卡片

1. 在 `cards.ts` 定义模板函数
2. 确保 `schema:"2.0"`
3. 在 `bridge.ts` 调用 `channel.send({ card: ... })`

### 添加新 client 方法

1. 在 `client.ts` 添加方法（使用 `this.req<T>()`）
2. 在 `types.ts` 添加类型定义
3. 更新 `learning/PIWEB-CAPABILITIES.md`

### 构建与测试

```bash
npm run build        # TypeScript 编译
npm run typecheck    # 类型检查（不输出）
npm start            # 启动服务
npm run probe:health # 健康检查探针
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PIWEB_PASSWORD` | ✅ | pi-web Basic Auth 密码 |
| `PIWEB_BASE_URL` | ❌ | pi-web 地址（默认 `http://127.0.0.1:30141`） |
| `LARK_APP_ID` | ✅ | 飞书应用 App ID |
| `LARK_APP_SECRET` | ✅ | 飞书应用 App Secret |
| `PROJECTS` | ❌ | 项目列表（`cwd:label,cwd:label`） |
| `DEFAULT_MODEL` | ❌ | 默认模型（`provider/modelId`） |

## 参考文档

- `learning/PIWEB-CAPABILITIES.md` — pi-web 完整 API 手册
- `learning/FEISHU-CHANNEL.md` — 飞书长连接与卡片协议
- `learning/VERIFIED.md` — 实测验证记录

## 注意事项

1. **禁止直接 `fetch`** — 所有 pi-web 调用通过 `client.ts`
2. **卡片必须 V2** — V1 schema 不触发回调
3. **飞书 SDK 类型宽松** — `as any` 是必要的
4. **ESM 导入** — 文件间用 `.js` 后缀（编译后路径）
5. **registry 持久化** — 修改后调用 `registry.persist()`
