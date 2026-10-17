/** Archive page text. Anything other than Chinese uses English. */
export function archiveCopy(active: string) {
  if (active === 'zh') {
    return {
      title: '会话列表',
      searchBy: '搜索方式',
      byTitle: '标题',
      byId: '会话编号',
      search: '搜索',
      name: '标题',
      updated: '更新时间',
      state: '状态',
      actions: '操作',
      archived: '已归档',
      active: '使用中',
      open: '打开',
      restore: '恢复',
      remove: '删除',
      confirm: '确认删除',
      cancel: '取消',
      loading: '正在读取',
      empty: '没有会话',
      none: '没有符合的会话',
      restoreFailed: '没有恢复',
      removeFailed: '没有删掉',
      removed: '已删除',
    }
  }
  return {
    title: 'Sessions',
    searchBy: 'Search by',
    byTitle: 'Title',
    byId: 'Session id',
    search: 'Search',
    name: 'Title',
    updated: 'Updated',
    state: 'Status',
    actions: 'Actions',
    archived: 'Archived',
    active: 'Active',
    open: 'Open',
    restore: 'Restore',
    remove: 'Delete',
    confirm: 'Confirm delete',
    cancel: 'Cancel',
    loading: 'Loading',
    empty: 'No sessions',
    none: 'No matching sessions',
    restoreFailed: 'Not restored',
    removeFailed: 'Not deleted',
    removed: 'Deleted',
  }
}

export function archiveTabLabel(active: string): string {
  return active === 'zh' ? '档案' : 'Archive'
}
