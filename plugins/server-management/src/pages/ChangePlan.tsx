import { zonedTime } from '../schedule-time.ts'
import { useEffect, useState } from 'react'
import { serverCopy, formatDate, enumLabel } from '../i18n.ts'
import { localized } from '../definitions.ts'
import type { ChangeRequest } from '../changes.ts'
import type { PreparedPlan } from '../plans.ts'
import { api, requestError, displayError, displayJobError } from './api.ts'
interface PlanView {
  id: string
  kind: string
  state: string
  revision: string
  review_digest: string
  request_snapshot: ChangeRequest
  window_start: string | null
  window_end: string | null
  targets: {
    id: string
    server_id: string
    server_snapshot: { name: string; host: string }
    state: string
    preflight_state: string
    preflight_error: unknown
    target_snapshot: PreparedPlan
    result: unknown
  }[]
}
const localDate = (value: Date) =>
  new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
export function ChangePlan(props: {
  active: string
  id: string
  onClose: () => void
  onNewPlan?: (id: string) => void
}) {
  const { active } = props,
    c = serverCopy(active).upgrades
  const [plan, setPlan] = useState<PlanView>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0)
  const [immediate, setImmediate] = useState(true),
    [start, setStart] = useState(localDate(new Date())),
    [end, setEnd] = useState(localDate(new Date(Date.now() + 3600000)))
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
    [concurrency, setConcurrency] = useState(1)
  const [replacement, setReplacement] = useState(false),
    [major, setMajor] = useState(false),
    [service, setService] = useState(false)
  useEffect(() => {
    let stopped = false
    const load = () => {
      void api<PlanView>(`/console-api/server-changes/plans/${props.id}`)
        .then((p) => {
          if (!stopped) setPlan(p)
        })
        .catch((cause) => {
          if (!stopped) setError(displayError(active, requestError(cause)))
        })
    }
    load()
    const timer = setInterval(load, 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [props.id, tick, active])
  async function act(action: string) {
    setBusy(true)
    setError('')
    try {
      const body =
        action === 'confirm'
          ? {
              revision: plan!.revision,
              review_digest: plan!.review_digest,
              start: immediate ? new Date().toISOString() : zonedTime(start, timezone),
              end: zonedTime(end, timezone),
              timezone,
              concurrency,
              ack_replacement: replacement,
              ack_major: major,
              ack_service_impact: service,
            }
          : {}
      const result = await api<{ id: string }>(`/console-api/server-changes/plans/${props.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (action === 'retry') props.onNewPlan?.(result.id)
      setTick((v) => v + 1)
    } catch (cause) {
      setError(displayError(active, requestError(cause)))
    } finally {
      setBusy(false)
    }
  }
  const changes = plan?.targets.flatMap((t) => t.target_snapshot.changes ?? []) ?? [],
    mutations = changes.filter((ch) => ['install', 'upgrade', 'replace'].includes(ch.action))
  const needsReplacement = mutations.some((ch) => ch.action === 'replace'),
    needsMajor = plan?.targets.some((t) => t.target_snapshot.risks?.major) ?? false,
    needsService = mutations.some((ch) => ch.effects.length)
  return (
    <section className="smp-change-plan">
      <div className="row">
        <h2>
          {c.planId} {props.id.slice(0, 8)}
        </h2>
        <button className="link" onClick={props.onClose}>
          {c.close}
        </button>
      </div>
      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}
      {plan && (
        <>
          <p>
            <b>
              {enumLabel(c, plan.kind)} · {enumLabel(c, plan.state)} · {c.running} (
              {plan.targets.filter((t) => t.state === 'running').length})
            </b>
          </p>
          <p className="muted">{c.executionHint}</p>
          {plan.targets.map((t) => (
            <section className="smp-plan-target" key={t.id}>
              <h3>
                {t.server_snapshot.name} <small>{t.server_snapshot.host}</small>
              </h3>
              <p>
                {enumLabel(c, t.preflight_state)} · {enumLabel(c, t.state)}
              </p>
              {!!t.preflight_error && (
                <p className="banner error">
                  {displayJobError(
                    active,
                    (t.preflight_error as { error?: unknown }).error ?? t.preflight_error,
                  )}
                </p>
              )}
              {(t.target_snapshot.changes ?? []).length ? (
                <div className="smp-upgrade-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{c.software}</th>
                        <th>{c.current}</th>
                        <th>{c.target}</th>
                        <th>{c.status}</th>
                        <th>{c.effects}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.target_snapshot.changes.map((ch) => (
                        <tr key={ch.software}>
                          <td>
                            {t.target_snapshot.targetType?.software.find(
                              (s) => s.software_key === ch.software,
                            )?.name_i18n
                              ? localized(
                                  t.target_snapshot.targetType.software.find(
                                    (s) => s.software_key === ch.software,
                                  )!.name_i18n,
                                  active,
                                )
                              : ch.software}
                          </td>
                          <td>{ch.before.state === 'installed' ? ch.before.version : '—'}</td>
                          <td>
                            {ch.target?.version ?? '—'}
                            <small className="mono">{ch.target?.targetIdentity}</small>
                          </td>
                          <td>{enumLabel(c, ch.action)}</td>
                          <td>
                            {ch.effects.map((effect, i) => (
                              <p key={i}>{localized(effect.description, active)}</p>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : t.preflight_state === 'ready' ? (
                <p>{c.noMutation}</p>
              ) : null}
              {(t.target_snapshot.changes ?? [])
                .filter((ch) => ch.target)
                .map((ch) => (
                  <details key={ch.software}>
                    <summary>
                      {ch.software} · {c.dependencies}
                    </summary>
                    <pre>{JSON.stringify(ch.payload, null, 2)}</pre>
                  </details>
                ))}
              {!!t.result && (
                <details>
                  <summary>{c.remoteChanges}</summary>
                  <pre>{JSON.stringify(t.result, null, 2)}</pre>
                </details>
              )}
            </section>
          ))}
          {plan.state === 'awaiting_confirmation' && (
            <div className="smp-plan-confirm">
              <p className="banner ok">{c.preflightReady}</p>
              <p>{c.confirmHint}</p>
              <label>
                <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} />
                {c.immediate}
              </label>
              <div className="smp-upgrade-fields">
                <label className="field">
                  {c.start}
                  <input
                    type="datetime-local"
                    disabled={immediate}
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </label>
                <label className="field">
                  {c.end}
                  <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
                </label>
                <label className="field">
                  {c.timezone}
                  <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
                </label>
                <label className="field">
                  {c.concurrency}
                  <input
                    type="number"
                    min="1"
                    max="4"
                    value={concurrency}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                  />
                </label>
              </div>
              {needsReplacement && (
                <label className="smp-upgrade-ack">
                  <input
                    type="checkbox"
                    checked={replacement}
                    onChange={(e) => setReplacement(e.target.checked)}
                  />
                  {c.ackReplacement}
                </label>
              )}
              {needsMajor && (
                <label className="smp-upgrade-ack">
                  <input type="checkbox" checked={major} onChange={(e) => setMajor(e.target.checked)} />
                  {c.ackMajor}
                </label>
              )}
              {needsService && (
                <label className="smp-upgrade-ack">
                  <input type="checkbox" checked={service} onChange={(e) => setService(e.target.checked)} />
                  {c.ackService}
                </label>
              )}
              <button
                type="button"
                className="primary"
                disabled={
                  busy ||
                  (needsReplacement && !replacement) ||
                  (needsMajor && !major) ||
                  (needsService && !service)
                }
                onClick={() => void act('confirm')}
              >
                {c.confirm}
              </button>
            </div>
          )}
          {plan.window_start && (
            <p>
              {formatDate(plan.window_start, active)} – {formatDate(plan.window_end, active)} ·{' '}
              {plan.request_snapshot.execution?.timezone}
            </p>
          )}
          <div className="row">
            {['scheduled', 'running'].includes(plan.state) && (
              <button className="secondary" disabled={busy} onClick={() => void act('pause')}>
                {c.pause}
              </button>
            )}
            {[
              'draft',
              'awaiting_confirmation',
              'scheduled',
              'running',
              'paused',
              'blocked',
              'partial_failure',
            ].includes(plan.state) && (
              <button className="secondary" disabled={busy} onClick={() => void act('cancel')}>
                {c.cancel}
              </button>
            )}
            {['paused', 'blocked', 'partial_failure', 'missed', 'cancelled'].includes(plan.state) && (
              <button
                className="secondary"
                disabled={busy || plan.targets.some((t) => t.state === 'running')}
                onClick={() => void act('retry')}
              >
                {c.retry}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
