create index if not exists server_command_audit_created
  on server_command_audit (created_at desc, id desc);
