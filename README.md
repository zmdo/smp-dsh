# smp-dsh

把策略控制台（[smp](https://github.com/zmdo/smp)）完全改造成 DeepSeek Harness（`dsh`）插件的准备仓库。

这里先记下边界和现状，还不搬代码。

## 要做成什么样

控制台是遥控器。页面和遥控器自己的接口都放进 `dsh` 插件。真正干活的服务留在外面，用接口接进来，和军师调用模型是同一种接法。

本进程默认听 `9090`（`http://127.0.0.1:9090/`）。`smp` 的控制台继续用 `8080`，两边同时开。

`dsh` 崩了就重启。已经交给运维服务的任务、远端容器和数据库不受这次重启影响。

## 已经在 smp 里完成的

`dsh-frontend-plugins` 分支上，页面已经按栏目拆成客户端插件，嵌在 `dsh web` 里：

| 插件 | 内容 |
| --- | --- |
| `@smp/console-shell` | 侧栏、登录页、军师 |
| `@smp/console-dashboard` | 仪表盘 |
| `@smp/console-quant` | 概览、行情、交易所、交易策略 |
| `@smp/console-accounts` | 钱包、信用卡 |
| `@smp/console-servers` | 服务器、密钥 |
| `@smp/console-settings` | 登录安全、MCP |

登录用现有的 `smp_session`。没有会话时打开单独的 `/login`。控制台接口走 `/console-api`，由网站入口转到现在的 Python 网站后台。`dsh` 自己占用 `/api`。

## 还要搬进插件的

现在的网站后台（`apps/web-api`）是遥控器上的按键：登录、读写登记数据、把动作交给运维服务。它会按栏目拆成对应插件的宿主端，用 TypeScript 重写，直接连现有的 PostgreSQL，并继续调用运维服务现有的内部接口。

壳的宿主端签发 `smp_session`。`/console-api` 和 `/mcp` 改由 `dsh` 自己接。

## 留在外面的

- 运维服务：领任务、巡检、采指标、SSH、终端、密钥加解密、行情和余额。
- PostgreSQL：表和现有的 Alembic 迁移。
- 交易所和模型：已经是外部接口。

## 源仓库

实现仍以 `smp` 为准，直到这里开始迁宿主端。设计记录在 `smp` 的 `docs/design/dsh-console-plugins/`。
