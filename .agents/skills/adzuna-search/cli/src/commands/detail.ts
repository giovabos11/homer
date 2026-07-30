import { recallJob, toDetail, writeError, type JobDetailResult } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

/** Accept a numeric id or an Adzuna redirect/details URL containing one. */
export function normalizeId(input: string): string | null {
  const t = input.trim()
  if (/^\d+$/.test(t)) return t
  const m =
    t.match(/adzuna\.[a-z.]+\/(?:land\/ad|details)\/(\d+)/i) ?? t.match(/[?&]ad=(\d+)/i)
  if (m) return m[1]
  return null
}

function renderPlain(job: JobDetailResult): string {
  return [
    job.title,
    `${job.company ?? "—"} · ${job.location ?? "—"} · ${job.date ?? "—"}`,
    job.employment_type ? `Employment: ${job.employment_type}` : "",
    job.category ? `Category: ${job.category}` : "",
    job.salary_min !== null || job.salary_max !== null
      ? `Salary: ${job.salary_min ?? "?"}–${job.salary_max ?? "?"} USD${job.salary_is_predicted ? " (predicted)" : ""}`
      : "",
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
  const id = normalizeId(opts.id)
  if (!id) {
    writeError(`could not parse an Adzuna job id from "${opts.id}"`, "BAD_ID")
    return 1
  }
  try {
    // Adzuna has no fetch-by-id endpoint; detail answers from the search cache.
    const hit = await recallJob(id)
    if (!hit) {
      writeError(
        `job ${id} is not in the local Adzuna result cache — run a search that returns it first (Adzuna's API has no fetch-by-id endpoint)`,
        "NOT_CACHED",
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
