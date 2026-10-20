import type { RecordPage } from '../../../shared/dto/upgrades.ts'
import { displayError, displayJobError, enumLabel, formatDate, serverCopy } from '../../../shared/i18n.ts'
import { usePollingResource } from '../../shared/usePollingResource.ts'
import { Pager } from '../Pager.tsx'

export function UpgradeRecords(props: {
  active: string
  page: number
  onPage: (page: number) => void
  onPlan: (id: string) => void
}) {
  const { active, page, onPage: setPage, onPlan: setPlan } = props,
    c = serverCopy(active).upgrades
  const { data: records, error } = usePollingResource<RecordPage>(
    '/console-api/server-changes/records?page=' + page,
  )
  return (
    <>
      {error && (
        <p className="banner error" role="alert">
          {displayError(active, error)}
        </p>
      )}
      <>
        <div className="smp-upgrade-scroll">
          <table>
            <thead>
              <tr>
                <th>{c.server}</th>
                <th>{c.status}</th>
                <th>{c.start}</th>
                <th>{c.remoteChanges}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {records?.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.server_snapshot.name}</td>
                  <td>{enumLabel(c, r.state)}</td>
                  <td>{formatDate(r.created_at, active)}</td>
                  <td>
                    <p>
                      {r.result && typeof r.result === 'object' && 'error' in r.result
                        ? displayJobError(active, r.result.error)
                        : r.result && typeof r.result === 'object' && 'summary' in r.result
                          ? enumLabel(serverCopy(active).jobMessages, String(r.result.summary))
                          : r.output_excerpt}
                    </p>
                    <details>
                      <summary>{c.details}</summary>
                      <pre>{JSON.stringify({ result: r.result, steps: r.steps }, null, 2)}</pre>
                    </details>
                  </td>
                  <td>
                    <button className="link" onClick={() => setPlan(r.plan_id)}>
                      {c.details}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!records?.items.length && <p>{c.emptyRecords}</p>}
        </div>
        <Pager active={active} page={page} total={records?.total ?? 0} onPage={setPage} />
      </>
    </>
  )
}
