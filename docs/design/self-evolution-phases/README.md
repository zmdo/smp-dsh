# 自演进三阶段实施方案

- 状态：方案设计，未实施
- 日期：2026-10-24
- 分支：`ces/self-evolution`
- 关联方案：
  - [自演进基础设施](../ces-self-evolution-infrastructure/README.md)
  - [内网域名与网络](../ces-self-evolution-infrastructure/INTERNAL_DNS_AND_NETWORKS.md)
  - [OneDev 自动初始化验证](../ces-self-evolution-infrastructure/ONEDEV_BOOTSTRAP_VERIFICATION.md)

本文把自演进拆成三个阶段，并把验证阶段进一步拆成 P1、P2、P3 三个门禁。每个阶段都必须通过验收后才能进入下一阶段。

## 1. 总览

```text
阶段一：初始开发
  本机 CES + GitHub
  ↓
阶段二：验证测试
  P1：基础服务器 + 测试服务器
  P2：生产服务器 + 全流程
  P3：清空重建 + 离线自举
  ↓
阶段三：正式上线
  生产运行、运维、备份、回滚
```

| 阶段 | 代码托管 | 部署范围 | 触发方 | 测试环境 | 生产环境 |
|---|---|---|---|---|---|
| 阶段一 | GitHub | 本机/测试机 | 本机 | 本机 | 无 |
| P1 | GitHub + OneDev | A + B | 本机 | B | 无 |
| P2 | OneDev | A + B + C | C 上的 CES | B | C |
| P3 | 离线 OneDev | A + B + C | C 上的 CES | B | C |
| 阶段三 | 离线 OneDev | 正式 A/B/C | C 上的 CES | B | C |

## 2. 阶段一：初始开发

### 2.1 目标

在本机完成自演进基础组件开发，代码托管在 GitHub。

```text
开发机器
├─ CES
├─ 自演进插件
├─ 部署脚本
├─ buildspec 模板
└─ 自动化测试
```

### 2.2 代码来源

```text
GitHub
└─ ces/self-evolution
```

### 2.3 需要完成的内容

```text
自演进插件
自演进组
三个服务器类型
Docker / PostgreSQL / OneDev / Caddy recipe
OneDev 项目创建
Agent Token 自动创建
默认 buildspec
发布脚本
回滚脚本
部署文档
```

### 2.4 验收标准

```text
本机构建成功
插件测试通过
OneDev 可在测试服务器启动
CES 项目可创建
Agent 可上线
buildspec 可被 OneDev 解析
简单 Job 可成功执行
```

### 2.5 当前进展

已完成：

```text
自演进插件包
自演进组
基础设施/测试/宿主三个服务器类型
Docker/PostgreSQL/OneDev/Caddy 安装 recipe
OneDev 测试环境
Agent 在线验证
buildspec 解析和执行验证
```

仍需补齐：

```text
默认 buildspec 自动播种
项目初始化提交
Job Executor 自动配置
build/test/release 三个 Job
SSH 部署 Job
发布审批状态机
```

## 3. 阶段二：验证测试

阶段二必须按照：

```text
P1 → P2 → P3
```

顺序执行，不能跳级。

### 3.1 P1：基础设施与测试环境

#### 目标

把 OneDev 等基础环境部署到基础服务器，但开发、提交和触发仍由本机完成。

```text
本机 CES
  ↓ git push / 触发
A 基础服务器
  ├─ OneDev
  ├─ PostgreSQL
  ├─ Caddy
  ├─ Agent
  └─ 发布执行器

B 测试服务器
  ├─ 候选 CES
  ├─ 测试数据库
  └─ 测试入口
```

C 生产服务器暂不参与正式发布。

#### 本机职责

```text
开发代码
提交到 OneDev
触发 build/test 流水线
查看测试地址
验收候选
```

#### P1 验收标准

```text
本机推送代码
→ OneDev 收到提交
→ build 成功
→ 镜像推送
→ 候选部署到 B
→ 用户可访问测试环境
```

P1 不验证生产替换。

### 3.2 P2：生产服务器与全流程

#### 目标

部署 C 生产服务器，让生产 CES 自己完成开发和触发。

```text
用户
 ↓
C 生产 CES
 ↓ 修改代码
OneDev
 ↓
build/test
 ↓
B 测试
 ↓
用户验收
 ↓
生产发布
 ↓
C 替换自身
```

#### 关键变化

```text
代码提交从“本机”切换到“生产 CES”
流水线触发从“本机”切换到“生产 CES”
生产发布由独立发布 Agent 执行
```

#### P2 验收标准

```text
生产 CES 能修改自己的代码
生产 CES 能提交到 OneDev
生产 CES 能触发流水线
B 能部署候选
用户能验收
C 能按同一镜像 digest 替换自身
失败可回滚
```

P2 不要求清空全部数据。

### 3.3 P3：清空重建与离线自举

#### 目标

完全清除数据，从头部署全部服务器，验证只依赖本项目打包的 Docker 镜像也能走通全流程。

#### “不依赖外部服务”的边界

```text
不依赖 GitHub
不依赖公共镜像仓库
不依赖外部 DNS
不依赖外部 CI
```

#### 离线包内容

```text
docker save 的 OneDev 镜像
docker save 的 PostgreSQL 镜像
docker save 的 Caddy 镜像
docker save 的 CES 镜像
docker save 的 Agent 镜像
镜像校验和
初始化 compose
OneDev 初始项目
初始 buildspec
初始 Git 提交
安装脚本
```

#### 执行流程

```text
清除 A/B/C 数据
→ 安装 Docker
→ docker load 离线镜像
→ 启动 A 的 PostgreSQL/OneDev/Caddy
→ 创建 CES 项目
→ 导入初始仓库和 buildspec
→ 启动 Agent
→ 部署 B
→ 部署 C
→ 生产 CES 触发流水线
→ B 测试
→ C 发布
```

#### P3 验收标准

```text
断网环境可完成部署
不访问 GitHub
不访问公共镜像仓库
OneDev 项目和 buildspec 自动恢复
B 测试通过
C 生产发布成功
全流程可重复
```

#### P3 风险

```text
清空数据不可逆
必须提前备份
必须在隔离环境验证
不能直接在生产数据上做第一次 P3
```

建议先在隔离的 A/B/C 演练环境执行 P3，通过后再进入正式上线。

## 4. 阶段三：正式上线

### 4.1 目标

把 P3 验证过的流程转为正式运行。

### 4.2 内容

```text
DNS 和证书
备份与恢复
监控和告警
发布窗口
回滚预案
审计
密钥轮换
容量规划
值班手册
```

### 4.3 验收标准

```text
生产发布有审批
发布使用不可变 digest
失败可回滚
备份可恢复
OneDev 故障不影响已有生产服务
生产 CES 可自演进
```

## 5. 跨阶段不变量

所有阶段都必须保持：

```text
测试和生产使用同一个镜像 digest
生产发布不重新构建镜像
发布必须经过用户验收
生产部署由独立发布 Agent 执行
测试不能直接访问生产数据库
OneDev 不能持有生产部署私钥
密钥不进入 Git、审计和 AI 上下文
```

## 6. 当前实现缺口

在进入 P1 前必须完成：

```text
1. 安装时自动创建 CES 项目
2. 初始化默认分支和初始提交
3. 自动写入 .onedev-buildspec.yml
4. 自动配置 Job Executor
5. 实现 build/test/release 三个 Job
6. 实现 SSH 部署和健康检查
7. 准备 P3 离线镜像包
```

## 7. 阶段门禁

```text
阶段一 → P1：
  本机构建、插件测试、OneDev 和 Agent 可运行

P1 → P2：
  本机提交可通过 OneDev 部署到 B，用户可验收

P2 → P3：
  生产 CES 可自行提交、触发、验收并替换 C，失败可回滚

P3 → 阶段三：
  断网清空重建成功，全部服务来自离线镜像

阶段三：
  备份、监控、审计、回滚和值班流程可用
```

## 8. 结论

```text
阶段一：把自演进组件做出来
P1：把 OneDev 和测试环境跑通
P2：让生产 CES 自己走完整流程
P3：清空重建，证明不依赖外部服务
阶段三：正式运行和运维化
```

P1、P2、P3 不能并行跳过。  
尤其是 P3 的清空重建，必须在 P2 稳定通过后，在隔离环境先完成一次全量演练。
