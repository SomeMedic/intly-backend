import { deflateSync, inflateSync } from 'node:zlib';

const ENCODING = 'deflate-base64-v1';
const MAX_COMPRESSED_BYTES = 2_000_000;
const MAX_EXPANDED_BYTES = 64_000_000;

export function encodeBuiltinSeenIds(ids: string[]): {
  seenIdsEncoding: typeof ENCODING;
  seenExternalIdsCompressed: string;
  uniqueSeen: number;
} {
  validateIds(ids);
  const text = ids.join('\n');
  if (Buffer.byteLength(text) > MAX_EXPANDED_BYTES) throw new Error('Built In exact ID history exceeds its resumable checkpoint limit');
  const compressed = deflateSync(text);
  if (compressed.length > MAX_COMPRESSED_BYTES) throw new Error('Built In compressed ID history exceeds its resumable checkpoint limit');
  return { seenIdsEncoding: ENCODING, seenExternalIdsCompressed: compressed.toString('base64'), uniqueSeen: ids.length };
}

export function decodeBuiltinSeenIds(checkpoint: Record<string, unknown>): string[] | undefined {
  if (checkpoint.seenIdsEncoding === undefined && checkpoint.seenExternalIdsCompressed === undefined) return undefined;
  if (checkpoint.seenIdsEncoding !== ENCODING || typeof checkpoint.seenExternalIdsCompressed !== 'string') {
    throw new Error('Built In checkpoint has an unsupported exact ID history encoding');
  }
  const encoded = checkpoint.seenExternalIdsCompressed;
  if (encoded.length > Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Built In checkpoint has malformed compressed ID history');
  }
  const compressed = Buffer.from(encoded, 'base64');
  if (compressed.toString('base64') !== encoded || compressed.length > MAX_COMPRESSED_BYTES) throw new Error('Built In checkpoint has malformed compressed ID history');
  let text: string;
  try {
    text = inflateSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES }).toString('utf8');
  } catch {
    throw new Error('Built In checkpoint compressed ID history could not be restored');
  }
  const ids = text === '' ? [] : text.split('\n');
  validateIds(ids);
  if (checkpoint.uniqueSeen !== ids.length) throw new Error('Built In checkpoint exact ID history count does not match uniqueSeen');
  if (checkpoint.seenExternalIds !== undefined) {
    const legacy = checkpoint.seenExternalIds;
    if (!Array.isArray(legacy) || legacy.length !== ids.length || legacy.some((id, index) => id !== ids[index])) {
      throw new Error('Built In checkpoint contains conflicting exact ID histories');
    }
  }
  return ids;
}

function validateIds(ids: unknown[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id) || seen.has(id)) throw new Error('Built In checkpoint exact ID history has invalid or duplicate native IDs');
    seen.add(id);
  }
}
