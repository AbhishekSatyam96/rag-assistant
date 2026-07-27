// Who built this and where else to find them.
//
// In one module rather than inline in the footer, because these strings appear
// in three unrelated places (footer, user menu, landing hero) and a portfolio
// link that's correct in two of them is worse than no link at all. Changing a
// handle here changes it everywhere.
//
// Plain constants, not env vars: none of this is deployment-specific, and a
// missing NEXT_PUBLIC_ var would fail as an empty href — a link that silently
// goes nowhere is the worst failure mode available.

export const AUTHOR = {
  name: "Abhishek Satyam",
  role: "Senior Software Engineer",
  location: "Bengaluru, India",
} as const;

export const LINKS = {
  portfolio: "https://abhisheksatyam.com",
  // Deep links into the portfolio's own anchors, so "Projects" lands on the
  // section rather than the top of a long page the visitor then has to scan.
  projects: "https://abhisheksatyam.com/#projects",
  contact: "https://abhisheksatyam.com/#contact",
  linkedin: "https://www.linkedin.com/in/abhishek-satyam/",
  github: "https://github.com/AbhishekSatyam96",
  repo: "https://github.com/AbhishekSatyam96/rag-assistant",
  email: "mailto:abhishek.satyam96@gmail.com",
} as const;

// The one place the year is written. `new Date().getFullYear()` is tempting and
// wrong here: the landing page is a Server Component, so the year would be
// baked in at build time anyway — and on a page that *is* client-rendered it
// would differ between the server's HTML and the client's, which is a
// hydration mismatch for no benefit.
export const COPYRIGHT_YEAR = 2026;
