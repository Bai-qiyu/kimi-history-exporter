---
name: kimi-history-archive
description: Export a user's complete Kimi web chat history in resumable shards, diagnose interrupted exports, validate the downloaded set, and organize conversations into readable question-and-answer Markdown archives. Use for Kimi history backup, bulk export, missing-question/order problems, shard recovery, or post-processing exported JSON; do not use for Kimi Code CLI exports or data from accounts the user is not authorized to access.
---

# Kimi History Archive

Produce a local, verifiable archive without uploading conversation data.

## Choose the stage

- If the user has not exported yet, follow [references/export-workflow.md](references/export-workflow.md).
- If export failed or login expired, use the recovery section in that reference before restarting anything.
- If JSON shards already exist, inspect filenames and JSON structure without printing message text, then run the bundled organizer.
- If the user only wants diagnosis, report the cause and do not install, download, or rewrite files.

## Preserve these invariants

- Operate only on the user's own Kimi account and local files they place in scope.
- Treat exported chats, attachment links, access tokens, cookies, and browser storage as sensitive.
- Never paste tokens into chat, write them into export files, commit chat data, or upload archives.
- Do not delete or modify the original JSON shards. Write results to a new directory.
- Before UI-driven installation, permissions, login, or bulk download, follow the active environment's confirmation rules.
- A `401` means authentication expired. Stop requests, let the user log in again, and resume from saved progress; do not retry it as a transient network error.
- Select exactly one file per part number. When retry duplicates exist, prefer the newest copy only after confirming the part/range metadata is consistent.

## Organize downloaded shards

1. Locate a shard named like `kimi-export-part-001-of-029-*.json` or `kimi-history-*-part-001-of-029.json`.
2. Count parts, detect missing/duplicate part numbers, and inspect only structural fields unless the user asks to examine content.
3. Run:

```powershell
node scripts/organize-kimi-chats.js --input "C:\path\to\part-001.json" --output "C:\path\to\Kimi聊天记录_整理版"
```

4. Verify the report and observable invariants: all selected shards parsed, conversation-file count matches the report, `README.md` exists, and originals are unchanged.
5. Report missing answers honestly. Do not invent or merge content across conversations.

The organizer restores chronological order using message timestamps, groups messages as question then answer, creates one Markdown file per conversation, sorts files by year/month, writes a linked index, and records the selected shards in `整理报告.json`.

For output details and known limitations, read [references/archive-format.md](references/archive-format.md).
