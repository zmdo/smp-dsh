# 演进开发 Git 代理与异地备灾配置方案

- 状态：方案设计，未实施
- 日期：2026-11-02
- 分支：`ces/self-evolution`
- 适用范围：单用户、本地化部署的 CES/Harness 演进开发环境

## 1. 背景

当前“演进开发”工作区的代码目录是：

```text
/root/.smp/evolution-dev/default-workspace
```

宿主机通过 bind mount 挂载：

```text
/srv/evolution/ces -> /root/.smp/evolution-dev/default-workspace
```

为了让默认对话可以提交和推送，当前临时配置了：

```text
/srv/evolution/ces/.git/credentials
credential.helper=store
```

其中保存的是 OneDev 管理员密码明文。

这个做法能跑，但不符合生产要求：

- 密钥进入工作区，任何 shell 都能读取；
- C 的生产容器也挂载了同一工作区，生产环境持有开发凭据；
- 使用管理员密码，权限过大；
- 异地备灾仓库没有正式配置入口；
- 没有审计，也没有统一的凭据路由。

本方案把 Git 操作收敛为一个“演进开发”组专用的 `git` 代理工具，并把异地备灾仓库配置放到：

```text
平台配置 / Harness 配置 / 演进开发
```

## 2. 目标

1. 默认对话可以正常执行 Git：
   - 查看分支、状态、日志；
   - add/commit；
   - push 到 OneDev；
   - 配置和推送到异地备灾仓库；
   - 验证远端分支和 commit。
2. 只注册一个 `git` 工具，不拆成 `git_status`、`git_diff`、`git_commit` 等大量工具。
3. 工具只对 `evolution-dev` 工作区组的会话开放。
4. 凭据不写入工作区，不返回给模型，不进入 Git remote URL。
5. 异地备灾仓库可在 Harness 设置中配置地址、用户名、验证方式，并测试连接。
6. 支持 `git remote` 和任意常用 Git 操作，不做过细的命令白名单。
7. 凭据按 remote 路由：
   - OneDev 地址使用 OneDev 仓库 token；
   - 备灾地址使用备灾 SSH key/token；
   - 未配置地址不注入凭据。

## 3. 非目标

- 不实现多用户 RBAC。
- 不替代 OneDev 的仓库权限系统。
- 不限制用户使用 `git push --force` 等操作。
- 不为每条 Git 子命令建立独立工具。
- 不把生产环境改造成开发环境。

## 4. 总体架构

```text
┌─────────────────────────────────────────────────────┐
│ Harness 会话（evolution-dev 组）                     │
│                                                     │
│  default workspace = CES 代码目录                    │
│  /root/.smp/evolution-dev/default-workspace          │
└──────────────────────┬──────────────────────────────┘
                       │ 只暴露一个 git 工具
                       ▼
┌─────────────────────────────────────────────────────┐
│ evolution-dev git 代理                               │
│  - 每次调用检查 session 是否属于 evolution-dev       │
│  - 在 host/runner 侧执行 git                         │
│  - 根据 remote 注入对应凭据                          │
│  - 返回 stdout/stderr/exit code                     │
└──────────────────────┬──────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
┌──────────────────┐      ┌──────────────────────┐
│ OneDev            │      │ 异地备灾仓库          │
│ 43.128.69.189     │      │ SSH/HTTPS             │
│ repo token        │      │ 独立 key/token        │
└──────────────────┘      └──────────────────────┘
```

## 5. 配置入口

### 5.1 位置

在现有 Harness 设置页增加一个 section：

```text
平台配置
└─ Harness 配置
   └─ 演进开发
```

使用 Harness 设置现有的 `settings.section` 插槽，id 建议：

```text
evolution-dev
```

该 section 只对管理员可见和可编辑。

### 5.2 表单字段

```text
启用备灾仓库：是/否
Remote 名称：backup
地址：git@backup.example.com:ces.git
用户名：git
验证方式：
  - SSH 私钥
  - SSH Agent
  - HTTPS + Access Token
  - HTTPS + 用户名/密码
凭据：写入后只显示“已配置”
私钥口令：可选
Host Key / 指纹：可选，用于 known_hosts
推送模式：
  - --mirror（推荐）
  - --all + --tags
  - 指定分支
```

### 5.3 配置行为

- 保存后不返回任何明文 secret。
- 提供“测试连接”，执行：

```text
git ls-remote <url>
```

- 成功只显示：

```text
连接成功，远端分支数：N
```

- 失败显示错误摘要，但必须脱敏：
  - 不显示 token；
  - 不显示私钥；
  - URL 中的 userinfo 必须去掉。

## 6. 数据模型

### 6.1 Git 远端配置

```text
evolution_git_remote
  id
  name            # backup / 自定义
  url             # 不含 userinfo
  username
  auth_type       # ssh_key / ssh_agent / https_token / https_password
  secret_ciphertext
  passphrase_ciphertext   # 可选
  known_hosts_fingerprint # 可选
  push_mode       # mirror / all_tags / branches
  enabled
  created_at
  updated_at
```

### 6.2 OneDev 配置

OneDev 的地址和 token 不放在工作区，建议：

```text
name: onedev
url: http://43.128.69.189/CES.git
username: <token name 或 admin>
auth_type: https_token
secret: 受限 access token
```

OneDev 地址可以作为内置配置，避免用户误改；也可以在同一个配置 section 中展示但只读。

### 6.3 加密保存

- 非敏感字段明文存数据库。
- secret 使用现有 encryption-key 机制加密后保存。
- 读取接口只返回：

```text
hasSecret: true
secretHint: "已配置"
```

- 不在日志、错误、审计中输出 secret。

## 7. Git 工具设计

### 7.1 只有一个工具

```text
name: git
description: 在演进开发默认工作区执行 Git 命令
args:
  - string[]
```

调用示例：

```text
git status
git branch --show-current
git remote -v
git add .
git commit -m "message"
git push origin HEAD:main
git remote add backup git@backup.example.com:ces.git
git push backup --mirror
git ls-remote backup
```

### 7.2 授权

与 `server-management` 的 `server-ops` 管理工具相同的模式：

```text
注册时：
  groupForSession(session) == "evolution-dev"

每次调用：
  再检查一次 groupForSession(session) == "evolution-dev"

离开组：
  立即撤销工具注册
```

只给主会话，还是也允许 subagent，需要在实现时明确；建议默认只给主会话，subagent 需要显式授权。

### 7.3 执行位置

Git 在 host/runner 侧执行，不在模型可随意读写的 shell 里直接拿 token。

工作目录固定为：

```text
/srv/evolution/ces
```

会话看到的是同一目录的 bind mount。

如果只在同一容器内执行，容器 root 仍可能读 secret；单用户场景可以接受，但要在文档中写明这一边界。

### 7.4 凭据注入

#### HTTPS

使用临时 `GIT_ASKPASS`：

```text
GIT_ASKPASS=<runner 临时脚本>
GIT_TERMINAL_PROMPT=0
```

askpass 从 secret store 读取 token，不写入 `.git/config`。

#### SSH

使用临时私钥文件：

```text
0600 /run/evolution-dev/keys/backup
GIT_SSH_COMMAND=ssh -i <key> -o IdentitiesOnly=yes -o UserKnownHostsFile=<known_hosts>
```

命令结束后删除临时私钥。

#### 按 remote 路由

根据 Git 提示或 remote URL 匹配：

```text
OneDev host      -> OneDev token
backup host      -> backup key/token
unknown host     -> 不注入，push 失败
```

不能把 OneDev token 发给任意 remote。

### 7.5 不做过细白名单

按当前单用户、本地部署的定位，不限制：

```text
git remote add/set-url
git push --force
git config
git -c ...
```

但要求：

- 所有操作有审计；
- 危险操作（force push、删除远端分支）记录 warning；
- 备份 remote 的凭据只发给配置的地址。

## 8. 异地备灾流程

### 8.1 首次配置

在 Harness 设置中保存：

```text
名称：backup
地址：git@backup.example.com:ces.git
用户名：git
验证方式：SSH 私钥
```

测试连接通过后，在默认对话中：

```bash
git remote add backup git@backup.example.com:ces.git
git push backup --mirror
```

如果平台根据配置自动维护 remote，也可以减少手工 `remote add`。

### 8.2 日常同步

```bash
git push origin HEAD:main
git push backup --mirror
```

或按配置的推送模式执行。

### 8.3 验证

```bash
git remote -v
git branch --show-current
git status -sb
git log --oneline -1
git ls-remote origin refs/heads/main
git ls-remote backup
```

对比：

```text
git rev-parse HEAD
git ls-remote origin refs/heads/main
```

commit 一致说明推送成功。

## 9. 迁移步骤

1. 在 OneDev 创建仓库级 access token：
   - 只给 CES 仓库 code write；
   - 不使用 admin 密码。
2. 在 Harness 设置中配置 OneDev 和 backup remote。
3. 删除工作区中的：

```text
/srv/evolution/ces/.git/credentials
```

4. 删除 git 配置：

```bash
git config --unset credential.helper
```

5. 从 C 的生产容器移除开发工作区挂载，或至少移除凭据。
6. 启用 `git` 工具，只对 evolution-dev 组开放。
7. 验证：
   - `git push origin` 走 OneDev token；
   - `git push backup --mirror` 走备份 key；
   - 未知 remote 不注入凭据；
   - 非 evolution-dev 组没有 git 工具。

## 10. 安全边界

本方案接受以下风险：

- 单用户环境，模型可能被恶意内容提示注入；
- `git push --force` 等破坏性操作不禁止；
- 同一容器内 root shell 可能读取运行时 secret；
- 备份 remote 的可用性依赖外部网络。

缓解措施：

- 工具只在 evolution-dev 组注册；
- 每次调用重新校验组；
- secret 加密保存，不返回前端；
- 凭据按 remote 路由，不发给未知地址；
- 操作审计；
- 异地 mirror 和 reflog 作为恢复手段；
- 生产 C 不配置开发 Git 工具。

## 11. 验收标准

1. Harness 设置中出现“演进开发”section。
2. 可以保存地址、用户名、验证方式和 secret；保存后 GET 不返回 secret。
3. “测试连接”能成功执行 `git ls-remote`。
4. evolution-dev 会话出现 `git` 工具；其他组没有。
5. 默认对话可以：
   - `git branch --show-current`
   - `git status`
   - `git commit`
   - `git push origin HEAD:main`
   - `git remote add backup ...`
   - `git push backup --mirror`
   - `git ls-remote backup`
6. 工作区不存在 `.git/credentials`，`git config credential.helper` 不再指向明文文件。
7. OneDev 地址和 backup 地址使用不同凭据；未知 remote 不注入。
8. 审计记录包含 session、group、remote、commit、push 结果。

## 12. 实施拆分

### 阶段 1：配置存储与 API

- 新增 evolution-dev settings 插件或扩展现有 workspace group 插件。
- 建表、加密存储、GET/PUT/test API。

### 阶段 2：Harness 设置页

- 注册 `settings.section`。
- 表单、secret 写入、测试连接、脱敏错误。

### 阶段 3：Git 工具

- 单工具注册、组校验、host/runner 执行、askpass/SSH key 注入。
- 审计。

### 阶段 4：迁移

- 删除 `.git/credentials`。
- 切换到受限 token。
- 验证 OneDev 和 backup 两条路径。

## 13. 待确认问题

1. 备灾仓库只支持一个，还是允许配置多个 remote？
2. 备份推送是手工，还是需要定时任务？
3. 生产 C 是否完全移除 evolution-dev 工作区和 Git 工具？
4. `git push --force` 是否需要审计告警，还是只记录？
5. 是否允许 subagent 使用 `git` 工具？
