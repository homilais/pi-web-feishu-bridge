// 桥接侧终端接入服务器：仅本机监听，供 pi 扩展注册会话并接收下行命令。
// 不做 token 认证 —— 监听面已限定在 127.0.0.1，安全边界=本机用户权限（spec 已决策）。
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSession } from '../bridge/agent-session.ts';
import type { PiWebEvent } from '../piweb/types.ts';
import { logger } from '../log.ts';
import {
  DISCOVERY_DIR,
  DISCOVERY_FILE,
  type BridgeDiscovery,
  type TerminalCommand,
  type TerminalEventBatch,
  type TerminalRegistryEntry,
  type TerminalResponse,
  type TerminalSessionInfo,
} from './protocol.ts';

const log = logger('terminal');

/** 把 AgentSession 接成扩展可驱动的会话（由外部注入，避免本模块耦合具体实现）。 */
export type TerminalSessionFactory = (sessionId: string) => AgentSession | undefined;

/** 会话提供的下行投递器：把命令写进扩展持有的 SSE 流。 */
interface Connection {
  sessionId: string;
  res: ServerResponse;
}

/** 某个会话的事件订阅者（由 AgentSession.onEvent 桥接过来）。 */
type SessionListener = (ev: PiWebEvent) => void;

export class TerminalServer {
  private server?: Server;
  private discoveryPath?: string;
  private readonly connections = new Map<string, Connection>();
  private readonly entries = new Map<string, TerminalRegistryEntry>();
  private readonly listeners = new Map<string, Set<SessionListener>>();
  /** chatId → 选中的终端 sessionId（同 cwd 可多终端，故不能用 cwd 当键）。 */
  private readonly chatBinding = new Map<string, string>();
  /** requestId → 等待中的请求（T5 的请求-响应通路）。 */
  private readonly pending = new Map<string, (res: TerminalResponse) => void>();
  private readonly factory?: TerminalSessionFactory;
  private port = 0;

  constructor(factory?: TerminalSessionFactory) {
    this.factory = factory;
  }

  /** 订阅某终端会话的事件流（AgentSession.onEvent 的桥接实现）。返回退订函数。 */
  onSessionEvent(sessionId: string, listener: SessionListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.listeners.delete(sessionId);
    };
  }

  /** 启动监听并写发现文件。返回实际端口。 */
  async start(): Promise<number> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // 仅本机：绑定回环地址，不对外暴露
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.port = typeof addr === 'object' && addr ? addr.port : 0;
    this.writeDiscovery();
    log.info(`终端接入服务已启动，监听 127.0.0.1:${this.port}`);
    return this.port;
  }

  /** 停止监听并清理发现文件。 */
  async stop(): Promise<void> {
    for (const c of this.connections.values()) c.res.end();
    this.connections.clear();
    if (this.discoveryPath) {
      try {
        rmSync(this.discoveryPath, { force: true });
      } catch {
        /* 清理失败不影响退出 */
      }
      this.discoveryPath = undefined;
    }
    const s = this.server;
    this.server = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    log.info('终端接入服务已停止');
  }

  /** 当前已注册的终端会话（T2 供 /agents 使用）。 */
  listSessions(): TerminalRegistryEntry[] {
    return [...this.entries.values()];
  }

  /** 把某个飞书会话绑定到指定的终端会话（/switch 用）。 */
  bindChat(chatId: string, sessionId: string): void {
    this.chatBinding.set(chatId, sessionId);
  }

  /** 取该飞书会话绑定的终端 sessionId。 */
  boundSession(chatId: string): string | undefined {
    return this.chatBinding.get(chatId);
  }

  /** 解除绑定（/release 或会话清理）。 */
  unbindChat(chatId: string): void {
    this.chatBinding.delete(chatId);
  }

  /** 下发一条请求并等待扩展回应（带超时，避免永久挂起）。 */
  request(sessionId: string, cmd: TerminalCommand, timeoutMs = 8_000): Promise<TerminalResponse | null> {
    if (!this.dispatch(sessionId, cmd)) return Promise.resolve(null);
    const requestId = cmd.requestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(requestId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  /** 取某会话的 AgentSession（不存在则 undefined）。 */
  sessionFor(sessionId: string): AgentSession | undefined {
    return this.factory?.(sessionId);
  }

  /** 向某个终端会话下发命令（离线时返回 false）。 */
  dispatch(sessionId: string, cmd: TerminalCommand): boolean {
    const c = this.connections.get(sessionId);
    if (!c) return false;
    try {
      c.res.write(`data: ${JSON.stringify(cmd)}\n\n`);
      return true;
    } catch (e) {
      log.warn(`下发命令失败 session=${sessionId.slice(-6)}：${String(e).slice(0, 80)}`);
      return false;
    }
  }

  private writeDiscovery(): void {
    try {
      const dir = join(homedir(), DISCOVERY_DIR);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, DISCOVERY_FILE);
      const info: BridgeDiscovery = {
        port: this.port,
        pid: process.pid,
        version: process.env.npm_package_version ?? '0.0.0',
      };
      writeFileSync(path, JSON.stringify(info, null, 2));
      this.discoveryPath = path;
      log.info(`已写发现文件 ${path}`);
    } catch (e) {
      log.error('写发现文件失败（扩展将无法自动发现桥接）', e);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '';
    // req.url 含查询串，匹配路由前先剥离
    const path = rawUrl.split('?')[0];
    // 事件上行：扩展批量 POST
    if (req.method === 'POST' && path === '/terminal/events') {
      const body = await this.readJson<TerminalEventBatch | TerminalEventBatch[]>(req);
      const batches = Array.isArray(body) ? body : body ? [body] : [];
      batches.forEach((b) => this.applyBatch(b));
      res.writeHead(204).end();
      return;
    }
    // 会话注册
    if (req.method === 'POST' && path === '/terminal/register') {
      const info = await this.readJson<TerminalSessionInfo>(req);
      if (!info?.sessionId) {
        res.writeHead(400).end();
        return;
      }
      this.entries.set(info.sessionId, {
        info,
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
        online: true,
        busy: false,
      });
      log.info(
        `终端会话注册 ${info.sessionId.slice(-6)} cwd=${info.cwd} pid=${info.pid ?? '?'}`,
      );
      res.writeHead(204).end();
      return;
    }
    // 扩展对请求的回应（pullState 等）
    if (req.method === 'POST' && path === '/terminal/respond') {
      const body = await this.readJson<TerminalResponse>(req);
      if (body?.requestId) {
        const resolve = this.pending.get(body.requestId);
        if (resolve) {
          this.pending.delete(body.requestId);
          resolve(body);
        }
      }
      res.writeHead(204).end();
      return;
    }
    // 下行命令流：扩展长连
    if (req.method === 'GET' && path === '/terminal/stream') {
      const sessionId = new URL(rawUrl, 'http://x').searchParams.get('session') ?? '';
      if (!this.entries.has(sessionId)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`);
      this.connections.set(sessionId, { sessionId, res });
      const entry = this.entries.get(sessionId);
      if (entry) entry.online = true;
      req.on('close', () => {
        this.connections.delete(sessionId);
        const e = this.entries.get(sessionId);
        if (e) {
          e.online = false;
          e.lastSeenAt = Date.now();
        }
        log.info(`终端会话断开 ${sessionId.slice(-6)}（离线保留）`);
      });
      return;
    }
    res.writeHead(404).end();
  }

  private applyBatch(b: TerminalEventBatch): void {
    const entry = this.entries.get(b.sessionId);
    if (!entry) return;
    entry.lastSeenAt = Date.now();
    if (typeof b.busy === 'boolean') entry.busy = b.busy;
    // settled 用于收尾会话状态
    for (const ev of b.events ?? []) {
      if (ev.type === 'agent_settled' || ev.type === 'agent_end') entry.busy = false;
    }
    // 扇出给订阅者（如流式卡片）
    const subs = this.listeners.get(b.sessionId);
    if (subs && subs.size) {
      for (const ev of b.events ?? []) {
        for (const fn of subs) {
          try {
            fn(ev);
          } catch (e) {
            log.warn(`事件订阅回调异常：${String(e).slice(0, 80)}`);
          }
        }
      }
    }
  }

  private readJson<T>(req: IncomingMessage): Promise<T | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        // 上限 1MB，防止异常客户端打爆内存
        if (size > 1_000_000) {
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }
}

export { randomUUID };