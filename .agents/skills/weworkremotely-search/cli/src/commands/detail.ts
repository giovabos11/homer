import {
  DEFAULT_CATEGORY,
  loadCategory,
  slugFromUrl,
  toDetail,
  writeError,
  type FeedItem,
  type JobDetailResult,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  category: string
  format: "json" | "plain"
}

/** Accept a slug from search results or a weworkremotely.com listing URL. */
export function normalizeId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  if (/weworkremotely\.com/i.test(t)) return slugFromUrl(t)
  if (/^[\w-]+$/.test(t)) return t
  return null
}

function findItem(items: FeedItem[], slug: string): FeedItem | undefined {
  return items.find((i) => i.id === slug)
}

function renderPlain(job: JobDetailResult): string {
  return [
    job.title,
    `${job.company ?? "—"} · ${job.location ?? "remote"} · ${job.date ?? "—"}`,
    job.category ? `Category: ${job.category}` : "",
    job.salary_min !== null ? `Salary: ${job.salary_min}–${job.salary_max} ${job.salary_currency}` : "",
    "",
    job.description ?? "(no description)",
    "",
    `id: ${job.id}`,
    `URL: ${job.url}`,
  ]
    .filter((l) => l !== "")
    .join("\n")
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  const slug = normalizeId(opts.id)
  if (!slug) {
    writeError(`could not parse a job slug from "${opts.id}"`, "BAD_ID")
    return 1
  }
  try {
    let { items } = await loadCategory(opts.category)
    let hit = findItem(items, slug)
    // Not in the requested category feed? The all-jobs feed covers every category.
    if (!hit && opts.category !== "all") {
      ;({ items } = await loadCategory("all"))
      hit = findItem(items, slug)
    }
    if (!hit) {
      writeError(
        `job ${slug} not found in the current feeds (WWR RSS only carries recent posts)`,
        "NOT_FOUND",
      )
      return 1
    }
    const job = toDetail(hit)
    if (opts.format === "plain") {
      process.stdout.write(renderPlain(job) + "\n")
    } else {
      process.stdout.write(JSON.stringify(job, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}

export { DEFAULT_CATEGORY }
