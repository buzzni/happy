import { describe, expect, it } from 'vitest';

import { isOlderRuntimeVersion } from './cliVersion';

describe('isOlderRuntimeVersion', () => {
  it('orders aplus builds numerically, not lexically', () => {
    expect(isOlderRuntimeVersion('1.1.10-aplus.388', '1.1.10-aplus.394')).toBe(true);
    expect(isOlderRuntimeVersion('1.1.10-aplus.99', '1.1.10-aplus.388')).toBe(true);
    expect(isOlderRuntimeVersion('1.1.9', '1.1.10-aplus.1')).toBe(true);
  });

  it('is false for the same, a newer or an unreadable version', () => {
    expect(isOlderRuntimeVersion('1.1.10-aplus.394', '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion('1.1.10-aplus.400', '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion(undefined, '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion('dev', '1.1.10-aplus.394')).toBe(false);
    expect(isOlderRuntimeVersion('1.1.10-aplus.388', 'dev')).toBe(false);
  });
});
