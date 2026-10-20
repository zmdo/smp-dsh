import type { UpgradeSuggestionsModel } from './useUpgradeSuggestions.ts'

export function DeferUpgrade(props: { model: UpgradeSuggestionsModel }) {
  const { busy, c, commands, defer, remindAt, setDefer, setRemindAt } = props.model
  return (
    <>
      {defer && (
        <div className="smp-upgrade-modal" role="dialog" aria-modal="true" aria-label={c.defer}>
          <div className="smp-upgrade-dialog">
            <h2>{c.defer}</h2>
            <p>{c.remindHint}</p>
            <label className="field">
              {c.remindAt}
              <input type="datetime-local" value={remindAt} onChange={(e) => setRemindAt(e.target.value)} />
            </label>
            <div className="row">
              <button className="primary" disabled={busy || !remindAt} onClick={() => void commands.defer()}>
                {c.defer}
              </button>
              <button className="secondary" onClick={() => void commands.remindNow()}>
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
  )
}
