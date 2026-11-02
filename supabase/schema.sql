-- 答题器云端版数据库初始化脚本
-- 在 Supabase Dashboard > SQL Editor 中一次性执行。

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  role text not null default 'user' check (role in ('user', 'super_admin')),
  status text not null default 'pending' check (status in ('pending', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  profile_count integer;
begin
  select count(*) into profile_count from public.profiles;
  insert into public.profiles (id, email, display_name, role, status)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(coalesce(new.email, '用户'), '@', 1)),
    case when profile_count = 0 then 'super_admin' else 'user' end,
    case when profile_count = 0 then 'active' else 'pending' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.current_user_is_active()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active'
  );
$$;

create or replace function public.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and status = 'active' and role = 'super_admin'
  );
$$;

create or replace function public.admin_set_user_status(p_user_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.current_user_is_admin() then
    raise exception '仅超级管理员可审核用户';
  end if;
  if p_status not in ('active', 'suspended', 'pending') then
    raise exception '无效的账号状态';
  end if;
  if p_user_id = auth.uid() then
    raise exception '不能修改自己的审核状态';
  end if;
  if exists (select 1 from public.profiles where id = p_user_id and role = 'super_admin') then
    raise exception '不能修改超级管理员状态';
  end if;
  update public.profiles set status = p_status where id = p_user_id;
end;
$$;

create table if not exists public.personal_questions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  question_key text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, question_key)
);

create table if not exists public.global_questions (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid references public.profiles(id) on delete set null,
  question_key text not null unique,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Allow public questions to remain published if the administrator who uploaded them is deleted.
alter table public.global_questions alter column uploaded_by drop not null;
alter table public.global_questions drop constraint if exists global_questions_uploaded_by_fkey;
alter table public.global_questions
  add constraint global_questions_uploaded_by_fkey
  foreign key (uploaded_by) references public.profiles(id) on delete set null;

create table if not exists public.wrong_records (
  user_id uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null,
  question_source text not null check (question_source in ('personal', 'public')),
  wrong_count integer not null default 1 check (wrong_count > 0),
  last_user_choice_texts jsonb,
  last_sub_choice_texts jsonb,
  last_time timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

create table if not exists public.favorite_records (
  user_id uuid not null references public.profiles(id) on delete cascade,
  question_id uuid not null,
  question_source text not null check (question_source in ('personal', 'public')),
  fav_time timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, question_id)
);

create table if not exists public.practice_sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null,
  label text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null default now(),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  total_questions integer not null default 0 check (total_questions >= 0),
  total_subquestions integer not null default 0 check (total_subquestions >= 0),
  answered_count integer not null default 0 check (answered_count >= 0),
  correct_count integer not null default 0 check (correct_count >= 0),
  accuracy numeric(5,2) not null default 0 check (accuracy >= 0 and accuracy <= 100),
  metadata jsonb not null default '{}'::jsonb,
  unique (id, user_id)
);

create table if not exists public.answer_history (
  id bigint generated by default as identity primary key,
  session_id uuid not null,
  user_id uuid not null,
  question_id uuid not null,
  question_source text not null check (question_source in ('personal', 'public')),
  question_text text not null,
  sub_index integer not null default 0,
  question_type text not null default 'single',
  knowledge text,
  year integer,
  user_answer text[] not null default '{}',
  correct_answer text[] not null default '{}',
  is_answered boolean not null default false,
  is_correct boolean not null default false,
  question_snapshot jsonb not null,
  answered_at timestamptz not null default now(),
  foreign key (session_id, user_id) references public.practice_sessions(id, user_id) on delete cascade
);

create index if not exists personal_questions_owner_idx on public.personal_questions(owner_id, created_at desc);
create index if not exists global_questions_created_idx on public.global_questions(created_at desc);
create index if not exists wrong_records_user_idx on public.wrong_records(user_id, updated_at desc);
create index if not exists favorite_records_user_idx on public.favorite_records(user_id, fav_time desc);
create index if not exists practice_sessions_user_idx on public.practice_sessions(user_id, completed_at desc);
create index if not exists answer_history_session_idx on public.answer_history(session_id, id);

drop trigger if exists personal_questions_touch_updated_at on public.personal_questions;
create trigger personal_questions_touch_updated_at before update on public.personal_questions
for each row execute function public.touch_updated_at();
drop trigger if exists global_questions_touch_updated_at on public.global_questions;
create trigger global_questions_touch_updated_at before update on public.global_questions
for each row execute function public.touch_updated_at();
drop trigger if exists wrong_records_touch_updated_at on public.wrong_records;
create trigger wrong_records_touch_updated_at before update on public.wrong_records
for each row execute function public.touch_updated_at();
drop trigger if exists favorite_records_touch_updated_at on public.favorite_records;
create trigger favorite_records_touch_updated_at before update on public.favorite_records
for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.personal_questions enable row level security;
alter table public.global_questions enable row level security;
alter table public.wrong_records enable row level security;
alter table public.favorite_records enable row level security;
alter table public.practice_sessions enable row level security;
alter table public.answer_history enable row level security;

drop policy if exists profiles_select_own_or_admin on public.profiles;
create policy profiles_select_own_or_admin on public.profiles
for select to authenticated
using (id = auth.uid() or public.current_user_is_admin());

drop policy if exists personal_questions_owner_all on public.personal_questions;
create policy personal_questions_owner_all on public.personal_questions
for all to authenticated
using (owner_id = auth.uid() and public.current_user_is_active())
with check (owner_id = auth.uid() and public.current_user_is_active());

drop policy if exists global_questions_active_read on public.global_questions;
create policy global_questions_active_read on public.global_questions
for select to authenticated
using (public.current_user_is_active());

drop policy if exists global_questions_admin_insert on public.global_questions;
create policy global_questions_admin_insert on public.global_questions
for insert to authenticated
with check (uploaded_by = auth.uid() and public.current_user_is_admin());

drop policy if exists global_questions_admin_update on public.global_questions;
create policy global_questions_admin_update on public.global_questions
for update to authenticated
using (public.current_user_is_admin())
with check (uploaded_by = auth.uid() and public.current_user_is_admin());

drop policy if exists global_questions_admin_delete on public.global_questions;
create policy global_questions_admin_delete on public.global_questions
for delete to authenticated
using (public.current_user_is_admin());

drop policy if exists wrong_records_owner_all on public.wrong_records;
create policy wrong_records_owner_all on public.wrong_records
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

drop policy if exists favorite_records_owner_all on public.favorite_records;
create policy favorite_records_owner_all on public.favorite_records
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

drop policy if exists practice_sessions_owner_all on public.practice_sessions;
create policy practice_sessions_owner_all on public.practice_sessions
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

drop policy if exists answer_history_owner_all on public.answer_history;
create policy answer_history_owner_all on public.answer_history
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

revoke all on public.profiles from anon;
revoke all on public.personal_questions from anon;
revoke all on public.global_questions from anon;
revoke all on public.wrong_records from anon;
revoke all on public.favorite_records from anon;
revoke all on public.practice_sessions from anon;
revoke all on public.answer_history from anon;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.personal_questions to authenticated;
grant select, insert, update, delete on public.global_questions to authenticated;
grant select, insert, update, delete on public.wrong_records to authenticated;
grant select, insert, update, delete on public.favorite_records to authenticated;
grant select, insert, update, delete on public.practice_sessions to authenticated;
grant select, insert, update, delete on public.answer_history to authenticated;
grant usage, select on sequence public.answer_history_id_seq to authenticated;

revoke all on function public.admin_set_user_status(uuid, text) from public;
grant execute on function public.admin_set_user_status(uuid, text) to authenticated;
revoke all on function public.current_user_is_active() from public;
revoke all on function public.current_user_is_admin() from public;
grant execute on function public.current_user_is_active() to authenticated;
grant execute on function public.current_user_is_admin() to authenticated;

-- Progress tracking and assessment session persistence.
create table if not exists public.user_learning_states (
  user_id uuid not null references public.profiles(id) on delete cascade,
  question_fingerprint text not null check (question_fingerprint ~ '^[0-9a-f]{64}$'),
  sub_index integer not null check (sub_index >= 0),
  question_id uuid,
  sources text[] not null default array['personal']::text[],
  question_snapshot jsonb not null,
  chapter text not null default '未分类',
  latest_answer text[] not null default '{}',
  is_correct boolean not null default false,
  answered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, question_fingerprint, sub_index)
);

create table if not exists public.active_practices (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  mode text not null,
  payload jsonb not null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.study_sessions (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('mock', 'random')),
  status text not null default 'in_progress' check (status in ('in_progress', 'incomplete', 'completed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  planned_questions integer not null default 0 check (planned_questions >= 0),
  planned_subquestions integer not null default 0 check (planned_subquestions >= 0),
  answered_count integer not null default 0 check (answered_count >= 0),
  correct_count integer not null default 0 check (correct_count >= 0),
  accuracy numeric(5,2) not null default 0 check (accuracy >= 0 and accuracy <= 100),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table if not exists public.study_session_questions (
  id bigint generated by default as identity primary key,
  session_id uuid not null,
  user_id uuid not null,
  question_order integer not null check (question_order > 0),
  question_fingerprint text not null check (question_fingerprint ~ '^[0-9a-f]{64}$'),
  question_snapshot jsonb not null,
  chapter text not null default '未分类',
  sources text[] not null default array['personal']::text[],
  answers jsonb not null default '[]'::jsonb,
  status text not null default 'unanswered' check (status in ('unanswered', 'correct', 'wrong')),
  updated_at timestamptz not null default now(),
  unique (session_id, question_order),
  foreign key (session_id, user_id) references public.study_sessions(id, user_id) on delete cascade
);

create index if not exists user_learning_states_user_idx on public.user_learning_states(user_id, chapter);
create index if not exists study_sessions_user_time_idx on public.study_sessions(user_id, started_at desc);
create index if not exists study_session_questions_session_idx on public.study_session_questions(session_id, question_order);

drop trigger if exists user_learning_states_touch_updated_at on public.user_learning_states;
create trigger user_learning_states_touch_updated_at before update on public.user_learning_states
for each row execute function public.touch_updated_at();
drop trigger if exists active_practices_touch_updated_at on public.active_practices;
create trigger active_practices_touch_updated_at before update on public.active_practices
for each row execute function public.touch_updated_at();
drop trigger if exists study_sessions_touch_updated_at on public.study_sessions;
create trigger study_sessions_touch_updated_at before update on public.study_sessions
for each row execute function public.touch_updated_at();
drop trigger if exists study_session_questions_touch_updated_at on public.study_session_questions;
create trigger study_session_questions_touch_updated_at before update on public.study_session_questions
for each row execute function public.touch_updated_at();

alter table public.user_learning_states enable row level security;
alter table public.active_practices enable row level security;
alter table public.study_sessions enable row level security;
alter table public.study_session_questions enable row level security;

drop policy if exists user_learning_states_owner_all on public.user_learning_states;
create policy user_learning_states_owner_all on public.user_learning_states
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

drop policy if exists active_practices_owner_all on public.active_practices;
create policy active_practices_owner_all on public.active_practices
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

drop policy if exists study_sessions_owner_all on public.study_sessions;
create policy study_sessions_owner_all on public.study_sessions
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

drop policy if exists study_session_questions_owner_all on public.study_session_questions;
create policy study_session_questions_owner_all on public.study_session_questions
for all to authenticated
using (user_id = auth.uid() and public.current_user_is_active())
with check (user_id = auth.uid() and public.current_user_is_active());

revoke all on public.user_learning_states from anon;
revoke all on public.active_practices from anon;
revoke all on public.study_sessions from anon;
revoke all on public.study_session_questions from anon;

grant select, insert, update, delete on public.user_learning_states to authenticated;
grant select, insert, update, delete on public.active_practices to authenticated;
grant select, insert, update, delete on public.study_sessions to authenticated;
grant select, insert, update, delete on public.study_session_questions to authenticated;
grant usage, select on sequence public.study_session_questions_id_seq to authenticated;
