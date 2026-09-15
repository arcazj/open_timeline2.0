import { ProviderError } from './data-provider.js';

export function validateRowPageOptions(options) {
  if (options.pageIndex === undefined) return;
  if (options.cursor != null) throw new ProviderError('invalid_pagination', 'Specify either cursor or pageIndex, not both', 422);
  if (!Number.isSafeInteger(options.pageIndex) || options.pageIndex < 0) {
    throw new ProviderError('invalid_page_index', 'pageIndex must be a nonnegative safe integer', 422);
  }
}
