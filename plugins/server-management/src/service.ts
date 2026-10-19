import { Service, type Context } from '@deepseek-ai/cordis'
import type { SystemGroupDefinition } from './definitions.ts'
import type { DefinitionRegistry } from './registry.ts'

/** Cordis traces ctx to the contributor, so its registration is removed with that plugin. */
export class ServerManagement {
  protected readonly ctx: Context
  private readonly definitions: DefinitionRegistry

  constructor(ctx: Context, definitions: DefinitionRegistry) {
    this.ctx = ctx
    this.definitions = definitions
    Object.defineProperty(this, Service.tracker, { value: { property: 'ctx' } })
  }

  registerGroup(definition: SystemGroupDefinition) {
    return this.ctx.effect(() => this.definitions.registerGroup(structuredClone(definition)), 'serverManagement.registerGroup()')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    serverManagement: ServerManagement
  }
}
