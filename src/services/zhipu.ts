import axios, { AxiosError } from 'axios'

export type Role = 'user' | 'assistant' | 'system'

export interface InputMessage {
  role: Role
  content: string
}

export interface StreamMeta {
  retryCount: number
  backoffMs: number
}

interface ZhipuResponse {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
}

interface ZhipuStreamDelta {
  choices?: Array<{
    delta?: {
      content?: string
    }
  }>
}

const api = axios.create({
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  timeout: 30_000,
})

const RETRY_COUNT = 2
const RETRY_DELAY_MS = 600

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getApiKey(): string {
  const key = import.meta.env.VITE_ZHIPU_API_KEY
  if (!key) {
    throw new Error('未配置 VITE_ZHIPU_API_KEY')
  }
  return key
}

function getDefaultModel(): string {
  return import.meta.env.VITE_ZHIPU_MODEL || 'glm-4-flash'
}

function shouldRetry(error: unknown): boolean {
  if (!(error instanceof AxiosError)) return false
  if (!error.response) return true

  const status = error.response.status
  return status >= 500 || status === 429
}

function canRetryStatus(status: number): boolean {
  return status >= 500 || status === 429
}

export async function chatCompletions(
  messages: InputMessage[],
  model = getDefaultModel(),
): Promise<string> {
  const token = getApiKey()

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const { data } = await api.post<ZhipuResponse>(
        '/chat/completions',
        {
          model,
          stream: false,
          messages,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      )

      const text = data.choices?.[0]?.message?.content?.trim()
      if (!text) {
        throw new Error('模型返回为空')
      }
      return text
    } catch (error) {
      const canRetry = shouldRetry(error) && attempt < RETRY_COUNT
      if (!canRetry) {
        if (error instanceof AxiosError) {
          const status = error.response?.status
          const detail =
            typeof error.response?.data === 'string'
              ? error.response.data
              : JSON.stringify(error.response?.data ?? {})
          throw new Error(`智谱AI请求失败${status ? `(${status})` : ''}：${detail}`)
        }
        throw error
      }

      await sleep(RETRY_DELAY_MS * (attempt + 1))
    }
  }

  throw new Error('智谱AI请求失败')
}

export async function chatCompletionsStream(
  messages: InputMessage[],
  onDelta: (deltaText: string) => void,
  signal?: AbortSignal,
  model = getDefaultModel(),
  onMeta?: (meta: StreamMeta) => void,
): Promise<void> {
  const token = getApiKey()

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    const backoffMs = attempt > 0 ? RETRY_DELAY_MS * attempt : 0

    if (attempt > 0) {
      onMeta?.({ retryCount: attempt, backoffMs })
      await sleep(backoffMs)
    }

    let response: Response
    try {
      response = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          stream: true,
          messages,
        }),
        signal,
      })
    } catch (error) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      if (attempt < RETRY_COUNT) continue
      throw error
    }

    if (!response.ok || !response.body) {
      const detail = await response.text()
      if (attempt < RETRY_COUNT && canRetryStatus(response.status)) {
        continue
      }
      throw new Error(`智谱AI流式请求失败(${response.status})：${detail}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) return

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line || !line.startsWith('data:')) continue

        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return

        try {
          const parsed = JSON.parse(payload) as ZhipuStreamDelta
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) onDelta(delta)
        } catch {
          // ignore broken chunk
        }
      }
    }
  }

  throw new Error('智谱AI流式请求失败')
}
