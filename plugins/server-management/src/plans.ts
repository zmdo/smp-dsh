import type { Candidate, RecipeRequest, ResolvedSoftwareChange, SoftwareObservation } from './contracts.ts'
import type { Component } from './catalog.ts'
import type { DetectedOs } from './operating-systems.ts'
import { ServerError } from './i18n.ts'
import { canonical, invokeRecipe } from './recipe.ts'
import type { SshSession } from './ssh.ts'
import type { TypeLease } from './registry.ts'

export interface PreparedPlan {
  definitionRevision: string
  os: DetectedOs
  changes: ResolvedSoftwareChange[]
}
export function environment(component: Component, os: DetectedOs) {
  return {
    contractVersion: 2 as const,
    os: { ...os, raw: {} },
    software: component.software_key,
    recipe: component.recipe,
    recipeRevision: component.revision,
    effectiveVersions: component.versions,
  }
}
export async function observe(session: SshSession, component: Component, os: DetectedOs): Promise<SoftwareObservation> {
  try {
    const result = await invokeRecipe(session, component.scripts.detect, {
      ...environment(component, os),
      operation: 'detect',
    })
    if (result.operation !== 'detect') throw new ServerError('recipe_protocol')
    if (result.result.state === 'installed') component.adapter.normalize(result.result.version)
    return result.result
  } catch (cause) {
    return {
      state: 'unknown',
      code: cause instanceof ServerError ? cause.code : 'detection_failed',
      detail: cause instanceof Error ? cause.message : '',
    }
  }
}
export async function preparePlan(session: SshSession, lease: TypeLease, os: DetectedOs): Promise<PreparedPlan> {
  const changes: ResolvedSoftwareChange[] = []
  for (const component of lease.components) {
    const before = await observe(session, component, os)
    if (before.state === 'unknown')
      throw new ServerError('software_detection_unknown', {
        detail: before.detail ?? before.code,
      })
    const base = {
      software: component.software_key,
      recipe: component.recipe,
      recipeRevision: component.revision,
      before,
      dependencies: component.requires.map((id) => lease.components.find((item) => item.id === id)!.software_key),
    }
    if (before.state === 'installed') {
      if (!before.healthy || !component.adapter.contains(component.versions, before.version))
        throw new ServerError('plan_conflict')
      changes.push({ ...base, action: 'keep', effects: [], payload: null })
      continue
    }
    if (
      !component.scripts.listCandidates ||
      !component.scripts.resolve ||
      !component.scripts.execute ||
      !component.scripts.verify ||
      !component.scripts.recover ||
      !component.actions.includes('install')
    )
      throw new ServerError('recipe_unavailable')
    const candidates = await invokeRecipe(session, component.scripts.listCandidates, {
      ...environment(component, os),
      operation: 'list-candidates',
      installed: before,
    })
    if (candidates.operation !== 'list-candidates') throw new ServerError('recipe_protocol')
    const eligible = candidates.candidates
      .filter((item) => item.channel === 'stable' && component.adapter.contains(component.versions, item.version))
      .sort(
        (a, b) => component.adapter.compare(b.version, a.version) || a.targetIdentity.localeCompare(b.targetIdentity),
      )
    const target = eligible[0]
    if (!target) throw new ServerError('recipe_unavailable')
    const resolved = await invokeRecipe(session, component.scripts.resolve, {
      ...environment(component, os),
      operation: 'resolve',
      target,
      installed: before,
    })
    if (
      resolved.operation !== 'resolve' ||
      resolved.change.action !== 'install' ||
      canonical(resolved.change.before) !== canonical(before) ||
      canonical(resolved.change.target) !== canonical(target)
    )
      throw new ServerError('plan_conflict')
    // Only the current type's required closure is covered by the saved install choice.
    if (resolved.change.dependencies.some((key) => !base.dependencies.includes(key)))
      throw new ServerError('plan_conflict')
    changes.push({ ...resolved.change, ...base, action: 'install', target })
  }
  const packages = new Map<string, string>()
  for (const change of changes) {
    const payload = change.payload
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !('packages' in payload) ||
      !Array.isArray(payload.packages)
    )
      continue
    for (const item of payload.packages) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || item.manager !== 'apt') continue
      const key = `${item.manager}/${item.name}/${item.architecture}`
      const snapshot = canonical(item)
      if (packages.has(key) && packages.get(key) !== snapshot) throw new ServerError('plan_conflict')
      packages.set(key, snapshot)
    }
  }
  return { definitionRevision: lease.signature, os, changes }
}
export async function checkPlan(session: SshSession, lease: TypeLease, plan: PreparedPlan): Promise<void> {
  if (lease.signature !== plan.definitionRevision || plan.changes.length !== lease.components.length)
    throw new ServerError('job_definition_changed')
  for (let index = 0; index < plan.changes.length; index++) {
    const change = plan.changes[index]!,
      component = lease.components[index]!
    if (change.software !== component.software_key || change.recipeRevision !== component.revision)
      throw new ServerError('job_definition_changed')
    const actual = await observe(session, component, plan.os)
    if (change.action === 'keep') {
      if (canonical(actual) !== canonical(change.before)) throw new ServerError('plan_conflict')
      continue
    }
    if (change.action !== 'install' || !change.target) throw new ServerError('plan_conflict')
    if (actual.state === 'installed' && actual.healthy && actual.targetIdentity === change.target.targetIdentity)
      continue
    if (canonical(actual) !== canonical(change.before)) throw new ServerError('plan_conflict')
    const candidates = await invokeRecipe(session, component.scripts.listCandidates!, {
      ...environment(component, plan.os),
      operation: 'list-candidates',
      installed: actual,
    })
    if (
      candidates.operation !== 'list-candidates' ||
      !candidates.candidates.some((candidate) => canonical(candidate) === canonical(change.target))
    )
      throw new ServerError('plan_conflict')
    const current = await invokeRecipe(session, component.scripts.resolve!, {
      ...environment(component, plan.os),
      operation: 'resolve',
      target: change.target,
      installed: actual,
    })
    if (
      current.operation !== 'resolve' ||
      canonical(current.change.payload) !== canonical(change.payload) ||
      canonical(current.change.effects) !== canonical(change.effects)
    )
      throw new ServerError('plan_conflict')
  }
}
