import { loadCategory, toDetail, writeError, type JobDetailResult } from "../helpers.js"

export interface DetailOpts {
  id: string
  category: string
  format: "json" | "plain"
}

/** Accept a numeric id or a remotive.com job URL (which ends in the id). */
export function normalizeId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  if (/^\d+$/.test(t)) return t
  const url = t.match(/remotive\.com\/remote-jobs\/[^/?#]*?(\d+)(?:[/?#]|$)/i)
  if (url) return url[1]
  const trailing = t.match(/-(\d+)$/)
  if (trailing) return trailing[1]
  return null
}

function renderPlain(job: JobDetailResult): string {
  return [
    job.title,
    `${job.company ?? "—"} · ${job.location ?? "remote"} · ${job.date ?? "—"}${job.job_type ? ` · ${job.job_type}` : ""}`,
    job.tags.length > 0 ? `Tags: ${job.tags.join(", ")}` : "",
    job.salary_raw ? `Salary: ${job.salary_raw}` : "",
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
    writeError(`could not parse a job id from "${opts.id}"`, "BAD_ID")
    return 1
  }
  try {
    const { jobs } = await loadCategory(opts.category)
    const hit = jobs.find((j) => String(j.id) === id)
    if (!hit) {
      writeError(
        `job ${id} not found in the cached "${opts.category}" listing — pass the same --category the search used`,
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
