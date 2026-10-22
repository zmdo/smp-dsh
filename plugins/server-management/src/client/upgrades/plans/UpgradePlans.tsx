import type { PlanSummary } from '../../../shared/dto/changes.ts'
import { displayError, enumLabel, format, formatDate, serverCopy } from '../../../shared/i18n.ts'
import { usePollingResource } from '../../shared/usePollingResource.ts'
import { useState } from 'react'

export function UpgradePlans(props: { active: string; onPlan: (id: string) => void }) {
  const active = props.active,
    c = serverCopy(active).upgrades,
    copy = serverCopy(active).ui
  const { data, error } = usePollingResource<PlanSummary[]>('/console-api/server-changes/plans')
  const plans = data ?? [],
    setPlan = props.onPlan
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const pages = Math.max(1, Math.ceil(plans.length / pageSize))
  const current = Math.min(page, pages)
  const rows = plans.slice((current - 1) * pageSize, current * pageSize)
  return (
    <>
      {error && (
        <p className="banner error" role="alert">
          {displayError(active, error)}
        </p>
      )}
      <div className="smp-list-scroll">
        <table className="smp-table">
          <thead>
            <tr>
              <th>{c.planId}</th>
              <th>{c.type}</th>
              <th>{c.status}</th>
              <th>{c.server}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="mono">
                  {p.id.slice(0, 8)}
                  <small>{formatDate(p.created_at, active)}</small>
                </td>
                <td>{enumLabel(c, p.kind)}</td>
                <td>{enumLabel(c, p.state)}</td>
                <td>
                  {p.succeeded_count}/{p.target_count}
                  {p.running_count > 0 && (
                    <small>
                      {c.running} ({p.running_count})
                    </small>
                  )}
                </td>
                <td>
                  <button className="link" onClick={() => setPlan(p.id)}>
                    {c.details}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plans.length > 0 && (
        <footer className="smp-server-pager smp-list-pager" aria-label={c.planPagination}>
          <span>
            {format(plans.length ? c.planRange : c.planTotal, {
              count: plans.length,
              from: (current - 1) * pageSize + 1,
              to: Math.min(current * pageSize, plans.length),
            })}
          </span>
          <div className="row">
            <label>
              {copy.perPage}
              <select
                aria-label={c.planPageSize}
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value))
                  setPage(1)
                }}
              >
                {[10, 20, 50].map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </label>
            <button className="secondary" type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>
              {copy.previous}
            </button>
            <span aria-live="polite">{format(copy.page, { page: current, pages })}</span>
            <button className="secondary" type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}>
              {copy.next}
            </button>
          </div>
        </footer>
      )}
    </>
  )
}
