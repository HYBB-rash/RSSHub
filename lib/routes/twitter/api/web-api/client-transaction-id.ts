import { ClientTransaction, fetchXDocument } from 'x-client-transaction-id';

import cache from '@/utils/cache';

const cacheKey = 'twitter:x-client-transaction';

/** The opaque pair of strings a transaction id is generated from. */
type Keys = { key: string; animationKey: string };

const isUsableKeys = (value: unknown): value is Keys =>
    typeof value === 'object' && value !== null && typeof (value as Keys).key === 'string' && (value as Keys).key.length > 0 && typeof (value as Keys).animationKey === 'string' && (value as Keys).animationKey.length > 0;

// The cache stores strings, so anything read back has to be decoded first. A
// value written by an earlier version of this module may be `{}` or a plain
// string, neither of which may be used.
const parseKeys = (raw: unknown): Keys | undefined => {
    if (typeof raw !== 'string') {
        return isUsableKeys(raw) ? raw : undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return isUsableKeys(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
};

/**
 * `getKeys()`/`fromKeys()` are the supported way to share the keys between
 * requests and processes; both were added in x-client-transaction-id 0.4.0.
 * Releases before that keep the values only on the instance, so fall back to
 * reusing the instance itself, which reaches no private field either.
 */
type KeysCapableClientTransaction = typeof ClientTransaction & {
    fromKeys?: (keys: Keys) => ClientTransaction;
};

const keysCapableClientTransaction = ClientTransaction as KeysCapableClientTransaction;
const supportsKeyExport = typeof keysCapableClientTransaction.fromKeys === 'function';

let cachedTransaction: Promise<ClientTransaction> | undefined;

const createTransaction = async () => {
    const document = await fetchXDocument();
    return await ClientTransaction.create(document);
};

const getTransaction = async () => {
    if (!cachedTransaction) {
        const pending = createTransaction();
        cachedTransaction = pending;
        // A rejected initialization must not stay cached, or every later
        // request would await the same rejection.
        try {
            await pending;
        } catch (error) {
            if (cachedTransaction === pending) {
                cachedTransaction = undefined;
            }
            throw error;
        }
    }
    return await cachedTransaction;
};

const readKeys = async (): Promise<Keys> => {
    const transaction = await getTransaction();
    const keys = (transaction as unknown as { getKeys?: () => Keys | undefined }).getKeys?.();
    if (!isUsableKeys(keys)) {
        throw new Error('x-client-transaction-id did not return usable transaction keys');
    }
    return keys;
};

const getKeys = async (refresh: boolean): Promise<Keys> => {
    if (!refresh) {
        // A cache entry written by an earlier version of this module may hold
        // `{}`, so validate instead of trusting anything stored.
        const cached = parseKeys(await cache.get(cacheKey));
        if (cached) {
            return cached;
        }
    }
    const keys = await readKeys();
    await cache.set(cacheKey, JSON.stringify(keys));
    return keys;
};

const generateFromInstance = async (method: string, path: string) => {
    const transaction = await getTransaction();
    return transaction.generateTransactionId(method, path);
};

const generateFromKeys = async (method: string, path: string, refresh: boolean) => {
    const keys = await getKeys(refresh);
    if (!keysCapableClientTransaction.fromKeys) {
        return await generateFromInstance(method, path);
    }
    const transaction = keysCapableClientTransaction.fromKeys(keys);
    return transaction.generateTransactionId(method, path);
};

/**
 * @param refresh skips the cached keys; used after X rejects a transaction id
 *                with 404.
 */
export const getClientTransactionId = async (method: string, path: string, refresh = false) => (supportsKeyExport ? await generateFromKeys(method, path, refresh) : await generateFromInstance(method, path));

/** Drops both the shared keys and the in-process instance. */
export const clearClientTransactionCache = async () => {
    cachedTransaction = undefined;
    await cache.set(cacheKey, '', 1);
};
