# Security Policy

## Reporting a vulnerability

请勿在公开 Issue 中粘贴 Kimi Cookie、Bearer Token、私人对话或带签名的附件 URL。

发现安全问题时，请优先通过 GitHub Security Advisory 私下报告。仓库尚未启用私密报告时，
可以只创建不包含敏感细节的 Issue，请求维护者提供安全联系方式。

## Data handling

- 脚本只在 `https://www.kimi.com/chat/history*` 运行。
- 登录信息仅用于向 `https://www.kimi.com/apiv2` 发送同源请求。
- 登录信息不会写入导出文件或发送到本项目服务器；本项目不运营数据收集服务器。
- 导出文件包含私人对话和附件引用，使用者应自行加密、备份并控制分享范围。

