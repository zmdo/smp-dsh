# 插件目录与包

本文件规定本仓库的目录和包怎么放。插件行为、生命周期和补丁方言以 `.agents/skills/dsh-plugin/` 为准。要做哪些插件、各自负责什么，以 `docs/design/remote-console/design.md` 为准。

运行版本是 `dsh` `0.2.1-alpha.5`。

## 仓库

```
plugins/
  store/
  shell/
  dashboard/
  quant/
  accounts/
  servers/
  settings/
packages/
  console-kit/
scripts/
  build-plugin.mjs
```

根上有一份 `package.json`，只用来把这些包放进本仓库的 workspace，本身不是插件，没有 `cordis.patch.yml`。workspace 包含 `plugins/*` 和 `packages/*`。全仓库一份 lockfile，放在根上。插件目录里不再各放一份。

这些包不写进 Harness 的 workspace。`tmp/deepseek-harness` 只作对照，不放控制台源码。

## 插件

一个栏目一个包。目录名是包名去掉 `@smp/console-` 的那一段。

| 目录 | 包名 | 补丁 `id` | 页面 |
| --- | --- | --- | --- |
| `plugins/store` | `@smp/console-store` | `console-store` | 无 |
| `plugins/shell` | `@smp/console-shell` | `console-shell` | 有 |
| `plugins/dashboard` | `@smp/console-dashboard` | `console-dashboard` | 有 |
| `plugins/quant` | `@smp/console-quant` | `console-quant` | 有 |
| `plugins/accounts` | `@smp/console-accounts` | `console-accounts` | 有 |
| `plugins/servers` | `@smp/console-servers` | `console-servers` | 有 |
| `plugins/settings` | `@smp/console-settings` | `console-settings` | 有 |
| `plugins/settings-shell` | `@smp/console-settings-shell` | `console-settings-shell` | 有 |
| `plugins/models` | `@smp/console-models` | `console-models` | 有 |

有页面的插件：

```
plugins/servers/
  package.json
  cordis.patch.yml
  icon.svg
  locale/en.json
  locale/zh.json
  src/index.ts
  src/client.tsx
  src/pages/
  test/
  lib/
```

`src/index.ts` 是宿主，导出 `inject` 和 `apply`。`src/client.tsx` 是客户端，同样导出这两个名字。页面组件放在 `src/pages/`。包内用相对路径，一个包里 `.ts` 后缀用或不用，跟该包已有文件保持一致。

`package.json` 至少包含：

- `"private": true`，`"type": "module"`
- `"description"` 作为没有 locale 时的退路
- `"main": "./lib/index.js"`
- `exports` 有 `.`、`./client`、`./package.json`、`./locale/*.json`、`./icon`
- `files` 列出 `lib/index.js`、`lib/client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`
- `engines.dsh` 为 `0.2.1-alpha.5`
- `dsh.bundle.patch` 为 `./cordis.patch.yml`
- `dsh.client.platform` 为 `web`

补丁只追加自己这一行，`name` 用包名：

```yaml
- insert:
    - id: console-servers
      name: '@smp/console-servers'
```

没有页面的插件去掉 `src/client.tsx`、`exports` 里的 `./client`、`files` 里的 `lib/client.js`、`dsh.client`。`locale` 和 `icon.svg` 仍在。存储插件的 SQL 放在 `plugins/store/migrations/`。组件脚本不放进任何插件目录，由服务器插件的配置指向仓库外面的那个目录。

## 清单

插件管理器不启动插件就会读这两样。每个插件，包括没有页面的存储插件，都要有。

`locale/en.json` 和 `locale/zh.json` 都写 `meta.title` 和 `meta.description`。中文是自己使用时看到的文字。英文写同样的意思，避免界面语言是英文时退回包名。

| 插件 | 中文标题 | 中文说明 | 英文标题 |
| --- | --- | --- | --- |
| 存储 | 存储 | 数据库连接和密文 | Store |
| 壳 | 控制台 | 侧栏、登录和军师 | Console |
| 仪表盘 | 仪表盘 | 总览 | Dashboard |
| 数字货币 | 数字货币 | 行情、交易所和交易策略 | Markets |
| 资金账户 | 资金账户 | 钱包和虚拟信用卡 | Accounts |
| 服务器 | 服务器 | 服务器、密钥和终端 | Servers |
| 平台设置 | 平台设置 | 安全和 MCP | Settings |
| 设置壳 | 设置壳 | 把已登记的 Harness 设置栏目列在平台设置里 | Settings shell |
| 模型 | 模型 | 把 Harness 的模型配置同步到数据库 | Models |

`icon.svg` 放在包根，由 `"./icon": "./icon.svg"` 导出。每个插件一张，彼此分得开。格式可以是 SVG、PNG、JPEG 或 WebP，不超过 256 KiB，文件留在包内，不使用绝对路径、网址或指向包外的符号链接。

`packages/console-kit` 不是插件，没有 locale，也没有图标。

`lib/` 是构建产物，不手改，不提交。交给 `dsh` 之前先构建。

## 共享库

`packages/console-kit` 的包名是 `@smp/console-kit`。它提供面板组件和浏览器里的请求函数。没有 `apply`，没有 `cordis.patch.yml`，没有 `engines.dsh`。

插件用包名依赖它。客户端构建把它打进该插件的 `lib/client.js`。宿主不从这里取数据库或会话。库本身不保存可变状态。

跨包只用包名。不使用指向另一个目录源码的相对路径。

## 构建

`scripts/build-plugin.mjs` 是唯一的构建脚本。在插件目录里执行，读该目录的 `package.json`，把产物写到该目录的 `lib/`。每个插件的 `"build"` 调用它。

宿主构建为 ESM，`platform: node`。客户端构建为 CJS，`platform: browser`，`jsx: automatic`。`react` 和 `react/jsx-runtime` 标为 external。`.css` 按文本打进包。浏览器产物包在 `window.__ModuleLoader__.load` 里，`id` 等于该插件的包名。

## 测试

每个插件的测试放在该插件的 `test/`，不放进 `src/`。`src/` 只作为构建输入。`test/` 不出现在 `files` 里，也不进入 `lib/`。

文件名是 `test/<名字>.test.ts`。用 `node:test` 和 `node:assert/strict`。从测试引用源码时用指向 `src/` 的相对路径。在插件目录里执行：

```sh
node --test test/**/*.test.ts
```

测纯函数、`apply` 登记的路由和 effect 的清理，以及存储插件对真实 PostgreSQL 的迁移和读写。没有 `DATABASE_URL` 时跳过数据库测试。SSH 和交易所不进默认测试；解析和状态变化在进程里测，连接换成这次测试提供的实现。

页面组件和 Cordis 本身不在这套测试里。不使用 Harness 的覆盖率门禁和会话快照。

## 配置与状态

会随部署变化的地址、间隔、密钥和组件目录写成该插件的 `Config`。缺了必填项就加载失败。

连接池、加密密钥、当前栏目、会话校验结果，放在某次 `apply` 拥有的状态里，或放在会随组件卸载消失的 React 树里。不放在模块顶层。
