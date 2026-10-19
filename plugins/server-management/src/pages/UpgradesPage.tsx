import { DetectionResults } from './DetectionResults.tsx'
import type { DetectionResult } from './detection-result.ts'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Panel } from '@smp/console-kit'
import { serverCopy, format, formatDate, enumLabel, type LocaleFace, groupName } from '../i18n.ts'
import { localized, type SoftwareView, type LocalizedText } from '../definitions.ts'
import { useActiveLocale } from './locale.ts'
import { api, requestError, displayError, displayJobError } from './api.ts'
import { ChangePlan } from './ChangePlan.tsx'
import type { ServerPageState } from './server-page-state.ts'
interface Suggestion {
  id: string
  server_id: string
  server_name: string
  host: string
  software_key: string
  product_version: string
  group_id: string | null
  type_key: string
  connection_state: string
  decision: string
  reminder_after: string | null
  scheduled: boolean
  basis_snapshot: { before: { version: string } }
  reason: { major: boolean; code?: string }
  validity: string
}
interface Suggestions {
  items: Suggestion[]
  total: number
  page: number
  page_size: number
  filtered_server_ids: string[]
  checks: DetectionResult[]
}
interface Inventory {
  type_name_i18n: LocalizedText
  required_software: SoftwareView[]
  id: string
  name: string
  group_id: string | null
  type_key: string
}
interface PlanSummary {
  id: string
  kind: string
  state: string
  created_at: string
  target_count: number
  succeeded_count: number
  running_count: number
}
interface RecordPage {
  items: {
    id: string
    state: string
    plan_id: string
    server_snapshot: { name: string }
    created_at: string
    finished_at: string | null
    output_excerpt: string
    result: unknown
    steps: unknown[]
  }[]
  total: number
}
export function UpgradesPage(props: {
  locale: LocaleFace
  pageState: ServerPageState
  openConsole?: (key: string) => void
}) {
  const active = useActiveLocale(props.locale),
    c = serverCopy(active).upgrades
  const snapshot = useSyncExternalStore(props.pageState.subscribe, props.pageState.getSnapshot)
  const context = snapshot.upgradeContext
  const { tab, page, planId: plan } = snapshot.upgradeView
  const setPage = (page: number) => props.pageState.setUpgradePage(page)
  const setPlan = (planId: string) => props.pageState.showUpgradePlan(planId)
  const [q, setQ] = useState(''),
    [decision, setDecision] = useState('pending')
  const [group, setGroup] = useState(context?.groupId ?? ''),
    [type, setType] = useState(''),
    [software, setSoftware] = useState(''),
    [connection, setConnection] = useState(''),
    [current, setCurrent] = useState(''),
    [target, setTarget] = useState('')
  const [data, setData] = useState<Suggestions>(),
    [plans, setPlans] = useState<PlanSummary[]>([]),
    [records, setRecords] = useState<RecordPage>(),
    [inventory, setInventory] = useState<Inventory[]>([])
  const [groups, setGroups] = useState<
      { id: string; name: string; name_i18n?: { zh: string; en: string } }[]
    >([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0)
  const [batchSoftware, setBatchSoftware] = useState<string[]>([]),
    [versions, setVersions] = useState<Record<string, string[]>>({}),
    [chosen, setChosen] = useState<Record<string, string>>({}),
    [defer, setDefer] = useState(''),
    [remindAt, setRemindAt] = useState('')
  const params = new URLSearchParams({
    q,
    decision,
    page: String(page),
    group_id: group,
    type_key: type,
    software,
    connection,
    current,
    target,
    ...(context?.serverId ? { server_id: context.serverId } : {}),
  }).toString()
  useEffect(() => {
    let stopped = false
    const load = async () => {
      try {
        const [inventory, groups] = await Promise.all([
          api<Inventory[]>('/console-api/server-changes/inventory'),
          api<{ id: string; name: string; name_i18n?: { zh: string; en: string } }[]>(
            '/console-api/server-groups',
          ),
        ])
        if (stopped) return
        setInventory(inventory)
        setGroups(groups)
        if (tab === 'suggestions') {
          const r = await api<Suggestions>('/console-api/server-changes/suggestions?' + params)
          if (!stopped) setData(r)
        } else if (tab === 'plans') {
          const r = await api<PlanSummary[]>('/console-api/server-changes/plans')
          if (!stopped) setPlans(r)
        } else {
          const r = await api<RecordPage>('/console-api/server-changes/records?page=' + page)
          if (!stopped) setRecords(r)
        }
      } catch (cause) {
        if (!stopped) setError(displayError(active, requestError(cause)))
      }
    }
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [tab, params, page, tick, active])
  useEffect(() => {
    let stopped = false
    setVersions({})
    setChosen({})
    if (selected.length && batchSoftware.length)
      void Promise.all(
        batchSoftware.map(
          async (software) =>
            [
              software,
              await api<{ versions: string[] }>('/console-api/server-changes/versions', {
                method: 'POST',
                body: JSON.stringify({ server_ids: selected, software }),
              }),
            ] as const,
        ),
      )
        .then((results) => {
          if (stopped) return
          setVersions(Object.fromEntries(results.map(([key, v]) => [key, v.versions])))
          setChosen(Object.fromEntries(results.map(([key, v]) => [key, v.versions[0] ?? ''])))
        })
        .catch((cause) => {
          if (!stopped) setError(displayError(active, requestError(cause)))
        })
    return () => {
      stopped = true
    }
  }, [selected, batchSoftware, active])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
      setTick((t) => t + 1)
    } catch (cause) {
      setError(displayError(active, requestError(cause)))
    } finally {
      setBusy(false)
    }
  }
  const shown = data?.items ?? [],
    keys = [...new Set(shown.map((s) => s.software_key))],
    filteredServers = inventory.filter(
      (s) =>
        (!group || s.group_id === group) &&
        (!type || s.type_key === type) &&
        (!context?.serverId || s.id === context.serverId),
    )
  const softwareName = (key: string) => {
    const item = inventory.flatMap((s) => s.required_software ?? []).find((s) => s.software_key === key)
    return item ? localized(item.name_i18n, active) : key
  }
  const pick = (id: string) =>
    setSelected((ids) => (ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id]))
  if (plan)
    return (
      <Panel className="smp-upgrade-page" title={c.plans}>
        <ChangePlan
          key={plan}
          active={active}
          id={plan}
          onNewPlan={setPlan}
          onClose={() => props.pageState.selectUpgradeTab('plans')}
        />
      </Panel>
    )
  return (
    <Panel
      className="smp-upgrade-page"
      title={c[tab]}
      extra={
        context?.serverId ? (
          <button
            className="link"
            onClick={() => {
              props.pageState.update({ screen: 'detail', serverId: context.serverId! })
              props.openConsole?.('servers')
            }}
          >
            {c.back}
          </button>
        ) : undefined
      }
    >
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="banner ok">{notice}</p>}
      {tab === 'suggestions' && (
        <>
          <div className="smp-upgrade-toolbar">
            <p className="muted">{c.detectHint}</p>
            <div className="row">
              <button
                className="secondary"
                disabled={busy || !filteredServers.length}
                onClick={() =>
                  void run(async () => {
                    await api('/console-api/server-changes/detect', {
                      method: 'POST',
                      body: JSON.stringify({
                        server_ids: selected.length ? selected : filteredServers.map((s) => s.id),
                      }),
                    })
                    setNotice(c.detectQueued)
                  })
                }
              >
                {selected.length ? c.detect : c.detectAll}
              </button>
              {context?.serverId && (
                <button
                  className="link"
                  onClick={() => props.pageState.update({ upgradeContext: undefined })}
                >
                  {c.all}
                </button>
              )}
            </div>
          </div>
          <div className="smp-upgrade-filter-region">
            <div className="smp-upgrade-fields smp-upgrade-filters" role="group" aria-label={c.filters}>
              <label className="field">
                {c.search}
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value)
                    setPage(1)
                  }}
                />
              </label>
              <label className="field">
                {c.group}
                <select
                  value={group}
                  onChange={(e) => {
                    setGroup(e.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">{c.all}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {groupName(active, g)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {c.type}
                <select
                  value={type}
                  onChange={(e) => {
                    setType(e.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">{c.all}</option>
                  {[...new Set(inventory.map((s) => s.type_key))].map((key) => (
                    <option key={key} value={key}>
                      {localized(inventory.find((s) => s.type_key === key)!.type_name_i18n, active)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {c.software}
                <select
                  value={software}
                  onChange={(e) => {
                    setSoftware(e.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">{c.all}</option>
                  {[
                    ...new Set(
                      inventory.flatMap((s) => (s.required_software ?? []).map((item) => item.software_key)),
                    ),
                  ].map((key) => (
                    <option key={key} value={key}>
                      {softwareName(key)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {c.current}
                <input
                  value={current}
                  onChange={(e) => {
                    setCurrent(e.target.value)
                    setPage(1)
                  }}
                />
              </label>
              <label className="field">
                {c.target}
                <input
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value)
                    setPage(1)
                  }}
                />
              </label>
              <label className="field">
                {c.connection}
                <select
                  value={connection}
                  onChange={(e) => {
                    setConnection(e.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">{c.all}</option>
                  {['online', 'offline', 'unknown'].map((s) => (
                    <option key={s} value={s}>
                      {enumLabel(c, s)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {c.decision}
                <select
                  value={decision}
                  onChange={(e) => {
                    setDecision(e.target.value)
                    setPage(1)
                  }}
                >
                  {['pending', 'all', 'deferred', 'rejected', 'scheduled', 'detection_failed'].map((s) => (
                    <option key={s} value={s}>
                      {enumLabel(c, s)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
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
            <table>
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
                          onClick={() =>
                            void run(async () => {
                              await api(
                                `/console-api/server-changes/suggestions/${s.id}/${s.decision === 'rejected' ? 'restore' : 'reject'}`,
                                { method: 'POST', body: '{}' },
                              )
                            })
                          }
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
          {selected.length > 0 && (
            <section className="smp-plan-confirm">
              <h3>{c.selectSoftware}</h3>
              <div className="row">
                {[...new Set([...keys, ...batchSoftware])].map((key) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={batchSoftware.includes(key)}
                      onChange={(e) =>
                        setBatchSoftware((old) =>
                          e.target.checked ? [...old, key] : old.filter((s) => s !== key),
                        )
                      }
                    />
                    {softwareName(key)}
                  </label>
                ))}
              </div>
              {batchSoftware.map((key) => (
                <label className="field" key={key}>
                  {softwareName(key)} · {c.chooseVersion}
                  <select
                    value={chosen[key] ?? ''}
                    onChange={(e) => setChosen((old) => ({ ...old, [key]: e.target.value }))}
                  >
                    <option value="">{c.chooseVersion}</option>
                    {(versions[key] ?? []).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                  {!versions[key]?.length && <span className="banner error">{c.noCommon}</span>}
                </label>
              ))}
              <button
                className="primary"
                disabled={busy || !batchSoftware.length || batchSoftware.some((key) => !chosen[key])}
                onClick={() =>
                  void run(async () => {
                    const result = await api<{ id: string }>('/console-api/server-changes/plans', {
                      method: 'POST',
                      body: JSON.stringify({
                        kind: 'upgrade',
                        server_ids: selected,
                        versions: Object.fromEntries(batchSoftware.map((key) => [key, chosen[key]])),
                      }),
                    })
                    setPlan(result.id)
                  })
                }
              >
                {c.createPlan}
              </button>
            </section>
          )}
          <DetectionResults
            active={active}
            checks={(data?.checks ?? []).filter(
              (check) => !context?.serverId || check.server_id === context.serverId,
            )}
            loading={!data}
            failuresOnly={decision === 'detection_failed'}
            softwareName={softwareName}
          />
          {defer && (
            <div className="smp-upgrade-modal" role="dialog" aria-modal="true" aria-label={c.defer}>
              <div className="smp-upgrade-dialog">
                <h2>{c.defer}</h2>
                <p>{c.remindHint}</p>
                <label className="field">
                  {c.remindAt}
                  <input
                    type="datetime-local"
                    value={remindAt}
                    onChange={(e) => setRemindAt(e.target.value)}
                  />
                </label>
                <div className="row">
                  <button
                    className="primary"
                    disabled={busy || !remindAt}
                    onClick={() =>
                      void run(async () => {
                        await api(`/console-api/server-changes/suggestions/${defer}/defer`, {
                          method: 'POST',
                          body: JSON.stringify({ until: new Date(remindAt).toISOString() }),
                        })
                        setDefer('')
                      })
                    }
                  >
                    {c.defer}
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      void run(async () => {
                        await api(`/console-api/server-changes/suggestions/${defer}/defer`, {
                          method: 'POST',
                          body: '{"until":null}',
                        })
                        setDefer('')
                      })
                    }
                  >
                    {c.remindNow}
                  </button>
                  <button className="link" onClick={() => setDefer('')}>
                    {c.close}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {tab === 'plans' && (
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
      )}
      {tab === 'records' && (
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
      )}
    </Panel>
  )
}
function Pager(props: { active: string; page: number; total: number; onPage: (page: number) => void }) {
  const c = serverCopy(props.active).upgrades
  return (
    <footer className="smp-server-pager">
      <span>{format(c.page, { page: props.page, count: props.total })}</span>
      <div className="row">
        <button className="secondary" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>
          {c.previous}
        </button>
        <button
          className="secondary"
          disabled={props.page * 20 >= props.total}
          onClick={() => props.onPage(props.page + 1)}
        >
          {c.next}
        </button>
      </div>
    </footer>
  )
}
