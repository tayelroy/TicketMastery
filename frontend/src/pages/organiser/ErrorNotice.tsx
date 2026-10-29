import { describeError } from './types';

/** Shows a failed API call with its validation details (see describeError). */
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  const { message, items } = describeError(error);
  return (
    <div className="org-error" role="alert">
      <strong>{message}</strong>
      {items.length > 0 && (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
