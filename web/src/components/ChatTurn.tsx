"use client";

import type { Source } from "@/lib/api";
import { AnswerView } from "@/components/AnswerView";
import { SourceList } from "@/components/SourceList";
import { SectionHeading } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { IconLayers, IconSearch, IconSpark } from "@/components/icons";

// One exchange in a thread: the question, the answer, and the citations that
// answer was built from.

export type SearchInfo = {
  query: string;
  rewritten: boolean;
  reused: boolean;
};

export function QuestionBubble({ text }: { text: string }) {
  return (
    // Right-aligned and capped at 85% so a question reads as something the user
    // said rather than as another block of page content. The answer below is
    // full-width, which is the asymmetry every chat UI uses to make "mine" and
    // "the system's" legible without labelling either.
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-fg">
        {text}
      </p>
    </div>
  );
}

// Surfaces the rewrite step, which is otherwise invisible magic.
//
// "How long is it?" quietly becoming "How long is parental leave under the
// handbook?" is the most surprising thing this feature does, and a user who
// cannot see it has no way to distinguish a bad rewrite from bad retrieval —
// the two failures look identical from the outside and have completely
// different fixes. Rendered only when something actually happened: on a first
// turn, or a follow-up that was already standalone, there is nothing to say.
function SearchNote({ search }: { search: SearchInfo }) {
  if (search.reused) {
    return (
      <p className="flex items-center gap-1.5 text-[12px] text-faint">
        <IconLayers className="size-3 shrink-0" />
        Answered from the previous sources — no new search
      </p>
    );
  }

  if (!search.rewritten) return null;

  return (
    <p className="flex items-start gap-1.5 text-[12px] text-faint">
      <IconSearch className="mt-0.5 size-3 shrink-0" />
      <span>
        Searched for <span className="text-muted">{search.query}</span>
      </span>
    </p>
  );
}

type AnswerBlockProps = {
  // Namespaces the citation anchors. A thread renders many source lists and each
  // numbers itself from 1, so without this every "[1]" in the conversation
  // scrolls to the first answer's first source.
  domId: string;
  answer: string;
  sources: Source[];
  search: SearchInfo | null;
  streaming: boolean;
  focused: number | null;
  onCitationClick: (n: number) => void;
};

export function AnswerBlock({
  domId,
  answer,
  sources,
  search,
  streaming,
  focused,
  onCitationClick,
}: AnswerBlockProps) {
  return (
    <div className="flex flex-col gap-3">
      {search && <SearchNote search={search} />}

      <div className="rounded-xl border border-line bg-surface p-4 shadow-sm">
        {/* Sources land before tokens, so there is a real window where sources
            exist and the answer is still empty. Narrating that window honestly
            — and naming which phase we are in — beats a blank box or a generic
            spinner, because the two phases fail for different reasons. */}
        {!answer && streaming ? (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="size-3.5" />
            {sources.length === 0
              ? "Searching your documents…"
              : `Reading ${sources.length} passage${sources.length === 1 ? "" : "s"}…`}
          </p>
        ) : (
          <AnswerView
            answer={answer}
            sources={sources}
            streaming={streaming}
            onCitationClick={onCitationClick}
          />
        )}
      </div>

      {sources.length > 0 && (
        <details className="group">
          {/* Collapsed by default in a thread, unlike /ask where one answer owns
              the page. Five expanded source cards per turn would bury the
              conversation after two exchanges — but the evidence still has to be
              one click away, or "grounded with citations" is decoration.
              `<details>` keeps that toggle working without any state. */}
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-[12px] font-medium text-muted transition-colors hover:text-fg">
            <IconLayers className="size-3" />
            {sources.length} source{sources.length === 1 ? "" : "s"}
            <span className="text-faint group-open:hidden">· show</span>
            <span className="hidden text-faint group-open:inline">· hide</span>
          </summary>

          <div className="mt-2.5">
            <SourceList sources={sources} focused={focused} idPrefix={domId} />
          </div>
        </details>
      )}
    </div>
  );
}

export function AnswerHeading() {
  return (
    <SectionHeading className="mb-2">
      <IconSpark className="size-3.5" />
      Answer
    </SectionHeading>
  );
}
