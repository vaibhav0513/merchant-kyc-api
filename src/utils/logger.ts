import { redact } from './mask';

// every log goes through redact(), so nobody can log a PAN by accident
export const logger = {
  info: (msg: string, data?: unknown) => console.log(msg, data ? JSON.stringify(redact(data)) : ''),
  error: (msg: string, data?: unknown) => console.error(msg, data ? JSON.stringify(redact(data)) : ''),
};