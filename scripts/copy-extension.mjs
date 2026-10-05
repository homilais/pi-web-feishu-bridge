// 构建期把 pi 扩展源码拷进 dist/。
// 扩展是给 pi 用 jiti 直载的 .ts 文件，不参与主仓库编译（依赖 pi 内建模块），
// 但必须随 npm 包分发 —— 扩展与桥接之间有协议，分成两个包迟早版本错位。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'src/terminal/extension');
const OUT_DIR = join(ROOT, 'dist/terminal/extension');

if (!existsSync(SRC_DIR)) {
  console.error(`[copy-extension] 找不到扩展源目录：${SRC_DIR}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
let n = 0;
for (const f of ['pi-feishu.ts']) {
  const from = join(SRC_DIR, f);
  if (!existsSync(from)) {
    console.error(`[copy-extension] 缺少扩展文件：${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(OUT_DIR, f));
  n++;
}
console.log(`[copy-extension] 已拷贝 ${n} 个扩展文件 → dist/terminal/extension/`);