import type { ZodError } from 'zod';

function formatIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'environment';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export class ConfigError extends Error {
  readonly issues: ZodError;

  constructor(issues: ZodError) {
    super(`Invalid application configuration: ${formatIssues(issues)}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}
