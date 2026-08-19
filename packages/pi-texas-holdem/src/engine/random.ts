const UINT32_RANGE = 0x1_0000_0000;

/**
 * Runtime-neutral, cryptographically secure random value in [0, 1).
 * Web Crypto is available in modern Node.js and Cloudflare Workers.
 */
export function secureRandom(): number {
	const crypto = globalThis.crypto;
	if (!crypto?.getRandomValues) {
		throw new Error("Secure randomness requires the Web Crypto API");
	}
	const value = new Uint32Array(1);
	crypto.getRandomValues(value);
	return (value[0] as number) / UINT32_RANGE;
}
