import { Request, Response, NextFunction } from 'express';

// last-resort handler: log the message only, never the request body
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error('unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
}