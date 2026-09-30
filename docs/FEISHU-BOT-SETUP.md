# 飞书机器人注册与配置指南

> 面向「在飞书开放平台创建/配置自建应用，接到本桥接」的完整流程。
> **多机器人场景下，每个 `config.yaml` 里的 bot 都要独立走完本文全部步骤。**
>
> 界面菜单名称可能随飞书版本微调，若找不到同名入口，按「功能语义」找对应项即可。

---

## 〇、先看这张清单（漏一项就会"连上但没反应"）

| # | 配置项 | 位置 | 必须 |
|---|---|---|---|
| 1 | 企业自建应用 | 应用列表 → 创建 | ✅ |
| 2 | **机器人能力** | 应用能力 → 添加应用能力 → 机器人 | ✅ |
| 3 | App ID / App Secret | 凭证与基础信息 | ✅ 填进 `config.yaml` |
| 4 | **订阅方式 = 使用长连接** | 事件与回调 → 订阅方式 | ⚠️ **默认不是长连接，最容易漏** |
| 5 | 事件 `im.message.receive_v1` | 事件与回调 → 事件配置 | ✅ 否则收不到消息 |
| 6 | 回调 `card.action.trigger` | 事件与回调 → 回调配置 | ✅ 否则卡片按钮/下拉无反应 |
| 7 | 权限 `im:message` 等 | 权限管理 | ✅ 见 §4 |
| 8 | **可用范围包含你自己** | 应用发布 → 可用范围/权限范围 | ✅ |
| 9 | **创建版本 → 发布** | 版本管理与发布 | ⚠️ **不发布，第 2/5/6/7 步改动全都不生效** |
| 10 | 把机器人加进会话 | 飞书客户端（群成员 / 私聊） | ✅ |

> 第 4 和第 9 是两个最常见的坑。本桥接用 WebSocket 长连接收事件，**不需要公网回调网址**。

---

## 一、创建应用

1. 打开开发者后台：<https://open.feishu.cn/app>
2. **创建企业自建应用** → 填名称（例：`pi-alpha-bot`）、图标、描述。
3. 进入应用详情页。

> 多机器人时建议**按项目命名**（`pi-alpha-bot`、`pi-beta-bot`），便于和 `config.yaml` 里的 `bots[].id` 对应。

## 二、添加「机器人」能力

1. 左侧 **应用能力** → **添加应用能力**
2. 找到 **机器人** → 添加。

**没有这一步，用户无法私聊该应用，也收不到任何消息事件。**

验证（可选）：桥接侧可以用 API 确认能力已开：

```bash
# 拿 app_access_token
curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"cli_xxx","app_secret":"yyy"}'
# 用 token 查机器人信息：activate_status = 2 表示机器人能力已激活
curl -s -H "Authorization: Bearer <app_access_token>" \
  https://open.feishu.cn/open-apis/bot/v3/info
```

## 三、取凭证

**凭证与基础信息** 页面复制：

- **App ID**（`cli_` 开头）
- **App Secret**

填进 `config.yaml`：

```yaml
bots:
  - id: alpha-bot          # 自定义，用于 registry.<id>.json 与日志
    appId: cli_aaa...      # ← App ID
    appSecret: bbb...      # ← App Secret
    cwds:
      - /absolute/path/to/project
```

> 多机器人时 **App ID 必须互不相同**。重复会在启动时直接报错：
> `机器人 X 与 Y 使用了相同的 appId，不允许`（同一个飞书应用不能建两条长连接）。

## 四、事件与回调（最关键）

### 4.1 订阅方式改成「使用长连接」

进入 **事件与回调**，在 **事件配置** 与 **回调配置** 两个标签页里，把 **订阅方式** 选为：

> **使用长连接接收事件/回调**
> （Receive events/callbacks through persistent connection）

⚠️ **新建应用的默认值是「开发者服务器」，需要填写请求网址。** 保持默认的话，桥接的 WebSocket 会显示连接成功、但**永远收不到任何事件**——症状就是"给机器人发消息毫无反应，日志里一行 `onMessage` 都没有"。

### 4.2 添加事件

**事件配置** → 添加事件 → 搜索并勾选：

| 事件 | 用途 |
|---|---|
| `im.message.receive_v1`（接收消息） | ✅ 必需，否则消息完全不进桥接 |

### 4.3 添加回调

**回调配置** → 添加回调 → 勾选：

| 回调 | 用途 |
|---|---|
| `card.action.trigger`（卡片回传交互） | ✅ 必需，否则 `/info` 的项目/模型下拉、停止/允许/拒绝按钮全无反应 |

> 本桥接的卡片使用 **卡片 V2 schema + behaviors callback**，回调方式必须是「行动回调 → 使用长连接」，不能是跳转网址。

### 4.4 权限

**权限管理** → 搜索并开通（不同租户名称略有差异，以下为核心项）：

| 权限 | 用途 |
|---|---|
| `im:message` | 获取与发送单聊、群组消息（收消息 + 发卡片都靠它） |
| `im:message:p2p_msg` 或 `im:message.group_at_msg` | 单聊 / 群内 @ 消息读取（按你的使用方式开通） |
| `im:chat` 或 `im:chat:readonly` | 获取群信息（多机器人在群里工作时建议开通） |
| `im:resource` | 消息内图片/文件资源（需要贴图时开） |
| `contact:user.base:readonly` | 读取用户基本信息（可选，用于白名单显示名字） |

开通权限后，若页面提示需审批，走审批流程；**并且仍然要执行 §6 发布版本**。

## 五、可用范围

**应用发布 / 版本管理** 页面里的 **可用范围（权限范围 / 可使用成员）**：

- 至少把**你自己**包含进去，或设为「全员可用」。
- 不在可用范围内的用户，即使私聊机器人也不会有任何响应。

## 六、创建版本并发布（必做）

**版本管理与发布** → **创建版本** → 填版本号和说明 → **申请线上版本 / 发布**。

⚠️ 以下改动**只有发布新版本后才生效**：

- 新增应用能力（机器人）
- 事件订阅、回调订阅
- 权限开通
- 订阅方式从「开发者服务器」改为「使用长连接」

若企业开启了应用发布审批，需要**管理员在管理后台批准**后才上线。
测试期可以把应用设为「测试企业/灰度」或直接找管理员通过。

## 七、把机器人加进会话

- **群聊**：群设置 → 群机器人/群成员 → 添加该应用为群机器人。
- **私聊**：搜索机器人名称直接发消息（需要 §2 机器人能力 + §5 可用范围）。

> 桥接默认 `requireMention: true` —— 在**群里**需要 `@机器人` 才会响应；私聊无需 @。

---

## 八、验证是否配置成功

### 8.1 看桥接日志

```bash
npm run logs        # 或直接 tail -f bridge.log
```

正常应该在你发消息的瞬间出现：

```
[bridge] onMessage chat=xxxxxx sender=yyyyyy mentionedBot=false text=/info
```

- **完全没有 `onMessage` 行** → 事件没投递过来，回到 §4.1（长连接）与 §6（发布）。
- 有 `[lark] 消息被策略拒绝` → 是被桥接的白名单拦了，检查 `config.yaml` 的 `allowOpenIds` / `groupAllowlist`。

### 8.2 多机器人的隔离验证

两个机器人各自私聊发 `/info`，下拉列表应当**互不相同**：

```
[default]    可见: pi-web 中除限定 cwd 外的所有项目
[alpha-bot]  可见: 只有 alpha
```

启动日志里的这两行就是权威说明：

```
[bot=default]    连接飞书长连接…（默认（pi-web 全集 − 1 个限定 cwd））
[bot=alpha-bot]  连接飞书长连接…（限定（1 个 cwd））
```

### 8.3 registry 文件确认

每个机器人独立持久化，文件互不干扰：

```bash
ls registry.*.json
# registry.default.json     ← 默认机器人
# registry.alpha-bot.json   ← alpha-bot
```

---

## 九、故障排查表

| 症状 | 最可能原因 | 处理 |
|---|---|---|
| 发消息**毫无反应**，日志无 `onMessage` | 订阅方式不是「使用长连接」 | §4.1 改订阅方式 → §6 发布 |
| 同上，且已是长连接 | 未订阅 `im.message.receive_v1` | §4.2 添加事件 → §6 发布 |
| 同上，事件也订阅了 | 改动**没发布新版本** | §6（最高频原因） |
| 同上，已发布 | 你不在**可用范围**内 | §5 |
| 同上，全部确认无误 | 该应用没**机器人能力** | §2 |
| 消息能收，但**下拉/按钮点了没反应** | 未订阅 `card.action.trigger` | §4.3 添加回调 → §6 发布 |
| 群里发消息不理，私聊可以 | 群里没 `@机器人` | 见 §7（`requireMention: true`） |
| 群里有 @ 但被拦，日志出现 `策略拒绝` | `groupAllowlist` 没含该群 | 群设置取 `chat_id`（`oc_` 开头）填进 `config.yaml` |
| 私聊提示"不在操作白名单内" | `allowOpenIds` 不含你 | 取自己 `open_id`（`ou_` 开头）填入，或留空=开放 |
| 启动即退出 `使用了相同的 appId` | 两个 bot 配了同一个飞书应用 | 每个 bot 用**独立**应用 |
| 启动即退出 `cwd 重复配置` | 同一项目在两个 bot 都声明 | 一个 cwd 只归属一个机器人（见需求 §9.4） |
| 启动即退出 `默认机器人最多 1 个` | 两个 bot 都没写 `cwds` | 只留一个默认，其余必须写 `cwds` |
| 启动即退出 `piweb.password 未配置` | `${PIWEB_PASSWORD}` 未解析 | `export PIWEB_PASSWORD=...`，或确保同目录有 `.env` |
| `/info` 下拉里**看不到**某项目 | 该项目在 pi-web 中还没有会话 | 先在 pi-web 里 `pi -c` 建会话（交集规则，见需求 §9.5） |
| 换了机器人后原群要重新选项目 | 符合预期：cwd 归属变更后 `pruneOutOfScope` 会清理越界绑定 | 在新机器人里重新 `/info` 选择 |

---

## 十、新增一个机器人的最短路径

1. 开发者后台 **创建企业自建应用**
2. 加 **机器人** 能力
3. 事件与回调：订阅方式选 **使用长连接**；加事件 `im.message.receive_v1`、回调 `card.action.trigger`
4. 权限管理：开 `im:message`（按需加 `im:chat` / `im:resource`）
5. 可用范围：加上你自己
6. **创建版本 → 发布**
7. `config.yaml` 追加一个 bot，填 `appId`/`appSecret`/`cwds`
8. `npm run restart`
9. 把机器人拉进群或私聊，发 `/info` 验证下拉只含自己的项目

---

## 参考

- `docs/REQUIREMENTS.md` §9 — 多机器人配置与 cwd 独占规则
- `docs/USAGE.md` — 指令与卡片用法
- `docs/IMPLEMENTATION.md` — 部署与运维
- 官方文档：长连接事件订阅、卡片回传交互（V2 `card.action.trigger`）
