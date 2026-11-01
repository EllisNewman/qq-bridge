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

2026-11-01 P1 修复：`/api/session/reset`、`/api/socialV2/reset`、`/api/workspace/reset` 和 QQ `/reset`、`/new` 也统一执行清除前备份，检查 DSH 业务成功信封后才提交本地清理。普通上下文重置保留长期记忆及归档代际，先准备交接文本，远端处理成功后才保存交接并清理会话。工作区/二代整体重置有任一远端失败时保留全部本地映射；已成功执行的远端停止/归档无法回滚。工作区重置保留活动日志。重置期间暂停目标会话的 agent 操作与新建会话，新来信在重置结束后继续处理。

归档重启恢复只使用当前 conv 的序号，不再拿旧代际的日索引水位恢复；蒸馏按实际记录数选择窗口，可跨过旧版本或写失败留下的序号空洞。

`memory-cli.mjs` 的 list/stats/search/export/import-impressions --dry-run 可在线运行且不落盘，包括 conv 不一致时。add/forget/pin 和 import-impressions --yes 必须先停止 bridge；在线维护请使用控制台管理接口。所有离线写命令、备份和恢复先取得 `memory-maintenance.lock`；与 bridge 启动互相检查锁，拒绝并发写入。锁不自动强制接管，进程中断遗留锁时须确认维护进程已退出后人工清理。

旧 token 代际的 context 文件仍按已有上下文保留策略留存，不作为长期记忆清除；新 token 无法读取旧代际原文。

## 验证

`npm run test:reset`：文件层及隔离 HTTP 回归，无真实 QQ/DSH 操作。
`npm run test:p1`：归档失败信封、所有重置入口的备份与失败保留、部分失败、重置期间来信、CLI 单写者/只读、维护锁竞争，以及保留归档重启后的蒸馏与序号空洞回归；也已纳入 test:audit。

2026-11-01 验证：test:p1、test:reset、test:distill、test:memory、test:context、test:console-memory、test:proactive 通过。规范化临时目录（macOS 使用 `TMPDIR=/private/tmp`）后的 test:audit 为 36/40 脚本通过；剩余 test-audit-setup-guards（start.bat CRLF）、test-voice-system（缺 VOICE.md）、test-console-encoding（无 chcp）、test-preset-local-tools（无本机 DSH 工具清单）也在未修改的 HEAD 副本复现。没有运行真实 QQ/DSH e2e 或部署。
另运行 memory-store、archive-log、time、conversation-context 回归。
