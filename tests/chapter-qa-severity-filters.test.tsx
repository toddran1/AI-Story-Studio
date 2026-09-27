// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QaDetail,
  sortQaFindingsBySeverity,
  filterQaFindingsBySeverity,
  type QaSeverityFilter,
} from "../apps/web/src/App.js";
import type { ChapterQaDetail, QaFinding } from "../apps/web/src/api.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.scrollTo = () => undefined;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(element);
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

const makeFinding = (overrides: Partial<QaFinding>): QaFinding => ({
  id: `qaf_${Math.random().toString(36).slice(2, 11)}`,
  category: "dialogue",
  severity: "warn",
  message: "Test finding message",
  evidence: "Test finding evidence",
  status: "open",
  origin: "llm",
  fingerprint: "fp",
  ...overrides,
});

const makeDetail = (overrides: Partial<ChapterQaDetail> = {}): ChapterQaDetail => ({
  chapter: 1,
  state: {
    status: "warn",
    score: 0.85,
    issues: [],
    checks: {},
    findings: [],
  },
  counts: {
    open: 0,
    resolved: 0,
    safeFixesAvailable: 0,
  },
  qaStale: false,
  currentFingerprint: "fp",
  ...overrides,
});

describe("sortQaFindingsBySeverity", () => {
  it("sorts Critical findings before Warnings and preserves original order within the same severity", () => {
    const warningA = makeFinding({ id: "w_a", severity: "warn", message: "Warning A" });
    const criticalA = makeFinding({ id: "c_a", severity: "fail", message: "Critical A" });
    const warningB = makeFinding({ id: "w_b", severity: "warn", message: "Warning B" });
    const criticalB = makeFinding({ id: "c_b", severity: "fail", message: "Critical B" });

    const input = [warningA, criticalA, warningB, criticalB];
    const sorted = sortQaFindingsBySeverity(input);

    expect(sorted.map((f) => f.id)).toEqual(["c_a", "c_b", "w_a", "w_b"]);
    // Original input array must not be mutated
    expect(input.map((f) => f.id)).toEqual(["w_a", "c_a", "w_b", "c_b"]);
  });

  it("handles empty lists, all-critical, and all-warning lists stably", () => {
    expect(sortQaFindingsBySeverity([])).toEqual([]);

    const c1 = makeFinding({ id: "c1", severity: "fail" });
    const c2 = makeFinding({ id: "c2", severity: "fail" });
    expect(sortQaFindingsBySeverity([c1, c2]).map((f) => f.id)).toEqual(["c1", "c2"]);

    const w1 = makeFinding({ id: "w1", severity: "warn" });
    const w2 = makeFinding({ id: "w2", severity: "warn" });
    expect(sortQaFindingsBySeverity([w1, w2]).map((f) => f.id)).toEqual(["w1", "w2"]);
  });
});

describe("filterQaFindingsBySeverity", () => {
  const criticalA = makeFinding({ id: "c_a", severity: "fail" });
  const criticalB = makeFinding({ id: "c_b", severity: "fail" });
  const warningA = makeFinding({ id: "w_a", severity: "warn" });
  const warningB = makeFinding({ id: "w_b", severity: "warn" });
  const warningC = makeFinding({ id: "w_c", severity: "warn" });
  const sortedFindings = [criticalA, criticalB, warningA, warningB, warningC];

  it("returns exactly the Critical findings when filter is 'critical'", () => {
    const result = filterQaFindingsBySeverity(sortedFindings, "critical");
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.severity === "fail")).toBe(true);
    expect(result.map((f) => f.id)).toEqual(["c_a", "c_b"]);
  });

  it("returns exactly the Warning findings when filter is 'warning'", () => {
    const result = filterQaFindingsBySeverity(sortedFindings, "warning");
    expect(result).toHaveLength(3);
    expect(result.every((f) => f.severity === "warn")).toBe(true);
    expect(result.map((f) => f.id)).toEqual(["w_a", "w_b", "w_c"]);
  });

  it("returns all findings in critical-first order when filter is 'all'", () => {
    const result = filterQaFindingsBySeverity(sortedFindings, "all");
    expect(result).toHaveLength(5);
    expect(result.map((f) => f.id)).toEqual(["c_a", "c_b", "w_a", "w_b", "w_c"]);
  });
});

describe("Chapter QA Severity Filters UI (<QaDetail />)", () => {
  it("defaults to 'all' filter and displays open findings in Critical-first order", async () => {
    const warningA = makeFinding({ id: "w_a", severity: "warn", message: "Warning Alpha" });
    const criticalA = makeFinding({ id: "c_a", severity: "fail", message: "Critical Alpha" });
    const warningB = makeFinding({ id: "w_b", severity: "warn", message: "Warning Beta" });
    const criticalB = makeFinding({ id: "c_b", severity: "fail", message: "Critical Beta" });

    const detail = makeDetail({
      state: {
        status: "fail",
        score: 0.65,
        issues: [],
        checks: {},
        findings: [warningA, criticalA, warningB, criticalB],
      },
      counts: { open: 4, resolved: 0, safeFixesAvailable: 0 },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    // Verify filter buttons exist with accurate counts
    const allBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show all 4 open QA findings"]')!;
    const critBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 2 critical QA findings"]')!;
    const warnBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 2 warning QA findings"]')!;

    expect(allBtn).toBeTruthy();
    expect(critBtn).toBeTruthy();
    expect(warnBtn).toBeTruthy();

    expect(allBtn.textContent).toContain("All 4");
    expect(critBtn.textContent).toContain("Critical 2");
    expect(warnBtn.textContent).toContain("Warnings 2");

    // "All" is active by default
    expect(allBtn.classList.contains("active")).toBe(true);
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    expect(critBtn.classList.contains("active")).toBe(false);
    expect(critBtn.getAttribute("aria-pressed")).toBe("false");
    expect(warnBtn.classList.contains("active")).toBe(false);
    expect(warnBtn.getAttribute("aria-pressed")).toBe("false");

    // Open finding cards appear in Critical-first order: Critical Alpha, Critical Beta, Warning Alpha, Warning Beta
    const headings = [...container!.querySelectorAll(".issues article h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Critical Alpha", "Critical Beta", "Warning Alpha", "Warning Beta"]);
  });

  it("filters visible findings to Critical only when clicking Critical chip", async () => {
    const warningA = makeFinding({ id: "w_a", severity: "warn", message: "Warning Alpha" });
    const criticalA = makeFinding({ id: "c_a", severity: "fail", message: "Critical Alpha" });
    const warningB = makeFinding({ id: "w_b", severity: "warn", message: "Warning Beta" });
    const criticalB = makeFinding({ id: "c_b", severity: "fail", message: "Critical Beta" });

    const detail = makeDetail({
      state: {
        status: "fail",
        score: 0.65,
        issues: [],
        checks: {},
        findings: [warningA, criticalA, warningB, criticalB],
      },
      counts: { open: 4, resolved: 0, safeFixesAvailable: 0 },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    const critBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 2 critical QA findings"]')!;
    await act(async () => {
      critBtn.click();
    });

    expect(critBtn.classList.contains("active")).toBe(true);
    expect(critBtn.getAttribute("aria-pressed")).toBe("true");

    const allBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show all 4 open QA findings"]')!;
    expect(allBtn.classList.contains("active")).toBe(false);
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");

    const headings = [...container!.querySelectorAll(".issues article h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Critical Alpha", "Critical Beta"]);
  });

  it("filters visible findings to Warnings only when clicking Warning chip and restores all when clicking All", async () => {
    const warningA = makeFinding({ id: "w_a", severity: "warn", message: "Warning Alpha" });
    const criticalA = makeFinding({ id: "c_a", severity: "fail", message: "Critical Alpha" });
    const warningB = makeFinding({ id: "w_b", severity: "warn", message: "Warning Beta" });

    const detail = makeDetail({
      state: {
        status: "fail",
        score: 0.70,
        issues: [],
        checks: {},
        findings: [warningA, criticalA, warningB],
      },
      counts: { open: 3, resolved: 0, safeFixesAvailable: 0 },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    const warnBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 2 warning QA findings"]')!;
    await act(async () => {
      warnBtn.click();
    });

    expect(warnBtn.classList.contains("active")).toBe(true);
    expect(warnBtn.getAttribute("aria-pressed")).toBe("true");

    let headings = [...container!.querySelectorAll(".issues article h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Warning Alpha", "Warning Beta"]);

    // Restore to All
    const allBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show all 3 open QA findings"]')!;
    await act(async () => {
      allBtn.click();
    });

    expect(allBtn.classList.contains("active")).toBe(true);
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");

    headings = [...container!.querySelectorAll(".issues article h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Critical Alpha", "Warning Alpha", "Warning Beta"]);
  });

  it("excludes resolved, dismissed, and fixed findings from counts and open filter results", async () => {
    const openCritical = makeFinding({ id: "c_open", severity: "fail", message: "Open Critical", status: "open" });
    const openWarning = makeFinding({ id: "w_open", severity: "warn", message: "Open Warning", status: "open" });
    const dismissed = makeFinding({ id: "d_1", severity: "fail", message: "Dismissed Finding", status: "dismissed" });
    const fixedManual = makeFinding({ id: "f_1", severity: "warn", message: "Fixed Finding", status: "fixed_manual" });

    const detail = makeDetail({
      state: {
        status: "warn",
        score: 0.82,
        issues: [],
        checks: {},
        findings: [openCritical, openWarning, dismissed, fixedManual],
      },
      counts: { open: 2, resolved: 2, safeFixesAvailable: 0 },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    // Filter strip reflects only open findings: All 2, Critical 1, Warning 1
    const allBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show all 2 open QA findings"]')!;
    const critBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 1 critical QA finding"]')!;
    const warnBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 1 warning QA finding"]')!;

    expect(allBtn.textContent).toContain("All 2");
    expect(critBtn.textContent).toContain("Critical 1");
    expect(warnBtn.textContent).toContain("Warning 1");

    // Open finding cards render only open items
    const openHeadings = [...container!.querySelectorAll(".issues:not(.resolved-list) article h3")].map((h) => h.textContent);
    expect(openHeadings).toEqual(["Open Critical", "Open Warning"]);

    // Resolved issues accordion remains intact
    const resolvedToggle = container!.querySelector(".qa-resolved-toggle");
    expect(resolvedToggle?.textContent).toContain("Resolved issues (2)");
  });

  it("shows filter-specific empty state when filter has zero matching open findings without showing global clear empty state", async () => {
    const warningA = makeFinding({ id: "w_a", severity: "warn", message: "Warning Alpha" });
    const warningB = makeFinding({ id: "w_b", severity: "warn", message: "Warning Beta" });

    const detail = makeDetail({
      state: {
        status: "warn",
        score: 0.88,
        issues: [],
        checks: {},
        findings: [warningA, warningB],
      },
      counts: { open: 2, resolved: 0, safeFixesAvailable: 0 },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    // Click Critical (0 open critical findings)
    const critBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 0 critical QA findings"]')!;
    await act(async () => {
      critBtn.click();
    });

    expect(container!.querySelectorAll(".issues article")).toHaveLength(0);
    expect(container!.textContent).toContain("No critical findings");
    expect(container!.textContent).toContain("This chapter currently has no open critical QA findings.");
    // Must NOT say "Nothing needs attention"
    expect(container!.textContent).not.toContain("Nothing needs attention");
    expect(container!.textContent).not.toContain("Every finding for this chapter is resolved");

    // Switch to Warning: displays warning cards and removes empty message
    const warnBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 2 warning QA findings"]')!;
    await act(async () => {
      warnBtn.click();
    });

    expect(container!.textContent).not.toContain("No critical findings");
    expect(container!.querySelectorAll(".issues article")).toHaveLength(2);
  });

  it("shows 'No warning findings' empty state when chapter only has open critical findings and user selects Warning", async () => {
    const criticalA = makeFinding({ id: "c_a", severity: "fail", message: "Critical Alpha" });

    const detail = makeDetail({
      state: {
        status: "fail",
        score: 0.50,
        issues: [],
        checks: {},
        findings: [criticalA],
      },
      counts: { open: 1, resolved: 0, safeFixesAvailable: 0 },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    const warnBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 0 warning QA findings"]')!;
    await act(async () => {
      warnBtn.click();
    });

    expect(container!.querySelectorAll(".issues article")).toHaveLength(0);
    expect(container!.textContent).toContain("No warning findings");
    expect(container!.textContent).toContain("This chapter currently has no open warning QA findings.");
    expect(container!.textContent).not.toContain("Nothing needs attention");
  });

  it("hides filter strip and shows normal clear empty state when chapter has zero open findings", async () => {
    const detail = makeDetail({
      state: {
        status: "pass",
        score: 1.0,
        issues: [],
        checks: {},
        findings: [],
      },
      counts: { open: 0, resolved: 0, safeFixesAvailable: 0 },
      qaStale: false,
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    // Filter strip is hidden when there are zero open findings
    expect(container!.querySelector(".qa-severity-filters")).toBeNull();
    // Status shows Chapter is clear
    expect(container!.textContent).toContain("Chapter is clear");
    // Standard empty state renders
    expect(container!.textContent).toContain("Nothing needs attention");
    expect(container!.textContent).toContain("Every finding for this chapter is resolved.");
  });

  it("supports stale QA awaiting verification: displays severity counts, pending verification badge, and preserves filter", async () => {
    const staleCritical = makeFinding({
      id: "c_stale",
      severity: "fail",
      message: "Stale Critical Issue",
      verifiedAgainstFingerprint: "old-fp",
    });
    const staleWarning = makeFinding({
      id: "w_stale",
      severity: "warn",
      message: "Stale Warning Issue",
      verifiedAgainstFingerprint: "old-fp",
    });

    const detail = makeDetail({
      state: {
        status: "warn",
        score: 0.72,
        issues: [],
        checks: {},
        findings: [staleCritical, staleWarning],
      },
      counts: { open: 2, resolved: 0, safeFixesAvailable: 0 },
      qaStale: true,
      currentFingerprint: "new-fp",
      stats: {
        open: 2,
        resolved: 0,
        unverified: 2,
        needsVerification: 2,
      },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    // Stale notice and unverified label are present
    expect(container!.querySelector(".artifact-status-notice")).toBeTruthy();
    expect(container!.textContent).toContain("2 previous open findings — awaiting QA verification");

    // Severity controls are present with accurate counts
    const critBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 1 critical QA finding"]')!;
    const warnBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 1 warning QA finding"]')!;
    expect(critBtn.textContent).toContain("Critical 1");
    expect(warnBtn.textContent).toContain("Warning 1");

    // Cards display "Awaiting QA verification" badge
    const badges = [...container!.querySelectorAll(".qa-reviewed")].map((b) => b.textContent);
    expect(badges.filter((b) => b === "Awaiting QA verification")).toHaveLength(2);

    // Filtering to Critical works on stale QA
    await act(async () => {
      critBtn.click();
    });

    const visibleCards = container!.querySelectorAll(".issues article");
    expect(visibleCards).toHaveLength(1);
    expect(visibleCards[0]?.textContent).toContain("Stale Critical Issue");
    expect(visibleCards[0]?.textContent).toContain("Awaiting QA verification");
  });

  it("resets severity filter to 'all' when navigating to a different chapter", async () => {
    const finding1 = makeFinding({ id: "c_1", severity: "fail", message: "Chapter 1 Critical" });
    const detail1 = makeDetail({
      chapter: 1,
      state: { status: "fail", score: 0.7, issues: [], checks: {}, findings: [finding1] },
      counts: { open: 1, resolved: 0, safeFixesAvailable: 0 },
    });

    const finding2 = makeFinding({ id: "w_2", severity: "warn", message: "Chapter 2 Warning" });
    const detail2 = makeDetail({
      chapter: 2,
      state: { status: "warn", score: 0.8, issues: [], checks: {}, findings: [finding2] },
      counts: { open: 1, resolved: 0, safeFixesAvailable: 0 },
    });

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail1}
      />
    );

    // Select Critical on Chapter 1
    const critBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 1 critical QA finding"]')!;
    await act(async () => {
      critBtn.click();
    });
    expect(critBtn.classList.contains("active")).toBe(true);

    // Re-render component on Chapter 2 with initialData=detail2
    await act(async () => {
      root!.render(
        <QaDetail
          slug="test-story"
          chapter={2}
          onJob={() => undefined}
          onEditManually={() => undefined}
          onChanged={() => undefined}
          initialData={detail2}
        />
      );
    });

    // Filter should have reset to "all"
    const allBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 1 open QA finding"]')!;
    expect(allBtn.classList.contains("active")).toBe(true);
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");

    const headings = [...container!.querySelectorAll(".issues article h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Chapter 2 Warning"]);
  });

  it("preserves active filter after a finding mutation within the same chapter", async () => {
    const critical1 = makeFinding({ id: "c_1", severity: "fail", message: "Critical First", status: "open" });
    const critical2 = makeFinding({ id: "c_2", severity: "fail", message: "Critical Second", status: "open" });
    const warning1 = makeFinding({ id: "w_1", severity: "warn", message: "Warning Only", status: "open" });

    const detail = makeDetail({
      chapter: 1,
      state: {
        status: "fail",
        score: 0.60,
        issues: [],
        checks: {},
        findings: [critical1, critical2, warning1],
      },
      counts: { open: 3, resolved: 0, safeFixesAvailable: 0 },
    });

    let currentDetail = detail;

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/resolve-manual")) {
        currentDetail = {
          ...detail,
          state: {
            ...detail.state,
            findings: [
              { ...critical1, status: "fixed_manual" },
              critical2,
              warning1,
            ],
          },
          counts: { open: 2, resolved: 1, safeFixesAvailable: 0 },
        };
        return {
          ok: true,
          json: async () => ({
            presentation: currentDetail,
          }),
        };
      }
      return { ok: true, json: async () => currentDetail };
    }));

    await mount(
      <QaDetail
        slug="test-story"
        chapter={1}
        onJob={() => undefined}
        onEditManually={() => undefined}
        onChanged={() => undefined}
        initialData={detail}
      />
    );

    // Switch to Critical
    const critBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 2 critical QA findings"]')!;
    await act(async () => {
      critBtn.click();
    });

    expect(critBtn.classList.contains("active")).toBe(true);
    let headings = [...container!.querySelectorAll(".issues:not(.resolved-list) article h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Critical First", "Critical Second"]);

    // Click "Mark resolved" on first critical card
    const resolveBtns = container!.querySelectorAll<HTMLButtonElement>(".qa-finding-actions button");
    const resolveBtn = [...resolveBtns].find((b) => b.textContent === "Mark resolved")!;
    await act(async () => {
      resolveBtn.click();
    });

    // After mutation finishes, filter must still be "critical"
    const updatedCritBtn = container!.querySelector<HTMLButtonElement>('button[aria-label="Show 1 critical QA finding"]')!;
    expect(updatedCritBtn).toBeTruthy();
    expect(updatedCritBtn.classList.contains("active")).toBe(true);
    expect(updatedCritBtn.getAttribute("aria-pressed")).toBe("true");

    // Only remaining critical card should be visible
    headings = [...container!.querySelectorAll(".issues:not(.resolved-list) article h3")].map((h) => h.textContent);
    expect(headings).toEqual(["Critical Second"]);
  });
});
