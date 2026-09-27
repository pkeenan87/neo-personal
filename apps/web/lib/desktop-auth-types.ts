/**
 * Wire types for desktop device authorization (Omarchy plugin / native clients).
 * Flow: POST /api/desktop/device → user approves at /desktop/authorize →
 * POST /api/desktop/device/token redeems the device code for a desktop token.
 *
 * With `device` the request is a monitoring request (_specs/device-enrollment.md):
 * redemption enrolls the device for the approving member and returns a token that
 * holds the monitoring scopes only (`device`, `signals:write`, `url:check`).
 */
import type { DeviceItem, DeviceKind, DevicePlatform } from "./household-types";

export type TokenScopeName = "full" | "device" | "signals:write" | "url:check";

/** The device a monitoring client enrolls. */
export interface DeviceAuthDeviceInput {
  kind: DeviceKind;
  platform: DevicePlatform;
  /** 1–64 characters, e.g. "Chrome on Grandma's laptop". */
  name: string;
  /** ≤ 32 characters. */
  clientVersion: string;
}

/** POST /api/desktop/device body. */
export interface DeviceAuthStartBody {
  /** Label for this client, e.g. "NeoShield on laptop"; becomes the token name. */
  clientName?: string;
  /** Present for a monitoring client; absent for a full-access client (unchanged). */
  device?: DeviceAuthDeviceInput;
}

/** POST /api/desktop/device 201 body. */
export interface DeviceAuthStartResponse {
  deviceCode: string;
  userCode: string;
  /** Page where the user confirms the code (absolute, on the host that served this request). */
  verificationUri: string;
  /** Same page with the code prefilled. */
  verificationUriComplete: string;
  /** Seconds until the request expires. */
  expiresIn: number;
  /** Seconds to wait between redemption polls. */
  interval: number;
}

/** POST /api/desktop/device/token body. */
export interface DeviceAuthRedeemBody {
  deviceCode: string;
}

/** POST /api/desktop/device/token 202 body while the user has not decided. */
export interface DeviceAuthPendingResponse {
  status: "pending";
  interval: number;
}

/** POST /api/desktop/device/token 200 body; delivered exactly once. */
export interface DeviceAuthRedeemResponse {
  status: "approved";
  token: string;
  tokenId: string;
  clientName: string;
  /** The approving account, so the client can show who it signed in as. */
  email: string;
  name: string;
  /** `["full"]` for a full token; the monitoring scopes for a device token. */
  scopes: TokenScopeName[];
  /** The enrolled device, for monitoring requests; null for a full token. */
  device: DeviceItem | null;
}

/** POST /api/desktop/device/approve body (browser session only). */
export interface DeviceAuthDecideBody {
  userCode: string;
  approve: boolean;
}

export interface DeviceAuthDecideResponse {
  status: "approved" | "denied";
  clientName: string;
}
