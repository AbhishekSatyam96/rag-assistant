// A layout purely to carry metadata. The page itself is a Client Component (it
// needs auth state and streaming), and Client Components cannot export
// `metadata` — so the title lives one level up, where the App Router will still
// slot it into the root layout's "%s · RAG Knowledge Assistant" template.
export const metadata = { title: "Chat" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
