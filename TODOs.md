# TODOs

Nightmanager implementation queue.

## Status Tags

- `[bug]` — eligible urgent defect; may omit spec and then uses `specs/TEMPLATE.md ## Testing Plan`.
- `[ready]` — eligible only with a non-draft linked spec.
- `[draft]` — not eligible until human-promoted.
- `[blocked]` — not eligible until reason resolved.
- `[in-progress]` — currently being worked.
- `[done]` — complete; include commit hash, and PR URL only if PR creation succeeds.

## Queue

### 终端感知机器人（spec: `specs/terminal-bot.md`）

- [done] T1 抽取 AgentSession 接口
  - Spec: `specs/terminal-bot.md`
  - Commit: `4545eca`
  - Blocked by: None — can start immediately
  - Scope: 把 pi-web 侧的 agent 调用收拢到一个会话级接口，让后续终端支持只需再写一份实现；本片不改变任何现有行为。
  - Acceptance:
    - 现有 pi-web 全流程（消息、流式卡片、审批、/last、/switch、/model、/abort）行为与改动前一致
    - 项目级操作（列项目、创建 agent）未被纳入会话接口，仍留在 pi-web 路径
    - 不再存在直接依赖 pi-web 专有语义的会话级调用点
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: prefactoring。约 17 处调用点，分布在桥接核心与流式层，模式高度一致，属机械迁移；由类型检查保证每步可绿。这是后续所有切片的前置条件。

- [done] T2 端到端最小闭环（终端会话可发现、可下发消息）
  - Spec: `specs/terminal-bot.md`
  - Commit: `1903441`
  - Scope: 终端 pi 启动后其会话出现在 terminal 机器人的列表中，可被选中并向其下发一条消息，该消息出现在用户终端里。本片打通最窄路径，不含流式与审批。
  - Acceptance:
    - terminal 机器人可配置、可启动，且与其他两类机器人严格隔离（互相不可见）
    - 终端 pi 启动后其会话出现在该机器人列表中；同项目开两个终端出现两条（不去重）
    - 可选中该会话并下发消息，消息出现在用户终端中
    - 终端上的人机对话不被上报到飞书（仅状态可见）
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: 本 spec 的核心风险集中在这片：桥接新增仅本机监听，扩展主动外连并注册会话，发现文件用于定位监听端口。优先打通端到端，后续片在此骨架上加能力。

- [done] T3 扩展一键安装与 bridge 缺席时优雅降级
  - Spec: `specs/terminal-bot.md`
  - Commit: `e53bcf3`
  - Scope: 扩展可一键安装到 pi 的扩展目录，装完直接用 pi 即可被飞书发现；桥接未运行时扩展静默降级并给一次提示，不影响本地使用。
  - Acceptance:
    - 一条命令把扩展安装到 pi 扩展目录，随后启动 pi 即可被飞书发现
    - 桥接未运行时扩展完全不介入，本地使用不受影响
    - 桥接未运行时提示一次且可静音
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: 扩展随现有 npm 包分发以保证版本永不错位（扩展与桥接之间有协议，错位表现为连上但无事件、极难排查）。本片完成后功能可日常使用，后续为增强。

- [done] T4 飞书发起回合的流式卡片
  - Spec: `specs/terminal-bot.md`
  - Commit: `a9b59c9`
  - Scope: 飞书发起的回合以流式卡片实时更新直至结束，且长时间任务下卡片文字与终端实际输出完全一致。
  - Acceptance:
    - 飞书发起回合后卡片实时更新直至该轮结束
    - 长任务下卡片文字与终端实际输出逐字一致（无丢字）
    - 事件拥塞时上游不阻塞、不重复应用
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: 上行批量上报需合并相邻的增量文本（追加语义，丢弃即丢字），其余事件有幂等或不可丢约束，逐类核对见 spec。合并规则错误只在长任务下暴露，人工验证不可省。

- [ready] T5 功能对齐：停止、模型、状态、历史、切换
  - Spec: `specs/terminal-bot.md`
  - Blocked by: T4 飞书发起回合的流式卡片
  - Scope: 终端会话在停止、模型切换、状态展示、历史查看、会话切换上与 pi-web 会话对等。
  - Acceptance:
    - 可中止任意回合（含用户在终端发起的回合）
    - 可切换该会话的模型
    - 列表实时反映运行中/空闲状态
    - 历史查看在两类后端上语义统一，均显示最后一条且不做过滤（含用户终端发起的回合）
    - 可在终端进程之间切换当前绑定
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: 停止权限刻意宽于批准权限：停止是收回控制权，最坏结果是白干；批准是授予权限，需信息完整，故仅发起方或信息完整的终端可批。这条不一致是刻意设计，见 spec 审批小节。

- [done] T6 审批双通道（终端与飞书可同时批准，先响应者胜）
  - Spec: `specs/terminal-bot.md`
  - Commit: `c3591bd`
  - Scope: 飞书发起的回合需批准时，终端与飞书同时呈现审批，任一侧响应后另一侧消失；用户在终端发起的回合，飞书不可见也不可代批。
  - Acceptance:
    - 飞书发起且需批准的回合，终端与飞书同时出现审批
    - 任一侧响应后，另一侧立即消失且不产生二次响应
    - 用户在终端发起且需批准的回合，飞书看不到该审批且无法代批
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: 终端为超集批准者，因其持有全部对话记录（含飞书发起的消息），信息完整；飞书看不到用户在终端的操作，故不能代批。撤销另一侧审批依赖 pi 提供的对话框取消能力（官方注释为可程序化撤除该对话框），非自行模拟。

- [done] T7 生命周期韧性：断线标记、超时移除、重连状态重取
  - Spec: `specs/terminal-bot.md`
  - Commit: `e435648`
  - Scope: 终端会话在连接异常与恢复时的表现可预期：短暂断线保留为离线、超时移除、恢复后状态正确。
  - Acceptance:
    - 扩展连接断开后列表该项标记为离线并保留
    - 超时后该项从列表移除，不残留
    - 扩展重连后状态（当前文本、工具、运行态）正确，不重放历史事件
    - 桥接重启、扩展重连均可恢复
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: 重连走状态重取而非事件补发：重取复用历史查看的既有通路，而为一次断线维护带序号的持久事件缓冲，复杂度与收益不成比例。代价是断线期间的中间过程永久丢失，只保最终结果（spec 已接受）。

- [done] T8 文档同步
  - Spec: `specs/terminal-bot.md`
  - Commit: `49cd7fd`
  - Scope: 让用户与后续维护者能依据文档正确安装、配置、使用与理解终端模式。
  - Acceptance:
    - 安装指引含一键安装步骤
    - 使用文档说明三类机器人的可绑范围与终端模式的指令语义
    - 架构文档反映新增的本机监听、扩展分发与会话接口抽象
    - 变更记录含本次变更
  - Validation:
    - npm run typecheck
    - npm run build
  - Notes: 需同步安装指引、需求文档、使用手册、助手上下文与变更记录五处。文档中不得出现真实凭据或本机专属路径。

<!--
- [draft] Add concise title
  - Spec: `specs/draft-title.md`
  - Scope: one reviewable vertical slice.
  - Acceptance:
    - Observable, testable behavior.
  - Notes: risks/constraints/follow-ups. Validation comes from the spec Testing Plan.
-->