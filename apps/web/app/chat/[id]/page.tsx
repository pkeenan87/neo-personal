import { notFound } from "next/navigation";
import { ChatInterface } from "@/components/ChatInterface";
import { loadConversation, loadConversationList } from "@/lib/server/chat-data";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, requireSession()]);
  const [conversation, conversations] = await Promise.all([loadConversation(session, id), loadConversationList(session)]);
  if (!conversation) notFound();
  return (
    <ChatInterface
      key={conversation.id}
      user={{ name: session.name, email: session.email }}
      initialConversations={conversations}
      conversationId={conversation.id}
      initialMessages={conversation.messages}
    />
  );
}
