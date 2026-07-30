import { useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  CalendarDays, ChevronsLeft, ChevronsRight, FlaskConical, Gem, Inbox as InboxIcon,
  LayoutDashboard, Loader2, Moon, Plug, Search as SearchIcon, Settings as SettingsIcon,
  Sparkles, Sun, WifiOff,
} from 'lucide-react';
import { IS_MOCK } from '@/api/client';
import { useEvents } from '@/api/useEvents';
import { useStore } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { Tip, TooltipProvider } from '@/components/ui/controls';
import { Button } from '@/components/ui/button';
import { ToastHost } from '@/components/common/Toasts';
import { JobDrawer } from '@/components/common/JobDrawer';
import { ProfileModal } from '@/components/common/ProfileModal';
import MissionControl from '@/views/MissionControl';
import Opportunities from '@/views/Opportunities';
import SearchView from '@/views/Search';
import Inbox from '@/views/Inbox';
import Schedule from '@/views/Schedule';
import Connections from '@/views/Connections';
import Assistant from '@/views/Assistant';
import SettingsView from '@/views/SettingsView';

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const toggle = () => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle('dark', next);
      try {
        localStorage.setItem('ajs.theme', next ? 'dark' : 'light');
      } catch {
        /* private mode */
      }
      return next;
    });
  };
  return { dark, toggle };
}

function ProfileChip({ collapsed }: { collapsed: boolean }) {
  const profile = useStore((s) => s.profile);
  const [open, setOpen] = useState(false);
  const ready = profile?.profileReady ?? false;
  const name = ready && profile?.fullName ? profile.fullName : 'Set up your profile';
  // Email extraction can miss (contact formats vary) — never show the setup nag once ready.
  const sub = ready
    ? profile?.email || profile?.location || 'Profile ready'
    : 'Homer needs to know who it applies for';
  const initials =
    ready && profile?.fullName
      ? profile.fullName
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0]?.toUpperCase() ?? '')
          .join('')
      : '?';

  const chip = (
    <button
      onClick={() => setOpen(true)}
      aria-label="Open profile"
      className={cn(
        'w-full flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors cursor-pointer',
        'hover:bg-overlay border border-transparent hover:border-line',
        collapsed && 'justify-center px-0',
      )}
    >
      <span
        className={cn(
          'h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 border',
          ready ? 'bg-accent/15 border-accent/30 text-accent' : 'bg-warn-raw/15 border-warn-raw/40 text-warn',
        )}
      >
        {initials}
      </span>
      {!collapsed && (
        <span className="min-w-0">
          <span className="block text-[12px] font-semibold text-ink truncate leading-4">{name}</span>
          <span className={cn('block text-[10px] truncate leading-3.5', ready ? 'text-ink-3' : 'text-warn')}>{sub}</span>
        </span>
      )}
    </button>
  );

  return (
    <>
      {collapsed ? <Tip label={name}>{chip}</Tip> : chip}
      <ProfileModal open={open} onOpenChange={setOpen} />
    </>
  );
}

function Sidebar() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('ajs.sidebar') === '1';
    } catch {
      return false;
    }
  });
  const { dark, toggle } = useTheme();
  const sse = useStore((s) => s.sseConnected);
  const readyCount = useStore((s) => s.jobs.filter((j) => j.status === 'ready_for_review').length);
  const outboxCount = useStore((s) => s.emails.filter((e) => e.direction === 'outbound' && e.needsApproval).length);
  const humanCount = useStore((s) => s.tasks.filter((t) => t.state === 'needs_human').length);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem('ajs.sidebar', c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  const NAV = [
    { to: '/', icon: LayoutDashboard, label: 'Mission Control', badge: readyCount, exact: true },
    { to: '/opportunities', icon: Gem, label: 'Opportunities', badge: 0 },
    { to: '/search', icon: SearchIcon, label: 'Search', badge: humanCount, badgeTone: 'warn' as const },
    { to: '/inbox', icon: InboxIcon, label: 'Inbox', badge: outboxCount },
    { to: '/schedule', icon: CalendarDays, label: 'Schedule', badge: 0 },
    { to: '/connections', icon: Plug, label: 'Connections', badge: 0 },
    { to: '/assistant', icon: Sparkles, label: 'Assistant', badge: 0 },
    { to: '/settings', icon: SettingsIcon, label: 'Settings', badge: 0 },
  ];

  return (
    <motion.aside
      animate={{ width: collapsed ? 60 : 216 }}
      transition={{ type: 'spring', stiffness: 400, damping: 36 }}
      className="h-full shrink-0 border-r border-line bg-surface flex flex-col overflow-hidden"
    >
      <div className={cn('flex items-center gap-2.5 px-3.5 h-14 border-b border-line shrink-0', collapsed && 'justify-center px-0')}>
        <div className="h-8 w-8 rounded-lg bg-overlay border border-line flex items-center justify-center shrink-0">
          <img src="/lyre-icon.png" alt="Homer" className="h-6 w-6" />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-ink leading-4 truncate">Homer</p>
            <p className="text-[10px] text-ink-3 leading-3.5">US Edition · local-first</p>
          </div>
        )}
      </div>

      <nav className="flex-1 py-2.5 px-2 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const Icon = item.icon;
          const link = (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors relative',
                  collapsed && 'justify-center px-0',
                  isActive ? 'bg-accent/12 text-accent' : 'text-ink-3 hover:text-ink hover:bg-overlay',
                )
              }
            >
              <span className="relative shrink-0">
                <Icon className="h-4.5 w-4.5" />
                {collapsed && item.badge > 0 && (
                  <span
                    className={cn(
                      'absolute -top-1 -right-1.5 h-3.5 min-w-3.5 rounded-full text-[9px] font-bold text-white flex items-center justify-center px-0.5',
                      item.badgeTone === 'warn' ? 'bg-warn-raw text-black' : 'bg-accent',
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </span>
              {!collapsed && (
                <>
                  <span className="truncate">{item.label}</span>
                  {item.badge > 0 && (
                    <span
                      className={cn(
                        'ml-auto rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular',
                        item.badgeTone === 'warn' ? 'bg-warn-raw/15 text-warn' : 'bg-accent/15 text-accent',
                      )}
                    >
                      {item.badge}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
          return collapsed ? (
            <Tip key={item.to} label={item.label}>
              {link}
            </Tip>
          ) : (
            link
          );
        })}
      </nav>

      <div className={cn('px-2 pb-3 space-y-1 shrink-0', collapsed && 'px-1.5')}>
        <ProfileChip collapsed={collapsed} />
        {IS_MOCK && (
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-lg border border-violet/30 bg-violet/10 text-violet px-2.5 py-1.5 text-[11px] font-semibold',
              collapsed && 'justify-center px-0',
            )}
          >
            <FlaskConical className="h-3.5 w-3.5 shrink-0" />
            {!collapsed && 'Mock mode — fixture data'}
          </div>
        )}
        <div
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 text-[11px]',
            collapsed && 'justify-center px-0',
            sse ? 'text-ink-3' : 'text-warn',
          )}
        >
          {sse ? (
            <span className="h-1.5 w-1.5 rounded-full bg-good status-pulse shrink-0" style={{ ['--pulse-color' as string]: 'var(--good)' }} />
          ) : (
            <WifiOff className="h-3 w-3 shrink-0" />
          )}
          {!collapsed && (sse ? 'Live events connected' : 'Reconnecting…')}
        </div>
        <div className={cn('flex items-center gap-1', collapsed && 'flex-col')}>
          <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle theme">
            {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={toggleCollapsed} aria-label="Collapse sidebar">
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </motion.aside>
  );
}

function Shell() {
  const ready = useStore((s) => s.ready);
  const loadError = useStore((s) => s.loadError);
  const loadAll = useStore((s) => s.loadAll);
  useEvents();

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  if (!ready) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-page">
        <div className="h-12 w-12 rounded-xl bg-overlay border border-line flex items-center justify-center">
          <img src="/lyre-icon.png" alt="Homer" className="h-8 w-8" />
        </div>
        <p className="text-sm text-ink-3 inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Connecting to mission control…
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-page px-6 text-center">
        <WifiOff className="h-8 w-8 text-warn" />
        <p className="text-sm font-medium text-ink">Can't reach the local server</p>
        <p className="text-xs text-ink-3 max-w-sm leading-relaxed">
          {loadError}. Start <code className="font-mono text-ink-2">apps/server</code> (port 4750) and retry — or run{' '}
          <code className="font-mono text-ink-2">npm run dev:mock</code> to explore the dashboard with fixture data.
        </p>
        <Button onClick={() => void loadAll()}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="h-full flex bg-page min-w-[1080px]">
      <Sidebar />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="p-5 h-full max-w-[1720px] mx-auto">
          <Routes>
            <Route path="/" element={<MissionControl />} />
            <Route path="/opportunities" element={<Opportunities />} />
            <Route path="/search" element={<SearchView />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/schedule" element={<Schedule />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
      <JobDrawer />
      <ToastHost />
    </div>
  );
}

export default function App() {
  return (
    <TooltipProvider>
      <HashRouter>
        <Shell />
      </HashRouter>
    </TooltipProvider>
  );
}
