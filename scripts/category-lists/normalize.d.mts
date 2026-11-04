export function normalizeHostLine(line: string): string | null;
export function parseList(text: string): string[];
export function domainPrefix(domain: string): number;
export function prefixesFor(domains: Iterable<string>): Uint32Array;
export function encodeBin(prefixes: Uint32Array): Buffer;
export function sha256Hex(bytes: Uint8Array | string): string;
