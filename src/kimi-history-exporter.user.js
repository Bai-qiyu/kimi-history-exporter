// ==UserScript==
// @name         Kimi History Exporter
// @namespace    https://github.com/Bai-qiyu/kimi-history-exporter
// @version      0.1.0
// @description  Resumable, local-first bulk history exporter for Kimi web
// @homepageURL  https://github.com/Bai-qiyu/kimi-history-exporter
// @supportURL   https://github.com/Bai-qiyu/kimi-history-exporter/issues
// @downloadURL  https://raw.githubusercontent.com/Bai-qiyu/kimi-history-exporter/main/src/kimi-history-exporter.user.js
// @updateURL    https://raw.githubusercontent.com/Bai-qiyu/kimi-history-exporter/main/src/kimi-history-exporter.user.js
// @match        https://www.kimi.com/chat/history*
// @grant        none
// ==/UserScript==

(function () {
  const SCRIPT_ID = 'kimi-history-exporter'
  if (window[SCRIPT_ID]) return
  window[SCRIPT_ID] = true

  const API_BASE = 'https://www.kimi.com/apiv2'
  const PAGE_SIZE = 1000
  const CONCURRENCY = 1
  const CHUNK_SIZE = 100
  const MAX_RETRIES = 4
  const BASE_RETRY_DELAY_MS = 750
  const PROGRESS_KEY = 'kimi-history-exporter-progress-v1'
  const LOCK_KEY = 'kimi-history-exporter-lock-v1'
  const LOCK_TTL_MS = 30_000

  function decodeJwtPayload(token) {
    if (typeof token !== 'string') return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    try {
      const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
      return JSON.parse(atob(padded))
    } catch {
      return null
    }
  }

  function tokenScore(token) {
    const payload = decodeJwtPayload(token)
    if (!payload || typeof payload !== 'object') return 0
    const expiresAt = Number(payload.exp || 0)
    if (expiresAt && expiresAt <= Math.floor(Date.now() / 1000) + 5) return -1
    const typ = String(payload.typ || '').toLowerCase()
    const typeScore = typ === 'access' ? 100 : typ === 'refresh' ? 10 : 1
    return typeScore + Math.min(expiresAt / 1_000_000_000, 10)
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`))
    return match ? decodeURIComponent(match[1]) : ''
  }

  function getStoredTokens(storage) {
    const tokens = []
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (!key || !/kimi|token|auth/i.test(key)) continue
        const rawValue = storage.getItem(key)
        if (!rawValue) continue
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(rawValue)) tokens.push(rawValue)
        try {
          const parsed = JSON.parse(rawValue)
          for (const candidateKey of ['token', 'access_token', 'accessToken', 'kimi-auth']) {
            const candidateValue = parsed?.[candidateKey]
            if (typeof candidateValue === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidateValue)) {
              tokens.push(candidateValue)
            }
          }
        } catch {
          // Ignore non-JSON storage values.
        }
      }
    } catch {
      // Ignore storage access issues.
    }
    return tokens
  }

  function pickBestToken(candidates) {
    const valid = [...new Set(candidates.filter((token) => typeof token === 'string' && token && tokenScore(token) >= 0))]
    valid.sort((left, right) => tokenScore(right) - tokenScore(left))
    return valid[0] || ''
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  function retryDelay(response, attempt) {
    const retryAfter = response?.headers?.get?.('retry-after')
    if (retryAfter) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
      const date = Date.parse(retryAfter)
      if (Number.isFinite(date)) return Math.max(0, date - Date.now())
    }
    return BASE_RETRY_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * BASE_RETRY_DELAY_MS)
  }

  function isRetryableStatus(status) {
    return [408, 425, 429, 500, 502, 503, 504].includes(status)
  }

  function guessFilename(url, fallback) {
    try {
      const parsed = new URL(url)
      const filename = parsed.searchParams.get('filename') || parsed.pathname.split('/').pop() || fallback
      return filename.trim() || fallback
    } catch {
      return fallback
    }
  }

  function readStorageValue(pattern) {
    for (const storage of [window.localStorage, window.sessionStorage]) {
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index)
          if (!key || !pattern.test(key)) continue
          const value = storage.getItem(key)
          if (typeof value === 'string' && value.trim()) return value.trim()
        }
      } catch {
        // Ignore storage access issues.
      }
    }
    return ''
  }

  function sessionHeaders() {
    const trafficId = readStorageValue(/traffic/i) || `kimi-export-${Date.now().toString(36)}`
    const deviceId = readStorageValue(/device[_-]?id/i)
    const sessionId = readStorageValue(/session[_-]?id/i)
    const headers = {
      'x-msh-platform': 'web',
      'x-msh-version': '1.0.0',
      'x-traffic-id': trafficId,
    }
    if (deviceId) headers['x-msh-device-id'] = deviceId
    if (sessionId) headers['x-msh-session-id'] = sessionId
    return headers
  }

  function buildHeaders() {
    const token = pickBestToken([
      getCookie('kimi-auth'),
      ...getStoredTokens(window.localStorage),
      ...getStoredTokens(window.sessionStorage),
    ])
    const headers = {
      'accept': 'application/json, text/plain, */*',
      'connect-protocol-version': '1',
      'content-type': 'application/json',
      'r-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      'x-language': navigator.language || 'en-US',
      ...sessionHeaders(),
    }
    if (token) headers.authorization = `Bearer ${token}`
    return headers
  }

  async function apiCall(path, payload) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let response
      try {
        response = await fetch(`${API_BASE}${path}`, {
          method: 'POST',
          credentials: 'include',
          headers: buildHeaders(),
          body: JSON.stringify(payload),
        })
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await sleep(retryDelay(null, attempt))
          continue
        }
        throw error
      }

      if (response.ok) return response.json()

      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        await sleep(retryDelay(response, attempt))
        continue
      }

      const text = await response.text()
      const error = new Error(`${path} failed with ${response.status}: ${text.slice(0, 300)}`)
      error.status = response.status
      throw error
    }
    throw new Error(`${path} failed after retries`)
  }

  function textOf(element, selector) {
    return element.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() || ''
  }

  function groupLabelForDate(value) {
    if (!value) return 'Unknown'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return 'Unknown'
    const now = new Date()
    const sameYear = date.getFullYear() === now.getFullYear()
    const sameMonth = sameYear && date.getMonth() === now.getMonth()
    if (sameMonth) return 'This Month'
    if (sameYear) return 'This Year'
    return `Year ${date.getFullYear()}`
  }

  function historyItemFromListChat(chat) {
    const attachments = Array.isArray(chat.files)
      ? chat.files.map((file) => {
          const preview = file?.parseResult?.thumbnail?.thumbnailUrl || file?.blob?.previewUrl || file?.blob?.signUrl || ''
          return {
            type: 'file',
            url: preview,
            filename: file?.meta?.name || guessFilename(preview, 'attachment'),
          }
        }).filter((item) => item.url)
      : []

    return {
      chat_id: chat.id,
      href: `${location.origin}/chat/${chat.id}?chat_enter_method=history`,
      title: chat.name || 'Untitled Kimi chat',
      date_label: (chat.updateTime || chat.createTime || '').slice(0, 10),
      preview_text: chat.messageContent || '',
      icon_url: chat?.kimiPlus?.sceneIconUrl?.dark || chat?.kimiPlus?.sceneIconUrl?.light || '',
      attachments,
      group_label: groupLabelForDate(chat.updateTime || chat.createTime),
      source: chat.source || null,
      kimi_plus: chat.kimiPlus || null,
      created_at: chat.createTime || null,
      updated_at: chat.updateTime || null,
    }
  }

  function groupHistoryItems(items) {
    const groups = []
    const map = new Map()
    for (const item of items) {
      const label = item.group_label || 'Unknown'
      if (!map.has(label)) {
        const group = { label, items: [] }
        map.set(label, group)
        groups.push(group)
      }
      map.get(label).items.push(item)
    }
    return groups
  }

  async function fetchHistoryFromApi() {
    const chats = []
    const seen = new Set()
    let pageToken = ''

    while (true) {
      const payload = { project_id: '', page_size: 50, page_token: pageToken, query: '' }
      const response = await apiCall('/kimi.chat.v1.ChatService/ListChats', payload)
      const pageChats = Array.isArray(response?.chats) ? response.chats : []
      for (const chat of pageChats) {
        if (!chat || typeof chat !== 'object' || !chat.id || seen.has(chat.id)) continue
        seen.add(chat.id)
        chats.push(historyItemFromListChat(chat))
      }
      const nextToken = typeof response?.nextPageToken === 'string' ? response.nextPageToken : ''
      if (!nextToken || nextToken === pageToken) break
      pageToken = nextToken
    }

    return groupHistoryItems(chats)
  }

  function flattenValue(value) {
    if (value == null) return ''
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) return value.map(flattenValue).filter(Boolean).join('\n\n').trim()
    if (typeof value === 'object') {
      const type = String(value.type || '').toLowerCase()
      if (['image', 'file', 'audio', 'video'].includes(type)) {
        return String(value.filename || value.name || value.title || '').trim()
      }
      const parts = []
      for (const key of ['text', 'markdown', 'content', 'display_content', 'summary', 'answer', 'query', 'body', 'value']) {
        if (value[key]) {
          const rendered = flattenValue(value[key])
          if (rendered) parts.push(rendered)
        }
      }
      for (const key of ['contents', 'parts', 'segments', 'children']) {
        if (value[key]) {
          const rendered = flattenValue(value[key])
          if (rendered) parts.push(rendered)
        }
      }
      return [...new Set(parts)].join('\n\n').trim()
    }
    return ''
  }

  function uniqueStrings(values) {
    return [...new Set(values.map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean))]
  }

  function cleanObject(value) {
    if (Array.isArray(value)) {
      const cleaned = value.map(cleanObject).filter((item) => item != null && (!(typeof item === 'string') || item))
      return cleaned.length ? cleaned : null
    }
    if (!value || typeof value !== 'object') return value == null ? null : value
    const cleanedEntries = Object.entries(value)
      .map(([key, nested]) => [key, cleanObject(nested)])
      .filter(([, nested]) => nested != null && (!(typeof nested === 'string') || nested) && (!Array.isArray(nested) || nested.length) && (!(typeof nested === 'object') || Array.isArray(nested) || Object.keys(nested).length))
    return cleanedEntries.length ? Object.fromEntries(cleanedEntries) : null
  }

  function normalizeSearchRef(ref) {
    if (!ref || typeof ref !== 'object') return null
    const base = ref.base && typeof ref.base === 'object' ? ref.base : {}
    const normalized = cleanObject({
      id: ref.id || null,
      url: typeof base.url === 'string' ? base.url : null,
      title: typeof base.title === 'string' ? base.title : null,
      snippet: typeof base.snippet === 'string' ? base.snippet : null,
      site_name: typeof base.siteName === 'string' ? base.siteName : null,
      icon_url: typeof base.iconUrl === 'string' ? base.iconUrl : null,
      publish_time: typeof base.publishTime === 'string' ? base.publishTime : null,
    })
    return normalized && normalized.url ? normalized : null
  }

  function normalizeArtifact(artifact) {
    if (!artifact || typeof artifact !== 'object') return null
    return cleanObject({
      artifact_id: artifact.artifactId || artifact.artifact_id || null,
      type: artifact.type || null,
      version: artifact.version || null,
      path: artifact.path || null,
      title: artifact.title || null,
      content: typeof artifact.content === 'string' ? artifact.content : null,
    })
  }

  function normalizeBlock(block) {
    if (!block || typeof block !== 'object') return null
    const createTime = block.createTime || block.create_time || null
    if (block.text) {
      const content = flattenValue(block.text)
      return {
        kind: 'text',
        text: content,
        created_at: createTime,
      }
    }
    if (block.think) {
      const content = flattenValue(block.think)
      return {
        kind: 'think',
        text: content,
        created_at: createTime,
      }
    }
    if (block.search && typeof block.search === 'object') {
      return cleanObject({
        kind: 'search',
        created_at: createTime,
        keywords: Array.isArray(block.search.keywords) ? uniqueStrings(block.search.keywords) : [],
        web_pages: Array.isArray(block.search.webPages)
          ? block.search.webPages.map((page) => cleanObject({
              title: page?.title || null,
              url: page?.url || null,
              snippet: page?.snippet || null,
              site_name: page?.siteName || null,
              icon_url: page?.iconUrl || null,
              publish_time: page?.publishTime || null,
            })).filter(Boolean)
          : [],
      })
    }
    if (block.tool && typeof block.tool === 'object') {
      return cleanObject({
        kind: 'tool',
        created_at: createTime,
        name: block.tool.name || null,
        status: block.tool.status || null,
        tool_call_id: block.tool.toolCallId || null,
        args: block.tool.args || null,
        contents: block.tool.contents || null,
      })
    }
    if (block.stage && typeof block.stage === 'object') {
      return cleanObject({
        kind: 'stage',
        created_at: createTime,
        name: block.stage.name || null,
        status: block.stage.status || null,
        description: block.stage.description || null,
        duration_seconds: block.stage.durationSeconds || null,
        index: block.stage.index ?? null,
        stage_created_at: block.stage.createTime || null,
      })
    }
    if (block.multiStage && typeof block.multiStage === 'object') {
      return cleanObject({
        kind: 'multi_stage',
        created_at: createTime,
        stages: Array.isArray(block.multiStage.stages)
          ? block.multiStage.stages.map((stage) => cleanObject({
              name: stage?.name || null,
              status: stage?.status || null,
              description: stage?.description || null,
              duration_seconds: stage?.durationSeconds || null,
              index: stage?.index ?? null,
              created_at: stage?.createTime || null,
            })).filter(Boolean)
          : [],
      })
    }
    if (block.artifact && typeof block.artifact === 'object') {
      return cleanObject({
        kind: 'artifact',
        created_at: createTime,
        artifact: normalizeArtifact(block.artifact),
      })
    }
    return cleanObject({
      kind: 'unknown',
      created_at: createTime,
      raw: block,
    })
  }

  function messageBlockMetadata(rawMessage) {
    const blocks = Array.isArray(rawMessage.blocks) ? rawMessage.blocks : []
    const normalizedBlocks = blocks.map(normalizeBlock).filter(Boolean)
    const textParts = []
    const thoughts = []
    const searches = []
    const tools = []
    const stages = []
    const artifacts = []

    for (const block of normalizedBlocks) {
      if (block.kind === 'text' && block.text) textParts.push(block.text)
      if (block.kind === 'think' && block.text) thoughts.push(block)
      if (block.kind === 'search') searches.push(block)
      if (block.kind === 'tool') tools.push(block)
      if (block.kind === 'stage' || block.kind === 'multi_stage') stages.push(block)
      if (block.kind === 'artifact' && block.artifact) artifacts.push(block.artifact)
    }

    const refs = cleanObject({
      search_chunks: rawMessage.refs && Array.isArray(rawMessage.refs.searchChunks)
        ? rawMessage.refs.searchChunks.map(normalizeSearchRef).filter(Boolean)
        : [],
      used_search_chunks: rawMessage.refs && Array.isArray(rawMessage.refs.usedSearchChunks)
        ? rawMessage.refs.usedSearchChunks.map(normalizeSearchRef).filter(Boolean)
        : [],
    }) || {}

    return {
      text: uniqueStrings(textParts).join('\n\n').trim(),
      metadata: cleanObject({
        blocks: normalizedBlocks,
        thoughts,
        searches,
        tools,
        stages,
        artifacts,
        refs,
        kimi_plus: rawMessage.kimiPlus || null,
        scenario: rawMessage.scenario || null,
        status: rawMessage.status || null,
        parent_id: rawMessage.parentId || null,
        children_message_ids: Array.isArray(rawMessage.childrenMessageIds) ? rawMessage.childrenMessageIds : [],
      }) || {},
    }
  }

  function isLikelyMessage(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
    const keys = new Set(Object.keys(candidate))
    if (!keys.size) return false
    if (keys.has('chat_id') && keys.size <= 3) return false
    const hasRole = ['role', 'sender', 'sender_type', 'message_type', 'is_bot', 'is_user'].some((key) => keys.has(key))
    const hasText = ['text', 'content', 'contents', 'parts', 'segments', 'answer', 'query', 'markdown', 'display_content', 'blocks'].some((key) => keys.has(key))
    const hasId = ['message_id', 'msg_id', 'id', 'uuid'].some((key) => keys.has(key))
    const hasTime = ['created_at', 'updated_at', 'timestamp', 'time', 'createTime'].some((key) => keys.has(key))
    return (hasRole && hasText) || (hasId && hasText) || (hasId && hasTime && hasRole)
  }

  function collectMessageCandidates(value, output) {
    if (!value) return
    if (Array.isArray(value)) {
      value.forEach((item) => collectMessageCandidates(item, output))
      return
    }
    if (typeof value !== 'object') return
    if (isLikelyMessage(value)) output.push(value)
    Object.values(value).forEach((nested) => collectMessageCandidates(nested, output))
  }

  function extractSourceUrl(candidate) {
    for (const key of ['url', 'src', 'image_url', 'download_url', 'file_url', 'thumbnail_url', 'thumb_url']) {
      const value = candidate?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }

  function extractAttachments(rawMessage) {
    const seen = new Set()
    const attachments = []

    function visit(value) {
      if (!value) return
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (typeof value !== 'object') return

      const sourceUrl = extractSourceUrl(value)
      if (sourceUrl) {
        const filename = String(value.filename || value.file_name || value.name || value.title || guessFilename(sourceUrl, 'attachment')).trim() || 'attachment'
        if (!seen.has(sourceUrl)) {
          seen.add(sourceUrl)
          attachments.push({
            filename,
            mime_type: typeof value.mime_type === 'string' ? value.mime_type : null,
            metadata: {
              source: 'kimi_remote_attachment',
              source_url: sourceUrl,
            },
          })
        }
      }

      Object.values(value).forEach(visit)
    }

    for (const key of ['attachments', 'files', 'images']) {
      if (rawMessage[key]) visit(rawMessage[key])
    }
    if (!attachments.length) visit(rawMessage)
    return attachments
  }

  function normalizeRole(rawMessage) {
    if (rawMessage.is_user === true) return 'user'
    if (rawMessage.is_bot === true) return 'assistant'
    for (const key of ['role', 'sender', 'sender_type', 'message_type']) {
      const value = String(rawMessage[key] || '').toLowerCase().trim()
      if (['user', 'human', 'prompt', 'questioner'].includes(value)) return 'user'
      if (['assistant', 'bot', 'kimi', 'model', 'answer'].includes(value)) return 'assistant'
      if (['system', 'developer'].includes(value)) return 'system'
      if (['tool', 'function'].includes(value)) return 'tool'
    }
    return 'unknown'
  }

  function normalizeMessage(rawMessage) {
    const parts = []
    for (const key of ['text', 'display_content', 'markdown', 'summary', 'answer', 'query', 'content', 'contents', 'parts', 'segments', 'message', 'body']) {
      if (rawMessage[key]) {
        const rendered = flattenValue(rawMessage[key])
        if (rendered) parts.push(rendered)
      }
    }
    const blockData = messageBlockMetadata(rawMessage)
    if (blockData.text) parts.push(blockData.text)
    const text = [...new Set(parts)].join('\n\n').trim()
    const attachments = extractAttachments(rawMessage)
    if (!text && !attachments.length) return null
    const role = normalizeRole(rawMessage)
    const metadata = cleanObject({
      ...blockData.metadata,
      updated_at: rawMessage.updated_at || rawMessage.updateTime || null,
    }) || {}
    return {
      message_id: rawMessage.message_id || rawMessage.msg_id || rawMessage.id || rawMessage.uuid || '',
      role,
      author_name: role === 'user' ? 'You' : role === 'assistant' ? 'Kimi' : null,
      created_at: rawMessage.created_at || rawMessage.create_time || rawMessage.createTime || rawMessage.timestamp || rawMessage.time || rawMessage.updated_at || rawMessage.updateTime || null,
      updated_at: rawMessage.updated_at || null,
      text,
      attachments,
      metadata,
    }
  }

  function getNextCursor(page) {
    if (!page || typeof page !== 'object') return ''
    for (const key of ['next_cursor', 'nextCursor', 'cursor', 'page_token', 'next_page_token']) {
      const value = page[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    for (const nested of Object.values(page)) {
      const cursor = getNextCursor(nested)
      if (cursor) return cursor
    }
    return ''
  }

  function extractNormalizedMessages(pages) {
    const candidates = []
    for (const page of pages) {
      if (Array.isArray(page?.messages) && page.messages.some((item) => isLikelyMessage(item))) {
        candidates.push(...page.messages.filter((item) => isLikelyMessage(item)))
        continue
      }
      collectMessageCandidates(page, candidates)
    }
    const seen = new Set()
    const normalized = []
    for (const candidate of candidates) {
      const normalizedMessage = normalizeMessage(candidate)
      if (!normalizedMessage) continue
      const key = normalizedMessage.message_id || `${normalizedMessage.role}:${normalizedMessage.created_at || ''}:${normalizedMessage.text.slice(0, 120)}`
      if (seen.has(key)) continue
      seen.add(key)
      normalized.push(normalizedMessage)
    }
    // Kimi returns ListMessages newest-first, including assistant replies before
    // their user prompt when both share the same second-level timestamp.
    return normalized.reverse()
  }

  async function fetchChatBundle(chat, updateStatus) {
    updateStatus(`Fetching ${chat.title || chat.chat_id}`)
    const getChat = await apiCall('/kimi.gateway.chat.v1.ChatService/GetChat', { chat_id: chat.chat_id })
    const pages = []
    const seenCursors = new Set()
    let cursor = ''

    while (true) {
      const payload = { chat_id: chat.chat_id, page_size: PAGE_SIZE }
      if (cursor) payload.cursor = cursor
      const page = await apiCall('/kimi.gateway.chat.v1.ChatService/ListMessages', payload)
      pages.push(page)
      const nextCursor = getNextCursor(page)
      if (!nextCursor || seenCursors.has(nextCursor)) break
      seenCursors.add(nextCursor)
      cursor = nextCursor
    }

    return {
      chat_id: chat.chat_id,
      history: chat,
      chat: getChat,
      message_pages: [],
      messages: extractNormalizedMessages(pages),
      warnings: [],
    }
  }

  async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length)
    let index = 0
    async function worker() {
      while (index < items.length) {
        const currentIndex = index
        index += 1
        results[currentIndex] = await mapper(items[currentIndex], currentIndex)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return results
  }

  function downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  function parseStoredJson(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null')
      return value && typeof value === 'object' ? value : null
    } catch {
      return null
    }
  }

  function makeId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  function newProgress(chats) {
    return {
      version: 1,
      export_id: `${new Date().toISOString().replace(/[:.]/g, '-')}-${makeId().slice(0, 8)}`,
      created_at: new Date().toISOString(),
      chat_ids: chats.map((chat) => chat.chat_id),
      completed_chat_ids: [],
      next_part: 1,
      total_parts: Math.ceil(chats.length / CHUNK_SIZE),
      files: [],
    }
  }

  function loadProgress(chats) {
    const progress = parseStoredJson(PROGRESS_KEY)
    if (
      progress?.version !== 1
      || typeof progress.export_id !== 'string'
      || !Array.isArray(progress.chat_ids)
      || !Array.isArray(progress.completed_chat_ids)
      || !Array.isArray(progress.files)
      || !Number.isInteger(progress.next_part)
    ) {
      return newProgress(chats)
    }
    return progress
  }

  function saveProgress(progress) {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress))
  }

  function clearProgress() {
    localStorage.removeItem(PROGRESS_KEY)
  }

  function acquireLock(runId) {
    const existing = parseStoredJson(LOCK_KEY)
    if (existing?.run_id && Date.now() - Number(existing.updated_at || 0) < LOCK_TTL_MS) return false
    localStorage.setItem(LOCK_KEY, JSON.stringify({ run_id: runId, updated_at: Date.now() }))
    return parseStoredJson(LOCK_KEY)?.run_id === runId
  }

  function refreshLock(runId) {
    if (parseStoredJson(LOCK_KEY)?.run_id !== runId) {
      const error = new Error('Another Kimi export took over this browser profile.')
      error.code = 'LOCK_LOST'
      throw error
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({ run_id: runId, updated_at: Date.now() }))
  }

  function releaseLock(runId) {
    if (parseStoredJson(LOCK_KEY)?.run_id === runId) localStorage.removeItem(LOCK_KEY)
  }

  function historyGroupsForChats(historyGroups, chatIds) {
    const included = new Set(chatIds)
    return historyGroups.map((group) => ({
      ...group,
      items: Array.isArray(group.items) ? group.items.filter((item) => included.has(item?.chat_id)) : [],
    })).filter((group) => group.items.length)
  }

  function createButton() {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = 'Export Kimi'
    button.style.position = 'fixed'
    button.style.right = '16px'
    button.style.bottom = '16px'
    button.style.zIndex = '99999'
    button.style.border = '0'
    button.style.borderRadius = '999px'
    button.style.padding = '10px 14px'
    button.style.background = '#6d28d9'
    button.style.color = '#fff'
    button.style.font = '600 13px/1.2 sans-serif'
    button.style.boxShadow = '0 8px 20px rgba(0,0,0,0.18)'
    button.style.cursor = 'pointer'
    document.body.appendChild(button)
    return button
  }

  const button = createButton()
  let activeRunId = null

  async function runExport(runId) {
    const historyGroups = await fetchHistoryFromApi()
    const chats = historyGroups.flatMap((group) => group.items)
    if (!chats.length) throw new Error('No chats found on the history page.')

    const chatsById = new Map(chats.map((chat) => [chat.chat_id, chat]))
    const progress = loadProgress(chats)
    const completedIds = new Set(progress.completed_chat_ids)
    let completed = completedIds.size
    const updateStatus = (message) => {
      refreshLock(runId)
      button.textContent = `${message} (${completed}/${progress.chat_ids.length})`
    }

    saveProgress(progress)
    updateStatus(completed ? 'Resuming' : 'Starting')

    while (completedIds.size < progress.chat_ids.length) {
      const pendingIds = progress.chat_ids.filter((chatId) => !completedIds.has(chatId))
      const chunkIds = pendingIds.slice(0, CHUNK_SIZE)
      const chunkChats = chunkIds.map((chatId) => chatsById.get(chatId) || {
        chat_id: chatId,
        title: 'Unavailable Kimi chat',
      })
      const warnings = []
      const capturedChats = await mapLimit(chunkChats, CONCURRENCY, async (chat) => {
        try {
          const result = await fetchChatBundle(chat, updateStatus)
          completed += 1
          updateStatus('Captured')
          return result
        } catch (error) {
          if (error?.status === 401) throw error
          completed += 1
          warnings.push(`${chat.chat_id}: ${error instanceof Error ? error.message : String(error)}`)
          updateStatus('Warning')
          return {
            chat_id: chat.chat_id,
            history: chat,
            chat: null,
            message_pages: [],
            messages: [],
            warnings: [error instanceof Error ? error.message : String(error)],
          }
        }
      })

      const bundle = {
        provider: 'kimi',
        schema_version: 'kimi-capture-v1',
        captured_at: new Date().toISOString(),
        exporter: { name: 'kimi-history-exporter', version: '0.1.0' },
        export_id: progress.export_id,
        part: progress.next_part,
        total_parts: progress.total_parts,
        range: {
          completed_before: completedIds.size,
          chat_count: chunkIds.length,
          total: progress.chat_ids.length,
        },
        source: {
          history_url: location.href,
          origin: location.origin,
          user_agent: navigator.userAgent,
        },
        history_groups: historyGroupsForChats(historyGroups, chunkIds),
        chats: capturedChats,
        warnings,
      }

      const paddedPart = String(progress.next_part).padStart(3, '0')
      const filename = `kimi-history-${progress.export_id}-part-${paddedPart}-of-${progress.total_parts}.json`
      downloadJson(filename, bundle)
      chunkIds.forEach((chatId) => completedIds.add(chatId))
      progress.completed_chat_ids = [...completedIds]
      progress.files.push({
        part: progress.next_part,
        filename,
        chat_count: chunkIds.length,
        warning_count: warnings.length,
      })
      progress.next_part += 1
      saveProgress(progress)
      button.textContent = `Saved part ${paddedPart}/${progress.total_parts} (${completedIds.size}/${progress.chat_ids.length})`
      await sleep(1200)
    }

    const manifestFilename = `kimi-history-${progress.export_id}-manifest.json`
    downloadJson(manifestFilename, {
      format: 'kimi-history-exporter-manifest-v1',
      exporter: { name: 'kimi-history-exporter', version: '0.1.0' },
      export_id: progress.export_id,
      created_at: progress.created_at,
      completed_at: new Date().toISOString(),
      chat_count: progress.chat_ids.length,
      files: progress.files,
    })
    clearProgress()
    button.textContent = `Exported ${progress.chat_ids.length} chats in ${progress.total_parts} parts`
  }

  button.addEventListener('click', () => {
    if (button.disabled) return
    const runId = makeId()
    if (!acquireLock(runId)) {
      button.textContent = 'Another Kimi export is already running'
      return
    }

    activeRunId = runId
    button.disabled = true
    button.style.opacity = '0.85'
    runExport(runId).catch((error) => {
      console.error('Kimi export failed', error)
      button.textContent = error?.status === 401
        ? 'Login expired - sign in, then click to resume'
        : 'Export failed - check console'
    }).finally(() => {
      releaseLock(runId)
      if (activeRunId === runId) activeRunId = null
      button.disabled = false
      button.style.opacity = '1'
    })
  })

  window.addEventListener('beforeunload', () => {
    if (activeRunId) releaseLock(activeRunId)
  })
  window.resetKimiHistoryExport = clearProgress
})()
