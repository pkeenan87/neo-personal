import { ChatInterface } from "@/components/ChatInterface";
import { isPlaybookId, playbookPrompt } from "@/lib/playbooks";
import { loadConversationList } from "@/lib/server/chat-data";
import { getVisibleVerdict } from "@/lib/server/verdict-data";
import { requireSession, type NeoSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type SearchParams = { playbook?: string | string[]; verdict?: string | string[]; check?: string | string[] };

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Entry points (agent E):
 *   ?playbook=<id>  auto-sends "I think I …. Help me." with `playbook` (effort high)
 *   ?verdict=<id>   auto-sends "Tell me more about …"; the server adds the stored verdict as hidden context
 *   ?check=<url>    pre-fills the composer (never auto-sent: a crafted link must not spend the user's checks)
 */
async function entryFor(session: NeoSession, params: SearchParams) {
  const playbook = one(params.playbook);
  if (isPlaybookId(playbook)) return { autoStart: { message: playbookPrompt(playbook), playbook } };
  const verdictId = one(params.verdict);
  if (verdictId) {
    const row = await getVisibleVerdict(session, verdictId).catch(() => undefined);
    if (row) return { autoStart: { message: `Tell me more about this check: "${row.headline}"`, verdictId: row.id } };
  }
  const check = one(params.check);
  if (check && check.length <= 2048 && /^https?:\/\//i.test(check)) return { prefill: `Check this link again: ${check}` };
  return {};
}

export default async function NewChatPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  const [conversations, entry] = await Promise.all([loadConversationList(session), entryFor(session, params)]);
  return (
    <ChatInterface
      key="new"
      user={{ name: session.name, email: session.email }}
      initialConversations={conversations}
      conversationId={null}
      {...entry}
    />
  );
}
