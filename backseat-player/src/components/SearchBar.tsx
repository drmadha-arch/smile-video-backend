import { useRef, useState } from 'react';
import { CloseIcon, SearchIcon } from './Icons';

interface Props {
  initial?: string;
  onSubmit: (text: string) => void;
}

/** One box for everything: search terms, YouTube links, or a bare video ID. */
export function SearchBar({ initial = '', onSubmit }: Props) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  return (
    <form
      className="flex h-16 flex-1 items-center gap-3 rounded-full bg-surface-2 pl-6 pr-2 ring-1 ring-line focus-within:ring-2 focus-within:ring-accent"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        ref.current?.blur(); // dismiss the on-screen keyboard
        onSubmit(t);
      }}
    >
      <SearchIcon size={28} className="shrink-0 text-muted" />
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search YouTube or paste a link"
        className="h-full min-w-0 flex-1 bg-transparent text-xl outline-none placeholder:text-muted"
        enterKeyHint="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      {text && (
        <button
          type="button"
          aria-label="Clear"
          className="flex h-12 w-12 items-center justify-center rounded-full text-muted active:bg-white/15"
          onClick={() => {
            setText('');
            ref.current?.focus();
          }}
        >
          <CloseIcon size={26} />
        </button>
      )}
      <button type="submit" className="h-12 rounded-full bg-accent px-6 text-lg font-semibold active:scale-95">
        Go
      </button>
    </form>
  );
}
