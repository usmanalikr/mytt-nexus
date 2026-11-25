// Constant-time token checks for the two functions that guard themselves with
// their own header instead of Supabase's JWT check: brain-ingest (D12) and
// brain-curator.

/** Constant time, so a wrong token cannot be found a character at a time.
 *  Compares the full length of both strings whatever happens. */
export function tokensMatch(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Only from the named header, never `Authorization`. A missing or empty token
 *  is refused, and so is any token when the expected one is unset. */
export function headerTokenMatches(request: Request, header: string, expected: string): boolean {
  if (!expected) return false;
  const given = request.headers.get(header);
  if (!given) return false;
  return tokensMatch(given, expected);
}
