import { loadFeed, toDetail, writeError, type JobDetailResult, type RemoteOKJob } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

/** Accept a numeric id, a slug, or a remoteok.com job URL. */
export function normalizeId(input: string): string | null {
  const t = input.trim()
  if (!t) return null
  const url = t.match(/remoteok\.com\/remote-jobs\/([^/?#]+)/i)
  if (url) return url[1]
  if (/^[\w-]+$/.test(t)) return t
  return null
}

export function findJob(jobs: RemoteOKJob[], id: string): RemoteOKJob | undefined {
  return jobs.find((j) => {
    if (String(j.id) === id || j.slug === id) return true
    // A slug like "remote-brand-designer-symbiotic-1135528" ends in the id.
    const m = id.match(/-(\d+)$/)
    return m !== null && String(j.id) === m[1]
  })
}

function renderPlain(job: JobDetailResult): string {
  const salary =
    job.salary_min !== null || job.salary_max !== null
      ? `Salary: ${job.salary_min ?? "?"}–${job.salary_max ?? "?"} ${job.salary_currency ?? ""}`.trimEnd()
      : ""
  return [
    job.title,
    `${job.company ?? "—"} · ${job.location ?? "remote"} · ${job.date ?? "—"}`,
    job.tags.length > 0 ? `Tags: ${job.tags.join(", ")}` : "",
    salary,
    "",
    job.description ?? "(no description)",
    "",
    `id: ${job.id}`,
    `URL: ${job.url}`,
    job.apply_url ? `Apply: ${job.apply_url}` : "",
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
    const { jobs } = await loadFeed()
    const hit = findJob(jobs, id)
    if (!hit) {
      writeError(
        `job ${id} not found in the current RemoteOK feed (the public feed only carries the ~100 most recent posts)`,
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
