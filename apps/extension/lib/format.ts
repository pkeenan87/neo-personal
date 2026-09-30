/** Shows a domain without it being clickable or copy-pasteable as a live link (`_specs/browser-extension.md`). */
export function defangDomain(domain: string): string {
  return domain.replace(/\./g, "[.]");
}
