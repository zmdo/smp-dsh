import { format, serverCopy } from '../../shared/i18n.ts'

export function Pager(props: {
  active: string
  page: number
  total: number
  onPage: (page: number) => void
  className?: string
}) {
  const c = serverCopy(props.active).upgrades
  return (
    <footer className={`smp-server-pager${props.className ? ` ${props.className}` : ''}`}>
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
