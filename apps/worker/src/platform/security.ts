const encoder = new TextEncoder();

export const sha256 = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
};

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let i = 0; i < length; i++) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return difference === 0;
}

export async function hashPassword(password: string, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<{ salt: string; hash: string }> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return { salt: Array.from(salt, byte => byte.toString(16).padStart(2, '0')).join(''), hash: Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('') };
}

export async function verifyPassword(password: string, saltHex: string, expected: string): Promise<boolean> {
  const salt = new Uint8Array(saltHex.match(/.{2}/g)?.map(byte => parseInt(byte, 16)) ?? []);
  if (salt.length !== 16 || !/^[a-f0-9]{64}$/.test(expected)) return false;
  const actual = await hashPassword(password, salt);
  return constantTimeEqual(actual.hash, expected);
}

export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
