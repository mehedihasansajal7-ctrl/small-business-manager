import { useState } from 'react';
import { ai } from '../api/endpointsAi';
import { ApiError } from '../api/client';
import { hasPermission } from '../api/permissions';
import { AsyncState, Restricted } from '../components/States';
import { Badge, Button, Card, Notice, PageHeader, Tabs, TextAreaInput, TextInput, type Tone } from '../components/ui';
import { DateTimeText } from '../components/MoneyText';
import { useApp, useT } from '../state/AppContext';
import { useResource } from '../offline/useSync';
import type { AIAnswer, AIMode, Citation, ConversationRow } from '../api/types';

const KIND_TONE: Readonly<Record<Citation['kind'], Tone>> = {
  OFFICIAL: 'ok',
  RESEARCH: 'info',
  RETAILER: 'warn',
  USER_REVIEW: 'muted',
  WARNING: 'error',
  CURATED_LINK: 'muted',
};

const MODE_TONE: Readonly<Record<AIMode, Tone>> = { generative: 'ok', local: 'info', fallback: 'warn' };

/**
 * AI agent chat.
 *
 * The mode badge is always visible: rule-based `fallback` text must never look
 * like a generative model's answer. Nothing on this screen writes to the books.
 */
export function AiScreen() {
  const { business, permissions, notify } = useApp();
  const { t, locale } = useT();
  const [tab, setTab] = useState('chat');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AIAnswer | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [openConversation, setOpenConversation] = useState<string | null>(null);
  const [researchQuery, setResearchQuery] = useState('');
  const [research, setResearch] = useState<readonly Citation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canUse = hasPermission(permissions, 'ai.use');
  const status = useResource(() => ai.status(), []);
  const conversations = useResource(() => ai.conversations(), []);
  const history = useResource(
    () => (openConversation ? ai.conversation(openConversation) : Promise.resolve(null)),
    [openConversation],
  );

  const run = (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    action()
      .catch((cause: unknown) => setError(cause instanceof ApiError ? cause.message : cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const ask = () =>
    run(async () => {
      const response = await ai.ask({
        question: question.trim(),
        language: locale === 'en' ? 'en' : 'bn',
        ...(conversationId ? { conversationId } : {}),
      });
      setAnswer(response);
      setQuestion('');
      conversations.reload();
    });

  const mode = answer?.mode ?? status.data?.mode ?? 'fallback';
  const hasRetailer = (answer?.citations ?? []).some((citation) => citation.kind === 'RETAILER');

  if (!canUse) {
    return (
      <>
        <PageHeader title={t('nav.ai')} />
        <Restricted permission="ai.use" hint={t('ai.noPermission')} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('nav.ai')}
        subtitle={business?.name}
        actions={
          <span className={`pill pill--${MODE_TONE[mode]}`}>
            {t('ai.mode')}: {modeLabel(mode, t)}
          </span>
        }
      />

      <Notice level="info">{t('ai.modeHint')}</Notice>
      <Notice level="warn">{t('ai.notATransaction')}</Notice>
      {hasRetailer ? <Notice level="error">{t('ai.retailerWarning')}</Notice> : null}

      {status.data ? (
        <Card title={`${t('ai.mode')}: ${status.data.provider}`} subtitle={`${status.data.research.provider} · ${status.data.limits.requestsPerHour}/h`}>
          <ul className="list">
            {status.data.notes.map((note) => (
              <li key={note} className="list__item">
                {note}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Tabs
        tabs={[
          { id: 'chat', label: t('ai.ask') },
          { id: 'conversations', label: t('ai.conversations') },
          { id: 'research', label: t('ai.research') },
        ]}
        active={tab}
        onChange={setTab}
      />

      {error ? <Notice level="error">{error}</Notice> : null}

      {tab === 'chat' ? (
        <>
          <Card
            title={t('ai.ask')}
            actions={
              <Button variant="primary" disabled={busy || question.trim().length < 3} onClick={ask}>
                {t('ai.send')}
              </Button>
            }
          >
            <TextAreaInput label={t('ai.ask')} value={question} onValueChange={setQuestion} rows={3} hint={t('ai.askPlaceholder')} />
            {conversationId ? (
              <div className="row">
                <Badge tone="info">{conversationId.slice(0, 8)}</Badge>
                <Button variant="ghost" onClick={() => setConversationId(null)}>
                  {t('ai.newConversation')}
                </Button>
              </div>
            ) : null}
          </Card>

          {answer ? (
            <Card
              title={t('nav.ai')}
              actions={
                <>
                  <Badge tone={MODE_TONE[answer.mode]}>{modeLabel(answer.mode, t)}</Badge>
                  <Badge tone="muted">{answer.provider}</Badge>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await ai.savePlan({ title: answer.text.slice(0, 60), content: answer.text, kind: 'PLAN' });
                        notify(t('ai.savedPlan'), 'success');
                      })
                    }
                  >
                    {t('ai.savePlan')}
                  </Button>
                </>
              }
            >
              <pre className="answer">{answer.text}</pre>

              {answer.factsUsed.length > 0 ? (
                <>
                  <h3 className="sheet__title">{t('ai.factsUsed')}</h3>
                  <ul className="list">
                    {answer.factsUsed.map((fact) => (
                      <li key={fact} className="list__item">
                        <span className="mono">{fact}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {answer.limitations.length > 0 ? (
                <>
                  <h3 className="sheet__title">{t('ai.limitations')}</h3>
                  <ul className="list">
                    {answer.limitations.map((limitation) => (
                      <li key={limitation} className="list__item">
                        {limitation}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {answer.citations.length > 0 ? <SourceCards citations={answer.citations} /> : null}

              <div className="row">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await ai.feedback({ messageId: conversationId ?? 'session', helpful: true });
                      notify(t('ai.feedbackThanks'), 'success');
                    })
                  }
                >
                  👍 {t('ai.helpful')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await ai.feedback({ messageId: conversationId ?? 'session', helpful: false });
                      notify(t('ai.feedbackThanks'), 'success');
                    })
                  }
                >
                  👎 {t('ai.notHelpful')}
                </Button>
                <span className="muted">
                  {t('ai.usage')}: {answer.usage.tokensIn}/{answer.usage.tokensOut}
                </span>
              </div>
            </Card>
          ) : null}
        </>
      ) : null}

      {tab === 'conversations' ? (
        <Card
          title={t('ai.conversations')}
          actions={
            <Button variant="secondary" onClick={conversations.reload}>
              {t('common.reload')}
            </Button>
          }
        >
          <AsyncState loading={conversations.loading} error={conversations.error} data={conversations.data} onRetry={conversations.reload} empty={(rows) => rows.length === 0}>
            {(rows) => (
              <ul className="list">
                {rows.map((row: ConversationRow) => (
                  <li key={row.id} className="list__item">
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        setOpenConversation(row.id);
                        setConversationId(row.id);
                      }}
                    >
                      {row.title}
                    </button>
                    <span className="muted">
                      <DateTimeText value={row.updated_at} />
                    </span>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await ai.deleteConversation(row.id);
                          conversations.reload();
                        })
                      }
                    >
                      {t('ai.deleteConversation')}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </AsyncState>

          {openConversation ? (
            <AsyncState loading={history.loading} error={history.error} data={history.data} onRetry={history.reload}>
              {(data) =>
                data === null ? null : (
                  <div className="transcript">
                    {data.messages.map((message, index) => (
                      <div key={`${message.created_at}-${index}`} className={`bubble bubble--${message.role}`}>
                        <span className="bubble__role">{message.role}</span>
                        <pre className="answer">{message.content}</pre>
                        {message.citations.length > 0 ? <SourceCards citations={message.citations} /> : null}
                      </div>
                    ))}
                  </div>
                )
              }
            </AsyncState>
          ) : null}
        </Card>
      ) : null}

      {tab === 'research' ? (
        <Card
          title={t('ai.research')}
          subtitle={t('ai.retailerWarning')}
          actions={
            <Button
              variant="primary"
              disabled={busy || researchQuery.trim().length < 3}
              onClick={() =>
                run(async () => {
                  const result = await ai.research(researchQuery.trim());
                  setResearch(result.citations);
                })
              }
            >
              {t('ai.research')}
            </Button>
          }
        >
          <TextInput label={t('ai.research')} value={researchQuery} onValueChange={setResearchQuery} hint={t('ai.researchPlaceholder')} />
          {research.length > 0 ? <SourceCards citations={research} /> : null}
        </Card>
      ) : null}
    </>
  );
}

function SourceCards({ citations }: { readonly citations: readonly Citation[] }) {
  const { t } = useT();
  return (
    <div className="sources">
      <h3 className="sheet__title">{t('ai.sources')}</h3>
      {citations.map((citation) => (
        <article key={citation.url} className="source">
          <header className="source__head">
            <Badge tone={KIND_TONE[citation.kind]}>{kindLabel(citation.kind, t)}</Badge>
            <strong>{citation.title}</strong>
          </header>
          <p className="muted">
            {citation.publisher} · {t('ai.accessedAt')} <DateTimeText value={citation.accessedAt} />
          </p>
          <p>{citation.excerpt}</p>
          {citation.note ? <p className="muted">{citation.note}</p> : null}
          <a className="link" href={citation.url} target="_blank" rel="noreferrer noopener">
            {t('ai.openSource')} ↗
          </a>
        </article>
      ))}
    </div>
  );
}

function modeLabel(mode: AIMode, t: (key: 'ai.modeGenerative' | 'ai.modeLocal' | 'ai.modeFallback') => string): string {
  if (mode === 'generative') return t('ai.modeGenerative');
  if (mode === 'local') return t('ai.modeLocal');
  return t('ai.modeFallback');
}

function kindLabel(kind: Citation['kind'], t: (key: 'ai.kindOfficial' | 'ai.kindResearch' | 'ai.kindRetailer' | 'ai.kindUserReview' | 'ai.kindCurated' | 'ai.kindWarning') => string): string {
  switch (kind) {
    case 'OFFICIAL':
      return t('ai.kindOfficial');
    case 'RESEARCH':
      return t('ai.kindResearch');
    case 'RETAILER':
      return t('ai.kindRetailer');
    case 'USER_REVIEW':
      return t('ai.kindUserReview');
    case 'WARNING':
      return t('ai.kindWarning');
    default:
      return t('ai.kindCurated');
  }
}
