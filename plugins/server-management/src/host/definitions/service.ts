import { Service, type Context } from '@deepseek-ai/cordis'
import type { DefinitionBundle, Registration } from '../../shared/contracts/definitions.ts'
import { ServerError } from '../../shared/errors.ts'
import { type DefinitionRegistry } from './registry.ts'

export class ServerManagement {
  protected readonly ctx: Context
  private readonly definitions: DefinitionRegistry
  constructor(ctx: Context, definitions: DefinitionRegistry) {
    this.ctx = ctx
    this.definitions = definitions
    Object.defineProperty(this, Service.tracker, { value: { property: 'ctx' } })
  }
  registerDefinitions(definition: DefinitionBundle): Registration {
    const fiber = this.ctx.fiber
    const entry = (fiber as typeof fiber & { entry?: { options: { name?: string } } }).entry
    const owner = entry?.options.name ?? fiber.runtime?.name
    if (owner !== definition.owner) throw new ServerError('definition_owner')
    let registration: Registration
    const dispose = this.ctx.effect(() => {
      registration = this.definitions.registerDefinitions(definition, fiber)
      return async () => {
        await registration.dispose()
      }
    }, 'serverManagement.registerDefinitions()')
    return {
      ready: registration!.ready,
      dispose: async () => {
        await dispose()
      },
    }
  }
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    serverManagement: ServerManagement
  }
}
