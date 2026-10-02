/** Wire types for the service pipe (`docs/contracts.md` "Desktop agent"). */

export type EnrollState = "not_enrolled" | "enrolled" | "disconnected";

export interface AgentStatus {
  ok: true;
  state: EnrollState;
  version: string;
  serverUrl: string;
  computerName: string;
  deviceName: string | null;
  memberName: string | null;
  householdName: string | null;
  ownerName: string | null;
  lastCheckIn: string | null;
  lastWarningAt: string | null;
  updateAvailable: string | null;
  /** `linux` only for development builds. */
  platform: "windows" | "macos" | "linux";
  /** macOS: whether the service can read the permissions database (Full Disk Access). null off a Mac or before the first probe. */
  fullDiskAccess: boolean | null;
}

export interface AgentError {
  ok: false;
  code: string;
  error: string;
}

export type Reply<T> = (T & { ok: true }) | AgentError;

export interface EnrollPreview {
  householdName: string;
  memberName: string | null;
  ownerName: string | null;
  expiresAt: string;
}

export interface SignInStart {
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export type SignInPoll = { status: "pending"; interval: number } | { status: "approved" } | { status: "denied" } | { status: "expired" };

export type Rating = "dangerous" | "suspicious" | "no_known_problems" | "unknown";

export interface CheckUrlResult {
  rating: Rating;
  domain: string;
  reasons: string[];
  checkedAt: string;
}

/** `permission`: (macOS) a listed remote-access tool was just allowed to see or control the Mac. */
export type WarningKind = "tool" | "session" | "unwanted" | "permission";

/** Which permission a `permission` warning is about. */
export type PermissionService = "screen_recording" | "accessibility" | "full_disk_access";

/** The `warning` push. A repeat with the same `eventId` updates an open window (`ownerTold` flips to true). */
export interface Warning {
  eventId: string;
  kind: WarningKind;
  toolName: string;
  peerId?: string;
  /** `permission` warnings only. */
  service?: PermissionService;
  severity: string;
  ownerName: string;
  ownerTold: boolean;
}

/** What the UI can ask the service. Every call resolves; failures come back as `{ ok: false }`. */
export interface AgentClient {
  status(): Promise<Reply<AgentStatus>>;
  enrollPreview(code: string, serverUrl?: string): Promise<Reply<EnrollPreview>>;
  enroll(code: string, name: string, serverUrl?: string): Promise<Reply<AgentStatus>>;
  selfEnrollStart(name: string, serverUrl?: string): Promise<Reply<SignInStart>>;
  selfEnrollPoll(): Promise<Reply<SignInPoll>>;
  checkUrl(url: string): Promise<Reply<CheckUrlResult>>;
  unenroll(): Promise<Reply<object>>;
  /** macOS: look at Full Disk Access now. `restarting`: the service is restarting to pick up a new grant, so ask again in a moment. */
  probePermissions(): Promise<Reply<PermissionProbe>>;
}

export interface PermissionProbe {
  fullDiskAccess: boolean | null;
  restarting: boolean;
}

/** The window-level actions only the Rust side can do. */
export interface Shell {
  /** Opens an http(s) address in the user's default browser. */
  openUrl(url: string): Promise<void>;
  /** Closes the window this view is in. */
  close(): Promise<void>;
  /** macOS: opens the Full Disk Access pane of System Settings. */
  openFullDiskAccess(): Promise<void>;
  /** macOS: shows Neo Protection in a Finder window, to add it with the + button. */
  showDaemonInFinder(): Promise<void>;
  /** macOS: runs the uninstall with the administrator password prompt. Rejects if it was cancelled or failed. */
  uninstallMac(): Promise<void>;
}
