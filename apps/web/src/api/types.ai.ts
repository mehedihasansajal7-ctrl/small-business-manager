/** Response shapes for this area of the API. */
export type AIMode = 'generative' | 'local' | 'fallback';
export interface Citation {
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly publishedAt?: string;
  readonly accessedAt: string;
  readonly excerpt: string;
  readonly kind: 'OFFICIAL' | 'RESEARCH' | 'RETAILER' | 'USER_REVIEW' | 'WARNING' | 'CURATED_LINK';
  readonly note?: string;
}
export interface AIAnswer {
  readonly text: string;
  readonly mode: AIMode;
  readonly provider: string;
  readonly citations: readonly Citation[];
  readonly factsUsed: readonly string[];
  readonly usage: { readonly tokensIn: number; readonly tokensOut: number };
  readonly limitations: readonly string[];
}
export interface AIStatus {
  readonly provider: string;
  readonly mode: AIMode;
  readonly configured: boolean;
  readonly research: { readonly provider: string; readonly configured: boolean };
  readonly limits: { readonly timeoutMs: number; readonly maxOutputTokens: number; readonly requestsPerHour: number };
  readonly notes: readonly string[];
}
export interface ConversationRow {
  readonly id: string;
  readonly title: string;
  readonly language: string;
  readonly created_at: string;
  readonly updated_at: string;
}
export interface ConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly mode: string;
  readonly provider: string;
  readonly citations: readonly Citation[];
  readonly created_at: string;
}
