# Harness 接入服务器管理方案

- 状态：方案草案
- 日期：2026-10-22
- 分支：`ces/harness-integration`
- 范围：服务器管理插件与 DeepSeek Harness 对话的工具接入

## 1. 目标

让 Harness 对话能够：

1. 查看本平台管理的服务器列表
2. 查看单台服务器状态
3. 通过 SSH 在服务器上执行命令
4. 后续接入巡检、变更计划等操作

原则：

- 只操作本平台清单内的服务器
- Harness 不直接接触私钥、密码和任意 SSH 目标
- 只读操作默认允许
- 执行操作受权限模式控制
- 危险操作可审批
- 全程审计

## 2. 总体架构

```text
Harness 对话
    │
    ▼
工具注册表 ctx.tools
    │
    ▼
ServerManagementHarness 适配层
    │
    ├── 服务器目录 / 状态
    ├── 凭据解密
    ├── SSH 连接与执行
    └── 审计
    │
    ▼
服务器管理数据库 / 远端服务器
```

工具本身只做参数解析和结果展示；业务逻辑集中在适配层。

## 3. 能力分层

### 3.1 只读工具

| 工具 | 作用 |
| --- | --- |
| `platform_server_list` | 列出平台服务器 |
| `platform_server_get` | 查看单台服务器状态 |

特点：

- 默认允许
- 不返回 secret
- 不建立 SSH 连接
- 只查询平台数据库和已有观察

### 3.2 执行工具

| 工具 | 作用 |
| --- | --- |
| `platform_server_exec` | 通过 SSH 执行命令 |

特点：

- 必须解析到平台服务器
- 必须使用平台保存的凭据
- 有超时、输出和并发限制
- 受权限模式控制
- 全程审计

### 3.3 后续工具

| 工具 | 作用 |
| --- | --- |
| `platform_server_inspect` | 触发巡检 |
| `platform_server_plan` | 创建安装／升级计划 |
| `platform_server_plan_status` | 查看计划 |

这些工具只创建任务或计划，不直接执行变更。

## 4. 工具命名

统一使用 `platform_` 前缀：

```text
platform_server_list
platform_server_get
platform_server_exec
```

原因：

- 与外部服务器、通用 SSH 工具区分
- 减少工具名冲突
- 让模型明确这是平台内服务器

描述中仍要写清楚边界：

```text
Only servers returned by platform_server_list are managed by this platform.
Never connect to an arbitrary host.
```

## 5. 服务器解析

### 5.1 输入

工具只接受：

```ts
{
  server: string // 平台服务器 ID 或名称
}
```

不接受：

```text
host
port
username
password
private_key
```

### 5.2 解析顺序

1. 按 ID 精确匹配
2. 按名称匹配
3. 名称唯一：返回
4. 名称重复：返回 `server_ambiguous`
5. 找不到：返回 `server_not_managed`

### 5.3 错误

```json
{
  "code": "server_not_managed",
  "message": "这台服务器不在本平台管理范围内"
}
```

```json
{
  "code": "server_ambiguous",
  "candidates": [
    {"id": "...", "name": "web-01", "host": "..."}
  ]
}
```

不允许在解析失败时回退到任意 SSH。

## 6. 工具定义

### 6.1 `platform_server_list`

参数：

```ts
{
  query?: string
  group?: string
  status?: string
  limit?: number
}
```

返回：

```json
{
  "items": [
    {
      "id": "...",
      "name": "web-01",
      "host": "192.0.2.10",
      "group": "生产",
      "type": "容器服务器",
      "status": "normal",
      "software": {
        "docker": "29.1.3"
      },
      "last_checked_at": "..."
    }
  ]
}
```

不返回：

- 私钥
- 密码
- secret_ciphertext
- 完整环境变量

### 6.2 `platform_server_get`

参数：

```ts
{
  server: string
}
```

返回：

- 基本信息
- 连接状态
- OS 核验
- 软件状态
- 最近巡检
- 最近任务
- 容器摘要
- 最近错误

### 6.3 `platform_server_exec`

参数：

```ts
{
  server: string
  command: string
  timeout_ms?: number
}
```

返回：

```json
{
  "exit_code": 0,
  "stdout": "...",
  "stderr": "",
  "duration_ms": 123
}
```

限制：

- 命令最大长度：默认 8192
- 超时：默认 30 秒，最大 120 秒
- 输出：默认 64 KiB，超出截断并标记
- 单服务器并发：1

## 7. 权限模型

### 7.1 模式

```text
read   只读
exec   可执行，需要审批
full   完全权限，自动批准执行
```

### 7.2 工具行为

| 模式 | list/get | exec |
| --- | --- | --- |
| read | 允许 | 拒绝 |
| exec | 允许 | 逐次审批 |
| full | 允许 | 自动允许 |

### 7.3 完全权限

完全权限下可以跳过交互审批，但仍保留：

- 平台服务器归属检查
- 凭据保护
- 超时
- 输出限制
- 并发限制
- 审计

“完全权限”不等于“可以连接任意主机”。

## 8. 审批接入

通过工具前置门实现：

```ts
ctx.on('tools/pre-execute', async (exec, next) => {
  if (exec.name !== 'platform_server_exec') return next()
  if (permission.mode === 'full') return next()
  if (permission.mode === 'read')
    return { kind: 'deny', reason: '当前模式不允许执行服务器命令' }
  return {
    kind: 'ask',
    reason: '在平台服务器上执行命令',
    displayReason: {
      zh: '是否允许在服务器上执行这条命令？',
      en: 'Allow this command to run on the server?',
    },
  }
})
```

没有审批服务时，`ask` 必须拒绝，不能静默执行。

## 9. SSH 执行

### 9.1 流程

1. 解析服务器
2. 读取服务器连接信息
3. 解密凭据
4. 建立 SSH 连接
5. 执行命令
6. 截断输出
7. 关闭连接
8. 写审计

### 9.2 约束

- 不使用用户传入的 host／port
- 不把私钥返回给模型
- 不使用本地 shell 拼接命令
- 不执行交互式命令
- 超时后关闭连接
- 调用取消时中止执行

### 9.3 命令工作目录

默认使用 SSH 用户 home；如需指定目录，使用单独参数，不接受任意注入。

## 10. 审计

建议新增表：

```text
server_command_audit
```

字段：

- id
- server_id
- actor
- command
- command_digest
- approval_mode
- approved
- exit_code
- stdout_excerpt
- stderr_excerpt
- started_at
- finished_at

不记录：

- 私钥
- 密码
- 完整 secret

审计记录与工具调用 ID 关联，便于从 Harness 会话回到服务器历史。

## 11. 系统提示

在服务器管理插件中注册：

```text
When the user asks about a managed server's status, health, software,
containers, tasks or recent errors, call platform_server_list or
platform_server_get instead of guessing.

Only servers returned by platform_server_list are managed by this platform.
Never assume localhost, an IP address, or an SSH target is managed.

For commands on a managed server, use platform_server_exec.
```

## 12. 与“服务器运维”工作区组的关系

工作区组负责：

- 会话组织
- 运维默认工作区
- 会话模板

工具负责：

- 实际访问服务器

两者独立：

```text
服务器运维组 = 入口和上下文
platform_* 工具 = 能力
```

工具是全局注册，因此所有对话都能看到；服务器归属仍由解析和权限控制。

## 13. 代码结构

建议新增：

```text
plugins/server-management/src/host/harness/
  service.ts      服务器解析、list/get/exec
  tools.ts        工具注册
  approval.ts     权限和审批
  audit.ts        审计写入
  schema.ts       工具参数
```

在 `src/index.ts` 中：

```ts
ctx.inject(['tools'], (child) => {
  registerServerHarnessTools(child, deps)
})
```

使用可选子注入，避免没有 Harness 工具服务时阻塞服务器管理插件启动。

## 14. 测试

至少覆盖：

- 列表不泄露 secret
- 按 ID／名称解析
- 同名服务器返回歧义
- 未管理服务器拒绝
- read 模式拒绝 exec
- exec 模式触发审批
- full 模式跳过审批
- 审批拒绝不执行
- 命令超时
- 输出截断
- 非零退出码
- SSH 断开
- 插件卸载时关闭连接

## 15. 分阶段落地

### 第一阶段

```text
platform_server_list
platform_server_get
```

只读，先让 Harness 回答服务器状态。

### 第二阶段

```text
platform_server_exec
```

加审批、超时、输出限制、审计。

### 第三阶段

```text
platform_server_inspect
platform_server_plan
platform_server_plan_status
```

接入巡检和变更计划。

## 16. 验收标准

- Harness 能列出平台服务器
- Harness 能按名称查询单台状态
- 外部主机不会被视为平台服务器
- 只读模式不能执行命令
- 普通模式执行前必须审批
- 完全权限自动批准，但仍受边界和审计约束
- 命令输出不含 secret
- 所有执行都有审计记录
