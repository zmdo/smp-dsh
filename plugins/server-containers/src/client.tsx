import { useEffect, useState } from 'react'
import { serverCopy } from '../../server-management/src/shared/i18n.ts'
import type { ServerDto } from '../../server-management/src/shared/dto/servers.ts'

const owner = '@smp/console-server-containers'
const PANEL = 'server-management.detail.panel'
const SETTINGS = 'server-management.settings.section'

interface SlotCtx {
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: object, component: unknown): () => void
  }
}
interface OwnerProps {
  server: ServerDto
  active: string
  settings?: { value: unknown; onChange: (value: unknown) => void }
  api?: { data(serverId: string, key: string): Promise<unknown> }
}

function ContainersPanel(props: OwnerProps) {
  const copy = serverCopy(props.active).ui
  const server = props.server
  const [containers, setContainers] = useState<{ container_id: string; name: string; image: string; status: string; ports: string }[]>([])
  useEffect(() => {
    let stopped = false
    void props.api?.data(server.id, `${owner}/container-list`).then((value) => {
      if (!stopped) setContainers(((value as { rows?: typeof containers }).rows ?? []) as typeof containers)
    })
    return () => { stopped = true }
  }, [props.api, server.id])
  return (
    <section className="panel">
      <div className="panel-head"><h2>{copy.containers}</h2></div>
      <div className="panel-body">
        {containers.length === 0 ? (
          <p className="empty">{copy.noContainers}</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead><tr><th>{copy.name}</th><th>{copy.image}</th><th>{copy.status}</th><th>{copy.ports}</th></tr></thead>
              <tbody>
                {containers.map((item) => (
                  <tr key={item.container_id}>
                    <td>{item.name}</td><td>{item.image}</td><td>{item.status}</td><td>{item.ports}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

function ContainerSettings(props: OwnerProps) {
  const value = (props.settings?.value ?? {}) as { collect?: boolean }
  return (
    <label className="smp-server-auto-install">
      <input
        type="checkbox"
        checked={value.collect !== false}
        onChange={(event) => props.settings?.onChange({ collect: event.target.checked })}
      />{' '}
      采集容器清单
    </label>
  )
}

export const inject = ['slots']

export function apply(ctx: SlotCtx): void {
  ctx.slots.inject(PANEL, () => ctx.slots.register({ name: PANEL, key: `${owner}/containers` }, ContainersPanel))
  ctx.slots.inject(SETTINGS, () => ctx.slots.register({ name: SETTINGS, key: `${owner}/container-settings` }, ContainerSettings))
}
