import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 text-center">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          RAG Knowledge Assistant
        </h1>
        <p className="mx-auto mt-3 max-w-md text-black/60 dark:text-white/60">
          Upload documents, ask questions, get grounded answers with citations.
        </p>
      </div>

      <div className="flex gap-3">
        <Link
          href="/login"
          className="rounded-md bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="rounded-md border border-black/15 px-5 py-2.5 text-sm font-medium hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
        >
          Create account
        </Link>
      </div>
    </div>
  );
}
