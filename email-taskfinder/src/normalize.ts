// Body normalization: strip HTML, strip quoted-reply chains, strip footer
// boilerplate, cap to MAX_BODY_CHARS with an explicit truncation marker.

export const MAX_BODY_CHARS = 5000;

function stripQuotedReply(s: string): string {
  const patterns: RegExp[] = [
    /^On .{1,200} wrote:\s*$/m,
    /^From:.{1,500}\nSent:.{1,200}\nTo:/m,
    /^-+\s*Original Message\s*-+/im,
    /(?:^>.*\n){3,}/m,
    /^-- $/m,
  ];
  let cut = s.length;
  for (const p of patterns) {
    const m = p.exec(s);
    if (m && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut).trim();
}

function stripFooterBoilerplate(s: string): string {
  if (s.length < 300) return s;
  const threshold = Math.floor((s.length * 2) / 3);
  const patterns: RegExp[] = [
    /Unsubscribe/i,
    /View (this email )?in (your )?browser/i,
    /You (received|are receiving) this/i,
    /© \d{4}\b/,
    /This (message|email) (contains|may contain) confidential/i,
  ];
  let cut = s.length;
  for (const p of patterns) {
    const m = p.exec(s);
    if (m && m.index >= threshold && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut).trim();
}

export function normalizeBody(raw: string): string {
  const noTags = raw
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const decoded = noTags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  const collapsed = decoded
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const stripped = stripFooterBoilerplate(stripQuotedReply(collapsed));
  if (stripped.length > MAX_BODY_CHARS) {
    return (
      stripped.slice(0, MAX_BODY_CHARS) +
      `\n[…body truncated, ${stripped.length} chars original]`
    );
  }
  return stripped;
}
