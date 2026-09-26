# Phase 3 (part 1): desktop clients sign in through the browser

## Context

The Omarchy NeoShield bar plugin (`~/Work/omarchy-neoshield-plugin`) is the first non-browser client. Its
architecture is right: a stdlib Python CLI owns TLS and the credential and writes `state.json`; the QML panel
never speaks HTTP. What it needed from Neo was a way to authenticate without a cookie, and a way to get that
credential without copying a secret out of a settings page.

The roadmap (`phase-0-and-roadmap.md`, Phase 3) planned a Tauri desktop app. The plugin arrived first; the
token and sign-in built here are what the Tauri app will use too.

## Decisions

- **Desktop tokens**, not session cookies or OAuth clients: hashed personal access tokens on a user-owned table,
  resolved inside `getSession()` so every route works unchanged. Revocable under Settings → Desktop.
- **Device authorization** (RFC 8628 shape) over a loopback redirect: no local listener, no https→http hop,
  works when the panel spawns the CLI in a terminal, and Auth.js is untouched because the approval page is just a
  signed-in page. Google and magic-link sign-in are reused as-is.
- **Mint at redemption, not at approval**, so an approved row never holds a usable credential and delivery is one-shot.
- A desktop token **cannot** create or approve tokens (browser session required); it can revoke itself.
- In-memory twins for MOCK_MODE and tests, like every other store.

## Delivery

1. Recover the uncommitted desktop-token work (table 0005, Bearer auth, settings API and page). Commit `ba3fd1b`.
2. Device authorization: table 0006, `@neo/db` helpers, three routes, `/desktop/authorize`, `requireSession(returnTo)`
   plus `?next=` on the landing page, browser-only guard on token management. Spec `_specs/desktop-auth.md`.
3. Plugin: `login` / `logout` / `setup --paste`, panel copy, README.
4. Owner: run migrations 0005 and 0006, then sign in from the bar.

## Out of scope

Token rotation, a shared rate-limit store, the Tauri app itself.
