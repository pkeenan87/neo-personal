# Appearance preferences and app UI polish

branch: feat/app-ui-themes

## Summary

Bring the homepage's emerald visual identity into chat, dashboard, and settings, with explicit light, dark, and system appearance choices. Improve keyboard access, mobile navigation, and recovery from dashboard loading errors.

## Functional requirements

- Offer a labeled appearance selector on the homepage and signed-in page headers.
- Default to the operating system preference. Remember explicit choices in browser local storage and apply them before first paint.
- Keep theme controls synchronized across routes and tabs. Follow operating system changes only in System mode.
- Apply the chosen mode to semantic colors, native controls, and severity/status colors. The homepage also supports both modes.
- Continue allowing theme changes when storage is unavailable.
- Resolve `/settings` to the existing forwarding settings page.
- Support Escape, focus containment, and focus return in the mobile chat drawer; release modal behavior at desktop widths.
- Support arrow, Home, and End keys in email-provider tabs.
- Provide a retry action for failed dashboard loads and accessible save/load error feedback.

## Possible edge cases

- Invalid or blocked browser storage, system preference changes, another tab changing the preference, and hydration after server rendering.
- Resizing an open mobile drawer to desktop, narrow viewports, long model names or email addresses.
- Empty household activity, failed dashboard requests, and settings save failures.

## Acceptance criteria

- Light and dark choices persist across navigation and reloads, independently of the OS preference.
- A saved preference applies before hydration without a theme flash.
- All audited routes render at mobile and desktop widths without horizontal page overflow.
- Chat, forwarding, and dashboard behavior retains existing regression coverage.
- Keyboard navigation and visible focus work for theme controls, navigation, tabs, and the mobile drawer.

## Testing guidelines

- Vitest: preference persistence, system changes, cross-tab synchronization, invalid storage, blocked storage, and pre-hydration initialization.
- Existing route/component regression suites, with targeted tests for drawer focus, tab navigation, and dashboard retry.
- Chromium: desktop/mobile rendering of both themes, route changes, reload persistence, selected-theme status colors, and an actual chat check using mock services.
- Run web typecheck, lint, tests, and production build.
