// 飞书卡片 V2 构建器（schema 2.0）
// 实测约束（见 docs/VERIFIED.md）：
//   ✅ 顶层 button / select_static / markdown / hr / div+fields
//   ❌ V2 不支持 tag: action、tag: note（会 400）
// 回调需后台订阅 card.action.trigger
import type { TurnState } from '../bridge/turn-state.ts';
import type { LiveProgress, ModelsEnabledResponse, ProjectInfo } from '../piweb/types.ts';

export interface SelectOption {
  label: string;
  value: string;
}

// —— 配色（飞书 header template）——
const TPL = {
  info: 'blue',
  agents: 'indigo',
  reply: 'turquoise',
  running: 'blue',
  approval: 'orange',
  done: 'green',
  error: 'red',
} as const;

const STATUS_ICON: Record<string, string> = {
  thinking: '⏳',
  running: '▶️',
  awaiting_approval: '🟡',
  done: '✅',
  error: '❌',
};

const STATUS_TEXT: Record<string, string> = {
  thinking: '思考中',
  running: '运行中',
  awaiting_approval: '等待确认',
  done: '已完成',
  error: '出错',
};

const TOOL_ICON: Record<string, string> = {
  calling: '⚪',
  running: '🔁',
  done: '✔️',
  error: '⚠️',
};

// —— 元素构建 ——
function md(content: string, align?: 'left' | 'center' | 'right'): object {
  const el: Record<string, unknown> = { tag: 'markdown', content };
  if (align) el.text_align = align;
  return el;
}

/** 水平分隔线（V2 可用）。 */
function hr(): object {
  return { tag: 'hr' };
}

/** 多列布局（column_set + column）：把多组元素并排成一行。 */
function columns(groups: { elements: object[]; weight?: number }[]): object {
  return {
    tag: 'column_set',
    columns: groups.map((g) => ({
      tag: 'column',
      elements: g.elements,
      width: 'weighted',
      weight: g.weight ?? 1,
    })),
  };
}

/** 折叠面板（V2 可用，实测）。expanded:false = 默认收起。 */
function collapsible(title: string, elements: object[], expanded: boolean): object {
  return {
    tag: 'collapsible_panel',
    expanded,
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

/** 两列键值块（div + fields）。short=true 时两列并排，false 时独占整行。 */
function fields(items: { label: string; value: string; short?: boolean }[]): object {
  return {
    tag: 'div',
    fields: items.map((it) => ({
      is_short: it.short !== false,
      text: { tag: 'lark_md', content: `**${it.label}**\n${it.value}` },
    })),
  };
}

function button(text: string, type: string, value: Record<string, unknown>): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

/** select_static 下拉（V2 顶层元素）。选项 value 用 `prefix:` 前缀区分用途。 */
function selectMenu(placeholder: string, options: SelectOption[], initial?: string, cmd = 'select'): object {
  const el: Record<string, unknown> = {
    tag: 'select_static',
    placeholder: { tag: 'plain_text', content: placeholder },
    options: options.map((o) => ({
      text: { tag: 'plain_text', content: o.label },
      value: o.value,
    })),
    behaviors: [{ type: 'callback', value: { cmd } }],
  };
  if (initial) el.initial_option = initial;
  return el;
}

function truncate(s: string, max = 3500): string {
  return s.length > max ? s.slice(0, max) + '\n\n…（已截断）' : s;
}

function card(
  template: string,
  title: string,
  elements: object[],
  subtitle?: string,
): object {
  const header: Record<string, unknown> = {
    title: { tag: 'plain_text', content: title },
    template,
  };
  if (subtitle) header.subtitle = { tag: 'plain_text', content: subtitle };
  return {
    schema: '2.0',
    config: { update_multi: true },
    header,
    body: { elements },
  };
}

// —— 卡片 ——

/** /last 执行中：实时执行进展卡。
 *  数据来自 pi-web getSessionContext（执行中会返回实时消息）。 */
export function progressCard(opts: { projectLabel: string; progress: LiveProgress }): object {
  const { projectLabel, progress } = opts;
  const sec = Math.round(progress.elapsedMs / 1000);
  const n = progress.steps.length;
  const elements: object[] = [];

  if (progress.prompt) {
    elements.push(md('**📌 当前任务**'));
    elements.push(md(truncate(progress.prompt, 300)));
  }

  if (n) {
    elements.push(hr(), md(`**🔄 进展（${n} 次工具调用）**`));
    for (const s of progress.steps.slice(-6)) {
      const inp = inputSummary(s.input);
      let line = `\`${s.toolName}\``;
      if (inp) line += `  \`${inp}\``;
      const res = (s.resultText ?? '').trim();
      if (res) line += `  →  ${s.isError ? '❌' : '✅'} ${truncate(res, 80).replace(/\n/g, ' ')}`;
      elements.push(md(line));
    }
    if (n > 6) elements.push(md(`… 共 ${n} 次（已省略前 ${n - 6} 次）`));
  }

  if (progress.currentText.trim()) {
    elements.push(hr(), md('**💬 正在输出**'));
    elements.push(md(truncate(progress.currentText.trim(), 1500)));
  }

  elements.push(hr(), md('📌 完成后结果会自动推送到本会话；再发 /last 可刷新'));

  return card(
    TPL.running,
    `🔴 ${projectLabel}`,
    elements,
    `已运行 ${sec}s${n ? ` · 🔧 ${n} 次工具调用` : ''}`,
  );
}

/** 工具入参摘要（bash 取 command，其余 JSON 截断）。 */
function inputSummary(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.slice(0, 60);
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    const c = o.command ?? o.path ?? o.pattern;
    if (typeof c === 'string') return c.slice(0, 60);
    return JSON.stringify(input).slice(0, 60);
  }
  return String(input).slice(0, 60);
}

/** /info：当前项目 + 模型 + 切换项目/模型下拉。
 *  notice：卡片顶部提示条（如「请先选择项目」），避免另发一条文本。
 *  未绑定项目时不展示模型列表。 */
export function statusCard(opts: {
  currentCwd?: string;
  projects: ProjectInfo[];
  currentModelRef?: string;
  models?: ModelsEnabledResponse | null;
  notice?: string;
}): object {
  const { currentCwd, projects, currentModelRef, models } = opts;
  const cur = currentCwd ? projects.find((p) => p.cwd === currentCwd) : undefined;
  const curLabel = cur?.label ?? currentCwd ?? '未选择';
  const curState = cur
    ? cur.busy
      ? '🔴 运行中'
      : cur.running
        ? '🟢 空闲'
        : cur.hasAgent
          ? '⚪ 已回收'
          : '⚪ 无进程'
    : '—';

  const elements: object[] = [];
  if (opts.notice) elements.push(md(`📌 ${opts.notice}`));

  // 项目列表：显示项目名称 + 是否在会话管理中
  const projectOpts: SelectOption[] = projects.map((p) => ({
    label: `${p.label}${p.hasAgent ? ' ✅' : ''}（${p.busy ? '运行中' : p.running ? '空闲' : '无进程'}）`,
    value: `project:${p.cwd}`,
  }));
  if (projectOpts.length) {
    elements.push(hr(), md('**切换项目**'));
    elements.push(selectMenu('选择项目…', projectOpts, currentCwd ? `project:${currentCwd}` : undefined));
  }

  // 模型列表：仅当已绑定项目且有 agent 时才展示
  if (models && cur?.hasAgent) {
    const modelOpts: SelectOption[] = [
      { label: '默认（保留当前模型，不更换）', value: 'model:default' },
      ...models.providers.flatMap((p) =>
        (p.models ?? []).map((m) => ({
          label: `${p.name} · ${m.name}${currentModelRef === m.ref ? '  ✅当前' : ''}`,
          value: `model:${m.ref}`,
        })),
      ),
    ];
    elements.push(hr(), md('**切换模型**（下一轮生效）'));
    elements.push(
      selectMenu('选择模型…', modelOpts, currentModelRef ? `model:${currentModelRef}` : 'model:default'),
    );
  }

  return card(
    TPL.info,
    curLabel,
    elements,
    [curState, currentModelRef ?? '未设置'].join('  ·  '),
  );
}

/** 简单确认卡片。 */
export function confirmCard(text: string, title = 'Pi 桥接'): object {
  return card(TPL.done, title, [md(text)]);
}

/** /last：最后一条回复（markdown 渲染）+ 当前 agent 状态。
 *  项目名 → 主标题；状态·模型 → 副标题。 */
export function lastReplyCard(opts: {
  projectLabel: string;
  modelRef?: string;
  state?: string;
  text: string;
}): object {
  const elements: object[] = [md(truncate(opts.text, 4000))];
  return card(
    TPL.reply,
    `📝 ${opts.projectLabel}`,
    elements,
    [opts.state ?? '—', opts.modelRef ?? '—'].join('  ·  '),
  );
}

/** /agents：会话记录列表，每项可点击切换。
 *  副标题：会话总数 + 当前所在项目（若有）。 */
export function agentsCard(
  rows: { cwd: string; label: string; agentId: string; state: string }[],
  currentCwd?: string,
): object {
  if (!rows.length) return card(TPL.agents, '🗂 会话记录', [md('（暂无活跃会话）')]);
  const curLabel = currentCwd ? rows.find((r) => r.cwd === currentCwd)?.label ?? '' : '';
  const elements: object[] = [];
  // 列表样式：每项一个按钮（独占整行，可点击切换），id 放按钮文字里
  // 不用 column_set 表格 —— 列宽固定，长内容会被截断/换行
  rows.forEach((r) => {
    const isCur = r.cwd === currentCwd;
    elements.push(button(`${isCur ? '✅ ' : ''}${r.label} · ${r.state}  ·  ${r.agentId.slice(0, 8)}`, isCur ? 'primary' : 'default', { cmd: 'switch', cwd: r.cwd }));
  });
  return card(
    TPL.agents,
    '🗂 会话记录',
    elements,
    `${rows.length} 个会话${curLabel ? ` · 当前：${curLabel}` : ''}`,
  );
}

/** 任务卡片：运行中显示有序过程；终态用折叠面板收起过程、突出结果。 */
export interface TurnActions {
  agentId?: string;
}

/** 把 turn 的有序时间线转成元素（文字块 + 紧凑工具行）。 */
function buildProcess(turn: TurnState): object[] {
  const els: object[] = [];
  let buf: string[] = [];
  let extra = 0;
  const flush = () => {
    if (!buf.length && !extra) return;
    const lines = [...buf];
    if (extra) lines.push(`… 另 ${extra} 个工具调用`);
    els.push(md(lines.join('\n')));
    buf = [];
    extra = 0;
  };
  for (const s of turn.segments) {
    if (s.kind === 'tool') {
      if (buf.length < 12) buf.push(`${TOOL_ICON[s.status] ?? '⚪'} \`${s.name}\``);
      else extra++;
      continue;
    }
    const body = s.text.trim();
    if (!body) continue;
    flush();
    els.push(md(truncate(body, 600)));
  }
  flush();
  return els;
}

export function streamCard(turn: TurnState, projectLabel: string, actions?: TurnActions): object {
  const elements: object[] = [];
  const icon = STATUS_ICON[turn.status] ?? '⏳';
  const sec = Math.max(1, Math.round((Date.now() - turn.startedAt) / 1000));
  const toolCount = turn.tools.length;
  const proc = buildProcess(turn);

  if (!turn.done) {
    // 运行中：状态行 + 过程（默认展开便于看进度）+ 操作按钮
    const meta = [toolCount ? `🔧 ${toolCount}` : ''].filter(Boolean).join('　·　');
    elements.push(md(`**${icon} ${STATUS_TEXT[turn.status] ?? turn.status}**${meta ? `　·　${meta}` : ''}`));
    if (proc.length) {
      elements.push(hr());
      elements.push(collapsible('查看过程（点击展开/收起）', proc, true));
    } else if (turn.status === 'thinking') {
      elements.push(hr(), md('思考中…'));
    }
    elements.push(hr());
    if (turn.status === 'awaiting_approval' && turn.pendingApproval) {
      elements.push(md(`**需确认：** ${turn.pendingApproval.message ?? turn.pendingApproval.method}`));
      // 允许/拒绝并排
      elements.push(columns([
        { elements: [button('✅ 允许', 'primary', { cmd: 'approve', requestId: turn.pendingApproval.requestId })] },
        { elements: [button('❌ 拒绝', 'danger', { cmd: 'reject', requestId: turn.pendingApproval.requestId })] },
      ]));
    } else {
      elements.push(button('⏹ 停止', 'danger', { cmd: 'abort', turnId: turn.turnId }));
    }
  } else {
    // 终态：结果可见，过程折叠收起（状态/耗时已放入副标题）
    if (turn.error) {
      elements.push(md(`**❌ 错误**\n${turn.error}`));
    } else {
      const result = turn.lastText.trim();
      if (result) {
        elements.push(md('**📝 结果**'));
        elements.push(md(truncate(result, 3000)));
      } else {
        elements.push(md('（本轮无文本输出）'));
      }
    }
    if (proc.length) {
      elements.push(hr());
      elements.push(collapsible(`查看过程（${toolCount} 次工具调用）`, proc, false));
    }
  }

  if (actions?.agentId) {
    elements.push(hr(), md(`🆔 \`${actions.agentId}\``));
  }

  const template = turn.done
    ? turn.status === 'error'
      ? TPL.error
      : TPL.done
    : turn.status === 'awaiting_approval'
      ? TPL.approval
      : TPL.running;

  // 主标题 = 项目名；副标题 = 状态（终态）/ 已用时（运行中）
  const subtitle = turn.done
    ? turn.status === 'error'
      ? `❌ 出错${turn.error ? `：${turn.error.slice(0, 40)}` : ''}`
      : [toolCount ? `🔧 ${toolCount} 次工具调用` : '', `⏱ ${sec}s`].filter(Boolean).join(' · ')
    : `⏱ ${sec}s`;

  return card(template, projectLabel, elements, subtitle);
}