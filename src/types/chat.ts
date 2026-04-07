export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  status?: 'pending' | 'streaming' | 'done' | 'error'
  replyToMessageId?: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  tags?: string[]
}

export interface ChatStats {
  requestCount: number
  avgLatencyMs: number
  lastLatencyMs: number
  estimatedTokens: number
  lastRetryCount: number
  lastBackoffMs: number
}

export interface UsageMetrics {
  modelUsage: Record<string, number>
  totalRequests: number
  totalRetries: number
  avgTurns: number
}
