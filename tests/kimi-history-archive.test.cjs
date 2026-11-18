'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  chronologicalMessages,
  conversationTurns,
  organize,
  selectShardFiles,
} = require('../skills/kimi-history-archive/scripts/organize-kimi-chats.js');

function writeShard(directory, part, stamp, chats) {
  const file = path.join(directory, `kimi-export-part-${String(part).padStart(3, '0')}-of-2-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ part, total_parts: 2, chats }), 'utf8');
  return file;
}

function chat(id, title, messages) {
  return {
    chat_id: id,
    history: {
      title,
      href: `/chat/${id}`,
      created_at: messages.at(-1)?.created_at,
    },
    messages,
  };
}

test('restores question-answer order from reverse API order', () => {
  const messages = [
    { role: 'assistant', created_at: '2026-01-01T00:00:02.000002Z', text: 'answer 2' },
    { role: 'user', created_at: '2026-01-01T00:00:02.000001Z', text: 'question 2' },
    { role: 'assistant', created_at: '2026-01-01T00:00:01.000002Z', text: 'answer 1' },
    { role: 'user', created_at: '2026-01-01T00:00:01.000001Z', text: 'question 1' },
  ];

  assert.deepEqual(
    chronologicalMessages(messages).map((message) => message.text),
    ['question 1', 'answer 1', 'question 2', 'answer 2'],
  );
  const turns = conversationTurns(messages);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].question.text, 'question 1');
  assert.equal(turns[0].answers[0].text, 'answer 1');
});

test('selects the newest duplicate part and builds a readable archive', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-history-archive-'));
  try {
    writeShard(temporary, 1, '2026-01-01T00-00-00-000Z', [
      chat('old-chat', 'old duplicate', [{ role: 'user', created_at: '2026-01-01T00:00:00Z', text: 'old' }]),
    ]);
    const input = writeShard(temporary, 1, '2026-01-01T00-00-01-000Z', [
      chat('chat-1', 'first chat', [
        { role: 'assistant', created_at: '2026-01-01T00:00:00.000002Z', text: 'answer' },
        { role: 'user', created_at: '2026-01-01T00:00:00.000001Z', text: 'question' },
      ]),
    ]);
    writeShard(temporary, 2, '2026-01-01T00-00-02-000Z', [
      chat('chat-2', 'second chat', [{ role: 'user', created_at: '2026-01-02T00:00:00Z', text: 'unanswered' }]),
    ]);

    const selected = selectShardFiles(input);
    assert.equal(selected.length, 2);
    assert.match(selected[0].name, /00-00-01-000Z/);

    const output = path.join(temporary, 'readable');
    const report = organize({ input, output, limit: Infinity });
    assert.equal(report.exported_conversations, 2);
    assert.equal(report.questions_without_answers, 1);
    assert.equal(fs.existsSync(path.join(output, 'README.md')), true);
    assert.equal(fs.existsSync(path.join(output, '整理报告.json')), true);

    const markdownFiles = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target);
        else if (target.endsWith('.md')) markdownFiles.push(target);
      }
    };
    walk(path.join(output, '对话'));
    assert.equal(markdownFiles.length, 2);
    const first = fs.readFileSync(markdownFiles.find((file) => file.includes('first chat')), 'utf8');
    assert.ok(first.indexOf('question') < first.indexOf('answer'));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('recognizes current exporter filenames with a stable export id', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-history-current-'));
  try {
    const first = path.join(temporary, 'kimi-history-2026-01-01T00-00-00-000Z-ab12cd34-part-001-of-002.json');
    const second = path.join(temporary, 'kimi-history-2026-01-01T00-00-00-000Z-ab12cd34-part-002-of-002.json');
    fs.writeFileSync(first, JSON.stringify({ chats: [] }), 'utf8');
    fs.writeFileSync(second, JSON.stringify({ chats: [] }), 'utf8');
    assert.deepEqual(selectShardFiles(first).map((shard) => shard.part), [1, 2]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
