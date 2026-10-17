/** Plugins page text. Anything other than Chinese uses English. */
export function pluginsCopy(active: string) {
  if (active === 'zh') {
    return {
      title: '插件',
      search: '搜索插件',
      empty: '没有全局插件',
      noMatch: '没有匹配的插件',
      loading: '正在读取',
      loadFailed: '插件列表没有读到',
      retry: '重试',
      name: '名称',
      summary: '说明',
      status: '状态',
      enabled: '已启用',
      disabled: '已停用',
      failed: '启动失败',
      preset: '预设中启用',
      pending: '等待依赖',
      loadingPhase: '加载中',
      unloading: '卸载中',
    }
  }
  return {
    title: 'Plugins',
    search: 'Search plugins',
    empty: 'No global plugins',
    noMatch: 'No matching plugins',
    loading: 'Loading',
    loadFailed: 'Could not load plugins',
    retry: 'Retry',
    name: 'Name',
    summary: 'Description',
    status: 'Status',
    enabled: 'Enabled',
    disabled: 'Disabled',
    failed: 'Failed to start',
    preset: 'Enabled by a preset',
    pending: 'Waiting',
    loadingPhase: 'Loading',
    unloading: 'Unloading',
  }
}
