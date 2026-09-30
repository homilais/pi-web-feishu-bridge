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

> 两种使用方式：
> - **📦 npm 安装运行**（推荐，普通用户）：3 分钟跑起来
> - **💻 从源码开发**（开发者）：改代码 / 跑探针 / 开发新功能

---

## 🔺 从 0.1.x 升级到 0.2.0（升级前必读）

0.2.0 引入**多机器人配置**，配置入口从 `.env` 改为 `config.yaml`。完整变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

### 先确认：你会不会受影响

| 你的现状 | 升级后 |
|---|---|
| 只用 `.env` 配了单个飞书机器人，**没用** `PROJECTS` | ✅ 无影响，自动回退为单默认机器人，行为与 0.1.x 一致 |
| 用了 `PROJECTS=cwd:label,...` 限制项目范围 | ⚠️ **该变量已废弃**，需迁到 `config.yaml` |
| 想要多机器人按项目隔离 | ✅ 正是本版新增能力 |

### 3 项破坏性变更

1. **`PROJECTS` 环境变量废弃** — 项目来源改为：pi-web 枚举（默认机器人=全集）或 `config.yaml` 的 `bots[].cwds`（限定机器人）
2. **`--init` 产出文件变了** — 从生成 `.env` 改为生成 `config.yaml`（带注释模板）
3. **registry 文件命名变了** — `registry.json` → `registry.<botId>.json`（已做自动迁移，见下）

> 另外 `AppConfig` 的 `lark` / `projects` 字段已移除，仅影响把本项目当库引用的场景。

### 升级步骤

```bash
# 1. 装新版（0.x 的 minor 升级不会被 npm update 自动带上，需显式指定）
npm i -g pi-web-feishu-bridge@0.2.0 --registry=https://registry.npmjs.org/

# 2. 进工作目录
cd ~/pi-bridge

# 3a. 之前没用过 PROJECTS：什么都不用改，直接启动（自动回退单默认机器人）
pi-web-feishu-bridge

# 3b. 要用多机器人 / 或曾用过 PROJECTS：生成配置并填写
pi-web-feishu-bridge --init     # 生成 config.yaml
$EDITOR config.yaml             # 填 appId / appSecret / cwds
PIWEB_PASSWORD=xxx pi-web-feishu-bridge
```

### 会话绑定不会丢

默认机器人首次启动会自动把旧数据迁移过去，日志会打印：

```
[bot=default] 从旧 registry.json 迁移到 .../registry.default.json
```

已绑定过的项目**不需要重新选择**；旧 `registry.json` 保留不动，随时可回退。

### ⚠️ 注意：把项目划给限定机器人会解绑它

如果你把某个正在使用的项目声明给了**限定机器人**，默认机器人会在启动时清理掉它的绑定（日志：`pruneOutOfScope 清理 N 个范围外绑定`）。之后需要在**那个限定机器人**里发 `/info` 重新选择该项目 —— 历史消息不会丢（会从 pi-web 会话自动找回）。

### 飞书侧别忘了配置新机器人

新增限定机器人时，它在飞书开发者后台是一个**独立应用**，必须单独配好「长连接订阅方式 + 事件 + 回调 + 权限 + 发布版本」，否则会出现**连上了但发消息毫无反应**。
逐项步骤与排错表见 **[docs/FEISHU-BOT-SETUP.md](./docs/FEISHU-BOT-SETUP.md)**。

---

### 📦 从 npm 安装运行（推荐）

#### 1. 安装 pi-web 基座

```bash
# 全局安装 pi-web（一次性）
npm i -g @agegr/pi-web@0.9.3

# 常驻运行（后台服务，需先于桥接启动）
PI_WEB_PASSWORD="你的密码" PI_WEB_IDLE_TIMEOUT_MS=0 \
  pi-web --no-open
# ↑ 默认端口 30141；自定义用 --port <port>
# ↑ PI_WEB_IDLE_TIMEOUT_MS=0 防会话被自动回收，详见 docs/IMPLEMENTATION.md
```

#### 2. 安装桥接并初始化

```bash
# 全局安装桥接
npm i -g pi-web-feishu-bridge

# 验证安装
pi-web-feishu-bridge --version
pi-web-feishu-bridge --help
```

#### 3. 在飞书开放平台创建机器人

本桥接靠飞书 **WebSocket 长连接** 收消息与卡片回调，因此应用必须在开发者后台配好。最小必需项：

1. 创建**企业自建应用**，并添加**机器人**能力
2. 事件与回调 → **订阅方式选「使用长连接」**（⚠️ 默认是「开发者服务器」，不改会**连上但收不到任何消息**）
3. 添加事件 `im.message.receive_v1`、回调 `card.action.trigger`
4. 权限管理开通 `im:message`（按需加 `im:chat` 等）
5. **创建版本 → 发布**（⚠️ 上述改动不发布全都不生效）

完整逐项说明、权限清单与故障排查表见 **[docs/FEISHU-BOT-SETUP.md](./docs/FEISHU-BOT-SETUP.md)**。

> 要多机器人按项目隔离时，**每个机器人 = 一个独立飞书应用**，上述步骤逐个走完。

#### 4. 配置

```bash
# 建立工作目录（config.yaml 与 registry.*.json 都写在这里）
mkdir -p ~/pi-bridge && cd ~/pi-bridge

# 生成 config.yaml 模板
pi-web-feishu-bridge --init

# 编辑填飞书凭据与项目路径
$EDITOR config.yaml
```

`config.yaml` 最小配置（单机器人，向后兼容也支持只配 `.env`）：

```yaml
piweb:
  baseUrl: http://127.0.0.1:30141
  password: ${PIWEB_PASSWORD}   # 引用环境变量，避免明文

bots:
  - id: default          # 默认机器人，可绑 pi-web 所有项目
    appId: cli_xxx
    appSecret: yyy
```

> 密码用 `${PIWEB_PASSWORD}` 引用环境变量：启动前 `export PIWEB_PASSWORD=你的密码`，或写进同目录 `.env`。
>
> 需要多个机器人按项目隔离时，在 `bots:` 下追加带 `cwds:` 的限定机器人（见 `docs/REQUIREMENTS.md` §9）。**一个 cwd 只能归属一个机器人。**

#### 5. 启动

```bash
# 终端 A：确认 pi-web 在跑（见 §1）

# 终端 B：启动桥接
cd ~/pi-bridge
PIWEB_PASSWORD=你的密码 pi-web-feishu-bridge
```

成功标志：日志出现 `Pi-Web 连接正常，运行中 agent N 个` 与 `✅ 桥接已就绪`。

#### 6. 常用操作

```bash
pi-web-feishu-bridge --config /path/to/config.yaml   # 指定配置文件
pi-web-feishu-bridge --env /path/to/.env             # 指定 .env（供 ${PIWEB_PASSWORD} 等插值）
pi-web-feishu-bridge --cwd /some/dir                 # 切目录后启动
```

---

### 💻 从源码开发

#### 1. 克隆仓库

```bash
git clone https://github.com/homilais/pi-web-feishu-bridge
cd pi-web-feishu-bridge
```

#### 2. 安装依赖

```bash
npm install
```

#### 3. 配置

```bash
# 生成 config.yaml 模板（多机器人配置）
node src/cli.ts --init
$EDITOR config.yaml
# pi-web 密码可写进 .env（供 ${PIWEB_PASSWORD} 插值）
cp .env.example .env && $EDITOR .env
```

#### 4. 启动（两个独立终端）

> `npm start` **只启动本桥接**，**不会**启动 pi-web。连不上 pi-web 时桥接会直接退出（`process.exit(1)`）。

```bash
# 终端 A：起 pi-web 基座（命令同 §1，已跑过则跳过）
PI_WEB_PASSWORD="你的密码" PI_WEB_IDLE_TIMEOUT_MS=0 pi-web --no-open

# 终端 B：起桥接（依赖终端 A 已就绪）
cd pi-web-feishu-bridge
npm run dev                 # 开发模式（watch 热重载，直接跑 .ts）
npm run typecheck           # 类型检查
npm run build               # 编译到 dist/
```

#### 5. 验证探针

```bash
npm run probe:piweb     # 验证 pi-web 侧（无需飞书凭据）
npm run probe:feishu    # 验证飞书长连接 + 卡片按钮回调
npm run probe:health    # 端到端健康检查
```

#### 6. 发布到 npm

```bash
npm login                      # 首次需登录
./scripts/publish.sh dry-run   # 演练
./scripts/publish.sh patch     # 发布
```

详见 [docs/PUBLISH.md](./docs/PUBLISH.md)。


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
├── CHANGELOG.md       📋 版本变更记录（SemVer，含升级注意）
├── docs/              📖 实现文档：设计 / 使用 / 部署
│   ├── README.md         项目介绍、架构、功能清单、代码结构、设计决策
│   ├── FEISHU-BOT-SETUP.md 飞书机器人注册与配置（长连接/事件/权限/发布）
│   ├── USAGE.md          使用手册（指令 / 卡片 / 场景 / 排错）
│   ├── REQUIREMENTS.md   需求文档（含多机器人配置 §9）
│   ├── DESIGN.md         详细设计与实现核对
│   └── IMPLEMENTATION.md 安装、配置、运行、验证、运维
├── learning/          📚 调研与选型资料（本地保留，不入 git）
│   ├── EVALUATION.md        三方案对齐 P0 打分 + 关键发现
│   ├── PIWEB-CAPABILITIES.md pi-web 完整能力手册
│   ├── VERIFIED.md          pi-web 接口实测核实记录
│   ├── FEISHU-CHANNEL.md    飞书长连接与卡片 V2 手册
│   ├── PIWEB-ON-PHONE.md    手机直访 pi-web 的 5 种方案
│   └── plan-*.md            三份候选方案原始设计
├── src/               🛠 源码（bridge / feishu / piweb / probes）
├── .env.example       环境变量模板（PIWEB_PASSWORD 等）
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
