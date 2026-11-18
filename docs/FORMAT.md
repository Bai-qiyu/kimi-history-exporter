# Export format

## Shard

每个分卷是一个独立 JSON 对象：

```json
{
  "provider": "kimi",
  "schema_version": "kimi-capture-v1",
  "exporter": {
    "name": "kimi-history-exporter",
    "version": "0.1.0"
  },
  "export_id": "...",
  "part": 1,
  "total_parts": 29,
  "history_groups": [],
  "chats": [],
  "warnings": []
}
```

`chats[].messages` 已按正常阅读顺序排列。为了控制文件大小，分卷不重复保存
`ListMessages` 原始分页响应，也不在每条标准化消息中嵌入完整原始消息。

附件记录包含文件名、MIME 类型和 Kimi 远程引用；当前版本不批量下载附件二进制文件。

## Manifest

全部分卷完成后会生成一个清单：

```json
{
  "format": "kimi-history-exporter-manifest-v1",
  "export_id": "...",
  "chat_count": 2816,
  "files": [
    {
      "part": 1,
      "filename": "...part-001-of-029.json",
      "chat_count": 100,
      "warning_count": 0
    }
  ]
}
```

清单不包含登录凭据或对话正文。

