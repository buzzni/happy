import { describe, expect, it } from 'vitest';
import { isRedisConfigured, resolveRedisClientOptions } from './createRedisClient';

describe('isRedisConfigured', () => {
    it('shouldBeFalseWhenNoRedisEnvVarsSet', () => {
        expect(isRedisConfigured({})).toBe(false);
    });

    it('shouldBeTrueWhenRedisUrlSet', () => {
        expect(isRedisConfigured({ REDIS_URL: 'redis://localhost:6379' })).toBe(true);
    });

    it('shouldBeTrueWhenSentinelsAndMasterNameSet', () => {
        expect(isRedisConfigured({
            REDIS_SENTINELS: 'sentinel-0:26379',
            REDIS_SENTINEL_MASTER_NAME: 'mymaster',
        })).toBe(true);
    });

    it('shouldBeFalseWhenOnlySentinelsSetWithoutMasterName', () => {
        expect(isRedisConfigured({ REDIS_SENTINELS: 'sentinel-0:26379' })).toBe(false);
    });
});

describe('resolveRedisClientOptions', () => {
    it('shouldReturnUrlStringWhenOnlyRedisUrlSet', () => {
        const options = resolveRedisClientOptions({ REDIS_URL: 'redis://localhost:6379' });
        expect(options).toBe('redis://localhost:6379');
    });

    it('shouldParseCommaSeparatedSentinelsIntoHostPortPairs', () => {
        const options = resolveRedisClientOptions({
            REDIS_SENTINELS: 'sentinel-0:26379,sentinel-1:26379, sentinel-2:26379 ',
            REDIS_SENTINEL_MASTER_NAME: 'aplus-dev-studio-master',
        });
        expect(options).toMatchObject({
            sentinels: [
                { host: 'sentinel-0', port: 26379 },
                { host: 'sentinel-1', port: 26379 },
                { host: 'sentinel-2', port: 26379 },
            ],
            name: 'aplus-dev-studio-master',
            role: 'master',
        });
    });

    it('shouldPreferSentinelConfigOverRedisUrlWhenBothSet', () => {
        const options = resolveRedisClientOptions({
            REDIS_URL: 'redis://static-host:6379',
            REDIS_SENTINELS: 'sentinel-0:26379',
            REDIS_SENTINEL_MASTER_NAME: 'aplus-dev-studio-master',
        });
        expect(options).toMatchObject({ name: 'aplus-dev-studio-master' });
    });

    it('shouldThrowWhenNeitherRedisUrlNorSentinelsSet', () => {
        expect(() => resolveRedisClientOptions({})).toThrow();
    });

    it('shouldReconnectOnReadonlyErrorSoTheClientRerequestsTheCurrentMasterFromSentinel', () => {
        const options = resolveRedisClientOptions({
            REDIS_SENTINELS: 'sentinel-0:26379',
            REDIS_SENTINEL_MASTER_NAME: 'aplus-dev-studio-master',
        });
        if (typeof options === 'string') throw new Error('expected sentinel options object');
        const reconnectOnError = options.reconnectOnError!;
        expect(reconnectOnError(new Error('READONLY You can\'t write against a read only replica.'))).toBe(2);
        expect(reconnectOnError(new Error('ECONNRESET'))).toBe(false);
    });
});
