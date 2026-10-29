import { Link, NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { features, type NavItem } from '../features';
import { ApiStatus } from './ApiStatus';

export function Layout() {
  const { session, signOut, hasGroup } = useAuth();

  const visible = (item: NavItem) =>
    item.requires === undefined || (item.requires === true ? !!session : hasGroup(item.requires));
  const navItems = features.flatMap((f) => f.nav ?? []).filter(visible);

  return (
    <div className="shell">
      <header className="topbar glass">
        <Link to="/" className="brand">
          <BrandMark />
          TicketMastery
        </Link>
        <nav className="nav">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === '/'}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="user">
          {session ? (
            <>
              <span className="user-chip">
                <span className="avatar">{(session.email ?? session.userId).charAt(0)}</span>
                {session.email ?? session.userId}
                {session.groups.map((g) => (
                  <span key={g} className="badge">
                    {g}
                  </span>
                ))}
              </span>
              <button type="button" className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <Link to="/login" className="btn small">
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main className="content">
        <Outlet />
      </main>

      <footer className="footer">
        <span>© TicketMastery · Live music, fair queues.</span>
        <ApiStatus />
      </footer>
    </div>
  );
}

function BrandMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 5h16a1 1 0 0 1 1 1v3.2a2.8 2.8 0 0 0 0 5.6V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3.2a2.8 2.8 0 0 0 0-5.6V6a1 1 0 0 1 1-1z"
        fill="#ffffff"
      />
      <path d="M15.5 6.5v11" stroke="#e2674d" strokeWidth="1.4" strokeDasharray="1.6 1.6" />
    </svg>
  );
}
