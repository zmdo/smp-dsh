import { useEffect, useState } from 'react'
import type { MetricHistoryDto, MetricRange } from '../../../shared/dto/metrics.ts'
import { displayError, serverCopy } from '../../../shared/i18n.ts'
import { api, requestError } from '../../shared/api.ts'
import type { ServerError } from '../../../shared/errors.ts'

const RANGES: MetricRange[] = ['1h', '6h', '24h', '7d', '30d']
const COLORS = { cpu: 'var(--primary)', memory: 'var(--green)', disk: 'var(--warn)' }

export function ResourceHistory(props: { active: string; serverId: string }) {
  const copy = serverCopy(props.active).ui
  const [range, setRange] = useState<MetricRange>('24h')
  const [data, setData] = useState<MetricHistoryDto>()
  const [error, setError] = useState<ServerError | null>(null)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api<MetricHistoryDto>(`/console-api/servers/${props.serverId}/metrics?range=${range}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) {
          setData(next)
          setHover(null)
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(requestError(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [props.serverId, range, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setRefresh((current) => current + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const points = data?.points ?? []
  const selected = hover === null ? points.at(-1) : points[hover]
  return (
    <section className="smp-resource-history smp-card" aria-label={copy.resourceHistory}>
      <header>
        <h2>{copy.resourceHistory}</h2>
        <div className="smp-resource-ranges" role="tablist" aria-label={copy.resourceHistory}>
          {RANGES.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={range === value}
              className={range === value ? 'is-on' : ''}
              onClick={() => setRange(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </header>
      {error !== null ? (
        <p className="banner error">{displayError(props.active, error)}</p>
      ) : loading && points.length === 0 ? (
        <p className="muted">{copy.loading}</p>
      ) : points.length === 0 ? (
        <p className="muted">{copy.resourceHistoryEmpty}</p>
      ) : (
        <>
          <div className="smp-resource-readout">
            <span className="is-cpu">CPU {selected === undefined ? '—' : `${selected.cpu}%`}</span>
            <span className="is-memory">{copy.memory} {selected === undefined ? '—' : `${selected.memory}%`}</span>
            <span className="is-disk">{copy.disk} {selected === undefined ? '—' : `${selected.disk}%`}</span>
            {selected !== undefined && <time>{formatPoint(selected.t, range)}</time>}
          </div>
          <LineChart points={points} range={range} hover={hover} onHover={setHover} />
          <div className="smp-resource-legend">
            <span><i style={{ background: COLORS.cpu }} />CPU</span>
            <span><i style={{ background: COLORS.memory }} />{copy.memory}</span>
            <span><i style={{ background: COLORS.disk }} />{copy.disk}</span>
          </div>
        </>
      )}
    </section>
  )
}

function LineChart(props: {
  points: MetricHistoryDto['points']
  range: MetricRange
  hover: number | null
  onHover(index: number | null): void
}) {
  const width = 720
  const height = 190
  const left = 38
  const right = 12
  const top = 12
  const bottom = 24
  const innerWidth = width - left - right
  const innerHeight = height - top - bottom
  const x = (index: number): number =>
    props.points.length <= 1 ? left : left + (index / (props.points.length - 1)) * innerWidth
  const y = (value: number): number => top + (1 - Math.max(0, Math.min(100, value)) / 100) * innerHeight
  const path = (key: 'cpu' | 'memory' | 'disk'): string =>
    props.points
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`)
      .join(' ')
  const active = props.hover === null ? undefined : props.points[props.hover]
  return (
    <div className="smp-resource-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="resource history"
        onMouseLeave={() => props.onHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          const position = ((event.clientX - box.left) / box.width) * width
          const ratio = Math.max(0, Math.min(1, (position - left) / innerWidth))
          props.onHover(Math.round(ratio * Math.max(0, props.points.length - 1)))
        }}
      >
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} className="smp-chart-grid" />
            <text x={left - 8} y={y(tick) + 3} textAnchor="end" className="smp-chart-label">{tick}%</text>
          </g>
        ))}
        <path d={path('cpu')} className="smp-chart-line is-cpu" />
        <path d={path('memory')} className="smp-chart-line is-memory" />
        <path d={path('disk')} className="smp-chart-line is-disk" />
        {props.points.length <= 2 && props.points.map((point, index) => (
          <g key={point.t}>
            {(['cpu', 'memory', 'disk'] as const).map((key) => (
              <circle key={key} cx={x(index)} cy={y(point[key])} r="3" className={`smp-chart-dot is-${key}`} />
            ))}
          </g>
        ))}
        {active !== undefined && props.hover !== null && (
          <>
            <line x1={x(props.hover)} x2={x(props.hover)} y1={top} y2={height - bottom} className="smp-chart-cursor" />
            {(['cpu', 'memory', 'disk'] as const).map((key) => (
              <circle key={key} cx={x(props.hover!)} cy={y(active[key])} r="3" className={`smp-chart-dot is-${key}`} />
            ))}
          </>
        )}
        <text x={left} y={height - 4} className="smp-chart-label">{formatPoint(props.points[0]!.t, props.range)}</text>
        <text x={width - right} y={height - 4} textAnchor="end" className="smp-chart-label">
          {formatPoint(props.points.at(-1)!.t, props.range)}
        </text>
      </svg>
    </div>
  )
}

function formatPoint(value: string, range: MetricRange): string {
  const date = new Date(value)
  if (range === '7d' || range === '30d')
    return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
