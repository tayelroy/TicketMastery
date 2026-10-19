import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <section className="card notfound">
      <p className="big">404</p>
      <h1>This show isn't on the lineup</h1>
      <p className="muted">The page you're looking for doesn't exist or has moved.</p>
      <div className="row">
        <Link to="/" className="btn">
          Browse concerts
        </Link>
      </div>
    </section>
  );
}
