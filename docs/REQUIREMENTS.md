# 需求文档

> 本文档描述桥接服务的整体目标与每个指令的预期交互行为，供需求确认使用。

---

## 一、整体目标

**pi-web-feishu-bridge** 是一个飞书 ↔ pi-web 桥接服务，核心目标：

1. **消息路由**：将飞书消息路由到 pi-web 的编码 agent
2. **流式输出**：实时将 agent 输出流式更新到飞书卡片
3. **会话管理**：支持多项目切换、会话绑定、历史查看
4. **卡片交互**：通过飞书卡片提供项目选择、模型切换、审批等操作

---

## 二、会话 Agent 管理

**目的**：维护所有与飞书进行交互的 agent 集合，支持查询、绑定、解绑、状态同步。

> **术语说明**：本文档统一使用 **agentId** 指代 agent 的唯一标识符。在 pi-web API 中，agentId 也称为 sid（session id），两者是同一个概念。

### 2.1 Agent 绑定

**预期行为**：
- 每个飞书会话（chatId）绑定到一个项目（cwd）
- 每个项目（cwd）对应一个 agent（agentId）
- 所有的agentId 都来自pi-web,不允许自动生成
- 绑定关系持久化存储，重启后保留
- 会话初级未绑定cwd时,主动通过发送info卡片,引导用户绑定

### 2.2 Agent 列表

**预期行为**：
- 记录所有绑定过的 agent 及其信息(agentId,状态,model等),便于快速切换回绑定状态
- 支持按状态筛选（运行中 / 空闲 / 已回收）


### 2.3 Agent 状态同步

**预期行为**：
- 定期或按需同步 agent 运行状态
- 无效 agent（agentId 不存在）自动清理
- 已回收 agent（进程不存在但有历史记录）保留

### 2.4 Agent 生命周期

| 阶段 | 触发条件 | 预期行为 |
|---|---|---|
| 创建 | 用户绑定新项目| 创建新 agent |
| 运行中 | 执行任务 busy | 状态显示 🔴 |
| 空闲 | 任务完成 running| 状态显示 🟢 |
| 已回收 | 进程超时释放 | 状态显示 ⚪，保留历史记录 |
| 无效 | agentId 不存在 | 自动清理 |

### 2.5 路由记忆

**预期行为**：
- 记录每张卡片的来源 agent
- 回复某张卡片时，路由到该卡片对应的 agent
- 路由记录持久化存储

---

## 三、指令列表

### 1. `/help` 或 `/h`

**目的**：显示帮助卡片

**预期交互**：
- 用户发送 `/help` 或 `/h`
- 机器人回复一张帮助卡片，列出所有指令及其说明

---

### 2. `/info`

**目的**：查看当前项目信息，并提供切换项目/模型的入口

**预期交互**：
- 用户发送 `/info`
- 机器人回复状态卡片，包含：
  - 当前绑定的Agent信息（标题显示项目名称，模型,状态等; 未绑定显示"未选择"）
  - 项目列表（下拉选择切换项目）[展示项目名称:是否有被会话管理]便于做出选择
  - 模型列表（下拉选择切换模型）留空白项代表pi-web现有model (如果当前为绑定项目agent时,不能进行模型选择,直接不展示模型列表)
- 用户点击项目下拉选择项目后：`/switch <project>`
  - 绑定该项目()
  - 机器人发送上下文摘要卡片（该agentId最后一条回复）
- 用户点击模型下拉选择模型后：`/model <provider/modelId>`
  - 为绑定的项目agent切换模型

---

### 3. `/switch <project>`

**目的**：切换当前会话绑定的项目,通过卡片交互触发

**预期交互**：
- 用户发送 `/switch <项目名>`：
  - 先判断是否已经在会话管理agent中,在的话直接直接绑定项目agent即可
  - 不再会话管理中, 寻找的改项目的agentId纳入会话管理: 优先running,然后才是非running的历史sesion,只允许绑定一个,默认使用最后一次会话同pi -c的原则
  - 未找到 → 更新卡片中的项目列表,让重新选择(原则上出现的项目至少都是有过历史会话的,一定可以有对应的agent会话)
  - 找到 → 1纳入会话管理,2绑定项目，3.由于时新纳入,便于用户理解上问,机器人回复last卡片

---

### 4. `/agents`

**目的**：列出所有纳入会话管理的 agent 及状态

**预期交互**：
- 用户发送 `/agents`
  - 机器人回复 agent 列表卡片(用户可以点击触发`/switch <project>`)
  - 每个 agent 显示：项目名称、状态（🔴 运行中 / 🟢 进程在 / ⚪ 已回收）
  - 已回收的 agent（有历史消息）应该显示
  - 无效 agent（无 agentId 记录）不显示

---

### 5. `/last`

**目的**：查看当前会话最后一条回复

**预期交互**：
- 用户发送 `/last`
- 未绑定项目 → 机器人回复info状态卡片提示选择项目
- 有 agent：
  - 工作中 → 机器人回复实时进展卡片
  - 空闲 → 机器人回复最后一条回复卡片（含项目名称、模型、状态、回复内容）

---

### 6. `/abort agentId`

**目的**：停止当前 agent 正在执行的任务, 大任务答复卡片中点击终止时触发

**预期交互**：
- 用户发送 `/abort 无参`时 使用当前绑定的项目agentID
- 无 agent → 回复"已经移除的Agent"
- 有 agent → 回复"⏹ 已请求停止"

---

### 7. `/release`

**目的**：解绑当前chat与项目agent的绑定,并且奖这个agent从会话管理中移除

**预期交互**：
- 用户发送 `/release`
- 机器人回复"✅ 已解绑"
- 下次发消息需要重新选择项目
- 已发送的旧卡片回复,由于不再会话管理集合中,奖不允许发送,提示重新用info状态卡片绑定

---

### 8. `/model <provider/modelId>`

**目的**：为单曲绑定的项目agent切换模型,在info卡片中选择模型列表中的模型触发

**预期交互**：
- 用户发送 `/model <provider/modelId>`：
  - 格式错误 → 回复"格式：/model provider/modelId"
  - 无 agent → 回复"已经移除的Agent"
  - 有 agent → 回复"✅ 模型已设为 xxx（下一轮生效）"

---

## 四、卡片交互

### 1. 项目选择`/switch <project>`

**触发**：点击info状态卡片中的项目下拉

**预期交互**：
- 绑定所选项目
- 机器人更新状态卡片
- 机器人发送上下文摘要卡片（该项目最后一条回复）

### 2. 模型选择`/model <provider/modelId>`

**触发**：点击info状态卡片中的模型下拉

**预期交互**：
- 切换模型
- 机器人更新状态卡片

### 3. 审批

**触发**：点击审批卡片的"允许"或"拒绝"按钮

**预期交互**：
- 机器人将审批结果发送给 agent

### 4. 中止 `/abort agentId`

**触发**：点击卡片中的"停止"按钮

**预期交互**：
- 停止当前任务

---

## 五、消息处理

### 非指令消息

**预期交互**：
1. 用户发送普通消息
2. 未绑定项目 → 机器人回复状态卡片提示选择项目
3. 已绑定项目：
   - 执行中 → 机器人回复"请等待当前任务完成"
   - 空闲 → 机器人开始执行任务，流式更新卡片，完成后发送完成卡片

### 回复消息

**预期交互**：
1. 用户回复某张卡片
2. 机器人将消息路由到该卡片对应的 agent

---

## 六、状态描述

| 状态 | 含义 |
|---|---|
| 🔴 运行中 | 正在执行任务 |
| 🟢 空闲 | 进程存在，空闲 |
| ⚪ 已回收 | 进程不存在，有历史记录 |
| ⚪ 无进程 | 无 agent 记录 |

---

## 七、待确认事项

请确认以下理解是否正确：

1. **`/info` 切项目后**：是否应该立即发送上下文摘要卡片？（当前逻辑：是）
2. **`/agents` 显示会话管理 agent**：除非通过/release 始发
3. **`/last` 模型显示**：agent 有进程活动时显示当前配置的模型，已回收时显示消息本身的模型，是否正确？对的
4. **`/release` 不 abort**：会话管理 agent解绑时是否应该不打断正在执行的任务？（当前逻辑：是）
5. **回复消息路由**：回复某张卡片时，是否应该路由到该卡片对应的 agent？（当前逻辑：是）
6. **无效 agent 处理**：无效 agent 应该自动清理不显示，还是提示用户手动清理？（当前逻辑：自动清理）
7. **Agent 生命周期**：已回收 agent 保留历史记录，是否正确？（当前逻辑：是）

---

## 八、参考

- `src/bridge/bridge.ts` — 指令处理实现
- `src/bridge/registry.ts` — 会话绑定与 管理agent 持久化
- `src/feishu/cards.ts` — 卡片模板
- `src/piweb/client.ts` — pi-web 客户端封装
- `learning/PIWEB-CAPABILITIES.md` — pi-web API 手册

---

## 九、变更记录

### 2026-09-29　多机器人配置（多 Bot 配置）

#### 9.1 目标与背景

现有架构只支持**单个飞书机器人**，绑定 pi-web 中全部 cwd。本次升级支持**多个飞书机器人**，每个机器人按配置限定可绑定的 cwd 范围，实现「不同项目路径由不同机器人服务、互不干扰」。

关键约束：**一个 cwd 只允许被一个机器人绑定**（配置级独占，非运行时抢占）。

#### 9.2 配置文件格式（YAML）

采用 YAML 配置文件（新增依赖 `js-yaml`），默认路径 `./config.yaml`，可用 CLI `--config <path>` 指定。支持 `${ENV_VAR}` 插值（用于把密码等敏感值从环境变量引入，避免明文）。

```yaml
# config.yaml（须加入 .gitignore，不提交）
piweb:
  baseUrl: http://127.0.0.1:30141
  password: ${PIWEB_PASSWORD}   # 引用环境变量

defaultModel: anthropic/claude-sonnet   # 可选，原 DEFAULT_MODEL

bots:
  - id: default          # 默认机器人：不写 cwds（或空数组）
    appId: cli_xxx
    appSecret: yyy
    # allowOpenIds: [ou_xxx]        # 可选：私聊白名单（open_id）
    # groupAllowlist: [oc_xxx]      # 可选：群白名单（chat_id）
  - id: alpha
    appId: cli_aaa
    appSecret: bbb
    cwds:
      - /Users/you/project/alpha
  - id: docs
    appId: cli_ccc
    appSecret: ddd
    cwds:
      - /path/a
      - /path/b
    groupAllowlist: [oc_xxx]
```

**字段说明：**

| 字段 | 必填 | 说明 |
|---|---|---|
| `piweb.baseUrl` | ❌ | pi-web 地址，默认 `http://127.0.0.1:30141` |
| `piweb.password` | ✅ | pi-web Basic Auth 密码；可用 `${PIWEB_PASSWORD}` 插值 |
| `defaultModel` | ❌ | 默认模型 `provider/modelId` |
| `bots[].id` | ✅ | 机器人唯一标识（slug），用于 registry 文件命名与日志 |
| `bots[].appId` | ✅ | 飞书 App ID |
| `bots[].appSecret` | ✅ | 飞书 App Secret |
| `bots[].cwds` | ❌ | 该机器人绑定的 cwd 列表。**缺省或空数组 = 默认机器人** |
| `bots[].allowOpenIds` | ❌ | 私聊白名单；空 = 开放 |
| `bots[].groupAllowlist` | ❌ | 群白名单；空 = 任意群 |

#### 9.3 机器人分类

| 类型 | 判定 | 数量限制 | 可绑定的 cwd |
|---|---|---|---|
| **默认机器人** | `cwds` 缺省或为空数组 | **最多 1 个**（可没有） | pi-web 全集 **减去**所有限定机器人声明的 cwd |
| **限定机器人** | `cwds` 非空（≥1） | 无上限 | 自身 `cwds` **∩** pi-web 已有 cwd |

- 默认机器人**不是必须**的；可以全是限定机器人。
- 不允许出现 2 个及以上默认机器人（`cwds` 为空的 bot），启动报错退出。

#### 9.4 cwd 独占规则（核心约束）

1. **一个 cwd 只归属一个机器人**：任何 cwd 在所有 bot 的 `cwds` 合集中**只能出现一次**。
2. **配置级生效，非运行时**：只要某 cwd 被写进某限定机器人的 `cwds`，其他机器人（含默认）就**永远不能绑定**它——不论它是否已被实际绑定。即排除在配置声明时完成，不依赖运行时状态。
3. **默认机器人的可绑集合**自动排除所有限定机器人声明的 cwd（差集），无需为默认机器人显式排除。

#### 9.5 可绑 cwd 的动态计算

可绑 cwd =（该机器人的声明集合）∩（pi-web 当前已有 cwd）。**每次 `/info` 实时计算**（因 pi-web 的 cwd 集合会随会话创建/删除变化）。

- 限定机器人声明了某 cwd 但 pi-web 暂无该会话 → 该 cwd **不可绑**，且**不在 `/info` 下拉中显示**（完全隐藏，不标灰）。等 pi-web 出现该 cwd 后自动生效、自动出现。
- pi-web 中存在但未被任何机器人声明的 cwd → **只有默认机器人**能绑定（在其 `/info` 显示）。若无默认机器人，则该 cwd 无人可绑。

#### 9.6 `/info` 下拉限制（前置卡死）

绑定限制必须**从 `/info` 项目下拉列表就限定好**，避免用户选了之后才发现不能绑：

- 默认机器人 `/info` 下拉：pi-web 全集 **−** 所有限定机器人声明的 cwd。
- 限定机器人 `/info` 下拉：仅自身 `cwds` ∩ pi-web。
- 切换项目时若目标 cwd 不在该机器人可绑集合内 → 拒绝（理论上不会发生，因为下拉已过滤；作为防御性校验）。

`/switch`、`/agents`、`/last` 等指令同样只看本机器人的可绑 cwd，**完全隔离**，不出现其他机器人的 cwd。

#### 9.7 数据隔离

每个机器人独立持有，互不影响（多个机器人在同一个群里各自工作）：

| 组件 | 隔离方式 |
|---|---|
| Feishu Channel | 每 bot 一个（独立 WS 长连接） |
| Bridge | 每 bot 一个 |
| Registry | 每 bot 一个文件 `registry.<botId>.json`（chatId↔cwd、cwd↔agentId、消息路由均按 bot 隔离） |
| QueueMap / PendingApprovals | 每 bot 一份 |
| **PiWebClient** | **全局共享一个**（所有 bot 连同一个 pi-web） |

#### 9.8 配置校验与启动行为

启动时（`loadConfig`）严格校验，**任一不通过即报错并退出进程**（fail fast，不留隐式降级）：

1. 至少配置 1 个 bot。
2. 默认机器人（`cwds` 为空/缺省）≤ 1 个。
3. `bots[].id` 全局唯一。
4. `bots[].appId` 全局唯一（同一飞书 App 不允许建两个连接）。
5. `bots[].appId` / `appSecret` 非空。
6. 所有限定机器人的 `cwds` 合并后**无重复**（即一个 cwd 不出现在两个 bot 中）。重复 → 报错，提示「cwd `X` 在 bot `A` 和 bot `B` 中重复，请修改配置」。
7. `cwd` 路径规范化（`resolve`）后再比对，避免尾部 `/` 等差异造成漏判。
8. `piweb.password` 必须可解析（`${ENV}` 插值后非空）。
9. pi-web 不可连接 → 退出（沿用现有行为）。

> 注：配置了但 pi-web 暂不存在的 cwd **不算**校验失败——仅在运行时 `/info` 中隐藏，等 pi-web 出现后自动生效。

#### 9.9 向后兼容

- 若不存在 `config.yaml` / `config.json`，但 `.env` 中有 `LARK_APP_ID` + `LARK_APP_SECRET` → 视为单默认机器人（旧用法），保持现有行为。
- 同时存在 `config.yaml` 与 `.env` 中的 LARK_* 时，以 `config.yaml` 为准。
- `PIWEB_PASSWORD` / `PIWEB_BASE_URL` / `DEFAULT_MODEL` 仍可从 `.env` 读，作为未提供 config 文件时的回退。

#### 9.10 CLI

- 新增 `--config <path>`：指定配置文件路径（默认 `./config.yaml`，其次 `./config.json`）。
- `--init`：在当前目录生成示例 `config.yaml`（含注释模板）。
- 其余 flag（`--cwd`、`--env`、`--help`、`--version`）不变。

#### 9.11 影响范围（待开发模块）

| 模块 | 改动 |
|---|---|
| `src/config.ts` | 重写：解析 YAML（加 `js-yaml`），多 bot 结构，`${ENV}` 插值，全部校验 |
| `src/index.ts` | 改为遍历 bots：共享 client，每 bot 建 channel/registry/queues/bridge 并启动 |
| `src/bridge/bridge.ts` | `getProjects()` 按 bot 可绑集合过滤；`/info`、`/switch`、`/agents`、`/last` 均限制在本 bot 范围 |
| `src/bridge/registry.ts` | 支持按 botId 命名持久化文件（`registry.<botId>.json`） |
| `src/cli.ts` | 新增 `--config`、`--init` 生成示例 yaml |
| `src/feishu/cards.ts` | 无结构变化（项目列表已是参数化），仅数据源受限 |
| `package.json` | 新增依赖 `js-yaml` 及其 `@types/js-yaml` |
| `.gitignore` | 新增 `config.yaml`、`config.json` |

### 2026-10-05　终端感知机器人

见完整设计 `specs/terminal-bot.md`。要点：

- 新增第三类机器人 `kind: pi-terminal`：可绑终端 pi 会话，与 pi-web 机器人**严格隔离**
- pi 无入站端口，故由扩展主动外连；桥接仅监听 `127.0.0.1`，不设 token
- 上行批量合并相邻 `text_delta`（追加语义，丢字即永久丢失）
- 审批不对称：终端为超集批准者（信息完整）；飞书仅能批自己发起的回合
- 生命周期：断线标离线 → 60s 移除；重连重取状态而非补发事件
