import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request & { id?: string }>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = exception instanceof HttpException ? exception.getResponse() : null;
    const object = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
    const message = status >= 500 ? 'Service temporarily unavailable' : object.message ?? raw ?? 'Request failed';
    const codes: Record<number, string> = { 400: 'VALIDATION_ERROR', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'FILE_TOO_LARGE', 429: 'RATE_LIMITED', 503: 'SERVICE_UNAVAILABLE' };
    response.status(status).json({ error: { code: object.code ?? codes[status] ?? 'SERVER_ERROR', message: Array.isArray(message) ? message.join('; ') : message, requestId: request.id, ...(object.details ? { details: object.details } : {}) } });
  }
}
