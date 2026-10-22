import { Panel } from '@smp/console-kit'
import { useState } from 'react'
import type { AuditPageDto } from '../../shared/dto/audit.ts'
import { displayError, format, formatDate, serverCopy, type LocaleFace } from '../../shared/i18n.ts'
import { useActiveLocale } from '../shared/locale.ts'
import { usePollingResource } from '../shared/usePollingResource.ts'

const STATUS_KEYS = {
  pending: 'auditPending',
  succeeded: 'auditSucceeded',
  failed: 'auditFailed',
  denied: 'auditDenied',
  timeout: 'auditTimeout',
  cancelled: 'auditCancelled',
} as const

export function AuditPage(props: { locale: LocaleFace }) {
  const active = useActiveLocale(props.locale)
  const c = serverCopy(active).ui
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const { data, error } = usePollingResource<AuditPageDto>(
    `/console-api/server-audits?page=${page}&page_size=${pageSize}`,
  )
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pages)
  const statusLabel = (status: string) =>
    status in STATUS_KEYS ? c[STATUS_KEYS[status as keyof typeof STATUS_KEYS]] : status
  return (
    <Panel className="smp-upgrade-page smp-list-panel smp-audit-page" title={c.auditTitle}>
      {error && (
        <p className="banner error" role="alert">
          {displayError(active, error)}
        </p>
      )}
      <div className="smp-list-scroll">
        <table className="smp-table smp-records-table smp-audit-table">
          <thead>
            <tr>
              <th>{c.auditTime}</th>
              <th>{c.auditActor}</th>
              <th>{c.auditServer}</th>
              <th>{c.auditCommand}</th>
              <th>{c.auditStatus}</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((record) => (
              <tr key={record.id}>
                <td>{formatDate(record.started_at, active)}</td>
                <td>{record.actor_id}</td>
                <td>{record.server_name}</td>
                <td className="smp-audit-command" title={record.command}>{record.command}</td>
                <td>
                  <span className={`smp-audit-status is-${record.status}`}>{statusLabel(record.status)}</span>
                </td>
              </tr>
            ))}
            {!data?.items.length && (
              <tr>
                <td colSpan={5} className="empty">{c.auditEmpty}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <footer className="smp-server-pager smp-list-pager">
        <span>{format(c.auditTotal, { count: total })}</span>
        <div className="row">
          <label>
            {c.perPage}
            <select
              aria-label={c.perPage}
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value))
                setPage(1)
              }}
            >
              {[10, 20, 50].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button className="secondary" type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>
            {c.previous}
          </button>
          <span aria-live="polite">{format(c.auditPage, { page: current, pages })}</span>
          <button
            className="secondary"
            type="button"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
          >
            {c.next}
          </button>
        </div>
      </footer>
    </Panel>
  )
}
