export type AppErrorOptions = {
  message: string;
  code: string;
  statusCode?: number;
  cause?: unknown;
  isOperational?: boolean;
};

export class AppError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly cause?: unknown;
  readonly isOperational: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
    this.isOperational = options.isOperational ?? true;
  }
}
