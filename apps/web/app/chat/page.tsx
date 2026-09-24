import { ChatInterface } from "@/components/ChatInterface";
import { loadConversationList } from "@/lib/server/chat-data";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function NewChatPage() {
  const session = await requireSession();
  const conversations = await loadConversationList(session);
  return (
    <ChatInterface
      key="new"
      user={{ name: session.name, email: session.email }}
      initialConversations={conversations}
      conversationId={null}
    />
  );
}
