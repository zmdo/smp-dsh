const owner = '@smp/console-server-containers'
const PANEL = 'server-management.detail.panel'
const SETTINGS = 'server-management.settings.section'

interface SlotCtx {
  slots: {
    inject(name: string, register: () => () => void): void
    register(options: object, component: unknown): () => void
  }
}

function ContainersPanel(props: { server?: { name?: string } }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>容器</h2></div>
      <div className="panel-body">
        <p>{props.server?.name ?? ''}</p>
        <p>容器面板由容器插件提供。</p>
      </div>
    </section>
  )
}

function ContainerSettings() {
  return <p className="muted">容器采集设置由容器插件提供。</p>
}

export const inject = ['slots']

export function apply(ctx: SlotCtx): void {
  ctx.slots.inject(PANEL, () => ctx.slots.register({ name: PANEL, key: `${owner}/containers` }, ContainersPanel))
  ctx.slots.inject(SETTINGS, () => ctx.slots.register({ name: SETTINGS, key: `${owner}/container-settings` }, ContainerSettings))
}
