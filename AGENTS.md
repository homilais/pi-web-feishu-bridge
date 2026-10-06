# AGENTS.md

> 本文件为 AI 编码助手（Claude Code / Cursor / Copilot 等）提供项目上下文与开发指南。

## 项目概览

**pi-web-feishu-bridge** — 飞书 ↔ pi-web 桥接服务

将飞书消息路由到 pi-web 的编码 agent，支持流式输出、卡片交互、会话管理。

## 技术栈

- **运行时**: Node.js >= 22（ESM，TypeScript 5.9）
- **飞书 SDK**: `@larksuiteoapi/node-sdk` v1.59
- **配置**: YAML（`js-yaml`）多机器人配置；无 config 文件时回退 .env
- **pi-web API**: HTTP + SSE（Basic Auth，用户名固定 `pi`）
- **构建**: `tsc -p tsconfig.build.json` → `dist/`
- **开发**: `node --watch --env-file-if-exists=.env src/cli.ts`

## 目录结构

```
src/
├── cli.ts              # CLI 入口（--config/--init/--env/--cwd）
├── config.ts           # 配置解析（YAML 多机器人 + .env 回退 + 校验）
├── index.ts            # 启动入口（共享 client + 每机器人独立 channel/registry/bridge）
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

### 多机器人架构（v3）

配置见 `config.yaml`（`--init` 生成模板）。一个 cwd 只归属一个机器人（配置级独占）：

| 机器人类型 | cwds | 可绑范围 |
|---|---|---|
| 默认（≤1） | 空 | pi-web 全集 − 所有限定机器人声明的 cwd |
| 限定（≥0） | 1+ | 自身 cwds ∩ pi-web |

- 启动：`loadConfig` 解析 YAML + 严格校验（id/appId 唯一、默认≤1、cwd 不重复）
- 共享一个 `PiWebClient`；每机器人独立 `channel`/`registry`(`registry.<botId>.json`)/`bridge`
- **第三类** `pi-terminal`：可绑终端 pi 会话，与前两类严格隔离
- `Bridge.isCwdInScope()` 按配置级判断范围；`getProjects()` 仅返回本机器人可绑项目
- **终端接入**（`src/terminal/`）：pi 无入站端口，故扩展主动外连
  - `server.ts` 仅监听 `127.0.0.1`（无 token，同机可访问），写发现文件 `~/.pi-bridge/bridge.json`
  - 下行 SSE（prompt/abort/setModel/pullState/resolveApproval）+ 上行批量 POST（200ms 合并）
  - `merge.ts` 合并相邻 `text_delta`（追加语义，丢字即永久丢失）；其余事件不可丢
  - 扩展随包分发 + `install-extension`，版本与桥接永不错位
  - 审批闸门由扩展充当（pi 无内置审批），需 `PI_FEISHU_GATE=1` 显式开启
- `pruneOutOfScope()` 启动时清理范围外的旧绑定（配置变更后避免脏数据）
- `/info` 下拉按可绑集合过滤，前置卡死，避免选了不能绑

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

### 发版前：更新 CHANGELOG

`CHANGELOG.md` 按 [SemVer](https://semver.org/lang/zh-CN/) 维护，**顶部的 `[Unreleased]`/未发布段**累积本次要发的变更：

1. 把未发布内容归入新版本号与日期（`## [x.y.z] - YYYY-MM-DD`）
2. 分栏：新增 / 变更 / 修复 / 移除（**破坏性变更必须写进「移除/变更」并在 README 升级段说明**）
3. 定级：只修bug→`patch`；向后兼容新功能→`minor`；有破坏性→`0.x` 阶段进 `minor`，`1.0+` 进 `major`
4. 再跑 `./scripts/publish.sh <patch|minor|major>`

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

## 配置

主配置为 `config.yaml`（多机器人，`--init` 生成模板）。无 config 文件时回退到环境变量（单默认机器人，向后兼容）。YAML 中可用 `${PIWEB_PASSWORD}` 引用环境变量。

### YAML 字段（`config.yaml`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `piweb.baseUrl` | ❌ | 默认 `http://127.0.0.1:30141` |
| `piweb.password` | ✅ | Basic Auth 密码（可用 `${PIWEB_PASSWORD}` 插值） |
| `bots[].id` | ✅ | 机器人唯一 id（slug，用于 registry 文件命名） |
| `bots[].appId` / `appSecret` | ✅ | 飞书凭据（全局唯一） |
| `bots[].cwds` | ❌ | cwd 列表；空/缺省=默认机器人（最多 1 个） |
| `bots[].allowOpenIds` / `groupAllowlist` | ❌ | 私聊/群白名单 |

### 环境变量（回退用）

| 变量 | 必填 | 说明 |
|---|---|---|
| `PIWEB_PASSWORD` | ✅ | pi-web Basic Auth 密码 |
| `PIWEB_BASE_URL` | ❌ | pi-web 地址（默认 `http://127.0.0.1:30141`） |
| `LARK_APP_ID` | ✅ | 飞书应用 App ID（回退模式） |
| `LARK_APP_SECRET` | ✅ | 飞书应用 App Secret（回退模式） |
| `DEFAULT_MODEL` | ❌ | 默认模型（`provider/modelId`） |

## 服务重启（关键约束）

> **用户是通过本桥接与 AI 助手对话的** —— 助手的输出要经 pi-web → bridge → 飞书。
> 因此重启必须满足两条，否则通信直接中断、会话挂死：

1. **绝不允许前台阻塞启动**（如直接跑 `npm start` / `node dist/cli.js`）——桥接是常驻进程，命令永不返回，会卡死整个工具调用。
2. **停旧进程前必须先完成构建**，把断线窗口压到“停止→启动”几秒；构建失败则不碰旧进程。

用现成脚本（内部已做 `nohup` + `disown` + 就绪探测）：

```bash
npm run restart    # 构建 → 停旧 → 后台起 → 等“桥接已就绪”
npm run stop       # 只停
npm run logs       # 看 bridge.log 尾部
```

手写时的正确方式：

```bash
npm run build                                  # 先构建（旧进程仍服务）
pkill -f "dist/cli.js"; sleep 1                # 只精确匹配桥接
nohup node --env-file-if-exists=.env dist/cli.js >>bridge.log 2>&1 &
disown                                         # 脱离会话，不被 SIGHUP 带走
```

**绝对禁止的操乍**：`pkill node`、`pkill -f pi-web` 等宽匹配——pi-web（监听 30141）是**承载助手会话的进程**，杀了等于拆自己的线路，且不会自动恢复。

重启后若用户说“没收到回复”，让 TA 发 `/last` 取回本轮结果（会话在 pi-web 侧，不随 bridge 重启丢失）。

## 参考文档

- `docs/FEISHU-BOT-SETUP.md` — **飞书机器人注册与配置**（长连接订阅方式 / 事件 / 回调 / 权限 / 发布，接入必读）
- `learning/PIWEB-CAPABILITIES.md` — pi-web 完整 API 手册
- `learning/FEISHU-CHANNEL.md` — 飞书长连接与卡片协议
- `learning/VERIFIED.md` — 实测验证记录

## 注意事项

1. **禁止直接 `fetch`** — 所有 pi-web 调用通过 `client.ts`
2. **卡片必须 V2** — V1 schema 不触发回调
3. **飞书 SDK 类型宽松** — `as any` 是必要的
4. **ESM 导入** — 文件间用 `.js` 后缀（编译后路径）
5. **registry 持久化** — 修改后调用 `registry.persist()`
6. **禁止自动提交/发布** — 改完代码不要直接 `git commit` 或 `npm publish`，必须向用户申请，获得明确允许后才操作
7. **重启必须非阻塞** — 用户通过桥接与助手对话，改动需要重启时一律用 `npm run restart`（先构建、后台启动、不阻塞）；**切勿** `pkill node` / 杀 pi-web 进程
8. **飞书应用配置** — 新建 bot 接入必须按 `docs/FEISHU-BOT-SETUP.md` 逐项走完；最常见故障是「订阅方式未选长连接」和「改动未发布版本」，两者都表现为**连上但收不到任何消息**（日志无 `onMessage`）
