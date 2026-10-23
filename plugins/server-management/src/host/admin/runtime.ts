import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TEXT_OUTPUT } from '../harness/schema.ts'
import { harnessTrace } from '../harness/trace.ts'
import type { ApprovalRequester } from '../harness/exec.ts'
import { executeAdmin, ADMIN_ACTIONS, type AdminTool } from './service.ts'
import { AdminError, object, type AdminDeps } from './model.ts'
import { scheduledRetention } from './retention.ts'
export class AdminRuntime {
  private controller = new AbortController()
  private pending = new Set<Promise<unknown>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private deps: AdminDeps
  constructor(deps: AdminDeps) {
    this.deps = deps
  }
  run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.controller.signal.aborted) return Promise.reject(new AdminError('cancelled'))
    const promise = work(this.controller.signal)
    this.pending.add(promise)
    // The original promise carries failures to the caller; this observer only owns cleanup.
    void promise
      .finally(() => this.pending.delete(promise))
      .catch((cause) => {
        void cause
      })
    return promise
  }
  start(log: (cause: unknown) => void) {
    let running = false
    this.timer = setInterval(() => {
      if (running) return
      running = true
      void this.run((signal) => scheduledRetention(this.deps.db, signal))
        .catch(log)
        .finally(() => {
          running = false
        })
    }, 60000)
  }
  async close() {
    clearInterval(this.timer)
    this.controller.abort()
    await Promise.allSettled([...this.pending])
  }
  register(ctx: Context) {
    for (const [name, actions] of Object.entries(ADMIN_ACTIONS)) {
      ctx.tools.register(
        defineTool({
          name,
          description: descriptions[name as AdminTool],
          parameters: {
            action: {
              type: 'string',
              enum: actions,
              required: true,
              description: 'Management operation.',
            },
            input: {
              type: 'object',
              additionalProperties: true,
              required: true,
              description: inputs[name as AdminTool],
            },
          },
          output: TEXT_OUTPUT,
          timeoutMs: 600000,
          execute: (args, exec) =>
            this.run(async (signal) => {
              const input = object(args.input)
              const trace = harnessTrace(
                exec.agent,
                String(exec.callId),
                ctx.get('sessionProjections') as Parameters<typeof harnessTrace>[2],
              )
              const result = await executeAdmin(
                this.deps,
                {
                  agent: exec.agent,
                  callId: String(exec.callId),
                  rootCallId: String(exec.rootCallId),
                  signal: AbortSignal.any([signal, exec.signal]),
                  approval: ctx.get('approval') as ApprovalRequester | undefined,
                  harnessTurn: trace.turn,
                  harnessStep: trace.step,
                  harnessEventSeq: trace.eventSeq,
                },
                name as AdminTool,
                args.action,
                input,
              )
              return JSON.stringify(result ?? { ok: true })
            }),
        }),
      )
    }
  }
}
const descriptions: Record<AdminTool, string> = {
  platform_server_group_admin:
    'Manage managed server groups. Mutations require one user approval and are audited. System groups are read-only.',
  platform_server_key_admin:
    'Manage SSH keys for managed servers. Never accepts or returns private keys. Reveal opens a human-only authenticated download page. Rotate targets one server and may resume an operation_id.',
  platform_server_upgrade_admin:
    'Check and manage single managed-server software plans. Apply approves the exact frozen plan and window; it never accepts commands.',
  platform_audit_admin:
    'Query, export and retain managed-server audit records. Mutations require approval. No individual record editing or deletion.',
  platform_server_admin:
    'Update, rebind or delete one managed server. Uses optimistic configuration revision and one user approval per operation.',
}
const inputs: Record<AdminTool, string> = {
  platform_server_group_admin:
    'Object: list {}; create {name}; rename {group_id,name}; delete {group_id}. Use returned UUIDs.',
  platform_server_key_admin:
    'Object: list {}; create {name}; delete/reveal {key_id}; rotate {server: UUID,key_id,expected_config_revision:string,operation_id?:UUID}. Read current revision before resuming.',
  platform_server_upgrade_admin:
    'Object: check {server}; plan {server,versions:{software_key:exact_version},expected_config_revision:string}; show/cancel {plan_id}; apply {plan_id,revision:string,review_digest,start:ISO8601,end:ISO8601,timezone:IANA}.',
  platform_audit_admin:
    'Object: query/export {from?:ISO8601,to?:ISO8601,server_id?,kind?,status?,session_id?,tool?,page?,page_size?}; retention {mode:"get"|"run"} or {mode:"set",days:integer,archive_directory:absolute_path,next_run:ISO8601,enabled:boolean}. Retention runs daily, at most 10000 records per archive batch.',
  platform_server_admin:
    'Object: update {server,expected_config_revision:string,patch:{name?,region?,declared_os?,install_required_software?,host?,ssh_port?,ssh_user?,ssh_key_id?}}; rebind {server,expected_config_revision:string,target_group:UUID|null,target_type?:string,install_missing:boolean,software_policies:array}; delete {server,expected_config_revision:string}.',
}
