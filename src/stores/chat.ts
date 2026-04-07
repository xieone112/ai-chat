import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import type { ChatMessage, ChatSession, ChatStats, UsageMetrics } from '../types/chat'
import { chatCompletionsStream } from '../services/zhipu'
import type { InputMessage, StreamMeta } from '../services/zhipu'

const STORAGE_KEY = 'vue-ai-chat/sessions'
const SETTINGS_KEY = 'vue-ai-chat/settings'
const METRICS_KEY = 'vue-ai-chat/metrics'

interface ChatSettings {
  promptTemplateId: string
  customSystemPrompt: string
  selectedModel: string
}

interface PromptTemplate {
  id: string
  name: string
  content: string
}

const PROMPT_TEMPLATES: PromptTemplate[] = [
  { id: 'general', name: '通用助手', content: '你是一个专业、友好、简洁的 AI 助手。' },
  {
    id: 'interviewer',
    name: '面试官',
    content: '你是一位技术面试官，请通过追问引导候选人深入分析并给出改进建议。',
  },
  {
    id: 'translator',
    name: '中英翻译',
    content: '你是专业翻译助手，保持原意、术语准确、语气自然。',
  },
  {
    id: 'writer',
    name: '写作助手',
    content: '你是写作教练，帮助用户优化结构、逻辑与表达，让内容清晰有说服力。',
  },
  { id: 'custom', name: '自定义人设', content: '' },
]

const MODEL_OPTIONS = ['glm-4-flash', 'glm-4-plus']

function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 1.8))
}

function createEmptySession(): ChatSession {
  const now = Date.now()
  return {
    id: uid('session'),
    title: '新会话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    tags: [],
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function normalizeImportedSession(input: unknown): ChatSession {
  const now = Date.now()
  const source = (input ?? {}) as Partial<ChatSession>
  const messages = Array.isArray(source.messages) ? source.messages : []

  return {
    id: uid('session'),
    title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : '导入会话',
    createdAt: typeof source.createdAt === 'number' ? source.createdAt : now,
    updatedAt: typeof source.updatedAt === 'number' ? source.updatedAt : now,
    tags: Array.isArray(source.tags)
      ? source.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      : [],
    messages: messages
      .map((m) => {
        const msg = m as Partial<ChatMessage>
        const role = msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user'
        const content = typeof msg.content === 'string' ? msg.content : ''

        return {
          id: uid('msg'),
          role,
          content,
          createdAt: typeof msg.createdAt === 'number' ? msg.createdAt : now,
          status: msg.status,
          replyToMessageId: msg.replyToMessageId,
        } as ChatMessage
      })
      .filter((m) => m.content.trim() !== ''),
  }
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<ChatSession[]>([])
  const activeSessionId = ref<string>('')
  const loading = ref(false)
  const abortController = ref<AbortController | null>(null)

  const promptTemplateId = ref<string>('general')
  const customSystemPrompt = ref<string>('')
  const selectedModel = ref<string>('glm-4-flash')

  const quoteMessageId = ref<string>('')
  const selectedMessageIds = ref<string[]>([])
  const pendingMeta = ref<StreamMeta>({ retryCount: 0, backoffMs: 0 })

  const stats = ref<ChatStats>({
    requestCount: 0,
    avgLatencyMs: 0,
    lastLatencyMs: 0,
    estimatedTokens: 0,
    lastRetryCount: 0,
    lastBackoffMs: 0,
  })

  const metrics = ref<UsageMetrics>({
    modelUsage: {},
    totalRequests: 0,
    totalRetries: 0,
    avgTurns: 0,
  })

  const promptTemplates = PROMPT_TEMPLATES
  const modelOptions = MODEL_OPTIONS

  const activeSession = computed(() =>
    sessions.value.find((s) => s.id === activeSessionId.value),
  )

  const activeMessages = computed(() => activeSession.value?.messages ?? [])

  const selectedMessages = computed(() =>
    activeMessages.value.filter((m) => selectedMessageIds.value.includes(m.id)),
  )

  const resolvedSystemPrompt = computed(() => {
    if (promptTemplateId.value === 'custom') {
      return customSystemPrompt.value.trim()
    }

    const tpl = promptTemplates.find((t) => t.id === promptTemplateId.value)
    return tpl?.content ?? promptTemplates[0].content
  })

  function persistSessions() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions.value))
  }

  function persistSettings() {
    const data: ChatSettings = {
      promptTemplateId: promptTemplateId.value,
      customSystemPrompt: customSystemPrompt.value,
      selectedModel: selectedModel.value,
    }
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(data))
  }

  function persistMetrics() {
    localStorage.setItem(METRICS_KEY, JSON.stringify(metrics.value))
  }

  function loadSettings() {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return

    try {
      const parsed = JSON.parse(raw) as Partial<ChatSettings>
      if (
        parsed.promptTemplateId &&
        promptTemplates.some((t) => t.id === parsed.promptTemplateId)
      ) {
        promptTemplateId.value = parsed.promptTemplateId
      }
      if (typeof parsed.customSystemPrompt === 'string') {
        customSystemPrompt.value = parsed.customSystemPrompt
      }
      if (parsed.selectedModel && modelOptions.includes(parsed.selectedModel)) {
        selectedModel.value = parsed.selectedModel
      }
    } catch {
      // ignore invalid settings
    }
  }

  function loadMetrics() {
    const raw = localStorage.getItem(METRICS_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as Partial<UsageMetrics>
      if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
        metrics.value.modelUsage = parsed.modelUsage as Record<string, number>
      }
      if (typeof parsed.totalRequests === 'number') metrics.value.totalRequests = parsed.totalRequests
      if (typeof parsed.totalRetries === 'number') metrics.value.totalRetries = parsed.totalRetries
      if (typeof parsed.avgTurns === 'number') metrics.value.avgTurns = parsed.avgTurns
    } catch {
      // ignore
    }
  }

  function load() {
    loadSettings()
    loadMetrics()

    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      const s = createEmptySession()
      sessions.value = [s]
      activeSessionId.value = s.id
      persistSessions()
      return
    }

    try {
      const parsed = JSON.parse(raw) as ChatSession[]
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('invalid sessions')
      }
      sessions.value = parsed.map((s) => ({ ...s, tags: s.tags ?? [] }))
      activeSessionId.value = parsed[0].id
    } catch {
      const s = createEmptySession()
      sessions.value = [s]
      activeSessionId.value = s.id
      persistSessions()
    }
  }

  function createSession() {
    const s = createEmptySession()
    sessions.value.unshift(s)
    activeSessionId.value = s.id
    persistSessions()
  }

  function switchSession(id: string) {
    activeSessionId.value = id
    quoteMessageId.value = ''
    selectedMessageIds.value = []
  }

  function removeSession(id: string) {
    const idx = sessions.value.findIndex((s) => s.id === id)
    if (idx < 0) return
    sessions.value.splice(idx, 1)

    if (sessions.value.length === 0) {
      const s = createEmptySession()
      sessions.value = [s]
      activeSessionId.value = s.id
    } else if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0].id
    }

    persistSessions()
  }

  function setPromptTemplate(id: string) {
    if (!promptTemplates.some((t) => t.id === id)) return
    promptTemplateId.value = id
    persistSettings()
  }

  function setCustomSystemPrompt(prompt: string) {
    customSystemPrompt.value = prompt
    persistSettings()
  }

  function setSelectedModel(model: string) {
    if (!modelOptions.includes(model)) return
    selectedModel.value = model
    persistSettings()
  }

  function addTagToActiveSession(tag: string) {
    const session = activeSession.value
    if (!session) return
    const cleaned = tag.trim()
    if (!cleaned) return

    session.tags = session.tags ?? []
    if (!session.tags.includes(cleaned)) {
      session.tags.push(cleaned)
      session.updatedAt = Date.now()
      persistSessions()
    }
  }

  function removeTagFromActiveSession(tag: string) {
    const session = activeSession.value
    if (!session?.tags) return
    session.tags = session.tags.filter((t) => t !== tag)
    session.updatedAt = Date.now()
    persistSessions()
  }

  function setQuoteMessage(messageId: string) {
    quoteMessageId.value = messageId
  }

  function clearQuoteMessage() {
    quoteMessageId.value = ''
  }

  function toggleSelectMessage(messageId: string) {
    if (selectedMessageIds.value.includes(messageId)) {
      selectedMessageIds.value = selectedMessageIds.value.filter((id) => id !== messageId)
    } else {
      selectedMessageIds.value.push(messageId)
    }
  }

  function clearSelectedMessages() {
    selectedMessageIds.value = []
  }

  function stopGenerating() {
    if (!loading.value) return
    abortController.value?.abort()
  }

  function exportActiveSessionAsJson(): string {
    const session = activeSession.value
    if (!session) return '{}'
    return JSON.stringify(session, null, 2)
  }

  function exportActiveSessionAsMarkdown(): string {
    const session = activeSession.value
    if (!session) return '# 空会话\n'

    const lines: string[] = [
      `# ${session.title}`,
      '',
      `- 会话ID: ${session.id}`,
      `- 创建时间: ${formatTime(session.createdAt)}`,
      `- 更新时间: ${formatTime(session.updatedAt)}`,
      `- 标签: ${(session.tags ?? []).join(', ') || '无'}`,
      '',
      '---',
      '',
    ]

    for (const msg of session.messages) {
      const role = msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'AI' : 'System'
      lines.push(`## ${role} · ${formatTime(msg.createdAt)}`)
      lines.push('')
      lines.push(msg.content || '（空内容）')
      lines.push('')
    }

    return lines.join('\n')
  }

  function exportSelectedMessagesAsJson(): string {
    return JSON.stringify(selectedMessages.value, null, 2)
  }

  function exportSelectedMessagesAsMarkdown(): string {
    const lines: string[] = ['# 选中消息导出', '']
    for (const msg of selectedMessages.value) {
      const role = msg.role === 'user' ? '你' : msg.role === 'assistant' ? 'AI' : 'System'
      lines.push(`## ${role} · ${formatTime(msg.createdAt)}`)
      lines.push('')
      lines.push(msg.content || '（空内容）')
      lines.push('')
    }
    return lines.join('\n')
  }

  function importSessionFromJson(jsonText: string) {
    const parsed = JSON.parse(jsonText) as unknown
    const session = normalizeImportedSession(parsed)

    if (session.messages.length === 0) {
      throw new Error('导入失败：会话中没有可用消息')
    }

    sessions.value.unshift(session)
    activeSessionId.value = session.id
    persistSessions()
  }

  function buildModelMessages(session: ChatSession): InputMessage[] {
    const context = session.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }))

    const systemPrompt = resolvedSystemPrompt.value
    return systemPrompt ? [{ role: 'system', content: systemPrompt }, ...context] : context
  }

  function updateStats(latencyMs: number, answerText: string, session: ChatSession) {
    const nextCount = stats.value.requestCount + 1
    const prevAvg = stats.value.avgLatencyMs
    stats.value.requestCount = nextCount
    stats.value.lastLatencyMs = latencyMs
    stats.value.avgLatencyMs = Math.round((prevAvg * (nextCount - 1) + latencyMs) / nextCount)
    stats.value.estimatedTokens += estimateTokens(answerText)
    stats.value.lastRetryCount = pendingMeta.value.retryCount
    stats.value.lastBackoffMs = pendingMeta.value.backoffMs

    metrics.value.totalRequests += 1
    metrics.value.totalRetries += pendingMeta.value.retryCount
    metrics.value.modelUsage[selectedModel.value] = (metrics.value.modelUsage[selectedModel.value] ?? 0) + 1

    const turns = Math.max(1, Math.floor(session.messages.filter((m) => m.role === 'user').length))
    const prevTurnsAvg = metrics.value.avgTurns
    const req = metrics.value.totalRequests
    metrics.value.avgTurns = Number(((prevTurnsAvg * (req - 1) + turns) / req).toFixed(2))

    persistMetrics()
  }

  async function runAssistantReply(session: ChatSession, assistantMessage: ChatMessage) {
    loading.value = true
    abortController.value = new AbortController()
    pendingMeta.value = { retryCount: 0, backoffMs: 0 }
    const start = performance.now()

    try {
      const finalMessages = buildModelMessages(session)

      await chatCompletionsStream(
        finalMessages,
        (delta) => {
          assistantMessage.content += delta
        },
        abortController.value.signal,
        selectedModel.value,
        (meta) => {
          pendingMeta.value = meta
        },
      )

      if (!assistantMessage.content.trim()) {
        assistantMessage.content = '（空响应）'
      }
      assistantMessage.status = 'done'

      const latency = Math.round(performance.now() - start)
      updateStats(latency, assistantMessage.content, session)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        assistantMessage.status = 'done'
        assistantMessage.content = assistantMessage.content || '（已停止生成）'
      } else {
        assistantMessage.content =
          err instanceof Error ? `请求失败：${err.message}` : '请求失败，请稍后重试。'
        assistantMessage.status = 'error'
      }
    } finally {
      loading.value = false
      abortController.value = null
      session.updatedAt = Date.now()
      persistSessions()
    }
  }

  async function sendMessage(content: string) {
    const session = activeSession.value
    if (!session || !content.trim() || loading.value) return

    const userMessage: ChatMessage = {
      id: uid('msg'),
      role: 'user',
      content,
      createdAt: Date.now(),
      status: 'done',
      replyToMessageId: quoteMessageId.value || undefined,
    }

    const assistantMessage: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
      replyToMessageId: quoteMessageId.value || undefined,
    }

    session.messages.push(userMessage, assistantMessage)
    quoteMessageId.value = ''
    session.updatedAt = Date.now()
    if (session.title === '新会话') {
      session.title = content.slice(0, 16)
    }
    persistSessions()

    await runAssistantReply(session, assistantMessage)
  }

  async function retryFailedMessage(messageId: string) {
    const session = activeSession.value
    if (!session || loading.value) return

    const msg = session.messages.find((m) => m.id === messageId)
    if (!msg || msg.role !== 'assistant' || msg.status !== 'error') return

    msg.content = ''
    msg.status = 'streaming'
    session.updatedAt = Date.now()
    persistSessions()

    await runAssistantReply(session, msg)
  }

  async function regenerateAssistant(messageId: string) {
    const session = activeSession.value
    if (!session || loading.value) return

    const idx = session.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return

    const target = session.messages[idx]
    if (target.role !== 'assistant') return

    target.content = ''
    target.status = 'streaming'
    session.updatedAt = Date.now()
    persistSessions()

    await runAssistantReply(session, target)
  }

  async function resendFromUserMessage(messageId: string, newContent: string) {
    const session = activeSession.value
    if (!session || loading.value) return

    const idx = session.messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return

    const msg = session.messages[idx]
    if (msg.role !== 'user') return

    msg.content = newContent.trim()
    session.messages.splice(idx + 1)
    session.updatedAt = Date.now()

    const assistantMessage: ChatMessage = {
      id: uid('msg'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      status: 'streaming',
      replyToMessageId: msg.replyToMessageId,
    }

    session.messages.push(assistantMessage)
    persistSessions()

    await runAssistantReply(session, assistantMessage)
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    activeMessages,
    selectedMessages,
    loading,
    promptTemplates,
    promptTemplateId,
    customSystemPrompt,
    modelOptions,
    selectedModel,
    resolvedSystemPrompt,
    quoteMessageId,
    selectedMessageIds,
    stats,
    metrics,
    pendingMeta,
    load,
    createSession,
    switchSession,
    removeSession,
    sendMessage,
    stopGenerating,
    exportActiveSessionAsJson,
    exportActiveSessionAsMarkdown,
    exportSelectedMessagesAsJson,
    exportSelectedMessagesAsMarkdown,
    importSessionFromJson,
    setPromptTemplate,
    setCustomSystemPrompt,
    setSelectedModel,
    addTagToActiveSession,
    removeTagFromActiveSession,
    setQuoteMessage,
    clearQuoteMessage,
    toggleSelectMessage,
    clearSelectedMessages,
    retryFailedMessage,
    regenerateAssistant,
    resendFromUserMessage,
  }
})
