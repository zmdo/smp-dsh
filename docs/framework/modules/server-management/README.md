# 服务器管理交接索引

核对基线：`ces/develop`，`f2b8d86`，2026-10-20。此模块当前包名为 `@smp/console-server-management`。

## 阅读分工

| 主题 | 文档 |
| --- | --- |
| 表结构、字段聚合、列表状态及分页位置 | [数据与查询](data-and-query.md) |
| 类型、系统分组、软件／配方注册与 OS 范围 | [定义与配方](definitions-and-recipes.md) |
| 登记识别、巡检、安装、移动、升级和恢复 | [执行与升级](execution-and-upgrades.md) |
| 现有 HTTP／WebSocket 路由 | [接口地图](http-api.md) |
| 未实现的新详情侧栏和容器插件 | [交接状态与下一步](handoff.md) |

## 已实现的页面与操作

- 主侧栏“服务器管理”分组包含服务器实例、服务器密钥、升级管理。
- 实例有服务器分组侧栏、定高列表、状态／查询／分页，新增／编辑表单、详情、移组和终端。
- 登记表单分服务器认证信息和服务器系统信息；先测试连接再识别系统，类型变化可使用按选择隔离的识别缓存。
- 已保存密钥不要求重新粘贴私钥；软件表展示版本要求和检测到的已安装版本。
- 升级管理顶部有升级建议、升级计划、执行记录，支持只读检测、拒绝／推迟提醒、共同版本预检及预约确认。

当前详情仍包含容器与任务报告，终端／编辑仍是另一个屏幕。局部详情侧栏、可扩展详情面板、配置栏目和独立容器插件都尚未开始。

## 当前类型

| 稳定键 | 名称 | 必要软件 |
| --- | --- | --- |
| `builtin/vacant` | 空置服务器 / Vacant server | 无，默认登记类型 |
| `builtin/general` | 普通服务器 / General-purpose server | Docker、Compose，限制为当前配方支持的 Linux |

不要把已确认的“容器服务器”新名称写成当前运行代码。插件可以注册自定义类型和系统组，但目前用户分组仍只继承内置两类，尚无 `publicTypes`。

## 代码组织

| 目录 | 职责 |
| --- | --- |
| `src/index.ts`、`src/client.tsx` | 宿主／客户端装配，不集中写全部业务 |
| `src/client/servers` | 列表、登记、详情、终端及页面 hooks |
| `src/client/keys`、`src/client/changes`、`src/client/upgrades` | 对应页面业务，三个同级目录 |
| `src/host/http` | HTTP 分派、参数与响应 |
| `src/host/servers`、`src/host/groups`、`src/host/keys` | 登记业务、组与凭据引用，三个同级目录 |
| `src/host/definitions`、`src/host/recipes` | 提供者注册、定义解析、脚本与精确计划，两个同级目录 |
| `src/host/execution`、`src/host/remote` | 队列、worker、SSH、远端监督器与恢复，两个同级目录 |
| `src/host/changes`、`src/host/upgrades`、`src/host/tasks` | 变更授权、升级建议／调度和任务查询，三个同级目录 |
| 各业务 `persistence/` | SQL、rows、inputs；连接由调用方提供 |
| `src/shared/contracts` | 公开插件／脚本协议 |
| `src/shared/dto` | HTTP 传输模型 |
| `src/host/database` | 本模块连接接口与事务辅助，实际池仍属于 database 插件 |

这套结构已完成上一轮重构。没有集中式 `store.ts` 或全模块统一 model 大目录，不代表持久化没有抽离；应按业务目录查找。

## 验证入口

`npm run test --workspace=@smp/console-server-management`，数据库集成测试使用 `SMP_TEST_DATABASE_URL`。测试涵盖规则、SSH 替身、隔离 PostgreSQL、Cordis 生命周期、脚本和远端日志恢复。实际运行结果按[测试约定](../../development/testing.md)记录。

源码：[宿主](../../../../plugins/server-management/src/index.ts)、[客户端](../../../../plugins/server-management/src/client.tsx)、[测试目录](../../../../plugins/server-management/test)。
