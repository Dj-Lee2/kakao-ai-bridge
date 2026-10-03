export class BridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function fail(code) { throw new BridgeError(code); }
export function safeCode(error) { return error instanceof BridgeError ? error.code : 'operation_failed'; }
export async function deadline(promise, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError('operation_timeout')), ms);
  })]); } finally { clearTimeout(timer); }
}
