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
  const [kind, setKind] = useState('')
  const { data, error } = usePollingResource<AuditPageDto>(
    `/console-api/server-audits?page=${page}&page_size=${pageSize}&kind=${encodeURIComponent(kind)}`,
  )
  const total = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pages)
  const statusLabel = (status: string) =>
    status in STATUS_KEYS ? c[STATUS_KEYS[status as keyof typeof STATUS_KEYS]] : status
  const kindLabel = (value: string) =>
    value === 'command' ? c.auditKindCommand : value === 'upload' ? c.auditKindUpload : c.auditKindDownload
  const target = (record: AuditPageDto['items'][number]) =>
    record.kind === 'command' ? record.command : record.remote_path
  return (
    <Panel
      className="smp-upgrade-page smp-list-panel smp-audit-page"
      title={c.auditTitle}
      extra={
        <select
          aria-label={c.auditKind}
          value={kind}
          onChange={(event) => { setKind(event.target.value); setPage(1) }}
        >
          <option value="">{c.auditAllKinds}</option>
          <option value="command">{c.auditKindCommand}</option>
          <option value="upload">{c.auditKindUpload}</option>
          <option value="download">{c.auditKindDownload}</option>
        </select>
      }
    >
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
              <th>{c.auditKind}</th>
              <th>{c.auditActor}</th>
              <th>{c.auditServer}</th>
              <th>{c.auditTarget}</th>
              <th>{c.auditStatus}</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((record) => (
              <tr key={record.id}>
                <td>{formatDate(record.started_at, active)}</td>
                <td>{kindLabel(record.kind)}</td>
                <td>{record.actor_id}</td>
                <td>{record.server_name}</td>
                <td className="smp-audit-command" title={target(record) ?? ''}>{target(record)}</td>
                <td>
                  <span className={`smp-audit-status is-${record.status}`}>{statusLabel(record.status)}</span>
                </td>
              </tr>
            ))}
            {!data?.items.length && (
              <tr>
                <td colSpan={6} className="empty">{c.auditEmpty}</td>
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
