import { useCallback, useEffect, useState } from 'react';
import { Icon, StatusPill, Toasts } from './components.tsx';
import { MirrorsPage } from './MirrorsPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { connect, refresh, useApp } from './store.ts';
import { ZonesPage } from './ZonesPage.tsx';

type Tab = 'zones' | 'mirrors' | 'settings';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'zones', label: 'Zones' },
  { id: 'mirrors', label: 'Mirrors' },
  { id: 'settings', label: 'Settings' },
];

function readHash(): Tab {
  const h = location.hash.slice(1);
  return h === 'mirrors' || h === 'settings' ? h : 'zones';
}

export function App() {
  const [tab, setTab] = useState<Tab>(readHash);
  const [openZone, setOpenZone] = useState<number | null>(null);
  const closeZone = useCallback(() => setOpenZone(null), []);
  const homeName = useApp((s) => s.config?.home.name ?? null);

  useEffect(() => {
    document.title = homeName ? `${homeName} · open-zone` : 'open-zone';
  }, [homeName]);

  useEffect(() => {
    // Load state over HTTP right away; the WebSocket then keeps it live.
    void refresh();
    connect();
    const onHash = () => setTab(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (t: Tab) => {
    history.replaceState(null, '', t === 'zones' ? location.pathname : `#${t}`);
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="app">
      <header className="top">
        <div className="titles">
          {homeName && <p className="home-name">{homeName}</p>}
          <h1>{TABS.find((t) => t.id === tab)?.label}</h1>
        </div>
        <StatusPill />
      </header>
      <main>
        {tab === 'zones' && <ZonesPage open={openZone} onOpen={setOpenZone} onClose={closeZone} />}
        {tab === 'mirrors' && <MirrorsPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            aria-current={tab === t.id ? 'page' : undefined}
            onClick={() => go(t.id)}
          >
            <Icon name={t.id} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <Toasts />
    </div>
  );
}
