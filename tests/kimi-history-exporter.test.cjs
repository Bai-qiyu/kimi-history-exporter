const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'kimi-history-exporter.user.js'), 'utf8')

class StorageMock {
  constructor() {
    this.values = new Map()
  }

  get length() {
    return this.values.size
  }

  key(index) {
    return [...this.values.keys()][index] ?? null
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }

  removeItem(key) {
    this.values.delete(key)
  }
}

function jsonResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}

function createHarness({ chatCount, failOnceAtChatId = null, storedTokens = [] }) {
  const localStorage = new StorageMock()
  const sessionStorage = new StorageMock()
  const downloads = []
  const blobs = new Map()
  const calls = []
  let button
  let nextBlobId = 1
  let shouldFail = Boolean(failOnceAtChatId)

  storedTokens.forEach((token, index) => localStorage.setItem(`kimi-token-${index}`, token))

  class MockURL extends URL {}
  MockURL.createObjectURL = (blob) => {
    const url = `blob:mock-${nextBlobId++}`
    blobs.set(url, blob)
    return url
  }
  MockURL.revokeObjectURL = () => {}

  const document = {
    cookie: '',
    body: {
      appendChild: () => {},
    },
    createElement: (tagName) => {
      if (tagName === 'button') {
        const listeners = new Map()
        button = {
          disabled: false,
          style: {},
          textContent: '',
          addEventListener: (name, listener) => listeners.set(name, listener),
          click: () => listeners.get('click')?.(),
        }
        return button
      }
      if (tagName === 'a') {
        return {
          href: '',
          download: '',
          click() {
            downloads.push({ filename: this.download, blob: blobs.get(this.href) })
          },
          remove: () => {},
        }
      }
      throw new Error(`Unexpected element: ${tagName}`)
    },
  }

  const chats = Array.from({ length: chatCount }, (_, index) => ({
    id: `chat-${index + 1}`,
    name: `Chat ${index + 1}`,
    createTime: '2026-11-18T08:00:00Z',
    updateTime: '2026-11-18T08:01:00Z',
  }))

  const fetch = async (url, options) => {
    const pathName = new URL(url).pathname
    const payload = JSON.parse(options.body)
    calls.push({ headers: options.headers, pathName, payload })
    if (pathName.endsWith('/kimi.chat.v1.ChatService/ListChats')) {
      return jsonResponse(200, { chats, nextPageToken: '' })
    }
    if (pathName.endsWith('/kimi.gateway.chat.v1.ChatService/GetChat')) {
      if (shouldFail && payload.chat_id === failOnceAtChatId) {
        shouldFail = false
        return jsonResponse(401, { message: 'expired' })
      }
      return jsonResponse(200, { id: payload.chat_id, name: payload.chat_id })
    }
    if (pathName.endsWith('/kimi.gateway.chat.v1.ChatService/ListMessages')) {
      return jsonResponse(200, {
        messages: [
          {
            id: `${payload.chat_id}-assistant`,
            role: 'assistant',
            text: 'Answer',
            createTime: '2026-11-18T08:00:00Z',
          },
          {
            id: `${payload.chat_id}-user`,
            role: 'user',
            text: 'Question',
            createTime: '2026-11-18T08:00:00Z',
          },
        ],
      })
    }
    throw new Error(`Unexpected endpoint: ${pathName}`)
  }

  const window = {
    localStorage,
    sessionStorage,
    addEventListener: () => {},
  }
  const context = vm.createContext({
    Blob,
    URL: MockURL,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    console: { ...console, error: () => {} },
    crypto: { randomUUID: () => '11111111-2222-3333-4444-555555555555' },
    document,
    fetch,
    localStorage,
    location: { origin: 'https://www.kimi.com', href: 'https://www.kimi.com/chat/history' },
    navigator: { language: 'en-US', userAgent: 'test' },
    sessionStorage,
    setTimeout: (callback, milliseconds) => setTimeout(callback, Math.min(milliseconds, 5)),
    clearTimeout,
    window,
  })

  vm.runInContext(scriptSource, context)
  return { button, calls, downloads, localStorage }
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for exporter')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('exports chronological compact messages and ignores a duplicate click', async () => {
  const harness = createHarness({ chatCount: 2 })
  harness.button.click()
  harness.button.click()
  await waitUntil(() => !harness.button.disabled)

  assert.equal(harness.downloads.length, 2)
  const bundle = JSON.parse(await harness.downloads[0].blob.text())
  assert.deepEqual(bundle.chats[0].messages.map((message) => message.role), ['user', 'assistant'])
  assert.equal(bundle.chats[0].messages[0].raw, undefined)
  assert.deepEqual(bundle.chats[0].message_pages, [])
  assert.equal(harness.calls.filter((call) => call.pathName.endsWith('/GetChat')).length, 2)
})

test('splits large exports into self-contained shards', async () => {
  const harness = createHarness({ chatCount: 101 })
  harness.button.click()
  await waitUntil(() => !harness.button.disabled)

  assert.equal(harness.downloads.length, 3)
  assert.match(harness.downloads[0].filename, /part-001-of-2/)
  assert.match(harness.downloads[1].filename, /part-002-of-2/)
  assert.match(harness.downloads[2].filename, /manifest\.json$/)
  const secondBundle = JSON.parse(await harness.downloads[1].blob.text())
  assert.equal(secondBundle.chats.length, 1)
  assert.equal(secondBundle.chats[0].chat_id, 'chat-101')
})

test('stops on 401 and resumes from the last downloaded shard', async () => {
  const harness = createHarness({ chatCount: 101, failOnceAtChatId: 'chat-101' })
  harness.button.click()
  await waitUntil(() => !harness.button.disabled)

  assert.equal(harness.downloads.length, 1)
  assert.match(harness.button.textContent, /Login expired/)
  const savedProgress = JSON.parse(harness.localStorage.getItem('kimi-history-exporter-progress-v1'))
  assert.equal(savedProgress.completed_chat_ids.length, 100)
  assert.equal(savedProgress.next_part, 2)

  harness.button.click()
  await waitUntil(() => !harness.button.disabled)

  assert.equal(harness.downloads.length, 3)
  assert.match(harness.downloads[1].filename, /part-002-of-2/)
  assert.match(harness.downloads[2].filename, /manifest\.json$/)
  assert.equal(harness.localStorage.getItem('kimi-history-exporter-progress-v1'), null)
  const secondBundle = JSON.parse(await harness.downloads[1].blob.text())
  assert.equal(secondBundle.chats.length, 1)
  assert.equal(secondBundle.chats[0].chat_id, 'chat-101')
})

test('prefers a current access token over an expired stored token', async () => {
  const expired = jwt({ typ: 'access', exp: Math.floor(Date.now() / 1000) - 60 })
  const current = jwt({ typ: 'access', exp: Math.floor(Date.now() / 1000) + 3600 })
  const harness = createHarness({ chatCount: 1, storedTokens: [expired, current] })
  harness.button.click()
  await waitUntil(() => !harness.button.disabled)

  assert.ok(harness.calls.length > 0)
  assert.equal(harness.calls[0].headers.authorization, `Bearer ${current}`)
})
