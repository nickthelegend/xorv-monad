/** Where the committed ABI lives, and its exact on-disk format (shared by the exporter and its test). */
export const ABI_PATH = new URL("../../abi/XorvLedger.json", import.meta.url);

/** Two-space JSON with a trailing newline, in solc's output order: stable across rebuilds. */
export function formatAbi(abi: readonly unknown[]): string {
  return `${JSON.stringify(abi, null, 2)}\n`;
}
