import type { PlanSummary } from '../../../shared/dto/changes.ts'
import { displayError, enumLabel, formatDate, serverCopy } from '../../../shared/i18n.ts'
import { usePollingResource } from '../../shared/usePollingResource.ts'

export function UpgradePlans(props: { active: string; onPlan: (id: string) => void }) {
  const active = props.active,
    c = serverCopy(active).upgrades
  const { data, error } = usePollingResource<PlanSummary[]>('/console-api/server-changes/plans')
  const plans = data ?? [],
    setPlan = props.onPlan
  return (
    <>
      {error && (
        <p className="banner error" role="alert">
          {displayError(active, error)}
        </p>
      )}
      <div className="smp-upgrade-scroll">
        <table>
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
            {plans.map((p) => (
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
    </>
  )
}
