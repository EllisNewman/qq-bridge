# M3：记忆重置与备份恢复

从 deepseek-harness/workspace/qq-bridge-changes/m3 的增量补丁迁入，保留原目录作为历史设计与补丁留档。仅实现 M3，不包括自动蒸馏、主动 v2 或 M6 控制台页面。

## 使用

- 在线预览：`node scripts/memory-reset.mjs --scope private --dry-run`
- 在线重置指定私聊：`node scripts/memory-reset.mjs --scope session --key private:123`
- 保留长期记忆：追加 `--keep-long-term`。默认保留原始归档；追加 `--include-archive` 才删除归档。
- 离线备份：停止 bridge 后运行 `node scripts/memory-reset.mjs --backup`；可追加 `--include-archive`。
- 离线恢复：`node scripts/memory-reset.mjs --restore <backup-dir>`。有 bridge.lock 时拒绝，不允许 force 绕过；残留锁须确认服务停止后人工清理。
- 指定数据目录：`--state-dir <dir>`。

## 边界与修复

备份含 sessions/social-v2/retired-sessions 及完整 memory 目录，归档按需包含；保留 10 份。文件以 0600 保存，目录 0700。恢复先校验全部文件、路径及符号链接，再以受控目录为单位替换，移除备份之后新增的记忆文件。未包含的 archive 与角色、配置不变。普通提交失败会回滚；若回滚自身失败，保留 .restore-* 恢复材料。进程崩溃/断电不保证跨目录原子性，需检查该目录后再启动服务。

恢复 CLI 创建 memory-restore.lock，bridge 检测到该锁拒绝启动。恢复后的 DSH 会话历史由 DSH 自身管理，文件恢复不会撤销远端归档操作。

在线重置先刷新持久化状态、备份，再停止/归档目标会话。停止或归档失败保留该会话状态并返回失败；多 scope 可部分成功，响应 errors 与 backupDir 可用于处理。工作区查询失败或停止/归档失败时不清本地桥接状态。清空工作区不删长期记忆与原始归档。

旧 token 代际的 context 文件仍按已有上下文保留策略留存，不作为长期记忆清除；新 token 无法读取旧代际原文。

## 验证

`npm run test:reset`：文件层及隔离 HTTP 回归，无真实 QQ/DSH 操作。
另运行 memory-store、archive-log、time、conversation-context 回归。
