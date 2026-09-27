# 实施指南（方案 2 · 外挂式飞书桥接 + Pi-Web）

> 已验证的接口事实见 [`../learning/VERIFIED.md`](../learning/VERIFIED.md)；方案设计见 [`../learning/plan-2-external-bridge.md`](../learning/plan-2-external-bridge.md)；pi-web 接口参考 [`../learning/PIWEB-CAPABILITIES.md`](../learning/PIWEB-CAPABILITIES.md)。

## 现状

| 模块 | 状态 |
|---|---|
| Pi-Web HTTP 客户端（鉴权/会话/SSE） | ✅ 实测通过 |
| SSE 事件解析（`agent_settled`/`message_update`/`extension_ui_request`） | ✅ 实测通过 |
| 翻译层（SSE → 飞书流式卡片 + 工具状态 + 审批按钮） | ✅ 实测通过 |
| 飞书 Channel（长连接/消息/卡片动作） | ✅ 实测通过 |
| 指令系统（/help /info /switch /model /last /agents /abort /release） | ✅ 实测通过 |
| 按项目复用 agent、回复卡片定向路由 | ✅ 实测通过 |
| 执行进展卡（`getLiveProgress` → `progressCard`） | ✅ 实测通过 |
| 飞书卡片 V2（`column_set`/`collapsible_panel`/`select_static`/`hr`/`header.subtitle`） | ✅ 实测通过 |
| TypeScript 类型检查 | ✅ `tsc --noEmit` 通过 |

> 全功能已落地并实测。下方是**从零复现**的步骤（假设没有 pi-web、没有飞书凭据）。

## 项目结构

```
pi-web-feishu-bridge/
├── src/
│   ├── index.ts              入口：装配 + 长驻
│   ├── config.ts             配置加载（env）
│   ├── log.ts
│   ├── piweb/
│   │   ├── types.ts           已核实的类型
│   │   ├── client.ts         HTTP 客户端（Basic Auth pi:<password>，含节流重试）
│   │   └── events.ts         fetch+手动解析的 SSE 订阅（自动重连+状态对齐）
│   ├── bridge/
│   │   ├── turn-state.ts     单轮状态机：消费 SSE 事件
│   │   ├── streamer.ts       核心：SSE → 飞书流式卡片
│   │   ├── bridge.ts         编排：消息路由/指令/审批
│   │   ├── registry.ts       飞书会话↔项目↔agent 绑定（持久化）
│   │   └── queue.ts          单 agent 串行队列 + 审批 pending 表
│   ├── feishu/
│   │   └── cards.ts          飞书卡片 V2 构建器
│   └── probes/
│       ├── probe-piweb.ts    ✅ 端到端验证 pi-web 侧（无需飞书）
│       └── probe-feishu.ts   验证飞书长连接+卡片按钮回调（需凭据+chatId）
├── docs/                      设计文档
└── package.json
```

## 1. 安装依赖

```bash
cd pi-web-feishu-bridge          # 本项目目录
npm install
# ⚠️ npm 11 默认跳过 install scripts；若要用 Pi-Web 的内置终端需另外批准
# （本桥接本身不依赖 node-pty，仅 Pi-Web 需要）
```

## 2. 启动 Pi-Web（基座）⭐ 前提

> **Pi-Web 是本项目的硬前提**：本项目不直接调用 pi SDK，全部会话操作走 pi-web 的 HTTP/SSE。
> 桥接启动时先探测 pi-web，**连不上会直接 `process.exit(1)`**，不会降级运行。
> 两者密码必须一致：pi-web 的 `PI_WEB_PASSWORD` = 桥接 `.env` 的 `PIWEB_PASSWORD`。

```bash
# 全局或临时目录安装 Pi-Web
npm install @agegr/pi-web@0.9.3   # 在某个目录
npm install-scripts approve @agegr/pi-web node-pty esbuild protobufjs
npm rebuild node-pty esbuild

# 启动（关键环境变量）
PI_WEB_PASSWORD=你的密码 \
PI_WEB_IDLE_TIMEOUT_MS=0 \
PI_WEB_NO_OPEN=1 \
PI_WEB_SKIP_VERSION_CHECK=1 \
node node_modules/@agegr/pi-web/bin/pi-web.js --no-open
# → 监听 127.0.0.1:30141
```

- `PI_WEB_IDLE_TIMEOUT_MS=0`：禁用空闲销毁（桥接常驻需多会话，否则 10 分钟后 session 被回收）。
- 想快速交接给终端：改设 `60000`（1 分钟）。
- 鉴权：API 用 HTTP Basic Auth，**用户名固定 `pi`**，密码 = `PI_WEB_PASSWORD`。

## 3. 配置 `.env`

```bash
cp .env.example .env
# 必填：
#   PIWEB_PASSWORD=<同上 Pi-Web 密码>
#   LARK_APP_ID / LARK_APP_SECRET=<见下一步>
# 可选：
#   LARK_ALLOW_OPEN_IDS=<飞书 open_id，逗号分隔；留空=允许所有单聊>
#   LARK_GROUP_ALLOWLIST=<群 chat_id（oc_ 开头），逗号分隔；留空=不允许群聊>

# 两个可选项的默认行为（推荐留空）：
#  · PROJECTS 留空 → 不限白名单，项目空间由 pi-web 的 /api/sessions 自动枚举
#  · DEFAULT_MODEL 留空 → 用 pi 自身默认模型，之后用 /info 下拉或 /model 切换
```

## 4. 飞书应用配置清单（逐项）

飞书开放平台 → 开发者后台 → **企业自建应用**：

1. **基础信息**：拿 App ID（`cli_` 开头）、App Secret。
2. **应用能力 → 机器人**：启用。
3. **事件订阅**：
   - 接收方式选 **「使用长连接接收事件」**（无需公网回调 URL）。
   - 订阅事件：
     - `im.message.receive_v1`（收消息）
     - `card.action.trigger`（卡片按钮回调）**← 审批/停止按钮必须**
4. **权限管理**（申请并发布版本后生效）：
   - `im:message`（读消息）
   - `im:message:send_as_bot`（发消息）
   - `im:resource`（下载图片/文件）
   - 可选 `im:message.group_msg`（群内免 @；默认群内需 @bot）
5. **版本管理与发布**：**每次改权限都要「创建版本并发布」**，否则权限不生效。
6. 拿到自己的 open_id：发任意消息给机器人，看后台日志或用 `getChatInfo`。

## 5. 验证

### 5.1 pi-web 侧（已能跑）

```bash
# 先确保 Pi-Web 已启动 + .env 配好 PIWEB_PASSWORD
npm run probe:piweb
# 期望：创建 agent → 发 prompt → 收到 message_update 流式 → agent_settled
```

> ⚠️ 已知：部分供应商/模型会间歇性返回空文本（触发 auto_retry）；正式跑之前先用小任务验证一下。
> 切模型可用 `/info` 下拉或 `/model <provider/modelId>`。

### 5.2 飞书侧（需凭据）

```bash
npm run probe:health          # 两端连通性：Pi-Web + 飞书凭据 + 桥接进程
LARK_TEST_CHAT_ID=oc_xxx npm run probe:feishu   # 长连接 + 卡片按钮回调
# → 给该会话发一张带按钮的测试卡片，点按钮看后台是否打印 cardAction
# 若收不到 cardAction：检查后台是否订阅了 card.action.trigger + 卡片是否 V2 schema
```

## 6. 启动桥接

```bash
node --env-file-if-exists=.env src/index.ts
# → 连接 Pi-Web → 连接飞书长连接 → 就绪
# 在飞书单聊里给机器人发消息：
#   /help     指令帮助卡
#   /info     项目 + 模型卡（下拉切换）
#   /last     最后回复 / 执行进展
#   /agents   会话列表卡
#   你好      直接下发任务（流式卡片回复）
#   点「停止」 abort 当前任务
#   回复任意卡片  定向到该卡片的项目/进程
```

## 7. 验证清单

| 项 | 状态 | 备注 |
|---|---|---|
| Basic Auth（用户名 `pi`） | ✅ | 实测 |
| `/api/agent/new` ensure_session | ✅ | 实测 |
| SSE `message_update`/`text_delta` 流式 | ✅ | 实测可收到完整文本增量 |
| `agent_settled` 完成判定 | ✅ | 实测 |
| 审批事件 → 卡片按钮 → `extension_ui_response` | ✅ | 全链路实测 |
| 飞书卡片 V2 `behaviors` 按钮回调 | ✅ | 实测（`switch`/`setmodel` 回调） |
| 卡片 V2 组件能力 | ✅ | 见 `../learning/VERIFIED.md`「飞书卡片 V2」 |
| 回复卡片定向路由 | ✅ | `replyToMessageId` → registry.routes |
| `/api/sessions/[id]/context` 执行中返回实时消息 | ✅ | `getLiveProgress` 数据源 |
| 会话释放给终端 | ✅ | `/release` 纯解绑；`/abort` 停任务 |

## 8. 运维

### 启停

```bash
npm start                          # 前台
nohup npm start > /tmp/bridge.log 2>&1 &   # 后台，日志重定向
kill <pid> | pkill -f "src/index\.ts"      # 优雅退出（SIGINT/SIGTERM）
```

### 状态检查

```bash
npm run probe:health        # 不启动桥接，单独诊断两端连通性
tail -f /tmp/bridge.log     # 看日志；「✅ 桥接已就绪」= 全部就绪
```

日志关键字与含义见 [`USAGE.md` §2](./USAGE.md)。

### 其他

- 开机自启：用 `launchd`（macOS）包一层 `npm start` + `caffeinate -dimsu`（防睡眠）。
- 单实例：飞书长连接同应用只能一个客户端（集群模式会丢事件），启动前先 `pkill` 或加 pidfile 锁。
