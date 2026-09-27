# 发布 pi-web-feishu-bridge 到 npm

把项目打包成 npm 包，让其他用户可以通过 `npm i -g` 或 `npx` 一键安装。

---

## 一、当前 package.json 的阻碍清单

```jsonc
{
  "name": "pi-web-feishu-bridge",   // ⚠️ 名字可能被占用
  "private": true,                  // ❌ 硬阻断，必须移除
  "type": "module",
  "description": "...",             // ✅
  "scripts": { ... },               // 需加 build
  "dependencies": { ... },          // ✅
  "devDependencies": { ... },       // 保留 typescript
  "engines": { "node": ">=22.19.0" }// ⚠️ 太窄，见下文
  // ❌ 缺 bin / main / types / files / license / repository
}
```

---

## 二、package.json 改造成可发布版本

```json
{
  "name": "pi-web-feishu-bridge",
  "version": "0.1.0",
  "type": "module",
  "description": "飞书远程指挥 pi 编码 agent（外挂式桥接 @agegr/pi-web）",
  "keywords": ["pi", "pi-web", "feishu", "lark", "bridge", "coding-agent"],

  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "pi-web-feishu-bridge": "dist/cli.js" },

  "files": [
    "dist/",
    "README.md",
    "LICENSE"
  ],

  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "node --watch --env-file-if-exists=.env src/index.ts",
    "start": "node dist/cli.js",
    "prepublishOnly": "npm run build && npm run typecheck",
    "typecheck": "tsc --noEmit"
  },

  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.74.0"
  },

  "devDependencies": {
    "@types/node": "^22.20.4",
    "typescript": "^5.9.3"
  },

  "engines": { "node": ">=22.19.0" },

  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/homilais/pi-web-feishu-bridge.git"
  },
  "bugs": { "url": "https://github.com/homilais/pi-web-feishu-bridge/issues" },
  "homepage": "https://github.com/homilais/pi-web-feishu-bridge#readme",
  "publishConfig": {
    "access": "public"
  }
}
```

**关键改动**：

| 字段 | 原值 | 新值 | 作用 |
|---|---|---|---|
| `private` | `true` | **删除** | npm 硬阻断位，不删就 publish 不了 |
| `main` | 无 | `dist/index.js` | 让 `require('pi-web-feishu-bridge')` 找到入口 |
| `types` | 无 | `dist/index.d.ts` | TypeScript 类型导出 |
| `bin` | 无 | `{...}` | 让 `npm i -g` 后 `pi-web-feishu-bridge` 命令可用 |
| `files` | 无 | `[dist/, README, LICENSE]` | 白名单，控制打哪个文件进包 |
| `license` | 无 | `MIT` | **npm 强制要求** |
| `repository`/`bugs`/`homepage` | 无 | 有 | 让 npmjs 页面能显示 GitHub 链接、issue 上报 |
| `publishConfig.access` | 无 | `public` | **scoped 包（`@org/pkg`）必须显式 public**，普通包可选 |

---

## 三、新增 cli.js 入口（薄壳）

`bin` 指到 `dist/cli.js`，但源码里 `src/index.ts` 是主入口（导出 `main`）。做一个薄壳让 CLI 命令启动服务：

**新建 `src/cli.ts`**：

```ts
#!/usr/bin/env node
// CLI 入口：`pi-web-feishu-bridge` 命令 → 启动桥接服务
import { main } from './index.ts';

// 让 main 变成可导入 + 可直接执行
if (typeof (globalThis as any).process.argv[1] !== 'undefined') {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

**改造 `src/index.ts`**：把现在末尾的 `main().catch(...)` 去掉，只 `export` main 函数，让 CLI 与 require 都能用。

---

## 四、新增 tsconfig.build.json（编译配置）

`src/*.ts` 用 ESM + 相对导入 `./x.ts` 写法。发布要编译成 `dist/*.js`，且 import 要改成 `.js` 后缀（Node ESM 严格要求）。

**新建 `tsconfig.build.json`**：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noEmit": false,
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/probes/**", "node_modules"]
}
```

> ⚠️ **NodeNext 会让 TS 强制要求 import 路径带 `.js` 后缀**。当前代码里 `import './config.ts'` 这种写法在编译时会报错。两种处理方式：
>
> **A. 改源码（推荐）**：把所有 `import './x.ts'` 改成 `import './x.js'`。TS 2.7+ 支持这么写（编译时会找到 `.ts` 源文件），Node 运行时也认 `.js`。这是社区标准做法。
>
> **B. 用 tsc-alias 或自定义插件**：编译后批量替换扩展名。麻烦，不推荐。

---

## 五、`.npmignore`（如果不用 `files` 白名单）

`files` 白名单更清晰，两者**只能选一个**（有 `files` 时 `.npmignore` 会被忽略）。

如果用 `.npmignore`，黑名单排除：

```
# 敏感文件
.env
registry.json
*.log
.DS_Store

# 源码与调研（已发布 dist/）
src/
learning/
docs/
tsconfig*.json

# 依赖
node_modules/

# 其他
.git/
.gitignore
.gitmodules
```

**推荐用 `files` 白名单**：只放行必要的（`dist/` + `README` + `LICENSE`），其他默认都不进包，避免误传敏感文件。

---

## 六、发布前验证

### 1. 本地打包（不上传）

```bash
npm pack
# → 生成 pi-web-feishu-bridge-0.1.0.tgz，查看内容：
tar tzf pi-web-feishu-bridge-0.1.0.tgz
```

预期只看到：

```
package/README.md
package/LICENSE
package/dist/cli.js
package/dist/cli.d.ts
package/dist/index.js
package/dist/index.d.ts
package/dist/bridge/*.js
package/dist/piweb/*.js
package/dist/feishu/*.js
package/package.json
package/dist/cli.js.map   # 等等
```

**绝不能看到**：`.env`、`registry.json`、`learning/`、`docs/`、`src/`。

### 2. 本地试装（真用户视角）

```bash
# 装到临时目录验证
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install ../pi-web-feishu-bridge-0.1.0.tgz

# 检查命令是否可执行
npx pi-web-feishu-bridge --help   # 或者启动试试

# 检查类型导出
node -e "import('./node_modules/pi-web-feishu-bridge/dist/index.js')"
```

### 3. 跑 prepublishOnly（模拟 CI 会跑的步骤）

```bash
npm run prepublishOnly
# → 等价于 npm run build && npm run typecheck
```

---

## 七、正式发布

### 1. 准备 npm 账号

- 去 [https://www.npmjs.com/](https://www.npmjs.com/) 注册账号
- 2FA 建议开启（现代 npm 强制）

### 2. 选择包名策略

**方案 A：普通名（推荐起步）**

```json
"name": "pi-web-feishu-bridge"
```

去 https://www.npmjs.com/package/pi-web-feishu-bridge 看名字是否被占用。如果被占用了：

**方案 B：scoped 包（更专业）**

```json
"name": "@your-org/pi-web-feishu-bridge"
```

- 需要先创建 npm org：`npm adduser` → 控制台 Add Organization
- 安装方式：`npm i -g @your-org/pi-web-feishu-bridge`
- 首次发布必须 `npm publish --access public`（默认会私有化收费）

**方案 C：个人作用域**

```json
"name": "@hebingjie/pi-web-feishu-bridge"
```

- 用你的 npm 用户名做 scope，免费
- 装法同上

### 3. 登录并发布

```bash
npm login                     # 交互登录，或 npm adduser
npm whoami                    # 验证身份

# 打 tag
npm version patch             # 0.1.0 → 0.1.1（自动打 git tag）
# 或
npm version minor             # 0.1.0 → 0.2.0

# 首次发布
npm publish
# scoped 包首次：npm publish --access public

# 后续发布
npm version patch && npm publish
```

### 4. 检查发布结果

- https://www.npmjs.com/package/pi-web-feishu-bridge
- 页面上能看到：文件列表、README 渲染、版本历史、GitHub 链接、issue 链接
- `npm view <包名>` 命令行快速验证

---

## 八、常见坑

| 问题 | 现象 | 修复 |
|---|---|---|
| 忘记删 `"private": true` | `npm publish` 直接失败 | 删掉这一行 |
| 缺 `license` | `npm publish` 报错 | 补 MIT/Apache 之类 |
| scoped 包未设 access | 首次发布后变私有，收费 | 加 `"publishConfig": {"access": "public"}` |
| NodeNext import 报错 | `build` 时 TS 找不到模块 | 源码 import 路径改 `.ts` → `.js` |
| bin 脚本没有 shebang | 装完命令不可执行 | `cli.js` 首行 `#!/usr/bin/env node` |
| 忘了 npm run build | 发布后包里没有 `dist/` | `prepublishOnly` 钩子强制 |
| engines 太窄 | 老 Node 用户装不上 | 要么放宽（`>=18`），要么在 README 明确 |
| 敏感文件混入 | `.env` 里带密钥被公开 | 用 `files` 白名单，不用黑名单 |
| 版本冲突 | `npm publish` 报 403 | 先 `npm version patch` 再发 |

---

## 九、完整发布脚本（一次性搞定）

把整套流程写进 `scripts/publish.sh`：

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "🔍 1/5 类型检查 + 构建..."
npm run prepublishOnly

echo "📦 2/5 打包验证..."
rm -f pi-web-feishu-bridge-*.tgz
npm pack
tar tzf pi-web-feishu-bridge-*.tgz | grep -E '\.env|registry\.json|learning/' && \
  { echo "❌ 敏感文件混入！"; exit 1; } || echo "  ✓ 白名单正确"

echo "🧪 3/5 本地试装..."
rm -rf /tmp/pi-bridge-smoke && mkdir -p /tmp/pi-bridge-smoke && cd /tmp/pi-bridge-smoke
npm init -y >/dev/null
npm install --silent /path/to/pi-web-feishu-bridge-*.tgz
node -e "import('./node_modules/pi-web-feishu-bridge/dist/index.js'); console.log('✓ import 成功')"
cd - >/dev/null

echo "📮 4/5 版本号..."
npm version "$1" || npm version patch

echo "🚀 5/5 发布到 npm..."
npm publish
echo "✅ 完成！"
```

用法：

```bash
chmod +x scripts/publish.sh
./scripts/publish.sh patch     # 打补丁版
./scripts/publish.sh minor     # 打小版本
```

---

## 十、发布后的维护

- **发 bug 修复**：`npm version patch` + `npm publish`
- **发新特性**：`npm version minor` + `npm publish`
- **弃用旧版本**：`npm deprecate <包>@<版本> "message"`
- **删除版本**：48 小时内可 `npm unpublish <包>@<版本>`，之后只能 deprecate
- **CI 自动化**：GitHub Actions + `npm publish` + GitHub tag 触发（`on: push: tags: ['v*']`）
