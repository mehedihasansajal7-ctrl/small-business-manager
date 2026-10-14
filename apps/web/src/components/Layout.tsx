import { useState, type ReactNode } from 'react';
import { useApp, useT } from '../state/AppContext';
import { navigate, useRoute } from '../state/router';
import { isActive, visibleNavItems, type NavItem } from './nav';
import { SyncBanner } from './SyncBanner';
import { InstallPrompt } from './InstallPrompt';
import { Button } from './ui';
import { LOCALES } from '../i18n';
import { useSyncState } from '../offline/useSync';

/**
 * App shell: header (business, language, theme, sign out), desktop sidebar,
 * mobile bottom bar, the sync strip and the transient status region.
 */
export function Layout({ children }: { readonly children: ReactNode }) {
  const { me, business, permissions, locale, setLocale, themeChoice, setThemeChoice, signOut, switchBusiness, status } = useApp();
  const { t } = useT();
  const route = useRoute();
  const { snapshot } = useSyncState();
  const [menuOpen, setMenuOpen] = useState(false);
  const items = visibleNavItems(permissions);

  const primary = items.filter((item) => item.primary).slice(0, 4);
  const rest = items.filter((item) => !primary.includes(item));

  const go = (path: string) => {
    setMenuOpen(false);
    navigate(path);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <button type="button" className="topbar__toggle" aria-expanded={menuOpen} aria-label={t('nav.more')} onClick={() => setMenuOpen((open) => !open)}>
            <span aria-hidden="true">☰</span>
          </button>
          <button type="button" className="topbar__title" onClick={() => go('/')}>
            <span className="topbar__logo" aria-hidden="true">
              🏪
            </span>
            <span>
              <strong>{business?.name ?? t('app.name')}</strong>
              <small>{business ? `${business.member.role} · ${business.currency}` : t('app.tagline')}</small>
            </span>
          </button>
        </div>

        <div className="topbar__tools">
          {me && me.businesses.length > 1 ? (
            <label className="topbar__select">
              <span className="sr-only">{t('auth.switchBusiness')}</span>
              <select
                className="input input--compact"
                value={business?.id ?? ''}
                onChange={(event) => {
                  void switchBusiness(event.target.value);
                }}
              >
                {me.businesses.map((row) => (
                  <option key={row.businessId} value={row.businessId}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label className="topbar__select">
            <span className="sr-only">{t('common.language')}</span>
            <select className="input input--compact" value={locale} onChange={(event) => setLocale(event.target.value === 'en' ? 'en' : 'bn-BD')}>
              {LOCALES.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.label}
                </option>
              ))}
            </select>
          </label>

          <label className="topbar__select">
            <span className="sr-only">{t('common.theme')}</span>
            <select className="input input--compact" value={themeChoice} onChange={(event) => setThemeChoice(event.target.value as typeof themeChoice)}>
              <option value="system">{t('common.themeSystem')}</option>
              <option value="light">{t('common.themeLight')}</option>
              <option value="dark">{t('common.themeDark')}</option>
            </select>
          </label>

          {me ? (
            <Button variant="ghost" onClick={() => void signOut()}>
              {t('auth.signOut')}
            </Button>
          ) : null}
        </div>
      </header>

      <SyncBanner />

      <div className="shell">
        <nav className="sidebar" aria-label={t('nav.more')}>
          <NavList items={items} path={route.path} onNavigate={go} />
        </nav>

        <main className="content" id="main">
          <InstallPrompt />
          <div className="status-region" role="status" aria-live="polite">
            {status ? <div className={`notice notice--${status.level}`}>{status.text}</div> : null}
            {snapshot.lastError ? <div className="notice notice--warn">{snapshot.lastError}</div> : null}
          </div>
          {children}
        </main>
      </div>

      <nav className="bottomnav" aria-label={t('nav.more')}>
        {primary.map((item) => (
          <button
            key={item.path}
            type="button"
            className={`bottomnav__item${isActive(route.path, item.path) ? ' is-active' : ''}`}
            onClick={() => go(item.path)}
            aria-current={isActive(route.path, item.path) ? 'page' : undefined}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span>{t(item.key)}</span>
          </button>
        ))}
        <button type="button" className="bottomnav__item" onClick={() => setMenuOpen(true)} aria-expanded={menuOpen}>
          <span aria-hidden="true">☰</span>
          <span>{t('nav.more')}</span>
        </button>
      </nav>

      {menuOpen ? (
        <div className="sheet" role="dialog" aria-modal="true" aria-label={t('nav.more')}>
          <div className="sheet__backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <div className="sheet__panel">
            <div className="sheet__head">
              <strong>{t('nav.more')}</strong>
              <Button variant="ghost" onClick={() => setMenuOpen(false)}>
                {t('nav.closeMenu')}
              </Button>
            </div>
            <NavList items={rest.length > 0 ? rest : items} path={route.path} onNavigate={go} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NavList({ items, path, onNavigate }: { readonly items: readonly NavItem[]; readonly path: string; readonly onNavigate: (path: string) => void }) {
  const { t } = useT();
  return (
    <ul className="navlist">
      {items.map((item) => (
        <li key={item.path}>
          <button
            type="button"
            className={`navlist__item${isActive(path, item.path) ? ' is-active' : ''}`}
            onClick={() => onNavigate(item.path)}
            aria-current={isActive(path, item.path) ? 'page' : undefined}
          >
            <span aria-hidden="true">{item.icon}</span>
            <span>{t(item.key)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
