import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

// lets us throw "409 Conflict" etc. from anywhere, including inside a transaction
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  logger.error('unhandled error:', { message: err.message });
  res.status(500).json({ error: 'Internal server error' });
}