/** Shown on every signed-in page while DEV_AUTH_BYPASS is active (never on production/preview). */
export function DevBypassBanner() {
  return (
    <div
      role="status"
      className="pointer-events-none fixed top-2 left-1/2 z-50 -translate-x-1/2 rounded-full bg-amber-300/95 px-3 py-1 text-xs font-semibold whitespace-nowrap text-amber-950 shadow"
    >
      Dev auth bypass active
    </div>
  );
}
