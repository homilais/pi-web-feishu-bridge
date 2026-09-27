#!/usr/bin/env node
// CLI 入口：`pi-web-feishu-bridge` 命令 → 启动桥接服务
// 通过 `npx pi-web-feishu-bridge` 或全局安装后的 `pi-web-feishu-bridge` 调用。
import { main } from './index.js';

main().catch((e) => {
  console.error('[pi-web-feishu-bridge] 启动失败：', e);
  process.exit(1);
});
