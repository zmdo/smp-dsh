# 步骤 8 验收执行记录

- 执行时间：2026-10-20 20:50～21:05 CST
- 分支：`ces/detail-extensions`
- 测试环境：本地控制台 + 4 台真实 SSH 测试服务器
- 状态：进行中

## 已完成用例

| 编号 | 用例 | 结果 | 报告 |
| --- | --- | --- | --- |
| 01 | CORE-01 仅核心启动 | 部分通过 | [01-CORE-01.md](01-CORE-01.md) |
| 02 | PLUGIN-01 插件加载与目录 | 通过 | [02-PLUGIN-01.md](02-PLUGIN-01.md) |
| 03 | PLUGIN-02 容器面板 | 通过 | [03-PLUGIN-02.md](03-PLUGIN-02.md) |
| 04 | PLUGIN-03 容器设置 | 通过 | [04-PLUGIN-03.md](04-PLUGIN-03.md) |
| 05 | CONT-01 无 Docker | 回测通过 | [05-CONT-01.md](05-CONT-01.md) / [11-CONT-01-RETEST.md](11-CONT-01-RETEST.md) |
| 06 | CONT-02 空容器清单 | 通过 | [06-CONT-02.md](06-CONT-02.md) |
| 07 | CONT-03 运行容器 | 通过 | [07-CONT-03.md](07-CONT-03.md) |
| 08 | CONT-04 停止容器 | 通过 | [08-CONT-04.md](08-CONT-04.md) |
| 09 | CONT-05 Compose 容器 | 通过 | [09-CONT-05.md](09-CONT-05.md) |
| 13 | SW-01 安装缺失软件 | 部分通过 | [13-SW-01.md](13-SW-01.md) |
| 10 | CONT-06 权限不足 | 回测通过 | [10-CONT-06.md](10-CONT-06.md) / [12-CONT-06-RETEST.md](12-CONT-06-RETEST.md) |

## 本轮发现并修复

1. 容器面板槽键错误：
   - 客户端注册 `container-list`，宿主目录是 `containers`
   - 已由 `c6fc7fc` 修复
2. 破坏性切换删表后插件查询失效：
   - 新增 `0021_container_plugin_observations.sql`
   - 插件巡检改为 `docker ps -a --format '{{json .}}'`
   - 插件巡检 commit 写回 `server_containers`

## 已修复并回测

### CONT-06 权限不足

- 任务失败，但服务器状态为 `unverified`，不是“需关注”。
- 容器查询返回空行，不返回权限错误。
- 面板因此可能显示“空清单”，无法解释 Docker 权限失败。
- 需要修状态派生或扩展查询错误展示后重测。

### CONT-01 面板诊断

- 无 Docker 时状态和软件状态正确。
- 容器面板的诊断文案尚未在浏览器确认；如仍显示空清单，需要同样修正。

## 下一步

- 修权限不足状态和面板诊断。
- 继续 SW 安装／升级、GROUP 临时插件、PLUG 生命周期、CFG 并发、TASK 取消、TERM/UI。
- 每完成一项补独立编号报告。
