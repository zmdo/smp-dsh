# CES

Cyber Evolving System（赛博演进系统）。

CES 做在 Smart Management Platform（SMP）基座上。基座是 DeepSeek Harness（`dsh`）里的一组 Cordis 插件，提供登录、侧栏、平台设置、数据库、加密密钥、会话和工作区存储。CES 的业务栏目作为插件装到基座上，不另起进程，也不再经过单独的网站后台。

本进程默认听 `9090`（`http://127.0.0.1:9090/`）。原来 `8080` 上的控制台已关闭。

`dsh` 崩了就重启。数据库里的登记和远端容器不受这次重启影响。

## 基座提供

| 插件 | 作用 |
| --- | --- |
| `@smp/console-database` | 连接池、密文、迁移 |
| `@smp/console-session-persistence` | 把会话写入 PostgreSQL |
| `@smp/console-workspace-storage` | 把工作区登记写入数据库 |
| `@smp/console-install` | 第一次启动时写入数据库地址和加密密钥 |
| `@smp/console-frame` | 侧栏、登录、网站、菜单、安全 |
| `@smp/console-encryption-key` | 查看和更换加密密钥 |
| `@smp/console-sessions` | 档案：查找、恢复、删除会话 |
| `@smp/console-harness-settings` | Harness 设置 |
| `@smp/console-settings-models` | 模型 |
| `@smp/console-plugin-inventory` | 插件清单 |

目录、包名和补丁 id 以 `docs/spec/plugins.md` 为准。控制台怎么做以 `docs/design/remote-console/design.md` 为准。

## 留在外面的

- PostgreSQL。
- 交易所和模型的 HTTP 接口。模型仍走 `dsh` 自己的接口。
- 登记过的服务器上的容器。CES 不把 Docker 引擎写进本仓库。
