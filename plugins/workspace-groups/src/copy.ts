/** The extension only supplies the group switch; native controls keep dsh's locale. */
export function groupCopy(active: string) {
  return active === 'zh'
    ? { group: '工作区组', unassigned: '未归属' }
    : { group: 'Workspace group', unassigned: 'Unassigned' }
}
