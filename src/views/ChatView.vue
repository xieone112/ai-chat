<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import markdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

import type { ChatMessage } from '../types/chat'
import { useChatStore } from '../stores/chat'

interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike

const store = useChatStore()
const input = ref('')
const listRef = ref<{ scrollToBottom: () => void } | null>(null)
const speaking = ref(false)
const listening = ref(false)
const importInputRef = ref<HTMLInputElement | null>(null)
const sessionKeyword = ref('')
const sessionTagKeyword = ref('')
const newTag = ref('')
const sidebarWidth = ref(250)
const isResizingSidebar = ref(false)

const sessions = computed(() => store.sessions)
const messages = computed(() => store.activeMessages)
const selectedMessages = computed(() => store.selectedMessages)
const selectedMessageIds = computed(() => store.selectedMessageIds)
const activeSessionId = computed(() => store.activeSessionId)
const activeSession = computed(() => store.activeSession)
const loading = computed(() => store.loading)
const promptTemplates = computed(() => store.promptTemplates)
const promptTemplateId = computed(() => store.promptTemplateId)
const customSystemPrompt = computed(() => store.customSystemPrompt)
const modelOptions = computed(() => store.modelOptions)
const selectedModel = computed(() => store.selectedModel)
const quoteMessageId = computed(() => store.quoteMessageId)
const stats = computed(() => store.stats)
const metrics = computed(() => store.metrics)
const pendingMeta = computed(() => store.pendingMeta)

const layoutStyle = computed(() => ({
  '--sidebar-width': `${sidebarWidth.value}px`,
}))

const filteredSessions = computed(() => {
  const q = sessionKeyword.value.trim().toLowerCase()
  const tagQ = sessionTagKeyword.value.trim().toLowerCase()

  return sessions.value.filter((s) => {
    const titleOK = !q || s.title.toLowerCase().includes(q)
    const tags = s.tags ?? []
    const tagOK = !tagQ || tags.some((t) => t.toLowerCase().includes(tagQ))
    return titleOK && tagOK
  })
})

const quotedMessage = computed(() => {
  const id = quoteMessageId.value
  if (!id) return null
  return messages.value.find((m) => m.id === id) ?? null
})

const retryRateText = computed(() => {
  if (metrics.value.totalRequests === 0) return '0%'
  return `${((metrics.value.totalRetries / metrics.value.totalRequests) * 100).toFixed(1)}%`
})

const topModelText = computed(() => {
  const entries = Object.entries(metrics.value.modelUsage)
  if (entries.length === 0) return '-'
  entries.sort((a, b) => b[1] - a[1])
  return entries[0][0]
})

const md = markdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

function renderMarkdown(content: string): string {
  const raw = md.render(content || '')
  return DOMPurify.sanitize(raw)
}

function asChatMessage(item: unknown): ChatMessage {
  return item as ChatMessage
}

function getReplyTarget(msg: ChatMessage): ChatMessage | null {
  if (!msg.replyToMessageId) return null
  return messages.value.find((m) => m.id === msg.replyToMessageId) ?? null
}

function isSelected(msg: ChatMessage): boolean {
  return selectedMessageIds.value.includes(msg.id)
}

let recognition: SpeechRecognitionLike | null = null

function onSidebarResizing(event: MouseEvent) {
  if (!isResizingSidebar.value) return
  const minWidth = 220
  const maxWidth = 420
  sidebarWidth.value = Math.min(maxWidth, Math.max(minWidth, event.clientX - 12))
}

function stopSidebarResize() {
  if (!isResizingSidebar.value) return
  isResizingSidebar.value = false
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
}

function startSidebarResize() {
  isResizingSidebar.value = true
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
}

onMounted(() => {
  store.load()
  window.addEventListener('mousemove', onSidebarResizing)
  window.addEventListener('mouseup', stopSidebarResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('mousemove', onSidebarResizing)
  window.removeEventListener('mouseup', stopSidebarResize)
})

watch(
  messages,
  async () => {
    await nextTick()
    listRef.value?.scrollToBottom()
  },
  { deep: true },
)

async function onSend() {
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  await store.sendMessage(text)
}

function onChangeTemplate(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  store.setPromptTemplate(value)
}

function onChangeModel(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  store.setSelectedModel(value)
}

function onChangeCustomPrompt(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value
  store.setCustomSystemPrompt(value)
}

function addTag() {
  store.addTagToActiveSession(newTag.value)
  newTag.value = ''
}

function removeTag(tag: string) {
  store.removeTagFromActiveSession(tag)
}

function openImportDialog() {
  importInputRef.value?.click()
}

async function onImportSession(event: Event) {
  const inputEl = event.target as HTMLInputElement
  const file = inputEl.files?.[0]
  if (!file) return

  try {
    const text = await file.text()
    store.importSessionFromJson(text)
    alert('导入成功，已切换到新会话。')
  } catch (err) {
    const msg = err instanceof Error ? err.message : '导入失败，请检查 JSON 格式。'
    alert(msg)
  } finally {
    inputEl.value = ''
  }
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function exportSessionJson() {
  const session = activeSession.value
  if (!session) return
  const text = store.exportActiveSessionAsJson()
  downloadTextFile(`${session.title || 'chat-session'}.json`, text, 'application/json')
}

function exportSessionMarkdown() {
  const session = activeSession.value
  if (!session) return
  const text = store.exportActiveSessionAsMarkdown()
  downloadTextFile(`${session.title || 'chat-session'}.md`, text, 'text/markdown')
}

function exportSelectedJson() {
  const session = activeSession.value
  if (!session || selectedMessages.value.length === 0) return
  const text = store.exportSelectedMessagesAsJson()
  downloadTextFile(`${session.title || 'chat-session'}-selected.json`, text, 'application/json')
}

function exportSelectedMarkdown() {
  const session = activeSession.value
  if (!session || selectedMessages.value.length === 0) return
  const text = store.exportSelectedMessagesAsMarkdown()
  downloadTextFile(`${session.title || 'chat-session'}-selected.md`, text, 'text/markdown')
}

function onQuoteMessage(msg: ChatMessage) {
  store.setQuoteMessage(msg.id)
}

function clearQuote() {
  store.clearQuoteMessage()
}

function onToggleSelect(msg: ChatMessage) {
  store.toggleSelectMessage(msg.id)
}

function clearSelected() {
  store.clearSelectedMessages()
}

async function onRetryFailed(msg: ChatMessage) {
  await store.retryFailedMessage(msg.id)
}

async function onRegenerateAssistant(msg: ChatMessage) {
  await store.regenerateAssistant(msg.id)
}

async function onEditAndResend(msg: ChatMessage) {
  const next = window.prompt('编辑后重发（将截断此消息之后的会话）', msg.content)
  if (next === null) return

  const trimmed = next.trim()
  if (!trimmed) {
    alert('内容不能为空')
    return
  }

  await store.resendFromUserMessage(msg.id, trimmed)
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

function toggleSpeechInput() {
  const Ctor = getRecognitionCtor()
  if (!Ctor) {
    alert('当前浏览器不支持语音识别，请使用 Chrome 内核浏览器。')
    return
  }

  if (listening.value && recognition) {
    recognition.stop()
    listening.value = false
    return
  }

  recognition = new Ctor()
  recognition.lang = 'zh-CN'
  recognition.interimResults = false
  recognition.continuous = false

  recognition.onresult = (event) => {
    const text = event.results[0]?.[0]?.transcript?.trim() || ''
    if (text) {
      input.value = input.value ? `${input.value}\n${text}` : text
    }
  }

  recognition.onerror = (event) => {
    listening.value = false
    alert(`语音识别失败：${event.error}`)
  }

  recognition.onend = () => {
    listening.value = false
  }

  listening.value = true
  recognition.start()
}

function speakLatestAssistantMessage() {
  if (!('speechSynthesis' in window)) {
    alert('当前浏览器不支持语音播报。')
    return
  }

  const latest = [...messages.value].reverse().find((m) => m.role === 'assistant')
  if (!latest?.content?.trim()) return

  if (speaking.value) {
    window.speechSynthesis.cancel()
    speaking.value = false
    return
  }

  const utter = new SpeechSynthesisUtterance(latest.content)
  utter.lang = 'zh-CN'
  utter.rate = 1
  utter.onstart = () => {
    speaking.value = true
  }
  utter.onend = () => {
    speaking.value = false
  }
  utter.onerror = () => {
    speaking.value = false
  }

  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(utter)
}
</script>

<template>
  <div class="chat-layout" :style="layoutStyle">
    <aside class="sidebar">
      <button class="new-btn" @click="store.createSession">+ 新建会话</button>

      <input v-model="sessionKeyword" class="search-input" placeholder="按标题搜索会话..." />
      <input v-model="sessionTagKeyword" class="search-input" placeholder="按标签过滤会话..." />

      <div class="prompt-card">
        <label class="prompt-label">模型</label>
        <select class="prompt-select" :value="selectedModel" @change="onChangeModel">
          <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
        </select>

        <label class="prompt-label">Prompt 模板</label>
        <select class="prompt-select" :value="promptTemplateId" @change="onChangeTemplate">
          <option v-for="tpl in promptTemplates" :key="tpl.id" :value="tpl.id">
            {{ tpl.name }}
          </option>
        </select>

        <textarea
          v-if="promptTemplateId === 'custom'"
          class="prompt-textarea"
          placeholder="输入自定义系统人设..."
          :value="customSystemPrompt"
          @input="onChangeCustomPrompt"
        />
      </div>

      <section class="tag-editor tag-editor-sidebar" v-if="activeSession">
        <div class="tag-input-row">
          <input
            v-model="newTag"
            class="search-input"
            placeholder="当前会话标签..."
            @keydown.enter.prevent="addTag"
          />
          <button class="mini-btn" @click="addTag">添加</button>
        </div>
        <div class="tag-list">
          <span v-for="tag in activeSession.tags || []" :key="`active-${tag}`" class="tag-chip tag-chip-dark">
            {{ tag }}
            <button class="tag-remove" @click="removeTag(tag)">×</button>
          </span>
        </div>
      </section>

      <ul class="session-list">
        <li
          v-for="session in filteredSessions"
          :key="session.id"
          :class="['session-item', { active: session.id === activeSessionId }]"
          @click="store.switchSession(session.id)"
        >
          <div class="session-main">
            <span class="session-title">{{ session.title }}</span>
            <div class="session-tags">
              <span v-for="tag in session.tags || []" :key="`${session.id}-${tag}`" class="tag-chip">{{ tag }}</span>
            </div>
          </div>
          <button class="session-del" title="删除会话" @click.stop="store.removeSession(session.id)">
            ×
          </button>
        </li>
      </ul>
    </aside>

    <div
      class="sidebar-resizer"
      @mousedown.prevent="startSidebarResize"
      :class="{ active: isResizingSidebar }"
      title="拖动调整侧边栏宽度"
    />

    <main class="chat-main">
      <header class="chat-header">
        <span>语聊小精灵 · 智谱 AI</span>
        <div class="header-actions">
          <input
            ref="importInputRef"
            class="hidden-input"
            type="file"
            accept="application/json,.json"
            @change="onImportSession"
          />
          <button class="ghost-btn" @click="openImportDialog">导入 JSON</button>
          <button class="ghost-btn" @click="toggleSpeechInput">
            {{ listening ? '停止听写' : '语音输入' }}
          </button>
          <button class="ghost-btn" @click="speakLatestAssistantMessage">
            {{ speaking ? '停止播报' : '语音播报' }}
          </button>
          <button class="ghost-btn" :disabled="!messages.length" @click="exportSessionMarkdown">
            导出会话 MD
          </button>
          <button class="ghost-btn" :disabled="!messages.length" @click="exportSessionJson">
            导出会话 JSON
          </button>
        </div>
      </header>

      <section class="stats-panel">
        <span>请求数：{{ stats.requestCount }}</span>
        <span>最近耗时：{{ stats.lastLatencyMs }}ms</span>
        <span>平均耗时：{{ stats.avgLatencyMs }}ms</span>
        <span>估算 Token：{{ stats.estimatedTokens }}</span>
        <span>重试次数：{{ stats.lastRetryCount }}</span>
        <span>退避：{{ stats.lastBackoffMs }}ms</span>
        <span>最常用模型：{{ topModelText }}</span>
        <span>重试率：{{ retryRateText }}</span>
        <span>平均轮次：{{ metrics.avgTurns }}</span>
        <span v-if="loading && pendingMeta.retryCount > 0">重试中（第 {{ pendingMeta.retryCount }} 次）</span>
      </section>


      <section class="selection-bar" v-if="selectedMessages.length > 0">
        <span>已选中 {{ selectedMessages.length }} 条消息</span>
        <div class="selection-actions">
          <button class="mini-btn" @click="exportSelectedMarkdown">导出选中 MD</button>
          <button class="mini-btn" @click="exportSelectedJson">导出选中 JSON</button>
          <button class="mini-btn" @click="clearSelected">清空选择</button>
        </div>
      </section>

      <section class="message-list">
        <DynamicScroller
          ref="listRef"
          class="scroller"
          :items="messages"
          :min-item-size="120"
          key-field="id"
        >
          <template #default="{ item, index, active }">
            <DynamicScrollerItem
              :item="asChatMessage(item)"
              :active="active"
              :size-dependencies="[
                asChatMessage(item).content,
                asChatMessage(item).status,
                asChatMessage(item).replyToMessageId,
                isSelected(asChatMessage(item)),
              ]"
            >
              <article :class="['message', asChatMessage(item).role]" :data-index="index">
                <div class="bubble" :class="{ selected: isSelected(asChatMessage(item)) }">
                  <div v-if="getReplyTarget(asChatMessage(item))" class="reply-chip">
                    回复：{{ getReplyTarget(asChatMessage(item))?.content.slice(0, 42) }}
                  </div>

                  <div class="role-row">
                    <div class="role">{{ asChatMessage(item).role === 'user' ? '你' : 'AI' }}</div>
                    <div class="msg-actions">
                      <button class="mini-btn" :disabled="loading" @click="onToggleSelect(asChatMessage(item))">
                        {{ isSelected(asChatMessage(item)) ? '取消多选' : '多选' }}
                      </button>
                      <button class="mini-btn" :disabled="loading" @click="onQuoteMessage(asChatMessage(item))">
                        引用回复
                      </button>

                      <button
                        v-if="asChatMessage(item).role === 'assistant'"
                        class="mini-btn"
                        :disabled="loading"
                        @click="onRegenerateAssistant(asChatMessage(item))"
                      >
                        重新生成
                      </button>

                      <button
                        v-if="asChatMessage(item).role === 'assistant' && asChatMessage(item).status === 'error'"
                        class="mini-btn"
                        :disabled="loading"
                        @click="onRetryFailed(asChatMessage(item))"
                      >
                        重试
                      </button>

                      <button
                        v-if="asChatMessage(item).role === 'user'"
                        class="mini-btn"
                        :disabled="loading"
                        @click="onEditAndResend(asChatMessage(item))"
                      >
                        编辑重发
                      </button>
                    </div>
                  </div>

                  <div
                    class="content md-content"
                    v-html="renderMarkdown(asChatMessage(item).content || '思考中...')"
                  />
                </div>
              </article>
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
      </section>

      <footer class="input-bar">
        <div>
          <div v-if="quotedMessage" class="quote-banner">
            <span>正在引用：{{ quotedMessage.content.slice(0, 60) }}</span>
            <button class="clear-quote-btn" @click="clearQuote">取消</button>
          </div>
          <textarea
            v-model="input"
            class="input"
            placeholder="输入你的问题，Enter 发送，Shift+Enter 换行"
            @keydown.enter.exact.prevent="onSend"
          />
        </div>
        <div class="input-actions">
          <button v-if="loading" class="stop-btn" @click="store.stopGenerating">停止</button>
          <button v-else class="send-btn" :disabled="!input.trim()" @click="onSend">发送</button>
        </div>
      </footer>
    </main>
  </div>
</template>
