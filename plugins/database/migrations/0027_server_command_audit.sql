create table if not exists server_command_audit (
  id uuid primary key,
  server_id uuid references servers(id) on delete set null,
  server_name text not null,
  host text not null,

  actor_id text not null,
  actor_kind text not null,
  harness_session_id text,
  agent_id text,
  harness_turn integer,
  harness_step integer,
  harness_event_seq bigint,
  tool_call_id text,
  root_tool_call_id text,
  parent_tool_call_id text,
  tool_name text not null,

  permission_mode text not null,
  approval_status text not null,
  approval_id text,
  approved_by text,
  approved_at timestamptz,
  approval_reason text,

  command text not null,
  command_digest text not null,
  command_length integer not null check (command_length >= 0),
  command_truncated boolean not null default false,
  redaction_applied boolean not null default false,
  cwd text,

  status text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  exit_code integer,
  signal text,
  timed_out boolean not null default false,
  cancelled boolean not null default false,
  error_code text,
  error_message text,

  stdout_excerpt text,
  stderr_excerpt text,
  stdout_bytes bigint,
  stderr_bytes bigint,
  stdout_truncated boolean not null default false,
  stderr_truncated boolean not null default false,
  stdout_digest text,
  stderr_digest text,

  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists server_command_audit_server_time
  on server_command_audit (server_id, created_at desc);
create index if not exists server_command_audit_actor_time
  on server_command_audit (actor_id, created_at desc);
create index if not exists server_command_audit_session
  on server_command_audit (harness_session_id);
create unique index if not exists server_command_audit_tool_call
  on server_command_audit (harness_session_id, tool_call_id)
  where harness_session_id is not null and tool_call_id is not null;
create index if not exists server_command_audit_root_call
  on server_command_audit (root_tool_call_id)
  where root_tool_call_id is not null;
