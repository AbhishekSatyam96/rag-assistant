import { ChatView } from "@/components/ChatView";

// An existing thread. A Server Component whose only job is to unwrap the route
// param and hand it to the client component that does the work — `params` is a
// Promise in the App Router, and awaiting it here keeps ChatView from needing
// `use()` and a Suspense boundary for a string it could have been given.
//
// Not `export const metadata`: titling this page properly means fetching the
// conversation, which needs the caller's bearer token, and that lives in the
// browser. Rather than authenticate a second time on the server purely for a tab
// title, the layout's static "Chat" applies.
export default async function ChatThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return <ChatView conversationId={id} />;
}
