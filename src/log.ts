const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}
function emit(level: Level, tag: string, msg: string, extra?: unknown): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
  if (extra !== undefined) console[level === 'error' ? 'error' : 'log'](line, extra);
  else console[level === 'error' ? 'error' : 'log'](line);
}
export function logger(tag: string) {
  return {
    debug: (m: string, e?: unknown) => emit('debug', tag, m, e),
    info: (m: string, e?: unknown) => emit('info', tag, m, e),
    warn: (m: string, e?: unknown) => emit('warn', tag, m, e),
    error: (m: string, e?: unknown) => emit('error', tag, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
