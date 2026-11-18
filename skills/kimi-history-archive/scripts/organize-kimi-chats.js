#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    limit: Infinity,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.input = argv[++index];
    else if (argument === '--output') options.output = argv[++index];
    else if (argument === '--limit') options.limit = Number(argv[++index]);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`未知参数：${argument}`);
  }

  if (!options.help && !options.input) {
    throw new Error('请使用 --input 指定任意一个 Kimi 导出分片');
  }
  if (options.input && !options.output) {
    options.output = path.join(path.dirname(path.resolve(options.input)), 'Kimi聊天记录_整理版');
  }
  if (options.limit !== Infinity && (!Number.isFinite(options.limit) || options.limit < 1)) {
    throw new Error('--limit 必须是大于 0 的数字');
  }
  return options;
}

function usage() {
  return [
    '用法：',
    '  node organize-kimi-chats.js --input 第一个分片.json [--output 输出目录] [--limit 数量]',
    '',
    '脚本会自动查找同目录下的全部分片；同一编号有多份时，选择文件名时间最新的一份。',
  ].join('\n');
}

function selectShardFiles(firstFile) {
  const absolute = path.resolve(firstFile);
  if (!fs.existsSync(absolute)) throw new Error(`找不到输入文件：${absolute}`);

  const baseName = path.basename(absolute);
  const legacyMatch = baseName.match(/^kimi-export-part-(\d+)-of-(\d+)-.+\.json$/i);
  const currentMatch = baseName.match(/^(kimi-history-.+)-part-(\d+)-of-(\d+)\.json$/i);
  if (!legacyMatch && !currentMatch) {
    throw new Error(`输入文件名不是预期的 Kimi 分片格式：${baseName}`);
  }

  const totalToken = legacyMatch ? legacyMatch[2] : currentMatch[3];
  const totalParts = Number(totalToken);
  const directory = path.dirname(absolute);
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = legacyMatch
    ? new RegExp(`^kimi-export-part-(\\d+)-of-${escapeRegExp(totalToken)}-(.+)\\.json$`, 'i')
    : new RegExp(`^${escapeRegExp(currentMatch[1])}-part-(\\d+)-of-${escapeRegExp(totalToken)}\\.json$`, 'i');
  const newestByPart = new Map();

  for (const name of fs.readdirSync(directory)) {
    const shardMatch = name.match(pattern);
    if (!shardMatch) continue;
    const part = Number(shardMatch[1]);
    const previous = newestByPart.get(part);
    if (!previous || name.localeCompare(previous.name) > 0) {
      newestByPart.set(part, { part, name, file: path.join(directory, name) });
    }
  }

  const missing = [];
  for (let part = 1; part <= totalParts; part += 1) {
    if (!newestByPart.has(part)) missing.push(part);
  }
  if (missing.length) throw new Error(`缺少分片：${missing.join(', ')}`);

  return [...newestByPart.values()].sort((left, right) => left.part - right.part);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function displayDate(value) {
  const date = safeDate(value);
  if (!date) return value || '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function filenameDate(value) {
  const date = safeDate(value);
  if (!date) return '日期未知';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function monthFolder(value) {
  const date = safeDate(value);
  if (!date) return path.join('日期未知');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return path.join(values.year, `${values.month}月`);
}

function sanitizeFilename(value, maxLength = 90) {
  const cleaned = String(value || '无标题对话')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || '无标题对话').slice(0, maxLength).trim();
}

function normalizeText(value) {
  if (typeof value === 'string') return value.replace(/\r\n/g, '\n').trim();
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

function attachmentLabel(attachment, index) {
  if (!attachment || typeof attachment !== 'object') return `附件 ${index + 1}`;
  return attachment.name
    || attachment.file_name
    || attachment.filename
    || attachment.title
    || attachment.type
    || `附件 ${index + 1}`;
}

function attachmentUrl(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  return attachment.url || attachment.download_url || attachment.file_url || attachment.content_url || null;
}

function renderAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const lines = ['', '**附件：**'];
  attachments.forEach((attachment, index) => {
    const label = String(attachmentLabel(attachment, index)).replace(/[\[\]]/g, '');
    const url = attachmentUrl(attachment);
    lines.push(url ? `- [${label}](${url})` : `- ${label}`);
  });
  return lines.join('\n');
}

function chronologicalMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message, originalIndex) => ({ ...message, originalIndex }))
    .sort((left, right) => {
      const leftTime = safeDate(left.created_at)?.getTime();
      const rightTime = safeDate(right.created_at)?.getTime();
      if (leftTime != null && rightTime != null && leftTime !== rightTime) return leftTime - rightTime;
      if (leftTime != null && rightTime == null) return -1;
      if (leftTime == null && rightTime != null) return 1;
      return right.originalIndex - left.originalIndex;
    });
}

function conversationTurns(messages) {
  const turns = [];
  let current = null;

  for (const message of chronologicalMessages(messages)) {
    const role = String(message.role || message.author_name || 'unknown').toLowerCase();
    if (role === 'user') {
      current = { question: message, answers: [], extras: [] };
      turns.push(current);
    } else if (role === 'assistant') {
      if (!current) {
        current = { question: null, answers: [], extras: [] };
        turns.push(current);
      }
      current.answers.push(message);
    } else {
      if (!current) {
        current = { question: null, answers: [], extras: [] };
        turns.push(current);
      }
      current.extras.push(message);
    }
  }
  return turns;
}

function renderMessage(message, emptyLabel) {
  if (!message) return `*${emptyLabel}*`;
  const text = normalizeText(message.text) || `*${emptyLabel}*`;
  return `${text}${renderAttachments(message.attachments)}`;
}

function renderConversation(chat, sourceFile) {
  const history = chat.history || {};
  const details = chat.chat?.chat || chat.chat || {};
  const title = history.title || details.name || details.title || '无标题对话';
  const createdAt = history.created_at || details.created_at || chronologicalMessages(chat.messages)[0]?.created_at;
  const updatedAt = history.updated_at || details.updated_at || chronologicalMessages(chat.messages).at(-1)?.updated_at;
  const href = history.href
    ? (history.href.startsWith('http') ? history.href : `https://www.kimi.com${history.href}`)
    : (chat.chat_id ? `https://www.kimi.com/chat/${chat.chat_id}` : null);
  const turns = conversationTurns(chat.messages);
  const lines = [
    `# ${title}`,
    '',
    `- 创建时间：${displayDate(createdAt)}`,
    `- 更新时间：${displayDate(updatedAt)}`,
    `- 对话 ID：\`${chat.chat_id || '未知'}\``,
    `- 来源分片：\`${sourceFile}\``,
  ];
  if (href) lines.push(`- 原对话：[在 Kimi 中打开](${href})`);
  lines.push('', '---', '');

  if (turns.length === 0) {
    lines.push('*这个对话没有导出到消息正文。*', '');
  }

  turns.forEach((turn, index) => {
    lines.push(`## 第 ${index + 1} 轮`, '', '### 问题', '');
    lines.push(renderMessage(turn.question, '未导出到用户问题'));
    lines.push('', '### Kimi 回答', '');
    if (turn.answers.length === 0) {
      lines.push('*未导出到对应回答，可能该对话当时没有回答，或导出时会话已失效。*');
    } else {
      turn.answers.forEach((answer, answerIndex) => {
        if (answerIndex > 0) lines.push('', `#### 回答 ${answerIndex + 1}`, '');
        lines.push(renderMessage(answer, '回答内容为空'));
      });
    }
    if (turn.extras.length) {
      lines.push('', '### 其他消息', '');
      turn.extras.forEach((extra) => lines.push(renderMessage(extra, '消息内容为空'), ''));
    }
    lines.push('', '---', '');
  });

  return { title, createdAt, updatedAt, href, markdown: lines.join('\n') };
}

function markdownLinkPath(relativePath) {
  return relativePath.split(path.sep).map(encodeURIComponent).join('/');
}

function organize(options) {
  const shards = selectShardFiles(options.input);
  const output = path.resolve(options.output);
  const conversationsRoot = path.join(output, '对话');
  fs.mkdirSync(conversationsRoot, { recursive: true });

  const indexRows = [];
  const seenIds = new Set();
  let exported = 0;
  let skippedDuplicates = 0;
  let missingAnswers = 0;

  for (const shard of shards) {
    if (exported >= options.limit) break;
    const data = JSON.parse(fs.readFileSync(shard.file, 'utf8'));
    for (const chat of data.chats || []) {
      if (exported >= options.limit) break;
      const dedupeKey = chat.chat_id || `${shard.part}:${exported}`;
      if (seenIds.has(dedupeKey)) {
        skippedDuplicates += 1;
        continue;
      }
      seenIds.add(dedupeKey);

      const rendered = renderConversation(chat, shard.name);
      const folder = path.join(conversationsRoot, monthFolder(rendered.createdAt));
      fs.mkdirSync(folder, { recursive: true });
      const shortId = String(chat.chat_id || exported + 1).slice(0, 8);
      const fileName = `${filenameDate(rendered.createdAt)}__${sanitizeFilename(rendered.title)}__${shortId}.md`;
      const destination = path.join(folder, fileName);
      fs.writeFileSync(destination, `${rendered.markdown}\n`, 'utf8');

      const relative = path.relative(output, destination);
      const turns = conversationTurns(chat.messages);
      missingAnswers += turns.filter((turn) => turn.question && turn.answers.length === 0).length;
      indexRows.push({
        title: rendered.title.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '),
        createdAt: displayDate(rendered.createdAt),
        messages: Array.isArray(chat.messages) ? chat.messages.length : 0,
        link: markdownLinkPath(relative),
      });
      exported += 1;
    }
  }

  const generatedAt = displayDate(new Date().toISOString());
  const readme = [
    '# Kimi 聊天记录（整理版）',
    '',
    `- 生成时间：${generatedAt}`,
    `- 对话数量：${exported}`,
    `- 输入分片：${shards.length}`,
    `- 跳过重复对话：${skippedDuplicates}`,
    `- 没有对应回答的问题：${missingAnswers}`,
    '',
    '> 对话已按消息时间重新排序，并整理为“问题 → Kimi 回答”。原始 JSON 文件没有被修改。',
    '',
    '## 使用方法',
    '',
    '点击下面的标题即可打开对应对话。也可以进入“对话”文件夹，按年份和月份浏览。',
    '',
    '## 对话目录',
    '',
    '| 日期 | 标题 | 消息数 |',
    '| --- | --- | ---: |',
    ...indexRows.map((row) => `| ${row.createdAt} | [${row.title}](${row.link}) | ${row.messages} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(output, 'README.md'), readme, 'utf8');

  const report = {
    generated_at: new Date().toISOString(),
    input_directory: path.dirname(path.resolve(options.input)),
    output_directory: output,
    selected_shards: shards.map((shard) => shard.name),
    exported_conversations: exported,
    skipped_duplicate_conversations: skippedDuplicates,
    questions_without_answers: missingAnswers,
  };
  fs.writeFileSync(path.join(output, '整理报告.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv);
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    const report = organize(options);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(`整理失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  chronologicalMessages,
  conversationTurns,
  selectShardFiles,
  sanitizeFilename,
  organize,
};


