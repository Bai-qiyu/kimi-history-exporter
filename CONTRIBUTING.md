# Contributing

感谢参与改进 Kimi History Exporter。

## 开发流程

1. Fork 并创建功能分支。
2. 修改 `src/kimi-history-exporter.user.js`。
3. 运行：

   ```bash
   node --check src/kimi-history-exporter.user.js
   node --test tests/kimi-history-exporter.test.cjs
   ```

4. 不要在测试、Issue、日志或提交记录中加入真实 Cookie、访问令牌或私人对话。
5. 提交 Pull Request，并说明复现步骤、预期行为和测试结果。

## 设计原则

- 本地优先：不引入收集对话数据的远程服务。
- 最小权限：用户脚本保持 `@grant none`，请求限定在 Kimi 同源接口。
- 可恢复：大规模导出失败时应尽量保留已完成结果。
- 可审计：避免混淆、压缩或远程加载不可审查代码。
- 向后兼容：输出继续使用 `kimi-capture-v1`，除非明确发布新格式版本。

