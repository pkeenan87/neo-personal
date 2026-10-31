import { requireSession } from "@/lib/session";
import { EveChat } from "./EveChat";

export const dynamic = "force-dynamic";

export default async function ChatV2Page() {
  await requireSession("/chat-v2");
  return <EveChat />;
}
