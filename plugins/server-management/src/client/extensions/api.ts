import { api } from '../shared/api.ts'

export interface ExtensionSettingsValue {
  value: unknown
  revision: string
}

export interface ExtensionApi {
  data(serverId: string, key: string, params?: Readonly<Record<string, string>>): Promise<unknown>
  settings(serverId: string, key: string): Promise<ExtensionSettingsValue>
  saveSettings(serverId: string, key: string, value: unknown, revision: string): Promise<ExtensionSettingsValue>
}

export const extensionApi: ExtensionApi = {
  async data(serverId, key, params = {}) {
    const search = new URLSearchParams({ key, ...params })
    const result = await api<{ value: unknown }>(
      `/console-api/servers/${encodeURIComponent(serverId)}/extension-data?${search.toString()}`,
    )
    return result.value
  },
  async settings(serverId, key) {
    const search = new URLSearchParams({ key })
    return api<ExtensionSettingsValue>(
      `/console-api/servers/${encodeURIComponent(serverId)}/extension-settings?${search.toString()}`,
    )
  },
  async saveSettings(serverId, key, value, revision) {
    const search = new URLSearchParams({ key })
    return api<ExtensionSettingsValue>(
      `/console-api/servers/${encodeURIComponent(serverId)}/extension-settings?${search.toString()}`,
      { method: 'PUT', body: JSON.stringify({ value, revision }) },
    )
  },
}
