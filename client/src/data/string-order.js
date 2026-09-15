import casefold from '../../../shared/fixtures/casefold.json' with { type: 'json' };

const folds = casefold.mappings ?? casefold;
const digit = value => value >= '0' && value <= '9';
const failure = message => Object.assign(new Error(message), { code: 'invalid_order', status: 422 });

export function compareCodepoints(left, right) {
  const a = Array.from(left.normalize('NFC')), b = Array.from(right.normalize('NFC'));
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const result = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (result) return Math.sign(result);
  }
  return Math.sign(a.length - b.length);
}

export function normalizeStringOrder(input = {}, definitionVersion = 1) {
  if (![1, 2].includes(definitionVersion)) throw failure('Ordering requires definition version 1 or 2');
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['order', 'caseSensitive'].includes(key))) throw failure('Unknown string ordering option');
  if (definitionVersion === 1 && Object.keys(input).length) throw failure('String ordering options require definition version 2');
  if (input.order !== undefined && !['codepoint', 'natural'].includes(input.order)) throw failure('String order must be codepoint or natural');
  if (input.caseSensitive !== undefined && typeof input.caseSensitive !== 'boolean') throw failure('String ordering caseSensitive must be boolean');
  return { order: input.order ?? 'codepoint', caseSensitive: input.caseSensitive ?? true };
}

function comparable(value, caseSensitive) {
  const normalized = value.normalize('NFC');
  return caseSensitive ? normalized : Array.from(normalized, char => folds[String(char.codePointAt(0))] ?? char).join('').normalize('NFC');
}

function naturalCompare(left, right) {
  const a = Array.from(left), b = Array.from(right);
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (digit(a[i]) && digit(b[j])) {
      const startA = i, startB = j;
      while (i < a.length && digit(a[i])) i++;
      while (j < b.length && digit(b[j])) j++;
      let significantA = startA, significantB = startB;
      while (significantA < i - 1 && a[significantA] === '0') significantA++;
      while (significantB < j - 1 && b[significantB] === '0') significantB++;
      const magnitude = (i - significantA) - (j - significantB);
      if (magnitude) return Math.sign(magnitude);
      for (let offset = 0; offset < i - significantA; offset++) {
        const difference = a[significantA + offset].codePointAt(0) - b[significantB + offset].codePointAt(0);
        if (difference) return Math.sign(difference);
      }
      const length = (i - startA) - (j - startB);
      if (length) return Math.sign(length);
    } else {
      const difference = a[i].codePointAt(0) - b[j].codePointAt(0);
      if (difference) return Math.sign(difference);
      i++; j++;
    }
  }
  return Math.sign((a.length - i) - (b.length - j));
}

export function compareOrderedText(left, right, { order = 'codepoint', caseSensitive = true } = {}) {
  const a = comparable(left, caseSensitive), b = comparable(right, caseSensitive);
  const result = order === 'natural' ? naturalCompare(a, b) : compareCodepoints(a, b);
  return result || compareCodepoints(left, right);
}
