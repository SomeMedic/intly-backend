export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function safePublicHostOrSlug(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]{1,252}[a-z0-9]$/.test(normalized)) return false;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) return false;
  if (normalized.startsWith('10.') || normalized.startsWith('127.') || normalized.startsWith('169.254.')) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return false;
  if (normalized.startsWith('192.168.')) return false;
  return true;
}

export async function loadRuntimePackage<T = unknown>(specifier: string): Promise<T> {
  const importer = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<T>;
  return importer(specifier);
}

export function firstTextLine(text: string, fallback: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 180) ?? fallback;
}
