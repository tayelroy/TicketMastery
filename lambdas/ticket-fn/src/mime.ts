export interface RawEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachment?: { filename: string; contentType: string; data: Uint8Array };
}

const CRLF = '\r\n';

/** Base64 in 76-character lines, as MIME requires. */
function base64Lines(data: Uint8Array | string): string {
  const encoded = Buffer.from(data).toString('base64');
  return encoded.match(/.{1,76}/g)?.join(CRLF) ?? '';
}

/**
 * RFC 2047 encoded words for a header value. Always encoding (not only for non-ASCII) also means a concert title
 * containing CR/LF can't inject headers. Chunks stay at most 45 bytes of UTF-8 so each word fits the 75-character
 * limit, and characters are never split across words.
 */
function encodeHeader(value: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const ch of value) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(`${CRLF} `);
}

/** Addresses come from configuration and Cognito, but a stray line break must still never reach the headers. */
const headerSafe = (value: string) => value.replace(/[\r\n]/g, '');

/** multipart/mixed: a UTF-8 text part and an optional attachment, for SES v2 SendEmail with Content.Raw. */
export function buildRawEmail(email: RawEmail, boundary: string): Uint8Array {
  const lines = [
    `From: TicketMastery <${headerSafe(email.from)}>`,
    `To: ${headerSafe(email.to)}`,
    `Subject: ${encodeHeader(email.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(email.text),
    '',
  ];
  if (email.attachment) {
    const filename = headerSafe(email.attachment.filename).replace(/"/g, '');
    lines.push(
      `--${boundary}`,
      `Content-Type: ${email.attachment.contentType}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(email.attachment.data),
      '',
    );
  }
  lines.push(`--${boundary}--`, '');
  return Buffer.from(lines.join(CRLF), 'utf8');
}
