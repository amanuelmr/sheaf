import {
  minorDigits,
  type CustomFieldData,
  type CustomFieldType,
  type MonetaryValue,
} from '@sheaf/protocol';

/** What a form shows for a stored value: always text, except a checkbox's yes/no. */
export function toInput(type: CustomFieldType, value: CustomFieldData | null): string {
  if (value === null) return '';
  switch (type) {
    case 'boolean':
      return value === true ? 'true' : 'false';
    case 'monetary': {
      const { minor, currency } = value as MonetaryValue;
      return (minor / 10 ** minorDigits(currency)).toFixed(minorDigits(currency));
    }
    case 'documentLink':
      return (value as readonly string[]).join(',');
    case 'text':
    case 'url':
    case 'select':
    case 'date':
    case 'integer':
    case 'number':
      return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }
}

/**
 * The value a form's text stands for, or `undefined` when it stands for nothing
 * valid. Empty text is `null`: the field kept, with no value.
 *
 * Amounts are parsed digit by digit rather than through floating point, so "0.29"
 * is 29 minor units, not 28.999….
 */
export function fromInput(
  type: CustomFieldType,
  text: string,
  currency = 'EUR',
): CustomFieldData | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  switch (type) {
    case 'text':
    case 'url':
    case 'select':
    case 'date':
      return trimmed;
    case 'boolean':
      return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined;
    case 'integer':
      return /^-?\d{1,15}$/.test(trimmed) ? Number(trimmed) : undefined;
    case 'number': {
      if (!/^-?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return undefined;
      return Number(trimmed);
    }
    case 'monetary': {
      const digits = minorDigits(currency);
      const match = /^(-?)(\d{1,13})(?:[.,](\d+))?$/.exec(trimmed);
      if (match === null) return undefined;
      const fraction = match[3] ?? '';
      if (fraction.length > digits) return undefined;
      const minor = Number(match[2]! + fraction.padEnd(digits, '0'));
      return { minor: match[1] === '-' ? -minor : minor, currency };
    }
    case 'documentLink':
      return trimmed
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== '');
  }
}
