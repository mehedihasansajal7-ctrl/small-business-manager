import { apiRequest } from './client';
import type { AIAnswer, AIStatus, Citation, ConversationMessage, ConversationRow } from './types';

/** AI agent endpoints. AI output is always a suggestion, never a transaction. */

export const ai = {
  status: () => apiRequest<AIStatus>('/api/ai/status'),
  ask: (body: { question: string; language?: 'bn' | 'en'; conversationId?: string }) => apiRequest<AIAnswer>('/api/ai/ask', { method: 'POST', body }),
  conversations: () => apiRequest<ConversationRow[]>('/api/ai/conversations'),
  conversation: (id: string) => apiRequest<{ conversation: ConversationRow; messages: ConversationMessage[] }>(`/api/ai/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id: string) => apiRequest<{ ok: boolean }>(`/api/ai/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  plans: () => apiRequest<readonly { id: string; kind: string; title: string; status: string; created_at: string }[]>('/api/ai/plans'),
  savePlan: (body: { title: string; content: string; kind?: string }) => apiRequest<{ id: string }>('/api/ai/plans', { method: 'POST', body }),
  feedback: (body: { messageId: string; helpful: boolean; comment?: string }) => apiRequest<{ ok: boolean }>('/api/ai/feedback', { method: 'POST', body }),
  research: (query: string) => apiRequest<{ citations: Citation[]; cached: boolean; provider: string }>('/api/ai/research', { method: 'POST', body: { query } }),
};
