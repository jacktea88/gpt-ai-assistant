-- 0021_notes.sql — 輕量筆記（notes）表。與 tasks 分開，提供通用文字紀錄。

begin;

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notes_owner_created_idx on notes (owner_id, created_at desc);

commit;