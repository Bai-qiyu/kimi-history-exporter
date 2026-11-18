# Kimi web export workflow

## Install and start

Use the repository's maintained userscript:

`https://raw.githubusercontent.com/Bai-qiyu/kimi-history-exporter/main/src/kimi-history-exporter.user.js`

1. Install a userscript manager such as Tampermonkey or Violentmonkey from its official store.
2. Install the userscript from the URL above after reviewing its requested permissions.
3. Log in to `https://www.kimi.com` and open `https://www.kimi.com/chat/history`.
4. Keep only one exporter script enabled. Disable older Kimi export scripts to prevent duplicate requests and downloads.
5. Click **Export Kimi** once and allow multiple downloads when the browser asks.

The script accesses Kimi's same-origin API from the logged-in page. It should not send chats or credentials to another service.

## Expected output

- JSON files are numbered `part-001-of-NNN`, `part-002-of-NNN`, and so on.
- Each completed shard is downloaded before progress advances.
- A manifest is downloaded after all shards finish.
- The script stores resume state locally in the browser; closing the page after a completed shard should not discard earlier downloads.

## Recovery and diagnosis

### `401 Unauthorized`

The Kimi session or access token expired. Stop the export, log in again, return to the history page, and click the export button once. The exporter should continue at the next incomplete shard.

Do not solve `401` by increasing concurrency, looping retries, or copying a token into a script.

### `RangeError: Invalid string length`

An older exporter attempted to keep duplicated raw responses and serialize the full account into one JSON string. Use the sharded exporter. Do not combine all raw payloads into one in-memory object.

### Duplicate downloads

Duplicate part numbers usually mean the export button was clicked more than once or two exporter scripts were active. Compare the part number, total parts, range metadata, chat IDs, and timestamps. Keep one consistent copy per part; the organizer prefers the lexically newest filename when duplicates are otherwise consistent.

### Export appears slower

Concurrency is deliberately conservative to reduce rate limiting and session churn. Progress and resumability are more important than maximum request rate for large accounts.

### Login repeatedly expires after many chats

Resume after re-login rather than starting from part 1. If the same shard repeatedly triggers expiry, record its part number and console status codes, then inspect whether the account session lifetime or a specific response causes the stop.

## Reset only when requested

If the user explicitly wants a clean restart, open the Kimi page console and run:

```js
resetKimiHistoryExport()
```

Resetting discards resume metadata but does not delete already downloaded files. Do not reset during ordinary recovery because it causes unnecessary repeat requests and duplicate files.
