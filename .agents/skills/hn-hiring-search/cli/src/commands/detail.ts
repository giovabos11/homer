import {
  ITEM_URL,
  apiGet,
  parseComment,
  writeError,
  type JobDetailResult,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

/** Accept a comment id or a news.ycombinator.com item URL. */
export function normalizeId(input: string): string | null {
  const t = input.trim()
  if (/^\d+$/.test(t)) return t
  const m = t.match(/news\.ycombinator\.com\/item\?id=(\d+)/i)
  if (m) return m[1]
  return null
}

interface AlgoliaItem {
  id: number
  author?: string
  created_at?: string
  text?: string | null
  type?: string
}

function renderPlain(job: JobDetailResult): string {
  return [
    `${job.company ?? "—"} — ${job.title}`,
    `${job.location ?? "—"} · ${job.remote_type ?? "—"} · ${job.date ?? "—"}${job.author ? ` · posted by ${job.author}` : ""}`,
    job.salary_min !== null ? `Salary: ${job.salary_min}–${job.salary_max} ${job.salary_currency}` : "",
    "",
    job.description ?? "(no text)",
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
    writeError(`could not parse an HN comment id from "${opts.id}"`, "BAD_ID")
    return 1
  }
  try {
    const item = await apiGet<AlgoliaItem>(`${ITEM_URL}/${id}`)
    if (!item || typeof item.text !== "string" || item.text.trim() === "") {
      writeError(`HN comment ${id} not found (or has no text)`, "NOT_FOUND")
      return 1
    }
    const job = parseComment({
      id: item.id,
      author: item.author ?? null,
      created_at: item.created_at ?? null,
      text: item.text,
    })
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
