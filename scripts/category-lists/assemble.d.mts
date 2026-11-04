export interface AssembleConfig {
  sources: Record<string, { name: string; repo: string; commit: string; licence: string }>;
  files: Record<string, { source: string }>;
  categories: Record<string, { inputs: string[] }>;
}
export function assemble(
  config: AssembleConfig,
  readInput: (inputKey: string) => string,
): { version: string; files: Map<string, Buffer>; manifest: { version: string; categories: Record<string, { file: string; count: number; sha256: string; source: string; licence: string }> } };
