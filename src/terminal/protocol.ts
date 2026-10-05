// 终端接入协议：桥接侧（server）与 pi 扩展（client）之间的报文格式。
// 方向：扩展主动外连 —— pi 没有入站端口，故桥接监听、扩展拨号。
// 拓扑：扩展 --POST register--> 桥接；扩展 <--SSE 持续下行-- 桥接；扩展 --POST events--> 桥接。

/** 扩展上报的会话信息（注册时一次）。 */
export interface TerminalSessionInfo {
  /** pi 会话 id（ctx.sessionManager.getSessionId()）。 */
  sessionId: string;
  /** 工作目录（ctx.sessionManager.getCwd()）。 */
  cwd: string;
  /** 会话显示名（便于在飞书里区分，可为 basename）。 */
  label?: string;
  /** 当前模型 ref，形如 provider/modelId。 */
  model?: string;
  /** 终端进程 pid，用于判活与展示。 */
  pid: number;
  /** 扩展版本，与桥接做兼容校验。 */
  version?: string;
}

/** 桥接 → 扩展 的下行命令（T2 只用到 prompt）。 */
export type TerminalCommand =
  | { type: 'prompt'; requestId: string; text: string }
  | { type: 'abort'; requestId: string }
  | { type: 'setModel'; requestId: string; provider: string; modelId: string }
  | { type: 'pullState'; requestId: string };

/** 扩展 → 桥接 的上行事件（T2 只用到 settled/heartbeat，其余留给 T4+）。 */
export interface TerminalEvent {
  sessionId: string;
  /** 序号，单调递增；桥接用它识别断线重连后的断层。 */
  seq: number;
  /** 轮次结束。T2 只用它更新列表状态。 */
  kind: 'settled' | 'heartbeat';
  /** 心跳/空闲时上报当前是否在跑，供列表显示运行态。 */
  busy?: boolean;
}

export interface TerminalRegistryEntry {
  info: TerminalSessionInfo;
  connectedAt: number;
  lastSeenAt: number;
  /** 在线 = 下行 SSE 连接是否存活。 */
  online: boolean;
  /** 最近一次已知运行态。 */
  busy: boolean;
}

/** 发现文件：扩展据此定位桥接的监听端口。 */
export interface BridgeDiscovery {
  port: number;
  pid: number;
  version: string;
}

/** 桥接发现的默认目录与文件名。 */
export const DISCOVERY_DIR = '.pi-bridge';
export const DISCOVERY_FILE = 'bridge.json';