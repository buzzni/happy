import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    openCheckpointFile,
    sealCheckpointBuffer,
    sealCheckpointStream,
    type CheckpointCryptoBinding,
} from './managedCheckpointCrypto';

const faults = vi.hoisted(() => ({
    wrap: undefined as undefined | ((path: string, flags: string, handle: import('node:fs/promises').FileHandle) => import('node:fs/promises').FileHandle | Promise<import('node:fs/promises').FileHandle>),
    destinations: 0,
}));
vi.mock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args);
        if (String(args[1]) === 'wx') faults.destinations++;
        return faults.wrap?.(String(args[0]), String(args[1]), handle) ?? handle;
    } };
});

const created: string[] = [];
const key = randomBytes(32);
const binding: CheckpointCryptoBinding = {
    tenantId: 'co_1',
    projectId: 'pr_1',
    checkpointId: 'a'.repeat(64),
    area: 'project',
};

async function scratch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mc-crypto-'));
    created.push(dir);
    return dir;
}

afterEach(async () => {
    faults.wrap = undefined;
    faults.destinations = 0;
    while (created.length) await rm(created.pop()!, { recursive: true, force: true });
});

async function seal(plaintext: Buffer, overrides: Partial<CheckpointCryptoBinding> = {}): Promise<string> {
    const destination = join(await scratch(), 'object.enc');
    await sealCheckpointBuffer({ plaintext, destination, key, binding: { ...binding, ...overrides } });
    return destination;
}

async function open(source: string, overrides: Partial<CheckpointCryptoBinding> = {}, openKey = key) {
    const destination = join(await scratch(), 'plain');
    const result = await openCheckpointFile({
        source, destination, key: openKey, binding: { ...binding, ...overrides },
    });
    return { ...result, destination };
}

describe('managed checkpoint envelope', () => {
    it('shouldRoundTripUnderTheSameBindingAndReportThePlaintextDigest', async () => {
        const plaintext = Buffer.from('hello checkpoint');
        const opened = await open(await seal(plaintext));
        expect(await readFile(opened.destination)).toEqual(plaintext);
        expect(opened.bytes).toBe(plaintext.length);
        expect(opened.sha256).toBe(createHash('sha256').update(plaintext).digest('hex'));
    });

    it('shouldNotProduceTheSameCiphertextTwice', async () => {
        const a = await readFile(await seal(Buffer.from('x')));
        const b = await readFile(await seal(Buffer.from('x')));
        expect(a.equals(b)).toBe(false);
    });

    it('shouldRefuseDecryptionUnderADifferentTenantProjectCheckpointOrArea', async () => {
        const sealed = await seal(Buffer.from('secret'));
        for (const other of [
            { tenantId: 'co_2' },
            { projectId: 'pr_2' },
            { checkpointId: 'b'.repeat(64) },
            { area: 'provider-state' as const },
        ]) {
            await expect(open(sealed, other)).rejects.toThrow('managed checkpoint object is not readable');
        }
    });

    it('shouldRefuseADifferentKey', async () => {
        await expect(open(await seal(Buffer.from('secret')), {}, randomBytes(32)))
            .rejects.toThrow('managed checkpoint object is not readable');
    });

    it('shouldLeaveNoPlaintextBehindWhenTheTagDoesNotHold', async () => {
        const sealed = await seal(Buffer.from('secret'));
        const destination = join(await scratch(), 'plain');
        await expect(openCheckpointFile({ source: sealed, destination, key: randomBytes(32), binding }))
            .rejects.toThrow('managed checkpoint object is not readable');
        await expect(stat(destination)).rejects.toThrow();
    });

    it('shouldRefuseTamperedCiphertextAndTruncatedInput', async () => {
        const sealed = await seal(Buffer.from('secret'));
        const bytes = await readFile(sealed);
        const flipped = Buffer.from(bytes);
        flipped[flipped.length - 1] ^= 0xff;
        const flippedPath = join(await scratch(), 'flipped.enc');
        await writeFile(flippedPath, flipped);
        await expect(open(flippedPath)).rejects.toThrow('managed checkpoint object is not readable');

        const truncatedPath = join(await scratch(), 'short.enc');
        await writeFile(truncatedPath, bytes.subarray(0, 10));
        await expect(open(truncatedPath)).rejects.toThrow('managed checkpoint object is not readable');
    });

    it('shouldRefuseAnObjectWithAForeignMagic', async () => {
        const bytes = await readFile(await seal(Buffer.from('secret')));
        bytes.write('XXXXX', 0, 'ascii');
        const path = join(await scratch(), 'foreign.enc');
        await writeFile(path, bytes);
        await expect(open(path)).rejects.toThrow('managed checkpoint object is not readable');
    });

    it('shouldRequireA32ByteKeyOnBothSides', async () => {
        await expect(sealCheckpointBuffer({
            plaintext: Buffer.from('x'), destination: join(await scratch(), 'o.enc'), key: randomBytes(16), binding,
        })).rejects.toThrow('32-byte');
        await expect(open(await seal(Buffer.from('x')), {}, randomBytes(16))).rejects.toThrow('32-byte');
    });

    it('shouldRefuseAnEmptyTenantOrProjectBinding', async () => {
        for (const override of [{ tenantId: '' }, { projectId: '' }]) {
            await expect(sealCheckpointBuffer({
                plaintext: Buffer.from('x'),
                destination: join(await scratch(), 'o.enc'),
                key,
                binding: { ...binding, ...override },
            })).rejects.toThrow('binding');
        }
    });

    it('shouldWriteCiphertextWhileTheSourceIsStillProducing', async () => {
        // The property is "this streams", and the observable form of that is
        // that sealed bytes are on disk before the source has finished. An
        // implementation that collected the plaintext first would have written
        // nothing at this point, however much memory it happened to be using.
        //
        // Measuring heap instead was the earlier version of this test, and it
        // was not a measurement of anything: `heapUsed + external` moves with
        // whatever else the process is doing, so it failed at 19.7MB against a
        // 16MB threshold with the implementation unchanged.
        const chunk = randomBytes(256 * 1024);
        const chunks = 64;
        const destination = join(await scratch(), 'big.enc');
        let sealedBytesAtHalfway = 0;

        await sealCheckpointStream({
            source: Readable.from((async function* () {
                for (let index = 0; index < chunks; index += 1) {
                    if (index === chunks / 2) {
                        sealedBytesAtHalfway = await stat(destination).then(
                            (entry) => entry.size,
                            () => 0,
                        );
                    }
                    yield chunk;
                }
            })()),
            destination,
            key,
            binding,
        });

        // Not `> 0`: the header is yielded before the cipher produces
        // anything, so a body that was collected and written at the end would
        // still have left those few bytes on disk. The assertion has to be
        // about the *body* having made progress.
        expect(sealedBytesAtHalfway).toBeGreaterThan(4 * chunk.length);
        const opened = await open(destination);
        expect(opened.bytes).toBe(chunk.length * chunks);
    });

    it('shouldNotStartTheProducerBeforeItHasClaimedTheDestination', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'already here');
        let producerStarted = false;

        // The barrier: the source must not run at all if the destination
        // cannot be claimed. A producer that has already begun is a producer
        // whose failures have nowhere to go — nothing is listening yet.
        await expect(sealCheckpointStream({
            source: Readable.from((async function* () {
                producerStarted = true;
                yield Buffer.from('x');
            })()),
            destination,
            key,
            binding,
        })).rejects.toThrow();

        expect(producerStarted).toBe(false);
        expect(await readFile(destination, 'utf8')).toBe('already here');
    });

    it('shouldNotDeleteAnExistingDestinationWhenTheSourceIsRefusedBeforeAnyWrite', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'someone else wrote this');

        // The write is refused because the destination is already there; the
        // cleanup that follows must not then remove it.
        await expect(sealCheckpointStream({
            source: Readable.from([Buffer.from('x')]),
            destination,
            key,
            binding,
        })).rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('someone else wrote this');
    });

    it('shouldNotDeleteAnExistingDestinationWhenTheSourceItselfFails', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'someone else wrote this');

        await expect(sealCheckpointStream({
            source: Readable.from((async function* () {
                yield Buffer.from('x');
                throw new Error('the source broke');
            })()),
            destination,
            key,
            binding,
        })).rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('someone else wrote this');
    });

    it('shouldRemoveOnlyItsOwnPartialOutputWhenTheSourceFails', async () => {
        const destination = join(await scratch(), 'object.enc');
        await expect(sealCheckpointStream({
            source: Readable.from((async function* () {
                yield randomBytes(64 * 1024);
                throw new Error('the source broke');
            })()),
            destination,
            key,
            binding,
        })).rejects.toThrow();
        // It created this one, so it is the one to clean up.
        await expect(stat(destination)).rejects.toThrow();
    });

    it('shouldNotDeleteAnExistingPlaintextWhenTheSealedObjectIsMalformed', async () => {
        const source = join(await scratch(), 'short.enc');
        await writeFile(source, Buffer.from('too short'));
        const destination = join(await scratch(), 'plain');
        await writeFile(destination, 'existing plaintext');

        // The refusal happens before a destination would ever be created.
        await expect(openCheckpointFile({ source, destination, key, binding }))
            .rejects.toThrow('managed checkpoint object is not readable');
        expect(await readFile(destination, 'utf8')).toBe('existing plaintext');
    });

    it('shouldNotDeleteAnExistingPlaintextWhenTheSealedObjectIsMissing', async () => {
        const destination = join(await scratch(), 'plain');
        await writeFile(destination, 'existing plaintext');
        await expect(openCheckpointFile({
            source: join(await scratch(), 'nope.enc'), destination, key, binding,
        })).rejects.toThrow('managed checkpoint object is not readable');
        expect(await readFile(destination, 'utf8')).toBe('existing plaintext');
    });

    it('shouldRefuseToOverwriteAnExistingObject', async () => {
        const destination = join(await scratch(), 'object.enc');
        await writeFile(destination, 'existing');
        await expect(sealCheckpointBuffer({ plaintext: Buffer.from('x'), destination, key, binding }))
            .rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('existing');
    });
});

describe('the tenant axis is not a company id', () => {
    it('shouldSealAndOpenAPersonalWorkspaceTenantJustLikeACompanyOne', async () => {
        /*
         * The parent's workspace key is `company:<id>` **or** `user:<id>`: a
         * personal workspace has no company, so a binding that demanded one
         * would leave those workspaces permanently unable to checkpoint. This
         * field was named `companyId` while already holding either — a name
         * that is right until somebody trusts it.
         */
        for (const tenantId of ['company:42', 'user:7']) {
            const plaintext = Buffer.from(`work for ${tenantId}`);
            const sealed = await seal(plaintext, { tenantId });
            const opened = await open(sealed, { tenantId });
            expect(await readFile(opened.destination)).toEqual(plaintext);
        }
    });

    it('shouldNotOpenAnArchiveSealedUnderADifferentTenant', async () => {
        // The AAD is built from the values, so these two are different seals
        // even though the field name is the same.
        const sealed = await seal(Buffer.from('company work'), { tenantId: 'company:42' });
        await expect(open(sealed, { tenantId: 'user:42' })).rejects.toThrow();
    });
});

it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid plaintext cap %s before creating destination', async maxPlaintextBytes => {
    const source = await seal(Buffer.from('bounded'));
    const destination = join(await scratch(), 'plain');
    const input = { source, destination, key, binding, maxPlaintextBytes };
    await expect(openCheckpointFile(input)).rejects.toThrow('managed checkpoint object is not readable');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('accepts an exact plaintext cap and refuses one additional byte before destination creation', async () => {
    const plaintext = Buffer.from('한글');
    const source = await seal(plaintext);
    const exact = join(await scratch(), 'exact');
    const result = await openCheckpointFile({ source, destination: exact, key, binding, maxPlaintextBytes: plaintext.length });
    expect(result.bytes).toBe(6);
    expect(await readFile(exact)).toEqual(plaintext);
    const over = join(await scratch(), 'over');
    faults.destinations = 0;
    await expect(openCheckpointFile({ source, destination: over, key, binding, maxPlaintextBytes: plaintext.length - 1 })).rejects.toThrow('managed checkpoint object is not readable');
    await expect(stat(over)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(faults.destinations).toBe(0);
});

it('owns bounded source, destination, key reference and binding before the first await', async () => {
    const plaintext = Buffer.from('owned');
    const source = await seal(plaintext);
    const destination = join(await scratch(), 'plain');
    const input = { source, destination, key, binding: { ...binding }, maxPlaintextBytes: plaintext.length };
    const other = join(await scratch(), 'other');
    const pending = openCheckpointFile(input);
    input.source = 'missing';
    input.destination = other;
    input.key = randomBytes(32);
    input.binding.tenantId = 'other';
    input.maxPlaintextBytes = 1;
    expect(await pending).toEqual({ bytes: plaintext.length, sha256: createHash('sha256').update(plaintext).digest('hex') });
    expect(await readFile(destination)).toEqual(plaintext);
    await expect(stat(input.destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['head', 'tag'] as const)('refuses a short %s read before opening a destination', async part => {
    const source = await seal(Buffer.from('content'));
    const destination = join(await scratch(), 'plain');
    faults.destinations = 0;
    faults.wrap = (path, _flags, handle) => path !== source ? handle : new Proxy(handle, {
        get(target, property) {
            if (property === 'read') return (buffer: Buffer, offset: number, length: number, position: number) =>
                target.read(buffer, offset, (part === 'head' ? position === 0 : position !== 0) ? 5 : length, position);
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    await expect(openCheckpointFile({ source, destination, key, binding, maxPlaintextBytes: 20 })).rejects.toThrow('managed checkpoint object is not readable');
    expect(faults.destinations).toBe(0);
});

it.each(['directory', 'unsafe', 'negative', 'nan'] as const)('refuses same-handle %s stat before destination creation', async kind => {
    const source = await seal(Buffer.from('content'));
    const destination = join(await scratch(), 'plain');
    faults.destinations = 0;
    faults.wrap = (path, _flags, handle) => path !== source ? handle : new Proxy(handle, {
        get(target, property) {
            if (property === 'stat') return async () => {
                const value = await target.stat();
                return { ...value, isFile: () => kind !== 'directory', size: kind === 'unsafe' ? Number.MAX_SAFE_INTEGER + 1 : kind === 'negative' ? -1 : kind === 'nan' ? NaN : value.size };
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    await expect(openCheckpointFile({ source, destination, key, binding, maxPlaintextBytes: 20 })).rejects.toThrow('managed checkpoint object is not readable');
    expect(faults.destinations).toBe(0);
});

it('fault-injected stream cannot forward an over-budget plaintext chunk before refusing', async () => {
    const plaintext = Buffer.alloc(65536, 97);
    const source = await seal(plaintext);
    const sealedSize = (await stat(source)).size;
    const destination = join(await scratch(), 'plain');
    const maximum = 10;
    let forwarded = 0;
    faults.wrap = (path, _flags, handle) => new Proxy(handle, {
        get(target, property) {
            // Deliberately inconsistent handle: this is not normal fixed-range GCM behavior.
            if (path === source && property === 'stat') return async () => ({ ...(await target.stat()), isFile: () => true, size: maximum + 33 });
            if (path === source && property === 'read') return (buffer: Buffer, offset: number, length: number, position: number) =>
                target.read(buffer, offset, length, position === 0 ? 0 : sealedSize - 16);
            if (path === source && property === 'createReadStream') return () => target.createReadStream({ start: 17, end: sealedSize - 17, autoClose: false });
            if (path === destination && property === 'createWriteStream') return () => {
                const stream = target.createWriteStream();
                const write = stream.write.bind(stream);
                stream.write = ((...args: Parameters<typeof stream.write>) => {
                    forwarded += Buffer.byteLength(args[0]);
                    return write(...args);
                }) as typeof stream.write;
                return stream;
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    await expect(openCheckpointFile({ source, destination, key, binding, maxPlaintextBytes: maximum })).rejects.toThrow('managed checkpoint object is not readable');
    expect(forwarded).toBe(0);
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('bounds and reads the same opened object after its pathname is replaced', async () => {
    const plaintext = Buffer.from('old');
    const source = await seal(plaintext);
    const replacement = await seal(Buffer.alloc(100, 98));
    const destination = join(await scratch(), 'plain');
    faults.wrap = async (path, flags, handle) => {
        if (path === source && flags === 'r') {
            await rename(source, source + '.old');
            await rename(replacement, source);
        }
        return handle;
    };
    expect((await openCheckpointFile({ source, destination, key, binding, maxPlaintextBytes: 3 })).bytes).toBe(3);
    expect(await readFile(destination)).toEqual(plaintext);
});

it('preserves an existing plaintext destination for bounded refusal and EEXIST', async () => {
    const source = await seal(Buffer.from('content'));
    const destination = join(await scratch(), 'plain');
    await writeFile(destination, 'survivor');
    for (const maxPlaintextBytes of [1, 7]) {
        await expect(openCheckpointFile({ source, destination, key, binding, maxPlaintextBytes })).rejects.toThrow('managed checkpoint object is not readable');
        expect(await readFile(destination, 'utf8')).toBe('survivor');
    }
});

it('accepts empty plaintext with an explicit positive budget', async () => {
    const source = await seal(Buffer.alloc(0));
    const destination = join(await scratch(), 'plain');
    expect((await openCheckpointFile({ source, destination, key, binding, maxPlaintextBytes: 1 })).bytes).toBe(0);
    expect((await readFile(destination)).length).toBe(0);
});
