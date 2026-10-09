import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { Observable, map } from 'rxjs';

const PRESERVE_JSON = new Set(['rawPayload', 'sourceMetadata', 'documentJson', 'structuredOutput']);
function serialize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof StreamableFile || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(serialize);
  const document = value as { toJSON?: () => unknown };
  if (typeof document.toJSON === 'function') return serialize(document.toJSON());
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '__v').map(([key, child]) => [key === '_id' ? 'id' : key, PRESERVE_JSON.has(key) ? child : serialize(child)]));
}
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> { return next.handle().pipe(map(serialize)); }
}
