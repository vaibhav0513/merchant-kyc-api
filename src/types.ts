export type Role = 'MERCHANT' | 'MAKER' | 'CHECKER' | 'ADMIN';

export interface AuthUser {
  id: number;
  email: string;
  role: Role;
}

// let TypeScript know req.user exists after our auth middleware runs
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}