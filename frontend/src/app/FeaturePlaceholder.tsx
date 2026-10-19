import type { ReactNode } from 'react';

interface Props {
  title: string;
  useCase: string;
  owner: string;
  /** Endpoint this page will call, e.g. '/api/concerts'. */
  endpoint: string;
  children?: ReactNode;
}

/** Temporary page body for features that are not built yet. Shows who owns the page. Replace it with the real page. */
export function FeaturePlaceholder({ title, useCase, owner, endpoint, children }: Props) {
  return (
    <section className="card about">
      <p className="eyebrow">
        {useCase} · owner: {owner}
      </p>
      <h1>{title}</h1>
      <div className="about-body">{children}</div>
      <div className="about-note">
        <p className="muted small">
          Placeholder page. The real UI goes here. API: <code>GET {endpoint}</code>
        </p>
      </div>
    </section>
  );
}
