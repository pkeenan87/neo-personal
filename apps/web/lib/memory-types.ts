/** Household memory shapes shared by the console routes and components (_specs/v2-m3-cutover.md section 3). */

export interface MemoryItem {
  id: string;
  text: string;
  /** The member it is about, or null for the whole household. */
  about: { id: string; name: string } | null;
  source: "console" | "chat";
  createdAt: string;
  expiresAt: string;
}

export interface MemoryListResponse {
  memories: MemoryItem[];
  /** How many Neo may keep per household. */
  max: number;
}

export const MEMORY_TEXT_MAX = 280;
