import { useEffect, useState, type FormEvent } from 'react'
import { type ServerError } from '../../../shared/errors.ts'
import {
  displayError,
  displayJobError,
  enumLabel,
  format,
  formatDate,
  serverCopy,
} from '../../../shared/i18n.ts'
import { api, requestError } from '../../shared/api.ts'
interface TaskRow {
  id: string
  action: string
  status: string
  output_excerpt: string
  result?: {
    summary?: string
    error?: unknown
    issues?: unknown[]
    hour_start?: string
    hour_end?: string
    succeeded?: number
    failed?: number
    steps?: {
      ordinal: number
      software: string
      state: string
      after?: { version?: string }
      changes?: { name?: string; version?: string }[]
    }[]
  }
  created_at: string
}
interface TaskPage {
  items: TaskRow[]
  page: number
  page_size: number
  total: number
}
const EMPTY_FILTER = { query: '', action: '', status: '', from: '', to: '' }

export function TaskHistory(props: { active: string; serverId: string; refresh: number }) {
  const { active } = props
  const copy = serverCopy(active).ui
  const [draft, setDraft] = useState(EMPTY_FILTER)
  const [filter, setFilter] = useState({ ...EMPTY_FILTER, page: 1, pageSize: 10 })
  const [loaded, setLoaded] = useState<{ key: string; data: TaskPage }>()
  const [error, setError] = useState<ServerError | null>(null)
  const params = new URLSearchParams({
    server_id: props.serverId,
    q: filter.query,
    action: filter.action,
    status: filter.status,
    page: String(filter.page),
    page_size: String(filter.pageSize),
  })
  if (filter.from) params.set('from', new Date(filter.from).toISOString())
  if (filter.to) params.set('to', new Date(filter.to).toISOString())
  const key = params.toString()
  const data = loaded?.key === key ? loaded.data : undefined

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    setError(null)
    async function load() {
      try {
        const next = await api<TaskPage>(`/console-api/server-jobs?${key}`, { signal: controller.signal })
        if (!stopped) {
          setLoaded({ key, data: next })
          setError(null)
        }
      } catch (cause) {
        if (!stopped) setError(requestError(cause))
      } finally {
        if (!stopped)
          timer = setTimeout(() => {
            void load()
          }, 5000)
      }
    }
    void load()
    return () => {
      stopped = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [key, props.refresh])

  function search(event: FormEvent) {
    event.preventDefault()
    setFilter({ ...filter, ...draft, page: 1 })
  }
  const page = data?.page ?? filter.page
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / filter.pageSize))
  return (
    <section className="smp-task-history" aria-label={copy.jobs}>
      <h2>{copy.jobs}</h2>
      <p className="muted">{copy.inspectionHistoryHint}</p>
      <form className="smp-task-filters" onSubmit={search}>
        <label>
          {copy.taskKeyword}
          <input
            type="search"
            maxLength={200}
            placeholder={copy.searchTasks}
            value={draft.query}
            onChange={(event) => setDraft({ ...draft, query: event.target.value })}
          />
        </label>
        <label>
          {copy.taskType}
          <select
            value={draft.action}
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
          >
            <option value="">{copy.allTypes}</option>
            {Object.entries(serverCopy(active).actions).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {copy.status}
          <select
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value })}
          >
            <option value="">{copy.allStatuses}</option>
            {Object.entries(serverCopy(active).jobStatus).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {copy.taskFrom}
          <input
            type="datetime-local"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label>
          {copy.taskTo}
          <input
            type="datetime-local"
            min={draft.from || undefined}
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <button className="secondary" type="submit">
          {copy.search}
        </button>
        <button
          className="link"
          type="button"
          onClick={() => {
            setDraft(EMPTY_FILTER)
            setFilter({ ...EMPTY_FILTER, page: 1, pageSize: filter.pageSize })
          }}
        >
          {copy.reset}
        </button>
      </form>
      {error && (
        <p className="banner error" role="alert">
          {displayError(active, error)}
        </p>
      )}
      <div className="table-scroll" aria-busy={!data && !error}>
        <table className="smp-task-table">
          <thead>
            <tr>
              <th>{copy.createdAt}</th>
              <th>{copy.taskType}</th>
              <th>{copy.status}</th>
              <th>{copy.taskDetails}</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((job) => (
              <tr key={job.id}>
                <td>{formatDate(job.created_at, active)}</td>
                <td title={job.action === 'inspection_report' ? undefined : job.id}>
                  {enumLabel(serverCopy(active).actions, job.action)}
                </td>
                <td>
                  <span className={`pill ${job.status}`}>
                    {enumLabel(serverCopy(active).jobStatus, job.status)}
                  </span>
                </td>
                <td>
                  <TaskResult active={active} job={job} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data ? (
          <p className="empty">{error ? copy.cannotLoadTasks : copy.loading}</p>
        ) : (
          data.items.length === 0 && <p className="empty">{copy.noTasks}</p>
        )}
      </div>
      <footer className="smp-server-pager" aria-label={copy.taskPagination}>
        <span>
          {format(data?.total ? copy.taskRange : copy.taskTotal, {
            count: data?.total ?? 0,
            from: (page - 1) * filter.pageSize + 1,
            to: Math.min(page * filter.pageSize, data?.total ?? 0),
          })}
        </span>
        <div className="row">
          <label>
            {copy.perPage}
            <select
              aria-label={copy.tasksPageSize}
              value={filter.pageSize}
              onChange={(event) => setFilter({ ...filter, pageSize: Number(event.target.value), page: 1 })}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            type="button"
            disabled={!data || page <= 1}
            onClick={() => setFilter({ ...filter, page: page - 1 })}
          >
            {copy.previous}
          </button>
          <span aria-live="polite">{format(copy.page, { page, pages })}</span>
          <button
            className="secondary"
            type="button"
            disabled={!data || page >= pages}
            onClick={() => setFilter({ ...filter, page: page + 1 })}
          >
            {copy.next}
          </button>
        </div>
      </footer>
    </section>
  )
}

function TaskResult({ active, job }: { active: string; job: TaskRow }) {
  const copy = serverCopy(active)
  const result = job.result
  return (
    <>
      {job.action === 'inspection_report' && result ? (
        <>
          {format(copy.ui.inspectionReport, { succeeded: result.succeeded ?? 0, failed: result.failed ?? 0 })}
          <small className="muted">
            {formatDate(result.hour_start ?? null, active)} – {formatDate(result.hour_end ?? null, active)}
          </small>
        </>
      ) : result?.error ? (
        displayJobError(active, result.error)
      ) : result?.summary ? (
        enumLabel(copy.jobMessages, result.summary)
      ) : job.status === 'recovering' ? (
        copy.jobMessages.recovering
      ) : (
        job.output_excerpt
      )}
      {result?.issues?.length ? (
        <ul>
          {result.issues.map((issue, index) => (
            <li key={index}>{displayJobError(active, issue)}</li>
          ))}
        </ul>
      ) : null}
      {result?.steps && (
        <ul>
          {result.steps.map((step) => (
            <li key={step.ordinal}>
              {step.software}: {enumLabel(copy.jobStatus, step.state)}
              {step.after?.version ? ` (${step.after.version})` : ''}
              {step.changes?.length ? (
                <small>
                  {' '}
                  —{' '}
                  {step.changes
                    .map((change) => `${change.name ?? ''}${change.version ? ` ${change.version}` : ''}`)
                    .filter(Boolean)
                    .join(', ')}
                </small>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
