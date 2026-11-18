# Kimi History Exporter

一个本地优先、支持断点续传的 Kimi 网页版历史会话批量导出脚本。

> 非 Kimi 官方工具。接口变化可能导致脚本失效；使用前请确认你有权导出该账号中的数据。

## 功能

- 批量读取 Kimi 历史会话，不依赖网页当前是否展开
- 按正常顺序保存“用户问题 → Kimi 回答”
- 每 100 个会话生成一个独立 JSON 分卷，避免超大字符串错误
- 每个分卷完成后保存断点；登录失效后重新登录即可继续
- 遇到 `401` 立即暂停，不生成大量空会话
- 对 `429`、临时网络错误和 `5xx` 使用有限次数的指数退避重试
- 防止双击或多个标签页同时启动重复任务
- 仅在 Kimi 页面内调用 Kimi 同源接口；不会把登录令牌写入导出文件
- 保留附件名称和远程引用，不主动上传导出内容

## 安装

1. 在 Edge、Chrome 或 Firefox 中安装 Tampermonkey/Violentmonkey。
2. 安装 `src/kimi-history-exporter.user.js`。
3. 登录 Kimi 并打开 <https://www.kimi.com/chat/history>。
4. 点击页面右下角的 **Export Kimi**。
5. 浏览器询问时允许多个文件下载。

## 断点续传

脚本在每个成功下载的分卷后记录已完成会话 ID。如果 Kimi 登录状态失效：

1. 重新登录 Kimi；
2. 回到历史会话页面；
3. 再次点击导出按钮。

脚本将从下一个未完成的会话继续。若要清除断点并重新开始，在开发者控制台运行：

```js
resetKimiHistoryExport()
```

## 输出格式

文件名示例：

```text
kimi-history-2026-11-18T09-00-00-000Z-ab12cd34-part-001-of-029.json
```

每个分卷都是独立的 `kimi-capture-v1` JSON，可以单独处理或导入兼容工具。

## 开发

```bash
npm run check
npm test
```

测试只依赖 Node.js 内置模块，无需安装第三方依赖。

## Codex Skill：完整导出与整理

仓库同时提供 [`kimi-history-archive`](skills/kimi-history-archive/SKILL.md) Skill，覆盖：

- 安装和运行批量导出脚本
- 登录失效、`401`、重复分片和断点续传处理
- 分片完整性检查
- 自动恢复“问题 → Kimi 回答”顺序
- 按年月生成每个对话独立的 Markdown 文件和总目录

整理已有分片也可以直接运行：

```powershell
node skills/kimi-history-archive/scripts/organize-kimi-chats.js --input "C:\path\to\part-001.json"
```

## 隐私与安全

- 脚本会读取当前浏览器中的 Kimi 登录状态，以代表你请求自己的会话数据。
- 登录令牌仅用于发送到 `https://www.kimi.com/apiv2` 的同源请求。
- 导出文件可能包含敏感对话和附件链接，请妥善保存，不要直接公开上传。
- 请只从本仓库源码安装，并在更新前检查变更。

## 来源与许可证

本项目基于 [`nuxdie/llm-chats-archive`](https://github.com/nuxdie/llm-chats-archive)
中的 Kimi 导出脚本改进，依照 GNU AGPL v3.0 发布。详见 [NOTICE](NOTICE) 和
[LICENSE](LICENSE)。

