/**
 * The `CustomEvent` contract between the MAIN-world hook (`entrypoints/hook.content.ts`) and the
 * isolated-world detector (`entrypoints/detect.content.ts`). A page (or a forged event) can only
 * ever claim one of these `kind`s happened — never a domain, never anything else — because the
 * isolated script always reads its own `location` for that.
 */
export const NEO_SIGNAL_EVENT = "neo:signal";

export type HookSignalKind =
  | "history_mutation"
  | "keyboard_lock"
  | "unload_trap"
  | "media_loop"
  | "media_restart";

export interface HookSignalDetail {
  kind: HookSignalKind;
}
