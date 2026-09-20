import type { ReactNode } from "react";

export type PaginationVariant = "standard" | "compact" | "mini";

export type PaginationProps = {
  page: number;
  pages: number;
  total?: number;
  itemLabel?: string;
  onPrevious: () => void;
  onNext: () => void;
  position?: "top" | "bottom";
  variant?: PaginationVariant;
  className?: string;
  previousLabel?: ReactNode;
  nextLabel?: ReactNode;
  previousAriaLabel?: string;
  nextAriaLabel?: string;
};

export function Pagination({
  page,
  pages,
  total,
  itemLabel,
  onPrevious,
  onNext,
  position = "bottom",
  variant = "standard",
  className,
  previousLabel,
  nextLabel,
  previousAriaLabel,
  nextAriaLabel,
}: PaginationProps) {
  const safePages = Math.max(1, pages);
  const safePage = Math.min(Math.max(1, page), safePages);
  const isFirst = safePage <= 1;
  const isLast = safePage >= safePages;

  if (variant === "mini") {
    const baseClass = "queue-mini-pages";
    const posClass = position === "top" ? "top" : "";
    const classes = [baseClass, posClass, className].filter(Boolean).join(" ");
    return (
      <div className={classes} role="navigation" aria-label={`${position} mini pagination`}>
        <button
          type="button"
          disabled={isFirst}
          onClick={onPrevious}
          aria-label={previousAriaLabel ?? "Previous page"}
        >
          {previousLabel ?? "←"}
        </button>
        <span>{safePage}/{safePages}</span>
        <button
          type="button"
          disabled={isLast}
          onClick={onNext}
          aria-label={nextAriaLabel ?? "Next page"}
        >
          {nextLabel ?? "→"}
        </button>
      </div>
    );
  }

  if (variant === "compact") {
    const baseClass = "localization-pagination";
    const posClass = position === "top" ? "top" : "";
    const classes = [baseClass, posClass, className].filter(Boolean).join(" ");
    return (
      <div className={classes} role="navigation" aria-label={`${position} pagination`}>
        <button
          type="button"
          disabled={isFirst}
          onClick={onPrevious}
          aria-label={previousAriaLabel ?? "Previous page"}
        >
          {previousLabel ?? "←"}
        </button>
        <span>{safePage} / {safePages}</span>
        <button
          type="button"
          disabled={isLast}
          onClick={onNext}
          aria-label={nextAriaLabel ?? "Next page"}
        >
          {nextLabel ?? "→"}
        </button>
      </div>
    );
  }

  // Standard variant
  const baseClass = "pagination";
  const posClass = position === "top" ? "top" : "";
  const classes = [baseClass, posClass, className].filter(Boolean).join(" ");

  const countText = total !== undefined && itemLabel
    ? `Page ${safePage} / ${safePages} · ${total} ${itemLabel}`
    : total !== undefined
    ? `Page ${safePage} / ${safePages} · ${total}`
    : `Page ${safePage} / ${safePages}`;

  return (
    <div className={classes} role="navigation" aria-label={`${position} pagination`}>
      <button
        type="button"
        disabled={isFirst}
        onClick={onPrevious}
        aria-label={previousAriaLabel ?? "Previous page"}
      >
        {previousLabel ?? "Previous"}
      </button>
      <span className="mono">{countText}</span>
      <button
        type="button"
        disabled={isLast}
        onClick={onNext}
        aria-label={nextAriaLabel ?? "Next page"}
      >
        {nextLabel ?? "Next"}
      </button>
    </div>
  );
}

