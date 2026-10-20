import { Panel } from '@smp/console-kit'
import { useState } from 'react'
import type { ServerDto } from '../../../shared/dto/servers.ts'
import { serverCopy } from '../../../shared/i18n.ts'
import { useServerForm } from '../form/useServerForm.ts'
import { BasicSettings } from './BasicSettings.tsx'
import { PolicySettings } from './PolicySettings.tsx'

export function ServerSettings(props: {
  active: string
  serverId: string
  server: ServerDto
  onSaved: () => void
  onDeleted: () => void
}) {
  const { active, serverId } = props
  const copy = serverCopy(active).ui
  const [section, setSection] = useState<'basic' | 'policies'>('basic')
  const form = useServerForm({
    active,
    editing: true,
    serverId,
    initialGroupId: props.server.group_id ?? '',
    onDone: () => {},
    onCancel: () => {},
    onSaved: props.onSaved,
  })
  const server = form.loadedServer ?? props.server
  return (
    <Panel title={copy.configuration} className="smp-server-settings-panel">
      <nav className="smp-settings-tabs" aria-label={copy.configuration}>
        {(['basic', 'policies'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={section === value}
            className={`smp-settings-tab${section === value ? ' is-on' : ''}`}
            onClick={() => setSection(value)}
          >
            {value === 'basic' ? copy.basicConfig : copy.policiesConfig}
          </button>
        ))}
      </nav>
      <div className="smp-settings-content">
        {section === 'basic' ? (
          <BasicSettings active={active} form={form} server={server} onDeleted={props.onDeleted} />
        ) : (
          <PolicySettings active={active} form={form} />
        )}
      </div>
    </Panel>
  )
}
