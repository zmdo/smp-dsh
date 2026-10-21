import { format, formatDate } from '../../../shared/i18n.ts'
import { Pager } from '../Pager.tsx'
import { DeferUpgrade } from './DeferUpgrade.tsx'
import { DetectionResults } from './DetectionResults.tsx'
import { SuggestionFilters } from './SuggestionFilters.tsx'
import { UpgradeBatch } from './UpgradeBatch.tsx'
import type { UpgradeSuggestionsModel } from './useUpgradeSuggestions.ts'

export function UpgradeSuggestions({ model }: { model: UpgradeSuggestionsModel }) {
  const {
    active,
    busy,
    c,
    commands,
    context,
    data,
    decision,
    error,
    filteredServers,
    notice,
    page,
    pick,
    selected,
    setDefer,
    setPage,
    setRemindAt,
    setSelected,
    showAll,
    shown,
    softwareName,
  } = model
  return (
    <>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="banner ok">{notice}</p>}

      <div className="smp-upgrade-toolbar">
        <p className="muted">{c.detectHint}</p>
        <div className="row">
          <button
            className="secondary"
            disabled={busy || !filteredServers.length}
            onClick={() => void commands.detect()}
          >
            {selected.length ? c.detect : c.detectAll}
          </button>
          {context?.serverId && (
            <button className="link" onClick={() => showAll()}>
              {c.all}
            </button>
          )}
        </div>
      </div>
      <SuggestionFilters model={model} />
      <div className="row smp-upgrade-selection" role="group" aria-label={c.selection}>
        <button
          className="secondary"
          disabled={!shown.length}
          onClick={() => setSelected([...new Set([...selected, ...shown.map((s) => s.server_id)])])}
        >
          {c.selectPage}
        </button>
        <button
          className="secondary"
          disabled={!data?.filtered_server_ids.length}
          onClick={() => setSelected(data?.filtered_server_ids ?? [])}
        >
          {c.selectFiltered}
        </button>
        <span>{format(c.selected, { count: selected.length })}</span>
      </div>
      <div className="smp-upgrade-scroll smp-upgrade-suggestions">
        <table className="smp-table">
          <thead>
            <tr>
              <th></th>
              <th>{c.server}</th>
              <th>{c.software}</th>
              <th>{c.current}</th>
              <th>{c.target}</th>
              <th>{c.status}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={s.server_name}
                    checked={selected.includes(s.server_id)}
                    onChange={() => pick(s.server_id)}
                  />
                </td>
                <td>
                  {s.server_name}
                  <small className="mono">{s.host}</small>
                </td>
                <td>{softwareName(s.software_key)}</td>
                <td>{s.basis_snapshot.before.version}</td>
                <td>
                  {s.product_version}
                  <small>{s.reason?.major ? c.major : c.sameMajor}</small>
                </td>
                <td>
                  {s.validity === 'blocked'
                    ? c.blocked
                    : s.decision === 'rejected'
                      ? c.rejected
                      : s.scheduled
                        ? c.scheduled
                        : s.reminder_after && Date.parse(s.reminder_after) > Date.now()
                          ? `${c.deferred} ${formatDate(s.reminder_after, active)}`
                          : c.pending}
                </td>
                <td>
                  <div className="row">
                    <button
                      className="link"
                      disabled={busy}
                      title={c.rejectedHint}
                      onClick={() => void commands.changeDecision(s)}
                    >
                      {s.decision === 'rejected' ? c.restore : c.reject}
                    </button>
                    <button
                      className="link"
                      onClick={() => {
                        setDefer(s.id)
                        setRemindAt('')
                      }}
                    >
                      {c.defer}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={7} className="smp-upgrade-empty">
                  {c.noSuggestions}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager active={active} page={page} total={data?.total ?? 0} onPage={setPage} />
      <UpgradeBatch model={model} />
      <DetectionResults
        active={active}
        checks={(data?.checks ?? []).filter(
          (check) => !context?.serverId || check.server_id === context.serverId,
        )}
        loading={!data}
        failuresOnly={decision === 'detection_failed'}
        softwareName={softwareName}
      />
      <DeferUpgrade model={model} />
    </>
  )
}
