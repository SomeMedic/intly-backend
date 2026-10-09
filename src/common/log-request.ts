/** Prevent short-lived file download capabilities from entering HTTP request logs. */
function isDownloadTicketKey(key: string): boolean {
  return key === 'ticket' || key.startsWith('ticket[');
}

export function redactFileDownloadTicket(url: string): string {
  try {
    const parsed = new URL(url, 'http://request-log.invalid');
    const ticketKeys = [...parsed.searchParams.keys()].filter(isDownloadTicketKey);
    if (ticketKeys.length === 0) return url;
    for (const key of ticketKeys) parsed.searchParams.set(key, '[Redacted]');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '[Invalid request URL]';
  }
}

export function serializeLogRequest(request: Record<string, unknown>): Record<string, unknown> {
  const query = request.query;
  const safeQuery = query !== null && typeof query === 'object'
    ? Object.fromEntries(Object.entries(query).map(([key, value]) => [key, isDownloadTicketKey(key) ? '[Redacted]' : value]))
    : query;
  return {
    ...request,
    ...(typeof request.url === 'string' ? { url: redactFileDownloadTicket(request.url) } : {}),
    ...(safeQuery !== query ? { query: safeQuery } : {}),
  };
}
