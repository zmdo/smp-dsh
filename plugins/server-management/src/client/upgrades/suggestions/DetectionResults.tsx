import { detectionResult } from '../../../shared/detection-result.ts'
import { type DetectionResult } from '../../../shared/dto/upgrades.ts'
import { format, formatDate, serverCopy } from '../../../shared/i18n.ts'
export function DetectionResults(props: {
  active: string
  checks: readonly DetectionResult[]
  loading: boolean
  failuresOnly: boolean
  softwareName: (key: string) => string
}) {
  const copy = serverCopy(props.active).upgrades
  const rows = props.checks
    .map((check) => ({ check, ...detectionResult(props.active, check) }))
    .filter((row) => !props.failuresOnly || row.state === 'failed')
  return (
    <section className="smp-detection-results" aria-label={copy.checks} aria-busy={props.loading}>
      <header className="smp-detection-head">
        <h2>{copy.checks}</h2>
        <span>{format(copy.checkCount, { count: rows.length })}</span>
      </header>
      <div className="smp-detection-scroll">
        <table className="smp-detection-table">
          <thead>
            <tr>
              <th scope="col">{copy.server}</th>
              <th scope="col">{copy.software}</th>
              <th scope="col">{copy.status}</th>
              <th scope="col">{copy.checkedAt}</th>
              <th scope="col">{copy.checkReason}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ check, state, label, reasons }) => (
              <tr key={`${check.server_id}/${check.software_key}`}>
                <td>
                  <b>{check.server_name}</b>
                  {check.host && <small className="mono">{check.host}</small>}
                </td>
                <td>{props.softwareName(check.software_key)}</td>
                <td>
                  <span className={`smp-detection-status ${state}`}>{label}</span>
                </td>
                <td className="smp-detection-time">{formatDate(check.last_check_at, props.active)}</td>
                <td>
                  <ul className="smp-detection-reasons">
                    {reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="smp-upgrade-empty">
                  {props.loading
                    ? serverCopy(props.active).ui.loading
                    : props.failuresOnly
                      ? copy.noCheckFailures
                      : copy.noChecks}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
