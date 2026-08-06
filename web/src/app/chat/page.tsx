import { ChatView } from "@/components/ChatView";

// A new conversation. No id yet — the server mints one when the first answer
// starts streaming, and ChatView swaps the URL to /chat/<id> without a
// navigation so the stream in flight survives. See the note at the top of that
// file.
export default function NewChatPage() {
  return <ChatView />;
}
