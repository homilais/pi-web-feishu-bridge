# 更新日志（Changelog）

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)（SemVer `主.次.修`）。

> ⚠️ 版本处于 `0.x` 阶段：按 SemVer 约定，**`0.x` 不保证兼容性，`minor` 升级即可能包含破坏性变更**。
> 因此 `0.1.x → 0.2.x` 不会被 `npm update` 自动带上，需要显式指定版本安装。

---

## [Unreleased]

### 变更（Changed）

- **`/last` 在任务执行中改为持续更新**：不再只给一次性快照，而是挂接一条 SSE 订阅，用流式卡片实时更新进展直到任务结束（或 10 分钟安全上限）
  - 若本会话已有正在流式的任务卡，不重复建卡，只提示去那张卡看
  - 卡片初始用 `getLiveProgress` 快照预填，不出现空白期
  - 并发安全：pi-web 的 SSE 端点支持同一 session 多订阅（已实测）
- `progressCard` 文案修正：不再笼统声称「完成后结果会自动推送」，改为「本卡为快照；再发 `/last` 可重新拉取」

---

## [0.2.0] - 2026-10-05

**主题：多机器人配置（按 cwd 隔离）** —— 含 3 项破坏性变更，升级前请先读 [README 的「从 0.1.x 升级」](../README.md#-从-01x-升级到-020升级前必读)。

### 新增（Added）

- **多飞书机器人**：引入 `config.yaml`（YAML，依赖 `js-yaml`），一个桥接进程可同时服务多个飞书应用，每个机器人按配置限定可绑定的项目（cwd）
  - **默认机器人**（不写 `cwds`，最多 1 个、可不配）：可绑 pi-web 全集 **减去** 所有限定机器人声明的 cwd
  - **限定机器人**（写 `cwds`）：可绑 = 自身 `cwds` **∩** pi-web 当前已有项目
- **cwd 配置级独占**：一个 cwd 只归属一个机器人；两个机器人声明同一 cwd 会在**启动时报错退出**（fail fast，不做隐式抢占）
- **`/info` 下拉前置过滤**：绑定限制直接在项目下拉列表卡死，只显示本机器人可绑项目；`/switch`、`/agents`、`/last` 同样只看本机器人范围
- **registry 按机器人隔离**：每机器人独立文件 `registry.<botId>.json`（会话绑定、agent 缓存、消息路由互不干扰）；多个机器人在同一个群里可各自独立工作
- **旧 registry 自动迁移**：默认机器人首次启动时，若 `registry.<botId>.json` 不存在而 `registry.json` 存在，自动迁移
- **启动清理越界绑定**：`pruneOutOfScope()` 剔除因配置变更而不属于本机器人的旧绑定，避免 `/agents` 出现脏数据
- **`${ENV_VAR}` 插值**：`config.yaml` 中可用 `${PIWEB_PASSWORD}` 引用环境变量，密钥不必写进配置文件
- **CLI**：新增 `--config <path>`；`--init` 改为生成带注释的 `config.yaml` 模板；指定 `--config` 时仍自动加载 `.env` 供插值
- **文档**：新增 [`docs/FEISHU-BOT-SETUP.md`](./docs/FEISHU-BOT-SETUP.md) —— 飞书机器人注册与配置全流程（机器人能力、**长连接订阅方式**、事件 `im.message.receive_v1`、回调 `card.action.trigger`、权限、可用范围、**创建版本并发布**），附 15 条「症状 → 原因」排错表
- **运维脚本**：`scripts/restart.sh` 与 `npm run restart` / `stop` / `logs`（先构建再停启、后台非阻塞、就绪探测）

### 变更（Changed）

- `src/config.ts` 重写为多机器人解析与校验；`AppConfig` 由 `lark` + `projects` 改为 `bots[]`
- `src/index.ts` 改为遍历机器人：共享一个 `PiWebClient`，每机器人独立 channel / registry / 队列 / bridge
- 移除对话答复卡片底部的 `🆔 agentId` 展示（纯展示，不参与路由/按钮回调），并清理其空壳参数 `TurnActions`
- 探针脚本适配新配置结构（取 `bots[0]` 凭据）
- `scripts/publish.sh` 敏感文件黑名单扩展：新增拦截 `config.yaml|yml|json`、`registry.<id>.json`、`*.log*`（放行公开模板 `.env.example`）
- `.env.example` 定位调整为「环境变量模板」（`PIWEB_PASSWORD` 等），不再承载项目列表

### 移除（Removed）⚠️ 破坏性

- **`PROJECTS` 环境变量不再支持**：项目来源改为 pi-web 枚举 + `config.yaml` 的 `bots[].cwds`
- **`LARK_ALLOW_OPEN_IDS` / `LARK_GROUP_ALLOWLIST` 仅在回退模式下生效**：多机器人时白名单移到 `config.yaml` 的 `bots[].allowOpenIds` / `bots[].groupAllowlist`
- `AppConfig.lark` / `AppConfig.projects` 字段移除（若把本项目当库引用需改代码）

### 兼容性（Compatibility）

- ✅ **单机器人 `.env` 用法保持不变**：没有 `config.yaml` 且存在 `LARK_APP_ID` / `LARK_APP_SECRET` / `PIWEB_PASSWORD` 时，自动回退为**单个默认机器人**，行为与 0.1.x 一致
- ✅ 已有 `registry.json` 绑定关系会自动迁移到 `registry.default.json`，不必重选项目

---

## [0.1.3] - 2026-09-28

**主题：会话 Agent 管理重构 + 修复历史记录获取**

### 新增（Added）

- `findExistingAgent()`：只查找不创建，**优先取 pi-web 的代表 session**（`activeSessionId`，保证有历史消息），再回退 registry 缓存
- `resolveAgentId()`：统一获取 `{ sid, running }`，不创建新 agent
- `fetchLatestReply()`：`/last` 与切项目摘要共用的取最新回复逻辑 —— **取不到历史记录即判定 agentId 无效**，清缓存重查后重试一次；无 assistant 回复时回退取最后一条用户提问（`💭 提问：…`）
- registry：`ProjectAgent` 增加 `model` / `lastActive` / `firstBound` 字段；新增 `clearRoutesByAgent()`、`isAgentManaged()`、`updateAgentModel()`
- `piweb/client.ts` 新增 `sse(agentId, signal)`，SSE 订阅不再直接 `fetch`
- `/info` 项目列表标注已被会话管理的项目（`✅`）；模型下拉仅在已绑定项目时展示，并增加「默认（保留当前模型）」选项
- `/release` 同步清理该 agent 的消息路由，并对旧卡片的回复做失效拦截

### 修复（Fixed）

- 切换项目后显示「（无历史记录）」/「暂无回复」：根因是 registry 缓存了由 `ensureAgent` 新建的、无历史消息的 agentId；现改为优先采用 pi-web 的真实 session
- `pruneDeadAgents()` 误清理已回收 agent：现只清理 `getState` 返回空（真正无效）的项，保留有历史消息的已回收 agent
- `/switch` 与卡片下拉切换逻辑统一复用 `handleSwitch`，消除两条路径行为不一致
- 状态描述统一为「🟢 空闲」（原「进程就绪」/「进程在」混用）

### 文档（Docs）

- 新增 `AGENTS.md`（AI 编码助手上下文），并加入「禁止自动提交/发布」约定

---

## [0.1.2] - 2026-09-27

### 修复（Fixed）

- 切项目后卡片显示「暂无回复」：为 `sendContextSummary` 增加重试与 `ensureAgent` 兜底（注：该轮定位方向有偏差，根因「agentId 取到无历史的会话」在 0.1.3 才彻底修复）

### 变更（Changed）

- `scripts/publish.sh` 显式指定 `--registry=https://registry.npmjs.org/`，避免本机 npm 镜像配置导致发错仓库

---

## [0.1.1] - 2026-09-27

### 修复（Fixed）

- 无参数启动时不加载 `.env`，导致 `PIWEB_PASSWORD` 缺失而启动失败：CLI 现在默认自动加载当前目录 `.env`（不存在则静默跳过）

---

## [0.1.0] - 2026-09-27

首个公开版本。

### 新增（Added）

- 飞书 ↔ pi-web 桥接：消息路由、指令解析、SSE 流式卡片更新、审批与中止（停止）按钮
- 会话绑定持久化：`chatId ↔ cwd`、`cwd ↔ agentId` 复用、卡片消息路由定向（回复卡片即路由到对应 agent）
- 指令：`/help`、`/info`、`/switch`、`/agents`、`/last`、`/abort`、`/release`、`/model`
- 飞书卡片 V2 schema（`schema: "2.0"` + `behaviors` 回调）：状态卡、答复流式卡、进展卡、会话列表卡
- agent 404 自愈：进程失效时清除记录并重建一次
- CLI：`--help` / `--version` / `--init` / `--env <path>` / `--cwd <dir>`
- 探针脚本：`probe:health`、`probe:piweb`、`probe:feishu`

---

## 版本号约定

| 场景 | 升级位 | 例 |
|---|---|---|
| 只修 bug | patch | `0.1.3 → 0.1.4` |
| 向后兼容的新功能 | minor | `0.1.3 → 0.2.0` |
| 破坏性变更 | `0.x` 阶段进 minor，`1.0+` 阶段进 major | `0.2.0 → 0.3.0` / `1.0.0 → 2.0.0` |
