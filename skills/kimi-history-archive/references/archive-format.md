# Readable archive format

The organizer creates a new directory and never edits the source shards.

```text
Kimi聊天记录_整理版/
├── README.md
├── 整理报告.json
└── 对话/
    └── YYYY/
        └── MM月/
            └── YYYY-MM-DD__标题__短ID.md
```

Each conversation contains metadata followed by repeated sections:

```markdown
## 第 1 轮

### 问题

...

### Kimi 回答

...
```

## Ordering

Kimi responses may arrive in reverse API order. The organizer sorts by `created_at` ascending. When timestamps are equal down to the available precision, it reverses the original API position so that the user message precedes its assistant response.

## Missing content

- A user message without a following assistant message is reported as missing an answer.
- An assistant message without a preceding user message is retained in its own turn and marked as missing the question.
- Empty text remains explicitly marked; it is not synthesized.
- Attachments retain available names and remote references. The script does not download attachment bodies.

## Privacy

Markdown output is easier to search but contains the same sensitive conversation text as the JSON. Keep the output private, exclude it from Git repositories and cloud sync unless the user explicitly chooses otherwise, and never use real chats as test fixtures.
