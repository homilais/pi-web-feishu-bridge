# pi-web-feishu-bridge

在**手机飞书**上像聊天一样给电脑里的 pi 编码 agent 下任务，pi 在本地干活，进度与结果通过**飞书流式卡片**实时推回手机。

> **前提**：[`@agegr/pi-web@0.9.3`](https://www.npmjs.com/package/@agegr/pi-web) 必须先安装并常驻运行。
> 本项目是**外挂式翻译层**——不直接操作 pi SDK，全部会话操作走 pi-web 的 HTTP/SSE；
> 连不上 pi-web 时桥接**直接退出**，不降级运行。

## 特性速览

- 🚫 **无需公网暴露**：飞书走 WebSocket **长连接出站**，桥接可跑在内网开发机
- 📱 **真流式**：卡片跟着 pi 打字机效果实时刷，工具调用状态、审批按钮一并呈现
- 🎯 **多项目并行**：一个飞书群同时指挥多个项目的 agent（跨项目并行、同项目串行）
- 🔗 **回复即路由**：在飞书里回复任意卡片 → 定向到该卡片所属的项目/进程
- 🧠 **多轮记忆**：与原生 `pi -c` 共享同一份 session 文件，可交替使用
- 🔄 **审批闭环**：pi 的 `extension_ui_request` 自动转飞书卡片按钮 → `extension_ui_response` 回执

## 架构

```
手机飞书
   ↕  WebSocket 长连接（出站，无需公网 IP / 端口映射）
飞书桥接（本项目，独立 Node 进程）
   ├─ 收飞书消息 / 卡片回调 → 指令路由 → 单会话串行队列
   └─ 翻译层：SSE 事件 → 飞书流式卡片
   ↕  HTTP + SSE（127.0.0.1，Basic Auth）
@agegr/pi-web（Next.js 网关，基座）
   ↕  进程内 SDK 调用
pi SDK（@earendil-works/pi-coding-agent）
   ↕  HTTP
模型供应商
```

三层职责分离：**pi-web** 是唯一的会话所有者；**桥接**只做协议翻译；**pi SDK** 在 pi-web 进程内运行 agent，与 `pi -c` 共享 session 文件。

## 快速上手

### 1. 启动 pi-web 基座（首次安装 + 常驻运行）

```bash
# 一次性安装（全局）
npm i -g @agegr/pi-web@0.9.3

# 常驻运行（后台常驻一定要加 --no-open，否则每次启动会弹浏览器）
PI_WEB_PASSWORD="你的密码" PI_WEB_IDLE_TIMEOUT_MS=0 \
  pi-web --no-open
# ↑ 默认端口 30141；需要自定义时用 --port <port>
# ↑ PI_WEB_IDLE_TIMEOUT_MS=0 防会话被自动回收，详见 docs/IMPLEMENTATION.md
```

### 2. 安装本桥接

```bash
cd pi-web-feishu-bridge
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

必填：`PIWEB_PASSWORD`、`LARK_APP_ID`、`LARK_APP_SECRET`。可选：`PIWEB_BASE_URL`、`DEFAULT_MODEL`、飞书白名单。完整说明见 [`.env.example`](./.env.example)。

### 4. 启动（两个独立终端）

> `npm start` **只启动本桥接**，**不会**启动 pi-web。连不上 pi-web 时桥接会直接退出（`process.exit(1)`）。

```bash
# 终端 A：起 pi-web 基座（命令同 §1，已跑过则跳过）
PI_WEB_PASSWORD="你的密码" PI_WEB_IDLE_TIMEOUT_MS=0 pi-web --no-open

# 终端 B：起桥接（依赖终端 A 已就绪）
cd pi-web-feishu-bridge
npm start                 # 生产启动
npm run typecheck         # 类型检查（不用跑，纯开发时用）
```

成功标志：桥接日志出现 `Pi-Web 连接正常，运行中 agent N 个` 与 `✅ 桥接已就绪`。

### 5. 验证

```bash
npm run probe:piweb     # 验证 pi-web 侧（无需飞书凭据）
npm run probe:feishu    # 验证飞书长连接 + 卡片按钮回调
npm run probe:health    # 端到端健康检查
```

## 指令一览

| 指令 | 说明 |
|---|---|
| `/help` | 指令帮助 |
| `/info` | 项目 + 模型下拉切换（**最常用**） |
| `/switch <项目>` | 切换项目（支持 cwd / 名称） |
| `/model <provider>/<modelId>` | 直接切模型 |
| `/last` | 空闲 = 最后回复；**执行中 = 实时进展快照** |
| `/agents` | 会话列表（点击切换；已回收自动解绑） |
| `/abort` | 停止当前任务（保留绑定） |
| `/release` | 纯解绑（**不打断任务**） |
| 直接发消息 | 下发任务（流式卡片回复） |
| **回复任意卡片** | 定向到该卡片的项目/进程 |

更多场景与排错见 [`docs/USAGE.md`](./docs/USAGE.md)。

## 目录导航

```
.
├── README.md          ← 本文件（入口）
├── docs/              📖 实现文档：设计 / 使用 / 部署
│   ├── README.md         项目介绍、架构、功能清单、代码结构、设计决策
│   ├── USAGE.md          使用手册（指令 / 卡片 / 场景 / 排错）
│   └── IMPLEMENTATION.md 安装、配置、运行、验证、运维
├── learning/          📚 调研与选型资料（本地保留，不入 git）
│   ├── EVALUATION.md        三方案对齐 P0 打分 + 关键发现
│   ├── PIWEB-CAPABILITIES.md pi-web 完整能力手册
│   ├── VERIFIED.md          pi-web 接口实测核实记录
│   ├── FEISHU-CHANNEL.md    飞书长连接与卡片 V2 手册
│   ├── PIWEB-ON-PHONE.md    手机直访 pi-web 的 5 种方案
│   └── plan-*.md            三份候选方案原始设计
├── src/               🛠 源码（bridge / feishu / piweb / probes）
├── .env.example       配置模板
└── package.json
```

## 依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| [`@larksuiteoapi/node-sdk`](https://www.npmjs.com/package/@larksuiteoapi/node-sdk) | ^1.74.0 | 飞书 SDK（含 `createLarkChannel`，长连接 / 流式卡片 / 按钮回调全内置） |
| [`@agegr/pi-web`](https://www.npmjs.com/package/@agegr/pi-web) | 0.9.3 | **基座**，单独安装运行（不在本项目依赖里） |
| [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) | — | pi SDK，pi-web 自带，桥接不直接依赖 |
| Node.js | ≥ 22.19 | 实测 Node 26.8.2；直接用 type stripping 跑 `.ts` |

## 设计原则（关键决策摘要）

1. **会话所有权只在 pi-web** —— 桥接不直接操作 pi SDK，避免「两个进程同时写一份 session 文件」。代价是多一层本地 HTTP 转发（毫秒级）。
2. **完成通知挂 `agent_settled`** —— 而非 `agent_end`：`agent_end` 之后可能还有 auto_retry / 上下文压缩 / 队列消息，`agent_settled` 才是真正彻底空闲。
3. **飞书侧用官方 `createLarkChannel()`** —— 长连接、流式卡片、按钮回调、白名单、去重、分片、重试全部内置，不自搓飞书协议。
4. **执行进展不用 SSE** —— `GET /api/sessions/[id]/context` 在**执行中**就返回实时消息（流式文本 / toolCall / toolResult），轮询即可拼装进展快照。
5. **卡片优先于文本** —— 含结构化信息或需要用户操作的回复一律走卡片；纯状态回执（≤1 行）保持文本。

完整决策及理由见 [`docs/README.md`](./docs/README.md) 与 [`learning/EVALUATION.md`](./learning/EVALUATION.md)。

## License

个人本地项目。
