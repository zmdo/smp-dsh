import { useState } from 'react'
import type { ServerDto } from '../../../shared/dto/servers.ts'
import type { ServerError } from '../../../shared/errors.ts'
import { displayError, format, groupName as localizedGroupName, serverCopy } from '../../../shared/i18n.ts'
import { api, requestError } from '../../shared/api.ts'
import { AuthenticationFields } from '../form/AuthenticationFields.tsx'
import { SystemFields } from '../form/SystemFields.tsx'
import type { ServerFormModel } from '../form/useServerForm.ts'
import { MoveServer } from '../detail/MoveServer.tsx'

export function BasicSettings(props: {
  active: string
  form: ServerFormModel
  server: ServerDto
  onDeleted: () => void
}) {
  const { active, form } = props
  const copy = serverCopy(active).ui
  const [moving, setMoving] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<ServerError | null>(null)

  async function remove(): Promise<void> {
    setDeleting(true)
    setDeleteError(null)
    try {
      await api(`/console-api/servers/${props.server.id}`, { method: 'DELETE' })
      setConfirmingRemove(false)
      props.onDeleted()
    } catch (cause) {
      setDeleteError(requestError(cause))
    } finally {
      setDeleting(false)
    }
  }

  const error = form.error ?? deleteError
  return (
    <form
      className="panel-form smp-settings-form"
      onSubmit={(event) => {
        event.preventDefault()
        void form.saveBasic()
      }}
    >
      {error !== null && (
        <p className="banner error" role="alert">
          {displayError(active, error)}
        </p>
      )}
      <div className="triple">
        <label className="field">
          {copy.name}
          <input
            value={form.name}
            onChange={(event) => {
              form.setName(event.target.value)
            }}
          />
        </label>
        <label className="field">
          {copy.group}
          <select value={form.groupId} disabled onChange={() => {}}>
            <option value="">{copy.ungrouped}</option>
            {form.groups.map((group) => (
              <option key={group.id} value={group.id} disabled={!group.available && group.id !== form.original?.groupId}>
                {localizedGroupName(active, group)}
                {group.available ? '' : ` (${copy.pluginUnavailable})`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {copy.region}
          <input
            value={form.region}
            onChange={(event) => {
              form.setRegion(event.target.value)
            }}
            placeholder={copy.autoRegion}
          />
        </label>
      </div>
      <AuthenticationFields form={form} />
      <SystemFields form={form} editing showPolicies={false} />
      <div className="row smp-settings-actions">
        <button className="primary" type="submit" disabled={form.busy || form.pending !== null || !form.canSaveBasic}>
          {form.busy ? copy.saving : copy.save}
        </button>
        {form.basicDirty && <span className="muted">{copy.unsavedChanges}</span>}
        <button className="secondary" type="button" onClick={() => setMoving(true)}>
          {serverCopy(active).upgrades.moveServer}
        </button>
        <button className="danger-button" type="button" disabled={deleting || form.busy} onClick={() => setConfirmingRemove(true)}>
          {copy.removeServer}
        </button>
      </div>
      {moving && <MoveServer active={active} server={props.server} onClose={() => setMoving(false)} />}
      {confirmingRemove && (
        <div className="smp-upgrade-modal" role="dialog" aria-modal="true" aria-label={copy.removeServer}>
          <div className="smp-upgrade-dialog smp-confirm-dialog">
            <h2>{copy.removeServer}</h2>
            <p>{format(copy.removeServerHint, { name: props.server.name })}</p>
            {deleteError !== null && <p className="banner error" role="alert">{displayError(active, deleteError)}</p>}
            <div className="row smp-upgrade-footer">
              <button className="secondary" type="button" disabled={deleting} onClick={() => setConfirmingRemove(false)}>
                {copy.cancel}
              </button>
              <button className="danger-button" type="button" disabled={deleting} onClick={() => { void remove() }}>
                {copy.remove}
              </button>
            </div>
          </div>
        </div>
      )}
    </form>
  )
}
