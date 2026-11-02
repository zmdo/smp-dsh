interface Groups {
  register(input: {
    id: string
    label: string
    labelI18n?: { zh?: string; en?: string }
    directory: string
    order?: number
  }): Promise<void>
}

interface HostCtx {
  workspaceGroups: Groups
}

export const inject = ['workspaceGroups']

/** Register the evolution-development workspace group from a plugin, not from UI state. */
export async function apply(ctx: HostCtx): Promise<void> {
  await ctx.workspaceGroups.register({
    id: 'evolution-dev',
    label: '演进开发',
    labelI18n: { zh: '演进开发', en: 'Evolution development' },
    directory: '.smp/evolution-dev',
    order: 30,
  })
}
