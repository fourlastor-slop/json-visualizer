/** A thin promise layer over IndexedDB. Used from both the page and the data worker. */

const DB_NAME = 'json-explorer';
const DB_VERSION = 1;

export type StoreName = 'projects' | 'files' | 'chunks' | 'visualizations' | 'templates';

let opening: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
      // File contents, one entry per upload, ordered within a file by `seq`.
      db.createObjectStore('chunks', { keyPath: ['fileId', 'seq'] });
      db.createObjectStore('visualizations', { keyPath: 'id' });
      db.createObjectStore('templates', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a newer version of the app, open in another tab, upgrade the database.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open browser storage.'));
    request.onblocked = () => reject(new Error('Browser storage is in use by another tab running an older version. Close it and reload.'));
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

/** Resolves with the result of an IndexedDB request. */
export function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function storageError(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error('The browser’s storage is full. Delete some files or projects to make room.');
  }
  return error instanceof Error ? error : new Error(String(error ?? 'Browser storage failed.'));
}

/**
 * Runs `work` in one transaction and resolves once it has been committed. `work` may only
 * await IndexedDB requests: awaiting anything else lets the transaction close early.
 */
export async function transact<T>(stores: StoreName[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => T | Promise<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    let failure: unknown;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(storageError(failure ?? tx.error));
    const fail = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        // Already finished, so no abort event will come: reject here.
        reject(storageError(error));
      }
    };
    // Started synchronously: a new transaction only accepts requests until the current
    // task ends.
    let outcome: T | Promise<T>;
    try {
      outcome = work(tx);
    } catch (error) {
      fail(error);
      return;
    }
    Promise.resolve(outcome).then((value) => {
      result = value;
    }, fail);
  });
}

export function getAll<T>(store: StoreName): Promise<T[]> {
  return transact([store], 'readonly', (tx) => done(tx.objectStore(store).getAll() as IDBRequest<T[]>));
}

export function put<T>(store: StoreName, value: T): Promise<void> {
  return transact([store], 'readwrite', (tx) => {
    tx.objectStore(store).put(value);
  });
}

/** Key range covering every chunk of a file. */
export function chunksOf(fileId: string): IDBKeyRange {
  return IDBKeyRange.bound([fileId, 0], [fileId, Number.MAX_SAFE_INTEGER]);
}
