# 19 SW-01 诊断：docker 组处理可观测化

- 用例：SW-01
- 结果：阻塞
- 测试时间：2026-10-21 01:10 CST
- 对象：`container-missing`（43.128.72.83）

## 本轮改动

1. 配方增加 `add_docker_group()`。
2. 在包变更后调用。
3. 将执行 UID、sudo 组成员和异常写入：
   ```text
   /tmp/smp-docker-group.log
   ```
4. 不再静默吞掉组处理异常。

## 执行

- 完全卸载 Docker，删除 docker 组和用户成员。
- 重启控制台，使插件重新加载最新配方。
- 重新创建安装计划并确认。

## 结果

- 计划：`partial_failure`
- 目标错误：
  ```json
  {"code":"ssh_handshake_timeout","detail":"网络连接已建立，但 SSH 握手超时（总等待上限 30 秒）。"}
  ```
- 机器上仍无 Docker。
- `/tmp/smp-docker-group.log` 不存在，说明配方尚未执行到组处理代码。

## 结论

本轮没有验证组处理逻辑；失败发生在安装前的 SSH 连接阶段。当前测试服务器 SSH 握手不稳定，无法继续可靠复现。

## 下一步

- 等待或恢复 `43.128.72.83` 的 SSH 稳定性。
- 重新执行安装计划。
- 读取 `/tmp/smp-docker-group.log` 判断是 `sudo` 组成员为空、UID 判断错误还是 `usermod` 失败。
