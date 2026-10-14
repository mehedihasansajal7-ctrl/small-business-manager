import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
import { Linking, Text, View } from 'react-native';

import { AIModeBadge } from '../../components/AIModeBadge';

import * as api from '../../api/endpoints';
import { describeError } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { Button, Card, Field, ListRow, Notice, Screen, SectionTitle, Tag } from '../../components';
import { useI18n } from '../../i18n';
import { useAsyncData } from '../../lib/useAsyncData';
import { useNetwork } from '../../lib/network';
import { useTheme } from '../../theme';
import type { AIAnswer, Citation, CitationKind } from '../../api/types';
import type { DashboardStackParamList, MoreStackParamList } from '../../navigation/types';

type Props = NativeStackScreenProps<DashboardStackParamList & MoreStackParamList, 'AIAgent'>;

/**
 * AI assistant.
 *
 * Three rules shape this screen, all of them from the spec:
 *
 *  1. **The mode is always visible.** `generative` / `local` / `fallback` is shown
 *     next to every answer, because the fallback is a deterministic rule engine —
 *     it must never look like a generative model. The badge text spells out which
 *     provider produced the text.
 *  2. **Sources are real cards.** Each citation shows its `kind`
 *     (OFFICIAL / RESEARCH / RETAILER / USER_REVIEW / WARNING / CURATED_LINK) and
 *     opens the URL. Curated links are labelled as links to open, *not* live search
 *     results — the server says so in `limitations`, and the UI repeats it.
 *  3. **AI output is never a posted transaction.** There is no "apply" button
 *     anywhere on this screen; a transaction can only be created through the
 *     normal outbox flow with an explicit save.
 *
 * Asking requires the internet; nothing is sent on the user's behalf while offline.
 */
export function AIAgentScreen(_props: Props) {
  const { colors, typography, spacing } = useTheme();
  const { t, language } = useI18n();
  const { can } = useAuth();
  const { online } = useNetwork();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AIAnswer | null>(null);
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const statusLoader = useCallback(async () => (online ? api.aiStatus() : null), [online]);
  const { data: status } = useAsyncData(statusLoader, [statusLoader]);

  const conversationsLoader = useCallback(async () => (online && can('ai.use') ? api.aiConversations() : []), [online, can]);
  const { data: conversations, reload: reloadConversations } = useAsyncData(conversationsLoader, [conversationsLoader]);

  const ask = async () => {
    setError(null);
    if (question.trim().length < 3) return;
    setBusy(true);
    try {
      const result = await api.aiAsk({ question: question.trim(), language, ...(conversationId ? { conversationId } : {}) });
      setAnswer(result);
      setConversationId(result.conversationId ?? conversationId);
      setQuestion('');
      reloadConversations();
    } catch (caught) {
      setError(describeError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  const feedback = async (helpful: boolean) => {
    if (!answer || !conversationId) return;
    try {
      await api.aiFeedback({ messageId: conversationId, helpful });
    } catch {
      // Feedback is a nice-to-have; never block the conversation on it.
    }
  };

  return (
    <Screen title={t('nav.ai')} subtitle={status ? `${status.provider}` : undefined}>
      {!online ? <Notice tone="warning" body={t('ai.needsInternet')} /> : null}
      {!can('ai.use') ? <Notice tone="warning" body={t('common.restrictedBody')} /> : null}
      {error ? <Notice tone="danger" body={error} /> : null}

      {/* The hard rule, stated before anything else the user reads. */}
      <Notice tone="info" title={t('ai.neverPosts')} body={t('ai.modeFallback')} />

      {status && !status.configured ? <Notice tone="warning" body={t('ai.notConfigured')} /> : null}

      <Card>
        <Field label={t('ai.title')} value={question} onChangeText={setQuestion} multiline placeholder={t('ai.placeholder')} />
        <Button label={t('ai.ask')} onPress={() => void ask()} loading={busy} disabled={!online || !can('ai.use')} fullWidth />
      </Card>

      {answer ? (
        <>
          <AIModeBadge mode={answer.mode} provider={answer.provider} />

          <SectionTitle title={t('ai.title')} />
          <Card>
            <Text style={[typography.body, { color: colors.text }]}>{answer.text}</Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
              <Button label={t('ai.helpful')} compact variant="ghost" onPress={() => void feedback(true)} />
              <Button label={t('ai.notHelpful')} compact variant="ghost" onPress={() => void feedback(false)} />
            </View>
          </Card>

          {answer.factsUsed.length > 0 ? (
            <>
              <SectionTitle title={t('ai.factsUsed')} />
              <Card>
                {answer.factsUsed.map((fact, index) => (
                  <Text key={`${index}-${fact.slice(0, 12)}`} style={[typography.caption, { color: colors.textMuted, marginBottom: 4 }]}>
                    • {fact}
                  </Text>
                ))}
              </Card>
            </>
          ) : null}

          {answer.citations.length > 0 ? (
            <>
              <SectionTitle title={t('ai.sources')} />
              {answer.citations.map((citation) => (
                <CitationCard key={citation.url} citation={citation} openLabel={t('ai.openSource')} curatedLabel={t('ai.curatedLinks')} />
              ))}
            </>
          ) : null}

          {answer.limitations.length > 0 ? (
            <>
              <SectionTitle title={t('ai.limitations')} />
              <Card>
                {answer.limitations.map((limitation, index) => (
                  <Text key={`${index}-${limitation.slice(0, 12)}`} style={[typography.caption, { color: colors.warning, marginBottom: 4 }]}>
                    • {limitation}
                  </Text>
                ))}
              </Card>
            </>
          ) : null}
        </>
      ) : null}

      <SectionTitle title={t('ai.history')} />
      <Card>
        {conversations && conversations.length > 0 ? (
          conversations.slice(0, 10).map((conversation) => (
            <ListRow
              key={conversation.id}
              title={String(conversation.title ?? conversation.id)}
              subtitle={String(conversation.createdAt ?? '')}
              right={
                <Text
                  style={[typography.caption, { color: colors.danger }]}
                  onPress={() => void api.aiDeleteConversation(conversation.id).then(reloadConversations).catch(() => undefined)}
                >
                  {t('common.delete')}
                </Text>
              }
              onPress={() => {
                setConversationId(conversation.id);
                void api
                  .aiConversation(conversation.id)
                  .then((detail) => {
                    const last = [...detail.messages].reverse().find((message) => message.role === 'assistant');
                    if (last) {
                      setAnswer({
                        text: last.content,
                        mode: last.mode ?? 'fallback',
                        provider: last.provider ?? 'unknown',
                        citations: last.citations ?? [],
                        factsUsed: [],
                        usage: { tokensIn: 0, tokensOut: 0 },
                        limitations: [],
                      });
                    }
                  })
                  .catch((caught) => setError(describeError(caught).message));
              }}
            />
          ))
        ) : (
          <Text style={[typography.caption, { color: colors.textMuted }]}>{t('common.none')}</Text>
        )}
      </Card>

      <Button label={t('ai.newChat')} variant="secondary" onPress={() => { setAnswer(null); setConversationId(undefined); }} fullWidth />
    </Screen>
  );
}

function CitationCard({ citation, openLabel, curatedLabel }: { citation: Citation; openLabel: string; curatedLabel: string }) {
  const { colors, typography, spacing } = useTheme();
  return (
    <Card style={{ marginBottom: spacing.sm }}>
      <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginBottom: 4 }}>
        {/* The `kind` is part of the answer, not decoration: an official label is
            different from a retailer page or a curated link. */}
        <Tag text={citation.kind} tone={citationKindTone(citation.kind)} />
        <Text style={[typography.caption, { color: colors.textMuted, flex: 1 }]} numberOfLines={1}>
          {citation.publisher}
        </Text>
      </View>
      <Text style={[typography.subheading, { color: colors.text }]}>{citation.title}</Text>
      <Text style={[typography.caption, { color: colors.textMuted, marginTop: 2 }]} numberOfLines={3}>
        {citation.excerpt}
      </Text>
      {citation.kind === 'CURATED_LINK' ? <Text style={[typography.caption, { color: colors.warning, marginTop: 4 }]}>{curatedLabel}</Text> : null}
      <View style={{ marginTop: spacing.sm }}>
        <Text style={[typography.caption, { color: colors.primary, textDecorationLine: 'underline' }]} onPress={() => void Linking.openURL(citation.url)}>
          {openLabel}
        </Text>
      </View>
    </Card>
  );
}

function citationKindTone(kind: CitationKind): 'neutral' | 'primary' | 'warning' | 'danger' | 'success' {
  switch (kind) {
    case 'OFFICIAL':
      return 'success';
    case 'WARNING':
      return 'danger';
    case 'RESEARCH':
      return 'primary';
    case 'CURATED_LINK':
      return 'warning';
    default:
      return 'neutral';
  }
}
