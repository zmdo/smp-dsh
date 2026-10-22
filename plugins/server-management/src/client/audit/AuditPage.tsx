import { Panel } from '@smp/console-kit'
import { serverCopy, type LocaleFace } from '../../shared/i18n.ts'
import { useActiveLocale } from '../shared/locale.ts'

export function AuditPage(props: { locale: LocaleFace }) {
  const c = serverCopy(useActiveLocale(props.locale)).ui
  return (
    <Panel className="smp-upgrade-page smp-list-panel smp-audit-page" title={c.auditTitle}>
      <div className="smp-list-scroll">
        <table className="smp-table smp-records-table">
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
            <tr>
              <td colSpan={5} className="empty">{c.auditEmpty}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <footer className="smp-server-pager smp-list-pager">
        <span>{c.auditEmpty}</span>
        <div className="row">
          <button className="secondary" type="button" disabled>{c.previous}</button>
          <span>{c.auditPage}</span>
          <button className="secondary" type="button" disabled>{c.next}</button>
        </div>
      </footer>
    </Panel>
  )
}
