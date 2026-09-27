import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.join(here, "../..");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Don't let `next dev` generate apps/web/AGENTS.md + CLAUDE.md; repo guidance lives in /CLAUDE.md.
  agentRules: false,
  reactStrictMode: true,
  // Monorepo: trace and bundle relative to the workspace root so the
  // @neo/* workspace packages resolve on Vercel.
  outputFileTracingRoot: monorepoRoot,
  turbopack: { root: monorepoRoot },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
        ],
      },
      {
        // Invite secrets are in the path (_specs/household-invites.md); never send them onward.
        // Mirrored in vercel.json, whose headers win on Vercel.
        source: "/invite/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default nextConfig;
