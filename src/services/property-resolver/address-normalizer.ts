import { AppError } from '../../errors';

const WHITESPACE_PATTERN = /\s+/g;

const UNIT_DESIGNATOR_PATTERN =
  /\s+(?:(?<keyword>apt|apartment|unit|suite|ste|floor|fl)\.?\s+(?<keywordValue>[A-Za-z0-9][A-Za-z0-9-]*)|#\s*(?<hashValue>[A-Za-z0-9][A-Za-z0-9-]*))\s*$/i;

const UNIT_ONLY_PATTERN =
  /^(?<keyword>apt|apartment|unit|suite|ste|floor|fl)\.?\s+(?<keywordValue>[A-Za-z0-9][A-Za-z0-9-]*)$/i;

const ORDINAL_PATTERN = /^\d+(?:st|nd|rd|th)$/i;
const QUEENS_HOUSE_NUMBER_PATTERN = /^\d+-\d+$/;
const HAS_ALPHANUMERIC_PATTERN = /[A-Za-z0-9]/;

type UnitMatch = {
  keyword: 'Apt' | 'Unit' | 'Ste' | 'Fl' | '#';
  value: string;
};

export type AddressNormalizationResult = {
  normalizedBaseAddress: string;
  normalizedUnitDesignation: string | null;
  normalizedInput: string;
};

function collapseWhitespace(value: string): string {
  return value.trim().replace(WHITESPACE_PATTERN, ' ');
}

function normalizeHyphenatedHouseNumber(value: string): string {
  return value.replace(/\u2013|\u2014/g, '-');
}

function normalizeAddressToken(token: string): string {
  const normalizedToken = normalizeHyphenatedHouseNumber(token);

  if (QUEENS_HOUSE_NUMBER_PATTERN.test(normalizedToken)) {
    return normalizedToken;
  }

  if (/^\d+$/.test(normalizedToken)) {
    return normalizedToken;
  }

  if (ORDINAL_PATTERN.test(normalizedToken)) {
    return normalizedToken.toLowerCase();
  }

  const houseNumberWithSuffix = normalizedToken.match(/^(\d+)([A-Za-z]+)$/);
  if (houseNumberWithSuffix) {
    return `${houseNumberWithSuffix[1]}${houseNumberWithSuffix[2].toUpperCase()}`;
  }

  if (normalizedToken.length === 0) {
    return normalizedToken;
  }

  return normalizedToken.charAt(0).toUpperCase() + normalizedToken.slice(1).toLowerCase();
}

function normalizeAddressTokens(value: string): string {
  return collapseWhitespace(value)
    .split(' ')
    .map((token) => normalizeAddressToken(token))
    .join(' ');
}

function normalizeUnitValue(value: string): string {
  const trimmed = value.trim();
  const alphaSuffix = trimmed.match(/^(\d+)([A-Za-z]+)$/);

  if (alphaSuffix) {
    return `${alphaSuffix[1]}${alphaSuffix[2].toUpperCase()}`;
  }

  return trimmed.toUpperCase() === trimmed && trimmed.toLowerCase() !== trimmed
    ? trimmed
    : trimmed.toUpperCase();
}

function canonicalUnitKeyword(keyword: string): UnitMatch['keyword'] {
  switch (keyword.toLowerCase()) {
    case 'apt':
    case 'apartment':
      return 'Apt';
    case 'unit':
      return 'Unit';
    case 'suite':
    case 'ste':
      return 'Ste';
    case 'floor':
    case 'fl':
      return 'Fl';
    default:
      return 'Apt';
  }
}

function extractUnitDesignator(value: string): { baseAddress: string; unit: UnitMatch | null } {
  const unitOnlyMatch = value.match(UNIT_ONLY_PATTERN);
  if (unitOnlyMatch?.groups?.keyword && unitOnlyMatch.groups.keywordValue) {
    return {
      baseAddress: '',
      unit: {
        keyword: canonicalUnitKeyword(unitOnlyMatch.groups.keyword),
        value: normalizeUnitValue(unitOnlyMatch.groups.keywordValue),
      },
    };
  }

  const match = value.match(UNIT_DESIGNATOR_PATTERN);

  if (!match?.groups) {
    return { baseAddress: value, unit: null };
  }

  const rawValue = match.groups.keywordValue ?? match.groups.hashValue;
  if (!rawValue) {
    return { baseAddress: value, unit: null };
  }

  const keyword = match.groups.keyword
    ? canonicalUnitKeyword(match.groups.keyword)
    : '#';

  const baseAddress = value.slice(0, match.index).trim();
  return {
    baseAddress,
    unit: {
      keyword,
      value: normalizeUnitValue(rawValue),
    },
  };
}

function formatUnitSegment(unit: UnitMatch): string {
  if (unit.keyword === '#') {
    return `# ${unit.value}`;
  }

  return `${unit.keyword} ${unit.value}`;
}

function assertValidAddressInput(input: string): void {
  const collapsed = collapseWhitespace(input);

  if (collapsed.length === 0) {
    throw new AppError({
      code: 'INVALID_ADDRESS_INPUT',
      message: 'Address input must not be empty',
      statusCode: 400,
    });
  }

  if (!HAS_ALPHANUMERIC_PATTERN.test(collapsed)) {
    throw new AppError({
      code: 'INVALID_ADDRESS_INPUT',
      message: 'Address input must contain at least one alphanumeric character',
      statusCode: 400,
    });
  }
}

function assertValidBaseAddress(baseAddress: string): void {
  if (baseAddress.length === 0 || !HAS_ALPHANUMERIC_PATTERN.test(baseAddress)) {
    throw new AppError({
      code: 'INVALID_ADDRESS_INPUT',
      message: 'Address input must include a base street address',
      statusCode: 400,
    });
  }
}

export function normalizeAddress(input: string): AddressNormalizationResult {
  assertValidAddressInput(input);

  const collapsed = collapseWhitespace(input);
  const { baseAddress, unit } = extractUnitDesignator(collapsed);
  const normalizedBaseAddress = normalizeAddressTokens(baseAddress);

  assertValidBaseAddress(normalizedBaseAddress);

  const normalizedUnitDesignation = unit?.value ?? null;
  const normalizedInput = unit
    ? `${normalizedBaseAddress} ${formatUnitSegment(unit)}`
    : normalizedBaseAddress;

  return {
    normalizedBaseAddress,
    normalizedUnitDesignation,
    normalizedInput,
  };
}
