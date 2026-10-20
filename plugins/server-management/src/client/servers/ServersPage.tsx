import { useCallback, useSyncExternalStore } from 'react'
import { type LocaleFace } from '../../shared/i18n.ts'
import { useActiveLocale } from '../shared/locale.ts'
import type {
  ServerListView as ListView,
  ServerPageSnapshot,
  ServerPageState,
} from '../shared/server-page-state.ts'
import { ServerDetail } from './detail/ServerDetail.tsx'
import { ServerForm } from './form/ServerForm.tsx'
import { ServerList } from './list/ServerList.tsx'
import { ServerTerminal } from './terminal/ServerTerminal.tsx'
export function ServersPage(props: {
  locale: LocaleFace
  pageState: ServerPageState
  openConsole?: (key: string) => void
}) {
  const active = useActiveLocale(props.locale)
  const { screen, serverId, editing, listView } = useSyncExternalStore(
    props.pageState.subscribe,
    props.pageState.getSnapshot,
  )
  const setScreen = (screen: ServerPageSnapshot['screen']) => props.pageState.update({ screen })
  const setServerId = (serverId: string) => props.pageState.update({ serverId })
  const setEditing = (editing: boolean) => props.pageState.update({ editing })
  const setListView = useCallback(
    (listView: ListView) => props.pageState.update({ listView }),
    [props.pageState],
  )
  if (screen === 'form') {
    return (
      <ServerForm
        active={active}
        editing={editing}
        serverId={serverId}
        initialGroupId={listView.groupId ?? ''}
        onDone={(id) => {
          setServerId(id)
          setScreen(id === '' ? 'list' : 'detail')
        }}
        onCancel={() => {
          setScreen(serverId === '' ? 'list' : 'detail')
        }}
      />
    )
  }
  if (screen === 'detail')
    return (
      <ServerDetail
        active={active}
        id={serverId}
        onUpgrades={() => {
          props.pageState.update({
            upgradeContext: { serverId },
            upgradeView: { tab: 'suggestions', page: 1, planId: '' },
          })
          props.openConsole?.('server-upgrades')
        }}
        onEdit={() => {
          setEditing(true)
          setScreen('form')
        }}
        onTerminal={() => {
          setScreen('terminal')
        }}
        onBack={() => {
          setScreen('list')
        }}
      />
    )
  if (screen === 'terminal')
    return (
      <ServerTerminal
        active={active}
        id={serverId}
        onBack={() => {
          setScreen('detail')
        }}
      />
    )
  return (
    <ServerList
      active={active}
      view={listView}
      onView={setListView}
      onUpgrades={() => {
        props.pageState.update({
          upgradeContext: { groupId: listView.groupId || undefined },
          upgradeView: { tab: 'suggestions', page: 1, planId: '' },
        })
        props.openConsole?.('server-upgrades')
      }}
      onOpen={(id) => {
        setServerId(id)
        setEditing(false)
        setScreen('detail')
      }}
      onCreate={() => {
        setServerId('')
        setEditing(false)
        setScreen('form')
      }}
    />
  )
}
