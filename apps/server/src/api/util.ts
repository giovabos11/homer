import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

/** Error with an HTTP status; the global handler renders {error, detail}. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    public readonly detail?: string,
  ) {
    super(detail ?? error);
  }
}

export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    throw new ApiError(400, 'validation_error', formatZod(result.error));
  }
  return result.data;
}

export function parseQuery<T>(schema: ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) {
    throw new ApiError(400, 'validation_error', formatZod(result.error));
  }
  return result.data;
}

export function idParam(req: Request, name = 'id'): number {
  const raw = req.params[name];
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(400, 'validation_error', `Invalid ${name}: ${raw}`);
  }
  return id;
}

function formatZod(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

/** Global error handler → { error, detail } with 4xx/5xx (contract). */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.error, detail: err.detail });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_error', detail: formatZod(err) });
    return;
  }
  // Errors from middleware that carry an HTTP status (express.static traversal
  // → 403 ForbiddenError, body-parser → 400, …) keep their 4xx status instead
  // of collapsing to 500.
  const status = (err as { status?: number; statusCode?: number })?.status
    ?? (err as { statusCode?: number })?.statusCode;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({ error: status === 403 ? 'forbidden' : 'bad_request', detail: message });
    return;
  }
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: 'internal_error', detail: message });
}
