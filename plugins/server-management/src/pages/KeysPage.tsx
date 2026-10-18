import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Panel } from '@smp/console-kit'
import { api } from './api.ts'

interface KeyRow {
  id: string
  name: string
  fingerprint: string
  server_count: number
  created_at: string
}

export function KeysPage() {
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    let stopped = false
    void api<KeyRow[]>('/console-api/ssh-keys').then(rows => {
      if (!stopped) setKeys(rows)
    }).catch((cause: unknown) => {
      if (!stopped) setError(cause instanceof Error ? cause.message : '请求没有完成')
    })
    return () => { stopped = true }
  }, [note])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return keys
    return keys.filter(key => key.name.toLowerCase().includes(needle) || key.fingerprint.toLowerCase().includes(needle))
  }, [keys, query])

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError('')
    try {
      await api('/console-api/ssh-keys', { method: 'POST', body: JSON.stringify({ name, secret }) })
      setName('')
      setSecret('')
      setAdding(false)
      setNote('已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求没有完成')
    }
  }

  async function remove(id: string): Promise<void> {
    setError('')
    try {
      await api(`/console-api/ssh-keys/${id}`, { method: 'DELETE' })
      setKeys(current => current.filter(key => key.id !== id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请求没有完成')
    }
  }

  return (
    <Panel title="服务器密钥" extra={<div className="row"><input className="search" value={query} placeholder="搜索名称或指纹" onChange={event => { setQuery(event.target.value) }} /><button className="primary" type="button" onClick={() => { setAdding(true) }}>添加密钥</button></div>}>
      {error !== '' ? <p className="banner error">{error}</p> : null}
      {adding ? (
        <form className="panel-form" onSubmit={event => { void create(event) }}>
          <label className="field">名称<input value={name} onChange={event => { setName(event.target.value) }} /></label>
          <label className="field">私钥<textarea value={secret} onChange={event => { setSecret(event.target.value) }} placeholder="粘贴 PEM" /></label>
          <div className="row"><button className="primary" type="submit">保存</button><button className="link" type="button" onClick={() => { setAdding(false) }}>取消</button></div>
        </form>
      ) : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>名称</th><th>指纹</th><th>服务器</th><th>创建时间</th><th /></tr></thead>
          <tbody>
            {shown.length === 0 ? <tr><td colSpan={5} className="empty">还没有密钥</td></tr> : shown.map(key => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td className="mono">{key.fingerprint}</td>
                <td>{key.server_count}</td>
                <td>{new Date(key.created_at).toLocaleString()}</td>
                <td>{key.server_count > 0 ? null : <button className="link danger" type="button" onClick={() => { void remove(key.id) }}>删除</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
