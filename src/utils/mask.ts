// ABCDE1234F -> XXXXX1234X
export function maskPan(pan: string): string {
  return 'XXXXX' + pan.slice(5, 9) + 'X';
}

// keys whose values must never appear in logs
// note: "pan" is matched at the start of the key, so "company_name" is not hidden by mistake
const SENSITIVE_KEY = /^pan($|_|number)|password|token|authorization|secret|identity/i;

// walks an object and hides sensitive fields, used before logging
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}