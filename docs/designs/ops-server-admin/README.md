# 运维组服务器管理工具

状态：方案设计，未实现。

## 1. 目标

为运维组提供一组 AI 可调用的服务器管理工具，覆盖：

1. 管理非系统分组
2. 管理 SSH 密钥
3. 管理软件升级
4. 管理审计数据
5. 修改服务器信息

这些能力比普通服务器查询、命令执行和 rsync 传输拥有更高的权限，因此必须建立在账号权限组之上。

## 2. 前置条件

### 2.1 账号权限组

新增账号权限组：

```text
user       普通用户
ops        运维组
admin      管理员
```

规则：

- 权限组来自登录会话
- 服务端根据账号解析权限组
- AI 不能传 role/group/mode
- 不能复用工作区组 `general/server-ops`
- 不能复用服务器分组 `server_groups`

### 2.2 服务端检查

所有运维工具在服务端检查：

```text
当前账号权限组是否包含 ops 或 admin
```

失败返回：

```json
{
  "code": "permission_denied",
  "required": "ops"
}
```

未通过检查时，工具不执行任何数据库写入或远端操作。

## 3. 工具划分

按领域拆分为五个工具：

```text
platform_server_group_admin
platform_server_key_admin
platform_server_upgrade_admin
platform_audit_admin
platform_server_admin
```

不建议使用一个万能工具，也不建议用单个 `action` 覆盖全部领域。

---

# 4. platform_server_group_admin

## 4.1 能力

```text
list
create
rename
delete
```

## 4.2 规则

- 只能管理非系统分组
- `general`、`unassigned` 等系统分组不可删除、不可重命名
- 删除分组前检查是否还有服务器
- 分组仍有服务器时拒绝删除，要求先迁移
- 创建和重命名检查重名
- 删除需要强审批
- 分组名与语言标签做长度和空值校验

## 4.3 审计

记录：

```text
group_id
旧名称
新名称
服务器数量
审批
结果
```

---

# 5. platform_server_key_admin

## 5.1 能力

```text
list
create
delete
rotate
reveal
```

## 5.2 普通操作

### list

只返回：

```text
key_id
name
fingerprint
created_at
referenced_server_count
```

不返回私钥。

### create

创建密钥并返回元数据，不把私钥放入工具输出。

### delete

删除前检查：

```text
ssh_keys
servers.ssh_key_id
```

被服务器引用时拒绝删除。

### rotate

流程：

```text
创建新密钥
→ 更新服务器引用
→ 测试连接
→ 旧密钥解绑
→ 审计
```

任一步失败必须保留可用旧密钥。

## 5.3 reveal

`reveal` 是高危能力。

要求：

- 独立 action
- 强人工审批
- 审批展示密钥名称、指纹、引用服务器
- 不把私钥写入审计
- 不把私钥写入日志
- 输出只返回一次
- 审计只记录 `key_reveal` 事件和指纹

推荐替代方案：

```text
由人工在 Web 页面导出
AI 工具只负责管理，不默认返回私钥
```

如果必须通过 AI 返回私钥，需要明确接受：

```text
私钥会进入模型上下文和会话历史
```

## 5.4 审批

| 操作 | 审批 |
|---|---|
| list | 否 |
| create | 是 |
| delete | 强审批 |
| rotate | 是 |
| reveal | 强审批 |

---

# 6. platform_server_upgrade_admin

## 6.1 能力

```text
check
plan
show
apply
cancel
```

## 6.2 流程

```text
check
→ plan
→ 人工审批
→ apply
```

禁止：

```text
check 后直接 apply
```

`apply` 只能执行已存在、未过期、已批准的计划，不能接受任意命令。

## 6.3 范围

第一版只支持单服务器。

批量升级后续再设计，因为涉及：

- 分批
- 失败恢复
- 回滚
- 变更窗口

## 6.4 审批

| 操作 | 审批 |
|---|---|
| check | 否 |
| plan | 是 |
| show | 否 |
| apply | 强审批 |
| cancel | 是 |

## 6.5 审计

记录：

```text
server_id
plan_id
software
旧版本
目标版本
审批
执行结果
失败原因
```

---

# 7. platform_audit_admin

## 7.1 能力

```text
query
export
retention
```

## 7.2 不提供

```text
update record
delete single record
```

审计记录不允许 AI 单条修改或删除。

## 7.3 query

支持：

```text
时间范围
服务器
类型
状态
会话
工具
分页
```

## 7.4 export

导出前需要审批。

导出内容可能包含：

```text
命令
路径
主机
会话
```

必须记录导出行为。

## 7.5 retention

只允许按规则执行：

```text
保留天数
归档位置
执行时间
```

保留策略的修改也要审计。

## 7.6 审批

| 操作 | 审批 |
|---|---|
| query | 否 |
| export | 是 |
| retention | 管理员 + 审批 |

---

# 8. platform_server_admin

用于修改服务器信息。

## 8.1 允许修改

```text
name
group_id
region
type_key
declared_os
internal_host
tags
install_required_software
```

## 8.2 不允许直接修改

```text
secret_ciphertext
```

密钥变更必须通过 `platform_server_key_admin`。

## 8.3 高风险字段

```text
host
ssh_port
ssh_user
ssh_key_id
```

修改后必须重新测试连接，不能只写数据库。

## 8.4 并发控制

修改必须携带：

```text
expected_config_revision
```

revision 不匹配时返回：

```json
{
  "code": "server_revision_conflict"
}
```

## 8.5 修改流程

```text
读取当前值
→ 生成 diff
→ 审批
→ 写入
→ 重新测试连接
→ 审计
```

## 8.6 删除服务器

建议单独 action：

```text
delete
```

要求：

- 强审批
- 二次确认
- 无运行中任务
- 无关联升级计划
- 审计保留服务器快照

## 8.7 审批

| 操作 | 审批 |
|---|---|
| update | 是 |
| delete | 强审批 |

---

# 9. 审计模型

现有 `server_audit_log.kind` 包含：

```text
command
upload
download
transfer
```

建议新增：

```text
admin
```

或者使用：

```text
tool_name
metadata.action
metadata.target_id
metadata.before
metadata.after
```

审计记录必须包含：

```text
账号
权限组
action
目标 id
变更前
变更后
审批
结果
错误
```

密钥 reveal 只记录：

```text
key_id
fingerprint
action=reveal
```

不记录私钥内容。

---

# 10. 审批矩阵

| 操作 | 审批 |
|---|---|
| 分组 list | 否 |
| 分组 create/rename | 是 |
| 分组 delete | 强审批 |
| 密钥 list | 否 |
| 密钥 create/delete/rotate | 是 |
| 密钥 reveal | 强审批 |
| 升级 check | 否 |
| 升级 plan | 是 |
| 升级 apply | 强审批 |
| 审计 query | 否 |
| 审计 export | 是 |
| 审计 retention | 管理员 + 审批 |
| 服务器 update | 是 |
| 服务器 delete | 强审批 |

---

# 11. 实施顺序

```text
1. 账号权限组
2. 服务端权限检查
3. 分组管理
4. 服务器信息修改
5. 密钥管理
6. 升级计划
7. 审计查询/导出
8. 密钥 reveal
9. 批量能力
```

`reveal` 最后实施，因为泄漏风险最高。

---

# 12. 测试要求

至少覆盖：

```text
普通用户调用运维工具 → 拒绝
系统分组删除 → 拒绝
有服务器的分组删除 → 拒绝
有服务器引用的密钥删除 → 拒绝
修改服务器 revision 冲突 → 拒绝
升级未审批直接 apply → 拒绝
审计单条删除 → 拒绝
密钥 reveal 不出现在审计内容
删除服务器有运行中任务 → 拒绝
```

---

# 13. 非目标

第一版不做：

- 批量升级
- 批量密钥轮换
- 多服务器批量修改
- 审计记录单条删除
- 密钥明文写入审计
- 复用工作区组作为权限组
