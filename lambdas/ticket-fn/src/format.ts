/** Fans are in Singapore and the venue is too, so every time on the ticket is SGT whatever the Lambda's TZ is. */
const sgt = new Intl.DateTimeFormat('en-SG', {
  timeZone: 'Asia/Singapore',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

export function formatSgt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${sgt.format(date)} SGT`;
}

/** "SGD 128.00": the currency code is explicit because "$" alone is ambiguous on a ticket. */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${currency} ${(Math.abs(cents) / 100).toFixed(2)}`;
}
