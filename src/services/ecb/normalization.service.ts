import { z } from 'zod';

import { canonicalizeBin } from '../../schemas/property-identifiers.schema';
import {
  ECB_BALANCE_DUE_API_FIELD,
  ECB_BIN_API_FIELD,
  ECB_ISSUE_DATE_API_FIELD,
  ECB_VIOLATION_NUMBER_API_FIELD,
  ECB_VIOLATION_STATUS_API_FIELD,
  ecbViolationSchema,
  extractEcbSourceIdentity,
  type EcbViolationSourceRow,
} from '../../schemas/ecb.schema';

export type NormalizedEcbViolation = {
  sourceId: string;
  socrataRowId: string;
  bin: string;
  violationNumber: string | null;
  issueDate: Date | null;
  ecbViolationStatus: string | null;
  balanceDue: number | null;
  sourceRowUpdatedAt: Date;
};

function invalidField(field: string, message: string): never {
  throw new z.ZodError([
    {
      code: z.ZodIssueCode.custom,
      path: [field],
      message,
    },
  ]);
}

function nullableText(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized.length === 0 ? null : normalized;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function parseIsoTimestamp(text: string): Date | null {
  const timestamp = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    text,
  );
  if (timestamp === null) {
    return null;
  }

  const year = Number(timestamp[1]);
  const month = Number(timestamp[2]);
  const day = Number(timestamp[3]);
  const hour = Number(timestamp[4]);
  const minute = Number(timestamp[5]);
  const second = Number(timestamp[6]);
  const millisecond = Number((timestamp[7] ?? '').padEnd(3, '0').slice(0, 3));
  const timezone = timestamp[8];

  if (
    !validCalendarDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (timezone !== 'Z') {
    const offsetHour = Number(timezone.slice(1, 3));
    const offsetMinute = Number(timezone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
    const direction = timezone[0] === '+' ? 1 : -1;
    offsetMinutes = direction * (offsetHour * 60 + offsetMinute);
  }

  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) -
      offsetMinutes * 60_000,
  );
}

export function parseEcbDate(value: string | number | null | undefined, field: string): Date | null {
  if (value === null || value === undefined || String(value).trim().length === 0) {
    return null;
  }

  const text = String(value).trim();
  const compactDate = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (compactDate !== null) {
    const year = Number(compactDate[1]);
    const month = Number(compactDate[2]);
    const day = Number(compactDate[3]);
    if (validCalendarDate(year, month, day)) {
      return new Date(Date.UTC(year, month - 1, day));
    }
    return invalidField(field, `must be a valid date, received ${JSON.stringify(value)}`);
  }

  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (validCalendarDate(year, month, day)) {
      return new Date(Date.UTC(year, month - 1, day));
    }
    return invalidField(field, `must be a valid date, received ${JSON.stringify(value)}`);
  }

  const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (slashDate !== null) {
    const month = Number(slashDate[1]);
    const day = Number(slashDate[2]);
    const year = Number(slashDate[3]);
    if (validCalendarDate(year, month, day)) {
      return new Date(Date.UTC(year, month - 1, day));
    }
    return invalidField(field, `must be a valid date, received ${JSON.stringify(value)}`);
  }

  const timestamp = parseIsoTimestamp(text);
  if (timestamp !== null) {
    return timestamp;
  }

  return invalidField(field, `must be a valid date, received ${JSON.stringify(value)}`);
}

function parseIssueDate(value: string | number | null | undefined): Date | null {
  if (value === '0') {
    return null;
  }

  return parseEcbDate(value, ECB_ISSUE_DATE_API_FIELD);
}

function parseSourceTimestamp(value: string, field: string): Date {
  const parsed = parseEcbDate(value, field);
  if (parsed === null) {
    return invalidField(field, 'must contain a timestamp');
  }
  return parsed;
}

function parseNumber(value: string | number | null | undefined, field: string): number | null {
  if (value === null || value === undefined || String(value).trim().length === 0) {
    return null;
  }

  const text = String(value).trim().replaceAll(',', '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    return invalidField(field, `must be a decimal number, received ${JSON.stringify(value)}`);
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return invalidField(field, 'must be a finite decimal number');
  }
  return parsed;
}

function sourceField(
  row: EcbViolationSourceRow,
  field:
    | typeof ECB_VIOLATION_NUMBER_API_FIELD
    | typeof ECB_ISSUE_DATE_API_FIELD
    | typeof ECB_VIOLATION_STATUS_API_FIELD
    | typeof ECB_BALANCE_DUE_API_FIELD,
): string | number | null | undefined {
  return row[field] as string | number | null | undefined;
}

/** Normalize a validated ECB source row into values accepted by PostgreSQL. */
export function normalizeEcbViolation(input: unknown): NormalizedEcbViolation {
  const row = ecbViolationSchema.parse(input);
  const identity = extractEcbSourceIdentity(row);

  let bin: string;
  try {
    bin = canonicalizeBin(String(row[ECB_BIN_API_FIELD]));
  } catch (error) {
    return invalidField(
      ECB_BIN_API_FIELD,
      `must be a canonical 7-digit BIN: ${String(error)}`,
    );
  }

  return {
    sourceId: identity.sourceId,
    socrataRowId: identity.socrataRowId,
    bin,
    violationNumber: nullableText(sourceField(row, ECB_VIOLATION_NUMBER_API_FIELD)),
    issueDate: parseIssueDate(sourceField(row, ECB_ISSUE_DATE_API_FIELD)),
    ecbViolationStatus: nullableText(sourceField(row, ECB_VIOLATION_STATUS_API_FIELD)),
    balanceDue: parseNumber(sourceField(row, ECB_BALANCE_DUE_API_FIELD), ECB_BALANCE_DUE_API_FIELD),
    sourceRowUpdatedAt: parseSourceTimestamp(
      identity.sourceRowUpdatedAt,
      ':updated_at',
    ),
  };
}

export const normalizeEcbRow = normalizeEcbViolation;
export const normalizeEcbViolationRow = normalizeEcbViolation;
